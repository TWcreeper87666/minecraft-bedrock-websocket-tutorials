import { MinecraftWebSocketServer } from "./MinecraftWebSocketServer.js";

async function main() {
    const wsServer = new MinecraftWebSocketServer(5218)

    wsServer.on('log', (message) => console.log(`[WSS] ${message}`));
    // 監聽玩家聊天訊息
    wsServer.on('playerMessage', (sender, msg, body) => {
        console.log(`[Chat] <${sender}> ${msg}`);
    });

    await wsServer.start();

    const responses = await wsServer.runCommand('say Hello from Javascript!');
    console.log("指令執行結果:", responses);

    // 示範傳送大量資料
    console.log("正在示範傳送大量資料...");
    try {
        const largeObject = {
            message: "這是一個從 Node.js 傳送的大物件!",
            timestamp: Date.now(),
            data: Array.from({ length: 100 }, (_, i) => `item_${i}`),
            nested: {
                info: "這是一個巢狀物件"
            }
        };
        await wsServer.sendDataToMinecraft('myLargeData', largeObject);
        console.log("✅ 大量資料已傳送至 'myLargeData' 通道。");

        const longString = "這是一段非常非常非常長的字串，需要被分塊才能成功傳送到 Minecraft。".repeat(20);
        await wsServer.sendDataToMinecraft('anotherChannel', longString);
        console.log("✅ 長字串已傳送至 'anotherChannel' 通道。");
    } catch (error) {
        console.error("傳送大量資料時發生錯誤:", error);
    }
}

main()