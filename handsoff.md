# HANDOFF：車長班表前後端分離重構（進度交接）

> 本檔供新對話接續進度用。工作目錄：`C:\Users\User\Documents\預設專案`（目前**不是** git repo）。
> `.claspignore` 已排除 `*.md`，此檔不會被推上 GAS。

---

## 1. 專案與重構目標

原本：單一 GAS 專案（V8），`Code.gs`（班表引擎＋LINE Bot `doPost`）＋ `LiffApi.gs`（網頁 `doGet`/`apiCall`）＋ 三個 GAS HTML（`LiffApp.html`、`LiffStyles.html`、`LiffScripts.html`）。

目標架構：

```
GitHub Pages（docs/，純靜態：index.html + styles.css + app.js + config.js）
        │ fetch POST（Content-Type: text/plain，body 為 JSON 字串）
        ▼
GAS Web App /exec（純 JSON API）
  doPost(e)：body.events[] → handleLineWebhook_（LINE，Code.gs）
             body.action   → apiCall(action, payload) → { ok, data | error }
  doGet(e)：健康檢查 / ?action=&payload=（JSON）
        ▼
Google Sheet：Staff / Schedule / Schedule_S / Station
```

- 測試機制維持：`test/` 下的 PowerShell 組建 + headless Chrome + Node runner。
- LINE webhook 與前端 API 共用同一個 `/exec`，由 `doPost` 依 body 形狀分流（**events 優先於 action**）。
- CORS 限制：GAS 無 `doOptions`、`TextOutput` 無法自訂 header → 前端只能用「簡單請求」（`text/plain`），不可用 `application/json` 或自訂 header；GAS 恆回 HTTP 200，錯誤走 `{ok:false,error}` envelope。
- 備案（若實測被 CORS 擋）：JSONP（目前 API 全唯讀，可用 GET）或代理；**不可用 `mode:'no-cors'`**（response 不可讀）。

---

## 2. 環境備忘

- Node：`C:\Program Files\nodejs\node.exe`；Chrome 158：`C:\Program Files\Google\Chrome\Application\chrome.exe`；clasp 已安裝。
- PowerShell **5.1** 主控台會把中文輸出變亂碼：讀檔要用 `-Encoding UTF8`、�幫 Node/Chrome 輸出留檔用 `cmd /c "... > %TEMP%\opencode\xxx.txt 2>&1"`（raw bytes，再用讀檔工具看），或直接用讀檔工具。
- `.ps1` 一律 **UTF-8 with BOM**（PowerShell 5.1 否則把中文讀成 ANSI）；`.gs`/`.html`/`docs/*` 是 UTF-8 無 BOM。
- 暫存工作區：`%TEMP%\opencode`（已核可）。
- Chrome headless 測試**只用最小參數**（見第 6 節）；**不要加 `--user-data-dir`**（Chrome 158 headless 會噴 `Multiple targets are not supported in headless mode` 並輸出空 DOM）。
- 使用者的 Chrome 設定檔有擴充功能，但已驗證**不是**本次問題來源（`--disable-extensions` 結果相同）。

---

## 3. 已完成進度（全部已驗證）

### Step 0：baseline（已完成）
- `test/results-baseline.txt`：舊 LINE 回覆備份（與當時重跑結果 SHA256 一致）。
- `node test/run.js` → `done, 48 queries`；`node test/run-api.js` → 15/15；`build-api-test.ps1` + Chrome → ALL PASSED（當時 18 項）。

### Step 1：後端 JSON API（已完成，ALL PASSED 24/24）
- `Code.gs`：
  - `doPost(e)` 改**分流器**：`body.events` 陣列 → `handleLineWebhook_`；`body.action` 字串 → `handleApiRequest_`（LiffApi.gs）；皆非 → `{ok:false,error:'無法辨識的請求格式'}`。
  - JSON 解析失敗：`postData.type === 'application/json'`（LINE）→ 回 `OK` 防 LINE 重試；其他 → JSON 錯誤。
  - 原 LINE 邏輯原封不動搬進 `handleLineWebhook_(payload)`（含 console log、最後防線 catch）。
  - LINE 導引用語移除「（LIFF）」（`results.txt` 因此有 27 行預期差異，僅此而已）。
