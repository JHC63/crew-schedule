#!/usr/bin/env node
// ===== 產生「假」timetable.json 範例（affected-plan.md §16 步驟 1：確認 schema 用）=====
//
// 輸入：test/data.js（既有固定測試資料）
// 輸出：test/fixtures/timetable.sample.json
//
// 注意：
// - 這是 schema 確認用的假資料，**不是** docs/data/timetable.json（正式產物要等
//   真實 TDX JSON，由 tools/build-timetable.js 產生，見 §16 步驟 8）。
// - 各車次「端點時間」取自 test/data.js 的 Schedule_S（真實）；「中間停靠站」與其
//   時間是示意用的假造值（依 KM 比例內插），僅為了讓 L1 篩選／內插測試有東西可測。
// - 站序 pos 在正式版以 TDX 站碼排序（§10.2 會出「站碼 vs KM」驗證報告）；
//   本樣本以 Station 表 KM 升冪排序，並附同樣的驗證輸出。
'use strict';

const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'test', 'data.js'));
const SHEETS = globalThis.SHEETS;
if (!SHEETS) throw new Error('test/data.js 未設定 globalThis.SHEETS');

// ---------- 小工具 ----------
function parseHM(s) {
  // 'H:MM' → 分鐘數；本樣本的 Schedule_S 不含 '24:xx' 寫法，跨夜用 arr < dep 判斷 +1440
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
const DAILY = { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 };

// ---------- 站序（樣本：KM 升冪；正式版：TDX 站碼排序）----------
const stations = SHEETS.Station.slice(1)
  .map(r => ({ id: String(r[0]), name: String(r[1]), km: Number(r[2]), inStationTable: true }))
  .sort((a, b) => a.km - b.km);

// 假造一個「只在 TDX 出現、不在 Station 表」的站，示範聯集與 inStationTable 標記。
// 林內是斗六與民雄之間的真實車站，但站碼 '3480' 是假的；正式資料以 TDX 為準。
stations.splice(stations.findIndex(s => s.name === '民雄'), 0, { id: '3480', name: '林內', km: 265.5, inStationTable: false });
stations.forEach((s, i) => { s.pos = i; });
const byName = new Map(stations.map(s => [s.name, s]));

// ---------- 每車次的示意設定（車種、中間停靠站白名單、營運日、加班車）----------
// mid 會自動過濾「位於端點之間」並依行進方向排序；empty = 直達（在中間站全部「通過」，
// 正好測 §7 的推估內插）。
const TRAIN_CONFIG = {
  '154':  { type: '區間快', typeCode: '50', mid: ['民雄', '斗六', '彰化', '新竹'] },
  '1288': { type: '區間',   typeCode: '31', mid: [], extraTrain: true },
  '125':  { type: '自強',   typeCode: '10', mid: ['彰化'],
            serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0, holiday: 0 },
            note: '逢週一至週五行駛。' },
  '2204': { type: '區間', typeCode: '31', mid: ['民雄', '林內', '斗六'] },
  '2193': { type: '區間', typeCode: '31', mid: ['斗六', '林內', '民雄'] },
  '175':  { type: '自強', typeCode: '10', mid: [] },
  '116':  { type: '自強', typeCode: '10', mid: [] },
  '105':  { type: '自強', typeCode: '10', mid: [] },
  '3222': { type: '區間', typeCode: '31', mid: [] },
  '3238': { type: '區間', typeCode: '31', mid: ['民雄', '林內'], extraTrain: true },
  '102':  { type: '自強', typeCode: '10', mid: [] },
  '2103': { type: '區間快', typeCode: '50', mid: ['民雄'] },
  '152':  { type: '自強', typeCode: '10', mid: [] },
  '114':  { type: '自強', typeCode: '10', mid: [] },
  '123':  { type: '自強', typeCode: '10', mid: ['彰化'] },
  '3010': { type: '區間', typeCode: '31', mid: ['民雄', '林內', '斗六'] },
  '3029': { type: '區間', typeCode: '31', mid: ['斗六', '林內', '民雄'] },
  '3257': { type: '區間', typeCode: '31', mid: [] },
  '3178': { type: '區間', typeCode: '31', mid: ['民雄', '林內', '斗六', '彰化'] },
  '2274': { type: '區間', typeCode: '31', mid: [], extraTrain: true },
  '270A': { type: '區間', typeCode: '31', mid: [] },
  '270':  { type: '區間', typeCode: '31', mid: ['民雄', '林內', '斗六'] },
  '191':  { type: '區間', typeCode: '31', mid: [], extraTrain: true }
};

// ---------- 從 Schedule_S 抽母體（班次列）----------
// 資料列欄位：[0]Number [1]Train [2]S_station [3]A_station [4]B_time [5]S_time [6]A_time
// 非班次列（例假／休息日／跨夜，Train 不以數字開頭）不入母體。
const rows = SHEETS['Schedule_S'].slice(1);
const legs = [];
const unmatched = [];
for (const r of rows) {
  const train = String(r[1] || '').trim();
  if (!/^\d/.test(train)) continue;
  const dep = parseHM(r[5]);
  const arr = parseHM(r[6]);
  if (dep == null || arr == null || !byName.has(String(r[2]).trim()) || !byName.has(String(r[3]).trim())) {
    unmatched.push(train);
    continue;
  }
  const no = train.replace(/便$/, '');          // 正規化：去「便」後綴（'270A' 的 A 保留）
  legs.push({ no, sStn: String(r[2]).trim(), aStn: String(r[3]).trim(), dep, arr });
}

