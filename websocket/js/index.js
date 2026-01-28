import { MinecraftEvents, MinecraftWebSocketServer } from "./MinecraftWebSocketServer.js";

async function main() {
    // 啟用 showLog 來查看伺服器內部日誌
    // 啟用 enableDataPolling 來啟動基於記分板的資料輪詢機制
    const wsServer = new MinecraftWebSocketServer(5218, { showLog: false, enableDataPolling: true });

    await wsServer.start();

    // 監聽玩家聊天訊息
    wsServer.onEvent(MinecraftEvents.PlayerMessage, (body) => {
        if (body.type === 'chat') console.log(`[Chat] <${body.sender}> ${body.message}`);
    });

    // 監聽從 Minecraft 透過輪詢機制傳來的資料
    wsServer.onData(({ data, score, id }) => {
        console.log(`[Data Polling] 從 Minecraft 收到資料:`);
        console.log(`  - ID: ${id}`);
        console.log(`  - DATA: ${data}`);
        console.log(`  - SCORE: ${score}`);
        // 在這裡，你可以根據 'data' 的內容執行自訂邏輯
    });

    // 執行指令
    const responses = await wsServer.runCommand('say Hello from Javascript!');
    console.log("指令執行結果:", responses);

    // 示範傳送大量資料
    console.log("正在示範傳送大量資料...");
    const largeObject = {
        message: "這是一個從 Node.js 傳送的大物件!",
        timestamp: Date.now(),
        data: Array.from({ length: 100 }, (_, i) => `item_${i}`),
        nested: {
            info: "這是一個巢狀物件"
        }
    };
    await wsServer.sendData('myLargeData', largeObject);
    console.log("✅ 大量資料已傳送至 'myLargeData' 通道。");

    // 超大量資料傳送
    const longString = "這是一段非常非常非常長的字串，需要被分塊才能成功傳送到 Minecraft。".repeat(1000) + "flag{你好lol}";
    await wsServer.sendData('anotherChannel', longString);
    console.log("✅ 長字串已傳送至 'anotherChannel' 通道。");
}

main()