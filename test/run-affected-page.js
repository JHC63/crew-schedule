#!/usr/bin/env node
// ============================================================
// test/run-affected-page.js——受影響列車「頁面測試」（affected-plan.md §14 頁面測試）
// 比照 test/build-preview.ps1 模式（fetch mock 攔 API＋固定資料），但用 Node 組頁與執行：
//   1. 讀 docs/affected.html 本體，內嵌合成 fixture（日期依執行當天的「台北今天」動態算，
//      車長姓名為虛構，不含真實個資）
//   2. fetch mock：bootstrap／staffSchedule 由 fixture 即時組回應（不依賴批次切分）
//   3. 自動按「查詢」，跑 self-test（查詢結果／延誤快速鍵／緩衝即時重算／推估開關／
//      只看不足／localStorage 情境／無時刻表警告／CSV・列印按鈕）
//   4. headless Chrome --dump-dom → 檢查 <title>AFF PAGE ALL PASSED</title>
// 跑法：node test\run-affected-page.js
// 產物：test/_affected-test.html（.gitignore 排除）
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_HTML = path.join(__dirname, '_affected-test.html');
const DOM_OUT = process.env.TEMP + '/opencode/affected-test-dom.html';

// ---------- 合成資料（站序 pos 沿線遞增；姓名虛構） ----------
const STATIONS = [
  { id: '1000', name: '台北', pos: 0, inStationTable: true },
  { id: '3300', name: '臺中', pos: 1, inStationTable: true },
  { id: '3360', name: '彰化', pos: 2, inStationTable: true },
  { id: '3410', name: '員林', pos: 3, inStationTable: true },
  { id: '4080', name: '嘉義', pos: 4, inStationTable: true },
  { id: '4400', name: '高雄', pos: 5, inStationTable: true }
];
function stopsMin(arr) { return arr; }
// 車次（分鐘數在頁面內依「今天」轉 ms；這裡直接存分鐘）
const TRAINS = [
  // 101 南下：臺中 13:10 → 彰化 14:10 → 嘉義 15:10
  { no: '101', type: '自強', typeCode: '11', headsign: '往嘉義', extraTrain: false,
    serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 }, note: '',
    stops: [['3300', 790, 790], ['3360', 850, 850], ['4080', 910, 910]] },
  // 201 南下：臺中 13:30 → 員林 14:40 → 嘉義 15:50（彰化不停靠 → 推估 ≈14:05）
  { no: '201', type: '區間', typeCode: '6', headsign: '往嘉義', extraTrain: false,
    serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 }, note: '',
    stops: [['3300', 810, 810], ['3410', 880, 882], ['4080', 950, 950]] },
  // 102 北上：嘉義 14:20 → 彰化 15:20 → 台北 16:20
  { no: '102', type: '自強', typeCode: '11', headsign: '往台北', extraTrain: false,
    serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 }, note: '',
    stops: [['4080', 860, 860], ['3360', 920, 920], ['1000', 980, 980]] },
  // 301 南下：彰化 14:00 → 嘉義 15:00
  { no: '301', type: '區間', typeCode: '6', headsign: '往嘉義', extraTrain: false,
    serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 }, note: '',
    stops: [['3360', 840, 840], ['4080', 900, 900]] },
  // 303 北上：嘉義 15:14 → 彰化 16:30 → 台北 17:40
  { no: '303', type: '區間', typeCode: '6', headsign: '往台北', extraTrain: false,
    serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 }, note: '',
    stops: [['4080', 914, 914], ['3360', 990, 990], ['1000', 1060, 1060]] },
  // 501 跨夜：高雄 23:00 → 嘉義 23:57(+1 00:17) → 彰化(+1 01:20)——時段外，不會入選
  { no: '501', type: '區間', typeCode: '6', headsign: '往台北', extraTrain: false,
    serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 }, note: '在嘉義跨日。',
    stops: [['4400', 1380, 1380], ['4080', 1437, 1457], ['3360', 1520, 1522]] }
];
// 車長值乘（name 虛構；title 為班表原始車次字串）
const CREW = [
  { name: '小林', group: 'A', label: '067-1', segs: [
    { title: '301', station: '彰化', toStation: '嘉義', dep: 840, arr: 900 },
    { title: '303', station: '嘉義', toStation: '彰化', dep: 914, arr: 990 }
  ] },
  { name: '大華', group: 'B', label: '068-2', segs: [
    { title: '102', station: '嘉義', toStation: '彰化', dep: 860, arr: 920 }
  ] },
  { name: '阿美', group: 'C', label: '069-1', segs: [
    { title: '201', station: '員林', toStation: '嘉義', dep: 880, arr: 950 }
  ] },
  { name: '陳強', group: 'B', label: '070-1', segs: [
    { title: '303', station: '彰化', toStation: '台北', dep: 990, arr: 1060 },
    { title: '321', station: '台北', toStation: '高雄', dep: 1440 + 360, arr: 1440 + 520 }   // 隔日 → crossnight
  ] },
  { name: '阿國', group: 'A', label: '071-1', segs: [
    { title: '501', station: '高雄', toStation: '嘉義', dep: 1380, arr: 1457 },
    { title: '501', station: '嘉義', toStation: '彰化', dep: 1460, arr: 1520 }
  ] },
  { name: '志明', group: 'A', label: '072-1', segs: [
    { title: '115A', station: '七堵', toStation: '基隆', dep: 462, arr: 474 }   // 時刻表查不到 → 警告
  ] },
  { name: '阿忠', group: 'D', label: '073-1', segs: [
    { title: '101', station: '彰化', toStation: '嘉義', dep: 850, arr: 910 }
  ] }
];
const STAFF = CREW.map(function (c) { return { name: c.name, group: c.group }; });

