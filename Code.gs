/**
 * 讀取必要的指令碼屬性；未設定時擲出清楚的錯誤訊息，方便排查。
 * 設定位置：GAS 編輯器左側「專案設定 ⚙️」→「指令碼屬性」→ 新增屬性
 */
function getRequiredProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error(`缺少指令碼屬性「${key}」，請到 GAS「專案設定 ⚙️ → 指令碼屬性」新增後再執行`);
  }
  return value;
}

/**
 * 系統環境變數配置 (需替換為實機參數)
 */
const CONFIG = {
  // LINE Channel Access Token 已改存於「專案設定 → 指令碼屬性」（屬性名稱：LINE_TOKEN），不再寫死在原始碼
  get LINE_CHANNEL_ACCESS_TOKEN() {
    return getRequiredProperty_('LINE_TOKEN');
  },
  // 試算表 ID 已改存於「專案設定 → 指令碼屬性」（屬性名稱：SPREADSHEET_ID），不再寫死在原始碼
  get SPREADSHEET_ID() {
    return getRequiredProperty_('SPREADSHEET_ID');
  },
  BASE_DATE: '2026/07/01', // 基準日
  MAX_QUERY_DAYS: 14,      // 查詢天數上限 (保護機制)
  SCHEDULE_S_SHEET: 'Schedule_S',
  TIMEZONE: 'Asia/Taipei',
  // 狀態查詢標頭顯示名稱（網頁版與車站時段查詢使用）：中場 → 非值乘
  STATUS_DISPLAY_NAMES: { '中場': '非值乘' },
  // 「放假」查詢只列出班表名稱含下列關鍵字的班表（例假(第幾周) 皆會命中）
  STATUS_LEAVE_KEYWORDS: ['休息日', '例假', '跨夜'],
  // 跨夜班判定關鍵字；班表名稱需含此關鍵字才算跨夜班
  CROSS_NIGHT_KEYWORD: '跨夜',
  // Schedule_S 各群組的輪值週期；未設定時會自動取該群組最大 Index
  SCHEDULE_S_CYCLE_LENGTH: { A: 47, B: 47, C: 20 },
  // 群組名稱對照（舊名稱 → 新名稱）：讀取試算表時自動轉換，兼容尚未改名的資料
  GROUP_NAME_ALIASES: { '副座': '日管', '助理': '日內' },
  // 採「遞增循環」的群組（其餘群組為遞減循環）
  INCREMENT_GROUPS: ['日管', '日內']
};

/**
 * 統一群組名稱：去除空白、轉大寫，並將舊群組名稱轉為新名稱。
 */
function normalizeGroupName(group) {
  const name = String(group || '').trim().toUpperCase();
  return (CONFIG.GROUP_NAME_ALIASES || {})[name] || name;
}

/**
 * 統一 HTTP POST 入口（LINE Webhook 與前端 API 共用同一個 /exec）：
 *   1. body 含 events 陣列 → handleLineWebhook_（LINE Bot）
 *   2. body 含 action 字串 → handleApiRequest_（JSON API，定義在 LiffApi.gs）
 * 以 body 形狀分流，LINE 優先；解析失敗時依 Content-Type 決定回 OK 或 JSON 錯誤。
 */
function doPost(e) {
  let body = null;

  try {
    body = (e && e.postData && e.postData.contents)
      ? JSON.parse(e.postData.contents)
      : null;
  } catch (parseError) {
    console.error(`請求 JSON 解析失敗：${parseError}`);

    // LINE webhook 為 application/json；解析失敗時回 OK，避免 LINE 重試
    if (e && e.postData && e.postData.type === 'application/json') {
      return ContentService.createTextOutput("OK");
    }

    return jsonResponse_({ ok: false, error: 'JSON 格式錯誤' });
  }

  if (body && Array.isArray(body.events)) {
    return handleLineWebhook_(body);
  }

  if (body && typeof body.action === 'string') {
    return handleApiRequest_(body);
  }

  return jsonResponse_({ ok: false, error: '無法辨識的請求格式' });
}

/**
 * LINE Webhook 處理（自舊 doPost 拆出，行為不變）。
 */
function handleLineWebhook_(payload) {
  try {
    const event = payload && Array.isArray(payload.events) ? payload.events[0] : null;
    if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') {
      return ContentService.createTextOutput("OK");
    }

    const replyToken = event.replyToken;
    const userMessage = String(event.message.text || '').trim();
    if (!replyToken) {
      console.error('事件缺少 replyToken，無法回覆。');
      return ContentService.createTextOutput("OK");
    }

    console.log(`收到 LINE 訊息：「${userMessage}」`);
    const replyText = buildReplyText_(userMessage);
    console.log(`準備回覆（${String(replyText).length} 字）：${String(replyText).slice(0, 150).replace(/\n/g, ' ⏎ ')}`);
    sendLineReplyLong(replyToken, replyText);
  } catch (fatalError) {
    // 最後一道防線：任何錯誤都寫進「執行記錄」，到 GAS 編輯器左側「執行記錄」即可看到原因
    console.error(`doPost 例外：${fatalError && fatalError.stack ? fatalError.stack : fatalError}`);
  }

  return ContentService.createTextOutput("OK");
}

/**
 * 將使用者輸入轉成要回覆的文字（只計算、不發送）。
 * 獨立成函式是為了讓 debugDoPost() 可以在編輯器直接模擬 LINE 訊息測試。
 */
function buildReplyText_(rawMessage) {
  let message = toHalfWidth(String(rawMessage || '')).trim();

  // 去掉開頭的標籤詞（例：「車次 132」→「132」、「車長姓名：小林」→「小林」），
  // 讓「車次 132」「車長姓名 小林」這種寫法和「132」「小林」一樣有效。
  const LABEL_PREFIX = /^(車長姓名|車長|姓名|車次|班次|查詢)([::\s]+)/;
  while (true) {
    const stripped = message.replace(LABEL_PREFIX, '');
    if (stripped === message) break;
    message = stripped.trim();
  }

  // ==========================================
  // 系統級指令攔截：教學模組 (支援全/半形)
  // ==========================================
  if (message === '?' || message === '？') {
    return getTutorialMessage();
  }

  // ==========================================
  // 系統診斷指令：比對 Staff 與 Schedule_S 的群組資料
  // ==========================================
  if (message === '診斷' || message === '檢查') {
    try {
      return buildSystemDiagnostic();
    } catch (error) {
      return `診斷失敗: ${error.message}`;
    }
  }

  // ==========================================
  // 已移除的舊關鍵字（值乘／中場／放假／簡單／詳細／who）
  // 與「車站＋時段」格式（含 HH:MM 的查詢）：導引改用網頁版
  // LINE 僅保留：車長姓名／車次／班表／日夜休（可加日期）
  // ==========================================
  const legacyTokens = message.toLowerCase().split(/\s+/).filter(Boolean);
  const isStationTimeQuery = legacyTokens.some(t => /^\d{1,2}:\d{2}/.test(t));
  if (isStationTimeQuery ||
      legacyTokens.some(t => t === '值乘' || t === '中場' || t === '放假' ||
                             t === '簡單' || t === '詳細' || t === 'who')) {
    return '狀態查詢（值乘／中場／放假）、班表明細（簡單／詳細／who）與車站時段查詢已停止支援。\n請改用網頁版查詢。\nLINE 僅支援：車長姓名、車次、班表、日／夜／休（可加日期）。';
  }

  const inputParts = message.split(/\s+/).filter(Boolean);
  if (inputParts.length === 0) {
    return "未偵測到有效查詢條件。輸入 ? 可查看教學。";
  }

  // 引導詞：單獨出現時忽略，不當成姓名查詢
  const LABEL_WORDS = ['車長姓名', '車長', '姓名', '車次', '班次', '查詢'];

  const queryGroups = [];
  let currentGroup = null;
  let totalDatesCount = 0;
  const baseDateObj = new Date(CONFIG.BASE_DATE);

  try {
    // 狀態機解析 (4D Contextual Grouping: 日期/實體/屬性/狀態意圖)
    for (let kw of inputParts) {
      if (/^\d{1,4}[\/\.]\d{1,2}/.test(kw)) {
        const parsedDates = parseDateInput(kw);
        if (parsedDates.length === 0) continue;

        const isBeforeBaseDate = parsedDates.some(d => d.getTime() < baseDateObj.getTime());
        if (isBeforeBaseDate) {
          return `無法查詢基準日 (${CONFIG.BASE_DATE}) 以前的班表，請重新輸入。`;
        }

        currentGroup = {
          dates: parsedDates,
          names: [],
          trains: [],
          shifts: [],
          isWorkingOnly: false // 布林狀態過濾器
        };
        queryGroups.push(currentGroup);
        totalDatesCount += parsedDates.length;
      }
      else {
        // 標籤詞（車次／車長姓名等）只是引導詞，不當成姓名查詢
        if (LABEL_WORDS.includes(kw)) continue;

        // [隱式上下文初始化] 若未輸入日期，自動注入「今日」
        if (!currentGroup) {
          const today = new Date();
          today.setHours(0, 0, 0, 0); // 抹除時間偏差

          if (today.getTime() < baseDateObj.getTime()) {
            return `當前系統時間早於基準日，無法預設查詢今日班表。`;
          }

          currentGroup = {
            dates: [today],
            names: [],
            trains: [],
            shifts: [],
            isWorkingOnly: false
          };
          queryGroups.push(currentGroup);
          totalDatesCount += 1;
        }

        // 字典分類邏輯 (Lexical Routing)
        if (['日', '夜', '休'].includes(kw)) {
          currentGroup.shifts.push(kw);
        } else if (kw === '班表') {
          // 觸發班表過濾
          currentGroup.isWorkingOnly = true;
        } else if (/\d/.test(kw)) {
          currentGroup.trains.push(kw);
        } else {
          currentGroup.names.push(kw);
        }
      }
    }

    if (queryGroups.length === 0) {
      return "未偵測到有效查詢條件。輸入 ? 可查看教學。";
    }

    if (totalDatesCount > CONFIG.MAX_QUERY_DAYS) {
      return `查詢總天數超過限制（最多 ${CONFIG.MAX_QUERY_DAYS} 天），請縮小範圍。`;
    }

    return buildScheduleResponse(queryGroups);

  } catch (error) {
    return `系統錯誤: ${error.message}`;
  }
}

