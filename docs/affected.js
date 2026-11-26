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

  function populateStations() {
    var fromSel = q('#fromStation');
    var toSel = q('#toStation');
    var list = corridorStations();
    if (!list.length) {
      fromSel.innerHTML = '<option value="">（無站點資料）</option>';
      toSel.innerHTML = fromSel.innerHTML;
      return;   // 無站點資料時維持 disabled
    }
    var html = list.map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
    }).join('');
    fromSel.innerHTML = html;
    toSel.innerHTML = html;
    fromSel.disabled = false;   // HTML 初始 disabled（載入中），填完站後解除
    toSel.disabled = false;
    // 預設：偏好 彰化→嘉義；否則第一站→最後一站
    var byName = {};
    list.forEach(function (s) { byName[normStn(s.name)] = s; });
    var dFrom = byName[normStn(DEFAULTS.from)] || list[0];
    var dTo = byName[normStn(DEFAULTS.to)] || list[list.length - 1];
    if (dFrom.id === dTo.id && list.length > 1) dTo = list[list.length - 1];
    fromSel.value = dFrom.id;
    toSel.value = dTo.id;
    state.from = dFrom.id;
    state.to = dTo.id;
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
      if (sc.direction) state.direction = sc.direction;
      if (sc.includePass != null) state.includePass = sc.includePass;
      if (sc.onlyShort != null) state.onlyShort = sc.onlyShort;
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
        onlyShort: state.onlyShort
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
    state.from = q('#fromStation').value;
    state.to = q('#toStation').value;
    state.timeFrom = q('#timeFrom').value || DEFAULTS.timeFrom;
    state.timeTo = q('#timeTo').value || DEFAULTS.timeTo;
    state.direction = q('#direction').value;
    var buf = parseInt(q('#bufferMin').value, 10);
    state.buffer = (isNaN(buf) || buf < 0) ? 0 : (buf > 120 ? 120 : buf);
    state.includePass = q('#includePass').checked;
    state.onlyShort = q('#onlyShort').checked;
  }

  function validateForm() {
    var problems = [];
    if (!state.tt) problems.push('時刻表未載入');
    if (!state.from || !state.to) problems.push('請選擇起站與迄站');
    if (state.from && state.from === state.to) problems.push('起站與迄站不能相同');
    var t1 = parseHM(state.timeFrom);
    var t2 = parseHM(state.timeTo);
    if (t1 == null || t2 == null || t1 >= t2) problems.push('時段起必須早於時段迄');
    return problems;
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
      computeAndRender();
    }).catch(function (e) {
      setStatus('');
      setWarn(['無法取得當日班表：' + e.message], true);
    }).then(function () {
      q('#btnQuery').disabled = false;
    });
  }

  function computeAndRender() {
    state.results = computeResults();
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
      // 方向篩選（§12）
      if (state.direction === 'south' && !tv.south) return;
      if (state.direction === 'north' && tv.south) return;
      // 時段重疊：進入 < 時段迄 && 離開 > 時段起（§5 Step 2.4）
      if (!(tv.enter < t2 && tv.exit > t1)) return;
      // 推估開關（§7.5）
      if (!state.includePass && (!tv.enterStop || !tv.exitStop)) return;

      // L2：值乘車長（§5 Step 3）
      var riders = [];
      (crew.byTrain[no] || []).forEach(function (seg) {
        var st = CORE.classifyRider(seg, tv, state.index, state.from, state.to);
        riders.push({ seg: seg, affected: st.affected, delayOn: st.delayOn, unknownStation: !!st.unknownStation });
        checkTimeMismatch(train, seg, warnings);
      });

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

  // L3：單一受影響車長的影響鏈（組裝轉接 core.buildChain；§5 Step 4、§13 邊界）
  function buildChain(item, rider) {
    var seg = rider.seg;
    var no = item.train.no;
    var crew = state.crew;
    var list = crew.byStaff[seg.group + '\u0000' + seg.name] || [];
    var idx = list.indexOf(seg);
    var nextRaw = idx >= 0 ? list[idx + 1] : null;
    function toMin(s) {
      return {
        title: s.title, station: s.station, toStation: s.toStation,
        dep: minOfDay(s.startMs), arr: minOfDay(s.endMs)
      };
    }
    var core = CORE.buildChain({
      seg: toMin(seg),
      trainNo: no,
      delay: item.delay,
      delayOn: rider.delayOn,
      next: nextRaw ? toMin(nextRaw) : null,
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
        '<td>' + (item.tv.south ? '南下' : '北上') + '</td>' +
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

  // 車種顯示：TDX 全名很長（如「自強(推拉式自強號且無自行車車廂)」）→ 取「(」前段
  function shortType(type) {
    var s = String(type || '');
    var i = s.indexOf('(');
    return i > 0 ? s.slice(0, i) : s;
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
    if (!riders.length) return '<span class="muted">（無）</span>';
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
        jumpToChain(this.getAttribute('data-group'), this.getAttribute('data-name'), this.getAttribute('data-train'));
      });
    });
  }

  // 找影響鏈區塊：優先（車長＋車次）完全相符，否則該車長第一個區塊
  function findChainBlock(group, name, trainNo) {
    var first = null;
    var blocks = qa('.chain-block');
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.getAttribute('data-name') !== name || b.getAttribute('data-group') !== group) continue;
      if (b.getAttribute('data-train') === trainNo) return b;
      if (!first) first = b;
    }
    return first;
  }

  function jumpToChain(group, name, trainNo) {
    var el = findChainBlock(group, name, trainNo);
    if (!el && state.onlyShort) {
      // 區塊被「只看緩衝時間不足」過濾掉 → 解除過濾再找
      q('#onlyShort').checked = false;
      state.onlyShort = false;
      saveScenario();
      renderChains();
      el = findChainBlock(group, name, trainNo);
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
    if (!res || !res.chains.length) {
      box.innerHTML = '<p class="placeholder">' +
        (res && res.trains.length ? '篩出的列車沒有受影響的車長。' : '請設定條件後按「查詢」。') + '</p>';
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
    chains.forEach(function (c) {
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
        '" data-train="' + esc(c.trainNo) + '">' +
        '<div class="chain-head">' + esc(c.name) + '（' + esc(c.group) + '）' +
        (c.label ? '<span class="chain-label">班別 ' + esc(c.label) + '</span>' : '') + '</div>' +
        rows.join('') + '</div>');
    });
    box.innerHTML = html.join('');
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
    if (res && res.noTimetable.length) {
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
    if (!res || !res.trains.length) return;
    var lines = [];
    lines.push('受影響列車 ' + state.today.replace(/-/g, '/') + '　' +
      stopName(state.from) + '→' + stopName(state.to) + '　' + state.timeFrom + '-' + state.timeTo +
      '　緩衝時間 ' + state.buffer + ' 分');
    lines.push(['車次', '車種', '方向', '起訖', '進入', '離開', '延誤(分)', '值乘車長', '狀態'].join(','));
    res.trains.forEach(function (item) {
      var t = item.train;
      var crew = item.riders.length ? item.riders.map(function (r) {
        return r.seg.name + '(' + r.seg.group + ')' +
          (r.unknownStation ? '[需人工確認]' : !r.affected ? '[未受影響]' :
            r.delayOn === 'boarding' ? '[上車延誤]' : '[受影響]');
      }).join(' ') : '（無）';
      lines.push([
        t.no, t.type, item.tv.south ? '南下' : '北上',
        stopName(t.stops[0][0]) + '→' + stopName(t.stops[t.stops.length - 1][0]),
        (item.tv.enterStop ? '' : '~') + fmtMin(item.tv.enter),
        (item.tv.exitStop ? '' : '~') + fmtMin(item.tv.exit),
        item.delay, crew,
        item.status === 'possible' ? '可能受影響' : item.status === 'pass' ? '通過（推估）' : '正常'
      ].map(csvCell).join(','));
    });
    lines.push('');
    lines.push('影響鏈');
    res.chains.forEach(function (c) {
      lines.push([c.name + '(' + c.group + ')', c.label ? '班別 ' + c.label : '', c.trainNo,
        c.section, fmtMin(c.dep) + '-' + fmtMin(c.arr),
        c.delay > 0 ? '+' + c.delay + ' → ' + fmtMin(c.delayOn === 'boarding' ? c.dep + c.delay : c.arrNew) : '＋0'
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
    if (res.noTimetable.length) {
      lines.push('');
      lines.push('無時刻表車次（未列入）,' + res.noTimetable.join('、'));
    }
    var blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'affected_' + state.today.replace(/-/g, '') + '.csv';
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
    q('#timeFrom').value = DEFAULTS.timeFrom;
    q('#timeTo').value = DEFAULTS.timeTo;
    q('#direction').value = 'both';
    q('#bufferMin').value = String(DEFAULTS.buffer);
    q('#includePass').checked = true;
    q('#onlyShort').checked = false;
    state.delays = {};
    saveScenario();
    populateStations();
    setWarn([]);
    setStats('–', '–', '–');
    state.results = null;
    q('#trainBody').innerHTML = '<tr class="placeholder"><td colspan="9">請設定條件後按「查詢」。</td></tr>';
    q('#chainBox').innerHTML = '<p class="placeholder">請設定條件後按「查詢」。</p>';
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
  function applyScenarioToForm() {
    q('#timeFrom').value = state.timeFrom;
    q('#timeTo').value = state.timeTo;
    q('#direction').value = state.direction;
    q('#bufferMin').value = String(state.buffer);
    q('#includePass').checked = state.includePass;
    q('#onlyShort').checked = state.onlyShort;
    // from/to 在 populateStations 之後套用
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
    q('#fromStation').addEventListener('change', function () { state.from = this.value; saveScenario(); });
    q('#toStation').addEventListener('change', function () { state.to = this.value; saveScenario(); });
    q('#timeFrom').addEventListener('change', function () { state.timeFrom = this.value || DEFAULTS.timeFrom; saveScenario(); });
    q('#timeTo').addEventListener('change', function () { state.timeTo = this.value || DEFAULTS.timeTo; saveScenario(); });
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
      populateStations();
      // 情境裡的 from/to（站碼）套回下拉
      if (state.from && q('#fromStation').querySelector('option[value="' + state.from + '"]')) {
        q('#fromStation').value = state.from;
      }
      if (state.to && q('#toStation').querySelector('option[value="' + state.to + '"]')) {
        q('#toStation').value = state.to;
      }
      renderTtMeta();
      q('#btnQuery').disabled = false;
      // 先在背景把當日班表載起來（首次查詢就不用等）
      loadCrewSegments(function (done, total) {
        setStatus('預載當日班表… ' + done + '/' + total + ' 批');
      }).then(function () {
        setStatus('');
      }).catch(function (e) {
        setStatus('');
        setWarn(['無法預載當日班表（按「查詢」會再試一次）：' + e.message], true);
      });
    });
  }

  init();
  window.__AFFECTED_READY__ = true;   // 頁面測試（步驟 7）用
})();