// ---------- 組頁（CSS／core／affected 全部內嵌，避免相對路徑問題） ----------
const html = fs.readFileSync(path.join(ROOT, 'docs', 'affected.html'), 'utf8');
let body = html.replace(/^[\s\S]*?<body>/, '<body>').replace(/<\/body>[\s\S]*$/, '');
body = body.split('<script src="config.js"></script>').join('');
body = body.split('<script src="affected-core.js"></script>').join('');
body = body.split('<script src="affected.js"></script>').join('');
const cssText = fs.readFileSync(path.join(ROOT, 'docs', 'affected.css'), 'utf8');
const coreText = fs.readFileSync(path.join(ROOT, 'docs', 'affected-core.js'), 'utf8');
const appText = fs.readFileSync(path.join(ROOT, 'docs', 'affected.js'), 'utf8');
const inlineCss = '<style>\n' + cssText + '\n</style>';
const inlineScripts = '<script>\n' + coreText + '\n</script>\n<script>\n' + appText + '\n</script>';

const fixtureScript = `<script>
window.__FIX__ = {
  stations: ${JSON.stringify(STATIONS)},
  trains: ${JSON.stringify(TRAINS)},
  crew: ${JSON.stringify(CREW)},
  staff: ${JSON.stringify(STAFF)}
};
</script>`;