/**
 * 獨立教學文案建構器 (關注點分離)
 */
function getTutorialMessage() {
  return `🤖 班表查詢系統教學 🤖
可直接輸入員工姓名查詢「今日」班表，或以「日期」開頭進行進階查詢。條件之間請用「空白鍵」隔開。

1️⃣ 【員工查詢】(支援多日與預設今日)
當日查詢：小林（「車長姓名 小林」也可以）
單日查詢：7.24 小林
多日查詢：7.24,7.25 小林
區間查詢：7.24-7.26 小林

2️⃣ 【車次與班別反查】
查車次：7.24 132（「車次 132」也可以）
查班別：7.24 日 (日管/日內適用)

3️⃣ 【進階過濾】(交集確認)
誰有班表：7.24 班表 (列出所有非休息日/例假的員工)
姓名+車次：7.24 小林 132

※ 提示：日期格式支援 7/24 或 7.24。
※ 僅支援：車長姓名、車次、班表、日／夜／休（可加日期）。
※ 狀態（值乘／中場／放假）、班表明細（簡單／詳細／who）與車站時段查詢已移除，請改用網頁版。`;
}

/**
 * 系統診斷訊息建構器：列出 Staff 與 Schedule_S 兩邊的群組比對，
 * 用於排查「查無此車長資料／群組沒有車長班表資料」的設定問題。
 */
function buildSystemDiagnostic() {
  const lines = ['🔧 系統診斷'];
  lines.push(`試算表 ID：${CONFIG.SPREADSHEET_ID}`);
  try {
    const ctx = loadScheduleSContext();
    const totalRows = Object.values(ctx.scheduleSMap)
      .reduce((sum, slot) => sum + slot.rows.length, 0);
    const staffGroups = {};
    ctx.staffList.forEach(s => { staffGroups[s.group] = (staffGroups[s.group] || 0) + 1; });
    const staffLine = Object.keys(staffGroups).sort()
      .map(g => `${g} ${staffGroups[g]} 人`).join('、') || '（無）';
    const schedGroups = Object.keys(ctx.cycleLengthByGroup).sort();
    const schedLine = schedGroups
      .map(g => `${g}（週期 ${ctx.cycleLengthByGroup[g]}）`).join('、') || '（無）';

    lines.push(`Staff 車長：${ctx.staffList.length} 人（${staffLine}）`);
    lines.push(`Schedule_S：${totalRows} 筆，群組 ${schedLine}`);
    lines.push(`Schedule_S 欄位：${ctx.scheduleSColumns.join('、') || '（無表頭）'}`);
    lines.push(`納入班表查詢的車長：${ctx.activeStaff.length} 人`);

    const notInScheduleS = Object.keys(staffGroups)
      .filter(g => !(ctx.cycleLengthByGroup[g] > 0)).sort();
    if (notInScheduleS.length) {
      lines.push(`⚠️ Staff 有、Schedule_S 沒有的群組：${notInScheduleS.join('、')}`);
      lines.push('→ 這些群組的車長在網頁版班表會查無，請確認 Schedule_S 工作表的 Group／Index 欄。');
    } else {
      lines.push('✅ Staff 與 Schedule_S 的群組一致');
    }
  } catch (error) {
    lines.push(`❌ 讀取失敗：${error.message}`);
  }
  return lines.join('\n');
}

