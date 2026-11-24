# 車長班表 LIFF 網頁

在同一個 Google Apps Script 專案裡，新增一個手機優先的班表網頁。
原本的 LINE Bot（`doPost`）保留姓名／車次／班表／日夜休查詢，兩邊共用同一份 Staff / Schedule_S 資料。

- 入口：`doGet`
- 前端→後端：`google.script.run.apiCall(action, payload)`
- 不依賴 LIFF SDK，也不強制 LINE 登入
- 身分識別：第一次開啟時手動選姓名，存在手機的 `localStorage`

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `Code.gs` | 既有 LINE Bot 與班表計算核心（LINE 僅留姓名／車次／班表／日夜休查詢） |
| `LiffApi.gs` | `doGet`、`apiCall` 與所有網頁用 API |
| `LiffApp.html` | 頁面骨架、SVG icon、底部導覽 |
| `LiffStyles.html` | 全部 CSS |
| `LiffScripts.html` | 前端邏輯（原生 JS，無建置流程） |
| `test/` | 本機測試工具，不需要部署到 GAS |

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

## 部署到 GAS

1. 開啟既有的 Apps Script 專案。
2. 新增下列檔案，檔名必須完全一致：
   - `LiffApi.gs`
   - `LiffApp.html`
   - `LiffStyles.html`
   - `LiffScripts.html`
3. 儲存後，選 **部署 → 管理部署**。
4. 建立／編輯「網頁應用程式」部署：
   - **執行身分**：我
   - **誰可以存取**：所有人
5. 複製 **網頁應用程式網址**（結尾通常是 `/exec`）。

> `doGet` 已設定 `XFrameOptionsMode.ALLOWALL`，才能在 LINE 的 in-app browser / iframe 內正常顯示。
> 每次修改前端或 `LiffApi.gs` 後，記得建立**新版本**部署，否則 `/exec` 還是舊版。

### 驗證

在瀏覽器直接開 `/exec`：

- 看到「車長班表」首頁 → 後端與前端都正常
- 看到 Google 登入頁 → 部署存取權不是「所有人」
- 一片空白 → 開 DevTools Console 看錯誤，通常是檔案沒存或部署沒更新

## 設成 LINE LIFF

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 選你的 Provider / Channel。
2. 建立 **LIFF app**：
   - **Endpoint URL**：貼上 GAS 的 `/exec` 網址
   - **Size**：Full
   - **Scopes**：不需要勾選（本頁沒有呼叫 LIFF API）
   - **Open in external browser**：依需求；關閉時會在 LINE 內開啟
3. 儲存後會得到 `https://liff.line.me/xxxxxxxx`。
4. 把這個 LIFF 網址放到圖文選單（Rich menu）或群組說明。

因為沒有使用 `liff.init()`，不需要在 LINE Login Channel 設定 callback，也不會遇到 GAS HtmlService 巢狀 iframe 與 LIFF SDK 的相容性問題。

## 本機測試（不需要 Node.js）

### 1. 後端 API

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\build-api-test.ps1
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --headless=new --disable-gpu --allow-file-access-from-files `
  --virtual-time-budget=8000 `
  --dump-dom "file:///C:/Users/User/Documents/預設專案/test/_api-test.html"
```

預期結果：`ALL PASSED`（目前 18 項，含 `staffDay`／`monthSchedule`／`allSchedules`）。

### 2. 前端互動

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\open-preview.ps1
```

這會重新產生 `test/_preview.html`，並直接用 **Chrome／Edge** 開啟（避開 IE 或沙箱預覽器），把 GAS 後端換成 `test/mocks.js` + `test/data.js`。

> 不要直接開 `LiffApp.html`。它含有 GAS 模板語法，沒有後端與樣式，會停在載入骨架。
> 也不要只開舊的 `_preview.html`；每次改完前端請重新執行 `open-preview.ps1` 或 `build-preview.ps1`。
> 若頁面停在載入中，5 秒後會顯示「頁面沒有成功啟動」；按 F12 看 Console 的第一個紅色錯誤。

