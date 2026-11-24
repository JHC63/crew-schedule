/**
 * ============================================================
 * 網頁版：後端 JSON API（GAS Web App）
 * ------------------------------------------------------------
 * 這個檔案負責：
 *   1. doGet：JSON 健康檢查（可選 ?action=...&payload=... 直接呼叫 apiCall）
 *   2. apiCall：前端 fetch 呼叫的統一 API，回傳 { ok, data } / { ok, error }
 *   3. handleApiRequest_ / jsonResponse_：doPost（Code.gs 分流）與 doGet 共用
 *
 * 前端為 GitHub Pages 靜態頁（docs/），以 text/plain 傳 JSON，
 * 避開 GAS 不支援 OPTIONS、也無法自訂 CORS header 的限制。
 * 班表計算全部沿用 Code.gs 的既有邏輯，兩邊共用同一份資料。
 * ============================================================
 */

const LIFF_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * JSON 入口。GAS Web App 必須部署為「執行身分：我 / 存取權：所有人」。
 * 沒有參數時回傳服務資訊（健康檢查）；
 * 有 ?action=...（可選 ?payload=<URL-encoded JSON>）時直接呼叫 apiCall。
 */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};

    if (!p.action) {
      return jsonResponse_({
        ok: true,
        data: { service: 'crew-schedule-api', version: '2.0.0' }
      });
    }

    const payload = p.payload ? JSON.parse(p.payload) : {};
    return jsonResponse_(apiCall(p.action, payload));
  } catch (error) {
    return jsonResponse_({ ok: false, error: String((error && error.message) || error) });
  }
}

/**
 * 前端統一的 API 入口。
 * 回傳格式固定為 { ok: true, data: ... } 或 { ok: false, error: '...' }
 */
function apiCall(action, payload) {
  try {
    const data = (function () {
      switch (action) {
        case 'bootstrap': return liffBootstrap_();
        case 'mySchedule': return liffMySchedule_(payload || {});
        case 'staffDay': return liffStaffDay_(payload || {});
        case 'monthSchedule': return liffMonthSchedule_(payload || {});
        case 'allSchedules': return liffAllSchedules_(payload || {});
        case 'staffSchedule': return liffStaffSchedule_(payload || {});
        case 'status': return liffStatus_(payload || {});
        case 'station': return liffStation_(payload || {});
        case 'trainLookup': return liffTrainLookup_(payload || {});
        case 'allTrains': return liffAllTrains_(payload || {});
        default: throw new Error('未知的 API 操作：' + action);
      }
    })();
    return { ok: true, data: data };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/**
 * doPost（Code.gs 分流）的 JSON API 入口：body 為 { action, payload }。
 */
function handleApiRequest_(body) {
  return jsonResponse_(apiCall(body.action, body.payload || {}));
}

/**
 * JSON 回應包裝。GAS 的 ContentService 無法自訂 CORS header，一律回 HTTP 200；
 * 錯誤以 { ok: false, error } 呈現，由前端解析。
 */
function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 車站清單：以 Station 工作表的 No 排序（找不到時退回字母排序），
// 並回傳各站里程（KM），供前端判斷順向／逆向
// ============================================================
function liffStationCatalog_(ctx) {
  const used = {};
  Object.keys(ctx.scheduleSMap).forEach(function (key) {
    ctx.scheduleSMap[key].rows.forEach(function (row) {
      if (row.sStation) used[row.sStation] = true;
      if (row.aStation) used[row.aStation] = true;
    });
  });

  const order = {};
  const kmByKey = {};
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName('Station');
    if (sheet) {
      const rows = sheet.getDataRange().getValues();
      if (rows.length > 1) {
        const header = rows[0].map(function (v) { return String(v || '').trim().toLowerCase(); });
        const noCol = header.indexOf('no');
        const nameCol = header.indexOf('name');
        const kmCol = header.indexOf('km');
        if (nameCol >= 0) {
          const list = [];
          rows.slice(1).forEach(function (row, index) {
            const name = String(row[nameCol] || '').trim();
            if (!name) return;
            const rawNo = noCol >= 0 ? String(row[noCol] || '').trim() : '';
            const no = rawNo ? Number(rawNo) : NaN;
            const rawKm = kmCol >= 0 ? String(row[kmCol] || '').trim() : '';
            const km = rawKm ? Number(rawKm) : NaN;
            list.push({ name: name, no: isNaN(no) ? Infinity : no, index: index });
            if (isFinite(km)) kmByKey[normalizeStationName(name)] = km;
          });
          list.sort(function (a, b) {
            return a.no - b.no || a.index - b.index;
          });
          list.forEach(function (item, index) {
            const key = normalizeStationName(item.name);
            if (order[key] === undefined) order[key] = index;
          });
        }
      }
    }
  } catch (e) {
    // Station 工作表不存在或格式不同時，沿用 Schedule_S 的車站並以字母排序。
  }

  const stations = Object.keys(used).sort(function (a, b) {
    const ka = normalizeStationName(a);
    const kb = normalizeStationName(b);
    const ia = order[ka] === undefined ? Number.MAX_SAFE_INTEGER : order[ka];
    const ib = order[kb] === undefined ? Number.MAX_SAFE_INTEGER : order[kb];
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b, 'zh-Hant');
  });

  const kms = {};
  stations.forEach(function (name) {
    const km = kmByKey[normalizeStationName(name)];
    if (km !== undefined) kms[name] = km;
  });

  return { stations: stations, kms: kms };
}