function parseDateInput(inputStr) {
  const currentYear = new Date().getFullYear();
  let cleanStr = inputStr.replace(/\./g, '/');
  let dates = [];

  function makeDate(str) {
    let parts = str.split('/');
    if (parts.length === 2) {
      return new Date(currentYear, parseInt(parts[0], 10) - 1, parseInt(parts[1], 10));
    } else if (parts.length === 3) {
      return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
    return new Date("Invalid");
  }

  if (cleanStr.includes('、') || cleanStr.includes(',')) {
    const parts = cleanStr.split(/[、,]/);
    parts.forEach(p => dates.push(makeDate(p)));
  }
  else if (cleanStr.includes('-') || cleanStr.includes('~')) {
    const parts = cleanStr.split(/[-~]/);
    if (parts.length === 2) {
      let start = makeDate(parts[0]);
      let end = makeDate(parts[1]);
      if (!isNaN(start) && !isNaN(end) && start <= end) {
        let curr = new Date(start);
        while (curr <= end) {
          dates.push(new Date(curr));
          curr.setDate(curr.getDate() + 1);
        }
      }
    }
  }
  else {
    dates.push(makeDate(cleanStr));
  }

  return dates.filter(d => !isNaN(d.getTime()));
}

function formatDateOutput(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

// ============================================================
// 以下為資料載入與查詢核心：Schedule_S 車長班表
// （LINE 僅供姓名／車次／班表／日夜休查詢；狀態與明細請用網頁版）
// ============================================================

function loadScheduleSContext() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheetTz = ss.getSpreadsheetTimeZone() || CONFIG.TIMEZONE || 'Asia/Taipei';
  const staffData = ss.getSheetByName('Staff').getDataRange().getValues();
  const scheduleSSheet = ss.getSheetByName(CONFIG.SCHEDULE_S_SHEET || 'Schedule_S');
  if (!scheduleSSheet) throw new Error(`找不到工作表 ${CONFIG.SCHEDULE_S_SHEET}`);
  const scheduleSData = scheduleSSheet.getDataRange().getValues();
  const scheduleSheet = ss.getSheetByName('Schedule');
  const scheduleData = scheduleSheet ? scheduleSheet.getDataRange().getDisplayValues() : [];

  // 依表頭動態對應欄位（大小寫／前後空白不限），
  // 相容「有 B_time 欄」與「無 B_time 欄」兩種 Schedule_S 格式。
  const scheduleSHeader = (scheduleSData[0] || []).map(h => String(h || '').trim().toUpperCase());
  const scheduleSCol = {};
  scheduleSHeader.forEach((h, i) => { if (h && !(h in scheduleSCol)) scheduleSCol[h] = i; });
  const sRequiredCols = ['NUMBER', 'TRAIN', 'S_TIME', 'A_TIME', 'GROUP', 'INDEX'];
  const sMissingCols = sRequiredCols.filter(c => !(c in scheduleSCol));
  if (sMissingCols.length) {
    throw new Error(`Schedule_S 工作表缺少表頭欄位：${sMissingCols.join('、')}（需含 Number／Train／S_time／A_time／Group／Index，S_station／A_station／B_time 可省略）`);
  }
  const S_COL = {
    number: scheduleSCol['NUMBER'],
    train: scheduleSCol['TRAIN'],
    sStation: scheduleSCol['S_STATION'] !== undefined ? scheduleSCol['S_STATION'] : -1,
    aStation: scheduleSCol['A_STATION'] !== undefined ? scheduleSCol['A_STATION'] : -1,
    bTime: scheduleSCol['B_TIME'] !== undefined ? scheduleSCol['B_TIME'] : -1,
    sTime: scheduleSCol['S_TIME'],
    aTime: scheduleSCol['A_TIME'],
    group: scheduleSCol['GROUP'],
    index: scheduleSCol['INDEX']
  };

  const staffList = [];
  for (let i = 1; i < staffData.length; i++) {
    // 統一群組代碼為大寫並轉換舊名稱，避免 Staff 與 Schedule_S 名稱不一致
    const group = normalizeGroupName(staffData[i][0]);
    const baseIndex = parseInt(staffData[i][1], 10);
    const name = String(staffData[i][2] || '').trim();
    if (!group || !name || isNaN(baseIndex)) continue;
    staffList.push({ group, baseIndex, name });
  }

  const scheduleSMap = {};
  for (let i = 1; i < scheduleSData.length; i++) {
    const row = scheduleSData[i];
    const number = String(row[S_COL.number] || '').trim();
    if (!number) continue;
    const group = normalizeGroupName(row[S_COL.group]);
    const index = parseInt(row[S_COL.index], 10);
    if (!group || isNaN(index)) continue;

    const parsedNumber = parseShiftNumber(number);
    const item = {
      number,
      train: String(row[S_COL.train] || '').trim(),
      sStation: S_COL.sStation >= 0 ? String(row[S_COL.sStation] || '').trim() : '',
      aStation: S_COL.aStation >= 0 ? String(row[S_COL.aStation] || '').trim() : '',
      bTimeMin: S_COL.bTime >= 0 ? cellTimeToMinutes(row[S_COL.bTime], sheetTz) : null,
      sTimeMin: cellTimeToMinutes(row[S_COL.sTime], sheetTz),
      aTimeMin: cellTimeToMinutes(row[S_COL.aTime], sheetTz),
      group,
      index,
      seq: parsedNumber.seq,
      shiftBase: parsedNumber.base,
      shiftDay: parsedNumber.day
    };

    const key = `${group}_${index}`;
    if (!scheduleSMap[key]) {
      scheduleSMap[key] = {
        key,
        group,
        index,
        shiftBase: item.shiftBase,
        shiftDay: item.shiftDay,
        rows: []
      };
    }
    if (!scheduleSMap[key].shiftBase && item.shiftBase) {
      scheduleSMap[key].shiftBase = item.shiftBase;
      scheduleSMap[key].shiftDay = item.shiftDay;
    }
    scheduleSMap[key].rows.push(item);
  }

  Object.values(scheduleSMap).forEach(slot => {
    slot.rows.sort((a, b) => {
      const sa = (a.seq === null || isNaN(a.seq)) ? 9999 : a.seq;
      const sb = (b.seq === null || isNaN(b.seq)) ? 9999 : b.seq;
      return sa - sb;
    });
  });

  const workScheduleMap = {};
  const scheduleRows = [];
  for (let i = 1; i < scheduleData.length; i++) {
    const group = normalizeGroupName(scheduleData[i][0]);
    const index = parseInt(scheduleData[i][1], 10);
    if (!group || isNaN(index)) continue;
    workScheduleMap[`${group}_${index}`] = {
      number: scheduleData[i][2],
      train: scheduleData[i][3],
      on: scheduleData[i][4],
      off: scheduleData[i][5],
      onMin: cellTimeToMinutes(scheduleData[i][4], sheetTz),
      offMin: cellTimeToMinutes(scheduleData[i][5], sheetTz)
    };

    // 「所有班表」要保留 Schedule 工作表的每一列（含同 Index 的重複列），
    // workScheduleMap 只留最後一筆，不能拿來列出完整班表。
    const number = String(scheduleData[i][2] || '').trim();
    const train = String(scheduleData[i][3] || '').trim();
    if (!number && !train) continue;
    scheduleRows.push({
      group,
      index,
      number,
      train,
      on: String(scheduleData[i][4] || '').trim(),
      off: String(scheduleData[i][5] || '').trim(),
      onMin: cellTimeToMinutes(scheduleData[i][4], sheetTz),
      offMin: cellTimeToMinutes(scheduleData[i][5], sheetTz)
    });
  }

  const cycleLengthByGroup = {};
  Object.values(scheduleSMap).forEach(slot => {
    const configured = (CONFIG.SCHEDULE_S_CYCLE_LENGTH || {})[slot.group] || 0;
    if (configured > 0) {
      // 有明確設定時以設定為準（A=47、B=47、C=20）
      cycleLengthByGroup[slot.group] = configured;
    } else {
      // 未設定時才退回該群組最大 Index
      cycleLengthByGroup[slot.group] = Math.max(
        cycleLengthByGroup[slot.group] || 0,
        slot.index
      );
    }
  });

  // 納入 Schedule_S 實際有班表資料的群組（以工作表資料為準，不依賴 CONFIG 設定：
  // 避免部署版 CONFIG 缺少群組設定，或新增群組未同步設定時，整批車長被誤判「查無此車長」）
  const activeStaff = staffList.filter(s => cycleLengthByGroup[s.group] > 0);

  return {
    ss,
    baseDate: new Date(CONFIG.BASE_DATE),
    staffList,
    activeStaff,
    scheduleSMap,
    workScheduleMap,
    scheduleRows,
    cycleLengthByGroup,
    // Schedule_S 實際讀到的表頭欄位（診斷用）
    scheduleSColumns: scheduleSHeader.filter(Boolean)
  };
}

function buildAllStaffIntervals(ctx, rangeStart, rangeEnd) {
  const result = [];
  ctx.activeStaff.forEach(staff => {
    const intervals = buildStaffIntervals(ctx, staff, rangeStart, rangeEnd);
    if (intervals.length) result.push({ staff, intervals });
  });
  return result;
}

function buildStaffIntervals(ctx, staff, rangeStart, rangeEnd) {
  const slots = [];
  const start = addDays(rangeStart, 0);
  const end = addDays(rangeEnd, 0);

  for (let d = new Date(start); d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const slot = getStaffSlotForDate(ctx, staff, d);
    if (!slot || !slot.rows.length) continue;
    const timeline = buildSlotTimeline(slot, d);
    if (!timeline) continue;
    slots.push({
      date: new Date(d.getFullYear(), d.getMonth(), d.getDate()),
      slot,
      timeline
    });
  }

  slots.sort((a, b) => a.date - b.date);

  const intervals = [];

  slots.forEach(s => {
    s.timeline.trains.forEach(t => {
      intervals.push({
        type: 'train',
        start: t.start,
        end: t.end,
        row: t.row,
        slot: s.slot,
        serviceDate: s.date
      });
    });
    s.timeline.rests.forEach(r => {
      intervals.push({
        type: 'rest',
        start: r.start,
        end: r.end,
        station: r.station,
        prevTrain: r.prevTrain,
        nextTrain: r.nextTrain,
        prevSlot: s.slot,
        nextSlot: s.slot,
        slot: s.slot,
        isOvernight: false,
        serviceDate: s.date
      });
    });
  });

  for (let i = 0; i < slots.length - 1; i++) {
    const a = slots[i];
    const b = slots[i + 1];
    const gapDays = Math.round((b.date.getTime() - a.date.getTime()) / 86400000);
    if (gapDays !== 1) continue;
    if (!a.timeline.lastTrain || !b.timeline.firstTrain) continue;
    const restStart = a.timeline.lastTrain.end;
    const restEnd = b.timeline.firstTrain.start;
    if (restEnd.getTime() <= restStart.getTime()) continue;
    intervals.push({
      type: 'rest',
      start: restStart,
      end: restEnd,
      station: a.timeline.lastTrain.row.aStation,
      prevTrain: a.timeline.lastTrain.row,
      nextTrain: b.timeline.firstTrain.row,
      prevSlot: a.slot,
      nextSlot: b.slot,
      slot: a.slot,
      isOvernight: true,
      serviceDate: a.date
    });
  }

  return intervals.sort((a, b) => a.start - b.start);
}

function buildSlotTimeline(slot, date) {
  const trains = [];
  let prevEnd = null;
  const crossNightKeyword = CONFIG.CROSS_NIGHT_KEYWORD || '跨夜';

  slot.rows.forEach(row => {
    // 跨夜列是放假分界，不是實際班次；即使有完整時間也不列入值乘。
    if (String(row.train || '').includes(crossNightKeyword)) return;
    if (row.sTimeMin === null || row.aTimeMin === null) return;

    let start = makeDateAtMinutes(date, row.sTimeMin);
    if (prevEnd && start.getTime() < prevEnd.getTime()) {
      while (start.getTime() < prevEnd.getTime()) {
        start = new Date(start.getTime() + 86400000);
      }
    }

    let duration = row.aTimeMin - row.sTimeMin;
    if (duration < 0) duration += 1440;
    const end = new Date(start.getTime() + duration * 60000);

    trains.push({ start, end, row });
    prevEnd = end;
  });

  if (trains.length === 0) return null;

  const rests = [];
  for (let i = 0; i < trains.length - 1; i++) {
    const a = trains[i];
    const b = trains[i + 1];
    if (b.start.getTime() > a.end.getTime()) {
      rests.push({
        start: a.end,
        end: b.start,
        station: a.row.aStation,
        prevTrain: a.row,
        nextTrain: b.row
      });
    }
  }

  return {
    trains,
    rests,
    firstTrain: trains[0],
    lastTrain: trains[trains.length - 1]
  };
}

function getStaffSlotForDate(ctx, staff, date) {
  const cycleLength = ctx.cycleLengthByGroup[staff.group];
  if (!cycleLength) return null;
  const diffDays = Math.round((date.getTime() - ctx.baseDate.getTime()) / 86400000);
  const index = getScheduleSIndex(staff.baseIndex, diffDays, cycleLength);
  return ctx.scheduleSMap[`${staff.group}_${index}`] || null;
}

/**
 * 與既有車長輪值方向一致：人員的 Index 每天 +1，因此 baseIndex 對應的 Index 每天遞減。
 * 若實務上是反向輪值，將此行改為：
 * const raw = (baseIndex - 1 + diffDays) % cycleLength;
 */
function getScheduleSIndex(baseIndex, diffDays, cycleLength) {
  const raw = (1 - baseIndex + diffDays) % cycleLength;
  return ((raw % cycleLength) + cycleLength) % cycleLength + 1;
}

function parseShiftNumber(number) {
  const parts = String(number || '').split('-').map(p => p.trim());
  return {
    base: parts[0] || '',
    day: parts.length > 1 ? parseInt(parts[1], 10) : null,
    seq: parts.length > 2 ? parseInt(parts[2], 10) : null
  };
}

/**
 * 精準數字邊界匹配 (隔離子字串干涉)：
 * 查詢 125 不會命中 1256，但會命中 125A / 125便 等非數字接續的車次。
 */
function isPreciseMatch(text, keyword) {
  if (!text) return false;
  const regex = new RegExp(`(^|[^0-9])${keyword}([^0-9]|$)`);
  return regex.test(String(text));
}

function cellTimeToMinutes(value, tz) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return parseTimeToMinutes(Utilities.formatDate(value, tz || CONFIG.TIMEZONE || 'Asia/Taipei', 'HH:mm'));
  }
  if (typeof value === 'number') {
    const total = Math.round((value % 1) * 1440);
    return ((total % 1440) + 1440) % 1440;
  }
  return parseTimeToMinutes(value);
}

