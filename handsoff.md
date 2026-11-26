# HANDOFF：車長班表前後端分離重構（進度交接）

> 本檔供新對話接續進度用。工作目錄：`C:\Users\User\Documents\預設專案`（**已是 git repo**，remote = https://github.com/JHC63/crew-schedule ，branch `main`）。
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
- Git 2.56.1：`C:\Program Files\Git\cmd\git.exe`；gh CLI 2.105.0（帳號 `JHC63`，已 `gh auth login`）。**新裝的工具要重整 PATH**：`$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')`。
- GitHub Pages：https://jhc63.github.io/crew-schedule/ ；GAS `/exec`：https://script.google.com/macros/s/AKfycbxMevgb-gMenHgMG737cQDJwIBwTPOV64CAy4PilPkbR3H1I5IwYDWkgDV-upmSRL8jCQ/exec （= 部署 AKfycbxMevgb… @34）。
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

### Step 3.5：SPREADSHEET_ID 改存 Script Properties（已完成，2026/11/24）
- `Code.gs`：`CONFIG.SPREADSHEET_ID` 從寫死字串改為 getter（`getRequiredProperty_('SPREADSHEET_ID')`），與 `LINE_TOKEN` 同模式；所有 `CONFIG.SPREADSHEET_ID` 用法零改動。
- `test/mocks.js`：PropertiesService mock 補回 `SPREADSHEET_ID`（同值），三套測試全過（48 queries / 15 API / 24 API+Chrome ALL PASSED / 68 UI ALL PASSED）；`results.txt` 與 baseline 差異仍只有（LIFF）文案。
- **使用者已手動在 GAS「專案設定 ⚙️ → 指令碼屬性」新增 `SPREADSHEET_ID`**（部署 v34 前完成）。
- 檔案內已無任何秘密（token、試算表 ID 都不在原始碼）→ repo 可公開。

### Step 4：GitHub Pages + CORS 實測（已完成，2026/11/24）
- 工具：winget 安裝 **Git 2.56.1**（`C:\Program Files\Git\cmd\git.exe`）+ **GitHub CLI 2.105.0**；使用者以彈出視窗完成 `gh auth login`（帳號 **JHC63**）。
- git 身分：`user.name=JHC63`、`user.email=216995039+JHC63@users.noreply.github.com`。
- Repo：https://github.com/JHC63/crew-schedule （public，`gh repo create crew-schedule --public --source . --push`）。
- `.gitignore`：排除 `test/_preview.html`、`test/_preview-dom.html`、`test/_api-test.html`、`test/results.txt`（產生物）。
- Pages：API 啟用（`POST /repos/.../pages`，`source: main + /docs`）→ **https://jhc63.github.io/crew-schedule/**（build 一次即 built）。
- GAS 部署：`clasp deploy -i AKfycbxMevgb-gMenHgMG737cQDJwIBwTPOV64CAy4PilPkbR3H1I5IwYDWkgDV-upmSRL8jCQ -d v2.0.0_JSON_API` → **@34 原地重建**，`/exec` 網址不變。
- 實測結果（全數通過）：
  - `GET /exec` → `{"ok":true,"data":{"service":"crew-schedule-api","version":"2.0.0"}}`
  - `POST /exec`（text/plain，bootstrap）→ `{"ok":true,"data":{...15 位車長...}}`，`SPREADSHEET_ID` 屬性讀取正常
  - 瀏覽器（jhc63.github.io）：**只有 POST、無 OPTIONS**；302（ACAO `*`）→ echo 200（ACAO `*`）；console 零錯誤；bootstrap／allSchedules／mySchedule 真資料渲染成功（姓名「琬美」實測：今日例假、11/25 025-1 14:40–07:42(+1)）。
  - JSONP／代理備案**不需要**。

### Step 3：build-preview.ps1 改讀 docs/（已完成，UI ALL PASSED 68 項）