// ============================================================
// API：初始資料（車長名單、車站清單）
// ============================================================
function liffBootstrap_() {
  const ctx = loadScheduleSContext();
  const seen = {};
  const staff = [];

  ctx.activeStaff.forEach(function (s) {
    const key = s.name + '\u0000' + s.group;
    if (seen[key]) return;
    seen[key] = true;
    staff.push({ name: s.name, group: s.group });
  });

  staff.sort(function (a, b) {
    return a.name.localeCompare(b.name, 'zh-Hant') || a.group.localeCompare(b.group);
  });

  const groups = {};
  staff.forEach(function (s) { groups[s.group] = true; });

  const stationCatalog = liffStationCatalog_(ctx);

  return {
    today: liffIsoDate_(getTaiwanToday()),
    nowMs: Date.now(),
    baseDate: liffIsoDate_(new Date(CONFIG.BASE_DATE)),
    maxDays: CONFIG.MAX_QUERY_DAYS || 14,
    staff: staff,
    stations: stationCatalog.stations,
    stationKms: stationCatalog.kms,
    groups: Object.keys(groups).sort()
  };
}

// ============================================================
// API：我的班表（首頁）／指定車長單日詳情
// ============================================================
function liffMySchedule_(payload) {
  return liffStaffDays_(payload, 7);
}

function liffStaffDay_(payload) {
  return liffStaffDays_(payload, 8);
}

function liffStaffDays_(payload, defaultDays, maxDays) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('請先設定姓名。');

  const groupFilter = payload.group ? normalizeGroupName(payload.group) : '';
  const ctx = loadScheduleSContext();
  let staffs = findStaffsByName(ctx, name);
  if (groupFilter) {
    staffs = staffs.filter(function (staff) { return staff.group === groupFilter; });
  }
  if (!staffs.length) {
    return {
      name: name,
      group: groupFilter,
      start: null,
      days: 0,
      staffs: [],
      missing: true
    };
  }

  const startDate = liffParseDate_(payload.start || payload.date) || getTaiwanToday();
  liffAssertBaseDate_([startDate]);

  let dayCount = parseInt(payload.days, 10);
  if (isNaN(dayCount) || dayCount < 1) dayCount = defaultDays || 7;
  dayCount = Math.min(dayCount, maxDays || CONFIG.MAX_QUERY_DAYS || 14);

  const dates = [];
  for (let i = 0; i < dayCount; i++) dates.push(addDays(startDate, i));

  const result = staffs.map(function (staff) {
    // 多看 7 天，讓「放假」的結束時間可以接到下一個上班日的報到時間。
    const status = buildStaffStatusIntervals(
      ctx, staff, addDays(startDate, -1), addDays(startDate, dayCount + 7)
    );
    return {
      staff: { name: staff.name, group: staff.group },
      days: dates.map(function (date) {
        return liffDayView_(ctx, staff, date, status);
      })
    };
  });

  return {
    name: name,
    group: groupFilter,
    start: liffIsoDate_(startDate),
    days: dayCount,
    staffs: result,
    missing: false
  };
}