function parseTimeToMinutes(value) {
  if (value === null || value === undefined) return null;
  let s = toHalfWidth(String(value)).trim();
  if (!s) return null;

  const isPM = /(下午|pm)/i.test(s);
  const isAM = /(上午|am)/i.test(s);
  s = s.replace(/(上午|下午|am|pm)/ig, '').trim();

  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;

  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (isPM && h < 12) h += 12;
  if (isAM && h === 12) h = 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function getTaiwanNowParts() {
  const tz = CONFIG.TIMEZONE || 'Asia/Taipei';
  const parts = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd/HH/mm').split('/').map(Number);
  return { year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4] };
}

function getTaiwanToday() {
  const p = getTaiwanNowParts();
  return new Date(p.year, p.month - 1, p.day, 0, 0, 0, 0);
}

function getTaiwanNow() {
  const p = getTaiwanNowParts();
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

function makeDateAtMinutes(date, minutes) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  return new Date(d.getTime() + minutes * 60000);
}

function formatTime(minutes) {
  if (minutes === null || minutes === undefined || isNaN(minutes)) return '--:--';
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function formatInterval(start, end) {
  if (!start || !end) return '';
  const sameDate = start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  const startText = formatTime(start.getHours() * 60 + start.getMinutes());
  const endText = formatTime(end.getHours() * 60 + end.getMinutes());
  if (sameDate) return `${startText}-${endText}`;
  return `${start.getMonth() + 1}/${start.getDate()} ${startText}-${end.getMonth() + 1}/${end.getDate()} ${endText}`;
}

function normalizeStationName(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/臺/g, '台')
    .replace(/火車站$/, '')
    .replace(/車站$/, '')
    .replace(/站$/, '')
    .trim();
}

function toHalfWidth(str) {
  return String(str)
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

/**
 * 除錯工具：在 GAS 編輯器選擇此函式按「執行」，模擬 LINE 訊息並列出「會回覆的內容」，
 * 不會真的發送訊息。想測的關鍵字自行加進 inputs 陣列即可。
 * 執行後到左側「執行記錄」查看每個關鍵字的實際回覆；若有例外會顯示完整堆疊。
 */
function debugDoPost() {
  const inputs = [
    '小林',            // 車長姓名查詢
    '車長姓名 小林',    // 帶標籤詞的姓名查詢
    '11/18 3178',      // 車次反查
    '車次 3178',        // 帶標籤詞的車次反查
    '11/18 班表',      // 全域班表
    '?'                // 教學
  ];

  const report = inputs.map(text => {
    try {
      const reply = buildReplyText_(text);
      return `【輸入】${text}\n【回覆】\n${reply || '（空字串 → 會改回覆「查無資料」）'}`;
    } catch (error) {
      return `【輸入】${text}\n【錯誤】${error && error.stack ? error.stack : error}`;
    }
  }).join('\n\n────────────────\n\n');

  console.log(report);
  return report;
}

/**
 * 長訊息回覆：超過 4500 字自動分段（最多 5 則），避免超過 LINE 單則 5000 字上限被拒。
 */
function sendLineReplyLong(replyToken, text) {
  const LIMIT = 4500;
  const MAX_MESSAGES = 5;
  const raw = String(text || '').trim();
  if (!raw) {
    sendLineReply(replyToken, '查無資料。');
    return;
  }

  const chunks = [];
  let rest = raw;
  while (rest.length > LIMIT && chunks.length < MAX_MESSAGES) {
    let cut = rest.lastIndexOf('\n', LIMIT);
    if (cut < Math.floor(LIMIT * 0.6)) cut = LIMIT;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).replace(/^\n+/, '').trim();
  }
  if (rest && chunks.length < MAX_MESSAGES) chunks.push(rest);

  if (rest && chunks.length === MAX_MESSAGES) {
    const note = '\n…（資料過多，僅顯示部分）';
    chunks[MAX_MESSAGES - 1] = chunks[MAX_MESSAGES - 1].slice(0, LIMIT - note.length) + note;
  }

  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: chunks.map(t => ({ type: 'text', text: t }))
    }),
    // 失敗時不要丟例外，把狀態碼寫進執行記錄才查得到原因
    muteHttpExceptions: true
  });
  logLineApiResponse_(response);
}

function getStatusTime(iv, keyword) {
  // 值乘依 Schedule_S 的 S_time；中場／放假依實際區間起點。
  if (keyword === '值乘' && iv.row && iv.row.sTimeMin !== null && iv.row.sTimeMin !== undefined) {
    return iv.row.sTimeMin;
  }
  return iv.start.getTime();
}

function getLeaveCategory(iv) {
  const name = iv && iv.workRow ? String(iv.workRow.train || '').trim() : '';
  const crossNightKeyword = CONFIG.CROSS_NIGHT_KEYWORD || '跨夜';
  if (name.includes(crossNightKeyword)) return '跨夜';
  if (name.includes('休息日')) return '休息日';
  if (name.includes('例假')) return '例假';
  return name || '其他';
}

function getLeaveCategoryRank(iv) {
  const category = getLeaveCategory(iv);
  if (category === '跨夜') return 0;
  if (category === '休息日') return 1;
  if (category === '例假') return 2;
  return 3;
}

