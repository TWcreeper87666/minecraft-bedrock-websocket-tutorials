import asyncio
import json
import websockets
import random
import string
import base64
import logging
from collections import defaultdict

# 設定基本日誌記錄
logging.basicConfig(level=logging.INFO, format='%(message)s')
log = logging.getLogger()

WSS_MAXIMUM_BYTES = 661


class MinecraftWebSocketServer:
    """
    一個透過 /wsserver 指令與 Minecraft Bedrock 版互動的 WebSocket 伺服器。
    這個類別是原始 JavaScript 實作的 Python 移植版本。
    """

    def __init__(self, port: int, host: str = "localhost"):
        self.port = port
        self.host = host
        self.request_timeout_s = 60

        self._ws_server = None
        self._client_conn = None
        self._connection_future = None

        # 事件處理
        self._emitter = defaultdict(list)

        # 指令處理
        self._command_batches = {
        }  # K: batch_id, V: {'count', 'results', 'future'}
        self._request_id_to_batch_id = {}  # K: request_id, V: batch_id

    # --- 事件發射器方法 ---

    def on(self, event_name: str, listener):
        """
        監聽一個伺服器事件。
        :param event_name: 事件名稱 (例如 'log', 'playerMessage')。
        :param listener: 要執行的回呼函式。
        """
        self._emitter[event_name].append(listener)
        return self

    def once(self, event_name: str, listener):
        """
        監聽一個一次性的伺服器事件。
        """

        def wrapper(*args, **kwargs):
            self.off(event_name, wrapper)
            return listener(*args, **kwargs)

        self.on(event_name, wrapper)
        return self

    def off(self, event_name: str, listener):
        """
        移除指定的事件監聽器。
        """
        if event_name in self._emitter:
            try:
                self._emitter[event_name].remove(listener)
            except ValueError:
                pass  # 監聽器未找到
        return self

    def _emit(self, event_name: str, *args, **kwargs):
        """內部方法，用於發射事件。"""
        if event_name in self._emitter:
            for listener in self._emitter[event_name]:
                try:
                    # 監聽器可以是同步或非同步的，但我們不等待它們，
                    # 以避免阻塞主伺服器迴圈。
                    listener(*args, **kwargs)
                except Exception as e:
                    self._emit("log", f"❌ 事件 '{event_name}' 的監聽器出錯: {e}")

    # --- 伺服器生命週期方法 ---

    async def start(self):
        """
        啟動 WebSocket 伺服器並等待第一個客戶端連線。
        """
        if self._ws_server:
            raise ConnectionError("伺服器已經在運行中。")

        self._connection_future = asyncio.Future()

        try:
            server = await websockets.serve(self._connection_handler,
                                            self.host, self.port)
            self._ws_server = server
            self._emit("log",
                       f"✅ WebSocket 伺服器已啟動於 ws://{self.host}:{self.port}")
            self._emit("statusUpdate",
                       f"等待連線中... (/wsserver {self.host}:{self.port})")

            # 等待第一個客戶端連線
            await self._connection_future
        except OSError as e:
            self._emit("log", f"❌ 啟動伺服器失敗: {e}")
            raise

    def stop(self, reason: str = "伺服器已停止"):
        """
        停止 WebSocket 伺服器並斷開所有客戶端。
        """
        if self._ws_server:
            self._ws_server.close()
            self._ws_server = None
            self._emit("log", "🛑 WebSocket 伺服器已停止。")

        if self._client_conn:
            # 這將觸發 _on_close 處理程序
            asyncio.create_task(self._client_conn.close(reason=reason))

        self._emit("statusUpdate", reason)

    # --- 連線處理 ---

    async def _connection_handler(self, websocket):
        """處理新的客戶端連線。"""
        if self._client_conn:
            log.warning("已有客戶端連線時，嘗試建立新連線。正在關閉新連線。")
            await websocket.close(1013, "伺服器已有客戶端。")
            return

        remote_addr = websocket.remote_address
        self._emit("log", f"🔗 客戶端已連線: {remote_addr}")
        self._emit("statusUpdate", "連線成功")
        self._client_conn = websocket

        # 解析 future 以表示伺服器已準備就緒
        if self._connection_future and not self._connection_future.done():
            self._connection_future.set_result(True)

        try:
            # 與 Minecraft 的初始設定
            # 將初始設定的協程作為背景任務執行，以避免阻塞主訊息迴圈。
            # send_message 會等待指令回應，如果在此處 await，將無法接收任何訊息，導致死鎖。
            asyncio.create_task(
                self.send_message("§l§b- Python WebSocket 連接成功!"))
            asyncio.create_task(self.event_subscribe("PlayerMessage"))

            # 主要訊息迴圈
            async for message in websocket:
                await self._on_message(message)

        except websockets.exceptions.ConnectionClosed as e:
            self._on_close(e.code, e.reason)
        except Exception as e:
            self._emit("log", f"⚠️ 連線處理程序中發生意外錯誤: {e}")
            self._on_close(1011, "內部伺服器錯誤")
        finally:
            if self._client_conn == websocket:
                self._client_conn = None
                self._emit("statusUpdate", "已斷線: Minecraft 離線")

    def _on_close(self, code, reason):
        """處理客戶端斷線。"""
        self._emit("log", f"🚫 客戶端已斷線: 代碼 {code}, 原因: {reason or '未提供原因'}")
        # 清理所有待處理的指令批次
        for batch_id, batch in list(self._command_batches.items()):
            if not batch['future'].done():
                batch['future'].set_exception(ConnectionAbortedError("客戶端已斷線"))
            self._command_batches.pop(batch_id, None)
        self._request_id_to_batch_id.clear()

    async def _on_message(self, message: str):
        """解析並路由來自 Minecraft 的傳入訊息。"""
        try:
            data = json.loads(message)
            header = data.get("header", {})
            body = data.get("body", {})

            event_name = header.get("eventName")
            if event_name:
                camel_case_event = event_name[0].lower() + event_name[1:]
                if camel_case_event == 'playerMessage' and body.get(
                        'type') == 'chat':
                    self._emit('playerMessage', body.get('sender'),
                               body.get('message'), body)
                else:
                    self._emit(camel_case_event, body)

            elif header.get("messagePurpose") == "commandResponse":
                request_id = header.get("requestId")
                status_message = body.get("statusMessage", "success")
                batch_id = self._request_id_to_batch_id.pop(request_id, None)

                if batch_id and batch_id in self._command_batches:
                    batch = self._command_batches[batch_id]
                    batch["results"].append(status_message)
                    if len(batch["results"]) == batch["count"]:
                        if not batch["future"].done():
                            batch["future"].set_result(batch["results"])
                        self._command_batches.pop(batch_id)
            else:
                self._emit("message", header, body)

        except json.JSONDecodeError:
            self._emit("log", f"❌ 解碼 JSON 時出錯: {message}")
        except Exception as e:
            self._emit("log", f"❌ 處理訊息時出錯: {e}")

    # --- Minecraft 互動方法 ---

    async def run_command(self, command: str) -> str:
        """
        執行單一指令並等待結果。
        :param command: 要執行的指令。
        :return: 來自遊戲的結果訊息。
        """
        results = await self.run_commands([command])
        return results[0]

    async def run_commands(self, commands: list[str]) -> list[str]:
        """
        執行一批指令並等待所有結果。
        :param commands: 要執行的指令列表。
        :return: 結果訊息列表。
        """
        if not self._client_conn:
            raise ConnectionError("尚未連線至 Minecraft。")

        batch_id = self._generate_id()
        future = asyncio.Future()

        self._command_batches[batch_id] = {
            "count": len(commands),
            "results": [],
            "future": future
        }

        for command in commands:
            request_id = self._generate_id()
            self._request_id_to_batch_id[request_id] = batch_id
            await self._internal_run_command(command, request_id)

        try:
            return await asyncio.wait_for(future,
                                          timeout=self.request_timeout_s)
        except asyncio.TimeoutError:
            # 清理超時的批次
            self._command_batches.pop(batch_id, None)
            # 移除相關的請求 ID
            stale_req_ids = [
                k for k, v in self._request_id_to_batch_id.items()
                if v == batch_id
            ]
            for req_id in stale_req_ids:
                self._request_id_to_batch_id.pop(req_id, None)
            raise TimeoutError(f"指令批次在 {self.request_timeout_s} 秒後超時")

    async def send_data_to_minecraft(self, name: str, data):
        """
        透過 scriptevents 將大量資料分塊傳送到 Minecraft。
        :param name: 資料的唯一名稱/頻道。
        :param data: 要傳送的資料 (字串或可序列化為 JSON 的物件)。
        """
        if not self._client_conn:
            raise ConnectionError("尚未連線至 Minecraft。")
        if not all(c.isalnum() or c in '-_' for c in name):
            raise ValueError("名稱只能包含字母、數字、底線和連字號。")
        if len(name) > 64:
            raise ValueError("名稱長度不能超過 64 個字元。")

        data_string = json.dumps(data) if not isinstance(data, str) else data
        data_b64 = base64.b64encode(
            data_string.encode('utf-8')).decode('ascii')
        transfer_id = self._generate_id(4)

        # 經過計算的區塊大小，以避免超過指令長度限制。
        # WebSocket 總酬載限制為 WSS_MAXIMUM_BYTES (661 位元組)。
        # 酬載結構與指令前綴 (`scriptevent yb:<name> DATA:<index>:<id>:`) 會消耗一部分空間。
        # CHUNK_SIZE <= 661 - (JSON 包裝開銷) - (指令前綴開銷)
        # CHUNK_SIZE <= 661 - ~132 - ~(27 + len(name) + len(str(index)))
        # 假設 name 長度上限為 64，index 位數為 7 (支援到 GB 等級的資料)，一個安全的大小約為 400。
        CHUNK_SIZE = 400
        chunks = [
            data_b64[i:i + CHUNK_SIZE]
            for i in range(0, len(data_b64), CHUNK_SIZE)
        ]
        total_chunks = len(chunks)

        self._emit(
            "log",
            f"[{transfer_id}] 準備向 Minecraft [{name}] 傳送資料，共 {total_chunks} 塊。"
        )

        command_base = f"scriptevent yb:{name}"
        all_commands = []
        all_commands.append(
            f"{command_base} START:{total_chunks}:{transfer_id}")
        all_commands.extend(f"{command_base} DATA:{i}:{transfer_id}:{chunk}"
                            for i, chunk in enumerate(chunks))
        all_commands.append(f"{command_base} END:{transfer_id}")

        # 逐一傳送指令，讓 Minecraft 有時間處理，
        # 並避免達到指令佇列上限。
        for i, command in enumerate(all_commands):
            try:
                # 我們不需要結果，但等待可確保順序執行
                await self.run_command(command)
            except Exception as e:
                self._emit("log", f"❌ 資料塊傳送失敗 (ID: {transfer_id}): {e}。傳送中止。")
                raise IOError(f"資料傳送中止: {e}") from e

        self._emit("log",
                   f"✅ [{transfer_id}] 已成功向 Minecraft [{name}] 傳送所有資料塊。")

    async def send_message(self, message: str):
        """
        使用 /tellraw 向所有玩家傳送訊息，必要時進行分塊。
        """
        if not self._client_conn:
            return

        remaining = message
        while remaining:
            # 找到能容納的最大塊
            # 這是一個簡單但有效的方法。二分搜尋會更快。
            chunk = ""
            for i in range(1, len(remaining) + 1):
                candidate = remaining[:i]
                tellraw_cmd = f'tellraw @a {{"rawtext":[{{"text":{json.dumps(candidate)}}}]}}'
                payload = self._create_command_payload(tellraw_cmd, "temp_id")
                if len(json.dumps(payload).encode(
                        'utf-8')) > WSS_MAXIMUM_BYTES:
                    break
                chunk = candidate

            if not chunk:
                # 如果 WSS_MAXIMUM_BYTES 合理，這不應該發生
                self._emit("log", "⚠️ 無法傳送部分訊息，它太長以至於無法放入單一塊中。")
                break

            final_cmd = f'tellraw @a {{"rawtext":[{{"text":{json.dumps(chunk)}}}]}}'
            await self.run_command(final_cmd)
            remaining = remaining[len(chunk):]

    async def event_subscribe(self, event_name: str, callback=None):
        """
        訂閱一個 Minecraft 事件。
        :param event_name: 事件的 PascalCase 名稱 (例如 'PlayerMessage')。
        :param callback: 為此事件註冊的可選回呼函式。
        """
        if not self._client_conn:
            self._emit("log", f"⚠️ 無法訂閱 '{event_name}': 連線已關閉。")
            return self

        payload = {
            "header": {
                "requestId": self._generate_id(8),
                "messagePurpose": "subscribe",
                "version": 1,
            },
            "body": {
                "eventName": event_name
            },
        }
        await self._client_conn.send(json.dumps(payload))
        self._emit("log", f"🔔 已訂閱事件: {event_name}")

        if callback and callable(callback):
            camel_case_event = event_name[0].lower() + event_name[1:]
            self.on(camel_case_event, callback)

        return self

    # --- 輔助方法 ---

    def _create_command_payload(self, command: str, request_id: str) -> dict:
        """為指令請求建立 JSON 酬載。"""
        return {
            "header": {
                "requestId": request_id,
                "messagePurpose": "commandRequest",
                "version": 1,
            },
            "body": {
                "commandLine": command,
                "version": 1,
            },
        }

    async def _internal_run_command(self, command: str, request_id: str):
        """準備並傳送單一指令的酬載。"""
        if not self._client_conn:
            self._emit("log", f"⚠️ 無法執行指令 '{command}': 連線已關閉。")
            return

        payload = self._create_command_payload(command, request_id)
        payload_str = json.dumps(payload)

        if len(payload_str.encode('utf-8')) > WSS_MAXIMUM_BYTES:
            msg = "§c[runCommand] 指令太長無法執行。"
            await self.send_message(msg)
            self._emit("log", f"⚠️ 酬載過大無法傳送 ({len(payload_str)} 位元組)。")
            return

        self._emit("log", f"[{request_id[:5]}] 執行中: {command}")
        await self._client_conn.send(payload_str)

    def _generate_id(self, length: int = 8) -> str:
        """產生一個短的隨機 ID。"""
        chars = string.ascii_letters + string.digits
        return ''.join(random.choices(chars, k=length))