// ============================================================
// API：當月班表（首頁）
// ============================================================
function liffMonthSchedule_(payload) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('請先設定姓名。');

  const today = getTaiwanToday();
  const rawMonth = String(payload.month || '').trim();
  const match = rawMonth.match(/^(\d{4})[\/\-](\d{1,2})$/);
  const year = match ? Number(match[1]) : today.getFullYear();
  const month = match ? Number(match[2]) : today.getMonth() + 1;
  if (month < 1 || month > 12) throw new Error('月份格式錯誤，請使用 YYYY-MM。');

  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const dayCount = last.getDate();
  const result = liffStaffDays_({
    name: name,
    group: payload.group || '',
    start: liffIsoDate_(first),
    days: dayCount
  }, dayCount, 31);

  result.month = year + '-' + String(month).padStart(2, '0');
  result.first = liffIsoDate_(first);
  result.last = liffIsoDate_(last);
  result.monthDays = dayCount;
  return result;
}

// ============================================================
// API：所有班表（首頁）
// 以 Schedule 工作表為主，依日期把 Group + Index 對到當天值乘的車長。
// ============================================================
function liffAllSchedules_(payload) {
  const date = liffPayloadDates_({ date: payload.date })[0];
  const iso = liffIsoDate_(date);
  const ctx = loadScheduleSContext();

  const assignedByKey = {};
  const activeGroups = {};
  ctx.activeStaff.forEach(function (staff) {
    activeGroups[staff.group] = true;
    const index = getStaffScheduleIndexForDetail(ctx, staff, date);
    if (index === null) return;
    const key = staff.group + '_' + index;
    if (!assignedByKey[key]) {
      assignedByKey[key] = { name: staff.name, group: staff.group };
    }
  });

  const rows = (ctx.scheduleRows || []).filter(function (row) {
    return !!activeGroups[row.group];
  });

  const schedules = rows.map(function (row) {
    return {
      group: row.group,
      index: row.index,
      number: row.number,
      train: row.train,
      on: row.on,
      off: row.off,
      onMin: row.onMin,
      offMin: row.offMin,
      staff: assignedByKey[row.group + '_' + row.index] || null
    };
  });

  return {
    date: iso,
    weekday: LIFF_WEEKDAYS[date.getDay()],
    count: schedules.length,
    schedules: schedules
  };
}

// ============================================================
// API：姓名／多日班表查詢
// ============================================================
function liffStaffSchedule_(payload) {
  const names = liffTokenList_(payload.names || payload.name);
  if (!names.length) throw new Error('請輸入車長姓名。');

  const mode = payload.mode === 'simple' ? 'simple' : 'detail';
  const dates = liffPayloadDates_(payload);
  const ctx = loadScheduleSContext();

  const staffs = [];
  const missing = [];
  const seen = {};

  names.forEach(function (name) {
    const matches = findStaffsByName(ctx, name);
    if (!matches.length) {
      const exists = ctx.staffList.some(function (s) {
        return String(s.name || '').trim().toLowerCase() === String(name).trim().toLowerCase();
      });
      missing.push({ name: name, reason: exists ? 'noSchedule' : 'unknown' });
      return;
    }
    matches.forEach(function (staff) {
      const key = staff.group + '_' + staff.name;
      if (seen[key]) return;
      seen[key] = true;
      staffs.push(staff);
    });
  });

  if (!staffs.length) {
    return { mode: mode, days: [], missing: missing, staffs: [] };
  }

  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const statusByKey = {};

  staffs.forEach(function (staff) {
    statusByKey[staff.group + '_' + staff.name] = buildStaffStatusIntervals(
      ctx, staff, addDays(minDate, -1), addDays(maxDate, 7)
    );
  });

  const days = dates.map(function (date) {
    return {
      date: liffIsoDate_(date),
      weekday: LIFF_WEEKDAYS[date.getDay()],
      staffs: staffs.map(function (staff) {
        const view = liffDayView_(
          ctx, staff, date, statusByKey[staff.group + '_' + staff.name]
        );
        view.staff = { name: staff.name, group: staff.group };
        if (mode === 'simple') {
          view.segments = view.segments.filter(function (s) { return s.kind === 'train'; });
        }
        return view;
      })
    };
  });

  return {
    mode: mode,
    days: days,
    missing: missing,
    staffs: staffs.map(function (s) { return { name: s.name, group: s.group }; })
  };
}

