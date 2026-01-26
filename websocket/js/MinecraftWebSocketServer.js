import { createServer } from "nodejs-websocket";
import EventEmitter from "events";
const WSS_MAXIMUM_BYTES = 661;

export class MinecraftWebSocketServer {
    #emitter = new EventEmitter();
    #connectionResolver = null;

    constructor(port) {
        this.port = port;

        this.wsServer = null;
        this.clientConn = null;

        this.commandBatches = new Map(); // K: batchId, V: { commandCount, results, resolve, reject, timeout }
        this.requestIdToBatchId = new Map(); // K: requestId, V: batchId
        this.requestTimeoutMs = 60_000;
    }

    /**
     * 監聽伺服器事件。
     * @param {'log' | 'statusUpdate' | 'playerMessage' | 'itemInteracted' | 'blockPlaced' | 'blockBroken' | 'playerTravelled' | 'message'} eventName - 要監聽的事件名稱 (camelCase)。
     * @param {(...args: any[]) => void} listener - 事件觸發時要執行的回呼函式。
     * @returns {this}
     */
    on(eventName, listener) {
        this.#emitter.on(eventName, listener);
        return this;
    }

    /**
     * 監聽一次性的伺服器事件。
     * @param {'log' | 'statusUpdate' | 'playerMessage' | 'itemInteracted' | 'blockPlaced' | 'blockBroken' | 'playerTravelled' | 'message'} eventName - 要監聽的事件名稱 (camelCase)。
     * @param {(...args: any[]) => void} listener - 事件觸發時要執行的回呼函式。
     * @returns {this}
     */
    once(eventName, listener) {
        this.#emitter.once(eventName, listener);
        return this;
    }

    /**
     * 移除指定的事件監聽器。
     * @param {'log' | 'statusUpdate' | 'playerMessage' | 'itemInteracted' | 'blockPlaced' | 'blockBroken' | 'playerTravelled' | 'message'} eventName - 要移除監聽器的事件名稱 (camelCase)。
     * @param {(...args: any[]) => void} listener - 先前附加的監聽器函式。
     * @returns {this}
     */
    off(eventName, listener) {
        this.#emitter.off(eventName, listener);
        return this;
    }