/**
 * 放假查詢的區間顯示（放假結束延伸到下一個上班日的報到時間）：
 *   整天都在放假（00:00-翌日00:00）→ 全天
 *   結束在當天內 → 00:15-13:47
 *   結束跨到翌日之後 → 00:15-11/19 13:47
 *   從之前的日子延續過來 → 11/18 00:15-13:47
 */
function formatLeaveRange(iv, date) {
  const dayStart = makeDateAtMinutes(date, 0);
  const dayEnd = makeDateAtMinutes(addDays(date, 1), 0);
  const startMs = iv.start.getTime();
  const endMs = iv.end.getTime();

  if (startMs <= dayStart.getTime() && endMs >= dayEnd.getTime()) return '全天';

  const startText = startMs < dayStart.getTime()
    ? formatDateTimeShort(iv.start)
    : formatTime(Math.round((startMs - dayStart.getTime()) / 60000));

  let endText;
  if (endMs > dayEnd.getTime()) {
    endText = formatDateTimeShort(iv.end);
  } else {
    const endMin = Math.round((endMs - dayStart.getTime()) / 60000);
    endText = endMin >= 1440 ? '24:00' : formatTime(endMin);
  }
  return `${startText}-${endText}`;
}

function formatDateTimeShort(date) {
  return `${date.getMonth() + 1}/${date.getDate()} ${formatTime(date.getHours() * 60 + date.getMinutes())}`;
}

function formatShiftLabel(slot) {
  if (!slot) return '';
  const base = slot.shiftBase || '';
  if (slot.shiftDay === null || slot.shiftDay === undefined || isNaN(slot.shiftDay)) return String(base);
  return `${base}-${slot.shiftDay}`;
}

function getRestIntervalLabel(iv) {
  if (iv.restKind === 'report') return '報到';
  if (iv.restKind === 'post') return '後整';
  if (iv.restKind === 'overnight') return 'D1下班';
  return '中場';
}

function buildAllStaffStatusIntervals(ctx, rangeStart, rangeEnd) {
  return ctx.activeStaff.map(staff => ({
    staff,
    status: buildStaffStatusIntervals(ctx, staff, rangeStart, rangeEnd)
  }));
}

/**
 * 依班表名稱決定第一班車的報到（前整）開始時間。
 * 規則：
 *   7202、7801：S_time 前 60 分鐘
 *   7802：固定 14:59
 *   7201：固定 15:57
 *   含「便」：S_time 前 30 分鐘
 *   其餘：S_time 前 40 分鐘
 */
function getFirstTrainReportStart(firstTrain) {
  const name = String(firstTrain.row.train || '').trim();

  if (name === '7202' || name === '7801') {
    return new Date(firstTrain.start.getTime() - 60 * 60000);
  }

  if (name === '7802' || name === '7201') {
    const fixedMin = name === '7802' ? (14 * 60 + 59) : (15 * 60 + 57);
    const start = makeDateAtMinutes(firstTrain.start, fixedMin);
    // 固定前整時間若晚於開車時間，代表當日不適用，回傳開車時間讓區間為空。
    if (start.getTime() >= firstTrain.start.getTime()) {
      return new Date(firstTrain.start.getTime());
    }
    return start;
  }

  if (name.includes('便')) {
    return new Date(firstTrain.start.getTime() - 30 * 60000);
  }

  return new Date(firstTrain.start.getTime() - 40 * 60000);
}

/**
 * 依班表名稱決定最後一班車的後整結束時間。
 * 規則：
 *   7202、7801、7802、7201：A_time 後 60 分鐘
 *   含「便」：A_time 後 20 分鐘
 *   其餘：A_time 後 30 分鐘
 */
function getLastTrainPostEnd(lastTrain) {
  const name = String(lastTrain.row.train || '').trim();
  let bufferMinutes = 30;

  if (name === '7202' || name === '7801' || name === '7802' || name === '7201') {
    bufferMinutes = 60;
  } else if (name.includes('便')) {
    bufferMinutes = 20;
  }

  return new Date(lastTrain.end.getTime() + bufferMinutes * 60000);
}

/**
 * 班表名稱是否為跨夜班。
 * 只有 Schedule 表當日班表名稱含「跨夜」才算，Schedule_S 有跨夜列但班表名稱不符時不列入。
 */
function isCrossNightScheduleName(name) {
  const keyword = CONFIG.CROSS_NIGHT_KEYWORD || '跨夜';
  return String(name || '').includes(keyword);
}

/**
 * 取得 Schedule_S 跨夜列的時間。
 * 跨夜列通常只有 A_time（少數只有 S_time），優先取 A_time，其次 S_time。
 * 沒有時間時回傳 null，由呼叫端改用前一天算出的後整結束時間。
 */
function getSlotCrossNightTime(slot, date) {
  if (!slot || !Array.isArray(slot.rows)) return null;
  const keyword = CONFIG.CROSS_NIGHT_KEYWORD || '跨夜';
  let minutes = null;

  for (const row of slot.rows) {
    if (!String(row.train || '').includes(keyword)) continue;
    if (row.aTimeMin !== null && row.aTimeMin !== undefined && !isNaN(row.aTimeMin)) {
      minutes = row.aTimeMin;
    } else if (row.sTimeMin !== null && row.sTimeMin !== undefined && !isNaN(row.sTimeMin)) {
      minutes = row.sTimeMin;
    }
    if (minutes !== null) return makeDateAtMinutes(date, minutes);
  }
  return null;
}

/**
 * 是否為跨夜日：班表名稱含「跨夜」且 Schedule_S 有跨夜列。
 * 若同一天還有完整時間的正常班次，視為正常工作日，忽略跨夜列（避免資料異常時產生奇怪區間）。
 */
function isCrossNightDay(workRow, slot) {
  if (!workRow || !isCrossNightScheduleName(workRow.train)) return false;
  if (!slot || !Array.isArray(slot.rows)) return false;
  const keyword = CONFIG.CROSS_NIGHT_KEYWORD || '跨夜';
  const hasCrossNightRow = slot.rows.some(row => String(row.train || '').includes(keyword));
  if (!hasCrossNightRow) return false;

  const hasNormalTrain = slot.rows.some(row => {
    if (String(row.train || '').includes(keyword)) return false;
    return row.sTimeMin !== null && row.sTimeMin !== undefined &&
      row.aTimeMin !== null && row.aTimeMin !== undefined;
  });
  return !hasNormalTrain;
}

/**
 * 判斷前後兩天是否為同一班別的連續兩天（例如 514-1 → 514-2）。
 */
function isContinuousShiftSlot(prevSlot, nextSlot) {
  if (!prevSlot || !nextSlot) return false;
  if (!prevSlot.shiftBase || prevSlot.shiftBase !== nextSlot.shiftBase) return false;
  if (prevSlot.shiftDay === null || prevSlot.shiftDay === undefined) return false;
  if (nextSlot.shiftDay === null || nextSlot.shiftDay === undefined) return false;
  return nextSlot.shiftDay === prevSlot.shiftDay + 1;
}

/**
 * 跨夜日放假起點：
 *   1. 跨夜列有時間 → 使用該時間
 *   2. 跨夜列沒有時間，或時間早於前一天最後一班車結束 → 使用前一天算出的後整結束
 *   3. 前一天沒有同班別班次 → 當日 00:00
 */
function getCrossNightLeaveStart(ctx, staff, date) {
  const workRow = getStaffWorkScheduleRow(ctx, staff, date);
  const slot = getStaffSlotForDate(ctx, staff, date);
  if (!isCrossNightDay(workRow, slot)) return null;

  const crossNightTime = getSlotCrossNightTime(slot, date);
  const prevDate = addDays(date, -1);
  const prevWorkRow = getStaffWorkScheduleRow(ctx, staff, prevDate);
  const prevSlot = getStaffSlotForDate(ctx, staff, prevDate);
  let prevPostEnd = null;

  if (prevWorkRow && !isRestSchedule(prevWorkRow) &&
      isContinuousShiftSlot(prevSlot, slot) &&
      prevSlot && prevSlot.rows.length) {
    const prevTimeline = buildSlotTimeline(prevSlot, prevDate);
    if (prevTimeline) {
      prevPostEnd = getLastTrainPostEnd(prevTimeline.lastTrain);
      if (crossNightTime && crossNightTime.getTime() < prevTimeline.lastTrain.end.getTime()) {
        return prevPostEnd;
      }
    }
  }

  const dayStart = makeDateAtMinutes(date, 0);
  if (crossNightTime) return crossNightTime;
  if (prevPostEnd && prevPostEnd.getTime() >= dayStart.getTime()) return prevPostEnd;
  return dayStart;
}