// ============================================================
// API：車次反查
// ============================================================
function liffTrainLookup_(payload) {
  const trains = liffTokenList_(payload.trains || payload.train);
  if (!trains.length) throw new Error('請輸入車次。');

  const mode = payload.mode === 'simple' ? 'simple' : 'detail';
  const dates = liffPayloadDates_(payload);
  const ctx = loadScheduleSContext();
  const statusByKey = {};

  const days = dates.map(function (date) {
    const hits = [];

    ctx.activeStaff.forEach(function (staff) {
      const workRow = getStaffWorkScheduleRowForDetail(ctx, staff, date);
      const slot = getStaffSlotForDetail(ctx, staff, date);
      if (!slot || !slot.rows.length) return;
      if (isRestSchedule(workRow) || isCrossNightDay(workRow, slot)) return;

      const timeline = buildSlotTimeline(slot, date);
      if (!timeline) return;

      const matched = timeline.trains.filter(function (t) {
        return trains.some(function (kw) { return isPreciseMatch(t.row.train, kw); });
      });
      if (!matched.length) return;

      const key = staff.group + '_' + staff.name;
      if (!statusByKey[key]) {
        statusByKey[key] = buildStaffStatusIntervals(
          ctx, staff, addDays(date, -1), addDays(date, 7)
        );
      }

      const dayView = liffDayView_(ctx, staff, date, statusByKey[key]);
      if (mode === 'simple') {
        const matchKeys = {};
        matched.forEach(function (t) {
          matchKeys[t.start.getTime() + '_' + t.row.train] = true;
        });
        dayView.segments = dayView.segments.filter(function (s) {
          return s.kind === 'train' && matchKeys[s.startMs + '_' + s.title];
        });
      }

      hits.push({
        staff: { name: staff.name, group: staff.group },
        shiftLabel: formatShiftLabel(slot),
        matched: matched.map(function (t) {
          return liffTrainSegment_(t);
        }),
        day: dayView
      });
    });

    hits.sort(function (a, b) {
      return (a.matched[0] ? a.matched[0].startMs : 0) - (b.matched[0] ? b.matched[0].startMs : 0) ||
        a.staff.name.localeCompare(b.staff.name, 'zh-Hant');
    });

    return { date: liffIsoDate_(date), weekday: LIFF_WEEKDAYS[date.getDay()], hits: hits };
  });

  return { mode: mode, trains: trains, days: days };
}

