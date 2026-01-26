import asyncio
import logging
from minecraft_ws_server import MinecraftWebSocketServer

# 設定日誌以匹配 JS 範例的輸出
logging.basicConfig(level=logging.INFO, format='%(message)s')
log = logging.getLogger()


async def main():
    """主函式，用於運行 WebSocket 伺服器並與 Minecraft 互動。"""
    ws_server = MinecraftWebSocketServer(port=5218)

    # 定義事件監聽器
    def on_log(message):
        log.info(f"[WSS] {message}")

    def on_player_message(sender, msg, body):
        log.info(f"[Chat] <{sender}> {msg}")

    # 註冊監聽器
    ws_server.on('log', on_log)
    ws_server.on('playerMessage', on_player_message)

    try:
        # 啟動伺服器並等待客戶端連線
        await ws_server.start()

        # 執行一個簡單的指令
        responses = await ws_server.run_command('say Hello from Python!')
        log.info(f"指令執行結果: {responses}")

        # 示範傳送大量資料
        log.info("正在示範傳送大量資料...")
        try:
            large_object = {
                "message": "這是一個從 Python 傳送的大物件!",
                "timestamp": asyncio.get_event_loop().time(),
                "data": [f"item_{i}" for i in range(100)],
                "nested": {
                    "info": "這是一個巢狀物件"
                }
            }
            await ws_server.send_data_to_minecraft('myLargeData', large_object)
            log.info("✅ 大量資料已傳送至 'myLargeData' 通道。")

            long_string = "這是一段非常非常非常長的字串，需要被分塊才能成功傳送到 Minecraft。" * 20
            await ws_server.send_data_to_minecraft('anotherChannel',
                                                   long_string)
            log.info("✅ 長字串已傳送至 'anotherChannel' 通道。")

        except Exception as e:
            log.error(f"傳送大量資料時發生錯誤: {e}")

        # 伺服器現在將保持運行狀態以接收事件 (例如玩家聊天)
        # 按下 Ctrl+C 來停止伺服器。
        log.info("伺服器正在運行中。按下 Ctrl+C 來停止。")
        await asyncio.Event().wait()  # 永遠等待，直到被取消

    except asyncio.CancelledError:
        # 當 asyncio.run 由於 KeyboardInterrupt 而取消任務時，這是預期的。
        pass
    except Exception as e:
        log.error(f"發生錯誤: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("\n使用者要求關閉伺服器。")
