/**
 * interactive-cli.js
 *
 * 這個腳本提供一個互動式的終端機介面 (CLI)，
 * 讓你可以直接在終端機輸入 Minecraft 指令並立即執行。
 *
 * 如何執行:
 * node interactive-cli.js
 */

import readline from 'readline';
import { MinecraftEvents, MinecraftWebSocketServer } from "./MinecraftWebSocketServer.js";

// ANSI escape codes for colors to make the output more readable
const colors = {
    reset: "\x1b[0m",
    cyan: "\x1b[36m",    // For user prompt
    yellow: "\x1b[33m",  // For server responses
    red: "\x1b[31m",      // For errors and stop status
    gray: "\x1b[90m",     // For general logs
    green: "\x1b[32m"     // For success status
};

async function main() {
    // 啟用日誌輸出，以便在 CLI 中看到伺服器內部訊息
    const wsServer = new MinecraftWebSocketServer(5218, true);

    try {
        await wsServer.start();
        console.log(`${colors.green}[Status] 伺服器已啟動並等待連線。${colors.reset}`);

        // 訂閱 PlayerMessage 事件，以便在 CLI 中顯示玩家聊天訊息
        wsServer.eventSubscribe(MinecraftEvents.PlayerMessage, (body) => {
            // 當非同步訊息 (如聊天) 進來時，在不干擾使用者輸入的情況下印出
            readline.cursorTo(process.stdout, 0);
            readline.clearLine(process.stdout, 0);
            console.log(`\n${colors.gray}[Chat] <${body.sender}> ${body.message}${colors.reset}`);
            // 重新顯示提示符號和使用者已輸入的內容
            rl.prompt(true);
        });

    } catch (error) {
        console.error(`${colors.red}無法啟動伺服器: ${error.message}${colors.reset}`);
        process.exit(1);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        // Set a colored prompt to distinguish user input area
        prompt: `${colors.cyan}mc> ${colors.reset}`
    });

    // Display the initial prompt
    rl.prompt();

    rl.on('line', async (line) => {
        const command = line.trim();

        if (command.toLowerCase() === 'close') {
            console.log('正在關閉伺服器...');
            rl.close(); // This will trigger the 'close' event
            return;
        }

        if (command) {
            try {
                // The user's input is already on the screen.
                // We execute the command and wait for the result.
                const response = await wsServer.runCommand(command);
                // Print the server's response in a different color for contrast.
                console.log(`${colors.yellow}  <-- ${response}${colors.reset}`);
            } catch (error) {
                console.error(`${colors.red}  <-- 指令執行錯誤: ${error.message}${colors.reset}`);
            }
        }

        // Prompt for the next command
        rl.prompt();
    }).on('close', () => {
        wsServer.stop("使用者關閉終端機");
        console.log('\n終端機介面已關閉。');
        process.exit(0);
    });

    // Gracefully handle Ctrl+C
    process.on('SIGINT', () => {
        rl.close();
    });
}

main();