// ============================================================
// API：狀態查詢（值乘／非值乘／放假）
// ============================================================
function liffStatus_(payload) {
  const requested = String(payload.keyword || '值乘').trim().toLowerCase();
  const keywordMap = {
    '值乘': '值乘',
    '中場': '中場',
    '誰在這裡': '中場',
    '谁在这里': '中場',
    '放假': '放假'
  };
  const keyword = keywordMap[requested] || '值乘';
  const isLeave = keyword === '放假';
  const dates = liffPayloadDates_(payload);

  let startMin = null;
  let endMin = null;
  let timeSource = 'explicit';

  if (!isLeave) {
    startMin = liffParseTime_(payload.startTime);
    endMin = liffParseTime_(payload.endTime);
    if (startMin === null) {
      const now = getTaiwanNow();
      startMin = now.getHours() * 60 + now.getMinutes();
      timeSource = 'now';
    }
    if (endMin === null) endMin = startMin;
  }

  const isRange = !isLeave && startMin !== endMin;
  const stationFilter = payload.station ? String(payload.station).trim() : '';
  const queryStation = stationFilter ? normalizeStationName(stationFilter) : null;
  const ctx = loadScheduleSContext();

  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const contextDays = isLeave ? 7 : 2;
  const all = buildAllStaffStatusIntervals(
    ctx, addDays(minDate, -contextDays), addDays(maxDate, contextDays)
  );

  const displayNames = CONFIG.STATUS_DISPLAY_NAMES || {};
  const displayName = displayNames[keyword] || keyword;

  const blocks = dates.map(function (date) {
    let qStart;
    let qEnd;

    if (isLeave) {
      qStart = makeDateAtMinutes(date, 0);
      qEnd = makeDateAtMinutes(addDays(date, 1), 0);
    } else {
      qStart = makeDateAtMinutes(date, startMin);
      if (!isRange) {
        qEnd = new Date(qStart.getTime() + 60000);
      } else {
        qEnd = makeDateAtMinutes(date, endMin);
        if (endMin <= startMin) qEnd = new Date(qEnd.getTime() + 86400000);
      }
    }

    let hits = [];
    all.forEach(function (entry) {
      const list = keyword === '值乘' ? entry.status.trains :
        keyword === '中場' ? entry.status.rests : entry.status.leaves;

      list.forEach(function (iv) {
        if (queryStation && !isLeave) {
          const station = keyword === '值乘' ? iv.row.sStation : iv.station;
          if (normalizeStationName(station) !== queryStation) return;
        }
        const overlap = Math.min(iv.end.getTime(), qEnd.getTime()) -
          Math.max(iv.start.getTime(), qStart.getTime());
        if (overlap > 0) hits.push({ staff: entry.staff, iv: iv });
      });
    });

    if (isLeave) hits = liffKeepLatestLeave_(hits);
    hits.sort(liffStatusComparator_(keyword));

    const groups = liffStatusGroups_(keyword, hits, date, !!queryStation);
    const timeLabel = isLeave ? '' :
      (timeSource === 'now' && !payload.startTime
        ? '現在 ' + formatTime(startMin)
        : formatTime(startMin) +
          (isRange ? '–' + formatTime(endMin) + (endMin <= startMin ? '（翌日）' : '') : ''));

    return {
      date: liffIsoDate_(date),
      weekday: LIFF_WEEKDAYS[date.getDay()],
      keyword: keyword,
      displayName: displayName,
      timeLabel: timeLabel,
      station: stationFilter,
      count: hits.length,
      groups: groups
    };
  });

  return {
    keyword: keyword,
    displayName: displayName,
    isLeave: isLeave,
    dates: blocks,
    station: stationFilter
  };
}

function liffStation_(payload) {
  const station = String(payload.station || '').trim();
  if (!station) throw new Error('請輸入車站名稱。');
  const merged = {};
  Object.keys(payload || {}).forEach(function (k) { merged[k] = payload[k]; });
  merged.keyword = '中場';
  merged.station = station;
  return liffStatus_(merged);
}

function liffKeepLatestLeave_(hits) {
  const map = {};
  hits.forEach(function (hit) {
    const key = hit.staff.group + '_' + hit.staff.name;
    if (!map[key] || hit.iv.start.getTime() > map[key].iv.start.getTime()) map[key] = hit;
  });
  return Object.keys(map).map(function (key) { return map[key]; });
}

function liffStatusComparator_(keyword) {
  return function (a, b) {
    if (keyword === '放假') {
      const rank = getLeaveCategoryRank(a.iv) - getLeaveCategoryRank(b.iv);
      if (rank !== 0) return rank;
      const time = a.iv.start.getTime() - b.iv.start.getTime();
      if (time !== 0) return time;
      return a.staff.name.localeCompare(b.staff.name, 'zh-Hant');
    }
    const sa = normalizeStationName(keyword === '值乘' ? a.iv.row.sStation : a.iv.station);
    const sb = normalizeStationName(keyword === '值乘' ? b.iv.row.sStation : b.iv.station);
    const station = sa.localeCompare(sb, 'zh-Hant');
    if (station !== 0) return station;
    const time = getStatusTime(a.iv, keyword) - getStatusTime(b.iv, keyword);
    if (time !== 0) return time;
    return a.staff.name.localeCompare(b.staff.name, 'zh-Hant');
  };
}

