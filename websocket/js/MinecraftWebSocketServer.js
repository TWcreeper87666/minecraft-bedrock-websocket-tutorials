import { createServer } from "nodejs-websocket";
import EventEmitter from "events";
const WSS_MAXIMUM_BYTES = 661;
const MC_PROTOCOL_VERSION = 26; // 支援新版 execute

/**
 * @enum {string}
 * @description 可訂閱的 Minecraft WebSocket 事件。
 * @warning 大多數這些事件在目前版本的 Minecraft 中已不再支援，
 * 僅保留用於舊版相容性或未來可能重新啟用。
 * 目前已知可運作的事件非常有限，例如 'PlayerMessage'。
 */
export const MinecraftEvents = Object.freeze({
    AwardAchievement: "AwardAchievement",
    BlockPlaced: "BlockPlaced",
    BlockBroken: "BlockBroken",
    EndOfDay: "EndOfDay",
    GameRulesLoaded: "GameRulesLoaded",
    GameRulesUpdated: "GameRulesUpdated",
    PlayerMessage: "PlayerMessage",
    PlayerTeleported: "PlayerTeleported",
    PlayerTravelled: "PlayerTravelled",
    PlayerTransform: "PlayerTransform",
    ItemAcquired: "ItemAcquired",
    ItemCrafted: "ItemCrafted",
    ItemDropped: "ItemDropped",
    ItemEquipped: "ItemEquipped",
    ItemInteracted: "ItemInteracted",
    ItemNamed: "ItemNamed",
    ItemSmelted: "ItemSmelted",
    ItemUsed: "ItemUsed",
    BookEdited: "BookEdited",
    SignedBookOpened: "SignedBookOpened",
    MobBorn: "MobBorn",
    MobInteracted: "MobInteracted",
    MobKilled: "MobKilled",
    StartWorld: "StartWorld",
    WorldLoaded: "WorldLoaded",
    WorldGenerated: "WorldGenerated",
    ScriptLoaded: "ScriptLoaded",
    ScriptRan: "ScriptRan",
    ScreenChanged: "ScreenChanged",
    SlashCommandExecuted: "SlashCommandExecuted",
    SignInToXboxLive: "SignInToXboxLive",
    SignOutOfXboxLive: "SignOutOfXboxLive",
    VehicleExited: "VehicleExited"
});

export class MinecraftWebSocketServer {
    #connectionResolver = null;
    #eventSubscriptionCallbacks = new Map(); // Key: eventName (PascalCase), Value: Set<Function>

    constructor(port, showLog = false) {
        this.port = port;
        this.showLog = showLog; // 新增的日誌開關

        this.wsServer = null;
        this.clientConn = null;
        this.commandBatches = new Map(); // K: batchId, V: { commandCount, results, resolve, reject, timeout }
        this.requestIdToBatchId = new Map(); // K: requestId, V: batchId
        this.requestTimeoutMs = 60_000;
    }

