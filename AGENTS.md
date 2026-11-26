# AGENTS.md：車長班表（給 AI 助手與未來的開發者）

> 改這個 repo 之前先讀完這份。尤其「CORS 限制」「不可回退的設計決策」「血淚教訓」三節——
> 都是真的踩過的坑，不是建議。

## 這是什麼

台鐵車長班表查詢系統：LINE Bot ＋ 手機優先網頁版，共用同一份 Google Sheet 班表資料。

- Repo：https://github.com/JHC63/crew-schedule（branch `main`）
- 網頁版：https://jhc63.github.io/crew-schedule/（GitHub Pages，source = `main` + `/docs`）
- 後端：GAS Web App `/exec`（網址填在 `docs/config.js` 的 `API_URL`）

## 架構

```
GitHub Pages（docs/：index.html + styles.css + app.js + config.js，純靜態）
        │ fetch POST（Content-Type: text/plain，body 為 JSON 字串）
        ▼
GAS Web App /exec（純 JSON API）
  doPost(e)：body.events[] → handleLineWebhook_（LINE Bot，Code.gs）
             body.action   → apiCall(action, payload) → { ok, data | error }
  doGet(e) ：健康檢查／?action=&payload=<URL-encoded JSON>
        ▼
Google Sheet：Staff / Schedule / Schedule_S / Station
```

- `doPost` 是**分流器**（Code.gs）：`events` 陣列優先於 `action` 字串；JSON 解析失敗時依
  `postData.type` 分流——`application/json`（LINE）回 `OK` 防 LINE 重試，其他回 JSON 錯誤。
- `handleApiRequest_`／`jsonResponse_` 在 LiffApi.gs；`apiCall` 與 10 個 `liff*_` handler 行為凍結。
- 前端 `docs/app.js` 的 `api()`：`fetch(API_URL, { method:'POST', redirect:'follow',
  headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify({action,payload}) })`，
  先 `res.text()` 再 `JSON.parse`，解析 `{ok,data|error}` envelope（**不能只看 `response.ok`**）。
- bootstrap（名單/車站/日期）在 localStorage 快取 `crew-schedule:bootstrap:v1`，TTL 6 小時；**班表永不快取**。

## 關鍵檔案

| 檔案 | 內容 |
| --- | --- |
| `Code.gs` | 班表計算核心＋LINE Bot＋`doPost` 分流器 |
| `LiffApi.gs` | `doGet`／`apiCall`／`handleApiRequest_`／`jsonResponse_`＋全部 JSON API handler |
| `docs/` | 靜態前端（無 GAS 模板語法、無 `google.script.run`、無 `MockApi`） |
| `docs/config.js` | `window.APP_CONFIG = { API_URL, BOOTSTRAP_CACHE_TTL_MS, TIMETABLE_VERSION }`——會公開，不放秘密 |
| `docs/affected*.html/js/css` | 主管用「受影響列車」獨立頁（見下方「受影響列車頁」節；不進 LIFF、不從首頁連結） |
| `docs/data/timetable.json` | 受影響列車頁的時刻表（`tools/build-timetable.js` 產生物，會 push 上 Pages） |
| `docs/1161125GeneralTrainTimetable.json` | TDX 定期時刻表原始檔（954 車次；建置 `timetable.json` 的輸入） |
| `tools/build-timetable.js` | 匯入腳本：Schedule_S CSV＋TDX JSON → `docs/data/timetable.json`＋報告＋自動更新 `TIMETABLE_VERSION` |
| `tools/timetable-overrides.example.json` | 人工補對照格式範本（實檔 `timetable-overrides.json` 存在才會被合併） |
| `tools/station-kms.json` | Station 表 站名→KM（站碼排序驗證用） |
| `appsscript.json` | V8、`executeAs: USER_DEPLOYING`、`access: ANYONE_ANONYMOUS`（維持不動） |
| `test/` | 本機測試（`.gitignore` 排除 `test/_preview*.html`、`test/_api-test.html`、`test/_affected-*.html`、`test/results.txt`、`tools/reports/` 產生物） |
| `handsoff.md` | 進度交接記錄（重構過程全記錄） |
| `affected-plan.md` | 「受影響列車」功能完整規格（§5 計算流程、§13 邊界、§16 步驟） |
| `LIFF_README.md` | 使用者／部署導向的說明 |

- 秘密：`LINE_TOKEN`、`SPREADSHEET_ID` 都在 GAS「指令碼屬性」（Script Properties），
  `Code.gs` 的 `CONFIG` 用 getter 從 `PropertiesService` 讀。原始碼內沒有任何秘密。
