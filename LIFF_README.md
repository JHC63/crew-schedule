# 車長班表網頁版（GitHub Pages + GAS JSON API）

車長班表查詢網頁，採「前後端分離」：前端是 GitHub Pages 上的純靜態頁面，
後端是 Google Apps Script Web App（純 JSON API），兩邊共用同一份 Google Sheet 資料。

```
GitHub Pages（docs/：index.html + styles.css + app.js + config.js，純靜態）
        │ fetch POST（Content-Type: text/plain，body 為 JSON 字串）
        ▼
GAS Web App /exec（純 JSON API）
  doPost(e)：body.events[] → handleLineWebhook_（LINE Bot，Code.gs）
             body.action   → apiCall(action, payload) → { ok, data | error }
  doGet(e) ：健康檢查／?action=&payload=（JSON）
        ▼
Google Sheet：Staff / Schedule / Schedule_S / Station
```

- LINE webhook 與網頁 API 共用同一個 `/exec`，`doPost` 以 body 形狀分流（**events 優先於 action**）
- 前端不依賴 LIFF SDK、不強制 LINE 登入；身分由使用者在頁面選姓名，存在手機的 `localStorage`
- 班表計算全部沿用 `Code.gs` 既有邏輯，LINE 與網頁共用同一份資料

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `Code.gs` | 班表計算核心＋LINE Bot（`doPost` 分流器、`handleLineWebhook_`） |
| `LiffApi.gs` | `doGet`、`apiCall`、`handleApiRequest_`／`jsonResponse_` 與所有網頁用 JSON API |
| `docs/index.html` | 頁面骨架、SVG icon、底部導覽（無 GAS 模板語法） |
| `docs/styles.css` | 全部 CSS |
| `docs/app.js` | 前端邏輯（`fetch(API_URL)`，原生 JS，無建置流程） |
| `docs/config.js` | `window.APP_CONFIG`（`API_URL`、bootstrap 快取 TTL） |
| `docs/.nojekyll` | 讓 GitHub Pages 原樣服務檔案 |
| `test/` | 本機測試工具，不需要部署到 GAS |
| `appsscript.json` | GAS manifest（V8、executeAs: USER_DEPLOYING、access: ANYONE_ANONYMOUS） |

## 功能

- **首頁**：今日英雄卡、值乘進度、今日時間軸（含「現在」時間線）、未來 7 天列表（明天起，可展開）
- **當月班表**：設定姓名後顯示，月曆式（週日為首）可上下月切換，點日期看該車長當日完整班表
- **所有班表**：列出 Schedule 工作表當日全部班表列（Group／Name／Number／Train／On／Off），
  可依班號、組別、上班、下班排序；點有車長姓名的列，看該車長當日完整班表
- **查詢**
  - 班表：同一個輸入框可輸入姓名或車次，按「查詢班表」
    - 姓名：一次最多 10 位，用空白、逗號、頓號、分號或換行分隔
    - 車次：一次最多 10 個，規則同上；可反查當天值乘的車長
    - 姓名與車次請分開查，混用會提示錯誤
    - 可選 1／3／7／14 天（上限由 `CONFIG.MAX_QUERY_DAYS` 控制）
    - 完全符合車長姓名者優先視為姓名，其次含數字者視為車次，其餘視為姓名
  - 狀態：值乘中／非值乘（中場）／放假；**固定單日**，不支援多日
    - 非值乘可指定車站；留空則依車站分組列出；放假不顯示車站
- **車次**：當日全部車次，依開車時間→起站→抵達時間排序；今天會自動捲動到「現在」的位置
  - 可換日、搜尋、只看未開
  - 起站、迄站、方向三個獨立下拉選單
  - 方向規則：以 `Station` 工作表里程判斷——起站公里數**大於**迄站為**順向**，起站**小於**迄站為**逆向**（例：民雄 282.5 → 嘉義 291.8 為逆向）；起訖任一站查不到里程時，才退回車次末碼（偶數順向、奇數逆向），`便`、`A` 等後綴不影響
  - 點任一車次列，看該車長當日完整班表
- 快速查詢：首頁三格（值乘中／非值乘／放假）可快速進入狀態查詢
- 名字記住、下拉候選、底部姓名面板

### LINE 關鍵字（已刪減）