    start() {
        return new Promise((resolve, reject) => {
            if (this.wsServer) {
                return reject(new Error("伺服器已經在運行中。"));
            }

            this.#connectionResolver = { resolve, reject };

            this.wsServer = createServer((conn) => this.#onOpen(conn)).listen(this.port, () => {
                this.#emitter.emit("log", `✅ WebSocket 伺服器已啟動於端口 ${this.port}`);
                this.#emitter.emit("statusUpdate", `等待連線中... (/wsserver localhost:${this.port})`);
            });

            this.wsServer.on("error", (err) => {
                this.#onError(null, err);
                if (this.#connectionResolver) {
                    this.#connectionResolver.reject(err);
                    this.#connectionResolver = null;
                }
            });
        });
    }

    stop(reason = "已停止") {
        if (this.wsServer) {
            this.wsServer.close(() => this.#emitter.emit("log", "🛑 WebSocket 伺服器已停止"));
            this.wsServer = null;
        }

        if (this.clientConn) {
            this.clientConn?.socket.destroy();
            this.clientConn = null;
        }

        this.#emitter.emit("statusUpdate", reason);
    }

    #onOpen(conn) {
        this.#emitter.emit("log", `🔗 客戶端已連線: ${conn.socket.remoteAddress}`);
        this.#emitter.emit("statusUpdate", "連線成功");
        this.clientConn = conn;

        this.sendMessage("§l§b- WebSocket連接成功!");
        this.eventSubscribe("PlayerMessage");

        conn.on("text", (msg) => this.#onMessage(conn, msg));
        conn.on("close", (code, reason) => this.#onClose(conn, code, reason));
        conn.on("error", (err) => this.#onError(conn, err));

        if (this.#connectionResolver) {
            this.#connectionResolver.resolve();
            this.#connectionResolver = null;
        }
    }

    #onMessage(conn, message) {
        try {
            const data = JSON.parse(message);
            const header = data.header || {};
            const body = data.body || {};
            const eventName = header.eventName;

            if (eventName) {
                const camelCaseEventName = eventName.charAt(0).toLowerCase() + eventName.slice(1);

                // 對聊天訊息進行特殊處理，提供更簡潔的參數
                if (camelCaseEventName === 'playerMessage' && body.type === 'chat') {
                    const sender = body.sender;
                    const msg = body.message;
                    this.#emitter.emit('playerMessage', sender, msg, body);
                } else {
                    // 對於所有其他訂閱的事件，發送原始 body
                    this.#emitter.emit(camelCaseEventName, body);
                }
            } else if (header.messagePurpose === "commandResponse") {
                const requestId = header.requestId;
                const statusMessage = body.statusMessage || "success";
                const batchId = this.requestIdToBatchId.get(requestId);

                if (batchId && this.commandBatches.has(batchId)) {
                    this.requestIdToBatchId.delete(requestId);
                    const batch = this.commandBatches.get(batchId);
                    batch.results.push(statusMessage);

                    if (batch.results.length === batch.commandCount) {
                        clearTimeout(batch.timeout);
                        this.commandBatches.delete(batchId);
                        batch.resolve(batch.results);
                    }
                }
            } else {
                this.#emitter.emit("message", header, body);
            }
        } catch (err) {
            this.#emitter.emit("log", `❌ 解析 JSON 時出錯: ${err.message}`);
        }
    }

    playerMessage(sender, message) {
        this.#emitter.emit("log", `[Chat] <${sender}> ${message}`);
    }

    /**
     * 執行單一指令並等待結果。
     * @param {string} command - 要執行的指令。
     * @returns {Promise<string>} 一個解析為指令執行結果的 Promise。
     */
    async runCommand(command) {
        const results = await this.runCommands([command]);
        return results[0];
    }

    /**
     * 傳送大量資料到 Minecraft。
     * 資料會被分塊並透過 scriptevent 傳送。
     * @param {string} name - 資料的唯一名稱/頻道。
     * @param {string | object} data - 要傳送的資料。如果是物件，會被 JSON.stringify。
     * @returns {Promise<void>}
     */
    async sendDataToMinecraft(name, data) {
        if (!this.clientConn || this.clientConn.closed) {
            throw new Error("連線尚未建立或已關閉，無法傳送資料");
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            // Minecraft 'scriptevent' namespace/id has restrictions. This is a safe subset.
            throw new Error("名稱只能包含字母、數字、底線和連字號。");
        }
        if (name.length > 64) {
            throw new Error("名稱長度不能超過 64 個字元。");
        }

        const dataString = typeof data === 'string' ? data : JSON.stringify(data);
        const dataB64 = Buffer.from(dataString).toString('base64');
        const transferId = this.#generateId(4);

        // 經過計算的區塊大小，以避免超過指令長度限制。
        // WebSocket 總酬載限制為 WSS_MAXIMUM_BYTES (661 位元組)。
        // 酬載結構與指令前綴 (`scriptevent yb:<name> DATA:<index>:<id>:`) 會消耗一部分空間。
        // CHUNK_SIZE <= 661 - (JSON 包裝開銷) - (指令前綴開銷)
        // CHUNK_SIZE <= 661 - ~132 - ~(27 + name.length + index.toString().length)
        // 假設 name 長度上限為 64，index 位數為 7 (支援到 GB 等級的資料)，一個安全的大小約為 400。
        const CHUNK_SIZE = 400;
        const chunks = [];
        for (let i = 0; i < dataB64.length; i += CHUNK_SIZE) {
            chunks.push(dataB64.substring(i, i + CHUNK_SIZE));
        }
        const totalChunks = chunks.length;

        this.#emitter.emit("log", `[${transferId}] 準備向 Minecraft [${name}] 傳送資料，共 ${totalChunks} 塊。`);

        const commandBase = `scriptevent yb:${name}`;
        const commands = [];

        // 1. START command
        commands.push(`${commandBase} START:${totalChunks}:${transferId}`);

        // 2. DATA commands
        chunks.forEach((chunk, i) => {
            commands.push(`${commandBase} DATA:${i}:${transferId}:${chunk}`);
        });

        // 3. END command
        commands.push(`${commandBase} END:${transferId}`);

        // Send all commands sequentially. `runCommand` waits for a response, which
        // naturally throttles the sending rate and ensures commands are processed in order.
        for (const command of commands) {
            try {
                await this.runCommand(command);
            } catch (e) {
                this.#emitter.emit("log", `❌ 傳送資料塊失敗 (ID: ${transferId}): ${e.message}. 傳送中止。`);
                throw new Error(`資料傳送中止: ${e.message}`);
            }
        }

        this.#emitter.emit("log", `✅ [${transferId}] 已成功向 Minecraft [${name}] 傳送所有資料塊。`);
    }

    /**
     * 執行一批指令並等待所有結果
     * @param {string[]} commands
     * @returns {Promise<string[]>}
     */
    runCommands(commands) {
        return new Promise((resolve, reject) => {
            if (!this.clientConn || this.clientConn.closed) {
                return reject("連線尚未建立或已關閉，無法執行指令");
            }

            const batchId = this.#generateId();
            const requestIds = commands.map(() => this.#generateId());

            const batch = {
                commandCount: commands.length,
                results: [],
                resolve,
                reject,
                timeout: setTimeout(() => {
                    // 清理超時的批次
                    requestIds.forEach((reqId) => this.requestIdToBatchId.delete(reqId));
                    this.commandBatches.delete(batchId);
                    reject(`指令批次執行超時 (${this.requestTimeoutMs}ms)`);
                }, this.requestTimeoutMs),
            };
            this.commandBatches.set(batchId, batch);

            commands.forEach((command, index) => {
                const requestId = requestIds[index];
                this.requestIdToBatchId.set(requestId, batchId);
                this.#internalRunCommand(command, requestId);
            });
        });
    }

    #onClose(conn, code, reason) {
        if (!this.wsServer) return;
        if (this.clientConn === conn) {
            this.clientConn = null;
        }
        this.#emitter.emit("log", `🚫 客戶端已斷線: 程式碼 ${code}, 原因 ${reason}`);
        this.#emitter.emit("statusUpdate", "已暫停: Minecraft 離線");
    }

    #onError(conn, err) {
        this.#emitter.emit("log", `⚠️ 發生錯誤: ${err}`);
        this.#emitter.emit("statusUpdate", `已暫停: ${err?.message || "未知錯誤"}`);
    }

    /**
     * 傳送遊戲內訊息，使用 tellraw 並處理分段
     * @param {string} message
     */
    sendMessage(message) {
        if (!this.clientConn || this.clientConn.closed) return;

        let remaining = message;
        while (remaining.length > 0) {
            let bestChunk = "";
            let bestLength = 0;

            if (this.#estimateFinalPayloadBytes(remaining) <= WSS_MAXIMUM_BYTES) {
                bestChunk = remaining;
                bestLength = remaining.length;
            } else {
                for (let i = 1; i <= remaining.length; i++) {
                    const candidate = remaining.substring(0, i);
                    if (this.#estimateFinalPayloadBytes(candidate) > WSS_MAXIMUM_BYTES) break;
                    bestChunk = candidate;
                    bestLength = i;
                }
            }

            const escapedCommand = JSON.stringify(bestChunk);
            this.runCommand(`tellraw @a {"rawtext":[{"text":${escapedCommand}}]}`);
            remaining = remaining.substring(bestLength);
        }
    }

    /**
     * (內部使用) 準備並傳送單一指令的酬載。
     * @param {string} command - 要執行的指令
     * @param {string | null} requestId - 用於追蹤的請求 ID
     * @private
     */
    #internalRunCommand(command, requestId = null) {
        if (!this.clientConn || this.clientConn.closed) {
            this.#emitter.emit("log", `⚠️ 無法執行指令 "${command}"：連線已關閉`);
            return;
        }

        const reqId = requestId || this.#generateId();
        const payload = JSON.stringify({
            header: {
                requestId: reqId,
                messagePurpose: "commandRequest",
                version: 17104896,
            },
            body: {
                commandLine: command,
                version: 17104896,
            },
        });

        if (Buffer.byteLength(payload, "utf8") > WSS_MAXIMUM_BYTES) {
            this.sendMessage("§c[runCommand] 指令太長無法執行");
            this.#emitter.emit("log", `⚠️ 傳送的酬載過大 (${payload.length} 位元組)`);
            return;
        }

        // 為所有指令（無論是單個還是批次）統一記錄日誌，並顯示請求 ID
        this.#emitter.emit("log", `[${reqId.slice(0, 5)}] 執行中: ${command}`);
        this.clientConn.sendText(payload);
    }

    /**
     * 註冊事件訂閱，並可選擇性地附加一個回呼函式。
     * @param {'ItemInteracted' | 'BlockPlaced' | 'BlockBroken' | 'PlayerTravelled' | 'PlayerMessage'} eventName - 要訂閱的 Minecraft 事件名稱 (PascalCase)。
     * @param {(body: object) => void} [callback] - 當事件觸發時要執行的回呼函式。
     * @returns {this}
     */
    eventSubscribe(eventName, callback) {
        if (!this.clientConn || this.clientConn.closed) {
            this.#emitter.emit("log", `⚠️ 無法訂閱事件 "${eventName}"：連線已關閉`);
            return this;
        }

        const payload = {
            header: {
                requestId: this.#generateId(8),
                messagePurpose: "subscribe",
                version: 17104896,
            },
            body: {
                eventName,
            },
        };
        this.clientConn.sendText(JSON.stringify(payload));
        this.#emitter.emit("log", `🔔 已訂閱事件: ${eventName}`);

        if (callback && typeof callback === 'function') {
            const camelCaseEventName = eventName.charAt(0).toLowerCase() + eventName.slice(1);
            this.on(camelCaseEventName, callback);
        }
        return this;
    }

    /**
     * 估計最終有效酬載的位元組數
     * @param {string} message - 訊息字串
     * @returns {number} 估計的位元組數
     * @private
     */
    #estimateFinalPayloadBytes(message) {
        const usedBytes = 190;
        const backtickEscapeLength = (message.match(/`/g) || []).length * 5;
        const escapedMessage = JSON.stringify(JSON.stringify(message));
        const textLength = Buffer.byteLength(escapedMessage, "utf8");
        return usedBytes + backtickEscapeLength + textLength;
    }

    /**
     * 產生一個短的隨機 ID
     * @param {number} [length=3] - ID 的長度
     * @returns {string}
     * @private
     */
    #generateId(length = 3) {
        const chars =
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let id = "";
        for (let i = 0; i < length; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
    }
}