- `LiffApi.gs`：
  - `doGet(e)`：無參數 → `{ok:true,data:{service:'crew-schedule-api',version:'2.0.0'}}`；`?action=...&payload=<URL-encoded JSON>` → 直接呼叫 `apiCall`。
  - 移除 `HtmlService`/`LiffApp` 模板與 `liffJsonForHtml_`。
  - 新增 `handleApiRequest_(body)`、`jsonResponse_(obj)`（`ContentService` + `MimeType.JSON`）。
  - **`apiCall` 與所有 `liff*_` handler 零改動**。
- `test/mocks.js`：`ContentService` mock 改為可鏈式（`setMimeType`/`getContent`/`append`/`setContent`）＋ `MimeType` 列舉。
- `test/build-api-test.ps1`：新增 `callHttp()`／`callGet()` helper 與 6 項分流測試（18 → **24 項**）。

### Step 2：docs/ 靜態前端（已完成，SMOKE ALL PASSED 11/11）
- 新增 `docs/index.html`（移除 GAS 模板/`<base>`/`initialJson`；外鏈 CSS/JS；fallback 改查 `window.__APP_READY__`）、`docs/styles.css`（剝殼）、`docs/app.js`（剝殼＋改造）、`docs/config.js`（`window.APP_CONFIG = { API_URL:'', BOOTSTRAP_CACHE_TTL_MS: 6h }`）、`docs/.nojekyll`。
- `.claspignore` 已加 `docs`、`docs/**`。
- `docs/app.js` 改造重點：
  - `api()` → `fetch(API_URL, { method:'POST', redirect:'follow', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify({action,payload}) })`，先 `res.text()` 再 `JSON.parse`；**已無 `google.script.run`、無 `MockApi` 分支**。
  - bootstrap localStorage 快取：`crew-schedule:bootstrap:v1`（`{savedAt, data}`，TTL 由 config）；只快取名單/車站/日期，**不快取班表**。
  - 啟動順序：`init()` → `ensureBootstrap()`（單例 promise，失敗會重設以利重試）→ `loadHomeData()`（mySchedule + monthSchedule + allSchedules）；`switchView` 的資料載入也等 bootstrap；`retry-boot` 重試後接 `loadHomeData()`。
  - bootstrap 回來只修正「還停在下載前日期」的欄位（month/allSched/search/trains），`serverOffset = data.nowMs - Date.now()`（快取時用 `nowMs - savedAt`）。
  - `window.__LIFF_READY__` → `window.__APP_READY__`；錯誤訊息指向 `docs/config.js`。
- **驗證方式（煙霧測試藍圖在 `%TEMP%\opencode\step3-smoke.js`）**：把 `docs/index.html` + `docs/styles.css` + `docs/config.js`（覆寫 `API_URL='mock://local'`）+ `test/mocks.js` + `test/data.js` + `Code.gs` + `LiffApi.gs` + fetch mock（攔截 fetch、`apiCall`、回 `{ok:true,status:200,text,json}`）+ `docs/app.js` 合成單頁，Chrome headless 跑 → 11 項全 PASS（含 datalist、當月班表、14 列所有班表、bootstrap/mySchedule 經 fetch、快取已寫入、零 JS 錯誤）。

### Step 3：build-preview.ps1 改讀 docs/（已完成，UI ALL PASSED 68 項）
- `test/build-preview.ps1`：來源改讀 `docs/index.html`/`styles.css`/`config.js`/`app.js`；三個 marker（`<link rel="stylesheet" href="styles.css">`、`<script src="config.js"></script>`、`<script src="app.js"></script>`）缺一即 throw；config 內嵌後注入 `window.APP_CONFIG.API_URL='mock://local'`；`<script src="app.js">` 位置改放後端 bundle（mocks/data/Code.gs/LiffApi.gs）+ **fetch mock**（攔 `window.fetch` → `apiCall`，120ms 延遲，記錄 `__API_CALLS__`）+ selftest + `<script>app.js</script>`；已移除 `$initialJson` 與 `window.MockApi`。全程 PowerShell `.Replace()`（字面替換，`$$` 安全）。
- 保留：關動畫 style、`__ERRORS__` 收集、`localStorage` 姓名（小林）、hash 導覽/diag/錯誤框、`#test` selftest here-string（選擇器全部沿用，DOM 未變）。
- 驗證：`--virtual-time-budget=45000` + `#test` → title `UI ALL PASSED`、selftest 框 68 PASS / 0 FAIL、無 preview-errors 框、diag `shell=485`。DOM 留檔 `%TEMP%\opencode\preview-step3-dom.html`。
- 根目錄 `LiffApp.html`、`LiffStyles.html`、`LiffScripts.html` **已刪除**（GAS 遠端三個 HTML 仍要到編輯器手動刪，`clasp push` 不會刪遠端）。