- `test/build-preview.ps1`：來源改讀 `docs/index.html`/`styles.css`/`config.js`/`app.js`；三個 marker（`<link rel="stylesheet" href="styles.css">`、`<script src="config.js"></script>`、`<script src="app.js"></script>`）缺一即 throw；config 內嵌後注入 `window.APP_CONFIG.API_URL='mock://local'`；`<script src="app.js">` 位置改放後端 bundle（mocks/data/Code.gs/LiffApi.gs）+ **fetch mock**（攔 `window.fetch` → `apiCall`，120ms 延遲，記錄 `__API_CALLS__`）+ selftest + `<script>app.js</script>`；已移除 `$initialJson` 與 `window.MockApi`。全程 PowerShell `.Replace()`（字面替換，`$$` 安全）。
- 保留：關動畫 style、`__ERRORS__` 收集、`localStorage` 姓名（小林）、hash 導覽/diag/錯誤框、`#test` selftest here-string（選擇器全部沿用，DOM 未變）。
- 驗證：`--virtual-time-budget=45000` + `#test` → title `UI ALL PASSED`、selftest 框 68 PASS / 0 FAIL、無 preview-errors 框、diag `shell=485`。DOM 留檔 `%TEMP%\opencode\preview-step3-dom.html`。
- 根目錄 `LiffApp.html`、`LiffStyles.html`、`LiffScripts.html` **已刪除**（GAS 遠端三個 HTML 仍要到編輯器手動刪，`clasp push` 不會刪遠端）。

---

## 4. 目前檔案狀態

- `docs/`：`index.html`、`styles.css`、`app.js`、`config.js`（**API_URL 已填入 /exec**）、`.nojekyll` ✅
- `Code.gs`、`LiffApi.gs`：JSON API + 分流 ✅，**已 push 至 GAS 並部署 @34 上線**
- `SPREADSHEET_ID`：改存 Script Properties（`Code.gs` getter + `test/mocks.js` mock）✅
- `test/mocks.js`、`test/build-api-test.ps1`：已更新 ✅
- 根目錄 `LiffApp.html`、`LiffStyles.html`、`LiffScripts.html`：已刪除（**GAS 遠端三個 HTML 仍要到編輯器手動刪**，`clasp push` 不會刪遠端）。
- `test/build-preview.ps1`：已改寫為讀 `docs/` + fetch mock ✅
- `test/run.js`：Step 5 已改成 `eval(code + '\n' + api)`（同時載入 `Code.gs`＋`LiffApi.gs`）✅
- `test/run-api.js`：Step 5 已補 9 項 doGet／doPost 分流檢查（15 → 24 項，全過）✅
- `results.txt`：Step 5 重產，與 baseline 差異確認只有 27 行「（LIFF）」文案 ✅
- `LIFF_README.md`：Step 6 已改寫（新架構圖、Pages 部署、CORS、測試數 24 項、virtual-time-budget=45000、疑難排解、安全段落）✅
- `AGENTS.md`：Step 6 已建立（架構、測試指令、CORS、血淚教訓、領域規則、手動事項）✅
- `appsscript.json`：未動（`executeAs: USER_DEPLOYING`、`access: ANYONE_ANONYMOUS`，維持即可）。
- `.gitignore`：排除 `test/_preview*.html`、`test/_api-test.html`、`test/results.txt`；repo 已有 2 個 commit（`524dfb5` 重構、`cbfab6e` config API_URL）。

---

## 5. 關鍵教訓（必讀，血淚）