function buildStaffStatusIntervals(ctx, staff, rangeStart, rangeEnd) {
  const start = addDays(rangeStart, 0);
  const end = addDays(rangeEnd, 0);
  const days = [];

  for (let d = new Date(start); d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const workRow = getStaffWorkScheduleRow(ctx, staff, date);
    const isRest = isRestSchedule(workRow);
    const slot = getStaffSlotForDate(ctx, staff, date);
    const crossNight = !isRest && isCrossNightDay(workRow, slot);
    let timeline = null;
    if (!isRest && !crossNight && slot && slot.rows.length) {
      timeline = buildSlotTimeline(slot, date);
    }
    const day = {
      date,
      work: !!timeline,
      slot: timeline ? slot : null,
      timeline,
      workRow,
      isCrossNight: crossNight,
      crossNightSlot: crossNight ? slot : null,
      crossNightTime: crossNight ? getSlotCrossNightTime(slot, date) : null,
      crossNightStart: null,
      onMin: workRow && workRow.onMin !== undefined ? workRow.onMin : null,
      offMin: workRow && workRow.offMin !== undefined ? workRow.offMin : null
    };
    days.push(day);
  }

  const dayByDate = {};
  days.forEach(day => {
    dayByDate[dateKey(day.date)] = day;
  });

  // 將連續且屬於同一班的日期合併成「班別區塊」。
  // 兩天班（501-1 → 501-2）必須視為同一個工作區塊，才能判斷跨夜時段。
  const blocks = [];
  let current = null;
  days.forEach(day => {
    if (!day.work) {
      current = null;
      return;
    }
    const prevDay = current ? current.days[current.days.length - 1] : null;
    const isContinuation = !!prevDay &&
      Math.round((day.date.getTime() - prevDay.date.getTime()) / 86400000) === 1 &&
      day.slot.shiftBase &&
      prevDay.slot.shiftBase === day.slot.shiftBase &&
      day.slot.shiftDay !== null &&
      prevDay.slot.shiftDay !== null &&
      day.slot.shiftDay === prevDay.slot.shiftDay + 1;

    if (!current || !isContinuation) {
      current = { days: [], trains: [] };
      blocks.push(current);
    }
    current.days.push(day);
    day.timeline.trains.forEach(t => {
      current.trains.push({
        start: t.start,
        end: t.end,
        row: t.row,
        slot: day.slot,
        serviceDate: day.date
      });
    });
  });

  const trains = [];
  const rests = [];
  const leaves = [];

  blocks.forEach(block => {
    block.trains.sort((a, b) => a.start - b.start);
    if (!block.trains.length) return;

    // 逐日計算第一班車的報到起點與最後一班車的後整終點。
    const dayInfos = block.days.map(day => {
      const firstTrain = day.timeline.firstTrain;
      const lastTrain = day.timeline.lastTrain;
      return {
        day,
        firstTrain,
        lastTrain,
        reportStart: getFirstTrainReportStart(firstTrain),
        postEnd: getLastTrainPostEnd(lastTrain)
      };
    });
    let blockEnd = dayInfos[dayInfos.length - 1].postEnd;

    block.trains.forEach(t => {
      trains.push({
        type: '值乘',
        start: t.start,
        end: t.end,
        row: t.row,
        slot: t.slot,
        serviceDate: t.serviceDate
      });
    });

    dayInfos.forEach((info, i) => {
      const { day, firstTrain, lastTrain, reportStart, postEnd } = info;
      const nextDayInfo = i < dayInfos.length - 1 ? dayInfos[i + 1] : null;
      // 翌日若為同班別的跨夜日（班表名稱含跨夜、有跨夜列、當日沒有班次），
      // D1 收班後直接接到跨夜列時間，不列一般後整，改列 D1下班。
      const nextCalendarDay = dayByDate[dateKey(addDays(day.date, 1))];
      const nextCrossNight = !nextDayInfo &&
        nextCalendarDay &&
        nextCalendarDay.isCrossNight &&
        isContinuousShiftSlot(day.slot, nextCalendarDay.crossNightSlot)
        ? nextCalendarDay
        : null;

      // 報到（前整）：只套用於區塊的第一天；
      // 兩天班的第二天報到時間已包含在前一晚的跨夜中場區間內。
      if (i === 0 && reportStart.getTime() < firstTrain.start.getTime()) {
        rests.push({
          type: '中場',
          restKind: 'report',
          start: reportStart,
          end: firstTrain.start,
          station: firstTrain.row.sStation,
          prevTrain: null,
          nextTrain: firstTrain.row,
          slot: day.slot,
          nextSlot: day.slot,
          serviceDate: day.date
        });
      }

      // 中場：當日班次之間的空檔；中間班次不套用前整／後整特殊設定。
      for (let j = 0; j < day.timeline.trains.length - 1; j++) {
        const a = day.timeline.trains[j];
        const b = day.timeline.trains[j + 1];
        if (b.start.getTime() > a.end.getTime()) {
          rests.push({
            type: '中場',
            restKind: 'mid',
            start: a.end,
            end: b.start,
            station: a.row.aStation,
            prevTrain: a.row,
            nextTrain: b.row,
            slot: day.slot,
            nextSlot: day.slot,
            serviceDate: day.date
          });
        }
      }

      // 後整：只套用於區塊最後一天；兩天班的第一天不列後整。
      // 若翌日為跨夜日，後整改由下面的 D1下班 取代。
      if (!nextDayInfo && !nextCrossNight && lastTrain.end.getTime() < postEnd.getTime()) {
        rests.push({
          type: '中場',
          restKind: 'post',
          start: lastTrain.end,
          end: postEnd,
          station: lastTrain.row.aStation,
          prevTrain: lastTrain.row,
          nextTrain: null,
          slot: day.slot,
          nextSlot: day.slot,
          serviceDate: day.date
        });
      }

      // 兩天班的跨夜時段：第一天最後一班車結束後，直接銜接翌日第一班車開車，
      // 區間涵蓋第一天的後整與翌日的報到時間。
      if (nextDayInfo) {
        const overnightStart = lastTrain.end;
        const overnightEnd = nextDayInfo.firstTrain.start;
        if (overnightStart.getTime() < overnightEnd.getTime()) {
          rests.push({
            type: '中場',
            restKind: 'overnight',
            start: overnightStart,
            end: overnightEnd,
            station: lastTrain.row.aStation,
            prevTrain: lastTrain.row,
            nextTrain: nextDayInfo.firstTrain.row,
            slot: day.slot,
            nextSlot: nextDayInfo.day.slot,
            serviceDate: day.date,
            isOvernight: true
          });
        }
      }

      // 跨夜班：D1 最後一班車結束後直接接到跨夜列時間，
      // 該區間取代後整；跨夜列沒有時間或時間早於收班時間時，改用算出的後整結束時間。
      if (nextCrossNight) {
        const overnightStart = lastTrain.end;
        let overnightEnd = nextCrossNight.crossNightTime;
        if (!overnightEnd || overnightEnd.getTime() < overnightStart.getTime()) {
          overnightEnd = postEnd;
        }
        if (overnightEnd.getTime() > overnightStart.getTime()) {
          rests.push({
            type: '中場',
            restKind: 'overnight',
            start: overnightStart,
            end: overnightEnd,
            station: lastTrain.row.aStation,
            prevTrain: lastTrain.row,
            nextTrain: null,
            slot: day.slot,
            nextSlot: nextCrossNight.crossNightSlot || nextCrossNight.slot || day.slot,
            serviceDate: day.date,
            isOvernight: true,
            isCrossNightLeave: true
          });
        }
        nextCrossNight.crossNightStart = overnightEnd;
        blockEnd = overnightEnd;
      }
    });

    block.start = dayInfos[0].reportStart;
    block.end = blockEnd;
  });
  // 「放假」依班表名稱逐日判定：當日沒有班次，且班表名稱含「休息日／例假／跨夜」即列出。
  // 跨夜班的放假起點為跨夜列時間；沒有跨夜列時間時，改用前一天算出的後整結束時間。
  // 放假結束時間延伸到下一個上班日的報到時間；範圍內找不到上班日時，以當天 24:00 為準。
  days.forEach((day, dayIndex) => {
    if (day.work) return;
    const name = day.workRow ? String(day.workRow.train || '').trim() : '';
    if (!isLeaveScheduleName(name)) return;

    const dayStart = makeDateAtMinutes(day.date, 0);
    const dayEnd = makeDateAtMinutes(addDays(day.date, 1), 0);
    let start = dayStart;

    if (day.isCrossNight) {
      const prevDay = dayByDate[dateKey(addDays(day.date, -1))];
      const prevPostEnd = prevDay && prevDay.work && prevDay.timeline &&
        isContinuousShiftSlot(prevDay.slot, day.crossNightSlot)
        ? getLastTrainPostEnd(prevDay.timeline.lastTrain)
        : null;
      start = day.crossNightStart || day.crossNightTime || prevPostEnd || dayStart;
      if (start.getTime() < dayStart.getTime() || start.getTime() >= dayEnd.getTime()) start = dayStart;
    }

    // 找下一個上班日（有班次的第一天），以其報到開始時間作為放假結束。
    let end = dayEnd;
    for (let i = dayIndex + 1; i < days.length; i++) {
      const nextDay = days[i];
      if (nextDay.work && nextDay.timeline) {
        const reportStart = getFirstTrainReportStart(nextDay.timeline.firstTrain);
        if (reportStart.getTime() > start.getTime()) end = reportStart;
        break;
      }
    }

    leaves.push({
      type: '放假',
      start,
      end,
      leaveStart: start,
      leaveEnd: end,
      isCrossNight: day.isCrossNight,
      restNames: [name],
      workRow: day.workRow,
      serviceDate: day.date
    });
  });

  return {
    trains: trains.sort((a, b) => a.start - b.start),
    rests: rests.sort((a, b) => a.start - b.start),
    leaves: leaves.sort((a, b) => a.start - b.start),
    blocks
  };
}