function liffStatusGroups_(keyword, hits, date, hasStationFilter) {
  const groups = [];
  const map = {};

  hits.forEach(function (hit) {
    let title = '';
    if (keyword === '中場' && !hasStationFilter) {
      title = hit.iv.station || '—';
    } else if (keyword === '放假') {
      title = getLeaveCategory(hit.iv);
    }

    if (!map[title]) {
      map[title] = { title: title, hits: [] };
      groups.push(map[title]);
    }
    map[title].hits.push(liffStatusHit_(keyword, hit, date));
  });

  return groups;
}

function liffStatusHit_(keyword, hit, date) {
  const staff = hit.staff;
  const iv = hit.iv;
  const base = {
    staff: { name: staff.name, group: staff.group },
    startMs: iv.start.getTime(),
    endMs: iv.end.getTime()
  };

  if (keyword === '值乘') {
    base.title = String(iv.row.train || '');
    base.subtitle = (iv.row.sStation || '') + ' → ' + (iv.row.aStation || '');
    base.station = iv.row.sStation || '';
    base.time = formatInterval(iv.start, iv.end);
    base.shiftLabel = iv.slot ? formatShiftLabel(iv.slot) : '';
    return base;
  }

  if (keyword === '中場') {
    const next = iv.nextTrain
      ? '下一班 ' + iv.nextTrain.train + ' ' + iv.nextTrain.sStation + '→' +
        iv.nextTrain.aStation + ' ' + formatTime(iv.nextTrain.sTimeMin)
      : '';
    base.title = getRestIntervalLabel(iv);
    base.subtitle = iv.station || '';
    base.station = iv.station || '—';
    base.time = formatInterval(iv.start, iv.end);
    base.shiftLabel = iv.nextSlot && iv.nextSlot !== iv.slot
      ? formatShiftLabel(iv.slot) + ' → ' + formatShiftLabel(iv.nextSlot)
      : formatShiftLabel(iv.slot);
    base.note = next;
    return base;
  }

  const number = iv.workRow && iv.workRow.number ? String(iv.workRow.number).trim() : '';
  const name = iv.workRow && iv.workRow.train ? String(iv.workRow.train).trim() : '';
  base.title = name || getLeaveCategory(iv);
  base.subtitle = number ? '班號 ' + number : '';
  base.time = formatLeaveRange(iv, date);
  base.shiftLabel = number;
  base.category = getLeaveCategory(iv);
  return base;
}

// ============================================================
// API：全部車次（依開車時間 → 起站 → 抵達時間排序）
// ============================================================
function liffAllTrains_(payload) {
  const date = liffPayloadDates_({ date: payload.date })[0];
  const iso = liffIsoDate_(date);
  const cacheKey = 'liff_all_trains_v2_' + iso;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);

  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 快取損毀時重新計算 */ }
  }

  const ctx = loadScheduleSContext();
  const trains = [];

  ctx.activeStaff.forEach(function (staff) {
    const workRow = getStaffWorkScheduleRowForDetail(ctx, staff, date);
    const slot = getStaffSlotForDetail(ctx, staff, date);
    if (!slot || !slot.rows.length) return;
    if (isRestSchedule(workRow) || isCrossNightDay(workRow, slot)) return;

    const timeline = buildSlotTimeline(slot, date);
    if (!timeline) return;

    timeline.trains.forEach(function (t) {
      trains.push({
        train: String(t.row.train || ''),
        from: t.row.sStation || '',
        to: t.row.aStation || '',
        start: liffHhmm_(t.start),
        end: liffHhmm_(t.end),
        endDayOffset: liffDayOffset_(t.start, t.end),
        startMs: t.start.getTime(),
        endMs: t.end.getTime(),
        staff: { name: staff.name, group: staff.group },
        shiftLabel: formatShiftLabel(slot)
      });
    });
  });

  // 排序：開車時間 → 起站 → 抵達時間 → 車次
  trains.sort(function (a, b) {
    return a.startMs - b.startMs ||
      a.from.localeCompare(b.from, 'zh-Hant') ||
      a.endMs - b.endMs ||
      a.train.localeCompare(b.train, 'zh-Hant');
  });

  const result = {
    date: iso,
    weekday: LIFF_WEEKDAYS[date.getDay()],
    count: trains.length,
    trains: trains
  };

  const json = JSON.stringify(result);
  if (json.length < 90000) cache.put(cacheKey, json, 120);
  return result;
}