1. **JS `String.replace()` 的替換字串會吃特殊符號**：`$$` → `$`。煙霧測試組建腳本曾因此把 app.js 的 `function $$(sel, root)`（querySelectorAll 助手）折疊成第二個 `function $`，同名後者覆蓋前者，`$()` 回傳**陣列** → `btn.classList` undefined → `init()` 在 `updateNameChip` 靜默爆炸（被底部 try/catch 吃掉，`showFatal` 的 `$('#main')` 也拿到陣列所以無聲）。**修法：組 HTML 一律用 `split(marker).join(replacement)`。** PowerShell 的 `.Replace()` 是字面替換、安全——這就是舊 `build-preview.ps1` 從沒事的原因。
2. **Chrome 158 headless + `--user-data-dir` = `Multiple targets are not supported in headless mode`**（輸出空 DOM）。測試命令維持最小參數。
3. **UI self-test 需要 `--virtual-time-budget=45000`**（自我測試 timer 總量約 25 秒；README 的 20000 跑不完：title 不變、無錯誤框、無 selftest box）。這是既有問題，更新 README 時一併修。
4. **GAS API 恆回 HTTP 200**：前端 `api()` 必須解析 envelope（`{ok:false,error}`），不能只看 `response.ok`。
5. 診斷手法（這次很好用）：在組建時對 app.js 注入 `window.__TRACE__` 追蹤點（不改 repo 檔），diag box 印 `READY / CALLS / TRACE / CHIP / MAIN-LEN`；`document.contentType`、`Object.prototype.toString.call(el)` 能快速分辨「文件問題」vs「元素問題」。
6. 主控台中文亂碼≠檔案壞掉；用 `cmd /c "node ... > file 2>&1"`（raw bytes）再讀檔。
7. `Get-Content` 行數統計會因 ANSI 解碼吃掉換行而失真（UTF-8 中文被 Big5 配對吞掉 `\n`）；比對檔案用 hash / `fc`（byte 層級）。
8. **`clasp push` 非互動環境會 `Skipping push.`**（appsscript.json 比對觸發確認提示，沒 TTY 就跳過）→ 一律用 `clasp push --force`。
9. **GAS 302 轉址的 curl 陷阱**：`/exec` 302 → `script.googleusercontent.com/macros/echo?user_content_key=…`（body 已編碼在 key 裡），echo **只收 GET**。curl 測 POST 要用 `curl -L -H "Content-Type: text/plain" --data-binary @file.json "<exec>"`（`--data` 本身就送 POST、302 後自動轉 GET）；**千萬別加 `-X POST`**（第二跳強制 POST 無 body → 411；`--post302` → 405）。
10. Chrome headless 對 `--dump-dom` 輸出的中文會亂碼（Big5 console），但比對 `<title>`/PASS 計數用 regex 數即可；`PASS` 計數要把 title 與測試器原始碼字串（`'FAIL  '`、`FAILED`）算進去，與 baseline DOM 同法比對才準。

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

### Step 3：改寫 `test/build-preview.ps1`（✅ 已完成，見第 3 節）
### Step 4：GitHub Pages + CORS 實測（✅ 已完成，見第 3 節 Step 3.5/Step 4）
- **剩使用者手動**：LINE Developers Console → LIFF app 的 Endpoint URL 改指 `https://jhc63.github.io/crew-schedule/`。
- **剩 GAS 編輯器手動**：刪除遠端三個舊 HTML（`LiffApp.html`、`LiffStyles.html`、`LiffScripts.html`）。

### Step 5：Node 測試同步（✅ 已完成，見第 4 節）
- `test/run.js`：改為 `eval(code + '\n' + api)`（讀入 `LiffApi.gs`；`doPost` 分流的 API/解析錯誤路徑需要 `jsonResponse_`）。
- `test/run-api.js`：沿用 build-api-test 的 `callHttp`/`callGet` 寫法補 9 項分流檢查（健康檢查／doGet 分流／doPost API・LINE 分流／events 優先於 action／無效 JSON 兩型／無法辨識格式）→ 24 項全過。
- 重跑 `node test\run.js` 重產 `results.txt`（與 baseline 差異確認只有 27 行 LIFF 文案，0 行其他差異）。

### Step 6：文件收尾（✅ 已完成，見第 4 節）
- `LIFF_README.md`：新架構圖、GitHub Pages 部署、CORS 注意事項、測試數 24 項、`--virtual-time-budget=45000`、疑難排解（OPTIONS 405／302 後 CORS／HTML 登入頁＝權限錯誤）、安全段落（`LINE_TOKEN`／`SPREADSHEET_ID` 在 Script Properties）。
- 建立 `AGENTS.md`：架構、測試指令、CORS 限制、不可回退決策、`$$` 折疊教訓、virtual-time-budget、既有領域規則（輪值遞減、跨夜、順逆向、BASE_DATE、Schedule_S 表頭對應等）。
- 剩使用者手動（見下）。