function getStaffWorkScheduleRow(ctx, staff, date) {
  const cycleLength = ctx.cycleLengthByGroup[staff.group];
  if (!cycleLength) return null;
  const diffDays = Math.round((date.getTime() - ctx.baseDate.getTime()) / 86400000);
  const index = getScheduleSIndex(staff.baseIndex, diffDays, cycleLength);
  return ctx.workScheduleMap[`${staff.group}_${index}`] || null;
}

function isRestSchedule(row) {
  if (!row || !row.train) return false;
  const name = String(row.train);
  return name.includes('休息日') || name.includes('例假');
}

/**
 * 「放假」查詢的判定基準：班表名稱含「休息日／例假／跨夜」即視為放假班表。
 * 例假班表名稱為「例假(第幾周)」，因此以包含「例假」兩字比對。
 */
function isLeaveScheduleName(name) {
  const s = String(name || '');
  const keywords = (CONFIG.STATUS_LEAVE_KEYWORDS && CONFIG.STATUS_LEAVE_KEYWORDS.length)
    ? CONFIG.STATUS_LEAVE_KEYWORDS
    : ['休息日', '例假', '跨夜'];
  return keywords.some(k => s.includes(k));
}

function dateKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}


function findStaffsByName(ctx, name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return [];

  const seen = new Set();
  const result = [];
  // 僅支援有 Schedule_S 班表的車長群組（日管／日內不列入）。
  ctx.activeStaff.forEach(staff => {
    if (String(staff.name || '').trim().toLowerCase() !== target) return;
    const key = `${staff.group}_${staff.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(staff);
  });
  return result;
}

/**
 * 班表明細查詢用的輪值 Index（僅車長群組，沿用 Schedule_S 週期）。
 */
function getStaffScheduleIndexForDetail(ctx, staff, date) {
  const diffDays = Math.round((date.getTime() - ctx.baseDate.getTime()) / 86400000);
  const cycleLength = ctx.cycleLengthByGroup[staff.group];
  if (!cycleLength) return null;
  return getScheduleSIndex(staff.baseIndex, diffDays, cycleLength);
}

function getStaffWorkScheduleRowForDetail(ctx, staff, date) {
  const index = getStaffScheduleIndexForDetail(ctx, staff, date);
  if (index === null) return null;
  return ctx.workScheduleMap[`${staff.group}_${index}`] || null;
}

function getStaffSlotForDetail(ctx, staff, date) {
  const index = getStaffScheduleIndexForDetail(ctx, staff, date);
  if (index === null) return null;
  return ctx.scheduleSMap[`${staff.group}_${index}`] || null;
}

/**
 * 是否為兩天班（或連續多天班）的續班日：
 * 前一天為工作日、且與當日屬於同一班別的連續兩天（例如 507-1 → 507-2）。
 */
function isContinuationWorkDay(ctx, staff, date, slot) {
  if (!slot) return false;
  const prevDate = addDays(date, -1);
  const prevWorkRow = getStaffWorkScheduleRowForDetail(ctx, staff, prevDate);
  const prevSlot = getStaffSlotForDetail(ctx, staff, prevDate);
  if (!prevSlot || !prevSlot.rows.length) return false;
  if (isRestSchedule(prevWorkRow) || isCrossNightDay(prevWorkRow, prevSlot)) return false;
  return isContinuousShiftSlot(prevSlot, slot);
}

function buildScheduleResponse(queryGroups) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  const staffSheet = ss.getSheetByName('Staff');
  if (!staffSheet) throw new Error('找不到工作表 Staff');
  const staffData = staffSheet.getDataRange().getValues();

  // Schedule 表改為可選：只維護 Schedule_S 時沒有此表也能查（由 Schedule_S 組出摘要）
  const scheduleSheet = ss.getSheetByName('Schedule');
  const scheduleData = scheduleSheet ? scheduleSheet.getDataRange().getDisplayValues() : [];

  // 車次號碼只存在 Schedule_S（Schedule 表的 Train 欄是班表名稱，不是車次）。
  // 載入失敗時不中斷，車次比對僅退回 Schedule 表。
  let scheduleSCtx = null;
  try {
    scheduleSCtx = loadScheduleSContext();
  } catch (error) {
    console.error(`讀取 Schedule_S 失敗，車次比對僅使用 Schedule 表：${error && error.message}`);
  }

  // 1-to-N HashMap 重構：解決同名覆蓋問題
  // 鍵統一「半形＋小寫」，避免全形數字/空白或大小寫造成「查無此員工資料」
  const staffMap = {};
  for (let i = 1; i < staffData.length; i++) {
    const displayName = String(staffData[i][2] || '').trim();
    const group = normalizeGroupName(staffData[i][0]);
    const baseIndex = parseInt(staffData[i][1], 10);
    if (!displayName || !group || isNaN(baseIndex)) continue;
    const key = toHalfWidth(displayName).toLowerCase();
    if (!staffMap[key]) staffMap[key] = [];
    staffMap[key].push({ name: displayName, group, baseIndex });
  }

  const scheduleMap = {};
  for (let i = 1; i < scheduleData.length; i++) {
    const key = `${normalizeGroupName(scheduleData[i][0])}_${scheduleData[i][1]}`;
    scheduleMap[key] = {
      number: scheduleData[i][2],
      train: scheduleData[i][3],
      on: scheduleData[i][4],
      off: scheduleData[i][5]
    };
  }

  // 閉包工具：取得指定員工在 diffDays 天後的輪值 Index
  // (Strategy Pattern 處理正逆向循環；週期優先採用 Schedule_S 設定，與網頁版一致)
  const getStaffScheduleIndex = (staffObj, diffDays) => {
    const ctxCycle = (scheduleSCtx && scheduleSCtx.cycleLengthByGroup[staffObj.group]) || 0;

    let targetIndex;
    // 判斷是否為遞增循環群組 (日管、日內)
    if ((CONFIG.INCREMENT_GROUPS || []).includes(staffObj.group)) {
      const cycleLength = ctxCycle || 3;
      // 遞增公式：baseIndex 隨日期推進向上累加
      const rawIndex = (staffObj.baseIndex - 1) + diffDays;
      targetIndex = ((rawIndex % cycleLength + cycleLength) % cycleLength) + 1;
    } else {
      const cycleLength = ctxCycle || (staffObj.group === 'C' ? 20 : 47);
      // 遞減公式：車長等常規群組
      const rawIndex = 1 - (staffObj.baseIndex - 1) + diffDays;
      targetIndex = ((rawIndex - 1) % cycleLength + cycleLength) % cycleLength + 1;
    }

    return targetIndex;
  };

  // 回傳 { sched: 當日摘要(工作班/班表/上班/下班), slot: Schedule_S 當日班次列, key }
  const getStaffSchedule = (staffObj, diffDays) => {
    const key = `${staffObj.group}_${getStaffScheduleIndex(staffObj, diffDays)}`;
    const slot = (scheduleSCtx && scheduleSCtx.scheduleSMap[key]) || null;
    let sched = scheduleMap[key] || null;
    if (!sched && slot && slot.rows.length) {
      sched = summarizeSlot_(slot); // Schedule 表缺這天的列時，改用 Schedule_S 組摘要
    }
    return { sched, slot, key };
  };

  const baseDate = new Date(CONFIG.BASE_DATE);
  let finalOutput = "";
  let isFirstDate = true;

  queryGroups.forEach(group => {
    group.dates.forEach(targetDate => {
      if (!isFirstDate) finalOutput += `\n---\n`;
      isFirstDate = false;
      finalOutput += `${formatDateOutput(targetDate)}\n`;

      // 針對完全無效的查詢進行阻擋
      if (group.names.length === 0 && group.trains.length === 0 && group.shifts.length === 0 && !group.isWorkingOnly) {
        finalOutput += `\n(請輸入要查詢的員工姓名、車次、班別或「班表」)\n`;
        return;
      }

      const diffDays = Math.round((targetDate - baseDate) / (1000 * 60 * 60 * 24));

      const printedStaff = new Set();
      const matchedRecords = []; // 用來暫存當日所有符合條件的資料，以便後續排序

      const collectSchedule = (staffObj, info) => {
        const uniqueKey = `${staffObj.group}_${staffObj.name}`;
        if (printedStaff.has(uniqueKey)) return;
        printedStaff.add(uniqueKey);

        matchedRecords.push({ staffObj, schedule: info.sched, info });
      };

      const isNameQuery = group.names.length > 0;
      const isShiftQuery = group.shifts.length > 0;
      const isTrainQuery = group.trains.length > 0;

      // 車次比對：Schedule 表（工作班/班表名稱）與 Schedule_S（實際車次號碼）都算命中
      const matchesTrain = (info) => group.trains.some(t =>
        isPreciseMatch(info.sched && info.sched.number, t) ||
        isPreciseMatch(info.sched && info.sched.train, t) ||
        (info.slot && info.slot.rows.some(r => isPreciseMatch(r.train, t))));

      // 查詢路徑 A: 索引查找 (Index Seek - 基於姓名)
      if (isNameQuery) {
        group.names.forEach(name => {
          const staffs = staffMap[toHalfWidth(String(name)).trim().toLowerCase()];
          if (!staffs) {
            finalOutput += `\n${name}\n查無此員工資料\n`;
            return;
          }
          staffs.forEach(staff => {
            const info = getStaffSchedule(staff, diffDays);
            if (!info.sched) {
              finalOutput += `\n[${staff.group}] ${staff.name}\n班表建置異常\n`;
              return;
            }

            let pass = true;
            if (isShiftQuery) pass = group.shifts.some(s => (info.sched.number && info.sched.number.includes(s)) || (info.sched.train && info.sched.train.includes(s)));
            if (pass && isTrainQuery) pass = matchesTrain(info);

            // 剔除休假與例假（跨夜列同樣視為放假）
            if (pass && group.isWorkingOnly) {
              pass = info.sched.train && !isLeaveScheduleName(info.sched.train);
            }

            if (pass) collectSchedule(staff, info);
          });
        });
      }
      // 查詢路徑 B: 全表掃描 (Full Table Scan - 處理班別、車次、或僅輸入「班表」的全域查詢)
      else if (isShiftQuery || isTrainQuery || group.isWorkingOnly) {
        Object.values(staffMap).flat().forEach(staff => {
          const info = getStaffSchedule(staff, diffDays);
          if (!info.sched) return;

          let pass = true;

          if (isShiftQuery) {
            if (!(CONFIG.INCREMENT_GROUPS || []).includes(staff.group)) pass = false;
            else pass = group.shifts.some(s => (info.sched.number && info.sched.number.includes(s)) || (info.sched.train && info.sched.train.includes(s)));
          }

          if (pass && isTrainQuery) pass = matchesTrain(info);

          if (pass && group.isWorkingOnly) {
            pass = info.sched.train && !isLeaveScheduleName(info.sched.train);
          }

          if (pass) collectSchedule(staff, info);
        });
      }

      // ==========================================
      // 資料排序與組裝輸出
      // ==========================================
      if (matchedRecords.length === 0) {
        finalOutput += `\n(查無符合條件的班表資料)\n`;
      } else {
        // 1. 根據上班時間 (schedule.on) 進行排序
        matchedRecords.sort((a, b) => {
          const normalizeTime = (timeStr) => {
            if (!timeStr) return '99:99'; // 沒有上班時間的排到最下面
            let s = timeStr.toString().trim();
            if (/^\d:\d{2}/.test(s)) s = '0' + s; // 8:30 -> 08:30 避免 8 比 10 大的錯誤
            return s;
          };

          const timeA = normalizeTime(a.schedule.on);
          const timeB = normalizeTime(b.schedule.on);

          return timeA.localeCompare(timeB);
        });

        // 2. 依序渲染文字輸出
        matchedRecords.forEach(record => {
          const { staffObj, schedule, info } = record;
          finalOutput += `\n[${staffObj.group}] ${staffObj.name}`;
          if (schedule.number) finalOutput += `\n工作班：${schedule.number}`;
          if (schedule.train) finalOutput += `\n班表：${schedule.train}`;
          if (schedule.on) finalOutput += `\n上班：${schedule.on}`;
          if (schedule.off) finalOutput += `\n下班：${schedule.off}`;
          const trainList = slotTrainText_(info);
          if (trainList) finalOutput += `\n車次：${trainList}`;
          finalOutput += `\n`;
        });
      }
    });
  });

  return finalOutput.trim();
}

/**
 * 由 Schedule_S 的當日班次列組出摘要（Schedule 表缺列時的後備顯示）。
 */
function summarizeSlot_(slot) {
  if (!slot || !Array.isArray(slot.rows)) return null;
  const timed = slot.rows.filter(r =>
    r.sTimeMin !== null && r.sTimeMin !== undefined &&
    r.aTimeMin !== null && r.aTimeMin !== undefined);
  const label = formatShiftLabel(slot);
  if (timed.length) {
    const onMin = timed.reduce((min, r) => Math.min(min, r.sTimeMin), 24 * 60);
    const offMax = timed.reduce((max, r) => Math.max(max, r.aTimeMin), 0);
    return { number: label, train: label, on: formatTime(onMin), off: formatTime(offMax) };
  }
  const named = slot.rows.find(r => r.train);
  if (named) return { number: named.number || label, train: named.train, on: '', off: '' };
  return null;
}

/**
 * 當日實際車次清單（來自 Schedule_S），供姓名查詢與車次反查顯示。
 * 跳過休息日／例假／跨夜等放假列。
 */
function slotTrainText_(info) {
  if (!info || !info.slot || !Array.isArray(info.slot.rows)) return '';
  const parts = info.slot.rows
    .filter(r => r.train && !isLeaveScheduleName(r.train))
    .map(r => (r.sTimeMin !== null && r.sTimeMin !== undefined &&
               r.aTimeMin !== null && r.aTimeMin !== undefined)
      ? `${r.train}(${formatTime(r.sTimeMin)}-${formatTime(r.aTimeMin)})`
      : String(r.train));
  return parts.join('、');
}

function sendLineReply(replyToken, text) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: String(text || '').trim() ? String(text) : '查無資料，輸入 ? 可查看教學。' }]
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    payload: JSON.stringify(payload),
    // 失敗（401 權杖過期／400 內容錯誤…）時不要直接丟例外，把狀態碼寫進執行記錄才查得到原因
    muteHttpExceptions: true
  });
  logLineApiResponse_(response);
}

/**
 * 把 LINE Reply API 的回應狀態寫進執行記錄。
 * 「機器人完全沒反應」最常見的原因就是這裡回傳 401（token 失效/未設 LINE_TOKEN）或 400，
 * 原本不記錄時在 GAS 上完全看不到任何跡象。
 */
function logLineApiResponse_(response) {
  try {
    const code = response && response.getResponseCode ? response.getResponseCode() : null;
    if (code === null || code === undefined) return;
    if (code < 300) {
      console.log(`LINE Reply API：HTTP ${code}`);
      return;
    }
    let body = '';
    try { body = response.getContentText ? response.getContentText() : ''; } catch (e) { body = ''; }
    console.error(`LINE Reply API 失敗：HTTP ${code} ${String(body).slice(0, 500)}`);
  } catch (logError) {
    console.error(`記錄 LINE 回應失敗：${logError}`);
  }
}