// ---------- 組 trains ----------
const trains = [];
for (const leg of legs) {
  const cfg = TRAIN_CONFIG[leg.no] || { type: '區間', typeCode: '31', mid: [] };
  if (!TRAIN_CONFIG[leg.no]) unmatched.push(leg.no);
  const s = byName.get(leg.sStn);
  const a = byName.get(leg.aStn);
  const arrN = leg.arr < leg.dep ? leg.arr + 1440 : leg.arr;   // 跨夜 → >1440

  // 中間停靠站：過濾端點之間，依行進方向排序，時間依 KM 比例假插（示意值）
  const asc = a.pos > s.pos;
  const mids = (cfg.mid || [])
    .map(n => byName.get(n))
    .filter(m => m && ((asc && m.pos > s.pos && m.pos < a.pos) || (!asc && m.pos < s.pos && m.pos > a.pos)))
    .sort((x, y) => (asc ? x.pos - y.pos : y.pos - x.pos));
  const dur = arrN - leg.dep;
  const kmTotal = Math.abs(a.km - s.km);
  const stopArr = mids.map(m => {
    const ratio = kmTotal ? Math.abs(m.km - s.km) / kmTotal : 0;
    return { stn: m, arr: Math.round(leg.dep + ratio * dur) };
  });
  // 保守修正：嚴格遞增，且不追過終點
  let prevDep = leg.dep;
  for (const st of stopArr) {
    if (st.arr <= prevDep) st.arr = prevDep + 1;
    st.dep = Math.min(st.arr + 1, arrN - (stopArr[stopArr.length - 1] === st ? 0 : 1));
    prevDep = st.dep;
  }

  const stops = [[s.id, leg.dep, leg.dep]];
  for (const st of stopArr) stops.push([st.stn.id, st.arr, st.dep]);
  stops.push([a.id, arrN, arrN]);

  trains.push({
    no: leg.no,
    type: cfg.type,
    typeCode: cfg.typeCode,
    headsign: '往' + a.name,
    extraTrain: !!(cfg.extraTrain),
    serviceDay: cfg.serviceDay || DAILY,
    note: cfg.note || '',
    stops
  });
}

// ---------- 輸出 ----------
const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    srcUpdateTime: '2026-11-24T13:51:48+08:00',   // 假值（沿用 §8.1 樣本）；正式版取 TDX SrcUpdateTime
    effectiveDate: '2026-07-01',
    expireDate: '2026-12-31'
  },
  stations: stations.map(({ id, name, pos, inStationTable }) => ({ id, name, pos, inStationTable })),
  trains
};

const outDir = path.join(__dirname, '..', 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'timetable.sample.json');
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf8');

// ---------- 驗證輸出（呼應 §10 三份報告的精神）----------
console.log('寫出：' + outFile);
console.log('班次列（母體）= ' + legs.length + '；不重複車次 = ' + new Set(legs.map(l => l.no)).size + '；trains 陣列 = ' + trains.length + ' 筆');

// 1) 母體覆蓋（= unmatched 檢查）
console.log('\n[1] 母體覆蓋檢查（unmatched）');
console.log(unmatched.length === 0 ? '  OK：Schedule_S 每個班次列都對到一筆 train，無 unmatched' : '  unmatched：' + unmatched.join('、'));

// 2) 站碼排序 vs KM 順序
const byId = stations.slice().sort((x, y) => x.id.localeCompare(y.id));
const byKm = stations.slice().sort((x, y) => x.km - y.km);
const same = byId.map(s => s.name).join('|') === byKm.map(s => s.name).join('|');
console.log('\n[2] 站碼排序 vs KM 順序');
console.log('  ' + (same ? 'OK：兩者一致' : '不一致！') + '（' + byKm.map(s => s.id + ' ' + s.name).join(' → ') + '）');

// 3) 跨夜時間（>=1440 分鐘）
console.log('\n[3] 跨夜時間檢查（值以「營運日 00:00 起算分鐘數」儲存，>1440 為隔日）');
const cross = [];
for (const t of trains) for (const [, arr, dep] of t.stops) if (arr >= 1440 || dep >= 1440) { cross.push(t.no); break; }
console.log(cross.length ? '  跨夜車次：' + cross.join('、') + '（時間已存為 >1440 分鐘）' : '  （無跨夜班次）');

// 4) 端點時間與 Schedule_S 一致＋站點都存在＋時間單調
let ok = true;
for (const t of trains) {
  for (const [id] of t.stops) if (!stations.some(s => s.id === id)) { console.log('  NG：' + t.no + ' 有未定義站 ' + id); ok = false; }
  for (let i = 1; i < t.stops.length; i++) {
    if (t.stops[i][1] < t.stops[i - 1][2]) { console.log('  NG：' + t.no + ' 時間非遞增 @ ' + t.stops[i][0]); ok = false; }
  }
}
console.log('\n[4] 端點一致性／站點存在／時間單調：' + (ok ? 'OK' : '有 NG，見上'));
console.log('\n同一車次多腿（no 不唯一，前端比對須用「車次＋時間窗」）：');
const count = {};
for (const t of trains) count[t.no] = (count[t.no] || 0) + 1;
const dup = Object.entries(count).filter(([, n]) => n > 1);
console.log(dup.length ? '  ' + dup.map(([no, n]) => no + '×' + n).join('、') : '  （無）');