### 使用者手動（自動化不了）
- GAS 編輯器刪遠端三個舊 HTML（`clasp push` 不會刪遠端檔案）。
- LINE Developers Console：LIFF Endpoint URL 改指 `https://jhc63.github.io/crew-schedule/`。
- `test/_preview.html`、`test/_api-test.html`、`test/results.txt` 是產生物不手改。

---

## 8. 不可回退的設計決策

- `doPost` 分流：**events 陣列優先於 action**；LINE 永遠回 `OK`；API 恆 JSON、HTTP 200。
- 前端只靠 `text/plain` 簡單請求；不可加 `application/json`／自訂 header／`Authorization`。
- `docs/app.js` 無 `MockApi`；測試一律用 fetch mock 攔截。
- `apiCall` 的 10 個 action（bootstrap/mySchedule/staffDay/monthSchedule/allSchedules/staffSchedule/status/station/trainLookup/allTrains）行為不變。
- bootstrap 快取只放名單/車站/日期，班表永不快取。
- `SPREADSHEET_ID`、`LINE_TOKEN`（Script Properties `LINE_TOKEN`）留在後端，前端 config.js 不放秘密。

---

## 9. 主管「受影響列車」功能（規格：affected-plan.md，進行中）

> 完整規格與實作順序見 `affected-plan.md`（§16 共 8 步）。此節只記進度與新學到的事。

### §16 步驟 1：假 timetable.json 範例（✅ 已完成，2026/11/25）

- 新檔：
  - `tools/make-sample-timetable.js`——讀 `test/data.js`，產 schema 確認用假資料。
  - `test/fixtures/timetable.sample.json`——產出（**不是**正式的 `docs/data/timetable.json`，
    那要等真實 TDX JSON 才由 `tools/build-timetable.js` 產生，避免假資料被推上 Pages）。
- schema 重點確認：
  - 時間一律存「營運日 00:00 起算分鐘數」，跨夜 >1440（樣本 1288：23:57→0:17 存 1437→1457）。
  - `trains` 是**陣列**、`no` 不唯一（測試資料 114/175/3257 各有 2 腿）→ 前端比對必須用
    「車次＋時間窗」，不能建 `no → train` 的唯一 map。
  - `stops` = `[stationId, arrMin, depMin]`；首站 arr=dep、末站 dep=arr。
  - 新增欄位 `stations[].inStationTable`（§9 原規格無）：`affected-plan.md` §9 說區間下拉
    「只用 Station 表的站」，但 stations 又是「TDX ∪ Station 表」聯集、無從分辨 →
    樣本加此布林標記，下拉取 `true` 的站。正式 `build-timetable.js` 要照做。
  - 「便」後綴正規化：`1288便`→`1288`＋`extraTrain:true`；`270A` 的 A 保留（TDX TrainNo 本就含 A 後綴車）。
  - typeCode 樣本用一般 TDX 慣例（10=自強(電車)、31=區間車、50=區間快）；§9 例的
    「區間快/'10'」疑為筆誤——正式匯入照 TDX 原值帶入，不做映射。
- 內建驗證輸出（呼應 §10 三份報告）：母體覆蓋（unmatched）、站碼 vs KM 排序、跨夜時間、
  端點一致性／時間單調、同車次多腿清單。樣本四項全 OK。

### §16 步驟 2：docs/affected.html 骨架＋表單（✅ 已完成，2026/11/25）

- 新檔：`docs/affected.html`（骨架＋查詢表單）、`docs/affected.css`（桌面優先，權杖與
  styles.css 同套但不載入它）、`docs/affected.js`（步驟 2 範圍：日期列、站下拉、表單驗證、
  查詢佔位；`api()` 已先放好，與 app.js 同 text/plain 模式）。
- 站下拉來源：`timetable.json` 的 `stations[].inStationTable === true` 子集（照 §9），
  排序用 `pos`；預設 彰化→嘉義。假站「林內」（inStationTable:false）正確被排除。
- cache-busting：`data/timetable.json?v=<config.js 的 TIMETABLE_VERSION>`；未設定時不帶參數。
  `tools/build-timetable.js`（步驟 8）重新產生時要同步更新 config.js 的 TIMETABLE_VERSION。