---

## 4. 目前檔案狀態

- `docs/`：`index.html`、`styles.css`、`app.js`、`config.js`、`.nojekyll` ✅
- `Code.gs`、`LiffApi.gs`：已改為 JSON API + 分流 ✅（未部署，`clasp push` 還沒跑）
- `test/mocks.js`、`test/build-api-test.ps1`：已更新 ✅
- 根目錄 `LiffApp.html`、`LiffStyles.html`、`LiffScripts.html`：已刪除（Step 3 通過後依計畫刪除）。
- `test/build-preview.ps1`：已改寫為讀 `docs/` + fetch mock ✅
- `test/run.js` 仍只 `eval(Code.gs)`：LINE 路徑夠用，但 Step 5 應改成同時 eval `LiffApi.gs`。
- `LIFF_README.md`：未更新（測試數仍寫 18 項、`--virtual-time-budget=20000` 不足、部署章節全是舊架構）。
- `AGENTS.md`：**不存在**（先前對話只規劃過，未寫入）。
- `appsscript.json`：未動（`executeAs: USER_DEPLOYING`、`access: ANYONE_ANONYMOUS`，維持即可）。

---

## 5. 關鍵教訓（必讀，血淚）

1. **JS `String.replace()` 的替換字串會吃特殊符號**：`$$` → `$`。煙霧測試組建腳本曾因此把 app.js 的 `function $$(sel, root)`（querySelectorAll 助手）折疊成第二個 `function $`，同名後者覆蓋前者，`$()` 回傳**陣列** → `btn.classList` undefined → `init()` 在 `updateNameChip` 靜默爆炸（被底部 try/catch 吃掉，`showFatal` 的 `$('#main')` 也拿到陣列所以無聲）。**修法：組 HTML 一律用 `split(marker).join(replacement)`。** PowerShell 的 `.Replace()` 是字面替換、安全——這就是舊 `build-preview.ps1` 從沒事的原因。
2. **Chrome 158 headless + `--user-data-dir` = `Multiple targets are not supported in headless mode`**（輸出空 DOM）。測試命令維持最小參數。
3. **UI self-test 需要 `--virtual-time-budget=45000`**（自我測試 timer 總量約 25 秒；README 的 20000 跑不完：title 不變、無錯誤框、無 selftest box）。這是既有問題，更新 README 時一併修。
4. **GAS API 恆回 HTTP 200**：前端 `api()` 必須解析 envelope（`{ok:false,error}`），不能只看 `response.ok`。
5. 診斷手法（這次很好用）：在組建時對 app.js 注入 `window.__TRACE__` 追蹤點（不改 repo 檔），diag box 印 `READY / CALLS / TRACE / CHIP / MAIN-LEN`；`document.contentType`、`Object.prototype.toString.call(el)` 能快速分辨「文件問題」vs「元素問題」。
6. 主控台中文亂碼≠檔案壞掉；用 `cmd /c "node ... > file 2>&1"`（raw bytes）再讀檔。
7. `Get-Content` 行數統計會因 ANSI 解碼吃掉換行而失真（UTF-8 中文被 Big5 配對吞掉 `\n`）；比對檔案用 hash / `fc`（byte 層級）。

---

## 6. 測試指令速查

