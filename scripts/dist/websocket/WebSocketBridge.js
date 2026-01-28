import { system, world } from "@minecraft/server";
/**
 * 專門處理與外部 WebSocket 伺服器交互的橋樑。
 * - 處理透過 `scriptevent` 傳入的分塊資料。
 * - 提供方法透過 `scoreboard` 將資料傳出。
 *
 * 傳入協定 (scriptevent):
 * 1. 開始: scriptevent yb:<name> START:<total_chunks>:<transfer_id>
 * 2. 資料: scriptevent yb:<name> DATA:<chunk_index>:<transfer_id>:<chunk_data>
 * 3. 結束: scriptevent yb:<name> END:<transfer_id>
 *
 * 傳出協定 (scoreboard):
 * 1. `scoreboard objectives add <unique_name> dummy "<data>"`
 * 2. `scoreboard players set yb:data <unique_name> <score>`
 */
export class WebSocketBridge {
    constructor() {
        this.incomingTransfers = new Map();
        this.listeners = new Map();
        this.TIMEOUT_TICKS = 30 * 20; // 30 秒 (600 遊戲刻) 內需接收到所有區塊
        // 只監聽我們自訂的 'yb' 命名空間
        system.afterEvents.scriptEventReceive.subscribe((event) => this.handleScriptEvent(event), { namespaces: ["yb"] });
    }
    /**
     * 獲取 WebSocketBridge 的單例實例。
     * @returns {WebSocketBridge}
     */
    static getInstance() {
        if (!WebSocketBridge.instance) {
            WebSocketBridge.instance = new WebSocketBridge();
        }
        return WebSocketBridge.instance;
    }
    /**
     * 訂閱一個具名資料事件。
     * @param name 要監聽的資料名稱。
     * @param callback 當資料完全接收後要呼叫的函式，會傳入資料內容與傳輸延遲(tick)。
     */
    onData(name, callback) {
        this.listeners.set(name, callback);
        console.log(`[WebSocketBridge] 已註冊監聽 '${name}' 的資料。`);
    }
    /**
     * 取消訂閱一個具名資料事件。
     * @param name 要停止監聽的資料名稱。
     */
    offData(name) {
        this.listeners.delete(name);
        console.log(`[WebSocketBridge] 已取消監聽 '${name}' 的資料。`);
    }
    /**
     * 透過記分板機制將資料傳送到外部 WebSocket 伺服器。
     * 外部伺服器需要輪詢 'scoreboard players list yb:data' 來接收。
     * @param data 要傳送的字串資料。這將成為記分板目標的顯示名稱。
     * @param score 一個可選的分數，可用於排序或作為 ID。預設為 0。
     */
    async sendData(data, score = 0) {
        const obj = world.scoreboard.addObjective(this.generateId(3), JSON.stringify(data));
        obj.addScore("yb:data", score);
        await system.waitTicks(100);
        if (obj.isValid) {
            throw new Error(`資料未被 websocket server 接收 ${data} ${score}`);
        }
    }
    handleScriptEvent({ id, message, }) {
        const name = id.substring("yb:".length);
        const parts = message.split(":");
        const type = parts[0];
        try {
            if (type === "START") {
                // START:<total_chunks>:<transfer_id>
                const totalChunks = parseInt(parts[1], 10);
                const transferId = parts[2];
                if (isNaN(totalChunks) || !transferId) {
                    console.warn(`[WebSocketBridge] 收到無效的 START 訊息: ${message}`);
                    return;
                }
                if (this.incomingTransfers.has(transferId)) {
                    system.clearRun(this.incomingTransfers.get(transferId).timeout);
                }
                const timeout = system.runTimeout(() => {
                    // 這裡的單位是遊戲刻
                    this.incomingTransfers.delete(transferId);
                    console.warn(`[WebSocketBridge] 資料傳輸 ${transferId} ('${name}') 已超時。`);
                }, this.TIMEOUT_TICKS);
                this.incomingTransfers.set(transferId, {
                    name,
                    totalChunks,
                    receivedChunks: new Map(),
                    timeout,
                    startTime: system.currentTick,
                });
            }
            else if (type === "DATA") {
                // DATA:<chunk_index>:<transfer_id>:<chunk_data>
                const chunkIndex = parseInt(parts[1], 10);
                const transferId = parts[2];
                const chunkData = parts.slice(3).join(":");
                if (isNaN(chunkIndex) || !transferId || chunkData === undefined) {
                    console.warn(`[WebSocketBridge] 收到無效的 DATA 訊息: ${message}`);
                    return;
                }
                const transfer = this.incomingTransfers.get(transferId);
                if (transfer) {
                    transfer.receivedChunks.set(chunkIndex, chunkData);
                }
            }
            else if (type === "END") {
                // END:<transfer_id>
                const transferId = parts[1];
                const transfer = this.incomingTransfers.get(transferId);
                if (!transfer)
                    return;
                if (transfer.receivedChunks.size === transfer.totalChunks) {
                    this.processCompleteTransfer(transferId, transfer);
                }
                else {
                    console.warn(`[WebSocketBridge] 收到 ${transferId} 的結束訊號，但區塊不完整。預期 ${transfer.totalChunks}, 收到 ${transfer.receivedChunks.size}。`);
                    system.clearRun(transfer.timeout);
                    this.incomingTransfers.delete(transferId);
                }
            }
        }
        catch (e) {
            console.error(`[WebSocketBridge] 處理 scriptevent 時發生錯誤: ${e}`);
        }
    }
    processCompleteTransfer(transferId, transfer) {
        system.clearRun(transfer.timeout);
        this.incomingTransfers.delete(transferId);
        let reassembledString = "";
        for (let i = 0; i < transfer.totalChunks; i++) {
            const chunk = transfer.receivedChunks.get(i);
            if (chunk === undefined) {
                console.error(`[WebSocketBridge] 傳輸 ${transferId} 遺失區塊 #${i}，處理中止。`);
                return;
            }
            reassembledString += chunk;
        }
        try {
            // 嘗試將重組後的字串解析為 JSON。
            // 如果失敗，則將其視為普通字串。
            let finalData;
            try {
                finalData = JSON.parse(reassembledString);
            }
            catch {
                finalData = reassembledString;
            }
            const listener = this.listeners.get(transfer.name);
            if (listener) {
                const delay = system.currentTick - transfer.startTime;
                listener(finalData, delay);
            }
        }
        catch (e) {
            console.error(`[WebSocketBridge] 處理來自 '${transfer.name}' 的完整資料時失敗: ${e}`);
        }
    }
    generateId(length = 3) {
        const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let id = "";
        for (let i = 0; i < length; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
    }
}