// ============================================================
// 單日資料（首頁、查詢結果共用）
// ============================================================
function liffDayView_(ctx, staff, date, status) {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const workRow = getStaffWorkScheduleRowForDetail(ctx, staff, date);
  const slot = getStaffSlotForDetail(ctx, staff, date);
  const shiftLabel = slot ? formatShiftLabel(slot) :
    (workRow && workRow.number ? String(workRow.number).trim() : '');
  const workName = workRow ? String(workRow.train || '').trim() : '';
  const isRest = isRestSchedule(workRow);
  const crossNight = isCrossNightDay(workRow, slot);
  const isLeaveName = isLeaveScheduleName(workName);
  const timeline = (!isRest && !crossNight && slot && slot.rows.length)
    ? buildSlotTimeline(slot, date) : null;

  const day = {
    date: liffIsoDate_(date),
    weekday: LIFF_WEEKDAYS[date.getDay()],
    label: shiftLabel || workName,
    workName: workName,
    kind: 'empty',
    summary: '查無班表',
    leaveCategory: '',
    leaveRange: '',
    firstStartMs: null,
    lastEndMs: null,
    segments: []
  };

  // 跨夜日：班表名稱含「跨夜」、當天沒有實際班次，直接視為放假。
  if (crossNight) {
    day.kind = 'leave';
    day.leaveCategory = '跨夜';
    const leave = liffFindLeave_(status, target);
    if (leave) {
      day.leaveRange = formatLeaveRange(leave, date);
      day.firstStartMs = leave.start.getTime();
      day.lastEndMs = leave.end.getTime();
    }
    day.label = shiftLabel || workName || '跨夜';
    day.summary = day.leaveRange || '跨夜';
    return day;
  }

  if (timeline) {
    day.kind = 'work';
    const segments = [];

    status.trains.forEach(function (t) {
      if (t.serviceDate.getTime() !== target) return;
      segments.push(liffTrainSegment_(t));
    });

    status.rests.forEach(function (r) {
      if (r.serviceDate.getTime() !== target) return;
      const kind = r.restKind === 'report' ? 'report' :
        r.restKind === 'post' ? 'post' :
        r.restKind === 'overnight' ? 'overnight' : 'rest';
      segments.push({
        kind: kind,
        title: getRestIntervalLabel(r),
        subtitle: r.station || '',
        station: r.station || '',
        startMs: r.start.getTime(),
        endMs: r.end.getTime(),
        start: liffHhmm_(r.start),
        end: liffHhmm_(r.end),
        endDayOffset: liffDayOffset_(r.start, r.end),
        note: r.nextTrain
          ? '下一班 ' + r.nextTrain.train + ' ' + r.nextTrain.sStation + '→' +
            r.nextTrain.aStation + ' ' + formatTime(r.nextTrain.sTimeMin)
          : ''
      });
    });

    // 兩天班的第二天：補上當日第一班車的報到（報到時間會落在前一晚的 D1下班區間內）。
    if (isContinuationWorkDay(ctx, staff, date, slot)) {
      const firstTrain = timeline.firstTrain;
      const reportStart = getFirstTrainReportStart(firstTrain);
      if (reportStart.getTime() < firstTrain.start.getTime() &&
          !segments.some(function (s) { return s.kind === 'report' && s.startMs === reportStart.getTime(); })) {
        segments.push({
          kind: 'report',
          title: '報到',
          subtitle: firstTrain.row.sStation || '',
          station: firstTrain.row.sStation || '',
          startMs: reportStart.getTime(),
          endMs: firstTrain.start.getTime(),
          start: liffHhmm_(reportStart),
          end: liffHhmm_(firstTrain.start),
          endDayOffset: 0,
          note: ''
        });
      }
    }

    segments.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
    day.segments = segments;

    if (segments.length) {
      day.firstStartMs = segments[0].startMs;
      day.lastEndMs = segments.reduce(function (max, s) { return Math.max(max, s.endMs); }, segments[0].endMs);
      day.summary = liffRangeSummary_(day.firstStartMs, day.lastEndMs);
    } else {
      day.summary = '查無班次資料';
    }
    return day;
  }

  if (isLeaveName) {
    day.kind = 'leave';
    day.leaveCategory = getLeaveCategory({ workRow: workRow });
    const leave = liffFindLeave_(status, target);
    if (leave) {
      day.leaveRange = formatLeaveRange(leave, date);
      day.firstStartMs = leave.start.getTime();
      day.lastEndMs = leave.end.getTime();
    }
    day.label = workName || shiftLabel;
    day.summary = day.leaveRange || '放假';
    return day;
  }

  if (workRow) {
    day.label = shiftLabel || workName;
    day.summary = '查無班次資料';
    return day;
  }

  return day;
}

