import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, system, world, } from "@minecraft/server";
// 建議將 ScriptEventDataManager.ts 檔名也改為 WebSocketBridge.ts
import { WebSocketBridge } from "./websocket/WebSocketBridge";
// --- 實例化與使用範例 ---
const wsBridge = WebSocketBridge.getInstance();
// --- 監聽從外部傳入的資料 ---
wsBridge.onData("myLargeData", (data, delay) => {
    world.sendMessage(`§a[WSS-IN] 成功接收到資料！(延遲: ${delay} ticks) 內容:\n§f${JSON.stringify(data)}`);
});
wsBridge.onData("anotherChannel", (data, delay) => {
    world.sendMessage(`§b[WSS-IN] 來自 'anotherChannel' 的訊息 (延遲: ${delay} ticks)\n§f...${data.slice(-30)}`);
});
// --- 從遊戲內傳送資料到外部 ---
system.run(() => {
    const data = "早上好".repeat(100);
    const score = 69;
    wsBridge.sendData(data, score);
    world.sendMessage(`§e[WSS-OUT] 已嘗試將資料傳送至外部: "${data}" 分數: ${score}`);
});
// --- 自定義指令範例 ---
system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
    customCommandRegistry.registerCommand({
        name: "yb:send",
        description: "傳送資料給 wsServer",
        permissionLevel: CommandPermissionLevel.GameDirectors,
        mandatoryParameters: [
            { name: "data", type: CustomCommandParamType.String },
        ],
        optionalParameters: [
            { name: "score", type: CustomCommandParamType.Integer },
        ],
    }, (origin, data, score) => {
        system.run(() => wsBridge.sendData(data, score));
        return {
            status: CustomCommandStatus.Success,
            message: `§e[WSS-OUT] 已嘗試將資料傳送至外部: "${data}" 分數: ${score}`,
        };
    });
});