- 煙霧測試：本機 node 靜態伺服器（/data/timetable.json 映射到 test/fixtures 樣本）＋
  headless Chrome --dump-dom，日期列／下拉／ttMeta／預設值全過。

#### 新環境教訓（headless Chrome 對 http://localhost）

1. **本機有系統代理**：headless Chrome 連 `http://127.0.0.1:port` 會被代理攔走，
   `--dump-dom` 輸出 0 bytes（無任何錯誤訊息）。**必須加 `--no-proxy-server`**。
2. **PowerShell 5.1 的 `>` 重導向 chrome stdout 會得 0 bytes**（pipe 反而正常）；
   重導向一律用 `cmd /c '"...chrome.exe" ... --dump-dom URL > file 2>&1'`（raw bytes，
   UTF-8 不經解碼）。讀檔比對用 `[IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)`。

### 待使用者提供（步驟 8 前）

- ~~TDX 定期時刻表完整 JSON（§8.1）~~ ✅ 已提供（2026/11/25，`docs/1161125GeneralTrainTimetable.json`）。
- `Schedule_S` 完整 CSV 已提供（2026/11/25，repo 外：`佳合資料夾\道路駕駛路線\班表查詢 - Schedule_S.csv`；
  219 列、190 班次列、A/B/C 三組、147 車次、20 站）。

### §16 步驟 3～8：功能實作完成（✅ 2026/11/25，測試全過）

- **真實資料偵察結論（定案依據）**：
  - TDX JSON 954 車次、車次號不重複、240 站（0900–7390）、`TrainTypeCode` 實際值 6=區間(695)、
    10=區間快(91)、11/2/3/1/4=各型自強/普悠瑪/太魯閣；`EffectiveDate/ExpireDate/SrcUpdateTime` 在頂層。
  - TDX **沒有**任何字母後綴車次。CSV 的 A/B 後綴（115A、156B、3271A…）是**折返續開腿**，
    基數車在 TDX 是反方向／另一班 → **不可**自動退基數，進 unmatched 人工補（`tools/timetable-overrides.json`）。
  - `便` 後綴去後全吻合、`3148(3146)`→3148 去括號吻合 → 正規化規則：原樣 → 去「便」 → 去括號（不做 A/B 剝除）。
  - 跨夜格式：TDX 全 `HH:MM`（無 24:xx），跨夜＝後站時間 < 前站時間（+1440 累計）。
  - 站碼排序 vs Station 表 KM：19 站全部一致（內插基礎成立）。
- **`tools/build-timetable.js`**（步驟 8 工具，先做因為真實資料齊了）：
  - 輸入 `--csv`＋`--tdx`，輸出 `docs/data/timetable.json`（壓縮單行，145KB，122 車次／150 站）＋
    `tools/reports/{unmatched,build-report}.txt`（.gitignore 排除）。
  - 會自動更新 `docs/config.js` 的 `TIMETABLE_VERSION`（cache-busting；注意原 config 最後一個屬性
    沒有逗號，插入時要補——已修）。
  - 支援 `--overrides`（人工補對照合併；範本 `tools/timetable-overrides.example.json`）、
    `--kms`（`tools/station-kms.json`，站碼 vs KM 驗證）。
  - 實測：129 唯一車次字串 → 122 匯入、unmatched 18、時間比對 0 不一致、班次列覆蓋 89%。
- **`docs/affected-core.js`（新增，純邏輯）**：L1 traverseSection（進入端＝先遇到站、進入＝開車、
  離開＝到達；端點不停靠→站序位置內插 `P開車 + 比例×(Q到達−P開車)`）、L2 classifyRider
  （下車站序 ≤ 進入端→未受影響；上車站序 ≥ 離開端→boarding；其他→alighting）、L3 bufferCheck/buildChain
  （samecontinue/crossnight/difstation/lasttrain 四種邊界）。瀏覽器掛 `window.AFFECTED_CORE`、
  Node 直接 `module.exports`——§14 的 14 案例全在 Node 測。
