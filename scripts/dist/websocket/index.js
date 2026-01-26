import { system } from "@minecraft/server";
/**
 * 處理從 WebSocket 伺服器透過 scriptevent 傳來的大量分塊資料。
 *
 * 協定:
 * 1. 開始: scriptevent yb:<name> START:<total_chunks>:<transfer_id>
 * 2. 資料: scriptevent yb:<name> DATA:<chunk_index>:<transfer_id>:<base64_chunk>
 * 3. 結束: scriptevent yb:<name> END:<transfer_id>
 */
export class ScriptEventDataManager {
    constructor() {
        this.incomingTransfers = new Map();
        this.listeners = new Map();
        this.TIMEOUT_TICKS = 30 * 20; // 30 秒 (600 遊戲刻) 內需接收到所有區塊
        // 只監聽我們自訂的 'yb' 命名空間
        system.afterEvents.scriptEventReceive.subscribe((event) => this.handleScriptEvent(event), { namespaces: ["yb"] });
    }
    /**
     * 訂閱一個具名資料事件。
     * @param name 要監聽的資料名稱。
     * @param callback 當資料完全接收後要呼叫的函式。
     */
    onData(name, callback) {
        this.listeners.set(name, callback);
        console.log(`[DataManager] 已註冊監聽 '${name}' 的資料。`);
    }
    /**
     * 取消訂閱一個具名資料事件。
     * @param name 要停止監聽的資料名稱。
     */
    offData(name) {
        this.listeners.delete(name);
        console.log(`[DataManager] 已取消監聽 '${name}' 的資料。`);
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
                    console.warn(`[DataManager] 收到無效的 START 訊息: ${message}`);
                    return;
                }
                if (this.incomingTransfers.has(transferId)) {
                    system.clearRun(this.incomingTransfers.get(transferId).timeout);
                }
                const timeout = system.runTimeout(() => {
                    // 這裡的單位是遊戲刻
                    this.incomingTransfers.delete(transferId);
                    console.warn(`[DataManager] 資料傳輸 ${transferId} ('${name}') 已超時。`);
                }, this.TIMEOUT_TICKS);
                this.incomingTransfers.set(transferId, {
                    name,
                    totalChunks,
                    receivedChunks: new Map(),
                    timeout,
                });
            }
            else if (type === "DATA") {
                // DATA:<chunk_index>:<transfer_id>:<base64_chunk>
                const chunkIndex = parseInt(parts[1], 10);
                const transferId = parts[2];
                const chunkData = parts.slice(3).join(":");
                if (isNaN(chunkIndex) || !transferId || chunkData === undefined) {
                    console.warn(`[DataManager] 收到無效的 DATA 訊息: ${message}`);
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
                    console.warn(`[DataManager] 收到 ${transferId} 的結束訊號，但區塊不完整。預期 ${transfer.totalChunks}, 收到 ${transfer.receivedChunks.size}。`);
                    system.clearRun(transfer.timeout);
                    this.incomingTransfers.delete(transferId);
                }
            }
        }
        catch (e) {
            console.error(`[DataManager] 處理 scriptevent 時發生錯誤: ${e}`);
        }
    }
    processCompleteTransfer(transferId, transfer) {
        system.clearRun(transfer.timeout);
        this.incomingTransfers.delete(transferId);
        let b64String = "";
        for (let i = 0; i < transfer.totalChunks; i++) {
            const chunk = transfer.receivedChunks.get(i);
            if (chunk === undefined) {
                console.error(`[DataManager] 傳輸 ${transferId} 遺失區塊 #${i}，處理中止。`);
                return;
            }
            b64String += chunk;
        }
        try {
            // 首先，將 Base64 字串解碼為 "byte string" (其中每個字元的 charCode 代表一個 byte)。
            const byteString = this.decodeBase64(b64String);
            // 接著，為了正確處理像中文這樣的多位元組字元，我們需要將這個 byte string 解譯為 UTF-8。
            // decodeURIComponent(escape(...)) 是一個處理此問題的有效技巧。
            const decodedString = decodeURIComponent(escape(byteString));
            let finalData;
            try {
                finalData = JSON.parse(decodedString);
            }
            catch {
                finalData = decodedString;
            }
            const listener = this.listeners.get(transfer.name);
            if (listener)
                listener(finalData);
        }
        catch (e) {
            console.error(`[DataManager] 解碼或解析來自 '${transfer.name}' 的資料時失敗: ${e}`);
        }
    }
    decodeBase64(b64) {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
        let str = b64.replace(/=+$/, "");
        let output = "";
        if (str.length % 4 === 1)
            throw new Error("無效的 Base64 字串");
        for (let bc = 0, bs = 0, buffer, i = 0; (buffer = str.charAt(i++)); ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
            ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
            : 0) {
            buffer = chars.indexOf(buffer);
        }
        return output;
    }
}
