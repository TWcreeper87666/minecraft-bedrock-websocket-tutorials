import { world } from "@minecraft/server";
import "./websocket/ScriptEventDataManager";
import { ScriptEventDataManager } from "./websocket/ScriptEventDataManager";
// --- 實例化與使用範例 ---
const dataManager = new ScriptEventDataManager();
dataManager.onData("myLargeData", (data, delay) => {
    world.sendMessage(`§a[WSS] 成功接收到資料！(延遲: ${delay} ticks) 內容:\n§f${JSON.stringify(data)}`);
});
dataManager.onData("anotherChannel", (data, delay) => {
    world.sendMessage(`§b[WSS] 來自 'anotherChannel' 的訊息 (延遲: ${delay} ticks)\n§f${data}`);
});