const mockScript = `<script>
window.APP_CONFIG = { API_URL: 'mock://local', TIMETABLE_VERSION: 'test' };
window.__ERRORS__ = [];
window.onerror = function (msg, src, line) {
  window.__ERRORS__.push(msg + ' @' + line);
  var box = document.querySelector('#preview-errors');
  if (box) { box.hidden = false; box.textContent = window.__ERRORS__.join('\\n'); }
  return false;
};
(function () {
  var realFetch = window.fetch.bind(window);
  function taipeiTodayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function todayStartMs() { return new Date(taipeiTodayIso() + 'T00:00:00+08:00').getTime(); }
  function resp(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'text/plain' } }); }
  window.fetch = function (url, opts) {
    if (/timetable\\.json/.test(String(url))) {
      // timetable 由測試頁內嵌（見下方 __TT__），攔下來不走網路
      return Promise.resolve(resp(window.__TT__ENVELOPE__));
    }
    var body;
    try { body = JSON.parse(opts && opts.body || '{}'); } catch (e) { body = {}; }
    if (body.action === 'bootstrap') {
      return new Promise(function (r) {
        setTimeout(function () {
          r(resp({ ok: true, data: {
            today: taipeiTodayIso(), nowMs: Date.now(), baseDate: '2026-07-01', maxDays: 14,
            staff: window.__FIX__.staff, stations: [], stationKms: {}, groups: ['A', 'B', 'C']
          } }));
        }, 5);
      });
    }
    if (body.action === 'staffSchedule') {
      var names = (body.payload && body.payload.names) || [];
      var staffs = [];
      names.forEach(function (n) {
        var c = window.__FIX__.crew.find(function (x) { return x.name === n; });
        if (!c) return;
        staffs.push({
          staff: { name: c.name, group: c.group },
          label: c.label, kind: 'work', workName: '',
          segments: c.segs.map(function (s) {
            var t0 = todayStartMs();
            return {
              kind: 'train', title: s.title, subtitle: s.station + ' → ' + s.toStation,
              station: s.station, toStation: s.toStation,
              startMs: t0 + s.dep * 60000, endMs: t0 + s.arr * 60000,
              start: '', end: '', endDayOffset: s.arr >= 1440 ? 1 : 0
            };
          })
        });
      });
      return new Promise(function (r) {
        setTimeout(function () {
          r(resp({ ok: true, data: {
            mode: 'detail',
            days: [{ date: taipeiTodayIso(), weekday: '三', staffs: staffs }],
            missing: [],
            staffs: staffs.map(function (s) { return { name: s.staff.name, group: s.staff.group }; })
          } }));
        }, 8);
      });
    }
    return Promise.resolve(resp({ ok: false, error: 'page-test mock：未知 action ' + body.action }));
  };
})();
</script>`;

const ttScript = `<script>
// 內嵌時刻表（不走網路；分鐘數直接用）
window.__TT__ENVELOPE__ = {
  meta: {
    generatedAt: new Date().toISOString(),
    srcUpdateTime: '2026-11-24T13:51:48+08:00',
    effectiveDate: '2026-07-01', expireDate: '2026-12-31'
  },
  stations: window.__FIX__.stations,
  trains: window.__FIX__.trains
};
</script>`;