LINE 視窗**僅保留**：車長姓名、車次、班表、日／夜／休（日管、日內適用），皆可加日期。
狀態（值乘／中場／放假）、班表明細（簡單／詳細／who）與車站時段查詢已移除，
輸入這些關鍵字會回覆導引訊息，請改用網頁版。

### 車站順序

`bootstrap` 會讀取 Google Sheet 的 `Station` 工作表（`No`／`Name`／`KM`），
只列出 `Schedule_S` 實際出現過的車站，並依 `No` 由小到大排序；
`Schedule_S` 有、但 `Station` 沒有的站會補在最後。若 `Station` 工作表不存在或格式不符，會退回字母排序。
`bootstrap` 同時回傳各站 `KM`（`stationKms`），車次頁以此判斷順向／逆向。

## 部署

### 後端：GAS Web App

1. 推上 GAS：`clasp push --force`（非互動環境一定要 `--force`，否則會 `Skipping push.`）。
2. 確認 GAS「專案設定 ⚙️ → 指令碼屬性」有 `LINE_TOKEN` 與 `SPREADSHEET_ID`（見下方安全段落）。
3. 部署／更新「網頁應用程式」：
   - **執行身分**：我
   - **誰可以存取**：所有人
   - 原地重建（`/exec` 網址不變）：`clasp deploy -i <deploymentId> -d <描述>`（目前為 `AKfycbxMevgb…` @34）
4. 複製 `/exec` 網址，填入 `docs/config.js` 的 `API_URL`（目前 `https://script.google.com/macros/s/AKfycbxMevgb-gMenHgMG737cQDJwIBwTPOV64CAy4PilPkbR3H1I5IwYDWkgDV-upmSRL8jCQ/exec`）。

> 修改 `Code.gs`／`LiffApi.gs` 後**必須建立新版本部署**，否則 `/exec` 還是舊版。
> 根目錄的 `.gs` 檔會整個推上 GAS；`docs/`、`test/`、`*.md` 已被 `.claspignore` 排除。

### 前端：GitHub Pages

1. repo 的 Settings → Pages → Source：`main` branch + `/docs` 資料夾（已設定）。
2. 部署就是 **git push**：推上 `main` 後 Pages 自動建置，1~2 分鐘後
   <https://jhc63.github.io/crew-schedule/> 更新。
3. 前端改動（`docs/`）不需要動 GAS；後端改動（`.gs`）不需要動 Pages——兩邊各自獨立部署。
4. `docs/config.js` 會公開在網路上，只放 `API_URL`，**不可放任何秘密**。

### 驗證

在瀏覽器直接開 `/exec`：

- 看到 `{"ok":true,"data":{"service":"crew-schedule-api",...}}` → 後端正常
- 看到 Google 登入頁（HTML）→ 部署存取權不是「所有人」

前端驗證：<https://jhc63.github.io/crew-schedule/> 能載入首頁、查到班表。

## 設成 LINE LIFF

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 選你的 Provider / Channel。
2. LIFF app 設定：
   - **Endpoint URL**：`https://jhc63.github.io/crew-schedule/`（GitHub Pages，不再是 GAS `/exec`）
   - **Size**：Full
   - **Scopes**：不需要勾選（本頁沒有呼叫 LIFF API）
   - **Open in external browser**：依需求；關閉時會在 LINE 內開啟
3. 把 LIFF 網址（`https://liff.line.me/xxxxxxxx`）放到圖文選單（Rich menu）或群組說明。

因為沒有使用 `liff.init()`，不需要在 LINE Login Channel 設定 callback，也不會遇到 LIFF SDK 與 iframe 的相容性問題。

## CORS 注意事項（重要）

GAS Web App 對瀏覽器 fetch 有幾個硬限制，前端是照著這些限制設計的：

1. **只能發「簡單請求」（simple request）**。
   GAS 沒有 `doOptions`（OPTIONS 一律 405）、`ContentService` 也無法自訂 CORS header，
   所以**不能**用 `Content-Type: application/json` 或自訂 header——那會觸發 preflight，直接被 CORS 擋掉。
   前端固定用 `Content-Type: text/plain;charset=utf-8`（簡單請求、不觸發 preflight），body 仍是 JSON 字串。
2. **GAS 恆回 HTTP 200**。
   `ContentService` 無法設定狀態碼，錯誤一律以 `{ ok: false, error }` envelope 呈現。
   前端 `api()` 必須解析 envelope，**不能只看 `response.ok`**。