function liffFindLeave_(status, targetMs) {
  if (!status || !status.leaves) return null;
  for (let i = 0; i < status.leaves.length; i++) {
    if (status.leaves[i].serviceDate.getTime() === targetMs) return status.leaves[i];
  }
  return null;
}

function liffTrainSegment_(t) {
  return {
    kind: 'train',
    title: String(t.row.train || ''),
    subtitle: (t.row.sStation || '') + ' → ' + (t.row.aStation || ''),
    station: t.row.sStation || '',
    toStation: t.row.aStation || '',
    startMs: t.start.getTime(),
    endMs: t.end.getTime(),
    start: liffHhmm_(t.start),
    end: liffHhmm_(t.end),
    endDayOffset: liffDayOffset_(t.start, t.end)
  };
}

function liffRangeSummary_(startMs, endMs) {
  if (startMs === null || endMs === null) return '';
  const start = new Date(startMs);
  const end = new Date(endMs);
  const offset = liffDayOffset_(start, end);
  return liffHhmm_(start) + '–' + liffHhmm_(end) + (offset > 0 ? ' (+' + offset + ')' : '');
}

// ============================================================
// 日期／時間工具
// ============================================================
function liffParseDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const m = String(value || '').trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return null;
  }
  return d;
}

function liffDateOnly_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function liffIsoDate_(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function liffHhmm_(d) {
  return formatTime(d.getHours() * 60 + d.getMinutes());
}

function liffDayOffset_(start, end) {
  const a = liffDateOnly_(start).getTime();
  const b = liffDateOnly_(end).getTime();
  return Math.round((b - a) / 86400000);
}

function liffParseTime_(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function liffTokenList_(value) {
  if (Array.isArray(value)) {
    const out = [];
    value.forEach(function (v) {
      const s = String(v || '').trim();
      if (s) out.push(s);
    });
    return out;
  }
  return String(value || '').split(/[\s,，、;；]+/).filter(Boolean);
}

function liffPayloadDates_(payload) {
  let raw = [];
  if (Array.isArray(payload.dates)) raw = payload.dates;
  else if (payload.dates) raw = [payload.dates];
  else if (payload.date) raw = [payload.date];

  if (!raw.length) raw = [liffIsoDate_(getTaiwanToday())];

  const dates = [];
  const seen = {};
  raw.forEach(function (value) {
    const parsed = liffParseDate_(value);
    if (!parsed) throw new Error('日期格式錯誤，請使用 YYYY-MM-DD。');
    const key = liffIsoDate_(parsed);
    if (seen[key]) return;
    seen[key] = true;
    dates.push(parsed);
  });

  liffAssertBaseDate_(dates);

  const maxDays = CONFIG.MAX_QUERY_DAYS || 14;
  if (dates.length > maxDays) {
    throw new Error('查詢天數超過上限（最多 ' + maxDays + ' 天）。');
  }

  dates.sort(function (a, b) { return a.getTime() - b.getTime(); });
  return dates;
}

function liffAssertBaseDate_(dates) {
  const base = new Date(CONFIG.BASE_DATE);
  base.setHours(0, 0, 0, 0);
  const before = dates.some(function (d) { return liffDateOnly_(d).getTime() < base.getTime(); });
  if (before) {
    throw new Error('無法查詢基準日（' + CONFIG.BASE_DATE + '）以前的班表。');
  }
}

