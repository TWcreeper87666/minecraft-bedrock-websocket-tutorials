# Websocket 連線

讓你的 Minecraft 可以接收外部資料。接口都寫好了，裡面有寫範例的外部傳送與內部接收方法，兩筆資料分別為 `myLargeData`、`anotherChannel`，可以參考一下外部傳送 `./websocket/py/main.py`、`./websocket/js/index.js` 與內部接收 `./scripts/src/index.ts` 的方式。

### 從 Minecraft 傳送資料到外部

可以透過一直執行 `/scoreboard players list yb:data`，要傳送資料時使用 `/scoreboard objectives add data dummy` 並 `/scoreboard players set yb:data data 123`。


接收到的訊息如果 `header.messagePurpose === "commandResponse"` 並且不是 `玩家 yb:data 沒有記錄分數` 然後又符合 `` /^§a正為 yb:data 顯示 \d+ 個追蹤的物件：/ `` 就可以 `message.matchAll(/- (.*?)：(\d+) \((.*?)\)/g);` 

哪天想到再加進來🤣

### 兩種語言

寫了 js 跟 py 的版本，安裝 websocket 套件應該就能用了，開啟一個終端機到 `./websocket`

#### python

安裝套件（直接全域安裝了懶）
```
pip install websockets
```
運行
```
python ./py/main.py
```

#### javascript

安裝套件（可以參考 [基岩版麥塊腳本 API 教學](https://youtu.be/mBSe_FHtWWo?si=Sc1spwI0MBTzPAnJ) 安裝 Node.js）
```
npm install nodejs-websocket
```
運行
```
node ./js/index.js
```

## 限制（不遵守會 crash）

- 單次傳送過去的完整物件大小不能超過 `661 bytes`
- 傳送時如果有 `` ` `` 要用 `\u0060` 取代
- 傳送時特殊字元要用 `\` 跳脫，不過 AI 幫我改用 base64 傳送所以就沒這問題了（但是傳送速度變慢了bruh💀）