3. **302 → echo 的行為**。
   `/exec` 實際上會 302 轉址到 `script.googleusercontent.com/macros/echo?user_content_key=…`（POST body 編碼在 key 裡），
   而 echo **只收 GET**。瀏覽器 `fetch(…, { redirect: 'follow' })` 會自動處理（302 與 echo 兩跳都帶 `Access-Control-Allow-Origin: *`，實測可行）。
   用 curl 測 POST 時要 `curl -L -H "Content-Type: text/plain" --data-binary @file.json "<exec>"`——
   **千萬別加 `-X POST`**（302 後第二跳會強制 POST 無 body → 411；`--post302` → 405）。
4. **不可用 `mode: 'no-cors'`**：回應變 opaque，完全讀不到內容。

## 本機測試

### 1. LINE Bot 回覆（Node）

```powershell
node test\run.js
```

48 題查詢經 `doPost` 分流器跑完整 LINE 路徑，覆寫 `test/results.txt`；
與 baseline（`test/results-baseline.txt`）比對，除預期文案外應零差異。

### 2. LIFF API＋分流（Node）

```powershell
node test\run-api.js
```

24 項檢查：10 個 action、validation、`doGet` 健康檢查／action 分流，
以及 `doPost` 分流（API 分流、LINE 分流、**events 優先於 action**、無效 JSON 依 Content-Type 分流、無法辨識格式）。

### 3. 後端完整 API（headless Chrome）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\build-api-test.ps1
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --headless=new --disable-gpu --virtual-time-budget=8000 `
  --dump-dom "file:///C:/Users/User/Documents/預設專案/test/_api-test.html"
```

預期結果：`ALL PASSED`（24 項，含 `callHttp()`／`callGet()` 分流檢查）。

### 4. 前端互動 / UI self-test

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\open-preview.ps1
```

這會重新產生 `test/_preview.html`（把後端換成 `test/mocks.js` + `test/data.js` + fetch mock），並直接用 Chrome／Edge 開啟。

UI 自動測試：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\build-preview.ps1
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --headless=new --disable-gpu --allow-file-access-from-files `
  --window-size=500,900 --virtual-time-budget=45000 `
  --dump-dom "file:///C:/Users/User/Documents/預設專案/test/_preview.html#test"
```

預期 `<title>UI ALL PASSED</title>`（68 項）。截圖放在 `test/screens/`。

> **`--virtual-time-budget` 必須 ≥ 45000**：UI self-test 的 timer 總量約 25 秒，
> 20000 會跑不完（title 不變、無錯誤框、無 selftest 框）——這是已知地雷，不是壞了。
>
> `test/_preview.html`、`test/_api-test.html`、`test/results.txt` 是產生物（`.gitignore` 已排除），不要手改。
> PowerShell 5.1 讀 `.ps1` 需要 UTF-8 BOM（`test/build-*.ps1` 都已是）。
> Chrome headless **不要加 `--user-data-dir`**（Chrome 158 會噴 `Multiple targets are not supported in headless mode` 並輸出空 DOM）。

## API 一覽

前端統一呼叫（`docs/app.js` 的 `api()`）：

```js
const res = await fetch(window.APP_CONFIG.API_URL, {
  method: 'POST',
  redirect: 'follow',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify({ action: 'mySchedule', payload: { name: '小林', days: 7 } })
});
const { ok, data, error } = await res.json(); // HTTP 恆 200，要解析 envelope
```

回傳固定為 `{ ok: true, data }` 或 `{ ok: false, error }`。

`doGet` 也可直接呼叫（方便瀏覽器／curl 測試）：
`<exec>?action=bootstrap`，或帶 `?action=status&payload=%7B%22keyword%22%3A%22%E5%80%BC%E4%B9%98%22%7D`（URL-encoded JSON）。

| action | payload | 說明 |
| --- | --- | --- |
| `bootstrap` | — | 車長名單、車站（依 Station 站序）與各站里程 `stationKms`、今天、基準日 |
| `mySchedule` | `name`, `start`, `days` | 首頁我的班表 |
| `staffDay` | `name`, `group`, `date`, `days` | 指定車長單日詳情＋未來 7 天（點班表列／車次列用） |
| `monthSchedule` | `name`, `month` | 當月班表（月曆用，整月） |
| `allSchedules` | `date` | 當日 Schedule 全部班表列（所有班表用） |
| `staffSchedule` | `names[]`, `dates[]` 或 `date`, `mode` | 多人／多日班表（simple／detail） |
| `status` | `keyword`, `date`, `startTime`, `endTime`, `station` | 值乘／中場／放假（單日；僅網頁版） |
| `station` | `station`, `date`, `startTime`, `endTime` | 舊版車站快捷（前端已改走 `status`，此 API 保留相容） |
| `trainLookup` | `trains[]` 或 `train`, `dates[]` 或 `date`, `mode` | 多車次／多日反查 |
| `allTrains` | `date` | 當日全部車次（快取 120 秒） |