const selftestScript = `<script>
(function () {
  'use strict';
  // 自動按「查詢」（等 prefetch 完成後）
  setTimeout(function () {
    var btn = document.querySelector('#btnQuery');
    if (btn && !btn.disabled) btn.click();
  }, 1200);
  var R = [];
  function q(s) { return document.querySelector(s); }
  function T(name, cond, detail) { R.push({ name: name, ok: !!cond, detail: detail || '' }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function stats() {
    return { t: q('#statTrains').textContent, c: q('#statCrew').textContent, s: q('#statShort').textContent };
  }
  function chainText() { return (q('#chainBox').textContent || '').replace(/\\s+/g, ''); }
  function trainRows() { return document.querySelectorAll('#trainBody tr:not(.placeholder)').length; }
  function findRow(no) {
    var rows = document.querySelectorAll('#trainBody tr');
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i].querySelector('.c-no b');
      if (b && b.textContent === no) return rows[i];
    }
    return null;
  }
  function clickQuick(no, add) {
    var row = findRow(no);
    if (!row) throw new Error('找不到車次列 ' + no);
    row.querySelector('.qbtn[data-add="' + add + '"]').click();
  }
  function setVal(sel, v) {
    var el = q(sel);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setChecked(sel, v) {
    var el = q(sel);
    el.checked = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function run(done) {
    var steps = [];
    function step(name, fn) { steps.push({ name: name, fn: fn }); }

    step('頁面就緒', function () {
      T('S01 __AFFECTED_READY__', window.__AFFECTED_READY__ === true);
      T('S02 零 JS 錯誤', window.__ERRORS__.length === 0, window.__ERRORS__.join('；'));
      T('S03 時刻表 meta 已渲染', /車次 6 筆/.test(q('#ttMeta').textContent));
      T('S04 站下拉有 6 站（inStationTable）', q('#fromStation').querySelectorAll('option').length === 6);
      T('S05 預設 彰化→嘉義', q('#fromStation').selectedOptions[0].text === '彰化' && q('#toStation').selectedOptions[0].text === '嘉義');
    });
    step('自動查詢結果', function () {
      var s = stats();
      T('S06 受影響車次＝5（101/102/201/301/303）', s.t === '5', '實際 ' + s.t);
      T('S07 受影響車長＝5（小林/大華/阿美/陳強/阿忠）', s.c === '5', '實際 ' + s.c);
      T('S08 緩衝不足＝0', s.s === '0', '實際 ' + s.s);
      T('S09 301 列存在且南下（彰化→嘉義 14:00→15:00）', (function () {
        var row = findRow('301');
        return row && row.textContent.indexOf('14:00') >= 0 && row.textContent.indexOf('15:00') >= 0;
      })());
      T('S10 201 進入為推估（~14:05）', (function () {
        var row = findRow('201');
        return row && /~14:05/.test(row.innerHTML);
      })());
      T('S11 102 為北上（進入＝嘉義 14:20）', (function () {
        var row = findRow('102');
        return row && row.textContent.indexOf('北上') >= 0 && row.textContent.indexOf('14:20') >= 0;
      })());
      T('S12 無時刻表警告含 115A', (q('#warnBox').textContent || '').indexOf('115A') >= 0);
      T('S13 無時刻表警告不含 501（有時刻表）', (q('#warnBox').textContent || '').indexOf('501') < 0);
      T('S14 影響鏈有 6 個區塊（小林在 301/303 各一條）', document.querySelectorAll('.chain-block').length === 6,
        '實際 ' + document.querySelectorAll('.chain-block').length);
      T('S15 小林鏈顯示班別 067-1', chainText().indexOf('067-1') >= 0);
      T('S16 大華鏈＝當日最後一班', chainText().indexOf('當日最後一班') >= 0);
      T('S17 陳強鏈＝跨日需人工確認', chainText().indexOf('跨日，需人工確認') >= 0);
      T('S18 CSV／列印按鈕解鎖', q('#btnCsv').disabled === false && q('#btnPrint').disabled === false);
    });
    step('延誤快速鍵＋緩衝重算', function () {
      clickQuick('301', 5);          // 小林鏈：緩衝 14−5 = 9 → 不足
      T('S19 +5 後 statShort＝1', stats().s === '1', '實際 ' + stats().s);
      T('S20 小林鏈顯示緩衝 9 分（不足）', chainText().indexOf('緩衝時間9分') >= 0 && chainText().indexOf('不足') >= 0);
      T('S21 301 列延誤欄同步為 5', findRow('301').querySelector('.delay-input').value === '5');
      clickQuick('301', 10);         // 累計 15 → 緩衝 −1 → 趕不上
      T('S22 +10（累計15）後鏈顯示趕不上', chainText().indexOf('趕不上') >= 0);
      T('S23 statShort 仍＝1（不足＋趕上都計入）', stats().s === '1', '實際 ' + stats().s);
      setVal('#bufferMin', '60');    // 緩衝改了即時重算（§12）
      T('S24 緩衝 60 後 301 延誤 15 仍趕不上', chainText().indexOf('趕不上') >= 0);
      setVal('#bufferMin', '10');
      // 清除所有延誤
      q('#btnClearDelays').click();
      T('S25 清除後 statShort＝0', stats().s === '0', '實際 ' + stats().s);
      T('S26 清除後 301 延誤欄歸零', findRow('301').querySelector('.delay-input').value === '0');
      // 套用到所有篩選車次
      setVal('#bulkDelay', '20');
      q('#btnApplyAll').click();
      T('S27 全部套用 20 後 301/303 延誤欄皆 20', findRow('301').querySelector('.delay-input').value === '20' &&
        findRow('303').querySelector('.delay-input').value === '20');
      q('#btnClearDelays').click();
    });
    step('推估開關／只看不足', function () {
      setChecked('#includePass', false);   // 201 排除
      T('S28 不含推估 → 車次＝4', stats().t === '4', '實際 ' + stats().t);
      T('S29 不含推估 → 車長＝4（阿美移除）', stats().c === '4', '實際 ' + stats().c);
      setChecked('#includePass', true);
      T('S30 恢復推估 → 車次＝5', stats().t === '5', '實際 ' + stats().t);
      clickQuick('301', 10);               // 只延誤 301 → 小林鏈：緩衝 14−10=4 → 不足
      setChecked('#onlyShort', true);
      T('S31 只看不足 → 影響鏈 1 個區塊（小林）', document.querySelectorAll('.chain-block').length === 1 &&
        chainText().indexOf('小林') >= 0,
        '實際 ' + document.querySelectorAll('.chain-block').length);
      setChecked('#onlyShort', false);
      q('#btnClearDelays').click();
    });
    step('localStorage 情境', function () {
      var raw = null;
      try { raw = localStorage.getItem('crew-schedule:affected:v1'); } catch (e) {}
      T('S32 情境已存 localStorage', !!raw);
      var sc = null;
      try { sc = JSON.parse(raw); } catch (e) {}
      T('S33 情境含 buffer/delays/from/to', !!(sc && sc.buffer != null && sc.delays && sc.from && sc.to));
      T('S34 情境日期＝今天', !!(sc && sc.date === q('#dateLine').textContent.match(/(\\d{4})\\/(\\d{2})\\/(\\d{2})/)[0].split('/').join('-')));
    });

    var i = 0;
    function next() {
      if (i >= steps.length) { finish(); return; }
      var st = steps[i++];
      try { st.fn(); } catch (e) { T(st.name + '（步驟執行）', false, e.message); }
      setTimeout(next, 30);
    }
    function finish() {
      var pass = 0, fail = 0, lines = [];
      R.forEach(function (r) {
        if (r.ok) { pass++; lines.push('PASS  ' + r.name); }
        else { fail++; lines.push('FAIL  ' + r.name + (r.detail ? '　→ ' + r.detail : '')); }
      });
      var box = document.createElement('div');
      box.id = 'selftest';
      box.innerHTML = '<div id="selftest-summary">' + pass + ' PASS / ' + fail + ' FAIL</div><pre>' +
        lines.map(function (l) { return l.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }).join('\\n') + '</pre>';
      document.body.appendChild(box);
      document.title = fail === 0 && window.__ERRORS__.length === 0 ? 'AFF PAGE ALL PASSED' : 'AFF PAGE FAILED';
      if (done) done();
    }
    setTimeout(next, 1600);   // 等 fetch mock 的自動查詢完成
  }
  run();
})();
</script>`;