也可以手動開啟 `test/_preview.html`，或用 `-SelfTest` 跑互動測試：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\open-preview.ps1 -SelfTest
```

- `test/_preview.html`：首頁
- `#search`：查詢頁並自動送出一次查詢
- `#trains`：全部車次並搜尋 `3178`
- `#name`：姓名底部面板
- `#test`：自動互動測試，最後顯示 `UI ALL PASSED`

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --headless=new --disable-gpu --allow-file-access-from-files `
  --window-size=500,900 --virtual-time-budget=20000 `
  --dump-dom "file:///C:/Users/User/Documents/預設專案/test/_preview.html#test"
```

截圖放在 `test/screens/`。

> PowerShell 5.1 讀取 `.ps1` 時，若檔案不是 UTF-8 BOM，中文會變亂碼並可能讓內嵌 JS 出現 `SyntaxError`。`test/build-*.ps1` 都已存成 UTF-8 BOM。

## API 一覽

前端統一呼叫：

```js
google.script.run.apiCall('mySchedule', { name: '小林', start: '2026-11-18', days: 7 })
```

回傳固定為 `{ ok: true, data }` 或 `{ ok: false, error }`。

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
| 開啟後一直轉圈 | `/exec` 部署的存取權不是「所有人」，或 `apiCall` 沒部署 |
| `後端尚未連線` | 直接開了本機 HTML；請從 GAS `/exec` 開啟，或使用 `test/_preview.html` |
| `未知的 API 操作` | `LiffApi.gs` 沒存檔，或部署的是舊版本 |
| 查無班表 | `Staff` 沒有此人、姓名不符、或該群組沒有 `Schedule_S` |
| `無法查詢基準日以前` | 查詢日期早於 `CONFIG.BASE_DATE`（目前 `2026/07/01`） |
| 日期選不到 | 日期欄位的 `min` 會鎖在基準日 |
| 車站選單空白 | `bootstrap` 尚未完成；重新整理或稍等 |
| 姓名沒被記住 | 無痕模式／瀏覽器封鎖 localStorage；改用一般視窗 |
| 換日後資料沒變 | `allTrains` 快取 120 秒；按「重新整理」會重新計算 |
| LINE 內開啟空白 | 部署需允許 iframe；`doGet` 已設 `ALLOWALL`，並確認 LIFF Endpoint 是 `/exec` |

## 安全注意事項

1. **`Code.gs` 內的 LINE Channel Access Token 是明文寫死的，且已出現在原始碼中。**
   建議立即到 LINE Developers Console **重新發行（Issue）新的 Channel Access Token**，
   舊 token 會失效；接著把新 token 放進 **專案設定 → 指令碼屬性**，例如 `LINE_CHANNEL_ACCESS_TOKEN`，
   再把 `Code.gs` 的 `CONFIG.LINE_CHANNEL_ACCESS_TOKEN` 改成從 `PropertiesService` 讀取。
   不要再把 token 提交到版本控制或分享給他人。
2. Web App 設為「所有人」代表任何拿到 `/exec` 網址的人都能查班表。
   目前只有姓名查詢、沒有登入驗證，請自行評估資料敏感度；
   若需要限制，可加上 Google 帳號限制或自行實作 token。
3. 前端只用 `localStorage` 記住姓名，不會傳送 LINE 個資，也沒有使用 LIFF profile。

## 後續擴充

- 新頁面：在 `LiffApp.html` 的 `tabbar` 增加按鈕，`switchView()` 增加 view，`LiffApi.gs` 增加 action。
- 新查詢：沿用 `state.search` 表單與 `runSearch()` 的 request/response 結構。
- 若之後要做 LINE 登入，再引入 LIFF SDK；目前的 `api()` 已把後端呼叫集中，替換身分來源不影響畫面。
