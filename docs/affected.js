(function () {
  'use strict';

  // ============================================================
  // 受影響列車（主管用獨立頁）——docs/affected.js
  // 規格：affected-plan.md（§5 計算流程、§12 UI）
  // 純邏輯在 docs/affected-core.js（window.AFFECTED_CORE，Node 可測）。
  // 三層模型：
  //   L1 篩選：哪些列車在時段內經過 A–B（timetable.json 停靠序列＋內插）
  //   L2 對人：這些車上，本段哪些車長在車上（staffSchedule 當日 segments）
  //   L3 傳播：延誤＋N 分，車長後續班次受影響嗎（緩衝時間檢查）
  // 此頁不進 LIFF、不從首頁連結，只給書籤。
  // CORS 限制：GAS 只收 text/plain 簡單請求——api() 與 docs/app.js 同模式，
  // 錯誤走 { ok, data | error } envelope，不能只看 response.ok。
  // ============================================================

  var CFG = window.APP_CONFIG || {};
  var CORE = window.AFFECTED_CORE;
  var API_URL = CFG.API_URL || '';
  // timetable.json 的 cache-busting：tools/build-timetable.js 重新產生時，
  // 同步更新 config.js 的 TIMETABLE_VERSION（§9）
  var TT_VERSION = CFG.TIMETABLE_VERSION || '';
  var TT_URL = 'data/timetable.json' + (TT_VERSION ? '?v=' + encodeURIComponent(TT_VERSION) : '');

  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  var DEFAULTS = { timeFrom: '14:00', timeTo: '16:00', buffer: 10, from: '彰化', to: '嘉義' };
  var STAFF_BATCH = 10;          // staffSchedule names[] 一次最多 10 人（§5 Step 1）
  var STAFF_CONCURRENCY = 4;     // 批次並行數
  var SCENARIO_KEY = 'crew-schedule:affected:v1';
  var TIME_TOLERANCE = 2;        // 時刻表 vs 班表時間容差（分，§6.4 警告用）

  // 選擇器助手：刻意命名 q／qa，不用 $／$$（AGENTS.md 教訓 1：同名助手折疊會靜默爆炸）
  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ============================================================
  // 狀態
  // ============================================================
  var state = {
    today: todayIso(),        // 台北時區當日（bootstrap 回來後改以伺服器為準）
    tt: null,                 // timetable.json：{ meta, stations, trains }
    ttError: '',
    index: null,              // { posById, nameToId }（core 站索引）
    mode: 'section',          // 'section' 起訖區間｜'train' 指定車次
    trainNo: '',              // 指定車次：解析後的車次 key
    trainInput: '',           // 指定車次：使用者輸入原文
    trainDelayInput: 0,       // 指定車次：本車延誤輸入
    trainMatchNote: '',       // 指定車次：自動對到 A/B 腿的提示
    from: '', to: '',
    timeFrom: DEFAULTS.timeFrom, timeTo: DEFAULTS.timeTo,
    direction: 'both',
    buffer: DEFAULTS.buffer,
    includePass: true,
    onlyShort: false,
    delays: {},               // 車次 no → 延誤分（L3）
    crew: null,               // { date, segments[], byTrain, byStaff, labels, batchErrors }
    crewLoading: false,
    results: null
  };
  var comboFrom = null, comboTo = null;

  // ============================================================
  // 小工具（轉接 core）
  // ============================================================
  function todayIso() {
    // 只查當日（台灣時間）——頁面在任意時區開啟都以台北日曆日為準
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    } catch (e) {
      var d = new Date();
      return d.getFullYear() + '-' + CORE.pad2(d.getMonth() + 1) + '-' + CORE.pad2(d.getDate());
    }
  }
  function parseHM(s) { return CORE.parseHM(s); }
  function fmtMin(min) { return CORE.fmtMin(min); }
  function normStn(s) { return CORE.normStn(s); }
  function todayStartMs() {
    return new Date(state.today + 'T00:00:00+08:00').getTime();
  }
  // epoch ms → 營運日 00:00 起算分鐘數（跨夜 >1440）
  function minOfDay(ms) {
    return Math.round((ms - todayStartMs()) / 60000);
  }
  function stopName(id) {
    if (!state.tt) return id;
    var list = state.tt.stations;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i].name;
    }
    return id;
  }

  // ============================================================
  // API（與 docs/app.js 同模式的 text/plain 簡單請求）
  // ============================================================
  function api(action, payload) {
    if (!API_URL) {
      return Promise.reject(new Error('尚未設定 API_URL，請檢查 docs/config.js。'));
    }
    return fetch(API_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, payload: payload || {} })
    }).then(function (res) {
      if (!res.ok) throw new Error('API HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('API 回傳非 JSON，請確認 API_URL 與 GAS 部署權限。');
      }
      if (data && data.ok) return data.data;
      throw new Error((data && data.error) || 'API 回應格式錯誤');
    });
  }

  // ============================================================
  // 時刻表載入（timetable.json 為同源靜態檔，非 GAS envelope）
  // ============================================================
  function loadTimetable() {
    return fetch(TT_URL).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (tt) {
      if (!tt || !tt.meta || !Array.isArray(tt.stations) || !Array.isArray(tt.trains)) {
        throw new Error('timetable.json 格式錯誤（缺 meta／stations／trains）');
      }
      state.tt = tt;
      state.ttError = '';
      state.index = CORE.makeIndex(tt.stations);
    }).catch(function (e) {
      state.tt = null;
      state.ttError = '無法讀取 data/timetable.json（' + e.message + '）。' +
        '時刻表尚未部署或網路異常；本頁需要時刻表才能篩選車次。';
    });
  }

  // 區間下拉：主線基隆(0900)～枋寮(5120)沿線各站（TDX 站碼範圍），
  // 不是只列班表出現過的站（2026/11/26 使用者定案：起訖站要整條營運線，
  // 含員林、台北、台南等沒人上下車的中途站；東部幹線 7000+ 不列）。
  // §9 原規劃「只用 Station 表的站」由此取代；inStationTable 欄位保留在資料裡供日後使用。
  var CORRIDOR_ID_MIN = '0900';
  var CORRIDOR_ID_MAX = '5120';
  function corridorStations() {
    if (!state.tt) return [];
    return state.tt.stations.filter(function (s) {
      return s.id >= CORRIDOR_ID_MIN && s.id <= CORRIDOR_ID_MAX;
    }).slice().sort(function (a, b) { return a.pos - b.pos; });
  }

  // 起訖站自刻 combobox：點一下列全部（131 站）、打字過濾（台北→臺北）、站碼可搜、
  // 鍵盤／ARIA／IME 完整。站名正規化與比對在 core（Node 可測）。
  function highlightStation(name, query) {
    var n = CORE.normStn(name);
    var qtext = CORE.normStn(query);
    if (!qtext) return esc(name);
    var i = n.indexOf(qtext);
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + qtext.length)) + '</mark>' +
      esc(name.slice(i + qtext.length));
  }

  function createCombo(opts) {
    var input = q(opts.input);
    var hidden = q(opts.hidden);
    var listEl = q(opts.list);
    var stations = [];
    var matches = [];
    var active = -1;
    var isOpen = false;
    var composing = false;
    var setting = false;
    var lastValid = null;

    function render() {
      if (!isOpen) return;
      var html = matches.map(function (s, i) {
        var cls = 'combo-opt' + (i === active ? ' active' : '') + (hidden.value === s.id ? ' selected' : '');
        return '<li id="' + esc(listEl.id) + '-opt-' + i + '" class="' + cls + '" role="option"' +
          ' aria-selected="' + (hidden.value === s.id ? 'true' : 'false') + '"' +
          ' data-id="' + esc(s.id) + '" data-index="' + i + '">' +
          '<span class="combo-name">' + highlightStation(s.name, input.value) + '</span>' +
          '<span class="combo-code">' + esc(s.id) + '</span></li>';
      }).join('');
      if (!matches.length) html = '<li class="combo-empty" role="presentation">查無站名</li>';
      listEl.innerHTML = html;
      listEl.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (active >= 0 && matches[active]) {
        input.setAttribute('aria-activedescendant', listEl.id + '-opt-' + active);
        var el = q('#' + listEl.id + '-opt-' + active);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    // all=true：點一下／聚焦時列出全部（需求）；打字時才依輸入過濾
    function openList(all) {
      if (!stations.length) return;
      matches = CORE.filterStations(stations, all ? '' : input.value);
      active = matches.length ? 0 : -1;
      if (hidden.value) {
        for (var i = 0; i < matches.length; i++) {
          if (matches[i].id === hidden.value) { active = i; break; }
        }
      }
      isOpen = true;
      render();
    }

    function closeList() {
      isOpen = false;
      listEl.hidden = true;
      listEl.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }

    function setValue(id) {
      var st = null;
      for (var i = 0; i < stations.length; i++) {
        if (stations[i].id === id) { st = stations[i]; break; }
      }
      if (!st) return false;
      setting = true;
      hidden.value = st.id;
      input.value = st.name;
      lastValid = { id: st.id, name: st.name };
      setting = false;
      closeList();
      return true;
    }

    function resolveTyped() {
      if (hidden.value) return hidden.value;
      var st = CORE.resolveStation(stations, input.value);
      if (st) {
        setValue(st.id);
        if (opts.onSelect) opts.onSelect(st);
        return st.id;
      }
      return '';
    }

    function selectIndex(i) {
      if (i < 0 || i >= matches.length) return;
      var st = matches[i];
      setValue(st.id);
      if (opts.onSelect) opts.onSelect(st);
    }

    function onInput() {
      if (setting) return;
      hidden.value = '';
      openList(false);
    }

    function onFocus() {
      if (!isOpen) openList(true);
    }

    function onKeyDown(e) {
      if (composing) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isOpen) openList(!!hidden.value);
        else if (matches.length) { active = (active + 1) % matches.length; render(); }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) openList(!!hidden.value);
        else if (matches.length) { active = (active - 1 + matches.length) % matches.length; render(); }
      } else if (e.key === 'Enter') {
        if (isOpen && active >= 0) {
          e.preventDefault();
          selectIndex(active);
        } else {
          var id = resolveTyped();
          if (id) e.preventDefault();
        }
      } else if (e.key === 'Escape') {
        if (isOpen) {
          e.preventDefault();
          closeList();
          if (lastValid) {
            setting = true;
            input.value = lastValid.name;
            hidden.value = lastValid.id;
            setting = false;
          }
        }
      } else if (e.key === 'Tab') {
        closeList();
        resolveTyped();
      } else if (e.key === 'Home' && isOpen) {
        e.preventDefault(); active = 0; render();
      } else if (e.key === 'End' && isOpen) {
        e.preventDefault(); active = matches.length - 1; render();
      }
    }

    function onBlur() {
      setTimeout(function () {
        if (document.activeElement === input) return;
        closeList();
        if (hidden.value) return;
        var st = CORE.resolveStation(stations, input.value);
        if (st) {
          setValue(st.id);
          if (opts.onSelect) opts.onSelect(st);
        } else if (lastValid) {
          setting = true;
          input.value = lastValid.name;
          hidden.value = lastValid.id;
          setting = false;
        }
      }, 0);
    }

    input.addEventListener('input', onInput);
    input.addEventListener('focus', onFocus);
    input.addEventListener('click', function () { if (!isOpen) openList(true); });
    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('blur', onBlur);
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; onInput(); });
    listEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
    listEl.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el !== listEl && !el.getAttribute('data-index')) el = el.parentNode;
      if (!el || el === listEl) return;
      selectIndex(Number(el.getAttribute('data-index')));
    });
    document.addEventListener('mousedown', function (e) {
      if (isOpen && !listEl.contains(e.target) && e.target !== input) closeList();
    });

    return {
      setStations: function (list) { stations = (list || []).slice(); },
      setValue: setValue,
      getValue: function () { return hidden.value; },
      getText: function () { return input.value; },
      resolveTyped: resolveTyped,
      close: closeList
    };
  }

  // 預設起訖：偏好 彰化→嘉義；否則第一站→最後一站
  function defaultStationIds() {
    var list = corridorStations();
    if (!list.length) return null;
    var byName = {};
    list.forEach(function (s) { byName[normStn(s.name)] = s; });
    var dFrom = byName[normStn(DEFAULTS.from)] || list[0];
    var dTo = byName[normStn(DEFAULTS.to)] || list[list.length - 1];
    if (dFrom.id === dTo.id && list.length > 1) dTo = list[list.length - 1];
    return { from: dFrom.id, to: dTo.id };
  }

  function initStationCombos() {
    var list = corridorStations();
    var fromInput = q('#fromStation');
    var toInput = q('#toStation');
    if (!list.length) {
      fromInput.placeholder = '（無站點資料）';
      toInput.placeholder = '（無站點資料）';
      return;
    }
    comboFrom = createCombo({
      input: '#fromStation', hidden: '#fromStationId', list: '#fromList',
      onSelect: function (st) { state.from = st.id; saveScenario(); }
    });
    comboTo = createCombo({
      input: '#toStation', hidden: '#toStationId', list: '#toList',
      onSelect: function (st) { state.to = st.id; saveScenario(); }
    });
    comboFrom.setStations(list);
    comboTo.setStations(list);
    fromInput.disabled = false;
    toInput.disabled = false;
    var d = defaultStationIds();
    comboFrom.setValue(d.from);
    comboTo.setValue(d.to);
    state.from = d.from;
    state.to = d.to;
  }

  // ============================================================
  // 情境（延誤等）存 localStorage（§11：不上傳、無伺服器狀態）
  // ============================================================
  function loadScenario() {
    try {
      var raw = localStorage.getItem(SCENARIO_KEY);
      if (!raw) return;
      var sc = JSON.parse(raw);
      if (!sc || sc.date !== state.today) return;   // 換天＝新情境
      if (sc.delays && typeof sc.delays === 'object') state.delays = sc.delays;
      if (sc.buffer != null) state.buffer = sc.buffer;
      if (sc.from) state.from = sc.from;
      if (sc.to) state.to = sc.to;
      if (sc.timeFrom) state.timeFrom = sc.timeFrom;
      if (sc.timeTo) state.timeTo = sc.timeTo;
      if (sc.direction === 'south') state.direction = 'reverse';
      else if (sc.direction === 'north') state.direction = 'forward';
      else if (sc.direction) state.direction = sc.direction;
      if (sc.includePass != null) state.includePass = sc.includePass;
      if (sc.onlyShort != null) state.onlyShort = sc.onlyShort;
      if (sc.mode === 'section' || sc.mode === 'train') state.mode = sc.mode;
      if (sc.trainInput) state.trainInput = sc.trainInput;
      if (sc.trainNo) state.trainNo = sc.trainNo;
      if (sc.trainDelayInput != null) state.trainDelayInput = sc.trainDelayInput;
    } catch (e) { /* 情境壞了就當沒有 */ }
  }
  function saveScenario() {
    try {
      localStorage.setItem(SCENARIO_KEY, JSON.stringify({
        date: state.today,
        delays: state.delays,
        buffer: state.buffer,
        from: state.from, to: state.to,
        timeFrom: state.timeFrom, timeTo: state.timeTo,
        direction: state.direction,
        includePass: state.includePass,
        onlyShort: state.onlyShort,
        mode: state.mode,
        trainNo: state.trainNo,
        trainInput: state.trainInput,
        trainDelayInput: state.trainDelayInput
      }));
    } catch (e) { /* 隱私模式等：存不進就算了 */ }
  }

  // ============================================================
  // 當日車長班表（§5 Step 1：bootstrap ＋ staffSchedule 分批）
  // ============================================================
  function loadCrewSegments(onProgress) {
    if (state.crew && state.crew.date === state.today) return Promise.resolve(state.crew);
    if (state.crewLoading) return state.crewLoading;
    state.crewLoading = (function () {
      var segments = [];
      var labels = {};
      var dateUsed = state.today;
      return api('bootstrap', {}).then(function (boot) {
        if (boot && boot.today) dateUsed = boot.today;
        var names = (boot.staff || []).map(function (s) { return s.name; });
        if (state.today !== dateUsed) {
          state.today = dateUsed;
          renderDateLine();
        }
        // 分批（每批 10 人），並行度 4
        var batches = [];
        for (var i = 0; i < names.length; i += STAFF_BATCH) {
          batches.push(names.slice(i, i + STAFF_BATCH));
        }
        var done = 0;
        var errors = [];
        function runBatch(batch) {
          return api('staffSchedule', {
            names: batch, mode: 'detail', dates: [dateUsed]
          }).then(function (res) {
            (res.days || []).forEach(function (day) {
              (day.staffs || []).forEach(function (view) {
                var staff = view.staff || {};
                if (staff.name) {
                  labels[staff.group + '\u0000' + staff.name] = view.label || view.workName || '';
                }
                (view.segments || []).forEach(function (seg) {
                  if (seg.kind !== 'train') return;
                  segments.push({
                    name: staff.name || '',
                    group: staff.group || '',
                    title: String(seg.title || ''),
                    station: String(seg.station || ''),
                    toStation: String(seg.toStation || ''),
                    startMs: seg.startMs,
                    endMs: seg.endMs
                  });
                });
              });
            });
          }).catch(function (e) {
            errors.push(batch.join('、') + '：' + e.message);
          }).then(function () {
            done++;
            if (onProgress) onProgress(done, batches.length, errors);
          });
        }
        // 簡單 promise pool
        var cursor = 0;
        function worker() {
          if (cursor >= batches.length) return Promise.resolve();
          var b = batches[cursor++];
          return runBatch(b).then(worker);
        }
        var pool = [];
        for (var w = 0; w < STAFF_CONCURRENCY; w++) pool.push(worker());
        return Promise.all(pool).then(function () {
          if (errors.length && !segments.length) {
            throw new Error('staffSchedule 全部批次失敗：' + errors[0]);
          }
          segments.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
          var byTrain = {};
          var byStaff = {};
          segments.forEach(function (seg) {
            var no = CORE.normalizeTrainNo(seg.title);
            (byTrain[no] = byTrain[no] || []).push(seg);
            var key = seg.group + '\u0000' + seg.name;
            (byStaff[key] = byStaff[key] || []).push(seg);
          });
          state.crew = {
            date: dateUsed,
            segments: segments,
            byTrain: byTrain,
            byStaff: byStaff,
            labels: labels,
            batchErrors: errors
          };
          return state.crew;
        });
      }).then(function (crew) {
        state.crewLoading = false;
        return crew;
      }, function (e) {
        state.crewLoading = false;
        throw e;
      });
    }());
    return state.crewLoading;
  }

  // ============================================================
  // L1：列車在 [fromId, toId] 區間的進入／離開（轉接 core）
  // ============================================================
  function traverseSection(train) {
    return CORE.traverseSection(train, state.from, state.to, state.index.posById, stopName);
  }

  // ============================================================
  // 查詢主流程（bootstrap／staffSchedule 載入後全在本地計算）
  // ============================================================
  function readForm() {
    state.mode = q('input[name="queryMode"]:checked').value;
    var buf = parseInt(q('#bufferMin').value, 10);
    state.buffer = (isNaN(buf) || buf < 0) ? 0 : (buf > 120 ? 120 : buf);
    state.onlyShort = q('#onlyShort').checked;
    if (state.mode === 'train') {
      state.trainInput = q('#trainNo').value;
      var td = parseInt(q('#trainDelay').value, 10);
      state.trainDelayInput = (isNaN(td) || td < 0) ? 0 : (td > 600 ? 600 : td);
      return;
    }
    state.from = comboFrom ? comboFrom.resolveTyped() : q('#fromStationId').value;
    state.to = comboTo ? comboTo.resolveTyped() : q('#toStationId').value;
    state.timeFrom = q('#timeFrom').value || DEFAULTS.timeFrom;
    state.timeTo = q('#timeTo').value || DEFAULTS.timeTo;
    state.direction = q('#direction').value;
    state.includePass = q('#includePass').checked;
  }

  function validateForm() {
    var problems = [];
    if (!state.tt) problems.push('時刻表未載入');
    if (state.mode === 'train') {
      if (!state.trainInput || !state.trainInput.trim()) problems.push('請輸入車次');
      return problems;
    }
    if (!state.from || !state.to) problems.push('請選擇起站與迄站');
    if (state.from && state.from === state.to) problems.push('起站與迄站不能相同');
    var t1 = parseHM(state.timeFrom);
    var t2 = parseHM(state.timeTo);
    if (t1 == null || t2 == null || t1 >= t2) problems.push('時段起必須早於時段迄');
    return problems;
  }

  // 指定車次：把輸入解析成今日班表的車次 key；查無／ambiguous 回 error
  function resolveTrainForQuery() {
    var keys = Object.keys(state.crew.byTrain);
    var r = CORE.resolveTrainNo(state.trainInput, keys);
    if (r.rule === 'empty') return { error: '請輸入車次。' };
    if (r.rule === 'ambiguous') {
      return { error: '今日有多個相近車次：' + r.candidates.join('、') + '，請輸入完整車次。' };
    }
    if (r.rule === 'notfound') {
      var inTt = state.tt && state.tt.trains.some(function (t) { return t.no === r.query; });
      if (inTt) return { error: '車次 ' + r.query + ' 今日沒有車長值乘。' };
      return { error: '今日班表查無車次 ' + r.query + '。' };
    }
    var note = '';
    if (r.rule === 'suffix') note = '已自動對到車次 ' + r.key + '（輸入 ' + r.query + '）。';
    return { no: r.key, note: note };
  }

  function populateTrainDatalist() {
    var el = q('#trainNoList');
    if (!el || !state.crew) return;
    el.innerHTML = Object.keys(state.crew.byTrain).sort().map(function (no) {
      return '<option value="' + esc(no) + '"></option>';
    }).join('');
  }

  function runQuery() {
    readForm();
    saveScenario();
    var problems = validateForm();
    if (problems.length) {
      setWarn(['查詢條件有誤：' + problems.join('；')], false);
      return;
    }
    setWarn([]);
    q('#btnQuery').disabled = true;
    setStatus('載入當日班表中…');
    loadCrewSegments(function (done, total) {
      setStatus('載入當日班表中… ' + done + '/' + total + ' 批');
    }).then(function () {
      setStatus('');
      if (state.mode === 'train') {
        var r = resolveTrainForQuery();
        if (r.error) { setWarn([r.error], false); return; }
        state.trainNo = r.no;
        state.trainMatchNote = r.note || '';
        if (state.trainDelayInput > 0) state.delays[r.no] = state.trainDelayInput;
        else delete state.delays[r.no];
        saveScenario();
      }
      computeAndRender();
    }).catch(function (e) {
      setStatus('');
      setWarn(['無法取得當日班表：' + e.message], true);
    }).then(function () {
      q('#btnQuery').disabled = false;
    });
  }

  function computeAndRender() {
    state.results = state.mode === 'train' ? computeTrainResults() : computeResults();
    renderTrains();
    renderChains();
    renderStats();
    renderWarnings();
  }

  // ------------------------------------------------------------
  // 計算：L1 篩選 → L2 對人 → L3 影響鏈（§5）
  // ------------------------------------------------------------
  function computeResults() {
    var tt = state.tt;
    var crew = state.crew;
    var t1 = parseHM(state.timeFrom);
    var t2 = parseHM(state.timeTo);
    var warnings = [];
    var noTimetable = {};    // 班表有值乘但時刻表查不到（§13：不列入，提示）
    var trainsOut = [];

    if (!crew) return { trains: [], chains: [], warnings: warnings, noTimetable: [], stats: { trains: 0, crew: 0, short: 0 } };

    var trainByNo = {};
    tt.trains.forEach(function (t) { if (!trainByNo[t.no]) trainByNo[t.no] = t; });

    // 母體：當日班表出現的車次（正規化後；§2 只算當日 Schedule_S 有值乘的車次）
    var nosToday = {};
    Object.keys(crew.byTrain).forEach(function (no) { nosToday[no] = true; });

    Object.keys(nosToday).forEach(function (no) {
      var train = trainByNo[no];
      if (!train) return;   // §13：查不到 → 不列入（noTimetable 提示）
      var tv = traverseSection(train);
      if (!tv) return;      // 不經過該區間
      // 方向篩選（§12）：forward＝順向（北上）、reverse＝逆向（南下）
      if (state.direction === 'reverse' && !tv.south) return;
      if (state.direction === 'forward' && tv.south) return;
      // 時段重疊：進入 < 時段迄 && 離開 > 時段起（§5 Step 2.4）
      if (!(tv.enter < t2 && tv.exit > t1)) return;
      // 推估開關（§7.5）
      if (!state.includePass && (!tv.enterStop || !tv.exitStop)) return;

      // L2：值乘車長（§5 Step 3）
      var riders = [];
      (crew.byTrain[no] || []).forEach(function (seg) {
        var st = CORE.classifyRider(seg, tv, state.index, state.from, state.to);
        riders.push({ seg: seg, affected: st.affected, delayOn: st.delayOn, unknownStation: !!st.unknownStation });
      });

      // 2026/11/27 使用者定案：全車沒有任何受影響車長（且無需人工確認）→ 整列不列，
      // 不再顯示「（無）」。例：554 的車長只便乘潮州→屏東，彰化–嘉義與他無關且無後續值乘。
      var anyAffected = riders.some(function (r) { return r.affected || r.unknownStation; });
      if (!anyAffected) return;

      // §6.4 時間不一致警告：只對列出的車次檢查
      riders.forEach(function (r) { checkTimeMismatch(train, r.seg, warnings); });

      // 狀態（§6.5、§7.5）：推估＋時段邊界切進區間 → 可能受影響
      var status = 'normal';
      if (!tv.enterStop || !tv.exitStop) {
        status = 'pass';
        var b1 = t1 > tv.enter && t1 < tv.exit;
        var b2 = t2 > tv.enter && t2 < tv.exit;
        if (b1 || b2) status = 'possible';
      }
      trainsOut.push({
        train: train, tv: tv, riders: riders, status: status,
        delay: Number(state.delays[no]) || 0
      });
    });

    // 無時刻表車次（顯示班表原始車次字串，較易辨認）
    Object.keys(crew.byTrain).forEach(function (no) {
      if (trainByNo[no]) return;
      (crew.byTrain[no] || []).forEach(function (seg) {
        var title = String(seg.title || '').trim() || no;
        noTimetable[title] = true;
      });
    });

    trainsOut.sort(function (a, b) { return a.tv.enter - b.tv.enter || a.train.no.localeCompare(b.train.no); });

    // L3：影響鏈（§5 Step 4）
    var chains = [];
    var crewAffected = {};
    var shortCount = 0;
    trainsOut.forEach(function (item) {
      item.riders.forEach(function (rider) {
        if (!rider.affected) return;
        crewAffected[rider.seg.group + '\u0000' + rider.seg.name] = true;
        chains.push(buildChain(item, rider));
      });
    });
    chains.sort(function (a, b) {
      return a.name.localeCompare(b.name, 'zh-Hant') ||
        a.group.localeCompare(b.group) ||
        a.enter - b.enter;
    });
    chains.forEach(function (c) {
      if (c.next && (c.next.status === 'short' || c.next.status === 'missed')) shortCount++;
    });

    return {
      trains: trainsOut,
      chains: chains,
      warnings: warnings,
      noTimetable: Object.keys(noTimetable).sort(),
      stats: {
        trains: trainsOut.length,
        crew: Object.keys(crewAffected).length,
        short: shortCount
      }
    };
  }

  // 指定車次：整趟車次的值乘腿＋每位車長的下一個班（完整影響鏈）
  // v1 假設整趟延誤 D 分（所有腿一起延後）；每位車長只追下一個班一層。
  function computeTrainResults() {
    var crew = state.crew;
    var no = state.trainNo;
    var warnings = [];
    var ttTrain = null;
    state.tt.trains.forEach(function (t) { if (t.no === no) ttTrain = t; });
    var ordered = CORE.orderLegs((crew.byTrain[no] || []).slice());
    var delay = Number(state.delays[no]) || 0;
    var legs = [], chains = [], crewSeen = {};
    var shortCount = 0;
    ordered.forEach(function (item, i) {
      var seg = item.seg;
      var list = crew.byStaff[seg.group + '\u0000' + seg.name] || [];
      var idx = list.indexOf(seg);
      var nextRaw = idx >= 0 ? list[idx + 1] : null;
      var core = CORE.buildChain({
        seg: segToMin(seg), trainNo: no, delay: delay, delayOn: 'alighting',
        next: nextRaw ? segToMin(nextRaw) : null,
        delays: state.delays, threshold: state.buffer
      });
      var label = crew.labels[seg.group + '\u0000' + seg.name] || '';
      var handoverBefore = i > 0 ? ordered[i - 1].handover : null;
      var chain = {
        name: seg.name, group: seg.group, label: label,
        trainNo: no, delay: delay,
        section: seg.station + '→' + seg.toStation,
        station: seg.station, toStation: seg.toStation,
        dep: core.dep, arr: core.arr, delayOn: 'alighting',
        arrNew: core.arrNew, nextSeg: core.nextSeg || null, next: core.next,
        enter: core.dep, legIndex: i, handoverBefore: handoverBefore
      };
      chains.push(chain);
      legs.push({
        seg: seg, train: ttTrain, south: legSouth(seg), delay: delay, label: label,
        handover: item.handover, handoverBefore: handoverBefore, chain: chain
      });
      crewSeen[seg.group + '\u0000' + seg.name] = true;
      if (chain.next && (chain.next.status === 'short' || chain.next.status === 'missed')) shortCount++;
      if (ttTrain) checkTimeMismatch(ttTrain, seg, warnings);
    });
    return {
      mode: 'train', trainNo: no, train: ttTrain, legs: legs, chains: chains,
      warnings: warnings,
      noTimetable: ttTrain ? [] : [no],
      matchNote: state.trainMatchNote || '',
      stats: { trains: legs.length, crew: Object.keys(crewSeen).length, short: shortCount }
    };
  }

  // §6.4：時刻表與班表時間不一致 → 警告（接駁以班表時間為基準）
  function checkTimeMismatch(train, seg, warnings) {
    var idUp = state.index.nameToId[normStn(seg.station)];
    var idDown = state.index.nameToId[normStn(seg.toStation)];
    var iUp = -1, iDown = -1;
    train.stops.forEach(function (s, i) {
      if (s[0] === idUp && iUp < 0) iUp = i;
      if (s[0] === idDown && iDown < 0) iDown = i;
    });
    if (iUp < 0 || iDown < 0 || iDown <= iUp) {
      warnings.push('車次 ' + train.no + '：' + seg.name + '（' + seg.group + '）的 ' +
        seg.station + '→' + seg.toStation + ' 對不上時刻表停靠序，請人工確認。');
      return;
    }
    var ttDep = train.stops[iUp][2];
    var ttArr = train.stops[iDown][1];
    var segDep = minOfDay(seg.startMs);
    var segArr = minOfDay(seg.endMs);
    if (Math.abs(ttDep - segDep) > TIME_TOLERANCE || Math.abs(ttArr - segArr) > TIME_TOLERANCE) {
      warnings.push('車次 ' + train.no + ' ' + seg.name + '（' + seg.group + '）：班表 ' +
        fmtMin(segDep) + '-' + fmtMin(segArr) + ' vs 時刻表 ' + fmtMin(ttDep) + '-' + fmtMin(ttArr) +
        '，不一致——接駁以班表時間為基準。');
    }
  }

  // segment（ms）→ 營運日分鐘數（core.buildChain 用）
  function segToMin(s) {
    return {
      title: s.title, station: s.station, toStation: s.toStation,
      dep: minOfDay(s.startMs), arr: minOfDay(s.endMs)
    };
  }

  // 指定車次：值乘腿方向用「該腿」上下車站序判定（2026/11/27），
  // 不用全車首末站（554 潮州→花蓮，但彰化–嘉義是北上）；站名對不到 → null（顯示 —）
  function legSouth(seg) {
    var idA = state.index.nameToId[normStn(seg.station)];
    var idB = state.index.nameToId[normStn(seg.toStation)];
    var pa = idA != null ? state.index.posById[idA] : null;
    var pb = idB != null ? state.index.posById[idB] : null;
    if (pa == null || pb == null || pa === pb) return null;
    return pb > pa;
  }

  // L3：單一受影響車長的影響鏈（組裝轉接 core.buildChain；§5 Step 4、§13 邊界）
  function buildChain(item, rider) {
    var seg = rider.seg;
    var no = item.train.no;
    var crew = state.crew;
    var list = crew.byStaff[seg.group + '\u0000' + seg.name] || [];
    var idx = list.indexOf(seg);
    var nextRaw = idx >= 0 ? list[idx + 1] : null;
    var core = CORE.buildChain({
      seg: segToMin(seg),
      trainNo: no,
      delay: item.delay,
      delayOn: rider.delayOn,
      next: nextRaw ? segToMin(nextRaw) : null,
      delays: state.delays,
      threshold: state.buffer
    });
    return {
      name: seg.name, group: seg.group,
      label: crew.labels[seg.group + '\u0000' + seg.name] || '',
      trainNo: no, delay: item.delay,
      section: seg.station + '→' + seg.toStation,
      dep: core.dep, arr: core.arr,
      delayOn: rider.delayOn,
      arrNew: core.arrNew,
      nextSeg: core.nextSeg || null,
      next: core.next,
      enter: item.tv.enter
    };
  }

  // ============================================================
  // 渲染
  // ============================================================
  function renderDateLine() {
    var iso = state.today.replace(/-/g, '/');
    var w = WEEKDAYS[weekdayOf(state.today)];
    q('#dateLine').innerHTML = '<b>' + esc(iso) + '（' + w + '）</b> 今日';
  }
  // 台北時區的 weekday（0=日）
  function weekdayOf(iso) {
    return new Date(iso + 'T12:00:00+08:00').getDay();
  }

  function renderTtMeta() {
    var el = q('#ttMeta');
    if (!state.tt) { el.textContent = ''; return; }
    var m = state.tt.meta;
    var src = m.srcUpdateTime ? m.srcUpdateTime.replace('T', ' ').slice(0, 16) : '';
    el.textContent = '時刻表有效期 ' + m.effectiveDate + ' ～ ' + m.expireDate +
      (src ? '｜資料時間 ' + src : '') +
      '｜站點 ' + corridorStations().length + ' 站（基隆～枋寮）／車次 ' + state.tt.trains.length + ' 筆';
  }

  function setWarn(lines, isError) {
    var box = q('#warnBox');
    if (!lines || !lines.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.className = 'warnbox' + (isError ? ' error' : '');
    box.innerHTML = lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('');
  }

  function setStatus(text) {
    q('#queryStatus').textContent = text || '';
  }

  function setStats(trains, crew, short) {
    var label = q('#statTrainsLabel');
    if (label) label.textContent = state.mode === 'train' ? '值乘腿' : '受影響車次';
    q('#statTrains').textContent = trains;
    q('#statCrew').textContent = crew;
    q('#statShort').textContent = short;
  }

  function statusBadge(item) {
    if (item.status === 'possible') return '<span class="badge warn" title="端點未停靠，時間為內插推估；時段邊界切進區間，請人工判斷">可能受影響</span>';
    if (item.status === 'pass') return '<span class="badge muted">通過（推估）</span>';
    return '<span class="badge ok">正常</span>';
  }

  function timeCell(min, isStop, approx) {
    if (isStop) return fmtMin(min);
    var tip = approx && approx.from && approx.to
      ? ' 未停靠，內插自 ' + approx.from + ' → ' + approx.to : ' 未停靠（推估）';
    return '<span class="approx" title="' + esc('~' + fmtMin(min) + tip) + '">~' + fmtMin(min) + '</span>';
  }

  function renderTrains() {
    var res = state.results;
    var body = q('#trainBody');
    var summary = q('#trainSummary');
    if (res && res.mode === 'train') { renderTrainLegs(res); return; }
    if (summary) { summary.hidden = true; summary.innerHTML = ''; }
    q('#trainCardTitle').textContent = '▌車次（依進入區間時間排序）';
    if (!res || !res.trains.length) {
      body.innerHTML = '<tr class="placeholder"><td colspan="9">' +
        (res ? '此條件下沒有受影響的列車。' : '請設定條件後按「查詢」。') + '</td></tr>';
      q('#btnCsv').disabled = true;
      q('#btnPrint').disabled = true;
      return;
    }
    var rows = [];
    res.trains.forEach(function (item) {
      var t = item.train;
      rows.push('<tr>' +
        '<td class="c-no"><b>' + esc(t.no) + '</b>' +
        (t.extraTrain ? ' <span class="badge muted">加班</span>' : '') + '</td>' +
        '<td>' + esc(shortType(t.type)) + '</td>' +
        '<td>' + (item.tv.south ? '逆向' : '順向') + '</td>' +
        '<td>' + esc(stopName(t.stops[0][0]) + '→' + stopName(t.stops[t.stops.length - 1][0])) + '</td>' +
        '<td>' + timeCell(item.tv.enter, item.tv.enterStop, item.tv.approx.enter) + '</td>' +
        '<td>' + timeCell(item.tv.exit, item.tv.exitStop, item.tv.approx.exit) + '</td>' +
        '<td class="c-delay">' + delayCell(t.no, item.delay) + '</td>' +
        '<td class="c-crew">' + crewCell(item.riders, t.no) + '</td>' +
        '<td>' + statusBadge(item) + '</td>' +
        '</tr>');
    });
    body.innerHTML = rows.join('');
    bindDelayInputs();
    bindCrewLinks();
    q('#btnCsv').disabled = false;
    q('#btnPrint').disabled = false;
  }

  // 指定車次：列車摘要＋值乘腿＋交接列
  function renderTrainLegs(res) {
    var body = q('#trainBody');
    var summary = q('#trainSummary');
    q('#trainCardTitle').textContent = '▌指定車次與值乘腿';
    if (!res || !res.legs.length) {
      summary.hidden = true;
      summary.innerHTML = '';
      body.innerHTML = '<tr class="placeholder"><td colspan="9">' +
        (res ? '今日沒有這個車次的值乘資料。' : '請設定條件後按「查詢」。') + '</td></tr>';
      q('#btnCsv').disabled = true;
      q('#btnPrint').disabled = true;
      return;
    }
    var t = res.train;
    var first = res.legs[0].seg;
    var last = res.legs[res.legs.length - 1].seg;
    var type = t ? shortType(t.type) : '—';
    var dir = legsDirLabel(res.legs);
    var run = t
      ? stopName(t.stops[0][0]) + '→' + stopName(t.stops[t.stops.length - 1][0])
      : first.station + '→' + last.toStation;
    var ttTimes = t
      ? '時刻表 ' + fmtMin(t.stops[0][2]) + '→' + fmtMin(t.stops[t.stops.length - 1][1])
      : '時刻表查無此車次，使用班表時間（車種／方向僅供參考）';
    summary.innerHTML = '<div class="train-summary-main"><b>' + esc(res.trainNo) + '</b>' +
      '<span class="badge ok">' + esc(type) + '</span>' +
      '<span class="badge muted">' + esc(dir) + '</span>' +
      '<span class="train-run">' + esc(run) + '</span></div>' +
      '<div class="train-summary-sub">值乘腿 ' + res.legs.length + ' 段｜' + esc(ttTimes) +
      '｜整趟延誤 +' + Number(res.legs[0].delay || 0) + ' 分</div>';
    summary.hidden = false;

    var rows = [];
    res.legs.forEach(function (leg, i) {
      var seg = leg.seg;
      var isFirst = i === 0;
      var isLast = i === res.legs.length - 1;
      var status;
      if (isFirst) status = '<span class="badge ok">起班</span>';
      else if (leg.handoverBefore && leg.handoverBefore.sameCrew) status = '<span class="badge muted">續乘</span>';
      else status = '<span class="badge warn">接班</span>';
      if (isLast) status += ' <span class="badge muted">末腿</span>';
      var delayHtml = isFirst
        ? delayCell(res.trainNo, leg.delay)
        : (leg.delay > 0 ? '+' + leg.delay : '<span class="muted">＋0</span>');
      rows.push('<tr class="leg-row" data-leg="' + i + '">' +
        '<td class="c-no"><b>' + esc(res.trainNo) + '</b> <span class="badge muted">第 ' + (i + 1) + ' 腿</span></td>' +
        '<td>' + esc(type) + '</td>' +
        '<td>' + esc(dirLabel(leg.south)) + '</td>' +
        '<td>' + esc(seg.station + '→' + seg.toStation) + '</td>' +
        '<td>' + esc(fmtMin(leg.chain.dep)) + '</td>' +
        '<td>' + esc(fmtMin(leg.chain.arr)) + '</td>' +
        '<td class="c-delay">' + delayHtml + '</td>' +
        '<td class="c-crew"><button type="button" class="crew-link" data-train="' + esc(res.trainNo) +
          '" data-name="' + esc(seg.name) + '" data-group="' + esc(seg.group) +
          '" data-leg="' + i + '">' + esc(seg.name) + '（' + esc(seg.group) + '）</button>' +
          (leg.label ? ' <span class="badge muted">班別 ' + esc(leg.label) + '</span>' : '') + '</td>' +
        '<td>' + status + '</td>' +
        '</tr>');
      if (!isLast) {
        var h = leg.handover;
        var text;
        if (h.sameCrew) text = '同一車長續乘（' + seg.name + '）';
        else if (!h.sameStation) text = '⚠ 交接站不一致：' + seg.toStation + ' → ' + res.legs[i + 1].seg.station + '，需人工確認';
        else if (h.gapMin < 0) text = '⚠ 兩腿時間重疊 ' + Math.abs(h.gapMin) + ' 分，需人工確認';
        else if (h.gapMin > 60) text = '⚠ 兩腿間隔 ' + h.gapMin + ' 分，可能不是同一趟';
        else text = '↳ ' + seg.toStation + ' ' + fmtMin(leg.chain.arr) + '／' + fmtMin(res.legs[i + 1].chain.dep) +
          ' 交班：' + seg.group + '/' + seg.name + ' → ' + res.legs[i + 1].seg.group + '/' + res.legs[i + 1].seg.name + '（接班）';
        rows.push('<tr class="handover-row"><td colspan="9">' + esc(text) + '</td></tr>');
      }
    });
    body.innerHTML = rows.join('');
    bindDelayInputs();
    bindCrewLinks();
    q('#btnCsv').disabled = false;
    q('#btnPrint').disabled = false;
  }

  // 車種顯示：TDX 全名很長（如「自強(推拉式自強號且無自行車車廂)」）→ 取「(」前段
  function shortType(type) {
    var s = String(type || '');
    var i = s.indexOf('(');
    return i > 0 ? s.slice(0, i) : s;
  }

  // 方向顯示：south＝站序遞增（南下）→ 逆向；站名對不到 → —
  function dirLabel(south) { return south == null ? '—' : (south ? '逆向' : '順向'); }
  // 多腿摘要：全部同向顯示該方向，不同向顯示「多方向」（2026/11/27：每腿各自判方向）
  function legsDirLabel(legs) {
    if (!legs || !legs.length) return '—';
    var first = legs[0].south;
    for (var i = 1; i < legs.length; i++) {
      if (legs[i].south !== first) return '多方向';
    }
    return dirLabel(first);
  }

  function delayCell(no, delay) {
    return '<span class="delay-wrap">' +
      '<input type="number" class="delay-input" data-no="' + esc(no) + '" min="0" max="600" step="1" value="' + Number(delay || 0) + '">' +
      '<span class="quick">' +
      '<button type="button" class="qbtn" data-no="' + esc(no) + '" data-add="5">+5</button>' +
      '<button type="button" class="qbtn" data-no="' + esc(no) + '" data-add="10">+10</button>' +
      '<button type="button" class="qbtn" data-no="' + esc(no) + '" data-add="15">+15</button>' +
      '<button type="button" class="qbtn" data-no="' + esc(no) + '" data-add="30">+30</button>' +
      '</span></span>';
  }

  function crewCell(riders, trainNo) {
    // 2026/11/27 起：全車無受影響車長的車次整列不列（computeResults 過濾），
    // 這裡理論上不會收到空陣列；保險起見回空字串（不顯示「無」）
    if (!riders.length) return '';
    return riders.map(function (r) {
      var tag;
      if (r.unknownStation) tag = '<span class="badge muted" title="班表站名對不到時刻表站碼">需人工確認</span>';
      else if (!r.affected) tag = '<span class="badge muted" title="在事故區間前已下車">未受影響</span>';
      else if (r.delayOn === 'boarding') tag = '<span class="badge warn" title="上車時列車已延誤">上車延誤</span>';
      else tag = '<span class="badge hot" title="在事故區間內乘車">受影響</span>';
      // 受影響車長可點：跳到影響鏈該車長區塊（§12 操作需求）
      var namePart;
      if (r.affected && !r.unknownStation) {
        namePart = '<button type="button" class="crew-link" data-train="' + esc(trainNo) +
          '" data-name="' + esc(r.seg.name) + '" data-group="' + esc(r.seg.group) +
          '" title="跳到下方影響鏈的此車長區塊">' + esc(r.seg.name) + '（' + esc(r.seg.group) + '）</button>';
      } else {
        namePart = esc(r.seg.name) + '（' + esc(r.seg.group) + '）';
      }
      return '<div class="crew-row">' + namePart + tag + '</div>';
    }).join('');
  }

  function bindCrewLinks() {
    qa('.crew-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        jumpToChain(this.getAttribute('data-group'), this.getAttribute('data-name'),
          this.getAttribute('data-train'), this.getAttribute('data-leg'));
      });
    });
  }

  // 找影響鏈區塊：優先（車長＋車次＋腿序）完全相符，其次（車長＋車次），最後該車長第一個區塊
  function findChainBlock(group, name, trainNo, legIndex) {
    var exact = null, sameTrain = null, first = null;
    var blocks = qa('.chain-block');
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.getAttribute('data-name') !== name || b.getAttribute('data-group') !== group) continue;
      if (!first) first = b;
      if (b.getAttribute('data-train') !== trainNo) continue;
      if (!sameTrain) sameTrain = b;
      if (legIndex != null && b.getAttribute('data-leg') === String(legIndex)) {
        exact = b;
        break;
      }
    }
    return exact || sameTrain || first;
  }

  function jumpToChain(group, name, trainNo, legIndex) {
    var el = findChainBlock(group, name, trainNo, legIndex);
    if (!el && state.onlyShort) {
      // 區塊被「只看緩衝時間不足」過濾掉 → 解除過濾再找
      q('#onlyShort').checked = false;
      state.onlyShort = false;
      saveScenario();
      renderChains();
      el = findChainBlock(group, name, trainNo, legIndex);
    }
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('chain-flash');
    void el.offsetWidth;   // 強制 reflow 重啟動畫
    el.classList.add('chain-flash');
    setTimeout(function () { el.classList.remove('chain-flash'); }, 2600);
  }

  function bindDelayInputs() {
    qa('.delay-input').forEach(function (input) {
      input.addEventListener('change', function () {
        var no = this.getAttribute('data-no');
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        if (v > 600) v = 600;
        this.value = v;
        if (v > 0) state.delays[no] = v; else delete state.delays[no];
        saveScenario();
        recalcChain();
      });
    });
    qa('.qbtn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var no = this.getAttribute('data-no');
        var add = Number(this.getAttribute('data-add')) || 0;
        var cur = Number(state.delays[no]) || 0;
        var v = Math.min(600, cur + add);
        state.delays[no] = v;
        var input = q('.delay-input[data-no="' + no + '"]');
        if (input) input.value = v;
        saveScenario();
        recalcChain();
      });
    });
  }

  // 緩衝時間／延誤改了即時重算（§12：不用重新查詢）
  function recalcChain() {
    if (!state.results || !state.crew) return;
    computeAndRender();
  }

  function renderChains() {
    var res = state.results;
    var box = q('#chainBox');
    var isTrain = !!(res && res.mode === 'train');
    if (!res || !res.chains.length) {
      var hasRows = res && ((res.trains && res.trains.length) || (res.legs && res.legs.length));
      box.innerHTML = '<p class="placeholder">' +
        (hasRows ? '篩出的列車沒有受影響的車長。' : '請設定條件後按「查詢」。') + '</p>';
      return;
    }
    // 只看緩衝時間不足（§12）
    var chains = res.chains;
    if (state.onlyShort) {
      chains = chains.filter(function (c) {
        return c.next && (c.next.status === 'short' || c.next.status === 'missed');
      });
    }
    if (!chains.length) {
      box.innerHTML = '<p class="placeholder">沒有緩衝時間不足的車長。</p>';
      return;
    }
    var html = [];
    if (isTrain) {
      html.push('<p class="chain-note">依值乘腿順序；每塊＝該腿車長＋他的下一個班。整趟延誤 +' +
        Number(chains[0].delay || 0) + ' 分。</p>');
    }
    var prev = null;
    chains.forEach(function (c) {
      if (isTrain && c.handoverBefore && prev && prev.legIndex === c.legIndex - 1) {
        html.push(renderChainHandover(prev, c));
      }
      var rows = [];
      rows.push('<div class="chain-row">' +
        '<span class="chain-no">' + esc(c.trainNo) + '</span> ' +
        '<span class="chain-sec">' + esc(c.section) + '</span> ' +
        '<span class="chain-time">' + esc(fmtMin(c.dep) + '→' + fmtMin(c.arr)) + '</span>' +
        (c.delay > 0
          ? '<span class="chain-delay">+' + c.delay + ' → ' + esc(fmtMin(c.delayOn === 'boarding' ? c.dep + c.delay : c.arrNew)) +
            (c.delayOn === 'boarding' ? '（上車延後）' : '（抵達延後）') + '</span>'
          : '<span class="chain-delay muted">＋0</span>') +
        '</div>');
      var n = c.next;
      if (n.kind === 'lasttrain') {
        rows.push('<div class="chain-row sub">' +
          '<span class="chain-sec">當日最後一班</span>' +
          (c.delay > 0
            ? '<span class="chain-delay">收班 ' + esc(fmtMin(c.arr)) + ' → ' + esc(fmtMin(c.arr + c.delay)) + '（延後 ' + c.delay + ' 分）</span>'
            : '<span class="chain-delay muted">無下一班</span>') +
          '</div>');
      } else if (n.kind === 'samecontinue') {
        rows.push('<div class="chain-row sub">' +
          '<span class="chain-no">' + esc(c.nextSeg.title) + '</span> ' +
          '<span class="chain-sec">同一車次續開</span>' +
          '<span class="chain-delay">延誤直接帶入（+' + c.delay + '）</span>' +
          '</div>');
      } else if (n.kind === 'crossnight') {
        rows.push('<div class="chain-row sub">' +
          '<span class="chain-no">' + esc(c.nextSeg.title) + '</span> ' +
          '<span class="chain-sec">' + esc(c.nextSeg.station + '→' + c.nextSeg.toStation) + '</span> ' +
          '<span class="chain-time">' + esc(fmtMin(c.nextSeg.dep) + '→' + fmtMin(c.nextSeg.arr)) + '</span>' +
          '<span class="badge muted">跨日，需人工確認</span>' +
          '</div>');
      } else if (n.kind === 'difstation') {
        rows.push('<div class="chain-row sub">' +
          '<span class="chain-no">' + esc(c.nextSeg.title) + '</span> ' +
          '<span class="chain-sec">' + esc(n.detail) + '</span>' +
          '<span class="badge muted">需人工確認</span>' +
          '</div>');
      } else {
        var badge;
        if (n.status === 'missed') badge = '<span class="badge hot">⚠ 趕不上</span>';
        else if (n.status === 'short') badge = '<span class="badge warn">⚠ 不足</span>';
        else badge = '<span class="badge ok">正常</span>';
        rows.push('<div class="chain-row sub' + (n.status === 'missed' ? ' miss' : n.status === 'short' ? ' warn' : '') + '">' +
          '<span class="chain-no">' + esc(c.nextSeg.title) + '</span> ' +
          '<span class="chain-sec">' + esc(c.nextSeg.station + '→' + c.nextSeg.toStation) + '</span> ' +
          '<span class="chain-time">' + esc(fmtMin(c.nextSeg.dep) + '→' + fmtMin(c.nextSeg.arr)) +
          (n.delayNext > 0 ? '（已含自身延誤 +' + n.delayNext + '）' : '') + '</span>' +
          '<span class="chain-delay">緩衝時間 ' + n.buffer + ' 分' +
          (n.status === 'ok' ? '' : '（' + (n.buffer < 0 ? '負值' : '< ' + state.buffer) + '）') + '</span> ' + badge +
          '</div>');
      }
      html.push('<div class="chain-block" data-group="' + esc(c.group) + '" data-name="' + esc(c.name) +
        '" data-train="' + esc(c.trainNo) + '" data-leg="' + (isTrain ? c.legIndex : '') + '">' +
        '<div class="chain-head">' + esc(c.name) + '（' + esc(c.group) + '）' +
        (isTrain ? '<span class="chain-label">第 ' + (c.legIndex + 1) + ' 腿</span>' : '') +
        (c.label ? '<span class="chain-label">班別 ' + esc(c.label) + '</span>' : '') + '</div>' +
        rows.join('') + '</div>');
      prev = c;
    });
    box.innerHTML = html.join('');
  }

  // 指定車次：兩腿之間的交接提示
  function renderChainHandover(prev, cur) {
    var h = cur.handoverBefore;
    var cls = 'chain-handover';
    var text;
    if (h.sameCrew) {
      text = '↳ 同一車長續乘（' + cur.name + '）';
    } else if (!h.sameStation) {
      cls += ' warn';
      text = '⚠ 交接站不一致：' + prev.toStation + ' → ' + cur.station + '，需人工確認';
    } else if (h.gapMin < 0) {
      cls += ' warn';
      text = '⚠ 兩腿時間重疊 ' + Math.abs(h.gapMin) + ' 分，需人工確認';
    } else if (h.gapMin > 60) {
      cls += ' warn';
      text = '⚠ 兩腿間隔 ' + h.gapMin + ' 分，可能不是同一趟';
    } else {
      text = '↳ ' + prev.toStation + ' ' + fmtMin(prev.arr) + '／' + fmtMin(cur.dep) + ' 交班：' +
        prev.group + '/' + prev.name + ' → ' + cur.group + '/' + cur.name + '（接班）';
    }
    return '<div class="' + cls + '">' + esc(text) + '</div>';
  }

  function renderStats() {
    var res = state.results;
    if (!res) { setStats('–', '–', '–'); return; }
    setStats(res.stats.trains, res.stats.crew, res.stats.short);
  }

  function renderWarnings() {
    var res = state.results;
    var lines = [];
    if (state.ttError) lines.push(state.ttError);
    // §6.3：改點或 ExpireDate 前手動重產時刻表——過期就提醒
    if (state.tt && state.tt.meta.expireDate && state.today > state.tt.meta.expireDate) {
      lines.push('時刻表有效期到 ' + state.tt.meta.expireDate + '，已過期——請重新產生 timetable.json。');
    }
    if (res && res.mode === 'train') {
      if (res.matchNote) lines.push(res.matchNote);
      if (res.noTimetable.length) {
        lines.push('時刻表查無車次 ' + res.noTimetable.join('、') +
          '——已改用班表時間計算，車種／方向僅供參考。可在 tools/timetable-overrides.json 補時刻後重產。');
      }
    } else if (res && res.noTimetable.length) {
      lines.push('以下車次在時刻表資料中查不到（未列入篩選，請人工確認）：' + res.noTimetable.join('、') +
        '。可在 tools/timetable-overrides.json 補時刻後重產。');
    }
    if (res && res.warnings.length) {
      lines = lines.concat(res.warnings);
    }
    if (state.crew && state.crew.batchErrors && state.crew.batchErrors.length) {
      lines.push('部分班次批次載入失敗（' + state.crew.batchErrors.length + ' 批）：' + state.crew.batchErrors[0]);
    }
    setWarn(lines, false);
  }

  // ============================================================
  // 匯出 CSV（§12；BOM＋CRLF，Excel 直接開）
  // ============================================================
  function exportCsv() {
    var res = state.results;
    if (!res) return;
    if (res.mode === 'train') { exportTrainCsv(res); return; }
    if (!res.trains.length) return;
    var lines = [];
    lines.push('受影響列車 ' + state.today.replace(/-/g, '/') + '　' +
      stopName(state.from) + '→' + stopName(state.to) + '　' + state.timeFrom + '-' + state.timeTo +
      '　緩衝時間 ' + state.buffer + ' 分');
    lines.push(['車次', '車種', '方向', '起訖', '進入', '離開', '延誤(分)', '值乘車長', '狀態'].join(','));
    res.trains.forEach(function (item) {
      var t = item.train;
      var crew = item.riders.map(function (r) {
        return r.seg.name + '(' + r.seg.group + ')' +
          (r.unknownStation ? '[需人工確認]' : !r.affected ? '[未受影響]' :
            r.delayOn === 'boarding' ? '[上車延誤]' : '[受影響]');
      }).join(' ');
      lines.push([
        t.no, t.type, item.tv.south ? '逆向' : '順向',
        stopName(t.stops[0][0]) + '→' + stopName(t.stops[t.stops.length - 1][0]),
        (item.tv.enterStop ? '' : '~') + fmtMin(item.tv.enter),
        (item.tv.exitStop ? '' : '~') + fmtMin(item.tv.exit),
        item.delay, crew,
        item.status === 'possible' ? '可能受影響' : item.status === 'pass' ? '通過（推估）' : '正常'
      ].map(csvCell).join(','));
    });
    lines.push('');
    lines.push('影響鏈');
    appendChainCsv(lines, res);
    if (res.noTimetable.length) {
      lines.push('');
      lines.push('無時刻表車次（未列入）,' + res.noTimetable.join('、'));
    }
    downloadCsv(lines, 'affected_' + state.today.replace(/-/g, '') + '.csv');
  }

  // 指定車次 CSV：值乘腿＋每位車長的下一班（完整影響鏈）
  function exportTrainCsv(res) {
    if (!res.legs.length) return;
    var t = res.train;
    var dir = legsDirLabel(res.legs);
    var run = t
      ? stopName(t.stops[0][0]) + '→' + stopName(t.stops[t.stops.length - 1][0])
      : res.legs[0].seg.station + '→' + res.legs[res.legs.length - 1].seg.toStation;
    var lines = [];
    lines.push('指定車次 ' + state.today.replace(/-/g, '/') + '　' + res.trainNo + '　' + run +
      '　整趟延誤 +' + Number(res.legs[0].delay || 0) + ' 分　緩衝時間 ' + state.buffer + ' 分');
    lines.push(['腿序', '車次', '車種', '方向', '起訖', '開車', '抵達', '延誤(分)', '值乘車長', '狀態'].join(','));
    res.legs.forEach(function (leg, i) {
      var seg = leg.seg;
      var status = i === 0 ? '起班'
        : leg.handoverBefore && leg.handoverBefore.sameCrew ? '續乘'
        : i === res.legs.length - 1 ? '接班（末腿）' : '接班';
      lines.push([
        String(i + 1), res.trainNo, t ? shortType(t.type) : '', dirLabel(leg.south),
        seg.station + '→' + seg.toStation,
        fmtMin(leg.chain.dep), fmtMin(leg.chain.arr), leg.delay,
        seg.name + '(' + seg.group + ')' + (leg.label ? ' 班別 ' + leg.label : ''), status
      ].map(csvCell).join(','));
    });
    lines.push('');
    lines.push('影響鏈（依值乘腿順序）');
    appendChainCsv(lines, res);
    if (res.noTimetable.length) {
      lines.push('');
      lines.push('無時刻表車次（改用班表時間）,' + res.noTimetable.join('、'));
    }
    downloadCsv(lines, 'affected_train_' + res.trainNo + '_' + state.today.replace(/-/g, '') + '.csv');
  }

  // 影響鏈 CSV 區塊（起訖模式／指定車次共用）
  function appendChainCsv(lines, res) {
    var isTrain = res.mode === 'train';
    res.chains.forEach(function (c) {
      lines.push([c.name + '(' + c.group + ')', c.label ? '班別 ' + c.label : '', c.trainNo,
        c.section, fmtMin(c.dep) + '-' + fmtMin(c.arr),
        c.delay > 0 ? '+' + c.delay + ' → ' + fmtMin(c.delayOn === 'boarding' ? c.dep + c.delay : c.arrNew) : '＋0',
        isTrain ? '第 ' + (c.legIndex + 1) + ' 腿' : ''
      ].map(csvCell).join(','));
      var n = c.next;
      if (n.kind === 'lasttrain') {
        lines.push([, , , '當日最後一班', , c.delay > 0 ? '收班延後 ' + c.delay + ' 分' : ''].map(csvCell).join(','));
      } else if (n.kind === 'samecontinue') {
        lines.push([, , c.nextSeg.title, '同一車次續開（延誤直接帶入）'].map(csvCell).join(','));
      } else if (n.kind === 'crossnight') {
        lines.push([, , c.nextSeg.title, c.nextSeg.station + '→' + c.nextSeg.toStation, , '跨日，需人工確認'].map(csvCell).join(','));
      } else if (n.kind === 'difstation') {
        lines.push([, , c.nextSeg.title, n.detail, , '需人工確認'].map(csvCell).join(','));
      } else {
        var st = n.status === 'missed' ? '趕不上' : n.status === 'short' ? '不足' : '正常';
        lines.push([, , c.nextSeg.title, c.nextSeg.station + '→' + c.nextSeg.toStation,
          fmtMin(c.nextSeg.dep) + '-' + fmtMin(c.nextSeg.arr),
          '緩衝時間 ' + n.buffer + ' 分（' + st + '）'].map(csvCell).join(','));
      }
    });
  }

  function downloadCsv(lines, filename) {
    var blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/[",\r\n]/.test(s)) s = '"' + s + '"';
    if (s.indexOf('"') === 0) s = '"' + s.slice(1, -1).split('"').join('""') + '"';
    return s;
  }

  // ============================================================
  // 重置／全部套用延誤
  // ============================================================
  function resetForm() {
    var d = defaultStationIds();
    q('input[name="queryMode"][value="section"]').checked = true;
    state.mode = 'section';
    state.trainInput = '';
    state.trainNo = '';
    state.trainDelayInput = 0;
    state.trainMatchNote = '';
    q('#trainNo').value = '';
    q('#trainDelay').value = '0';
    if (d) {
      if (comboFrom) comboFrom.setValue(d.from);
      if (comboTo) comboTo.setValue(d.to);
      state.from = d.from;
      state.to = d.to;
    }
    q('#timeFrom').value = DEFAULTS.timeFrom;
    q('#timeTo').value = DEFAULTS.timeTo;
    q('#direction').value = 'both';
    q('#bufferMin').value = String(DEFAULTS.buffer);
    q('#includePass').checked = true;
    q('#onlyShort').checked = false;
    state.timeFrom = DEFAULTS.timeFrom;
    state.timeTo = DEFAULTS.timeTo;
    state.direction = 'both';
    state.buffer = DEFAULTS.buffer;
    state.includePass = true;
    state.onlyShort = false;
    state.delays = {};
    state.results = null;
    saveScenario();
    applyModeToForm();
    setWarn([]);
    setStats('–', '–', '–');
    q('#trainBody').innerHTML = '<tr class="placeholder"><td colspan="9">請設定條件後按「查詢」。</td></tr>';
    q('#chainBox').innerHTML = '<p class="placeholder">請設定條件後按「查詢」。</p>';
    q('#trainSummary').hidden = true;
    q('#trainSummary').innerHTML = '';
    q('#trainCardTitle').textContent = '▌車次（依進入區間時間排序）';
    q('#btnCsv').disabled = true;
    q('#btnPrint').disabled = true;
  }

  // 套用到所有篩選車次／清除所有延誤（§12）
  function applyAllDelays() {
    var v = parseInt(q('#bulkDelay').value, 10);
    if (isNaN(v) || v < 0) { setWarn(['請先在「全部＋」輸入延誤分鐘。'], false); return; }
    if (v > 600) v = 600;
    var res = state.results;
    if (!res || !res.trains.length) { setWarn(['請先查詢。'], false); return; }
    res.trains.forEach(function (item) {
      state.delays[item.train.no] = v;
    });
    saveScenario();
    recalcChain();
  }
  function clearAllDelays() {
    state.delays = {};
    saveScenario();
    recalcChain();
  }

  // ============================================================
  // 初始化
  // ============================================================
  // 依查詢方式顯示／隱藏欄位（data-mode）
  function applyModeToForm() {
    qa('[data-mode]').forEach(function (el) {
      el.hidden = el.getAttribute('data-mode') !== state.mode;
    });
  }

  // 指定車次：本車延誤（快速鍵／輸入框共用）；已查詢過就即時重算
  function setTrainDelay(v) {
    v = parseInt(v, 10);
    if (isNaN(v) || v < 0) v = 0;
    if (v > 600) v = 600;
    q('#trainDelay').value = String(v);
    state.trainDelayInput = v;
    if (state.trainNo) {
      if (v > 0) state.delays[state.trainNo] = v;
      else delete state.delays[state.trainNo];
    }
    saveScenario();
    if (state.mode === 'train' && state.results && state.results.mode === 'train') {
      recalcChain();
    }
  }

  function applyScenarioToForm() {
    if (['both', 'forward', 'reverse'].indexOf(state.direction) < 0) state.direction = 'both';
    var radio = q('input[name="queryMode"][value="' + state.mode + '"]');
    if (radio) radio.checked = true;
    q('#trainNo').value = state.trainInput || '';
    q('#trainDelay').value = String(state.trainDelayInput || 0);
    q('#timeFrom').value = state.timeFrom;
    q('#timeTo').value = state.timeTo;
    q('#direction').value = state.direction;
    q('#bufferMin').value = String(state.buffer);
    q('#includePass').checked = state.includePass;
    q('#onlyShort').checked = state.onlyShort;
    applyModeToForm();
    // from/to 在 initStationCombos 之後套用
  }

  function bindEvents() {
    q('#btnQuery').addEventListener('click', runQuery);
    q('#btnReset').addEventListener('click', resetForm);
    q('#btnCsv').addEventListener('click', exportCsv);
    q('#btnPrint').addEventListener('click', function () { window.print(); });
    q('#btnApplyAll').addEventListener('click', applyAllDelays);
    q('#btnClearDelays').addEventListener('click', clearAllDelays);
    q('#bufferMin').addEventListener('change', function () {
      readForm();
      saveScenario();
      recalcChain();
    });
    q('#includePass').addEventListener('change', function () {
      readForm();
      saveScenario();
      computeAndRender();
    });
    q('#onlyShort').addEventListener('change', function () {
      readForm();
      saveScenario();
      renderTrains();
      renderChains();
    });
    q('#direction').addEventListener('change', function () {
      readForm();
      saveScenario();
      computeAndRender();
    });
    q('#timeFrom').addEventListener('change', function () { state.timeFrom = this.value || DEFAULTS.timeFrom; saveScenario(); });
    q('#timeTo').addEventListener('change', function () { state.timeTo = this.value || DEFAULTS.timeTo; saveScenario(); });

    // 查詢方式切換：換模式就清掉上一次結果（欄位語意不同，避免誤讀）
    qa('input[name="queryMode"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        state.mode = this.value;
        state.results = null;
        applyModeToForm();
        saveScenario();
        setWarn([]);
        setStats('–', '–', '–');
        q('#trainBody').innerHTML = '<tr class="placeholder"><td colspan="9">請設定條件後按「查詢」。</td></tr>';
        q('#chainBox').innerHTML = '<p class="placeholder">請設定條件後按「查詢」。</p>';
        q('#trainSummary').hidden = true;
        q('#trainSummary').innerHTML = '';
        q('#trainCardTitle').textContent = state.mode === 'train'
          ? '▌指定車次與值乘腿' : '▌車次（依進入區間時間排序）';
        q('#btnCsv').disabled = true;
        q('#btnPrint').disabled = true;
        if (state.mode === 'train') q('#trainNo').focus();
      });
    });
    q('#trainNo').addEventListener('change', function () {
      state.trainInput = this.value;
      saveScenario();
    });
    q('#trainNo').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runQuery(); }
    });
    q('#trainDelay').addEventListener('change', function () { setTrainDelay(this.value); });
    qa('.tqbtn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cur = parseInt(q('#trainDelay').value, 10) || 0;
        setTrainDelay(cur + Number(this.getAttribute('data-train-add')));
      });
    });
  }

  function init() {
    renderDateLine();
    bindEvents();
    loadScenario();
    applyScenarioToForm();
    setWarn([]);
    q('#trainBody').innerHTML = '<tr class="placeholder"><td colspan="9">請設定條件後按「查詢」。</td></tr>';
    q('#chainBox').innerHTML = '<p class="placeholder">請設定條件後按「查詢」。</p>';

    loadTimetable().then(function () {
      if (state.ttError) {
        setWarn([state.ttError], true);
        return;
      }
      // 情境裡的 from/to（站碼）優先，其次預設（彰化→嘉義）
      var scFrom = state.from, scTo = state.to;
      initStationCombos();
      if (scFrom && comboFrom) comboFrom.setValue(scFrom);
      if (scTo && comboTo) comboTo.setValue(scTo);
      state.from = comboFrom ? comboFrom.getValue() : state.from;
      state.to = comboTo ? comboTo.getValue() : state.to;
      renderTtMeta();
      q('#btnQuery').disabled = false;
      // 先在背景把當日班表載起來（首次查詢就不用等）
      loadCrewSegments(function (done, total) {
        setStatus('預載當日班表… ' + done + '/' + total + ' 批');
      }).then(function () {
        setStatus('');
        populateTrainDatalist();
      }).catch(function (e) {
        setStatus('');
        setWarn(['無法預載當日班表（按「查詢」會再試一次）：' + e.message], true);
      });
    });
  }

  init();
  window.__AFFECTED_READY__ = true;   // 頁面測試（步驟 7）用
})();
