# 將 docs/ 靜態前端（index/styles/config/app）展開成可在瀏覽器直接預覽的單一 HTML
# 後端使用 test/mocks.js + test/data.js + Code.gs + LiffApi.gs 模擬 GAS 環境，fetch 攔截後直接呼叫 apiCall
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Read-Utf8([string]$path) {
  return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
}

$app = Read-Utf8 (Join-Path $root 'docs/index.html')
$styles = Read-Utf8 (Join-Path $root 'docs/styles.css')
$config = Read-Utf8 (Join-Path $root 'docs/config.js')
$appJs = Read-Utf8 (Join-Path $root 'docs/app.js')
$mocks = Read-Utf8 (Join-Path $PSScriptRoot 'mocks.js')
$data = Read-Utf8 (Join-Path $PSScriptRoot 'data.js')
$code = Read-Utf8 (Join-Path $root 'Code.gs')
$api = Read-Utf8 (Join-Path $root 'LiffApi.gs')

$preview = @'
<script>
  // ---- 預覽用：關閉動畫、收集錯誤、攔截 fetch 直接呼叫後端 apiCall ----
  (function () {
    var style = document.createElement('style');
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(style);
  })();
  window.__ERRORS__ = [];
  window.addEventListener('error', function (e) {
    window.__ERRORS__.push(String(e.message) + ' @ ' + e.filename + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__ERRORS__.push('rejection: ' + String((e.reason && e.reason.message) || e.reason));
  });
  try { localStorage.setItem('crew-schedule:name', '\u5c0f\u6797'); } catch (e) {}
  window.__API_CALLS__ = [];
  window.fetch = function (url, options) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          var req = JSON.parse(options.body);
          window.__API_CALLS__.push(req.action);
          var res = apiCall(req.action, req.payload || {});
          resolve({
            ok: true,
            status: 200,
            text: function () { return Promise.resolve(JSON.stringify(res)); },
            json: function () { return Promise.resolve(res); }
          });
        } catch (e) { reject(e); }
      }, 120);
    });
  };
  window.addEventListener('load', function () {
    setTimeout(function () {
      var hash = String(location.hash || '').replace(/^#/, '');
      if (!hash) return;
      if (hash === 'name') {
        var btn = document.getElementById('nameBtn');
        if (btn) btn.click();
        return;
      }
      if (hash.indexOf('quick-') === 0) {
        var quick = document.querySelector('[data-quick="' + hash.slice(6) + '"]');
        if (quick) quick.click();
        return;
      }
      var tab = document.querySelector('.tab[data-nav="' + hash + '"]');
      if (tab) tab.click();
      if (hash === 'search') {
        setTimeout(function () {
          var form = document.getElementById('searchForm');
          if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }, 400);
      }
      if (hash === 'trains') {
        setTimeout(function () {
          var input = document.querySelector('[data-field="trainQ"]');
          if (input) {
            input.value = '3178';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, 500);
      }
    }, 1400);

    setTimeout(function () {
      var shell = document.querySelector('.app-shell');
      var diag = 'vw=' + window.innerWidth + ' dpr=' + window.devicePixelRatio +
        ' shell=' + (shell ? shell.getBoundingClientRect().width : '-') +
        ' body=' + document.body.clientWidth;
      document.body.setAttribute('data-diag', diag);
      if (!window.__ERRORS__ || !window.__ERRORS__.length) return;
      document.title = 'ERRORS: ' + window.__ERRORS__.join(' | ');
      var box = document.createElement('div');
      box.id = 'preview-errors';
      box.textContent = window.__ERRORS__.join(' | ');
      box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;' +
        'background:#b00020;color:#fff;font:12px/1.4 monospace;padding:6px 8px';
      document.body.appendChild(box);
    }, 3200);
  });
</script>
<script>
  // ---- 預覽用：互動自我測試（開啟 #test） ----
  window.addEventListener('load', function () {
    if (String(location.hash || '').replace(/^#/, '') !== 'test') return;

    var lines = [];
    var fails = 0;
    function ok(cond, label) {
      if (cond) lines.push('PASS  ' + label);
      else { fails++; lines.push('FAIL  ' + label); }
    }
    function wait(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }
    function q(sel) { return document.querySelector(sel); }
    function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
    function submit() {
      var form = q('#searchForm');
      if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }

    (async function () {
      await wait(2000);
      ok(!!q('.hero'), '首頁英雄卡');
      ok(qa('.week-row').length === 7, '首頁 7 天列表（' + qa('.week-row').length + '）');
      ok(!q('.week-row.is-today'), '7 天列表從明天開始（不含今天）');
      ok(!!q('.tl-now'), '今日行程顯示現在時間線');

      var weekBtn = q('.week-row');
      weekBtn.click();
      await wait(120);
      ok(weekBtn.getAttribute('aria-expanded') === 'true', '7 天列表展開');
      weekBtn.click();
      await wait(120);
      ok(weekBtn.getAttribute('aria-expanded') === 'false', '7 天列表收合');

      // 當月班表
      ok(!!q('#monthSection .month-card'), '首頁當月班表');
      ok(qa('#monthSection .month-day:not(.is-blank)').length === 30, '當月日曆 30 天（' + qa('#monthSection .month-day:not(.is-blank)').length + '）');
      ok(qa('#monthSection .month-day.is-work').length > 0, '當月日曆有上班日');
      q('[data-action="month-prev"]').click();
      await wait(800);
      ok(q('#monthSection .month-nav-main strong').textContent.indexOf('10 月') >= 0, '當月班表切上個月');
      q('[data-action="month-current"]').click();
      await wait(800);
      ok(q('#monthSection .month-nav-main strong').textContent.indexOf('11 月') >= 0, '當月班表切回本月');

      // 所有班表
      ok(!!q('#allSchedSection .all-card'), '首頁所有班表');
      ok(qa('#allSchedSection .all-row').length === 14, '所有班表列出 14 列（' + qa('#allSchedSection .all-row').length + '）');
      var allText = q('#allSchedSection').textContent;
      ok(allText.indexOf('小林') >= 0 && allText.indexOf('李美華') >= 0 && allText.indexOf('陳大明') >= 0, '所有班表對到當日車長');
      ok(qa('#allSchedSection .sort-chip').length === 4, '所有班表四種排序');
      q('[data-action="sort-all"][data-sort="on"]').click();
      await wait(200);
      ok(q('[data-action="sort-all"][data-sort="on"]').classList.contains('active'), '上班時間排序啟用');
      q('[data-action="sort-all"][data-sort="number"]').click();
      await wait(200);

      // 點所有班表列 → 車長當日詳情
      var koRow = qa('#allSchedSection .all-row').filter(function (r) { return r.textContent.indexOf('小林') >= 0; })[0];
      ok(!!koRow, '所有班表有小林的列');
      koRow.click();
      await wait(900);
      ok(q('.detail-title') && q('.detail-title').textContent === '小林', '所有班表開啟車長當日詳情');
      ok(!!q('.detail-view .hero'), '詳情使用我的班表介面（英雄卡）');
      q('[data-action="close-detail"]').click();
      await wait(700);
      ok(!q('.detail-view') && !!q('.hero'), '關閉詳情回首頁');

      // 月曆點日期 → 詳情
      var dayBtn = q('#monthSection .month-day[data-date="2026-11-19"]');
      dayBtn.click();
      await wait(900);
      ok(q('.detail-title') && q('.detail-title').textContent === '小林', '月曆點日期開啟當日詳情');
      q('[data-action="close-detail"]').click();
      await wait(700);

      var quick = q('[data-quick="live"]');
      ok(!!quick, '快速查詢按鈕');
      ok(q('[data-quick="who"]').textContent.indexOf('非值乘') >= 0, '快速查詢顯示非值乘');
      ok(getComputedStyle(q('.quick-grid')).gridTemplateColumns.split(' ').length === 3, '快速查詢三格同一列');
      quick.click();
      await wait(800);
      ok(!!q('.tab[data-nav="search"].active'), '快速查詢切到查詢頁');
      ok(!!q('.results-head'), '快速查詢有結果');
      ok(qa('[data-action="search-tab"]').length === 2, '查詢頁只剩兩個頁籤');
      ok(!!q('[data-field="station"]'), '狀態表單含車站欄位');
      ok(qa('[data-action="set-days"]').length === 0, '狀態頁沒有多日選項');

      q('[data-action="search-tab"][data-tab="status"]').click();
      await wait(150);
      q('[data-action="set-keyword"][data-keyword="放假"]').click();
      await wait(150);
      submit();
      await wait(700);
      ok(!!q('.results-head'), '放假查詢有結果');

      q('[data-action="set-search-date"][data-date="2026-11-19"]').click();
      await wait(250);
      ok(q('[data-field="date"]').value === '2026-11-19', '查詢日期快捷');
      q('[data-action="set-search-date"][data-date="2026-11-18"]').click();
      await wait(250);

      q('[data-action="search-tab"][data-tab="status"]').click();
      await wait(150);
      q('[data-action="set-keyword"][data-keyword="中場"]').click();
      await wait(150);
      ok(q('[data-action="set-keyword"].active').textContent === '非值乘', '狀態頁籤顯示非值乘');
      var stationInput = q('[data-field="station"]');
      stationInput.value = '嘉義';
      stationInput.dispatchEvent(new Event('input', { bubbles: true }));
      submit();
      await wait(700);
      ok(!!q('.results-head'), '狀態＋車站查詢有結果');
      ok(q('.results-meta').textContent.indexOf('嘉義') >= 0, '查詢結果標示車站');

      q('[data-action="search-tab"][data-tab="lookup"]').click();
      await wait(150);
      ok(q('#searchForm .btn-primary').textContent.indexOf('查詢班表') >= 0, '查詢按鈕為查詢班表');
      var lookupInput = q('[data-field="lookup"]');
      lookupInput.value = '小林';
      lookupInput.dispatchEvent(new Event('input', { bubbles: true }));
      submit();
      await wait(700);
      ok(qa('#searchResults .staff-head .staff-name').length > 0, '姓名查班表命中');

      lookupInput = q('[data-field="lookup"]');
      lookupInput.value = '小林 李美華';
      lookupInput.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(120);
      ok(q('#lookupHint').textContent.indexOf('2 位車長') >= 0, '多人輸入提示');
      submit();
      await wait(700);
      ok(qa('#searchResults .staff-head').length === 2, '多人班表命中');

      lookupInput = q('[data-field="lookup"]');
      lookupInput.value = '小林 3178';
      lookupInput.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(120);
      ok(q('#lookupHint').classList.contains('is-error'), '混合姓名車次提示錯誤');

      lookupInput = q('[data-field="lookup"]');
      lookupInput.value = '小林';
      lookupInput.dispatchEvent(new Event('input', { bubbles: true }));
      q('[data-action="set-days"][data-days="3"]').click();
      await wait(200);
      ok(q('[data-action="set-days"][data-days="3"]').classList.contains('active'), '多日選項啟用');
      submit();
      await wait(700);
      ok(qa('#searchResults .result-date').length === 3, '多日班表三天');
      ok(q('.results-meta').textContent.indexOf('3 天') >= 0, '多日標題顯示天數');
      q('[data-action="set-days"][data-days="1"]').click();
      await wait(200);

      lookupInput = q('[data-field="lookup"]');
      lookupInput.value = '3178';
      lookupInput.dispatchEvent(new Event('input', { bubbles: true }));
      submit();
      await wait(700);
      ok(qa('.matched-row').length > 0, '車次反查命中');

      lookupInput = q('[data-field="lookup"]');
      lookupInput.value = '3178 3257';
      lookupInput.dispatchEvent(new Event('input', { bubbles: true }));
      submit();
      await wait(700);
      ok(qa('.matched-row').length >= 2, '多車次反查命中');

      q('.tab[data-nav="trains"]').click();
      await wait(800);
      ok(qa('#trainList .train-row').length > 0, '全部車次列表');
      ok(!!q('#trainList .now-line'), '車次頁顯示現在時間線');
      var stationOpts = qa('[data-field="trainFrom"] option').map(function (o) { return o.value; }).filter(Boolean);
      ok(stationOpts[0] === '七堵' && stationOpts.indexOf('嘉義') < stationOpts.indexOf('潮州'), '車站依站序排列');

      q('[data-field="trainFrom"]').value = '嘉義';
      q('[data-field="trainFrom"]').dispatchEvent(new Event('change', { bubbles: true }));
      q('[data-field="trainTo"]').value = '后里';
      q('[data-field="trainTo"]').dispatchEvent(new Event('change', { bubbles: true }));
      q('[data-field="trainDirection"]').value = '順向';
      q('[data-field="trainDirection"]').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(200);
      ok(qa('#trainList .train-row').length === 1, '起迄站＋方向篩選');
      ok(q('#trainList').textContent.indexOf('3178') >= 0, '方向篩選命中 3178');

      ['trainFrom', 'trainTo'].forEach(function (field) {
        var select = q('[data-field="' + field + '"]');
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      q('[data-field="trainDirection"]').value = '逆向';
      q('[data-field="trainDirection"]').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(200);
      var reverseText = q('#trainList').textContent;
      ok(reverseText.indexOf('3257') >= 0 && reverseText.indexOf('3178') < 0, '末碼奇數列為逆向');

      q('[data-field="trainDirection"]').value = '順向';
      q('[data-field="trainDirection"]').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(200);
      var forwardText = q('#trainList').textContent;
      ok(forwardText.indexOf('2274便') >= 0 && forwardText.indexOf('3257') < 0, '便字後綴不影響方向判斷');

      ['trainFrom', 'trainTo', 'trainDirection'].forEach(function (field) {
        var select = q('[data-field="' + field + '"]');
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await wait(200);
      ok(qa('#trainList .train-row').length > 1, '清除車次篩選');

      var before = q('[data-field="trainDate"]').value;
      q('[data-action="train-next"]').click();
      await wait(800);
      ok(q('[data-field="trainDate"]').value !== before, '車次頁換日');

      var dirSelect = q('[data-field="trainDirection"]');
      dirSelect.value = '逆向';
      dirSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(200);
      ok(q('#trainList').textContent.indexOf('270A') >= 0, '270A 依站序判斷為逆向');
      dirSelect.value = '';
      dirSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(200);

      q('[data-action="train-today"]').click();
      await wait(800);
      ok(q('[data-field="trainDate"]').value === '2026-11-18', '車次頁回到今天');

      var search = q('[data-field="trainQ"]');
      search.value = '3178';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(150);
      ok(qa('#trainList .train-row').length === 1, '車次關鍵字篩選');
      q('[data-action="retry-trains"]').click();
      await wait(800);
      ok(qa('#trainList .train-row').length === 1, '車次重新整理');

      // 車次列 → 車長當日詳情
      var trainRowBtn = q('#trainList .train-row');
      ok(trainRowBtn && trainRowBtn.getAttribute('data-action') === 'open-staff-day', '車次列可點擊');
      trainRowBtn.click();
      await wait(900);
      ok(!!q('.detail-view'), '車次列開啟車長當日詳情');
      q('[data-action="close-detail"]').click();
      await wait(700);
      ok(qa('#trainList .train-row').length > 0, '關閉詳情回到車次頁');

      q('.tab[data-nav="home"]').click();
      await wait(600);
      ok(!q('[data-quick="station"]'), '車站休息快捷已移除');
      ok(qa('.quick-btn').length === 3, '快速查詢剩三格');

      q('#nameBtn').click();
      await wait(250);
      ok(!!q('#nameSearch'), '姓名面板開啟');
      var nameSearch = q('#nameSearch');
      nameSearch.value = '李';
      nameSearch.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(150);
      ok(qa('#nameList .staff-row').length === 1, '姓名搜尋篩選');
      q('#nameList .staff-row').click();
      await wait(900);
      ok(q('#nameBtn .chip-text').textContent === '李美華', '選擇姓名');

      q('.tab[data-nav="home"]').click();
      await wait(900);
      ok(!!q('.hero'), '回首頁顯示班表');

      q('#nameBtn').click();
      await wait(200);
      q('[data-action="clear-name"]').click();
      await wait(200);
      ok(q('#nameBtn .chip-text').textContent === '設定姓名', '清除姓名');
      ok(!!q('.hero.is-empty'), '清除後顯示設定引導');

      var box = document.createElement('div');
      box.id = 'selftest';
      box.textContent = lines.join('\n');
      box.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#0b1a12;' +
        'color:' + (fails ? '#ffb4b4' : '#a8f0c0') + ';font:12px/1.7 Consolas,monospace;' +
        'padding:18px;white-space:pre-wrap';
      document.body.appendChild(box);
      document.title = fails ? 'UI FAILED ' + fails : 'UI ALL PASSED';
    })();
  });
</script>
'@

$backend = "<script>`n" + $mocks + "`n</script>`n<script>`n" +
  $data + "`n</script>`n<script>`n" +
  $code + "`n</script>`n<script>`n" +
  $api + "`n</script>"

# docs/index.html 的三個外鏈 marker（必須存在，否則中斷）
$styleMarker = '<link rel="stylesheet" href="styles.css">'
$configMarker = '<script src="config.js"></script>'
$appMarker = '<script src="app.js"></script>'
if ($app.IndexOf($styleMarker) -lt 0) { throw 'styles.css marker not found in docs/index.html' }
if ($app.IndexOf($configMarker) -lt 0) { throw 'config.js marker not found in docs/index.html' }
if ($app.IndexOf($appMarker) -lt 0) { throw 'app.js marker not found in docs/index.html' }

# .Replace() 是字面替換（不吃 $ 特殊符號），app.js 內的 function $$ 因此安全
$app = $app.Replace($styleMarker, "<style>`n" + $styles + "`n</style>")
$app = $app.Replace($configMarker, "<script>`n" + $config + "`nwindow.APP_CONFIG.API_URL = 'mock://local';`n</script>")
$app = $app.Replace($appMarker, $backend + "`n" + $preview + "`n<script>`n" + $appJs + "`n</script>")

$target = Join-Path $PSScriptRoot '_preview.html'
[IO.File]::WriteAllText($target, $app, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $target
