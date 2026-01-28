# Websocket 連線與交互

讓你的 Minecraft Bedrock Edition 可以與外部環境互動。

使用 javascript，接口都寫好了，也有範例的交互方法，建議先把 API 學好再來玩這個 [MCBE 腳本 API 教學](https://youtu.be/mBSe_FHtWWo?si=Sc1spwI0MBTzPAnJ)。

[![介紹影片](https://img.youtube.com/vi/bSNMS_0zMOQ/maxresdefault.jpg)](https://youtu.be/bSNMS_0zMOQ)


## 開啟 Websocket Server

- 安裝套件（可以參考 [MCBE 腳本 API 教學](https://youtu.be/mBSe_FHtWWo?si=Sc1spwI0MBTzPAnJ) 安裝 Node.js）
```
npm install nodejs-websocket
```
- 設定記得打開【設定 > 一般 > 已啟用 Websockets】（無加密）

1. 在 `./websocket` 開啟終端機運行下面指令開啟 Websocket Server
```
node index.js
```
2. 到遊戲輸入你的 port 就能連上了（範例使用 5218）
```
/wsserver localhost:5218
/connect localhost:5218 // 也行
```

## 訂閱事件

大部分已無法使用，能用的就自己 console.log 看一下結構吧。
```js
// ./websocket/index.js

// 監聽玩家聊天訊息
wsServer.onEvent(MinecraftEvents.PlayerMessage, (body) => {
    if (body.type === 'chat') console.log(`[Chat] <${body.sender}> ${body.message}`);
});
```

## 傳送資料到 Minecraft（外部 -> 內部）

只需要用 `sendData` 即可傳送物件到 Minecraft，資料量很大也沒問題，只是會有延遲。很在意延遲的話建議自己壓縮一下資料再傳送（例如用陣列取代物件）。

```js
// ./websocket/index.js

// 示範傳送大量資料
const largeObject = {
    message: "這是一個從 Node.js 傳送的大物件!",
    timestamp: Date.now(),
    data: Array.from({ length: 100 }, (_, i) => `item_${i}`),
    nested: {
        info: "這是一個巢狀物件"
    }
};
await wsServer.sendData('myLargeData', largeObject);
```

## Minecraft API 接收資料

使用 `onData` 接收，請確保 name 跟傳送端一樣。
```ts
// ./scripts/src/index.ts

wsBridge.onData("myLargeData", (data, delay) => {
  world.sendMessage(
    `§a[WSS-IN] 成功接收到資料！(延遲: ${delay} ticks) 內容:\n§f${JSON.stringify(
      data,
    )}`,
  );
});
```

## 傳送資料到 Websocket Server（內部 -> 外部）

使用 `sendData` 就行，因為是用輪詢計分板的方式實現，所以有 score 這個參數可以使用。
```ts
// ./scripts/src/index.ts

// --- 從遊戲內傳送資料到外部，自定義指令範例 ---
system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  customCommandRegistry.registerCommand(
    {
      name: "yb:send",
      description: "傳送資料給 wsServer",
      permissionLevel: CommandPermissionLevel.GameDirectors,
      mandatoryParameters: [
        { name: "data", type: CustomCommandParamType.String },
      ],
      optionalParameters: [
        { name: "score", type: CustomCommandParamType.Integer },
      ],
    },
    (origin, data: string, score: number) => {
      system.run(() => wsBridge.sendData(data, score));
      return {
        status: CustomCommandStatus.Success,
        message: `§e[WSS-OUT] 已嘗試將資料傳送至外部: "${data}" 分數: ${score}`,
      };
    },
  );
});
```

## Websocket Server 接收資料

我只負責把接口做出來，要怎麼用就由你自己決定了，例如根據 score 來區分不同的資料或者直接在 data 用屬性區分。

```js
// 監聽從 Minecraft 透過輪詢機制傳來的資料
wsServer.onData(({ data, score, id }) => {
    console.log(`[Data Polling] 從 Minecraft 收到資料:`);
    console.log(`  - ID: ${id}`);
    console.log(`  - DATA: ${data}`);
    console.log(`  - SCORE: ${score}`);
    // 在這裡，你可以根據 'data' 的內容執行自訂邏輯
});
```

## 小知識

- 單次傳送過去的完整物件大小不能超過 `661 bytes`
- 傳送時特殊字元要用 `\u` 格式跳脫，例如中文字或 `` ` ``（`\u0060`）
- header 的 version 經測試，使用 26 就能執行新版 execute
- 內部往外傳資料使用 scoreboard list 指令輪詢
- 每個 tick 最多傳送 126 個指令，不然你會獲得 `提出的指令過多，請等候一個完成`

## TODO

- 加密的 websocket （lazy）