- `.claspignore` 排除 `docs`、`test`、`*.md`；`clasp push --force`（非互動環境不加 `--force` 會 `Skipping push.`）。

## 測試指令（速查）

```powershell
# 1. LINE Bot 回覆（48 題；覆寫 test/results.txt；baseline 在 test/results-baseline.txt）
node test\run.js

# 2. LIFF API + doGet/doPost 分流（24 項）
node test\run-api.js

# 3. 後端完整 API（24 項）+ headless Chrome；檢查輸出 <title>ALL PASSED</title>
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\build-api-test.ps1
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu --virtual-time-budget=8000 --dump-dom "file:///C:/Users/User/Documents/預設專案/test/_api-test.html"

# 4. 前端 UI self-test（68 項）；檢查 <title>UI ALL PASSED</title>
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\build-preview.ps1
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu --allow-file-access-from-files --window-size=500,900 --virtual-time-budget=45000 --dump-dom "file:///C:/Users/User/Documents/預設專案/test/_preview.html#test"

# 5. 受影響列車：純邏輯測試（57 項）；全過輸出 AFF CORE ALL PASSED
node test\run-affected.js

# 6. 受影響列車：頁面測試（34 項；組頁＋headless Chrome）；檢查 <title>AFF PAGE ALL PASSED</title>
node test\run-affected-page.js

# 7. 受影響列車：重產時刻表（改了 CSV／補了 overrides 之後）
cmd /c "node tools\build-timetable.js --csv `"C:\Users\User\Documents\佳合資料夾\道路駕駛路線\班表查詢 - Schedule_S.csv`" --tdx `"docs\1161125GeneralTrainTimetable.json`""
```

- `test/run.js`、`test/run-api.js` 用 `eval(code + '\n' + api)` 同時載入 `Code.gs`＋`LiffApi.gs`
  （`doPost` 分流的 API／解析錯誤路徑需要 `jsonResponse_`；兩個 runner 都**不能加 `'use strict'`**，
  否則 eval 的函式宣告不外溢）。
- 三套後端測試共用 `test/mocks.js`（GAS 環境模擬＋固定時間 2026/11/18 14:00 台北）＋`test/data.js`（固定資料）。
- 改了回覆文案／API 行為：先 `node test\run.js` 重產 `results.txt`，再與 baseline 比對，確認差異都是預期的。
- PowerShell 5.1 主控台中文會亂碼——輸出留檔用 `cmd /c "node ... > %TEMP%\opencode\xxx.txt 2>&1"` 再讀檔。

## CORS 限制（必讀，前端設計都建立在這上面）

1. **只能發「簡單請求」**：GAS 沒有 `doOptions`（OPTIONS 一律 405）、`ContentService` 不能自訂 CORS header。
   `Content-Type: application/json` 或自訂 header 會觸發 preflight → 直接掛。
   前端固定 `Content-Type: text/plain;charset=utf-8`（body 仍是 JSON 字串）。
2. **GAS 恆回 HTTP 200**：錯誤走 `{ ok:false, error }` envelope，前端要解析 envelope，不能只看 `response.ok`。
3. **302 → echo**：`/exec` 302 轉到 `script.googleusercontent.com/macros/echo?...`（echo 只收 GET）。
   瀏覽器 `redirect:'follow'` 自動處理，兩跳都帶 `ACAO:*`（已實測）。
   curl 測 POST：`curl -L -H "Content-Type: text/plain" --data-binary @file.json "<exec>"`——
   **不要加 `-X POST`**（第二跳強制 POST 無 body → 411；`--post302` → 405）。
4. **不可 `mode:'no-cors'`**：回應 opaque 讀不到。
5. 部署存取權必須「所有人」；看到 Google 登入頁（HTML）＝權限設定錯誤。

## 不可回退的設計決策

- `doPost` 分流：**events 陣列優先於 action**；LINE 永遠回 `OK`；API 恆 JSON、HTTP 200。
- 前端只靠 `text/plain` 簡單請求；不可加 `application/json`／自訂 header／`Authorization`。
- `docs/app.js` 無 `MockApi`；測試一律用 fetch mock 攔截（見 `test/build-preview.ps1`）。
- `apiCall` 的 10 個 action（bootstrap/mySchedule/staffDay/monthSchedule/allSchedules/staffSchedule/status/station/trainLookup/allTrains）行為不變。
- bootstrap 快取只放名單/車站/日期，班表永不快取。
- `LINE_TOKEN`、`SPREADSHEET_ID` 只放 GAS Script Properties；`docs/config.js` 不放秘密。

## 血淚教訓（踩過的坑）

1. **JS `String.replace()` 的替換字串會吃特殊符號**：`$$` → `$`。
   組 HTML／注入程式碼時曾把 `app.js` 的 `function $$(sel, root)`（querySelectorAll 助手）折疊成第二個
   `function $`，同名後者覆蓋前者，`$()` 回傳**陣列** → `init()` 在 `updateNameChip` 靜默爆炸
   （被底部 try/catch 吃掉，完全無聲）。**組字串一律用 `split(marker).join(replacement)`。**
   （PowerShell 的 `.Replace()` 是字面替換、安全；Node/JS 的 `.replace()` 才有這問題。）
2. **UI self-test 需要 `--virtual-time-budget=45000`**（self-test timer 總量約 25 秒）。
   20000 跑不完：title 不變、無錯誤框、無 selftest 框——看起來像壞掉，其實是預算不足。
3. **Chrome 158 headless 不要加 `--user-data-dir`**：噴
   `Multiple targets are not supported in headless mode` 並輸出空 DOM。維持最小參數。
4. **`clasp push` 非互動環境要 `--force`**（appsscript.json 比對會觸發確認提示，沒 TTY 就 `Skipping push.`）。
5. **`clasp push` 不會刪遠端檔案**：從 repo 刪掉的檔案，GAS 編輯器裡還在，要手動刪。
6. **PowerShell 5.1 編碼**：`.ps1` 一律存 UTF-8 **with BOM**（否則中文變 ANSI 亂碼、內嵌 JS 可能 SyntaxError）；
   `.gs`／`.html`／`docs/*` 是 UTF-8 無 BOM。主控台亂碼≠檔案壞掉，比對檔案用 hash／byte 層級，別用 `Get-Content` 行數。
7. **診斷手法**：組測試頁時對 app.js 注入 `window.__TRACE__` 追蹤點（不改 repo 檔）；
   `document.contentType`、`Object.prototype.toString.call(el)` 能快速分辨「文件問題」vs「元素問題」。
   錯誤被 try/catch 吃掉時，先懷疑某個 helper 回傳了非預期型別（見教訓 1）。
8. **GAS 部署**：`clasp deploy -i <deploymentId> -d <描述>` 可原地重建、`/exec` 網址不變；
   改 `.gs` 後不重建新版，`/exec` 一直是舊版。

## 既有領域規則（班表邏輯，動 Code.gs 前先懂）

- **基準日 `BASE_DATE`（`2026/07/01`）**：所有輪值 Index 以這天為基準；查詢不得早於這天
  （API 回 `無法查詢基準日以前`，前端日期欄位 `min` 也鎖這天）。時區固定 `Asia/Taipei`。
- **Schedule_S 表頭動態對應**（大小寫／前後空白不限）：必填
  `Number／Train／S_time／A_time／Group／Index`；`S_station／A_station／B_time` 可省略
  （相容有無 `B_time` 欄兩種格式）。缺欄位會直接 throw，訊息會列出缺哪些。
- **輪值遞減**：車長等常規群組（A/B/C）是「遞減循環」——人員的 Index 每天 +1，
  所以 `baseIndex` 對應的班表 Index 每天**遞減**（`getScheduleSIndex`：`raw = (1 - baseIndex + diffDays) % cycleLength`）。
  **例外**：日管／日內採「遞增循環」（`CONFIG.INCREMENT_GROUPS`）。
- **輪值週期**：`CONFIG.SCHEDULE_S_CYCLE_LENGTH`（A:47、B:47、C:20）；未設定的群組自動取該群組最大 Index。
- **群組名稱對照**：`副座→日管`、`助理→日內`（`GROUP_NAME_ALIASES`），讀試算表時自動轉換，兼容舊資料。
- **跨夜班**：只有 Schedule 當日**班表名稱**含「跨夜」（`CROSS_NIGHT_KEYWORD`）才算；
  跨夜列是放假分界、不是實際班次（即使有完整時間也不列入值乘）。
  跨夜列時間優先取 `A_time`、其次 `S_time`。同一天若有完整班次，忽略跨夜列。
  跨夜日放假起點＝跨夜列時間；沒有時間（或早於前一天收班）就用前一天算出的後整結束時間。
- **兩天班**（如 `501-1 → 501-2`）視為同一個工作區塊：D1 收班直接接到 D2 報到／跨夜列，不列一般後整。
- **放假判定**：當日沒有班次，且班表名稱含 `休息日／例假／跨夜`（`STATUS_LEAVE_KEYWORDS`）才列出（`例假(第幾週)` 也命中）。
- **順逆向**：以 `Station` 工作表 `KM` 欄判斷——起站 KM **大於**迄站＝順向、**小於**＝逆向
  （例：民雄 282.5 → 嘉義 291.8 = **逆向**）。任一站查不到 KM 才退回車次末碼（偶數順向、奇數逆向）；
  車次後綴（`便`、`A` 等）不影響判斷。
- **顯示名稱**：狀態查詢的「中場」顯示為「非值乘」（`STATUS_DISPLAY_NAMES`）。
- **查詢上限**：`CONFIG.MAX_QUERY_DAYS = 14`；`staffSchedule`／`trainLookup` 的 `dates[]` 會排序去重再套上限。
- **`allTrains` 排序**：開車時間 → 起站（`localeCompare('zh-Hant')`）→ 抵達時間 → 車次；後端快取 120 秒。

## 受影響列車頁（主管用，docs/affected*.html/js/css）

規格全文見 `affected-plan.md`。重點：

- **純前端**：不新增 GAS action（`apiCall` 10 個 action 凍結）；API 只用現有
  `bootstrap`＋`staffSchedule`（names[] 每 10 人一批、並行 4；真實 114 人＝12 批約 15 秒，頁面開啟即背景預載）。
- **三層模型**：L1 篩選（timetable.json 停靠序列＋站序內插）→ L2 對人（班表 segments 的上／下車站序
  與事故區間比對）→ L3 影響鏈（緩衝時間＝下一班出發＋下一班自身延誤−本班抵達−本班延誤；門檻嚴格 `<`）。
- **L2 邊界（2026/11/26 使用者回饋改）**：下車站在進入端**之前**才標「未受影響」；
  **下車站＝進入端算受影響（alighting）**——3207 延誤 90 時在彰化（進入端）下車的車長抵達也延後 90，
  要看得到「接不上 2173」這條鏈。改這條規則要連動 `test/run-affected.js` 案例 5b／9b／9e／18。
- **兩種查詢方式（2026/11/26）**：表單上方 radio 切換「起訖區間／指定車次」，換模式清空上一次結果。
  - 起訖站是**自刻 combobox**（點一下列全部 131 站、打字過濾、站碼可搜、「台北」找得到「臺北」；
    邏輯在 core `filterStations`/`resolveStation`）。方向值 `both`/`forward`（順向＝北上）/`reverse`（逆向＝南下），
    舊情境 `north`/`south` 載入時自動遷移。
  - **指定車次**（`computeTrainResults`＋core `resolveTrainNo`/`orderLegs`）：整趟延誤 D 分＝所有值乘腿
    一起延後；值乘腿依 `startMs` 排序（CSV 列序不是行駛順序）；每位車長只追下一個班一層（完整影響鏈），
    腿間顯示交接列（交接站不一致／重疊／間隔 >60 分 → ⚠）。輸入 `115` 今日只有 `115A` → 自動對到；
    `115A`/`115B` 並存 → 回「請輸入完整車次」；有 A/B 後綴查無 → 不退回基數。
- **母體**＝當日班表出現的車次（正規化後）∩ timetable.json——沒車長值乘的車次不列。
- **車次正規化**（與 `tools/build-timetable.js` 同規則）：去「便」後綴、去括號附註（`3148(3146)`→3148）；
  **A/B 後綴（115A 等）是折返續開腿，不可自動退基數**（基數車是反方向／另一班），一律進
  `tools/reports/unmatched.txt` 人工補（`tools/timetable-overrides.json`）。
- **時間一律「營運日 00:00 起算分鐘數」，跨夜 >1440**（timetable.json 與班表 segments 皆如此；
  頁面以 `minOfDay(ms)` 對齊台北當日 00:00）。
- **純邏輯在 `docs/affected-core.js`**（掛 `window.AFFECTED_CORE`，Node 可 `require`）——
  改 L1/L2/L3 規則先改 core＋跑 `test/run-affected.js`，再動 affected.js。
- 延誤情境存 `localStorage`（`crew-schedule:affected:v1`，換天自動重置）；不上傳、無伺服器狀態。
- `docs/config.js` 的 `TIMETABLE_VERSION` 是 timetable.json 的 cache-busting，**由 build-timetable.js 自動更新**。
- 頁面網址 `https://jhc63.github.io/crew-schedule/affected.html`（書籤用，不連結、不宣傳）。

## 手動事項（無法自動化）

- GAS 編輯器手動刪遠端三個舊 HTML（`LiffApp.html`、`LiffStyles.html`、`LiffScripts.html`）——`clasp push` 不會刪遠端。
- LINE Developers Console：LIFF app 的 Endpoint URL 指到 `https://jhc63.github.io/crew-schedule/`。
