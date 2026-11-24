(function () {
  'use strict';

  // GitHub Pages 靜態版：後端為 GAS JSON API，設定在 docs/config.js
  var CFG = window.APP_CONFIG || {};
  var API_URL = CFG.API_URL || '';
  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  var STORE_KEY = 'crew-schedule:name';
  var BOOT_KEY = 'crew-schedule:bootstrap:v1';
  var BOOT_TTL = CFG.BOOTSTRAP_CACHE_TTL_MS || 6 * 60 * 60 * 1000;
  var DEFAULT_MAX_DAYS = 14;
  var serverOffset = 0;

  var cachedBoot = readBootCache(); // { savedAt, data } 或 null
  var initialToday = (cachedBoot && cachedBoot.data && cachedBoot.data.today) || isoOf(new Date());

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  var state = {
    boot: (cachedBoot && cachedBoot.data) || null,
    bootError: '',
    today: initialToday,
    baseDate: (cachedBoot && cachedBoot.data.baseDate) || '',
    maxDays: (cachedBoot && cachedBoot.data.maxDays) || DEFAULT_MAX_DAYS,
    view: 'home',
    name: readName(),
    my: null,
    myLoading: false,
    myError: '',
    expanded: {},
    sheet: false,
    month: {
      month: initialToday.slice(0, 7),
      key: '',
      data: null,
      loading: false,
      error: ''
    },
    allSched: {
      date: initialToday,
      data: null,
      loading: false,
      error: '',
      sort: 'number',
      dir: 1,
      cache: {}
    },
    detail: {
      open: false,
      from: 'home',
      name: '',
      group: '',
      date: '',
      loading: false,
      error: '',
      data: null
    },
    search: {
      tab: 'lookup',
      mode: 'detail',
      date: initialToday,
      days: 1,
      lookup: readName(),
      keyword: '值乘',
      startTime: '',
      endTime: '',
      station: '',
      loading: false,
      error: '',
      result: null
    },
    trains: {
      date: initialToday,
      data: null,
      loading: false,
      error: '',
      q: '',
      from: '',
      to: '',
      direction: '',
      upcoming: false,
      cache: {}
    }
  };

  if (cachedBoot && cachedBoot.data && cachedBoot.data.nowMs) {
    // 用「快取當下的 server/client 時差」推回現在，不要拿過期的 nowMs 直接當現在時間
    serverOffset = cachedBoot.data.nowMs - cachedBoot.savedAt;
  }

  // ============================================================
  // 工具
  // ============================================================
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function icon(name, cls) {
    return '<svg class="icon ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }

  function parseISO(value) {
    var m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function isoOf(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function addDaysISO(iso, days) {
    var d = parseISO(iso);
    if (!d) return iso;
    d.setDate(d.getDate() + days);
    return isoOf(d);
  }

  function fmtMD(iso) {
    var d = parseISO(iso);
    return d ? String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') : iso;
  }

  function fmtFull(iso) {
    var d = parseISO(iso);
    if (!d) return iso;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 週' + WEEKDAYS[d.getDay()];
  }

  function weekdayOf(iso) {
    var d = parseISO(iso);
    return d ? WEEKDAYS[d.getDay()] : '';
  }

  function isToday(iso) {
    return iso === state.today;
  }

  function nowMs() {
    return Date.now() + serverOffset;
  }

  function hhmmOf(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function initialOf(name) {
    var s = String(name || '').trim();
    return s ? s.slice(0, 1) : '?';
  }

  function groupText(group) {
    var g = String(group || '').trim();
    if (!g) return '未分組';
    return /^[A-Z]$/.test(g) ? g + '組' : g;
  }

  function readName() {
    try { return localStorage.getItem(STORE_KEY) || ''; } catch (e) { return ''; }
  }

  function writeName(name) {
    try {
      if (name) localStorage.setItem(STORE_KEY, name);
      else localStorage.removeItem(STORE_KEY);
    } catch (e) { /* 無痕模式可能無法寫入 */ }
  }

  // bootstrap（名單／車站／日期）快取：先渲染舊資料，再透過 fetch 重新驗證
  function readBootCache() {
    try {
      var raw = localStorage.getItem(BOOT_KEY);
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || !entry.savedAt || !entry.data) return null;
      if (Date.now() - entry.savedAt > BOOT_TTL) return null;
      var data = entry.data;
      if (!Array.isArray(data.staff) || !Array.isArray(data.stations)) return null;
      return { savedAt: entry.savedAt, data: data };
    } catch (e) {
      return null;
    }
  }

  function writeBootCache(data) {
    try {
      localStorage.setItem(BOOT_KEY, JSON.stringify({ savedAt: Date.now(), data: data }));
    } catch (e) { /* 快取寫不進去就算了 */ }
  }

  // ============================================================
  // API
  // ============================================================
  // 後端呼叫：fetch POST + text/plain（JSON 字串），避免 GAS 觸發 CORS preflight
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

  var toastTimer = null;
  function toast(message, isError) {
    var el = $('#toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' error' : '');
    toastTimer = setTimeout(function () {
      el.className = 'toast' + (isError ? ' error' : '');
    }, 2600);
  }

  // ============================================================
  // 啟動
  // ============================================================
  var bootstrapPromise = null;

  function ensureBootstrap() {
    if (!bootstrapPromise) bootstrapPromise = loadBootstrap();
    return bootstrapPromise;
  }

  // bootstrap 成功後要接著載的首頁資料（我的班表／當月班表／所有班表）
  function loadHomeData() {
    if (state.name) {
      loadMySchedule();
      loadMonthSchedule(false);
    }
    if (state.view === 'home') loadAllSchedules(false);
  }

  function init() {
    window.__APP_READY__ = true;
    updateNameChip();
    bindEvents();
    if (state.boot) fillDatalists();
    renderHome();
    ensureBootstrap().then(function (data) {
      if (!data) return;
      loadHomeData();
    });
  }

  function loadBootstrap() {
    return api('bootstrap').then(function (data) {
      state.boot = data;
      state.bootError = '';

      if (data.today) {
        var prevToday = state.today;
        state.today = data.today;
        // 只修正「還停在下載前日期」的欄位；使用者已手動切換的不動
        if (state.month.month === monthKeyOf(prevToday)) {
          state.month.month = monthKeyOf(state.today);
        }
        if (state.allSched.date === prevToday) state.allSched.date = state.today;
        if (!state.search.date || state.search.date === prevToday) state.search.date = state.today;
        if (!state.trains.date || state.trains.date === prevToday) state.trains.date = state.today;
      }
      if (data.baseDate) state.baseDate = data.baseDate;
      if (data.maxDays) state.maxDays = data.maxDays;
      if (data.nowMs) serverOffset = data.nowMs - Date.now();

      writeBootCache(data);
      fillDatalists();
      if (state.sheet) renderNameList(($('#nameSearch') || {}).value || '');
      if (state.view === 'trains') refreshStationFilters();
      if (state.view === 'home') renderHome();
      return data;
    }).catch(function (err) {
      bootstrapPromise = null; // 失敗時允許下次切頁自動重試
      if (!state.boot) state.bootError = err.message;
      toast(state.boot ? '使用快取資料，無法更新：' + err.message : '名單載入失敗：' + err.message, true);
      if (state.view === 'home') renderHome();
      return null;
    });
  }

  function fillDatalists() {
    if (!state.boot) return;
    var staff = $('#staffOptions');
    var stations = $('#stationOptions');
    if (staff) {
      var seen = {};
      staff.innerHTML = state.boot.staff.map(function (s) { return s.name; })
        .filter(function (name) {
          if (seen[name]) return false;
          seen[name] = true;
          return true;
        })
        .map(function (name) { return '<option value="' + esc(name) + '"></option>'; })
        .join('');
    }
    if (stations) {
      stations.innerHTML = (state.boot.stations || []).map(function (name) {
        return '<option value="' + esc(name) + '"></option>';
      }).join('');
    }
  }

  function updateNameChip() {
    var btn = $('#nameBtn');
    if (!btn) return;
    btn.classList.toggle('is-empty', !state.name);
    btn.setAttribute('aria-label', state.name ? '目前姓名 ' + state.name + '，點擊更換' : '設定姓名');
    var avatar = btn.querySelector('.avatar');
    if (avatar) {
      if (state.name) avatar.textContent = initialOf(state.name);
      else avatar.innerHTML = icon('user', 'icon-sm');
    }
    var text = btn.querySelector('.chip-text');
    if (text) text.textContent = state.name || '設定姓名';
  }

  function loadMySchedule() {
    var seq = ++mySeq;
    if (!state.name) {
      state.my = null;
      state.myLoading = false;
      state.myError = '';
      if (state.view === 'home') renderHome();
      return;
    }
    var name = state.name;
    state.myLoading = true;
    state.myError = '';
    if (state.view === 'home') renderHome();
    // 多撈一天（今天＋未來 7 天）；「接下來 7 天」列表會排除今天，從明天開始
    api('mySchedule', { name: name, start: state.today, days: 8 })
      .then(function (data) {
        if (seq !== mySeq) return;
        state.my = data;
        state.myLoading = false;
        if (state.view === 'home') renderHome();
        if (data.missing) toast('查無「' + name + '」的車長班表', true);
      })
      .catch(function (err) {
        if (seq !== mySeq) return;
        state.my = null;
        state.myLoading = false;
        state.myError = err.message;
        if (state.view === 'home') renderHome();
      });
  }

  // ============================================================
  // 首頁
  // ============================================================
  function renderHome() {
    var html = '';

    if (!state.name) {
      html += onboardingHTML();
    } else if (state.myLoading) {
      html += homeLoadingHTML();
    } else if (state.myError) {
      html += sectionHeadHTML('我的班表', '', true);
      html += '<div class="error-card"><strong>班表載入失敗</strong>' + esc(state.myError) +
        '<button type="button" data-action="retry-my">重新載入</button></div>';
    } else if (state.my && state.my.missing) {
      html += sectionHeadHTML('我的班表', '', true);
      html += '<div class="card empty-state">' +
        '<div class="empty-ico">' + icon('alert') + '</div>' +
        '<div class="empty-title">查無「' + esc(state.name) + '」的班表</div>' +
        '請確認姓名是否正確，或洽管理員確認 Staff 與 Schedule_S 資料。' +
        '<div style="margin-top:12px"><button class="chip" type="button" data-action="open-name">重新設定姓名</button></div>' +
        '</div>';
    } else if (state.my && state.my.staffs && state.my.staffs.length) {
      html += sectionHeadHTML('我的班表', fmtFull(state.today), true);
      state.my.staffs.forEach(function (staffObj, index) {
        html += staffBlockHTML(staffObj, index);
      });
    } else {
      html += state.name ? homeLoadingHTML() : onboardingHTML();
    }

    if (state.bootError) {
      html += '<div class="error-card" style="margin-top:12px"><strong>名單尚未載入</strong>' +
        esc(state.bootError) +
        '<button type="button" data-action="retry-boot">重新載入</button></div>';
    }

    if (state.name) {
      html += '<div id="monthSection">' + monthSectionHTML() + '</div>';
    }
    html += '<div id="allSchedSection">' + allSchedulesSectionHTML() + '</div>';

    html += sectionHeadHTML('快速查詢', '不用打字，直接看目前狀態');
    html += quickGridHTML();
    html += queryCTAHTML();

    $('#main').innerHTML = '<div class="view">' + html + '</div>';
    updateNameChip();
  }

  function sectionHeadHTML(title, note, withRefresh) {
    return '<div class="section-head">' +
      '<h2 class="section-title">' + esc(title) + '</h2>' +
      '<div style="display:flex;align-items:center;gap:8px;min-width:0">' +
      (note ? '<span class="section-note">' + esc(note) + '</span>' : '') +
      (withRefresh ? '<button class="icon-btn" type="button" data-action="refresh-my" aria-label="重新整理班表">' + icon('refresh', 'icon-sm') + '</button>' : '') +
      '</div></div>';
  }

  function onboardingHTML() {
    return '<section class="hero is-empty">' +
      '<div class="hero-top"><span class="hero-kicker">WELCOME</span><span class="pill green">首次設定</span></div>' +
      '<div class="hero-shift">先設定你的姓名</div>' +
      '<p class="hero-hint">設定一次，之後打開就能直接看到今日班表與未來 7 天。姓名只會儲存在這支手機。</p>' +
      '<button class="hero-cta" type="button" data-action="open-name">' + icon('user') + '設定姓名</button>' +
      '</section>';
  }

  function homeLoadingHTML() {
    return '<div class="section-head"><h2 class="section-title">我的班表</h2></div>' +
      '<div class="hero is-empty" style="padding:20px">' +
      '<div class="sk sk-line w40"></div>' +
      '<div class="sk" style="height:34px;width:55%;margin-top:12px"></div>' +
      '<div class="sk sk-line w60" style="margin-top:12px"></div>' +
      '<div class="sk sk-block" style="margin-top:18px;height:52px"></div>' +
      '</div>' +
      '<div class="card skeleton-card" style="margin-top:12px">' +
      '<div class="sk sk-line w40"></div>' +
      '<div class="sk sk-block" style="margin-top:12px"></div>' +
      '<div class="sk sk-line w80" style="margin-top:12px"></div>' +
      '</div>';
  }

  function staffBlockHTML(staffObj, index) {
    var days = staffObj.days || [];
    var staff = staffObj.staff || {};
    var today = null;
    for (var i = 0; i < days.length; i++) {
      if (days[i].date === state.today) { today = days[i]; break; }
    }
    if (!today && days.length) today = days[0];

    var html = '';
    if (state.my.staffs.length > 1) {
      html += '<div class="section-head" style="margin-top:' + (index === 0 ? '12px' : '22px') + '">' +
        '<h3 class="section-title"><span class="tag-group">' + esc(staff.group) + '</span>' + esc(staff.name) + '</h3>' +
        '<span class="section-note">' + esc(groupText(staff.group)) + '</span></div>';
    }

    html += heroHTML(today, staff);
    html += todayTimelineHTML(today);

    html += '<div class="section-head"><h2 class="section-title">接下來 7 天</h2><span class="section-note">點日期看細節</span></div>';
    // 從明天開始：排除英雄卡顯示的那一天（今天）
    var heroDate = today ? today.date : (days.length ? days[0].date : '');
    var weekDays = days.filter(function (d) { return d.date !== heroDate; });
    html += weekHTML(weekDays, staff);
    return html;
  }

  function heroHTML(day, staff, options) {
    var opts = options || {};
    var live = opts.live === undefined ? true : !!opts.live;
    if (!day) {
      return '<section class="hero is-empty"><div class="hero-top"><span class="hero-kicker">' +
        (live ? 'TODAY' : 'DATE') + '</span></div>' +
        '<div class="hero-shift">查無班表</div><p class="hero-hint">請確認姓名是否正確。</p></section>';
    }

    var kicker = opts.kicker || (live ? 'TODAY · ' : '') + fmtMD(day.date) + '（' + day.weekday + '）';
    var status = live ? dayStatus(day) : staticDayStatus(day);

    if (day.kind === 'work') {
      var segments = day.segments || [];
      var trains = segments.filter(function (s) { return s.kind === 'train'; });
      var firstTrain = trains[0];
      var lastTrain = trains[trains.length - 1];
      var report = null;
      var offSeg = null;
      segments.forEach(function (s) { if (s.kind === 'report' && !report) report = s; });
      for (var i = segments.length - 1; i >= 0; i--) {
        if (segments[i].kind === 'post' || segments[i].kind === 'overnight' || segments[i].kind === 'train') {
          offSeg = segments[i];
          break;
        }
      }

      var reportTime = report ? report.start : (firstTrain ? firstTrain.start : '—');
      var offTime = offSeg ? offSeg.end : '—';
      var offLabel = offSeg && offSeg.kind === 'overnight' ? '翌日下班' :
        offSeg && offSeg.kind === 'post' ? '後整結束' : '收班';
      if (offSeg && offSeg.endDayOffset) offTime += ' (+' + offSeg.endDayOffset + ')';

      var progress = '';
      if (live && day.firstStartMs !== null && day.lastEndMs !== null && day.lastEndMs > day.firstStartMs) {
        var now = nowMs();
        var pct = Math.max(0, Math.min(100, (now - day.firstStartMs) / (day.lastEndMs - day.firstStartMs) * 100));
        var left = now < day.firstStartMs ? '尚未報到' : now >= day.lastEndMs ? '已收班' : '現在 ' + hhmmOf(now);
        progress = '<div class="hero-progress">' +
          '<div class="hero-progress-track"><div class="hero-progress-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
          '<div class="hero-progress-labels"><span>' + esc(left) + '</span><span>' + Math.round(pct) + '%</span></div>' +
          '</div>';
      }

      return '<section class="hero">' +
        '<div class="hero-top"><span class="hero-kicker">' + kicker + '</span>' +
        '<span class="hero-status ' + status.cls + '"><i></i>' + esc(status.label) + '</span></div>' +
        '<div class="hero-shift">' + esc(day.label || '班表') + '</div>' +
        (firstTrain && lastTrain
          ? '<div class="hero-route">' + esc(firstTrain.station) + icon('arrow') + esc(lastTrain.toStation || '') + '</div>'
          : '') +
        '<div class="hero-stats">' +
        '<div class="hero-stat"><span>報到</span><strong>' + esc(reportTime) + '</strong></div>' +
        '<div class="hero-stat"><span>' + esc(offLabel) + '</span><strong>' + esc(offTime) + '</strong></div>' +
        '<div class="hero-stat"><span>班次</span><strong>' + trains.length + '<small>班</small></strong></div>' +
        '</div>' + progress +
        '</section>';
    }

    if (day.kind === 'leave') {
      var inLeave = live && day.firstStartMs !== null && day.lastEndMs !== null &&
        nowMs() >= day.firstStartMs && nowMs() < day.lastEndMs;
      var leaveStatus = inLeave ? '放假中' : '休假';
      return '<section class="hero is-leave">' +
        '<div class="hero-top"><span class="hero-kicker">' + kicker + '</span>' +
        '<span class="hero-status is-rest"><i></i>' + leaveStatus + '</span></div>' +
        '<div class="hero-shift">' + esc(day.label || day.leaveCategory || '放假') + '</div>' +
        '<p class="hero-leave-time">' + esc(day.leaveRange || '全天') + '</p>' +
        '<p class="hero-leave-note">' + esc(day.leaveCategory || '休假') + ' · 下一班前好好休息。</p>' +
        '</section>';
    }

    return '<section class="hero is-empty">' +
      '<div class="hero-top"><span class="hero-kicker">' + kicker + '</span><span class="pill">無班表</span></div>' +
      '<div class="hero-shift">這天沒有班表</div>' +
      '<p class="hero-hint">' + (opts.multiStaff
        ? '這個群組沒有排班資料，切換其他群組看看。'
        : '可能是排班資料尚未建置，或所屬群組沒有 Schedule_S 資料。') + '</p>' +
      '<button class="hero-cta" type="button" data-action="' +
      (live ? 'refresh-my' : 'retry-detail') + '">' + icon('refresh') + '重新整理</button>' +
      '</section>';
  }

  function staticDayStatus(day) {
    if (!day) return { label: '—', cls: 'is-idle' };
    if (day.kind === 'leave') return { label: '休假', cls: 'is-rest' };
    if (day.kind !== 'work' || !day.segments || !day.segments.length) {
      return { label: '無班表', cls: 'is-idle' };
    }
    return { label: '班表', cls: 'is-idle' };
  }

  function dayStatus(day) {
    if (!day) return { label: '—', cls: 'is-idle' };
    if (day.kind === 'leave') {
      var inLeave = day.firstStartMs !== null && day.lastEndMs !== null &&
        nowMs() >= day.firstStartMs && nowMs() < day.lastEndMs;
      return { label: inLeave ? '放假中' : '休假', cls: 'is-rest' };
    }
    if (day.kind !== 'work' || !day.segments || !day.segments.length) {
      return { label: '無班表', cls: 'is-idle' };
    }
    var now = nowMs();
    for (var i = 0; i < day.segments.length; i++) {
      var seg = day.segments[i];
      if (now >= seg.startMs && now < seg.endMs) {
        if (seg.kind === 'train') return { label: '值乘中', cls: 'is-live' };
        if (seg.kind === 'report') return { label: '報到中', cls: 'is-live' };
        if (seg.kind === 'rest') return { label: '中場休息', cls: 'is-rest' };
        if (seg.kind === 'post') return { label: '後整中', cls: 'is-rest' };
        if (seg.kind === 'overnight') return { label: '休息中', cls: 'is-rest' };
      }
    }
    var first = day.segments[0];
    var last = day.segments[day.segments.length - 1];
    if (now < first.startMs) return { label: '尚未報到', cls: 'is-idle' };
    if (now >= last.endMs) return { label: '已收班', cls: 'is-off' };
    return { label: '休息中', cls: 'is-rest' };
  }

  function todayTimelineHTML(day, title) {
    if (!day || day.kind !== 'work') return '';
    var count = (day.segments || []).filter(function (s) { return s.kind === 'train'; }).length;
    return '<div class="card mt-12">' +
      '<div class="card-head"><h3 class="card-title">' + icon('list') + esc(title || '今日行程') + '</h3>' +
      '<span class="card-sub">共 ' + count + ' 班</span></div>' +
      '<div class="card-pad" style="padding-top:8px">' +
      timelineHTML(day.segments, false, isToday(day.date)) + '</div>' +
      '</div>';
  }

  function timelineHTML(segments, compact, showNow) {
    if (!segments || !segments.length) {
      return '<div class="tl-empty">這天沒有班次資料</div>';
    }
    var now = nowMs();
    var nowPlaced = false;
    var html = '<div class="tl' + (compact ? ' compact' : '') + '">';
    segments.forEach(function (s) {
      // 同車次頁：在第一個還沒開始的區段前，標出「現在」位置
      if (showNow && !nowPlaced && s.startMs > now) {
        html += '<div class="now-line tl-now">現在 ' + esc(hhmmOf(now)) + '</div>';
        nowPlaced = true;
      }
      var isTrain = s.kind === 'train';
      var title = isTrain
        ? '<span class="train-badge">' + esc(s.title) + '</span>'
        : esc(s.title);
      var subtitle = isTrain
        ? esc(s.station) + ' → ' + esc(s.toStation || '')
        : esc(s.subtitle || '');
      var endText = s.end + (s.endDayOffset ? ' +' + s.endDayOffset : '');
      html += '<div class="tl-item">' +
        '<div class="tl-time">' + esc(s.start) + '<span class="end">' + esc(endText) + '</span></div>' +
        '<div class="tl-rail"><span class="tl-dot ' + esc(s.kind) + '"></span></div>' +
        '<div class="tl-main">' +
        '<div class="tl-title">' + title + '</div>' +
        (subtitle ? '<div class="tl-sub">' + subtitle + '</div>' : '') +
        (s.note && !compact ? '<span class="tl-note">' + esc(s.note) + '</span>' : '') +
        '</div></div>';
    });
    return html + '</div>';
  }

  function weekHTML(days, staff) {
    var keyBase = String(staff.group || '') + '_' + String(staff.name || '');
    var html = '<div class="card week-card">';
    (days || []).forEach(function (day) {
      var key = keyBase + '_' + day.date;
      var expanded = !!state.expanded[key];
      var today = isToday(day.date);
      var kindClass = day.kind === 'leave' ? 'leave' : day.kind === 'work' ? '' : 'empty';
      var summary = day.kind === 'work'
        ? (day.summary || '')
        : day.kind === 'leave'
          ? '放假 · ' + (day.leaveRange || '全天')
          : (day.summary || '查無班表');

      html += '<div class="week-item">' +
        '<button class="week-row' + (today ? ' is-today' : '') + '" type="button" ' +
        'data-action="toggle-week" data-key="' + esc(key) + '" aria-expanded="' + expanded + '">' +
        '<span class="week-date"><span class="week-md">' + fmtMD(day.date) + '</span>' +
        '<span class="week-wd">' + (today ? '今天' : '週' + esc(day.weekday)) + '</span></span>' +
        '<span class="week-main"><span class="week-label"><span class="week-dot ' + kindClass + '"></span>' +
        esc(day.label || (day.kind === 'empty' ? '無班表' : '—')) + '</span>' +
        '<span class="week-sum">' + esc(summary) + '</span></span>' +
        icon('chevron', 'week-chev') +
        '</button>' +
        '<div class="week-expand' + (expanded ? '' : ' hidden') + '">' +
        timelineHTML(day.segments, true) +
        '</div></div>';
    });
    return html + '</div>';
  }

  // ============================================================
  // 首頁：當月班表
  // ============================================================
  function monthKeyOf(iso) {
    return String(iso || '').slice(0, 7);
  }

  function monthTitle(key) {
    var m = String(key || '').match(/^(\d{4})-(\d{2})$/);
    return m ? Number(m[1]) + ' 年 ' + Number(m[2]) + ' 月' : String(key || '');
  }

  function shiftMonthKey(key, delta) {
    var m = String(key || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return key;
    var d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function updateMonthSection() {
    var el = $('#monthSection');
    if (el) el.innerHTML = monthSectionHTML();
  }

  function monthSectionHTML() {
    if (!state.name) return '';
    var m = state.month;
    var currentMonth = monthKeyOf(state.today);
    var baseMonth = monthKeyOf(state.baseDate);
    var prevKey = shiftMonthKey(m.month, -1);
    var disablePrev = !!(baseMonth && prevKey < baseMonth);
    var note = m.loading ? '載入中…' :
      m.data && !m.data.missing ? '共 ' + (m.data.monthDays || 0) + ' 天' : '';

    var html = '<div class="section-head"><h2 class="section-title">當月班表</h2>' +
      '<div style="display:flex;align-items:center;gap:8px;min-width:0">' +
      (note ? '<span class="section-note">' + esc(note) + '</span>' : '') +
      '<button class="icon-btn" type="button" data-action="refresh-month" aria-label="重新整理當月班表">' +
      icon('refresh', 'icon-sm') + '</button></div></div>';

    html += '<div class="card month-card">' +
      '<div class="month-nav">' +
      '<button class="icon-btn" type="button" data-action="month-prev" aria-label="上個月"' +
      (disablePrev ? ' disabled' : '') + '>' + icon('chevron', 'flip') + '</button>' +
      '<div class="month-nav-main"><strong>' + esc(monthTitle(m.month)) + '</strong>' +
      '<span>' + esc(state.name) +
      (m.data && m.data.staffs && m.data.staffs.length > 1 ? ' · ' + m.data.staffs.length + ' 組' : '') +
      '</span></div>' +
      '<button class="icon-btn" type="button" data-action="month-next" aria-label="下個月">' +
      icon('chevron') + '</button>' +
      (m.month !== currentMonth
        ? '<button class="today-chip" type="button" data-action="month-current">本月</button>'
        : '') +
      '</div>' +
      monthBodyHTML() +
      '</div>';
    return html;
  }

  function monthBodyHTML() {
    var m = state.month;
    if (m.loading && !m.data) {
      return '<div class="month-loading">' +
        '<div class="sk sk-line w40"></div>' +
        '<div class="sk sk-block" style="margin-top:12px;height:180px"></div>' +
        '</div>';
    }
    if (m.error && !m.data) {
      return '<div style="padding:12px 2px 4px">' +
        errorCardHTML('當月班表載入失敗', m.error, 'retry-month') + '</div>';
    }
    if (!m.data) {
      return '<div class="hint-card" style="margin:12px 0 4px">' +
        '<span class="empty-ico">' + icon('calendar') + '</span>' +
        '<span>正在準備當月班表。</span></div>';
    }
    if (m.data.missing || !m.data.staffs || !m.data.staffs.length) {
      return emptyHTML('查無「' + state.name + '」的當月班表。');
    }

    var html = '';
    m.data.staffs.forEach(function (staffObj, index) {
      if (m.data.staffs.length > 1) {
        html += '<div class="month-staff' + (index ? ' mt-12' : '') + '">' +
          staffHeadHTML(staffObj.staff, '') + '</div>';
      }
      html += monthCalendarHTML(staffObj.staff, staffObj.days || [], m.month);
    });
    html += '<div class="month-legend">' +
      '<span><i class="work"></i>上班</span>' +
      '<span><i class="leave"></i>放假</span>' +
      '<span><i class="empty"></i>無班表</span>' +
      '<span class="month-legend-note">點日期看當日班表</span></div>';
    return html;
  }

  function monthCalendarHTML(staff, days, monthKey) {
    var byDate = {};
    (days || []).forEach(function (day) { byDate[day.date] = day; });

    var m = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
    var year = m ? Number(m[1]) : 0;
    var month = m ? Number(m[2]) : 1;
    var first = parseISO(monthKey + '-01');
    var leading = first ? first.getDay() : 0;
    var total = m ? new Date(year, month, 0).getDate() : 0;
    var weekdays = ['日', '一', '二', '三', '四', '五', '六'];

    var html = '<div class="month-weekdays">' + weekdays.map(function (w) {
      return '<span>' + w + '</span>';
    }).join('') + '</div><div class="month-grid">';

    for (var i = 0; i < leading; i++) {
      html += '<span class="month-day is-blank"></span>';
    }

    for (var dayNum = 1; dayNum <= total; dayNum++) {
      var iso = monthKey + '-' + String(dayNum).padStart(2, '0');
      var day = byDate[iso];
      var kind = day ? day.kind : 'empty';
      var cls = kind === 'work' ? 'is-work' : kind === 'leave' ? 'is-leave' : 'is-empty';
      if (isToday(iso)) cls += ' is-today';

      var label = '';
      if (day) {
        if (day.kind === 'leave') label = day.leaveCategory || '放假';
        else if (day.kind === 'work') label = day.label || '班表';
        else label = day.label || '—';
      } else {
        label = '—';
      }
      var title = fmtFull(iso) + (label ? ' · ' + label : '') +
        (day && day.summary ? ' · ' + day.summary : '');

      html += '<button class="month-day ' + cls + '" type="button" ' +
        'data-action="open-staff-day" data-name="' + esc(staff.name) + '" ' +
        'data-group="' + esc(staff.group) + '" data-date="' + esc(iso) + '" ' +
        'title="' + esc(title) + '" aria-label="' + esc(title) + '">' +
        '<span class="md-num">' + dayNum + '</span>' +
        '<span class="md-label">' + esc(label) + '</span>' +
        '</button>';
    }

    return html + '</div>';
  }

  function loadMonthSchedule(force) {
    if (!state.name) return;
    var month = state.month.month;
    var key = state.name + '|' + month;
    var m = state.month;

    if (!force && m.key === key && m.data) {
      if (state.view === 'home') updateMonthSection();
      return;
    }

    if (m.key !== key) m.data = null;
    m.key = key;
    m.loading = true;
    m.error = '';
    if (force) m.data = null;
    if (state.view === 'home') updateMonthSection();

    api('monthSchedule', { name: state.name, month: month }).then(function (data) {
      if (state.month.key !== key) return;
      state.month.loading = false;
      state.month.error = '';
      state.month.data = data;
      if (state.view === 'home') updateMonthSection();
    }).catch(function (err) {
      if (state.month.key !== key) return;
      state.month.loading = false;
      state.month.error = err.message;
      if (state.view === 'home') updateMonthSection();
      toast('當月班表載入失敗：' + err.message, true);
    });
  }

  function goMonth(key) {
    var baseMonth = monthKeyOf(state.baseDate);
    if (baseMonth && key < baseMonth) {
      toast('無法查詢基準日（' + state.baseDate + '）以前的班表');
      return;
    }
    if (state.month.month === key && state.month.data) return;
    state.month.month = key;
    state.month.data = null;
    loadMonthSchedule(false);
  }

  // ============================================================
  // 首頁：所有班表
  // ============================================================
  function naturalCompare(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'zh-Hant', {
      numeric: true,
      sensitivity: 'base'
    });
  }

  function updateAllSchedulesSection() {
    var el = $('#allSchedSection');
    if (el) el.innerHTML = allSchedulesSectionHTML();
  }

  function allSchedulesSectionHTML() {
    var a = state.allSched;
    var note = a.loading ? '載入中…' : a.data ? '共 ' + a.data.count + ' 筆' : '';
    var html = '<div class="section-head"><h2 class="section-title">所有班表</h2>' +
      '<div style="display:flex;align-items:center;gap:8px;min-width:0">' +
      (note ? '<span class="section-note">' + esc(note) + '</span>' : '') +
      '<button class="icon-btn" type="button" data-action="refresh-all" aria-label="重新整理所有班表">' +
      icon('refresh', 'icon-sm') + '</button></div></div>';

    html += allDateNavHTML();
    html += '<div class="card all-card">' +
      allSortHTML() +
      '<div id="allList">' + allListHTML() + '</div>' +
      '<div class="all-foot">點擊有車長姓名的班表，查看該車長當日完整班表</div>' +
      '</div>';
    return html;
  }

  function allDateNavHTML() {
    var a = state.allSched;
    var min = state.baseDate || addDaysISO(state.today, -3650);
    var max = addDaysISO(state.today, 365);
    var todayLabel = isToday(a.date) ? '今天' : '週' + weekdayOf(a.date);

    return '<div class="date-nav">' +
      '<button class="icon-btn" type="button" data-action="all-prev" aria-label="前一天">' +
      icon('chevron', 'flip') + '</button>' +
      '<div class="date-nav-center">' +
      '<div class="date-nav-main">' + fmtMD(a.date) +
      ' <span class="week-wd" style="margin-top:0">' + esc(todayLabel) + '</span></div>' +
      '<div class="date-nav-sub">' + esc(allNavSub()) + '</div>' +
      '<input type="date" data-field="allDate" value="' + esc(a.date) + '" ' +
      'min="' + esc(min) + '" max="' + esc(max) + '" aria-label="選擇所有班表日期">' +
      '</div>' +
      '<button class="icon-btn" type="button" data-action="all-next" aria-label="後一天">' +
      icon('chevron') + '</button>' +
      (isToday(a.date) ? '' : '<button class="today-chip" type="button" data-action="all-today">今天</button>') +
      '</div>';
  }

  function allNavSub() {
    var a = state.allSched;
    if (a.loading && !a.data) return '載入中…';
    if (a.error && !a.data) return '載入失敗';
    if (!a.data) return '';
    var staffKeys = {};
    a.data.schedules.forEach(function (row) {
      if (row.staff) staffKeys[row.staff.group + '_' + row.staff.name] = true;
    });
    return '共 ' + a.data.count + ' 筆 · ' + Object.keys(staffKeys).length + ' 位車長';
  }

  function allSortHTML() {
    var a = state.allSched;
    var defs = [
      { key: 'number', label: '班號' },
      { key: 'group', label: '組別' },
      { key: 'on', label: '上班' },
      { key: 'off', label: '下班' }
    ];
    return '<div class="sort-row"><span class="sort-label">排序</span>' + defs.map(function (def) {
      var active = a.sort === def.key;
      var arrow = active ? (a.dir > 0 ? ' ↑' : ' ↓') : '';
      return '<button class="chip sort-chip' + (active ? ' active' : '') + '" type="button" ' +
        'data-action="sort-all" data-sort="' + def.key + '" aria-pressed="' + active + '">' +
        def.label + arrow + '</button>';
    }).join('') + '</div>';
  }

  function allListHTML() {
    var a = state.allSched;
    if (a.loading && !a.data) {
      return '<div class="all-loading">' +
        '<div class="sk sk-line w40"></div>' +
        '<div class="sk sk-line w60"></div>' +
        '<div class="sk sk-line w80"></div>' +
        '<div class="sk sk-line w40"></div>' +
        '</div>';
    }
    if (a.error && !a.data) {
      return '<div style="padding:14px">' +
        errorCardHTML('所有班表載入失敗', a.error, 'retry-all') + '</div>';
    }
    if (!a.data) return '<div class="tl-empty">正在準備所有班表…</div>';
    if (!a.data.schedules || !a.data.schedules.length) {
      return emptyHTML('這個日期沒有班表資料。');
    }

    return sortedAllSchedules().map(function (row) {
      var staff = row.staff;
      var name = staff ? staff.name : '未排班';
      var cls = 'all-row' + (staff ? '' : ' is-off');
      var date = a.data.date;
      var attrs = staff
        ? ' type="button" data-action="open-staff-day" data-name="' + esc(staff.name) +
          '" data-group="' + esc(staff.group) + '" data-date="' + esc(date) + '"' +
          ' aria-label="查看 ' + esc(staff.name) + ' ' + esc(date) + ' 的班表"'
        : '';
      var tag = staff ? 'button' : 'div';

      return '<' + tag + ' class="' + cls + '"' + attrs + '>' +
        '<span class="tag-group all-group">' + esc(row.group || '—') + '</span>' +
        '<span class="all-main">' +
        '<span class="all-name-line"><strong class="all-name">' + esc(name) + '</strong>' +
        '<span class="all-number">' + esc(row.number || '—') + '</span></span>' +
        '<span class="all-sub"><span class="all-k">車次</span>' + esc(row.train || '—') + '</span>' +
        '</span>' +
        '<span class="all-times">' +
        '<span class="all-time"><small>上班</small>' + esc(row.on || '—') + '</span>' +
        '<span class="all-time"><small>下班</small>' + esc(row.off || '—') + '</span>' +
        '</span>' +
        '</' + tag + '>';
    }).join('');
  }

  function sortedAllSchedules() {
    var a = state.allSched;
    var list = ((a.data && a.data.schedules) || []).slice();
    var dir = a.dir || 1;

    function rowNumberCompare(x, y) {
      return naturalCompare(x.number, y.number) ||
        naturalCompare(x.group, y.group) ||
        (x.index || 0) - (y.index || 0);
    }

    function timeCompare(x, y, field) {
      var xv = x[field];
      var yv = y[field];
      var xn = (xv === null || xv === undefined || isNaN(xv)) ? Infinity : Number(xv);
      var yn = (yv === null || yv === undefined || isNaN(yv)) ? Infinity : Number(yv);
      if (xn === yn) return rowNumberCompare(x, y);
      if (xn === Infinity) return 1;
      if (yn === Infinity) return -1;
      return (xn - yn) * dir;
    }

    list.sort(function (x, y) {
      if (a.sort === 'group') {
        return (naturalCompare(x.group, y.group) || rowNumberCompare(x, y)) * dir;
      }
      if (a.sort === 'on') return timeCompare(x, y, 'onMin');
      if (a.sort === 'off') return timeCompare(x, y, 'offMin');
      return rowNumberCompare(x, y) * dir;
    });
    return list;
  }

  function loadAllSchedules(force) {
    var a = state.allSched;
    var date = a.date;

    if (!force && a.cache[date]) {
      a.data = a.cache[date];
      a.loading = false;
      a.error = '';
      if (state.view === 'home') updateAllSchedulesSection();
      return;
    }

    a.loading = true;
    a.error = '';
    if (force) a.data = null;
    if (state.view === 'home') updateAllSchedulesSection();

    api('allSchedules', { date: date }).then(function (data) {
      if (state.allSched.date !== date) return;
      state.allSched.loading = false;
      state.allSched.error = '';
      state.allSched.data = data;
      state.allSched.cache[date] = data;
      if (state.view === 'home') updateAllSchedulesSection();
    }).catch(function (err) {
      if (state.allSched.date !== date) return;
      state.allSched.loading = false;
      state.allSched.error = err.message;
      if (state.view === 'home') updateAllSchedulesSection();
      toast('所有班表載入失敗：' + err.message, true);
    });
  }

  function goAllDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
    var base = state.baseDate || '';
    if (base && date < base) {
      toast('無法查詢基準日（' + base + '）以前的班表');
      return false;
    }
    var max = addDaysISO(state.today, 365);
    if (date > max) {
      toast('最多只能查詢未來一年');
      return false;
    }
    state.allSched.date = date;
    state.allSched.error = '';
    state.allSched.data = state.allSched.cache[date] || null;
    loadAllSchedules(false);
    return true;
  }

  // ============================================================
  // 車長當日詳情（我的班表介面）
  // ============================================================
  var detailSeq = 0;

  function openStaffDetail(name, group, date, from) {
    name = String(name || '').trim();
    group = String(group || '').trim();
    date = String(date || '').trim();
    if (!name || !date) return;

    from = from === 'search' || from === 'trains' ? from : 'home';
    state.detail = {
      open: true,
      from: from,
      name: name,
      group: group,
      date: date,
      loading: true,
      error: '',
      data: null
    };
    state.view = 'detail';
    state.sheet = false;
    renderNameSheet();
    setActiveTab(from);
    renderDetail();
    loadDetail();
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  }

  function loadDetail() {
    var d = state.detail;
    if (!d.open) return;
    var seq = ++detailSeq;
    d.loading = true;
    d.error = '';
    renderDetail();

    api('staffDay', {
      name: d.name,
      group: d.group,
      date: d.date,
      days: 8
    }).then(function (data) {
      if (seq !== detailSeq || !state.detail.open) return;
      state.detail.loading = false;
      state.detail.error = '';
      state.detail.data = data;
      renderDetail();
    }).catch(function (err) {
      if (seq !== detailSeq || !state.detail.open) return;
      state.detail.loading = false;
      state.detail.error = err.message;
      renderDetail();
      toast('班表載入失敗：' + err.message, true);
    });
  }

  function closeStaffDetail() {
    var from = state.detail.from || 'home';
    state.detail.open = false;
    state.detail.data = null;
    switchView(from);
  }

  function renderDetail() {
    var d = state.detail;
    if (!d.open) return;

    var html = '<div class="view detail-view">' +
      '<div class="detail-bar">' +
      '<button class="icon-btn" type="button" data-action="close-detail" aria-label="返回">' +
      icon('chevron', 'flip') + '</button>' +
      '<div class="detail-head">' +
      '<p class="page-kicker">CREW DAY</p>' +
      '<h2 class="detail-title">' + esc(d.name) + '</h2>' +
      '<p class="page-sub">' + esc(fmtFull(d.date)) +
      (d.group ? ' · ' + esc(groupText(d.group)) : '') + '</p>' +
      '</div>' +
      (d.group ? '<span class="tag-group">' + esc(d.group) + '</span>' : '') +
      '</div>';

    if (d.loading) {
      html += detailLoadingHTML();
    } else if (d.error) {
      html += '<div style="margin-top:12px">' +
        errorCardHTML('班表載入失敗', d.error, 'retry-detail') + '</div>';
    } else if (!d.data || d.data.missing || !d.data.staffs || !d.data.staffs.length) {
      html += '<div class="card empty-state" style="margin-top:12px">' +
        '<div class="empty-ico">' + icon('alert') + '</div>' +
        '<div class="empty-title">查無「' + esc(d.name) + '」的班表</div>' +
        '請確認車長姓名與組別，或洽管理員確認資料。</div>';
    } else {
      d.data.staffs.forEach(function (staffObj, index) {
        html += detailStaffBlockHTML(staffObj, index, d.data.staffs.length, d.date);
      });
    }

    $('#main').innerHTML = html + '</div>';
    updateNameChip();
  }

  function detailLoadingHTML() {
    return '<div class="hero is-empty" style="padding:20px;margin-top:12px">' +
      '<div class="sk sk-line w40"></div>' +
      '<div class="sk" style="height:34px;width:55%;margin-top:12px"></div>' +
      '<div class="sk sk-line w60" style="margin-top:12px"></div>' +
      '<div class="sk sk-block" style="margin-top:18px;height:52px"></div>' +
      '</div>' +
      '<div class="card skeleton-card" style="margin-top:12px">' +
      '<div class="sk sk-line w40"></div>' +
      '<div class="sk sk-block" style="margin-top:12px"></div>' +
      '</div>';
  }

  function detailStaffBlockHTML(staffObj, index, total, date) {
    var days = staffObj.days || [];
    var staff = staffObj.staff || {};
    var heroDay = null;
    for (var i = 0; i < days.length; i++) {
      if (days[i].date === date) { heroDay = days[i]; break; }
    }
    if (!heroDay && days.length) heroDay = days[0];

    var html = '';
    if (total > 1) {
      html += '<div class="section-head" style="margin-top:' + (index === 0 ? '14px' : '24px') + '">' +
        '<h3 class="section-title"><span class="tag-group">' + esc(staff.group) + '</span>' +
        esc(staff.name) + '</h3>' +
        '<span class="section-note">' + esc(groupText(staff.group)) + '</span></div>';
    } else {
      html += '<div class="detail-staff">' + staffHeadHTML(staff, heroDay ? heroDay.label : '') + '</div>';
    }

    var kicker = heroDay ? fmtMD(heroDay.date) + '（' + (heroDay.weekday || '') + '）' : '';
    html += heroHTML(heroDay, staff, {
      live: !!(heroDay && heroDay.date === state.today),
      kicker: kicker,
      multiStaff: total > 1
    });
    html += todayTimelineHTML(heroDay, '當日行程');

    var weekDays = days.filter(function (day) { return !heroDay || day.date !== heroDay.date; });
    html += sectionHeadHTML('接下來 7 天', '點日期看細節');
    html += weekHTML(weekDays, staff);
    return html;
  }

  function quickGridHTML() {
    var items = [
      { key: 'live', title: '值乘中', icon: 'bolt', color: 'green' },
      { key: 'who', title: '非值乘', icon: 'coffee', color: 'amber' },
      { key: 'leave', title: '放假', icon: 'moon', color: 'blue' }
    ];
    return '<div class="quick-grid">' + items.map(function (item) {
      return '<button class="quick-btn" type="button" data-action="quick" data-quick="' + item.key + '"' +
        ' aria-label="' + item.title + '">' +
        '<span class="quick-ico ' + item.color + '">' + icon(item.icon) + '</span>' +
        '<span class="quick-title">' + item.title + '</span></button>';
    }).join('') + '</div>';
  }

  function queryCTAHTML() {
    return '<button class="query-cta" type="button" data-action="go-search">' +
      '<span class="query-cta-main">' +
      '<span class="query-cta-title">' + icon('search', 'icon-sm') + '完整查詢</span>' +
      '<span class="query-cta-sub">姓名、車次、值乘、非值乘、放假</span></span>' +
      '<span class="query-cta-tiles">' +
      '<span class="query-tile">名</span><span class="query-tile">車</span>' +
      '<span class="query-tile">況</span><span class="query-tile">站</span></span>' +
      icon('chevron', 'chev') +
      '</button>';
  }

  // ============================================================
  // 查詢頁
  // ============================================================
  function renderSearch() {
    var s = state.search;
    var html = '<div class="view">' +
      '<div class="page-head">' +
      '<p class="page-kicker">SEARCH</p>' +
      '<h2 class="page-title">查詢</h2>' +
      '</div>' +
      searchTabsHTML() +
      '<form class="card form-card" id="searchForm" novalidate>' + searchFormHTML(s.tab) + '</form>' +
      '<div id="searchResults">' + searchResultsHTML() + '</div>' +
      '</div>';
    $('#main').innerHTML = html;
  }

  function searchTabsHTML() {
    var tabs = [
      { key: 'lookup', label: '班表' },
      { key: 'status', label: '狀態' }
    ];
    return '<div class="seg seg-2" role="tablist">' + tabs.map(function (t) {
      return '<button type="button" role="tab" data-action="search-tab" data-tab="' + t.key + '" ' +
        'class="' + (state.search.tab === t.key ? 'active' : '') + '">' + t.label + '</button>';
    }).join('') + '</div>';
  }

  function searchFormHTML(tab) {
    if (tab === 'status') return statusFormHTML();
    return lookupFormHTML();
  }

  function lookupFormHTML() {
    var s = state.search;
    return '<div class="field"><div class="label">姓名或車次</div>' +
      '<input class="input" type="text" data-field="lookup" list="staffOptions" ' +
      'value="' + esc(s.lookup) + '" placeholder="例如：小林、李美華 或 3178、3257" autocomplete="off" ' +
      'autocapitalize="off" spellcheck="false">' +
      lookupHintHTML() + '</div>' +
      dateFieldHTML() +
      dayRangeFieldHTML() +
      '<div class="field"><div class="label">顯示方式</div>' +
      '<div class="toggle">' +
      '<button type="button" data-action="set-mode" data-mode="detail" class="' + (s.mode === 'detail' ? 'active' : '') + '">完整</button>' +
      '<button type="button" data-action="set-mode" data-mode="simple" class="' + (s.mode === 'simple' ? 'active' : '') + '">精簡</button>' +
      '</div><div class="field-note">完整：班表含報到、中場、後整；車次含當日完整班表。精簡：只列車次或命中區段。</div></div>' +
      '<button class="btn-primary" type="submit">' + icon('search') + '查詢班表</button>';
  }

  function statusFormHTML() {
    var s = state.search;
    var isLeave = s.keyword === '放假';
    var isMid = s.keyword === '中場';
    var keywords = [
      { value: '值乘', label: '值乘' },
      { value: '中場', label: '非值乘' },
      { value: '放假', label: '放假' }
    ];
    return '<div class="field"><div class="label">查詢狀態</div>' +
      '<div class="seg seg-3">' + keywords.map(function (k) {
        return '<button type="button" data-action="set-keyword" data-keyword="' + k.value + '" ' +
          'class="' + (s.keyword === k.value ? 'active' : '') + '">' + k.label + '</button>';
      }).join('') + '</div></div>' +
      dateFieldHTML() +
      '<div class="field' + (isLeave ? ' hidden' : '') + '"><div class="label">時間 <span class="opt">留空 = 現在</span></div>' +
      '<div class="two-col">' +
      '<input class="input" type="time" data-field="startTime" value="' + esc(s.startTime) + '">' +
      '<input class="input" type="time" data-field="endTime" value="' + esc(s.endTime) + '">' +
      '</div>' +
      ((s.startTime || s.endTime) ? '<div class="chip-row"><button type="button" class="chip" data-action="clear-time">清除時間，改用現在</button></div>' : '') +
      '</div>' +
      (isLeave ? '<div class="field-note" style="margin-top:-4px">放假查詢不需要時間，會直接列出跨夜、休息日與例假。</div>' : '') +
      '<div class="field' + (isLeave ? ' hidden' : '') + '"><div class="label">車站 <span class="opt">選填</span></div>' +
      '<input class="input" type="text" data-field="station" list="stationOptions" ' +
      'value="' + esc(s.station) + '" placeholder="例如：嘉義；留空查全部" autocomplete="off">' +
      '<div class="field-note">' + (isMid
        ? '指定車站＝查詢該站非值乘（中場休息）的車長；留空則依車站分組列出。'
        : '值乘以起站比對；留空查全部。') + '</div></div>' +
      '<button class="btn-primary" type="submit">' + icon('clock') + '查詢狀態</button>';
  }

  function dateFieldHTML() {
    var s = state.search;
    var min = state.baseDate || addDaysISO(state.today, -3650);
    var max = addDaysISO(state.today, 365);
    var chips = [
      { label: '今天', date: state.today },
      { label: '明天', date: addDaysISO(state.today, 1) },
      { label: '後天', date: addDaysISO(state.today, 2) }
    ];
    return '<div class="field"><div class="label">日期</div>' +
      '<input class="input" type="date" data-field="date" value="' + esc(s.date) + '" ' +
      'min="' + esc(min) + '" max="' + esc(max) + '">' +
      '<div class="chip-row">' + chips.map(function (c) {
        return '<button type="button" class="chip' + (s.date === c.date ? ' active' : '') + '" ' +
          'data-action="set-search-date" data-date="' + c.date + '">' + c.label + '</button>';
      }).join('') + '</div></div>';
  }

  function findBootStaffName(term) {
    var target = String(term || '').trim().toLowerCase();
    if (!target) return '';
    var list = (state.boot && state.boot.staff) || [];
    for (var i = 0; i < list.length; i++) {
      var name = String(list[i].name || '').trim();
      if (name.toLowerCase() === target) return name;
    }
    return '';
  }

  var LOOKUP_SEPARATORS = /[\s,，、;；]+/;
  var MAX_LOOKUP_TOKENS = 10;

  function splitLookupTokens(text) {
    return String(text || '').split(LOOKUP_SEPARATORS)
      .map(function (token) { return token.trim(); })
      .filter(Boolean);
  }

  function uniqueTokens(tokens) {
    var seen = {};
    var out = [];
    tokens.forEach(function (token) {
      var key = token.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(token);
    });
    return out;
  }

  function analyzeLookup(text) {
    var tokens = uniqueTokens(splitLookupTokens(text));
    var info = { tokens: tokens, names: [], trains: [], kind: '', error: '' };
    if (!tokens.length) return info;
    if (tokens.length > MAX_LOOKUP_TOKENS) {
      info.error = '最多 ' + MAX_LOOKUP_TOKENS + ' 筆，目前 ' + tokens.length + ' 筆。';
      return info;
    }

    var exactNames = [];
    var otherNames = [];
    var trains = [];
    tokens.forEach(function (token) {
      var name = findBootStaffName(token);
      if (name) { exactNames.push(name); return; }
      if (/\d/.test(token)) { trains.push(token); return; }
      otherNames.push(token);
    });

    info.names = exactNames.concat(otherNames);
    info.trains = trains;
    if (info.names.length && info.trains.length) {
      info.error = '姓名與車次請分開查詢。';
      return info;
    }
    if (info.trains.length) info.kind = 'train';
    else if (info.names.length) info.kind = 'staff';
    return info;
  }

  function tokensLabel(tokens, max) {
    var list = tokens || [];
    max = max || 3;
    if (!list.length) return '';
    if (list.length <= max) return list.join('、');
    return list.slice(0, max).join('、') + ' 等 ' + list.length + ' 筆';
  }

  function lookupHintText(info) {
    if (info.error) return info.error;
    if (info.kind === 'staff') {
      return '將查詢 ' + info.names.length + ' 位車長：' + tokensLabel(info.names, 5);
    }
    if (info.kind === 'train') {
      return '將反查 ' + info.trains.length + ' 個車次：' + tokensLabel(info.trains, 5);
    }
    return '姓名看班表、車次反查車長；可用空格或逗號分隔多筆。';
  }

  function lookupHintHTML() {
    var info = analyzeLookup(state.search.lookup);
    return '<div class="field-note' + (info.error ? ' is-error' : '') + '" id="lookupHint">' +
      esc(lookupHintText(info)) + '</div>';
  }

  function updateLookupHint() {
    var el = $('#lookupHint');
    if (!el) return;
    var info = analyzeLookup(state.search.lookup);
    el.className = 'field-note' + (info.error ? ' is-error' : '');
    el.textContent = lookupHintText(info);
  }

  function searchDateList(start, days) {
    var count = parseInt(days, 10);
    if (isNaN(count) || count < 1) count = 1;
    count = Math.min(count, state.maxDays || 14);
    var dates = [];
    for (var i = 0; i < count; i++) dates.push(addDaysISO(start, i));
    return dates;
  }

  function searchRangeLabel(snap) {
    var days = snap.days || 1;
    if (days <= 1) return fmtFull(snap.date);
    return fmtMD(snap.date) + '–' +
      fmtMD(snap.endDate || addDaysISO(snap.date, days - 1)) +
      '（' + days + ' 天）';
  }

  // 順向／逆向：以 Station 工作表里程判斷，公里數大 → 小為順向，小 → 大為逆向；
  // 查不到里程時退回車次末碼（偶數順向、奇數逆向）。
  function stationKmValue(name) {
    var km = ((state.boot || {}).stationKms || {})[name];
    var n = km === undefined ? NaN : Number(km);
    return isFinite(n) ? n : NaN;
  }

  function trainDirection(train, from, to) {
    var kmFrom = stationKmValue(from);
    var kmTo = stationKmValue(to);
    if (isFinite(kmFrom) && isFinite(kmTo) && kmFrom !== kmTo) {
      return kmFrom > kmTo ? '順向' : '逆向';
    }
    var digits = String(train || '').match(/\d/g);
    if (!digits || !digits.length) return '';
    return Number(digits[digits.length - 1]) % 2 === 0 ? '順向' : '逆向';
  }

  function dayRangeFieldHTML() {
    var s = state.search;
    var max = state.maxDays || 14;
    var current = Math.max(1, Math.min(s.days || 1, max));
    var options = [1, 3, 7, 14].filter(function (n) { return n <= max; });
    if (!options.length) options = [1];
    var end = addDaysISO(s.date, current - 1);
    return '<div class="field"><div class="label">查詢天數 <span class="opt">從選定日期起</span></div>' +
      '<div class="chip-row">' + options.map(function (n) {
        return '<button type="button" class="chip' + (current === n ? ' active' : '') + '" ' +
          'data-action="set-days" data-days="' + n + '">' + n + ' 天</button>';
      }).join('') + '</div>' +
      (current > 1
        ? '<div class="field-note" id="dayRangeNote">' + fmtMD(s.date) + '–' + fmtMD(end) + '，共 ' + current + ' 天。</div>'
        : '') +
      '</div>';
  }

  function updateDayRangeNote() {
    var el = $('#dayRangeNote');
    if (!el) return;
    var days = Math.max(1, Math.min(state.search.days || 1, state.maxDays || 14));
    el.textContent = fmtMD(state.search.date) + '–' +
      fmtMD(addDaysISO(state.search.date, days - 1)) + '，共 ' + days + ' 天。';
  }

  function runSearch() {
    var s = state.search;
    var tab = s.tab;
    var lookup = String(s.lookup || '').trim();
    var action;
    var payload;
    var kind = '';
    var tokens = [];
    var dates = [s.date];
    var days = 1;

    if (tab === 'lookup') {
      if (!lookup) {
        toast('請先輸入姓名或車次');
        focusField('lookup');
        return;
      }
      var info = analyzeLookup(lookup);
      if (info.error) {
        updateLookupHint();
        toast(info.error, true);
        focusField('lookup');
        return;
      }
      if (!info.kind) {
        toast('請輸入姓名或車次');
        focusField('lookup');
        return;
      }
      days = Math.max(1, Math.min(parseInt(s.days, 10) || 1, state.maxDays || 14));
      s.days = days;
      dates = searchDateList(s.date, days);
      kind = info.kind;
      tokens = info.kind === 'train' ? info.trains : info.names;
      if (info.kind === 'train') {
        action = 'trainLookup';
        payload = { trains: info.trains, dates: dates, mode: s.mode };
      } else {
        action = 'staffSchedule';
        payload = { names: info.names, dates: dates, mode: s.mode };
      }
    } else if (tab === 'status') {
      action = 'status';
      payload = {
        keyword: s.keyword,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        station: s.station
      };
    } else {
      return;
    }

    var snap = {
      tab: tab,
      kind: kind,
      mode: s.mode,
      date: s.date,
      days: days,
      endDate: days > 1 ? dates[dates.length - 1] : s.date,
      lookup: lookup,
      tokens: tokens,
      keyword: s.keyword,
      startTime: s.startTime,
      endTime: s.endTime,
      station: String(s.station || '').trim(),
      train: kind === 'train' ? tokens.join('、') : ''
    };

    var seq = ++searchSeq;
    s.loading = true;
    s.error = '';
    s.result = null;
    renderSearchResults();

    api(action, payload).then(function (data) {
      if (seq !== searchSeq) return;
      s.loading = false;
      s.result = { tab: tab, snap: snap, data: data };
      renderSearchResults();
      var target = $('#searchResults');
      if (target) {
        setTimeout(function () {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
      }
    }).catch(function (err) {
      if (seq !== searchSeq) return;
      s.loading = false;
      s.error = err.message;
      renderSearchResults();
      toast('查詢失敗：' + err.message, true);
    });
  }

  function focusField(field) {
    var el = document.querySelector('[data-field="' + field + '"]');
    if (el) {
      el.focus();
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
    }
  }

  function renderSearchResults() {
    var el = $('#searchResults');
    if (el) el.innerHTML = searchResultsHTML();
  }

  function searchResultsHTML() {
    var s = state.search;
    if (s.loading) return resultsLoadingHTML();
    if (s.error) {
      return '<div class="results">' +
        errorCardHTML('查詢失敗', s.error, 'retry-search') +
        '</div>';
    }
    if (!s.result || s.result.tab !== s.tab) {
      return '<div class="results"><div class="hint-card">' +
        '<span class="empty-ico">' + icon('search') + '</span>' +
        '<span>輸入條件後按查詢，結果會顯示在這裡。</span>' +
        '</div></div>';
    }

    var r = s.result;
    if (r.tab === 'lookup') {
      return r.snap.kind === 'train'
        ? trainResultsHTML(r.snap, r.data)
        : staffResultsHTML(r.snap, r.data);
    }
    if (r.tab === 'status') return statusResultsHTML(r.snap, r.data);
    return '';
  }

  function resultsHeadHTML(title, meta) {
    return '<div class="results-head"><div class="results-title">' + esc(title) + '</div>' +
      '<div class="results-meta">' + esc(meta) + '</div></div>';
  }

  function staffResultsHTML(snap, data) {
    var modeLabel = snap.mode === 'detail' ? '詳細' : '簡單';
    var label = tokensLabel(snap.tokens);
    var html = '<div class="results">' +
      resultsHeadHTML('班表查詢', (label ? label + ' · ' : '') + modeLabel + ' · ' + searchRangeLabel(snap));

    (data.days || []).forEach(function (day) {
      html += '<div class="card result-card">' +
        '<div class="result-date">' + icon('calendar') + fmtFull(day.date) + '</div>';
      if (!day.staffs || !day.staffs.length) {
        html += emptyHTML('查無符合條件的車長。');
      } else {
        day.staffs.forEach(function (d, index) {
          if (index > 0) html += '<div class="divider-label">第 ' + (index + 1) + ' 位車長</div>';
          html += staffDayBodyHTML(d);
        });
      }
      html += '</div>';
    });

    if (data.missing && data.missing.length) {
      html += '<div class="card result-card">' +
        '<div class="divider-label">未找到</div>' +
        '<ul class="missing-list">' + data.missing.map(function (m) {
          return '<li><strong>' + esc(m.name) + '</strong> — ' +
            (m.reason === 'noSchedule'
              ? '有 Staff 資料，但所屬群組沒有 Schedule_S 班表。'
              : '查無此車長姓名。') +
            '</li>';
        }).join('') + '</ul></div>';
    }

    if (!data.days || !data.days.length) {
      html += '<div class="card result-card">' + emptyHTML('查無班表資料。') + '</div>';
    }
    return html + '</div>';
  }

  function staffDayBodyHTML(d) {
    var staff = d.staff || {};
    var html = staffHeadHTML(staff, d.label);
    html += '<div class="result-body">';
    if (d.kind === 'leave') {
      html += '<div class="leave-box">' + icon('moon') +
        '<div class="leave-box-main"><div class="leave-box-title">' + esc(d.label || d.leaveCategory || '放假') + '</div>' +
        '<div class="leave-box-sub">' + esc(d.leaveCategory || '休假') + ' · ' + esc(d.leaveRange || '全天') + '</div></div></div>';
    } else if (d.kind === 'work') {
      if (d.segments && d.segments.length) {
        html += timelineHTML(d.segments, false);
      } else {
        html += '<div class="tl-empty">查無班次資料</div>';
      }
    } else {
      html += '<div class="tl-empty">查無班表</div>';
    }
    html += '</div>';
    return html;
  }

  function statusResultsHTML(snap, data) {
    var title = data.isLeave ? '放假名單' : data.displayName;
    var total = (data.dates || []).reduce(function (n, d) { return n + d.count; }, 0);
    var station = !data.isLeave && data.station ? ' · ' + data.station : '';
    var meta = total + ' 人' + station + ' · ' + fmtFull(snap.date);

    var html = '<div class="results">' + resultsHeadHTML(title, meta);

    (data.dates || []).forEach(function (block) {
      html += '<div class="card result-card">' +
        '<div class="result-date">' + icon('calendar') + fmtFull(block.date) +
        (block.timeLabel
          ? '<span class="pill ' + (data.isLeave ? 'blue' : 'green') + '">' + esc(block.timeLabel) + '</span>'
          : '<span class="pill blue">全天</span>') +
        '</div>';

      if (!block.count) {
        html += emptyHTML(data.isLeave
          ? '這天沒有符合條件的放假名單。'
          : '這個時段沒有符合條件的車長。');
      } else {
        block.groups.forEach(function (group) {
          if (group.title) {
            html += '<div class="group-head">' + esc(group.title) +
              '<span class="group-count">' + group.hits.length + '</span></div>';
          }
          group.hits.forEach(function (hit) {
            html += statusHitHTML(hit, snap);
          });
        });
      }
      html += '</div>';
    });

    if (!data.dates || !data.dates.length) {
      html += '<div class="card result-card">' + emptyHTML('查無資料。') + '</div>';
    }
    return html + '</div>';
  }

  function statusHitHTML(hit, snap) {
    var isTrain = snap.keyword === '值乘';
    var shift = hit.shiftLabel || '';
    return '<div class="hit">' +
      '<span class="avatar sm">' + esc(initialOf(hit.staff.name)) + '</span>' +
      '<div class="hit-main">' +
      '<div class="hit-person"><strong>' + esc(hit.staff.name) + '</strong>' +
      '<span class="tag-group">' + esc(hit.staff.group) + '</span>' +
      (shift ? '<span class="staff-shift">' + esc(shift) + '</span>' : '') +
      '</div>' +
      '<div class="hit-title">' +
      (isTrain ? '<span class="train-badge">' + esc(hit.title) + '</span>' : esc(hit.title)) +
      '</div>' +
      (hit.subtitle ? '<div class="hit-sub">' + esc(hit.subtitle) + '</div>' : '') +
      (hit.note ? '<span class="hit-note">' + esc(hit.note) + '</span>' : '') +
      '</div>' +
      '<div class="hit-time">' + esc(hit.time) + '</div>' +
      '</div>';
  }

  function trainResultsHTML(snap, data) {
    var days = data.days || [];
    var unique = {};
    var hitKeys = {};

    days.forEach(function (day) {
      (day.hits || []).forEach(function (hit) {
        unique[hit.staff.group + '_' + hit.staff.name] = true;
        (hit.matched || []).forEach(function (m) {
          hitKeys[String(m.title || '').toLowerCase()] = true;
        });
      });
    });

    var people = Object.keys(unique).length;
    var label = tokensLabel(snap.tokens) || snap.train || '';
    var html = '<div class="results">' +
      resultsHeadHTML('車次反查', label + ' · ' + people + ' 位車長 · ' + searchRangeLabel(snap));

    days.forEach(function (day) {
      html += '<div class="card result-card">' +
        '<div class="result-date">' + icon('calendar') + fmtFull(day.date) + '</div>';
      if (!day.hits.length) {
        html += emptyHTML('這天沒有車長操作「' + label + '」。');
      } else {
        day.hits.forEach(function (hit, index) {
          if (index > 0) html += '<div class="divider-label">第 ' + (index + 1) + ' 位車長</div>';
          html += staffHeadHTML(hit.staff, hit.shiftLabel);
          html += '<div class="result-body">';
          hit.matched.forEach(function (m) {
            html += '<div class="matched-row">' +
              '<span class="train-badge">' + esc(m.title) + '</span>' +
              '<div class="matched-main"><div class="matched-route">' + esc(m.station) + ' → ' + esc(m.toStation || '') + '</div></div>' +
              '<span class="matched-time">' + esc(m.start) + '–' + esc(m.end) +
              (m.endDayOffset ? ' +' + m.endDayOffset : '') + '</span></div>';
          });
          if (snap.mode === 'detail' && hit.day) {
            html += '<div class="divider-label">當日完整班表</div>' + timelineHTML(hit.day.segments, true);
          }
          html += '</div>';
        });
      }
      html += '</div>';
    });

    if (!days.length) {
      html += '<div class="card result-card">' + emptyHTML('查無車次資料。') + '</div>';
    }

    var missed = (snap.tokens || []).filter(function (token) {
      return !hitKeys[String(token).toLowerCase()];
    });
    if (missed.length && (snap.tokens || []).length > 1) {
      html += '<div class="card result-card">' +
        '<div class="divider-label">未命中車次</div>' +
        '<div class="result-note">' + esc(missed.join('、')) + '</div></div>';
    }

    return html + '</div>';
  }

  function staffHeadHTML(staff, shift) {
    return '<div class="staff-head">' +
      '<span class="avatar">' + esc(initialOf(staff.name)) + '</span>' +
      '<div class="staff-head-main">' +
      '<div class="staff-name">' + esc(staff.name) +
      '<span class="tag-group">' + esc(staff.group) + '</span></div>' +
      '<div class="staff-sub">' + esc(groupText(staff.group)) + '</div>' +
      '</div>' +
      (shift ? '<span class="staff-shift">' + esc(shift) + '</span>' : '') +
      '</div>';
  }

  function resultsLoadingHTML() {
    return '<div class="results">' +
      '<div class="card result-card">' +
      '<div class="sk sk-line w40"></div>' +
      '<div class="sk sk-line w60" style="margin-top:10px"></div>' +
      '<div class="sk sk-block" style="margin-top:14px"></div>' +
      '<div class="sk sk-line w80" style="margin-top:12px"></div>' +
      '</div></div>';
  }

  function emptyHTML(message) {
    return '<div class="empty-state">' +
      '<div class="empty-ico">' + icon('empty') + '</div>' +
      '<div class="empty-title">沒有資料</div>' + esc(message) + '</div>';
  }

  function errorCardHTML(title, message, retryAction) {
    return '<div class="error-card"><strong>' + esc(title) + '</strong>' + esc(message) +
      (retryAction ? '<button type="button" data-action="' + retryAction + '">重新載入</button>' : '') +
      '</div>';
  }

  var mySeq = 0;
  var searchSeq = 0;

  // ============================================================
  // 全部車次頁
  // ============================================================
  function renderTrains() {
    var t = state.trains;
    var min = state.baseDate || addDaysISO(state.today, -3650);
    var max = addDaysISO(state.today, 365);
    var todayLabel = isToday(t.date) ? '今天' : '週' + weekdayOf(t.date);

    var html = '<div class="view">' +
      '<div class="page-head">' +
      '<p class="page-kicker">TRAINS</p>' +
      '<h2 class="page-title">全部車次</h2>' +
      '<p class="page-sub">依開車時間排序，同時間再依起站、抵達時間排列</p>' +
      '</div>' +
      '<div class="date-nav">' +
      '<button class="icon-btn" type="button" data-action="train-prev" aria-label="前一天">' +
      icon('chevron', 'flip') + '</button>' +
      '<div class="date-nav-center">' +
      '<div class="date-nav-main">' + fmtMD(t.date) +
      ' <span class="week-wd" style="margin-top:0">' + esc(todayLabel) + '</span></div>' +
      '<div class="date-nav-sub" id="trainNavSub">' + esc(trainNavSub()) + '</div>' +
      '<input type="date" data-field="trainDate" value="' + esc(t.date) + '" ' +
      'min="' + esc(min) + '" max="' + esc(max) + '" aria-label="選擇日期">' +
      '</div>' +
      '<button class="icon-btn" type="button" data-action="train-next" aria-label="後一天">' +
      icon('chevron') + '</button>' +
      (isToday(t.date) ? '' : '<button class="today-chip" type="button" data-action="train-today">今天</button>') +
      '</div>' +
      '<div class="filters card" style="padding:12px">' +
      '<div class="search-wrap">' + icon('search') +
      '<input class="input" type="search" data-field="trainQ" value="' + esc(t.q) + '" ' +
      'placeholder="搜尋車次、車站或車長" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '</div>' +
      '<div class="filter-grid">' +
      '<label class="filter-box"><span class="filter-label">起站</span>' +
      '<select class="select" data-field="trainFrom" aria-label="篩選起站">' +
      stationOptionsHTML(t.from, '全部起站') + '</select></label>' +
      '<label class="filter-box"><span class="filter-label">迄站</span>' +
      '<select class="select" data-field="trainTo" aria-label="篩選迄站">' +
      stationOptionsHTML(t.to, '全部迄站') + '</select></label>' +
      '<label class="filter-box"><span class="filter-label">方向</span>' +
      '<select class="select" data-field="trainDirection" aria-label="篩選方向">' +
      directionOptionsHTML(t.direction) + '</select></label>' +
      '<label class="filter-box filter-box-switch"><span class="filter-label">開車狀態</span>' +
      '<span class="switch"><input type="checkbox" data-field="trainUpcoming"' +
      (t.upcoming ? ' checked' : '') + '><span class="track"></span>只看未開</span></label>' +
      '</div>' +
      '</div>' +
      '<div class="list-meta"><span id="trainMeta">' + esc(trainMetaText()) + '</span>' +
      '<button class="chip" type="button" data-action="retry-trains">' +
      icon('refresh', 'icon-sm') + '重新整理</button></div>' +
      '<div id="trainList">' + trainListHTML() + '</div>' +
      '</div>';

    $('#main').innerHTML = html;
  }

  function trainNavSub() {
    var t = state.trains;
    if (t.loading && !t.data) return '載入中…';
    if (t.error && !t.data) return '載入失敗';
    if (!t.data) return '';
    return '共 ' + t.data.count + ' 班';
  }

  function trainMetaText() {
    var t = state.trains;
    if (!t.data) return t.loading ? '正在讀取車次…' : '—';
    var total = t.data.trains.length;
    var shown = filteredTrains().length;
    if (shown === total) return '共 ' + total + ' 班';
    return '顯示 ' + shown + ' / ' + total + ' 班';
  }

  function stationOptionsHTML(selected, placeholder) {
    var stations = (state.boot && state.boot.stations) || [];
    var html = '<option value="">' + esc(placeholder) + '</option>';
    stations.forEach(function (name) {
      html += '<option value="' + esc(name) + '"' +
        (selected === name ? ' selected' : '') + '>' + esc(name) + '</option>';
    });
    return html;
  }

  function directionOptionsHTML(selected) {
    var options = [
      { value: '', label: '全部方向' },
      { value: '順向', label: '順向' },
      { value: '逆向', label: '逆向' }
    ];
    return options.map(function (option) {
      return '<option value="' + esc(option.value) + '"' +
        (selected === option.value ? ' selected' : '') + '>' + esc(option.label) + '</option>';
    }).join('');
  }

  function refreshStationFilters() {
    var from = $('[data-field="trainFrom"]');
    if (from) {
      from.innerHTML = stationOptionsHTML(state.trains.from, '全部起站');
      from.value = state.trains.from || '';
    }
    var to = $('[data-field="trainTo"]');
    if (to) {
      to.innerHTML = stationOptionsHTML(state.trains.to, '全部迄站');
      to.value = state.trains.to || '';
    }
  }

  function filteredTrains() {
    var t = state.trains;
    if (!t.data) return [];
    var q = String(t.q || '').trim().toLowerCase();
    var from = t.from || '';
    var to = t.to || '';
    var direction = t.direction || '';
    var now = nowMs();
    var onlyUpcoming = t.upcoming && isToday(t.date);

    return t.data.trains.filter(function (tr) {
      if (onlyUpcoming && tr.startMs < now) return false;
      if (from && tr.from !== from) return false;
      if (to && tr.to !== to) return false;
      if (direction && trainDirection(tr.train, tr.from, tr.to) !== direction) return false;
      if (!q) return true;
      var hay = (tr.train + ' ' + tr.from + ' ' + tr.to + ' ' +
        tr.staff.name + ' ' + (tr.staff.group || '') + ' ' + (tr.shiftLabel || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function trainListHTML() {
    var t = state.trains;

    if (t.loading && !t.data) {
      return '<div class="card train-card" style="padding:16px">' +
        '<div class="sk sk-line w40"></div>' +
        '<div class="sk sk-block" style="margin-top:14px"></div>' +
        '<div class="sk sk-block" style="margin-top:10px"></div>' +
        '<div class="sk sk-block" style="margin-top:10px"></div>' +
        '</div>';
    }

    if (t.error && !t.data) {
      return errorCardHTML('車次載入失敗', t.error, 'retry-trains');
    }

    var rows = filteredTrains();
    if (!rows.length) {
      return '<div class="card">' + emptyHTML(
        t.data && t.data.trains.length
          ? '沒有符合篩選條件的車次，換個關鍵字或車站試試。'
          : '這個日期沒有車次資料。'
      ) + '</div>';
    }

    var now = nowMs();
    var hasFuture = rows.some(function (tr) { return tr.startMs > now; });
    var showNow = isToday(t.date) && !t.upcoming && hasFuture;
    var nowPlaced = false;
    var lastHour = null;
    var html = '<div class="card train-card">';

    rows.forEach(function (tr) {
      var hour = String(tr.start || '').slice(0, 2);
      if (hour !== lastHour) {
        html += '<div class="hour-head">' + esc(hour) + ':00</div>';
        lastHour = hour;
      }
      if (showNow && !nowPlaced && tr.startMs > now) {
        html += '<div class="now-line">現在 ' + esc(hhmmOf(now)) + '</div>';
        nowPlaced = true;
      }
      html += trainRowHTML(tr);
    });

    return html + '</div>';
  }

  function trainRowHTML(tr) {
    var end = tr.end + (tr.endDayOffset ? ' (+' + tr.endDayOffset + ')' : '');
    var group = tr.staff.group ? groupText(tr.staff.group) : '';
    return '<button class="train-row" type="button" data-action="open-staff-day"' +
      ' data-name="' + esc(tr.staff.name) + '" data-group="' + esc(tr.staff.group || '') + '"' +
      ' data-date="' + esc(state.trains.date) + '"' +
      ' aria-label="查看 ' + esc(tr.staff.name) + ' ' + esc(fmtMD(state.trains.date)) + ' 的完整班表">' +
      '<span class="train-time">' + esc(tr.start) +
      (tr.endDayOffset ? '<small>+' + tr.endDayOffset + '</small>' : '') + '</span>' +
      '<span class="train-main">' +
      '<span class="train-line">' +
      '<span class="train-badge">' + esc(tr.train) + '</span>' +
      esc(tr.from || '—') + '<span class="arrow">→</span>' + esc(tr.to || '—') +
      '</span>' +
      '<span class="train-route">' + esc(end) + ' 到 · 車長 ' + esc(tr.staff.name) + '</span>' +
      '</span>' +
      '<span class="train-meta">' +
      '<span class="train-staff">' + esc(tr.shiftLabel || '—') + '</span>' +
      (group ? '<span class="train-shift">' + esc(group) + '</span>' : '') +
      '</span></button>';
  }

  function updateTrainList() {
    var sub = $('#trainNavSub');
    if (sub) sub.textContent = trainNavSub();
    var meta = $('#trainMeta');
    if (meta) meta.textContent = trainMetaText();
    var list = $('#trainList');
    if (list) list.innerHTML = trainListHTML();
  }

  // 畫面直接移到「現在」的位置（僅今天且有現在時間線時）
  function scrollToNowLine() {
    var line = $('#trainList .now-line');
    if (!line) return;
    try {
      line.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      try { line.scrollIntoView(true); } catch (e2) { /* ignore */ }
    }
  }

  function loadTrains(force) {
    var t = state.trains;
    var date = t.date;

    if (!force && t.cache[date]) {
      t.data = t.cache[date];
      t.loading = false;
      t.error = '';
      if (state.view === 'trains') {
        updateTrainList();
        scrollToNowLine();
      }
      return;
    }

    t.loading = true;
    t.error = '';
    t.data = force ? null : (t.cache[date] || null);
    if (state.view === 'trains') updateTrainList();

    api('allTrains', { date: date }).then(function (data) {
      if (state.trains.date !== date) return;
      state.trains.loading = false;
      state.trains.error = '';
      state.trains.data = data;
      state.trains.cache[date] = data;
      if (state.view === 'trains') {
        updateTrainList();
        scrollToNowLine();
      }
    }).catch(function (err) {
      if (state.trains.date !== date) return;
      state.trains.loading = false;
      state.trains.error = err.message;
      if (state.view === 'trains') updateTrainList();
      toast('車次載入失敗：' + err.message, true);
    });
  }

  function goTrainDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
    var base = state.baseDate || '';
    if (base && date < base) {
      toast('無法查詢基準日（' + base + '）以前的班表');
      return false;
    }
    var max = addDaysISO(state.today, 365);
    if (date > max) {
      toast('最多只能查詢未來一年');
      return false;
    }
    state.trains.date = date;
    state.trains.error = '';
    state.trains.data = state.trains.cache[date] || null;
    if (state.view === 'trains') renderTrains();
    loadTrains(false);
    return true;
  }

  // ============================================================
  // 姓名底部面板
  // ============================================================
  function renderNameSheet() {
    var root = $('#sheetRoot');
    if (!root) return;

    if (!state.sheet) {
      root.innerHTML = '';
      document.body.style.overflow = '';
      return;
    }

    document.body.style.overflow = 'hidden';
    root.innerHTML = '<div class="sheet-backdrop" data-action="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">' +
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-head"><div>' +
      '<h2 class="sheet-title" id="sheetTitle">設定姓名</h2>' +
      '<p class="sheet-sub">選一次就記住，下次打開直接看班表</p>' +
      '</div>' +
      '<button class="sheet-close" type="button" data-action="close-sheet" aria-label="關閉">' +
      icon('close') + '</button></div>' +
      '<div class="sheet-search"><div class="search-wrap">' + icon('search') +
      '<input class="input" id="nameSearch" type="search" placeholder="搜尋姓名" ' +
      'autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '</div></div>' +
      '<div class="sheet-body" id="nameList">' + nameListHTML('') + '</div>' +
      (state.name
        ? '<div class="sheet-footer"><button class="btn-ghost" type="button" data-action="clear-name">' +
          '清除姓名（' + esc(state.name) + '）</button></div>'
        : '') +
      '</div>';

    setTimeout(function () {
      var input = $('#nameSearch');
      if (input && state.sheet) input.focus();
    }, 80);
  }

  function uniqueStaffList() {
    var map = {};
    var list = [];
    ((state.boot && state.boot.staff) || []).forEach(function (s) {
      if (!map[s.name]) {
        map[s.name] = { name: s.name, groups: [] };
        list.push(map[s.name]);
      }
      if (map[s.name].groups.indexOf(s.group) < 0) map[s.name].groups.push(s.group);
    });
    return list;
  }

  function nameListHTML(query) {
    if (!state.boot) {
      if (!state.bootError) return '<div class="sheet-empty">名單載入中…</div>';
      return '<div class="sheet-empty">名單載入失敗<br>' +
        '<button class="chip" type="button" data-action="retry-boot" style="margin-top:10px">重新載入</button>' +
        '</div>';
    }

    var q = String(query || '').trim();
    var lower = q.toLowerCase();
    var all = uniqueStaffList();
    var list = !lower ? all : all.filter(function (s) {
      return s.name.toLowerCase().indexOf(lower) >= 0;
    });
    var exact = all.some(function (s) { return s.name === q; });
    var html = '';

    list.forEach(function (s) {
      html += staffRowHTML(
        s.name,
        s.groups.map(groupText).join(' · '),
        state.name === s.name
      );
    });

    if (!list.length) {
      html += '<div class="sheet-empty">' + (q ? '名單裡沒有符合的姓名' : '目前沒有車長名單') + '</div>';
    }

    if (q && !list.length && !exact) {
      html += staffRowHTML(q, '直接使用這個名稱', state.name === q);
    }

    return html;
  }

  function staffRowHTML(name, note, selected) {
    return '<button class="staff-row' + (selected ? ' selected' : '') + '" type="button" ' +
      'data-action="pick-name" data-name="' + esc(name) + '">' +
      '<span class="avatar">' + esc(initialOf(name)) + '</span>' +
      '<span class="staff-row-main">' +
      '<span class="staff-row-name">' + esc(name) + '</span>' +
      '<span class="staff-row-group">' + esc(note || '') + '</span>' +
      '</span>' +
      (selected ? '<span class="check">' + icon('check') + '</span>' : '') +
      '</button>';
  }

  function renderNameList(query) {
    var el = $('#nameList');
    if (el) el.innerHTML = nameListHTML(query);
  }

  // ============================================================
  // 頁面切換與事件
  // ============================================================
  function setActiveTab(view) {
    $$('.tab').forEach(function (tab) {
      var active = tab.getAttribute('data-nav') === view;
      tab.classList.toggle('active', active);
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
  }

  function switchView(view) {
    if (view !== 'home' && view !== 'search' && view !== 'trains') return;
    state.view = view;
    state.detail.open = false;
    state.sheet = false;
    renderNameSheet();
    setActiveTab(view);

    // 資料載入等 bootstrap（server 日期／名單）完成再開始
    if (view === 'home') {
      renderHome();
      ensureBootstrap().then(function (data) {
        if (!data) return;
        if (state.name && !state.my && !state.myLoading) loadMySchedule();
        if (state.name) loadMonthSchedule(false);
        loadAllSchedules(false);
      });
    } else if (view === 'search') {
      renderSearch();
    } else {
      renderTrains();
      ensureBootstrap().then(function (data) {
        if (!data) return;
        loadTrains(false);
      });
    }

    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    if (view === 'trains') scrollToNowLine();
  }

  function quickLookup(key) {
    var s = state.search;
    s.startTime = '';
    s.endTime = '';
    s.station = '';
    s.loading = false;
    s.error = '';
    s.result = null;
    s.date = state.today;

    s.tab = 'status';
    s.keyword = key === 'who' ? '中場' : key === 'leave' ? '放假' : '值乘';
    switchView('search');
    runSearch();
  }

  function cancelSearch() {
    searchSeq++;
    state.search.loading = false;
  }

  function goSearchTab(tab) {
    var s = state.search;
    cancelSearch();
    s.tab = tab;
    s.error = '';
    s.result = null;
    renderSearch();
  }

  function syncDateChips() {
    $$('.chip[data-action="set-search-date"]').forEach(function (chip) {
      chip.classList.toggle('active', chip.getAttribute('data-date') === state.search.date);
    });
  }

  function actionElement(node) {
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-action')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function onDocumentClick(event) {
    var el = actionElement(event.target);
    if (!el) return;
    handleAction(el.getAttribute('data-action'), el);
  }

  function handleAction(action, el) {
    var s = state.search;
    var t = state.trains;

    switch (action) {
      case 'open-name':
        state.sheet = true;
        renderNameSheet();
        return;

      case 'close-sheet':
        state.sheet = false;
        renderNameSheet();
        return;

      case 'clear-name':
        mySeq++;
        detailSeq++;
        state.name = '';
        writeName('');
        state.my = null;
        state.myLoading = false;
        state.myError = '';
        state.month.month = monthKeyOf(state.today);
        state.month.key = '';
        state.month.data = null;
        state.month.loading = false;
        state.month.error = '';
        s.lookup = '';
        s.result = null;
        s.error = '';
        state.sheet = false;
        renderNameSheet();
        updateNameChip();
        if (state.view === 'detail') switchView('home');
        else if (state.view === 'home') renderHome();
        else if (state.view === 'search') renderSearch();
        toast('已清除姓名');
        return;

      case 'pick-name': {
        var name = String(el.getAttribute('data-name') || '').trim();
        if (!name) return;
        state.name = name;
        writeName(name);
        state.my = null;
        state.myLoading = false;
        state.myError = '';
        state.month.month = monthKeyOf(state.today);
        state.month.key = '';
        state.month.data = null;
        state.month.loading = false;
        state.month.error = '';
        s.lookup = name;
        s.result = null;
        s.error = '';
        state.sheet = false;
        renderNameSheet();
        updateNameChip();
        if (state.view === 'detail') {
          switchView('home');
        } else {
          if (state.view === 'home') renderHome();
          else if (state.view === 'search') renderSearch();
          loadMySchedule();
          loadMonthSchedule(false);
        }
        toast('已設定為「' + name + '」');
        return;
      }

      case 'toggle-week': {
        var key = el.getAttribute('data-key') || '';
        var open = !state.expanded[key];
        state.expanded[key] = open;
        el.setAttribute('aria-expanded', String(open));
        var item = el.parentNode;
        var box = item ? item.querySelector('.week-expand') : null;
        if (box) box.classList.toggle('hidden', !open);
        return;
      }

      case 'refresh-my':
        if (!state.name) {
          state.sheet = true;
          renderNameSheet();
          return;
        }
        loadMySchedule();
        return;

      case 'retry-my':
        loadMySchedule();
        return;

      case 'retry-boot':
        state.bootError = '';
        ensureBootstrap().then(function (data) {
          if (data) loadHomeData();
        });
        return;

      case 'retry-search':
        runSearch();
        return;

      case 'retry-trains':
        loadTrains(true);
        return;

      case 'quick':
        quickLookup(el.getAttribute('data-quick'));
        return;

      case 'go-search':
        switchView('search');
        return;

      case 'search-tab':
        goSearchTab(el.getAttribute('data-tab') || 'lookup');
        return;

      case 'set-search-date':
        cancelSearch();
        s.date = el.getAttribute('data-date') || state.today;
        s.error = '';
        s.result = null;
        renderSearch();
        return;

      case 'set-days':
        cancelSearch();
        s.days = Math.max(1, Math.min(parseInt(el.getAttribute('data-days'), 10) || 1, state.maxDays || 14));
        s.error = '';
        s.result = null;
        renderSearch();
        return;

      case 'set-mode':
        s.mode = el.getAttribute('data-mode') === 'simple' ? 'simple' : 'detail';
        renderSearch();
        return;

      case 'set-keyword':
        cancelSearch();
        s.keyword = el.getAttribute('data-keyword') || '值乘';
        s.error = '';
        s.result = null;
        renderSearch();
        return;

      case 'clear-time':
        s.startTime = '';
        s.endTime = '';
        renderSearch();
        return;

      case 'train-prev':
        goTrainDate(addDaysISO(t.date, -1));
        return;

      case 'train-next':
        goTrainDate(addDaysISO(t.date, 1));
        return;

      case 'train-today':
        goTrainDate(state.today);
        return;

      case 'month-prev':
        goMonth(shiftMonthKey(state.month.month, -1));
        return;

      case 'month-next':
        goMonth(shiftMonthKey(state.month.month, 1));
        return;

      case 'month-current':
        goMonth(monthKeyOf(state.today));
        return;

      case 'refresh-month':
      case 'retry-month':
        loadMonthSchedule(true);
        return;

      case 'all-prev':
        goAllDate(addDaysISO(state.allSched.date, -1));
        return;

      case 'all-next':
        goAllDate(addDaysISO(state.allSched.date, 1));
        return;

      case 'all-today':
        goAllDate(state.today);
        return;

      case 'refresh-all':
      case 'retry-all':
        loadAllSchedules(true);
        return;

      case 'sort-all': {
        var sortKey = el.getAttribute('data-sort') || 'number';
        if (state.allSched.sort === sortKey) {
          state.allSched.dir = state.allSched.dir > 0 ? -1 : 1;
        } else {
          state.allSched.sort = sortKey;
          state.allSched.dir = 1;
        }
        updateAllSchedulesSection();
        return;
      }

      case 'open-staff-day':
        openStaffDetail(
          el.getAttribute('data-name'),
          el.getAttribute('data-group'),
          el.getAttribute('data-date'),
          state.view
        );
        return;

      case 'close-detail':
        closeStaffDetail();
        return;

      case 'retry-detail':
        loadDetail();
        return;
    }
  }

  function onDocumentSubmit(event) {
    if (!event.target || event.target.id !== 'searchForm') return;
    event.preventDefault();
    runSearch();
  }

  function onDocumentInput(event) {
    var el = event.target;
    if (!el) return;

    if (el.id === 'nameSearch') {
      renderNameList(el.value);
      return;
    }

    var field = el.getAttribute('data-field');
    if (!field) return;

    if (field === 'trainQ') {
      state.trains.q = el.value;
      updateTrainList();
      return;
    }

    if (field === 'lookup') {
      state.search.lookup = el.value;
      updateLookupHint();
      return;
    }

    if (field === 'date' || field === 'startTime' ||
        field === 'endTime' || field === 'station') {
      state.search[field] = el.value;
    }
  }

  function onDocumentChange(event) {
    var el = event.target;
    if (!el) return;
    var field = el.getAttribute('data-field');

    if (field === 'allDate') {
      if (el.value && el.value !== state.allSched.date) {
        if (!goAllDate(el.value)) el.value = state.allSched.date;
      } else {
        el.value = state.allSched.date;
      }
      return;
    }

    if (field === 'trainDate') {
      if (el.value && el.value !== state.trains.date) {
        if (!goTrainDate(el.value)) el.value = state.trains.date;
      }
      return;
    }

    if (field === 'trainFrom') {
      state.trains.from = el.value;
      updateTrainList();
      return;
    }

    if (field === 'trainTo') {
      state.trains.to = el.value;
      updateTrainList();
      return;
    }

    if (field === 'trainDirection') {
      state.trains.direction = el.value;
      updateTrainList();
      return;
    }

    if (field === 'trainUpcoming') {
      state.trains.upcoming = !!el.checked;
      updateTrainList();
      return;
    }

    if (field === 'date') {
      if (!el.value) return;
      cancelSearch();
      state.search.date = el.value;
      state.search.error = '';
      state.search.result = null;
      syncDateChips();
      updateDayRangeNote();
      renderSearchResults();
    }
  }

  function onDocumentKeydown(event) {
    var key = event.key;
    if (key === 'Escape' || key === 'Esc') {
      if (state.sheet) {
        state.sheet = false;
        renderNameSheet();
      } else if (state.detail.open) {
        closeStaffDetail();
      }
      return;
    }

    if (key !== 'Enter') return;
    if (!event.target || event.target.id !== 'nameSearch') return;
    event.preventDefault();
    var first = $('#nameList [data-action="pick-name"]');
    if (first) handleAction('pick-name', first);
  }

  function bindEvents() {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('submit', onDocumentSubmit);
    document.addEventListener('input', onDocumentInput);
    document.addEventListener('change', onDocumentChange);
    document.addEventListener('keydown', onDocumentKeydown);

    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchView(tab.getAttribute('data-nav'));
      });
    });
  }

  function showFatal(err) {
    var main = $('#main');
    var message = (err && err.message) || String(err || '未知錯誤');
    if (main) {
      main.innerHTML = '<div class="view"><div class="card" style="padding:20px">' +
        '<div class="error-card"><strong>頁面載入失敗</strong>' + esc(message) +
        '<button type="button" onclick="location.reload()">重新整理</button></div>' +
        '<p style="margin:12px 2px 0;font-size:11px;line-height:1.6;color:#71827a">' +
        '請確認網路連線與 docs/config.js 的 API_URL 設定；本機預覽請執行 test/open-preview.ps1。</p>' +
        '</div></div>';
    }
    if (window.console && window.console.error) window.console.error(err);
  }

  try {
    init();
  } catch (err) {
    showFatal(err);
  }

})();
