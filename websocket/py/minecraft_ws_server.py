import asyncio
import json
import websockets
import random
import string
from collections import defaultdict

WSS_MAXIMUM_BYTES = 661
MC_PROTOCOL_VERSION = 26 # 支援新版 execute


class MinecraftWebSocketServer:
    """
    一個透過 /wsserver 指令與 Minecraft Bedrock 版互動的 WebSocket 伺服器。
    這個類別是原始 JavaScript 實作的 Python 移植版本。
    """

    def __init__(self, port: int, host: str = "localhost", show_log: bool = False):
        self.port = port
        self.host = host
        self.show_log = show_log
        self.request_timeout_ms = 60_000

        self._ws_server = None
        self._client_conn = None
        self._connection_future = None

        # 事件處理
        self._event_subscription_callbacks = defaultdict(set)

        # 指令處理
        self._command_batches = {
        }  # K: batch_id, V: {'count', 'results', 'future'}
        self._request_id_to_batch_id = {}  # K: request_id, V: batch_id

    def _log(self, message: str):
        """內部日誌函式，根據 `show_log` 參數決定是否輸出到 console。"""
        if self.show_log:
            print(f"[WSS] {message}")

    # --- 伺服器生命週期方法 ---

    async def start(self):
        if self._ws_server:
            raise ConnectionError("伺服器已經在運行中。")

        self._connection_future = asyncio.Future()

        try:
            self._ws_server = await websockets.serve(self._connection_handler, self.host, self.port)
            self._log(f"✅ WebSocket 伺服器已啟動於 ws://{self.host}:{self.port}")
            self._log(f"等待連線中... (/wsserver {self.host}:{self.port})")

            # 等待第一個客戶端連線
            await self._connection_future
        except OSError as e:
            self._log(f"❌ 啟動伺服器失敗: {e}")
            raise

    def stop(self, reason: str = "伺服器已停止"):
        """
        停止 WebSocket 伺服器並斷開所有客戶端。
        """
        if self._ws_server:
            self._ws_server.close()
            self._ws_server = None
            self._log("🛑 WebSocket 伺服器已停止。")

        if self._client_conn:
            # 這將觸發 _on_close 處理程序
            asyncio.create_task(self._client_conn.close(reason=reason))

        self._log(reason)

    # --- 連線處理 ---

    async def _connection_handler(self, websocket):
        """處理新的客戶端連線。"""
        if self._client_conn:
            self._log("⚠️ 已有客戶端連線時，嘗試建立新連線。正在關閉新連線。")
            await websocket.close(1013, "伺服器已有客戶端。")
            return

        remote_addr = websocket.remote_address
        self._log(f"🔗 客戶端已連線: {remote_addr}")
        self._client_conn = websocket

        # 解析 future 以表示伺服器已準備就緒
        if self._connection_future and not self._connection_future.done():
            self._connection_future.set_result(True)

        try:
            await self.send_message("§l§b- Python WebSocket 連接成功!")

            # 主要訊息迴圈
            async for message in websocket:
                await self._on_message(message)

        except websockets.exceptions.ConnectionClosed as e:
            self._on_close(e.code, e.reason)
        except Exception as e:
            self._log(f"⚠️ 連線處理程序中發生意外錯誤: {e}")
            self._on_close(1011, "內部伺服器錯誤")
        finally:
            if self._client_conn == websocket:
                self._client_conn = None

    def _on_close(self, code, reason):
        """處理客戶端斷線。"""
        self._log(f"🚫 客戶端已斷線: 代碼 {code}, 原因: {reason or '未提供原因'}")
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
                callbacks = self._event_subscription_callbacks.get(event_name)
                if callbacks:
                    for callback in callbacks:
                        try:
                            callback(body, header)
                        except Exception as e:
                            self._log(f"❌ 事件 '{event_name}' 的回呼函式出錯: {e}")
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
                self._log(f"[Unhandled Message] Purpose: {header.get('messagePurpose')}, Event: {event_name}")

        except json.JSONDecodeError:
            self._log(f"❌ 解碼 JSON 時出錯: {message}")
        except Exception as e:
            self._log(f"❌ 處理訊息時出錯: {e}")

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
            return await asyncio.wait_for(future, timeout=self.request_timeout_ms / 1000)
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
            raise TimeoutError(f"指令批次在 {self.request_timeout_ms}ms 後超時")

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

        # 將資料轉換為 JSON 字串。json.dumps 預設會將非 ASCII 字元
        # 跳脫為 \uXXXX 格式，這對於安全的資料傳輸是必要的。
        data_string = json.dumps(data)
        transfer_id = self._generate_id(4)

        # 輔助函式，用於計算給定指令的最終 WebSocket 酬載大小。
        sample_request_id = self._generate_id()
        def get_command_payload_size(command):
            payload = self._create_command_payload(command, sample_request_id)
            return len(json.dumps(payload).encode('utf-8'))

        chunks = []
        remaining_data = data_string
        chunk_index = 0
        command_base = f"scriptevent yb:{name}"

        while remaining_data:
            command_prefix = f"{command_base} DATA:{chunk_index}:{transfer_id}:"

            # 使用二分搜尋法找到適合 WSS_MAXIMUM_BYTES 的最大資料塊
            low, high = 0, len(remaining_data)
            best_fit_index = 0

            while low <= high:
                mid = low + (high - low) // 2
                if mid == 0:
                    break

                candidate_chunk = remaining_data[:mid]
                test_command = command_prefix + candidate_chunk
                current_size = get_command_payload_size(test_command)

                if current_size <= WSS_MAXIMUM_BYTES:
                    best_fit_index = mid
                    low = mid + 1
                else:
                    high = mid - 1

            if best_fit_index == 0:
                overhead_size = get_command_payload_size(command_prefix)
                raise IOError(f"無法傳送資料：指令開銷太大 ({overhead_size} 位元組)，沒有足夠的空間容納資料。")

            chunk = remaining_data[:best_fit_index]
            chunks.append(chunk)
            remaining_data = remaining_data[best_fit_index:]
            chunk_index += 1

        total_chunks = len(chunks)

        self._log(f"[{transfer_id}] 準備向 Minecraft [{name}] 傳送資料，共 {total_chunks} 塊。")

        all_commands = []
        all_commands.append(
            f"{command_base} START:{total_chunks}:{transfer_id}")
        all_commands.extend(f"{command_base} DATA:{i}:{transfer_id}:{chunk}"
                            for i, chunk in enumerate(chunks))
        all_commands.append(f"{command_base} END:{transfer_id}")

        # 依序傳送所有指令。`run_command` 會等待回應，這自然地調節了傳送速率並確保指令按順序處理。
        for command in all_commands:
            try:
                await self.run_command(command)
            except Exception as e:
                self._log(f"❌ 資料塊傳送失敗 (ID: {transfer_id}): {e}。傳送中止。")
                raise IOError(f"資料傳送中止: {e}") from e

        self._log(f"✅ [{transfer_id}] 已成功向 Minecraft [{name}] 傳送所有資料塊。")

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
                self._log("⚠️ 無法傳送部分訊息，它太長以至於無法放入單一塊中。")
                break

            final_cmd = f'tellraw @a {{"rawtext":[{{"text":{json.dumps(chunk)}}}]}}'
            await self.run_command(final_cmd)
            remaining = remaining[len(chunk):]

    def event_subscribe(self, event_name: str, callback):
        """
        註冊 Minecraft 遊戲事件訂閱。
        當指定的 Minecraft 遊戲事件發生時，會觸發提供的回呼函式。
        :param event_name: 要訂閱的 Minecraft 事件名稱 (PascalCase)。
        :param callback: 當事件觸發時要執行的回呼函式。
        :raises ConnectionError: 如果連線未建立或已關閉。
        :raises TypeError: 如果 callback 不是函式。
        """
        if not self._client_conn:
            raise ConnectionError(f"無法訂閱事件 \"{event_name}\"：連線已關閉")
        if not callable(callback):
            raise TypeError(f"訂閱事件 \"{event_name}\" 必須提供一個回呼函式。")

        # 如果是第一次訂閱此事件，則向 Minecraft 發送訂閱請求
        if not self._event_subscription_callbacks[event_name]:
            payload = {
                "header": {
                    "requestId": self._generate_id(8),
                    "messagePurpose": "subscribe",
                    "version": MC_PROTOCOL_VERSION,
                },
                "body": {"eventName": event_name},
            }
            asyncio.create_task(self._client_conn.send(json.dumps(payload)))
            self._log(f"🔔 已向 Minecraft 請求訂閱事件: {event_name}")

        # 將回呼函式儲存起來
        self._event_subscription_callbacks[event_name].add(callback)
        self._log(f"✅ 已註冊本地回呼函式用於事件: {event_name}")

    # --- 輔助方法 ---

    def _create_command_payload(self, command: str, request_id: str) -> dict:
        """為指令請求建立 JSON 酬載。"""
        return {
            "header": {
                "requestId": request_id,
                "messagePurpose": "commandRequest",
                "version": MC_PROTOCOL_VERSION,
            },
            "body": {
                "commandLine": command,
                "version": MC_PROTOCOL_VERSION,
            },
        }

    async def _internal_run_command(self, command: str, request_id: str):
        """準備並傳送單一指令的酬載。"""
        if not self._client_conn:
            self._log(f"⚠️ 無法執行指令 '{command}': 連線已關閉。")
            return

        payload = self._create_command_payload(command, request_id)
        payload_str = json.dumps(payload)

        if len(payload_str.encode('utf-8')) > WSS_MAXIMUM_BYTES:
            await self.send_message("§c[runCommand] 指令太長無法執行。")
            self._log(f"⚠️ 酬載過大無法傳送 ({len(payload_str.encode('utf-8'))} 位元組)。")
            return

        self._log(f"[{request_id[:5]}] 執行中: {command}")
        await self._client_conn.send(payload_str)

    def _generate_id(self, length: int = 3) -> str:
        """產生一個短的隨機 ID。"""
        chars = string.ascii_letters + string.digits
        return ''.join(random.choices(chars, k=length))