const out = '<!DOCTYPE html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<title>受影響列車 PAGE TEST</title>\n' + inlineCss + '\n</head>\n' +
  body + '\n' + fixtureScript + '\n' + ttScript + '\n' + mockScript + '\n' + selftestScript + '\n' +
  inlineScripts + '\n</body>\n</html>\n';
fs.writeFileSync(OUT_HTML, out, 'utf8');
console.log('built ' + OUT_HTML + ' (' + out.length + ' bytes)');

// ---------- headless Chrome ----------
if (process.argv.indexOf('--build-only') >= 0) { console.log('--build-only，不跑 Chrome'); process.exit(0); }
let dom = '';
try {
  dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
    '--window-size=500,900', '--virtual-time-budget=45000', '--dump-dom',
    'file:///' + OUT_HTML.split('\\').join('/')
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(DOM_OUT, dom, 'utf8');
} catch (e) {
  console.error('Chrome 執行失敗：' + e.message);
  process.exit(1);
}

// ---------- 檢查 ----------
// 注意：selftest 的原始碼也在 dump 裡，summary 只認「數字 PASS / 數字 FAIL」的渲染版
const title = (/<title>([^<]*)<\/title>/.exec(dom) || [])[1] || '';
const summary = (/<div id="selftest-summary">(\d+ PASS \/ \d+ FAIL)<\/div>/.exec(dom) || [])[1] || '';
const fails = (dom.match(/FAIL  /g) || []).length;
console.log('title=' + title);
console.log('summary=' + summary);
const preAll = dom.match(/<pre>([\s\S]*?)<\/pre>/g) || [];
const selftestBlock = preAll.length ? preAll[preAll.length - 1] : '';
if (fails > 0) {
  console.log('--- failures ---');
  selftestBlock.split('\n').forEach(function (l) { if (l.indexOf('FAIL') === 0) console.log(l); });
}
const okAll = title === 'AFF PAGE ALL PASSED';
console.log(okAll ? 'AFF PAGE ALL PASSED' : 'AFF PAGE NOT PASSED');
process.exit(okAll ? 0 : 1);
