import asyncio
from minecraft_ws_server import MinecraftWebSocketServer


async def main():
    """主函式，用於運行 WebSocket 伺服器並與 Minecraft 互動。"""
    # 傳入 show_log=True 以在控制台顯示伺服器內部日誌
    ws_server = MinecraftWebSocketServer(port=5218, show_log=True)

    # 定義事件處理函式
    # 回呼函式現在接收 body 和 header
    def on_player_message(body, header):
        if body.get('type') == 'chat':
            sender = body.get('sender')
            msg = body.get('message')
            # 直接使用 print 或您選擇的日誌庫
            print(f"[Chat] <{sender}> {msg}")

    try:
        # 啟動伺服器並等待客戶端連線
        await ws_server.start()

        # 連線成功後，手動訂閱事件
        ws_server.event_subscribe('PlayerMessage', on_player_message)

        # 執行一個簡單的指令
        response = await ws_server.run_command('say Hello from Python!')
        print(f"指令執行結果: {response}")

        # 示範傳送大量資料
        print("正在示範傳送大量資料...")
        try:
            large_object = {
                "message": "這是一個從 Python 傳送的大物件!",
                "timestamp": asyncio.get_event_loop().time(),
                "data": [f"item_{i}" for i in range(100)],
                "nested": {"info": "這是一個巢狀物件"},
            }
            await ws_server.send_data_to_minecraft('myLargeData', large_object)
            print("✅ 大量資料已傳送至 'myLargeData' 通道。")

            long_string = "這是一段非常非常非常長的字串，需要被分塊才能成功傳送到 Minecraft。" * 20
            await ws_server.send_data_to_minecraft('anotherChannel', long_string)
            print("✅ 長字串已傳送至 'anotherChannel' 通道。")

        except Exception as e:
            print(f"傳送大量資料時發生錯誤: {e}")

        # 伺服器現在將保持運行狀態以接收事件 (例如玩家聊天)
        # 按下 Ctrl+C 來停止伺服器。
        print("伺服器正在運行中。按下 Ctrl+C 來停止。")
        await asyncio.Event().wait()  # 永遠等待，直到被取消

    except asyncio.CancelledError:
        # 當 asyncio.run 由於 KeyboardInterrupt 而取消任務時，這是預期的。
        pass
    except Exception as e:
        print(f"發生錯誤: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n使用者要求關閉伺服器。")