    /**
     * 內部日誌函式，根據 `showLog` 參數決定是否輸出到 console。
     * @param {string} message - 要輸出的日誌訊息。
     * @private
     */
    #_log(message) {
        if (this.showLog) {
            console.log(`[WSS] ${message}`);
        }
    }

    start() {
        return new Promise((resolve, reject) => {
            if (this.wsServer) {
                return reject(new Error("伺服器已經在運行中。"));
            }

            this.#connectionResolver = { resolve, reject };

            this.wsServer = createServer((conn) => this.#onOpen(conn)).listen(this.port, () => {
                this.#_log(`✅ WebSocket 伺服器已啟動於端口 ${this.port}`);
                this.#_log(`等待連線中... (/wsserver localhost:${this.port})`);
            });

            this.wsServer.on("error", (err) => {
                this.#_log(`⚠️ 伺服器錯誤: ${err.message}`);
                if (this.#connectionResolver) {
                    this.#connectionResolver.reject(err);
                    this.#connectionResolver = null;
                }
            });
        });
    }

    stop(reason = "已停止") {
        if (this.wsServer) {
            this.wsServer.close(() => this.#_log("🛑 WebSocket 伺服器已停止"));
            this.wsServer = null;
        }

        if (this.clientConn) {
            this.clientConn?.socket.destroy();
            this.clientConn = null;
        }

        this.#_log(reason);
    }

    #onOpen(conn) {
        this.#_log(`🔗 客戶端已連線: ${conn.socket.remoteAddress}`);
        this.clientConn = conn;

        this.sendMessage("§l§b- WebSocket連接成功!");

        conn.on("text", (msg) => this.#onText(conn, msg));
        conn.on("close", (code, reason) => this.#onClose(conn, code, reason));
        conn.on("error", (err) => this.#onError(conn, err));

        if (this.#connectionResolver) {
            this.#connectionResolver.resolve();
            this.#connectionResolver = null;
        }
    }

    #onText(conn, message) {
        try {
            const data = JSON.parse(message);
            const header = data.header || {};
            const body = data.body || {};
            const eventName = header.eventName;

            if (eventName) {
                // 觸發透過 eventSubscribe 註冊的回呼函式
                const callbacks = this.#eventSubscriptionCallbacks.get(eventName);
                if (callbacks) {
                    callbacks.forEach(callback => callback(body, header));
                }
                // 不再透過 emitter 發送 Minecraft 遊戲事件
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
                this.#_log(`[Unhandled Message] Purpose: ${header.messagePurpose}, Event: ${eventName}`);
            }
        } catch (err) {
            this.#_log(`❌ 解析 JSON 時出錯: ${err.message}`);
        }
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

        const jsonString = JSON.stringify(data);
        const dataString = jsonString.replace(
            /[^\x00-\x7F]/g,
            (c) => `\\u${('0000' + c.charCodeAt(0).toString(16)).slice(-4)}`
        );
        const transferId = this.#generateId(4);

        // 輔助函式，用於計算給定指令的最終 WebSocket 酬載大小。
        // 我們使用一個範例 requestId，因為實際的 ID 是在 runCommands 內部生成的。
        // ID 的長度對於準確的大小計算很重要。
        const sampleRequestId = this.#generateId(); // #generateId() 預設長度為 3
        const getCommandPayloadSize = (command) => {
            const payload = {
                header: {
                    requestId: sampleRequestId,
                    messagePurpose: "commandRequest",
                    version: MC_PROTOCOL_VERSION,
                },
                body: {
                    commandLine: command,
                    version: MC_PROTOCOL_VERSION,
                },
            };
            return Buffer.byteLength(JSON.stringify(payload), 'utf8');
        };

        const chunks = [];
        let remainingData = dataString;
        let chunkIndex = 0;
        const commandBase = `scriptevent yb:${name}`;

        while (remainingData.length > 0) {
            const commandPrefix = `${commandBase} DATA:${chunkIndex}:${transferId}:`;

            // 使用二分搜尋法找到適合 WSS_MAXIMUM_BYTES 的最大資料塊
            let low = 0;
            let high = remainingData.length;
            let bestFitIndex = 0;

            while (low <= high) {
                const mid = Math.floor(low + (high - low) / 2);
                if (mid === 0) break; // 不能有長度為 0 的資料塊

                const candidateChunk = remainingData.substring(0, mid);
                const testCommand = commandPrefix + candidateChunk;
                const currentSize = getCommandPayloadSize(testCommand);

                if (currentSize <= WSS_MAXIMUM_BYTES) {
                    // 這個大小有效，嘗試更大的資料塊
                    bestFitIndex = mid;
                    low = mid + 1;
                } else {
                    // 太大了，縮小搜尋範圍
                    high = mid - 1;
                }
            }

            if (bestFitIndex === 0) {
                // 如果連一個字元都放不下，表示指令本身的開銷就已經超限了
                const overheadSize = getCommandPayloadSize(commandPrefix);
                throw new Error(`無法傳送資料：指令開銷太大 (${overheadSize} 位元組)，沒有足夠的空間容納資料。`);
            }

            const chunk = remainingData.substring(0, bestFitIndex);
            chunks.push(chunk);
            remainingData = remainingData.substring(bestFitIndex);
            chunkIndex++;
        }

        const totalChunks = chunks.length;

        this.#_log(`[${transferId}] 準備向 Minecraft [${name}] 傳送資料，共 ${totalChunks} 塊。`);

        const commands = [];

        // 1. START command
        commands.push(`${commandBase} START:${totalChunks}:${transferId}`);

        // 2. DATA commands
        chunks.forEach((chunk, i) => {
            commands.push(`${commandBase} DATA:${i}:${transferId}:${chunk}`);
        });

        // 3. END command
        commands.push(`${commandBase} END:${transferId}`);

        // 依序傳送所有指令。`runCommand` 會等待回應，這自然地調節了傳送速率並確保指令按順序處理。
        for (const command of commands) {
            try {
                await this.runCommand(command); // runCommand already logs
            } catch (e) {
                this.#_log(`❌ 傳送資料塊失敗 (ID: ${transferId}): ${e.message}. 傳送中止。`);
                throw new Error(`資料傳送中止: ${e.message}`);
            }
        }

        this.#_log(`✅ [${transferId}] 已成功向 Minecraft [${name}] 傳送所有資料塊。`);
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
            this.clientConn = null; // Clear clientConn only if it's the one that closed
        }
        this.#_log(`🚫 客戶端已斷線: 程式碼 ${code}, 原因 ${reason}`);
    }

    #onError(conn, err) {
        this.#_log(`⚠️ 連線錯誤: ${err.message}`);
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
            this.#_log(`⚠️ 無法執行指令 "${command}"：連線已關閉`);
            return;
        }

        const reqId = requestId || this.#generateId();
        const payload = JSON.stringify({
            header: {
                requestId: reqId,
                messagePurpose: "commandRequest",
                version: MC_PROTOCOL_VERSION,
            },
            body: {
                commandLine: command,
                version: MC_PROTOCOL_VERSION,
            },
        });

        if (Buffer.byteLength(payload, "utf8") > WSS_MAXIMUM_BYTES) {
            this.sendMessage("§c[runCommand] 指令太長無法執行");
            this.#_log(`⚠️ 傳送的酬載過大 (${payload.length} 位元組)`);
            return;
        }

        // 為所有指令（無論是單個還是批次）統一記錄日誌，並顯示請求 ID (前5位)
        this.#_log(`[${reqId.slice(0, 5)}] 執行中: ${command}`);
        this.clientConn.sendText(payload);
    }

    /**
     * 註冊 Minecraft 遊戲事件訂閱。
     * 當指定的 Minecraft 遊戲事件發生時，會觸發提供的回呼函式。
     * @param {string} eventName - 要訂閱的 Minecraft 事件名稱 (PascalCase)。建議使用 `MinecraftEvents` 列舉。
     * @param {(body: object, header: object) => void} callback - 當事件觸發時要執行的回呼函式。
     * @throws {Error} 如果連線未建立或已關閉，或 callback 不是函式。
     */
    eventSubscribe(eventName, callback) {
        if (!this.clientConn || this.clientConn.closed) {
            throw new Error(`無法訂閱事件 "${eventName}"：連線已關閉`);
        }
        if (typeof callback !== 'function') {
            throw new Error(`訂閱事件 "${eventName}" 必須提供一個回呼函式。`);
        }

        // 如果是第一次訂閱此事件，則向 Minecraft 發送訂閱請求
        if (!this.#eventSubscriptionCallbacks.has(eventName) || this.#eventSubscriptionCallbacks.get(eventName).size === 0) {
            const payload = {
                header: {
                    requestId: this.#generateId(8),
                    messagePurpose: "subscribe",
                    version: MC_PROTOCOL_VERSION,
                },
                body: {
                    eventName,
                },
            };
            this.clientConn.sendText(JSON.stringify(payload));
            this.#_log(`🔔 已向 Minecraft 請求訂閱事件: ${eventName}`);
        }

        // 將回呼函式儲存起來
        let callbacks = this.#eventSubscriptionCallbacks.get(eventName);
        if (!callbacks) {
            callbacks = new Set();
            this.#eventSubscriptionCallbacks.set(eventName, callbacks); // Ensure it's set if new
        }
        callbacks.add(callback);
        this.#_log(`✅ 已註冊本地回呼函式用於事件: ${eventName}`);

        // 懶得處理 unsubscribe
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