- **`docs/affected.js`（步驟 3–6）**：bootstrap＋staffSchedule（10 人/批、並行 4、真實 114 人＝12 批約 15 秒，
  頁面開啟即背景預載）→ 母體＝當日班表出現的車次（正規化後）∩ timetable → L1 篩選 → L2 對人 →
  L3 影響鏈。延誤輸入（快速鍵＋5/10/15/30、全部套用／清除）、緩衝即時重算、onlyShort／includePass、
  localStorage 情境（換天重置）、CSV（BOM＋CRLF）、列印（@page A4 landscape）。
  無時刻表車次在警告盒列出**原始車次字串**（如 `3292B便`）。
- **測試（步驟 7）**：
  - `test/run-affected.js`：57 項全過（§14 的 14 案例＋內插極值／臺台正規化／數字邊界）。
  - `test/run-affected-page.js`：組測試頁（CSS/core/affected **全內嵌**）＋合成 fixture（虛構姓名，
    日期依執行日動態算）＋fetch mock＋34 項 self-test → headless Chrome `AFF PAGE ALL PASSED`。
  - 真實資料煙霧測試：本機靜態伺服器＋真實 API fixture（存 %TEMP%，**不進 repo**——真實車長姓名是個資）
    → 2026/11/25 彰化→嘉義 14:00–16:00 篩出 18 車次／22 車長／23 鏈、警告盒列 18 個無時刻表車次。
- **剩餘（人工）**：補 `tools/timetable-overrides.json`（18 筆）→ 重跑 `build-timetable.js` →
  commit → push Pages → 瀏覽器實測 affected.html。

#### 新環境教訓（2026/11/25，affected 實作期）

0. **2026/11/26 使用者回報三項已修**：起訖站下拉鎖定（populateStations 忘記解除 disabled）；
   車次列車長姓名可點 → 跳影響鏈該區塊＋閃爍標示（被 onlyShort 過濾時自動解除）；
   字體排版整體放大（基準 15px、表格 15px、統計 24px、版面 1200px）。
   **區間下拉定案變更**：改用時刻表主線站（基隆 0900～枋寮 5120，131 站），
   不只用 Station 表的 20 站——§9 的「下拉只用 Station 表」規則被取代。
1. **PowerShell 5.1 不支援 `&&` 串接**（ParserError）；內嵌 `node -e "..."` 一逗號引號就爆——
   多行 Node 腳本**一律寫檔再跑**，別用 `-e` 內嵌。
2. **測試頁的 `<script src>` 相對路徑**以測試頁所在目錄解析——測試頁放 `test/` 就找不到 `docs/` 的
   core/affected.js → 頁面整個沒啟動（且 `__ERRORS__` 是空的，因為 404 不算 JS 錯誤）。
   組測試頁時 CSS/JS **全部內嵌**最穩。
3. **dump-dom 的 selftest 斷言**：selftest 的 `<div id="selftest-summary">` 模板字串也出現在
   script 原始碼裡，regex 要錨定「數字 PASS / 數字 FAIL」的渲染版，`<pre>` 取最後一個。
4. **「全部套用延誤」會連下一班一起延誤**——緩衝公式「下一班出發含自身延誤」會把效果吃掉
   （301 +10、303 也 +10 → 緩衝不變）。測試情境要只延誤本班。
5. **`applyAll`／延誤是 per-train 單一值（覆蓋不累加）**＝「多筆延誤取 max 不取 sum」的 v1 實現。
6. 真實資料裡同一車長會在**同一查詢的多個車次**受影響（如小林 301/303 各一條鏈）——
   鏈數 ≥ 車長數是正常現象（鏈＝(車長，車次) 對）。
7. **`git commit -m "中文"` 會被 PowerShell 以 Big5 傳參**→ 儲存的訊息亂碼（git log 與 %B 讀出都是）。
   中文 commit 訊息一律：Node 寫 UTF-8 無 BOM 訊息檔 → `git commit -F <file>`（amend 同理）。
   驗證用 `git cat-file commit HEAD` 再以 UTF-8 解碼（PowerShell `>` 重導向會轉 UTF-16，別用它驗）。
