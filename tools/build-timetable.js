#!/usr/bin/env node
// ============================================================
// tools/build-timetable.js——產生 docs/data/timetable.json（affected-plan.md §10／§16 步驟 8）
//
// 輸入：
//   --csv  <path>  Schedule_S CSV（母體：班表出現的車次）
//   --tdx  <path>  TDX 定期時刻表 JSON（GeneralTrainTimetable，全量，腳本過濾到母體）
//   --out  <path>  輸出 JSON（預設 docs/data/timetable.json，壓縮單行）
//   --reports <dir> 驗證報告目錄（預設 tools/reports）
//   --kms <path>   站名→KM 對照（預設 tools/station-kms.json，存在才做站碼 vs KM 驗證）
//   --overrides <path> 人工補對照車次（預設 tools/timetable-overrides.json，存在才合併）
//
// 正規化規則（§8.3，依 2026/11/25 實測資料定案）：
//   - 去「便」後綴：1288便 → 1288（實測時間全吻合）
//   - 去括號附註：3148(3146) → 3148（實測時間吻合）
//   - A/B 後綴（115A、156B、3292B便…）＝折返續開腿，定期表查無且基數車為反方向／另一班
//     → **不**自動退回基數（會對到錯的車），進 unmatched.txt 人工補（tools/timetable-overrides.json）
//   - 對不上的一律進 unmatched.txt，不做模糊比對硬猜
//
// 輸出驗證報告（§10 三份的精神）：
//   tools/reports/unmatched.txt     母體車次在 TDX 查不到的清單（最重要，防靜默漏車）
//   tools/reports/build-report.txt  覆蓋率／時間比對／站碼 vs KM 排序／跨夜清單／下拉站
//
// 已知限制（v1，見 affected-plan.md §6/§17）：
//   - TDX 時間格式為 HH:MM（實測無 24:xx），跨夜由「後站時間 < 前站時間」偵測並 +1440
//   - serviceDay 前端 v1 只比對星期；NationalHolidays 帶入但不判定（無假日曆）
//   - 本機 Node 執行，不連網、無相依套件
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- 參數 ----------
function argValue(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ROOT = path.join(__dirname, '..');
const CSV_PATH = argValue('csv', null);
const TDX_PATH = argValue('tdx', null);
const OUT_PATH = argValue('out', path.join(ROOT, 'docs', 'data', 'timetable.json'));
const REPORT_DIR = argValue('reports', path.join(__dirname, 'reports'));
const KMS_PATH = argValue('kms', path.join(__dirname, 'station-kms.json'));
const OVERRIDES_PATH = argValue('overrides', path.join(__dirname, 'timetable-overrides.json'));

if (!CSV_PATH || !TDX_PATH) {
  console.error('Usage: node tools/build-timetable.js --csv <Schedule_S.csv> --tdx <GeneralTrainTimetable.json> [--out docs/data/timetable.json] [--reports tools/reports]');
  process.exit(1);
}

// ---------- 小工具 ----------
const normStn = (s) => String(s || '')
  .replace(/\s+/g, '')
  .replace(/臺/g, '台')
  .replace(/火車站$/, '')
  .replace(/車站$/, '')
  .replace(/站$/, '')
  .trim();
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function fmt(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
// 正規化候選：原樣 → 去「便」 → 去括號 → 去括號＋去「便」（不做 A/B 剝除，見檔頭說明）
function normalizeCandidates(train) {
  const t = String(train || '').trim();
  const list = [t];
  const noBian = t.replace(/便$/, '');
  if (noBian !== t) list.push(noBian);
  const noParen = t.replace(/\([^)]*\)/g, '').trim();
  if (noParen !== t && list.indexOf(noParen) < 0) list.push(noParen);
  const noParenBian = noParen.replace(/便$/, '');
  if (noParenBian !== noParen && list.indexOf(noParenBian) < 0) list.push(noParenBian);
  return list;
}
// TDX 停靠序列 → [[stationId, arrMin, depMin], ...]（營運日 00:00 起算分鐘，跨夜 >1440）
function stopsToMinutes(stopTimes) {
  const out = [];
  let off = 0;
  let prev = -1;
  for (const s of stopTimes) {
    const aRaw = parseHM(s.ArrivalTime);
    const dRaw = parseHM(s.DepartureTime);
    if (aRaw == null || dRaw == null) throw new Error('無法解析時間: ' + JSON.stringify(s));
    let arr = aRaw + off;
    while (arr < prev) { off += 1440; arr = aRaw + off; }
    let dep = dRaw + off;
    if (dep < arr) { off += 1440; arr = aRaw + off; dep = dRaw + off; }
    out.push([String(s.StationID), arr, dep]);
    prev = dep;
  }
  return out;
}

// ---------- 讀 CSV ----------
let raw = fs.readFileSync(CSV_PATH, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const csvRows = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(','));
const csvHeader = csvRows[0].map((h) => String(h || '').trim().toLowerCase());
const col = (name) => csvHeader.indexOf(name);
const C_TRAIN = col('train'), C_S = col('s_station'), C_A = col('a_station'),
  C_ST = col('s_time'), C_AT = col('a_time'), C_GROUP = col('group'), C_INDEX = col('index');
[[C_TRAIN, 'train'], [C_S, 's_station'], [C_A, 'a_station'], [C_ST, 's_time'], [C_AT, 'a_time']]
  .forEach((c) => { if (c[0] < 0) throw new Error('CSV 缺欄位：' + c[1]); });

const legs = [];
for (const r of csvRows.slice(1)) {
  const train = String(r[C_TRAIN] || '').trim();
  if (!/^\d/.test(train)) continue;            // 非班次列（例假／休息日／跨夜）不入母體
  legs.push({
    train: train,
    s: String(r[C_S] || '').trim(),
    a: String(r[C_A] || '').trim(),
    dep: parseHM(r[C_ST]),
    arr: parseHM(r[C_AT]),
    group: String(r[C_GROUP] || '').trim(),
    index: String(r[C_INDEX] || '').trim()
  });
}

// ---------- 讀 TDX ----------
const tdx = JSON.parse(fs.readFileSync(TDX_PATH, 'utf8'));
const tdxByNo = new Map();
for (const t of tdx.TrainTimetables || []) {
  const no = String((t.TrainInfo && t.TrainInfo.TrainNo) || '').trim();
  if (no && !tdxByNo.has(no)) tdxByNo.set(no, t);
}
// id→站名（TDX 全量；供時間比對與站清單用）
const stationNameById = {};
for (const t of tdx.TrainTimetables || []) {
  for (const s of t.StopTimes || []) {
    const id = String(s.StationID);
    if (!stationNameById[id]) stationNameById[id] = (s.StationName && s.StationName.Zh_tw) || '';
  }
}

// ---------- 母體 → TDX 對應 ----------
const legGroups = new Map();   // TDX 車次 → legs[]
const matchOf = new Map();     // 原始車次字串 → { no, rule }
const unmatched = new Map();   // 原始車次字串 → legs[]
for (const leg of legs) {
  const cands = normalizeCandidates(leg.train);
  let hit = null;
  for (const c of cands) {
    if (tdxByNo.has(c)) {
      hit = { no: c, rule: c === leg.train ? '原樣' : (c === leg.train.replace(/便$/, '') ? '去便' : '去括號') };
      break;
    }
  }
  if (hit) {
    matchOf.set(leg.train, hit);
    if (!legGroups.has(hit.no)) legGroups.set(hit.no, []);
    legGroups.get(hit.no).push(leg);
  } else {
    if (!unmatched.has(leg.train)) unmatched.set(leg.train, []);
    unmatched.get(leg.train).push(leg);
  }
}

// ---------- 人工補對照（tools/timetable-overrides.json）----------
const overrides = [];
if (fs.existsSync(OVERRIDES_PATH)) {
  let o;
  try {
    o = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch (e) {
    throw new Error('overrides 檔解析失敗（' + OVERRIDES_PATH + '）：' + e.message);
  }
  for (const t of o.trains || []) {
    if (!t || !t.no || !Array.isArray(t.stops) || t.stops.length < 2) continue;
    overrides.push(t);
  }
}
const overrideByNo = new Map(overrides.map((t) => [String(t.no).trim(), t]));

// ---------- 組 trains ----------
function serviceDayOf(sd) {
  const out = {
    mon: sd.Monday === 1 ? 1 : 0, tue: sd.Tuesday === 1 ? 1 : 0, wed: sd.Wednesday === 1 ? 1 : 0,
    thu: sd.Thursday === 1 ? 1 : 0, fri: sd.Friday === 1 ? 1 : 0, sat: sd.Saturday === 1 ? 1 : 0,
    sun: sd.Sunday === 1 ? 1 : 0, holiday: sd.NationalHolidays === 1 ? 1 : 0
  };
  // v1 前端只比對星期（＋holiday 欄位帶入供日後使用）
  out.dayBeforeHoliday = sd.DayBeforeHoliday === 1 ? 1 : 0;
  out.dayAfterHoliday = sd.DayAfterHoliday === 1 ? 1 : 0;
  return out;
}

const trains = [];
const timeMismatches = [];
for (const [no, tLegs] of legGroups) {
  const t = tdxByNo.get(no);
  const info = t.TrainInfo || {};
  const stops = stopsToMinutes(t.StopTimes || []);
  // 班次時間比對（±1 分，跨夜雙側修正）——只驗證，不影響匯入
  for (const leg of tLegs) {
    const iS = stops.findIndex((s) => normStn(stationNameById[s[0]]) === normStn(leg.s));
    const iA = stops.findIndex((s) => normStn(stationNameById[s[0]]) === normStn(leg.a));
    if (iS < 0 || iA < 0 || iA <= iS) {
      timeMismatches.push({ train: leg.train, no: no, leg: leg.s + '→' + leg.a, reason: '站序對不上（' + leg.group + '/' + leg.index + '）' });
      continue;
    }
    const dT = stops[iS][2], aT = stops[iA][1];
    let lArr = leg.arr;
    if (lArr < leg.dep) lArr += 1440;
    if (Math.abs(dT - leg.dep) > 1 || Math.abs(aT - lArr) > 1) {
      timeMismatches.push({
        train: leg.train, no: no,
        leg: leg.s + '→' + leg.a + '（' + leg.group + '/' + leg.index + '）',
        reason: '班表 ' + fmt(leg.dep) + '-' + fmt(lArr) + ' vs TDX ' + fmt(dT) + '-' + fmt(aT)
      });
    }
  }
  trains.push({
    no: no,
    type: (info.TrainTypeName && info.TrainTypeName.Zh_tw) || '',
    typeCode: String(info.TrainTypeCode || ''),
    headsign: info.TripHeadSign || '',
    extraTrain: info.ExtraTrainFlag === 1,
    serviceDay: serviceDayOf(t.ServiceDay || {}),
    note: String(info.Note || ''),
    stops: stops
  });
}
// overrides：補 unmatched 或覆蓋既有車次
const overridden = new Set();
for (const t of overrides) {
  const no = String(t.no).trim();
  const idx = trains.findIndex((x) => x.no === no);
  const entry = {
    no: no,
    type: t.type || '',
    typeCode: String(t.typeCode || ''),
    headsign: t.headsign || '',
    extraTrain: !!t.extraTrain,
    serviceDay: t.serviceDay || { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 },
    note: t.note || '人工補對照',
    stops: t.stops.map((s) => [String(s[0]), Number(s[1]), Number(s[2])])
  };
  if (idx >= 0) { trains[idx] = entry; overridden.add(no); }
  else trains.push(entry);
  for (const key of [...unmatched.keys()]) {
    if (normalizeCandidates(key).indexOf(no) >= 0) unmatched.delete(key);
  }
}

// ---------- 站清單：匯入車次停靠站 ∪ CSV 站（inStationTable）----------
const csvStationNames = new Set();
for (const leg of legs) { csvStationNames.add(leg.s); csvStationNames.add(leg.a); }
const csvStationIds = new Set();   // 匯入站中屬於 Station 表（＝Schedule_S 出現過）的站碼
{
  const nameToId = new Map();
  for (const [id, name] of Object.entries(stationNameById)) {
    const n = normStn(name);
    if (!nameToId.has(n)) nameToId.set(n, id);
  }
  for (const name of csvStationNames) {
    const id = nameToId.get(normStn(name));
    if (id) csvStationIds.add(id);
  }
}
const stationIds = new Set();
for (const t of trains) for (const s of t.stops) stationIds.add(s[0]);
for (const id of csvStationIds) stationIds.add(id);
// 站碼排序（TDX 站碼沿線遞增；皆為 4 碼字串，字串排序＝數字排序）
const stationsRaw = [...stationIds].map((id) => ({ id: id, name: stationNameById[id] || '' }));
const nonNumId = stationsRaw.filter((s) => !/^\d{4}$/.test(s.id));
if (nonNumId.length) throw new Error('非 4 碼站碼：' + nonNumId.map((s) => s.id + '(' + s.name + ')').join('、'));
stationsRaw.sort((a, b) => a.id.localeCompare(b.id));
const stations = stationsRaw.map((s, i) => ({
  id: s.id,
  name: s.name,
  pos: i,
  inStationTable: csvStationIds.has(s.id)
}));

// ---------- 車次排序（首班發車 → 車次） ----------
trains.sort((a, b) => (a.stops[0][1] - b.stops[0][1]) || a.no.localeCompare(b.no));

// ---------- meta ----------
const dateOnly = (s) => String(s || '').slice(0, 10);
const generatedAt = new Date().toISOString();
const meta = {
  generatedAt: generatedAt,
  srcUpdateTime: tdx.SrcUpdateTime || tdx.UpdateTime || '',
  effectiveDate: dateOnly(tdx.EffectiveDate),
  expireDate: dateOnly(tdx.ExpireDate),
  source: { csv: path.basename(CSV_PATH), tdx: path.basename(TDX_PATH) },
  counts: { trains: trains.length, stations: stations.length, unmatched: unmatched.size, overridden: overridden.size },
  notes: [
    '時間為營運日 00:00 起算分鐘數，跨夜 >1440',
    'serviceDay 以星期比對為主；holiday 帶入 TDX NationalHolidays，前端 v1 無假日曆不判定',
    'A/B 後綴折返續開腿不在 TDX 定期表：見 tools/reports/unmatched.txt 與 tools/timetable-overrides.json'
  ]
};

// ---------- 寫出 ----------
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify({ meta: meta, stations: stations, trains: trains }) + '\n', 'utf8');

// ---------- 更新 docs/config.js 的 TIMETABLE_VERSION（§9 cache-busting） ----------
const CONFIG_PATH = path.join(ROOT, 'docs', 'config.js');
let versionStr = '';
if (fs.existsSync(CONFIG_PATH)) {
  let cfg = fs.readFileSync(CONFIG_PATH, 'utf8');
  versionStr = dateOnly(meta.srcUpdateTime).replace(/-/g, '') + 'T' + String(meta.srcUpdateTime).slice(11, 19).replace(/:/g, '');
  if (/TIMETABLE_VERSION\s*:/.test(cfg)) {
    cfg = cfg.replace(/TIMETABLE_VERSION\s*:\s*'[^']*'/, "TIMETABLE_VERSION: '" + versionStr + "'");
  } else {
    // 插到最後一個屬性之後；前一個屬性可能沒有結尾逗號，要補上
    cfg = cfg.replace(/\n};/, "\n  TIMETABLE_VERSION: '" + versionStr + "'\n};");
    cfg = cfg.replace(/([\w\)\]'])\s*\n\s*TIMETABLE_VERSION/, '$1,\n  TIMETABLE_VERSION');
  }
  fs.writeFileSync(CONFIG_PATH, cfg, 'utf8');
}

// ---------- 報告：unmatched.txt ----------
fs.mkdirSync(REPORT_DIR, { recursive: true });
const unLines = [];
unLines.push('unmatched：Schedule_S 母體車次在 TDX 定期時刻表查不到（' + unmatched.size + ' 筆車次）');
unLines.push('產生時間：' + generatedAt);
unLines.push('來源 CSV：' + CSV_PATH);
unLines.push('');
unLines.push('處理方式：這些車次「不會」出現在 docs/data/timetable.json，受影響列車頁面無法計算它們');
unLines.push('（頁面會顯示「無時刻表」提示，不會靜默漏列——主管至少看得到有哪些班次缺資料）。');
unLines.push('補法：在 tools/timetable-overrides.json 加該車次的完整停靠序列（TDX ExtraTrainTimetable');
unLines.push('或行車系統查詢），再重跑本腳本。格式見 tools/timetable-overrides.example.json。');
unLines.push('');
for (const [train, tLegs] of unmatched) {
  const cands = normalizeCandidates(train);
  const m = /^(\d+)/.exec(train);
  const base = m ? m[1] : '';
  const baseInTdx = base && tdxByNo.has(base);
  let reason = 'TDX 定期表查無此車次（候選：' + cands.join('、') + '）';
  if (/[AB]$/.test(train.replace(/便$/, '')) && baseInTdx) {
    reason = 'A/B 後綴＝折返續開腿，定期表只有基數車 ' + base + '（方向／時刻與本腿不同，不可自動套用）';
  } else if (base && !baseInTdx) {
    reason = 'TDX 定期表查無此車次（基數 ' + base + ' 亦無——可能為專開／加班車）';
  }
  unLines.push('■ ' + train + '（' + reason + '）');
  for (const l of tLegs) {
    unLines.push('    班次 ' + l.group + '/' + l.index + '：' + l.s + '→' + l.a + '　' +
      (l.dep != null ? fmt(l.dep) : '?') + '-' + (l.arr != null ? fmt(l.arr) : '?'));
  }
  unLines.push('');
}
fs.writeFileSync(path.join(REPORT_DIR, 'unmatched.txt'), unLines.join('\n') + '\n', 'utf8');

// ---------- 報告：build-report.txt ----------
const rep = [];
rep.push('build-timetable 報告');
rep.push('產生時間：' + generatedAt);
rep.push('CSV：' + CSV_PATH + '（班次列 ' + legs.length + '，非班次列不計）');
rep.push('TDX：' + TDX_PATH + '（車次 ' + tdxByNo.size + '，SrcUpdateTime ' + meta.srcUpdateTime + '，有效期 ' + meta.effectiveDate + '～' + meta.expireDate + '）');
rep.push('');
rep.push('[1] 母體覆蓋');
const ruleStat = {};
for (const v of matchOf.values()) ruleStat[v.rule] = (ruleStat[v.rule] || 0) + 1;
rep.push('    唯一車次字串 ' + matchOf.size + ' → 對到 TDX 車次 ' + legGroups.size +
  '（正規化統計：' + JSON.stringify(ruleStat) + '）' + (overrides.length ? '＋人工補 ' + overrides.length : '') + '＝匯入 ' + trains.length + ' 筆；unmatched ' + unmatched.size + ' 筆（見 unmatched.txt）');
const coveredLegs = legs.filter((l) => matchOf.has(l.train) || normalizeCandidates(l.train).some((c) => overrideByNo.has(c))).length;
rep.push('    班次列覆蓋：' + coveredLegs + ' / ' + legs.length + '（' + (legs.length ? Math.round((coveredLegs / legs.length) * 100) : 0) + '%）');
rep.push('');
rep.push('[2] 班次時間比對（CSV vs TDX，±1 分，跨夜修正）');
rep.push('    不一致：' + timeMismatches.length + ' 筆' + (timeMismatches.length ? '' : '（全部吻合）'));
for (const m of timeMismatches) rep.push('    - ' + m.train + ' ' + m.leg + '：' + m.reason);
rep.push('');
rep.push('[3] 站碼排序 vs Station 表 KM');
let kms = null;
if (fs.existsSync(KMS_PATH)) {
  try { kms = JSON.parse(fs.readFileSync(KMS_PATH, 'utf8')); } catch (e) { kms = null; }
}
if (kms && kms.kms) kms = kms.kms;
if (kms) {
  const kmOf = (name) => {
    const n = normStn(name);
    for (const [k, v] of Object.entries(kms)) {
      if (normStn(k) === n) return v;
    }
    return null;
  };
  const withKm = stations.filter((s) => kmOf(s.name) != null);
  let bad = 0;
  for (let i = 1; i < withKm.length; i++) {
    if (kmOf(withKm[i].name) <= kmOf(withKm[i - 1].name)) {
      bad++;
      rep.push('    ✗ 順序不一致：' + withKm[i - 1].name + '(' + kmOf(withKm[i - 1].name) + ') → ' + withKm[i].name + '(' + kmOf(withKm[i].name) + ')');
    }
  }
  rep.push('    有 KM 的站 ' + withKm.length + ' 個，站碼排序檢查：' + (bad === 0 ? 'OK，全部一致' : bad + ' 處不一致！'));
  const noKm = stations.filter((s) => s.inStationTable && kmOf(s.name) == null).map((s) => s.name);
  if (noKm.length) rep.push('    Station 表站無 KM（不影響計算）：' + noKm.join('、'));
} else {
  rep.push('    （略：無 ' + KMS_PATH + '）');
}
rep.push('');
rep.push('[4] 跨夜時間檢查（>1440 分鐘）');
const crossTrains = trains.filter((t) => t.stops.some((s) => s[1] >= 1440 || s[2] >= 1440));
rep.push('    跨夜車次 ' + crossTrains.length + ' 筆：' + crossTrains.map((t) => t.no).join('、'));
rep.push('');
rep.push('[5] 區間下拉站（inStationTable，' + stations.filter((s) => s.inStationTable).length + ' 站）');
rep.push('    ' + stations.filter((s) => s.inStationTable).map((s) => s.name + '(' + s.id + ')').join('、'));
rep.push('');
rep.push('[6] 產物');
rep.push('    ' + OUT_PATH + '（' + trains.length + ' 車次／' + stations.length + ' 站，' + Math.round(fs.statSync(OUT_PATH).size / 1024) + ' KB）');
if (versionStr) rep.push('    docs/config.js TIMETABLE_VERSION = ' + versionStr);
fs.writeFileSync(path.join(REPORT_DIR, 'build-report.txt'), rep.join('\n') + '\n', 'utf8');

// ---------- console 摘要（PowerShell 5.1 中文會亂碼，重點都寫進報告檔） ----------
console.log('trains=' + trains.length + ' stations=' + stations.length + ' unmatched=' + unmatched.size + ' mismatch=' + timeMismatches.length);
console.log('out=' + OUT_PATH);
console.log('reports=' + REPORT_DIR);