```powershell
# LINE Bot 回覆（會覆寫 test/results.txt；baseline 在 test/results-baseline.txt）
node test\run.js

# LIFF API 子集（15 項）
node test\run-api.js

# 後端完整 API（24 項）＋ headless Chrome
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\build-api-test.ps1
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu --virtual-time-budget=8000 --dump-dom "file:///C:/Users/User/Documents/預設專案/test/_api-test.html"
# 檢查 <title>ALL PASSED</title>（24 個 PASS）

# 前端預覽 / UI self-test（Step 3 改寫後）
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\build-preview.ps1
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu --allow-file-access-from-files --window-size=500,900 --virtual-time-budget=45000 --dump-dom "file:///C:/Users/User/Documents/預設專案/test/_preview.html#test"
# 檢查 <title>UI ALL PASSED</title>
```

baseline 留檔：`test/results-baseline.txt`、`%TEMP%\opencode\run-api-baseline.txt`、`%TEMP%\opencode\api-test-baseline-dom.html`。
可用藍圖：`%TEMP%\opencode\step3-smoke.js`（= 新版 build-preview 的最佳參考，含 split/join 與 fetch mock）、`%TEMP%\opencode\step3-transform.js`（docs/ 產生方式）。

---

## 7. 待辦（依序執行）

### Step 3：改寫 `test/build-preview.ps1`（✅ 已完成，見第 3 節；下一步從 Step 4 開始）

### Step 4：GitHub Pages + CORS 實測
1. 此目錄還不是 git repo → 需 init/commit/push 到 GitHub。
2. Settings → Pages → Deploy from a branch → `main` + `/docs`。
3. `docs/config.js` 填入 GAS `/exec` 網址（部署後才有）。
4. GAS 部署：`clasp push` → 「部署 → 管理部署」建新版本 → 開 `/exec` 應看到 JSON 健康檢查；`curl.exe -L -X POST -H "Content-Type: text/plain" --data '{\"action\":\"bootstrap\",\"payload\":{}}' "<exec>"` 應回 `{"ok":true,...}`。
5. DevTools 驗證：**只有一個 POST、沒有 OPTIONS**、302→200 JSON。若 302 後 CORS 錯誤 → 確認 `ANYONE_ANONYMOUS`；再不行走 JSONP/代理備案。
6. 若仍有 LINE LIFF：Endpoint URL 改指 GitHub Pages 網址。

### Step 5：Node 測試同步
- `test/run.js`：改為 `eval(code + '\n' + api)`（讀入 `LiffApi.gs`；`doPost` 分流的 API/解析錯誤路徑需要 `jsonResponse_`）。
- `test/run-api.js`：可加 `doGet`/`doPost` 分流檢查（沿用 build-api-test 的 `callHttp`/`callGet` 寫法）。
- 重跑 `node test\run.js` 重產 `results.txt`（預期與 baseline 只差那 27 行 LIFF 文案）。

### Step 6：文件收尾
- `LIFF_README.md`：新架構圖、GitHub Pages 部署、CORS 注意事項、測試數 24 項、`--virtual-time-budget=45000`、疑難排解（OPTIONS 405／302 後 CORS／HTML 登入頁＝權限錯誤）、安全段落（`LINE_TOKEN` 在 Script Properties，README 舊的「寫死 token」段落已過時）。
- 建立 `AGENTS.md`：GAS JSON API + docs/ 靜態前端、測試指令、CORS 限制、`$$` 折疊教訓、virtual-time-budget、既有領域規則（輪值遞減、跨夜、順逆向、BASE_DATE、Schedule_S 表頭對應等）。
- GAS 編輯器手動刪三個舊 HTML；`test/_preview.html`、`test/_api-test.html`、`test/results.txt` 是產生物不手改。

---

## 8. 不可回退的設計決策

- `doPost` 分流：**events 陣列優先於 action**；LINE 永遠回 `OK`；API 恆 JSON、HTTP 200。
- 前端只靠 `text/plain` 簡單請求；不可加 `application/json`／自訂 header／`Authorization`。
- `docs/app.js` 無 `MockApi`；測試一律用 fetch mock 攔截。
- `apiCall` 的 10 個 action（bootstrap/mySchedule/staffDay/monthSchedule/allSchedules/staffSchedule/status/station/trainLookup/allTrains）行為不變。
- bootstrap 快取只放名單/車站/日期，班表永不快取。
- `SPREADSHEET_ID`、`LINE_TOKEN`（Script Properties `LINE_TOKEN`）留在後端，前端 config.js 不放秘密。