`staffSchedule` 與 `trainLookup` 的 `dates[]` 會排序、去重，最多 `CONFIG.MAX_QUERY_DAYS`（目前 14）天。
`allTrains` 排序：`startMs` → 起站 `localeCompare('zh-Hant')` → 抵達時間 `endMs` → 車次。

## 疑難排解

| 症狀 | 可能原因 / 處理 |
| --- | --- |
| 面板出現 **OPTIONS** 請求且 405，接著 CORS 錯誤 | 前端發了會觸發 preflight 的請求（`application/json` 或自訂 header）。GAS 不支援 OPTIONS；改回 `text/plain` 簡單請求（`docs/app.js` 的 `api()` 已是）。 |
| 302 之後出現 CORS 錯誤 | 部署存取權不是「所有人」。權限正確時，302 與 echo 兩跳都會帶 `Access-Control-Allow-Origin: *`。 |
| 直接開 `/exec` 看到 Google **登入頁（HTML）** | 部署存取權不是「所有人」——到「管理部署 → 編輯」把「誰可以存取」改成所有人。 |
| 頁面一直轉圈／`後端尚未連線` | `docs/config.js` 的 `API_URL` 沒填或填錯；或 GAS 部署不是最新版本。 |
| `未知的 API 操作` | `LiffApi.gs` 沒 push 上去，或部署的是舊版本。 |
| 查無班表 | `Staff` 沒有此人、姓名不符、或該群組沒有 `Schedule_S` |
| `無法查詢基準日以前` | 查詢日期早於 `CONFIG.BASE_DATE`（目前 `2026/07/01`） |
| 日期選不到 | 日期欄位的 `min` 會鎖在基準日 |
| 車站選單空白 | `bootstrap` 尚未完成；重新整理或稍等 |
| 姓名沒被記住 | 無痕模式／瀏覽器封鎖 localStorage；改用一般視窗 |
| 換日後資料沒變 | `allTrains` 快取 120 秒；bootstrap 名單／車站前端快取 6 小時（`docs/config.js` 的 `BOOTSTRAP_CACHE_TTL_MS`） |
| LINE 內開啟空白 | 先確認 Pages 網址在一般瀏覽器能開；再檢查 LIFF Endpoint URL 是否指向 `https://jhc63.github.io/crew-schedule/` |

## 安全注意事項

1. **秘密全部存在 GAS「專案設定 ⚙️ → 指令碼屬性」（Script Properties）**：
   - `LINE_TOKEN`：LINE Channel Access Token，由 `CONFIG.LINE_CHANNEL_ACCESS_TOKEN` getter 從 `PropertiesService` 讀取。
   - `SPREADSHEET_ID`：試算表 ID，同模式由 `CONFIG.SPREADSHEET_ID` getter 讀取。
   原始碼與 repo 內沒有任何秘密。token 需要輪換時，到 LINE Developers Console 重新發行，
   再更新 Script Properties 即可，**不用改程式**。
2. Web App 設為「所有人」代表任何拿到 `/exec` 網址的人都能查班表。
   目前只有姓名查詢、沒有登入驗證，請自行評估資料敏感度；
   若需要限制，可加上 Google 帳號限制或自行實作 token。
3. `docs/config.js` 公開在 GitHub Pages，只放 `API_URL`，不要放 token 或試算表 ID。
4. 前端只用 `localStorage` 記住姓名，不會傳送 LINE 個資，也沒有使用 LIFF profile。

## 後續擴充

- 新 API：在 `LiffApi.gs` 的 `apiCall` switch 加 case 與 handler，並在 `test/run-api.js`、`test/build-api-test.ps1` 補測試。
- 新頁面：在 `docs/index.html` 的 `tabbar` 增加按鈕，`docs/app.js` 的 `switchView()` 增加 view。
- 若之後要做 LINE 登入，再引入 LIFF SDK；目前的 `api()` 已把後端呼叫集中，替換身分來源不影響畫面。
