#!/usr/bin/env node
// ============================================================
// test/run-affected.js——受影響列車「純邏輯」測試（affected-plan.md §14）
// 測 docs/affected-core.js（無 DOM、無 fetch），Node 直接 require。
// 跑法：node test\run-affected.js　（全過 → 輸出 AFF CORE ALL PASSED）
// ============================================================
'use strict';

const path = require('path');
const CORE = require(path.join(__dirname, '..', 'docs', 'affected-core.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? '　→ ' + detail : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, '實際 ' + JSON.stringify(actual) + '，預期 ' + JSON.stringify(expected));
}

// ============================================================
// 假站序（pos 沿線遞增＝南下；站碼排序）
// ============================================================
const STATIONS = [
  { id: '0900', name: '基隆', pos: 0, inStationTable: true },
  { id: '1000', name: '台北', pos: 1, inStationTable: true },
  { id: '1210', name: '新竹', pos: 2, inStationTable: true },
  { id: '3300', name: '臺中', pos: 3, inStationTable: true },
  { id: '3360', name: '彰化', pos: 4, inStationTable: true },
  { id: '3410', name: '員林', pos: 5, inStationTable: true },
  { id: '3470', name: '斗六', pos: 6, inStationTable: true },
  { id: '4060', name: '民雄', pos: 7, inStationTable: true },
  { id: '4080', name: '嘉義', pos: 8, inStationTable: true },
  { id: '4400', name: '高雄', pos: 9, inStationTable: true }
];
const IDX = CORE.makeIndex(STATIONS);
const nameOf = (id) => { const s = STATIONS.find((x) => x.id === id); return s ? s.name : id; };
const idOf = (name) => IDX.nameToId[CORE.normStn(name)];

// 南下車次：台北 8:00 → 臺中 9:00 → 彰化 10:00 → 嘉義 11:00
const T_SOUTH = {
  no: '101', type: '自強', typeCode: '11', headsign: '往嘉義', extraTrain: false,
  serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 },
  note: '', stops: [
    ['1000', 480, 480], ['3300', 540, 542], ['3360', 600, 602], ['4080', 660, 660]
  ]
};
// 北上車次：高雄 8:20 → 嘉義 9:20 → 彰化 10:20 → 台北 11:20
const T_NORTH = {
  no: '102', type: '自強', typeCode: '11', headsign: '往台北', extraTrain: false,
  serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 },
  note: '', stops: [
    ['4400', 500, 500], ['4080', 560, 562], ['3360', 620, 622], ['1000', 680, 680]
  ]
};
// 通過彰化（不停靠）：臺中 8:20 → 員林 9:40 → 嘉義 11:00
const T_PASS_CH = {
  no: '201', type: '區間', typeCode: '6', headsign: '往嘉義', extraTrain: false,
  serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 },
  note: '', stops: [
    ['3300', 500, 500], ['3410', 580, 582], ['4080', 660, 660]
  ]
};
// 通過員林＋民雄：臺中 8:00 → 彰化 9:30 → 嘉義 11:40
const T_PASS_BOTH = {
  no: '202', type: '區間', typeCode: '6', headsign: '往嘉義', extraTrain: false,
  serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 },
  note: '', stops: [
    ['3300', 480, 480], ['3360', 570, 572], ['4080', 700, 700]
  ]
};
// 跨夜車次：高雄 23:00 → 嘉義 23:57→(隔日)00:17 → 彰化 01:20 → 台北 02:30
const T_CROSS = {
  no: '501', type: '區間', typeCode: '6', headsign: '往台北', extraTrain: false,
  serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 },
  note: '在嘉義跨日。', stops: [
    ['4400', 1380, 1380], ['4080', 1437, 1457], ['3360', 1520, 1522], ['1000', 1590, 1590]
  ]
};

// ============================================================
// §14 案例 14：車次後綴正規化
// ============================================================
eq('14a 1288便 → 1288', CORE.normalizeTrainNo('1288便'), '1288');
eq('14b 3148(3146) → 3148', CORE.normalizeTrainNo('3148(3146)'), '3148');
eq('14c 115A 的 A 保留', CORE.normalizeTrainNo('115A'), '115A');
eq('14d 3292B便 → 3292B', CORE.normalizeTrainNo('3292B便'), '3292B');
eq('14e 純數字原樣', CORE.normalizeTrainNo('2204'), '2204');
ok('14f 車次比對：1288 不等於 12885（數字邊界）', CORE.normalizeTrainNo('1288') !== CORE.normalizeTrainNo('12885'));

// ============================================================
// §14 案例 1／2：端點有停靠，時段重疊／不重疊（L1）
// ============================================================
const tvS = CORE.traverseSection(T_SOUTH, idOf('彰化'), idOf('嘉義'), IDX.posById, nameOf);
ok('1a 南下車 traverse 成功', !!tvS);
eq('1b 進入＝彰化開車 602（進入端開車時間，§5 Step 2.3）', tvS && tvS.enter, 602);
eq('1c 離開＝嘉義到達 660', tvS && tvS.exit, 660);
eq('1d 方向＝南下', tvS && tvS.south, true);
ok('1e 時段 10:30–11:30 重疊 → 入選（進入 600 < 690 且 離開 660 > 630）',
  tvS && tvS.enter < 690 && tvS.exit > 630);
ok('2a 時段 11:00–12:00 不重疊（進入 600 < 720 但 離開 660 ≮ 660 → 排除）',
  tvS && !(tvS.enter < 720 && tvS.exit > 660));
const tvN = CORE.traverseSection(T_NORTH, idOf('彰化'), idOf('嘉義'), IDX.posById, nameOf);
eq('2b 北上車進入端＝嘉義（先遇到，開車 562）', tvN && tvN.enter, 562);
eq('2c 北上車離開端＝彰化（到達 620）', tvN && tvN.exit, 620);
eq('2d 方向＝北上', tvN && tvN.south, false);

// ============================================================
// §14 案例 3／4：一端／兩端不停靠 → 內插推估（§7）
// ============================================================
const tvP1 = CORE.traverseSection(T_PASS_CH, idOf('彰化'), idOf('嘉義'), IDX.posById, nameOf);
ok('3a 一端不停靠（彰化）→ 內插入選', !!tvP1 && !tvP1.enterStop && tvP1.exitStop);
// 內插：臺中(pos3) 8:20 dep 500 → 員林(pos5) 9:40 arr 580；彰化 pos4 剛好中點 → 540（9:00）
eq('3b 彰化通過時間＝500 + (4-3)/(5-3)×(580-500) = 540', tvP1 && tvP1.enter, 540);
ok('3c 推估來源 tooltip 有前後站', !!(tvP1 && tvP1.approx.enter && tvP1.approx.enter.from && tvP1.approx.enter.to));
const tvP2 = CORE.traverseSection(T_PASS_BOTH, idOf('員林'), idOf('民雄'), IDX.posById, nameOf);
ok('4a 兩端都不停靠 → 推估範圍', !!tvP2 && !tvP2.enterStop && !tvP2.exitStop);
// 員林 pos5：彰化(pos4) 開車 572 → 嘉義(pos8) 到達 700 → 572 + (5-4)/(8-4)×128 = 604
eq('4b 員林通過時間 ≈ 604', tvP2 && tvP2.enter, 604);
// 民雄 pos7：572 + (7-4)/(8-4)×128 = 668
eq('4c 民雄通過時間 ≈ 668', tvP2 && tvP2.exit, 668);
// 站序位置在行駛範圍外 → 不經過（null）
const tvOut = CORE.traverseSection(T_PASS_CH, idOf('基隆'), idOf('台北'), IDX.posById, nameOf);
eq('4d 端點在行駛範圍外 → null', tvOut, null);
// 邊界切到（時段邊界在進入/離開之間）→「可能受影響」判定輸入
const possible = tvP2 && ((590 > tvP2.enter && 590 < tvP2.exit) || (620 > tvP2.enter && 620 < tvP2.exit));
ok('4e 時段邊界 9:50/10:20 切進推估範圍 → 可能受影響', possible === true);

// ============================================================
// §14 案例 5／6／9：車長分類（L2）
// ============================================================
// 南下 101：彰化(pos4) 進入、嘉義(pos8) 離開
// 5. 車長在事故前下車：台北→臺中（下車站在進入端之前）→ 未受影響
const r5 = CORE.classifyRider(
  { title: '101', station: '台北', toStation: '臺中' },
  tvS, IDX, idOf('彰化'), idOf('嘉義'));
eq('5a 事故前下車 → 未受影響', r5.affected, false);
// 5b. 下車站＝進入端（台北→彰化）→ 受影響（2026/11/26 起，見案例 18）
const r5b = CORE.classifyRider(
  { title: '101', station: '台北', toStation: '彰化' },
  tvS, IDX, idOf('彰化'), idOf('嘉義'));
eq('5b 下車站＝進入端 → 受影響', r5b.affected, true);
eq('5c 下車站＝進入端 → 延誤落在 alighting', r5b.delayOn, 'alighting');
// 6. 車長在事故後上車：彰化→高雄（上車站＝進入端？不行——上車站序 ≥ 離開端才算 boarding）
//    嘉義→高雄：上車站＝離開端（嘉義）→ boarding
const r6 = CORE.classifyRider(
  { title: '101', station: '嘉義', toStation: '高雄' },
  tvS, IDX, idOf('彰化'), idOf('嘉義'));
eq('6a 事故後上車 → 受影響', r6.affected, true);
eq('6b 延誤落在 boarding', r6.delayOn, 'boarding');
// 區間內乘車：台北→高雄（全程在車上）→ alighting
const r6b = CORE.classifyRider(
  { title: '101', station: '台北', toStation: '高雄' },
  tvS, IDX, idOf('彰化'), idOf('嘉義'));
eq('6c 區間內乘車 → 延誤落在 alighting', r6b.delayOn, 'alighting');
// 9. 同車次多車長：各自用自己的區間
const r9a = CORE.classifyRider(
  { title: '101', station: '台北', toStation: '臺中' },
  tvS, IDX, idOf('彰化'), idOf('嘉義'));
const r9b = CORE.classifyRider(
  { title: '101', station: '員林', toStation: '嘉義' },
  tvS, IDX, idOf('彰化'), idOf('嘉義'));
ok('9a 車長 A 未受影響、車長 B 受影響（同車次各自獨立；B 在員林上車＝區間內 → alighting）',
  r9a.affected === false && r9b.affected === true && r9b.delayOn === 'alighting');
// 邊界：下車站序剛好＝進入端（台北→彰化，彰化＝進入端）→ 受影響（2026/11/26 起，案例 18）
ok('9b 下車站＝進入端 → 受影響（原嚴格 ≤，2026/11/26 使用者回饋改）', r5b.affected === true);
// 站名對不到 → 需人工確認
const rBad = CORE.classifyRider(
  { title: '101', station: '鳳鳴', toStation: '嘉義' },
  tvS, IDX, idOf('彰化'), idOf('嘉義'));
eq('9c 班表站名對不到 → unknownStation', rBad.unknownStation, true);
// 臺/台正規化：班表寫「台中」、時刻表寫「臺中」
const rTai = CORE.classifyRider(
  { title: '101', station: '台北', toStation: '高雄' },
  tvS, IDX, idOf('彰化'), idOf('嘉義'));
ok('9d 台/臺 正規化正常分類', rTai.affected === true && rTai.unknownStation !== true);
// 北上車的對稱檢查：102 嘉義→彰化（南下方向區間查詢 彰化→嘉義）
// 北上 102：嘉義(pos8) 先遇到＝進入端 560；車長 高雄→嘉義（下車站＝進入端）→ 受影響（2026/11/26 起）
const rN = CORE.classifyRider(
  { title: '102', station: '高雄', toStation: '嘉義' },
  tvN, IDX, idOf('彰化'), idOf('嘉義'));
eq('9e 北上車：下車站＝進入端 → 受影響（對稱）', rN.affected, true);
eq('9e2 北上車：下車站＝進入端 → alighting', rN.delayOn, 'alighting');
const rN2 = CORE.classifyRider(
  { title: '102', station: '彰化', toStation: '台北' },
  tvN, IDX, idOf('彰化'), idOf('嘉義'));
eq('9f 北上車：上車站＝離開端（彰化）→ boarding', rN2.delayOn, 'boarding');

// ============================================================
// §14 案例 7／8／10／11／12／13：影響鏈（L3）
// ============================================================
// 7. 緩衝剛好門檻 → 正常；9 → 不足；−6 → 趕不上
const c7a = CORE.buildChain({
  seg: { title: '3010', station: '嘉義', toStation: '彰化', dep: 831, arr: 920 },
  trainNo: '3010', delay: 0, delayOn: 'alighting',
  next: { title: '3029', station: '彰化', toStation: '嘉義', dep: 974, arr: 1043 },
  delays: {}, threshold: 10
});
eq('7a 原定餘裕 54 分 → 正常', c7a.next.status, 'ok');
const c7b = CORE.buildChain({
  seg: { title: '3010', station: '嘉義', toStation: '彰化', dep: 831, arr: 920 },
  trainNo: '3010', delay: 50, delayOn: 'alighting',       // +50 → 16:10 到，緩衝 4 分
  next: { title: '3029', station: '彰化', toStation: '嘉義', dep: 974, arr: 1043 },
  delays: {}, threshold: 10
});
eq('7b +50 → 緩衝 4 分 → 不足', c7b.next.status, 'short');
eq('7c +50 → 抵達 16:10（970）', c7b.arrNew, 970);
const c7d = CORE.buildChain({
  seg: { title: '3010', station: '嘉義', toStation: '彰化', dep: 831, arr: 920 },
  trainNo: '3010', delay: 60, delayOn: 'alighting',       // +60 → 緩衝 −6
  next: { title: '3029', station: '彰化', toStation: '嘉義', dep: 974, arr: 1043 },
  delays: {}, threshold: 10
});
eq('7d +60 → 緩衝 −6 → 趕不上', c7d.next.status, 'missed');
eq('7e 緩衝值 −6', c7d.next.buffer, -6);
// 緩衝剛好等於門檻 → 不篩（嚴格 <，§13）
const c7f = CORE.buildChain({
  seg: { title: 'X', station: '嘉義', toStation: '彰化', dep: 831, arr: 920 },
  trainNo: 'X', delay: 44, delayOn: 'alighting',          // 緩衝剛好 10
  next: { title: '3029', station: '彰化', toStation: '嘉義', dep: 974, arr: 1043 },
  delays: {}, threshold: 10
});
eq('7f 緩衝剛好等於門檻 → 正常（嚴格 <）', c7f.next.status, 'ok');
// 下一班自身也有延誤 → 用調整後出發時間算緩衝（§13）
const c7g = CORE.buildChain({
  seg: { title: '3010', station: '嘉義', toStation: '彰化', dep: 831, arr: 920 },
  trainNo: '3010', delay: 50, delayOn: 'alighting',
  next: { title: '3029', station: '彰化', toStation: '嘉義', dep: 974, arr: 1043 },
  delays: { '3029': 5 }, threshold: 10
});
eq('7g 下一班自身 +5 → 緩衝 4+5=9 → 不足', c7g.next.status, 'short');

// 8. 同一車次續開（兩天班）→ 延誤直接帶入
const c8 = CORE.buildChain({
  seg: { title: '501', station: '嘉義', toStation: '彰化', dep: 880, arr: 920 },
  trainNo: '501', delay: 30, delayOn: 'alighting',
  next: { title: '501', station: '彰化', toStation: '台北', dep: 925, arr: 1050 },
  delays: {}, threshold: 10
});
eq('8a 同一車次續開 → samecontinue', c8.next.kind, 'samecontinue');
ok('8b 不做緩衝檢查（無 buffer 值）', c8.next.buffer === undefined);

// 10. 跨夜（>1440 分鐘）：fmtMin 與鏈
eq('10a fmtMin(1457)＝+1 00:17', CORE.fmtMin(1457), '+1 00:17');
eq('10b fmtMin(600)＝10:00', CORE.fmtMin(600), '10:00');
const tvCross = CORE.traverseSection(T_CROSS, idOf('嘉義'), idOf('彰化'), IDX.posById, nameOf);
ok('10c 跨夜車 traverse：進入 1457（隔日 00:17 開車）', tvCross && tvCross.enter === 1457);
eq('10d 跨夜車離開 1520（隔日 01:20）', tvCross && tvCross.exit, 1520);
const c10 = CORE.buildChain({
  seg: { title: '501', station: '高雄', toStation: '嘉義', dep: 1380, arr: 1457 },
  trainNo: '501', delay: 0, delayOn: 'alighting',
  next: { title: '502', station: '嘉義', toStation: '彰化', dep: 1450, arr: 1510 },
  delays: {}, threshold: 10
});
eq('10e 下一班在隔日（dep≥1440）→ crossnight', c10.next.kind, 'crossnight');

// 11. 下一班不同站 → 需人工確認
const c11 = CORE.buildChain({
  seg: { title: '3010', station: '嘉義', toStation: '彰化', dep: 831, arr: 920 },
  trainNo: '3010', delay: 30, delayOn: 'alighting',
  next: { title: '111', station: '員林', toStation: '台北', dep: 980, arr: 1100 },
  delays: {}, threshold: 10
});
eq('11a 不同站接駁 → difstation', c11.next.kind, 'difstation');
eq('11b 狀態 manual', c11.next.status, 'manual');

// 12. 當日最後一班
const c12 = CORE.buildChain({
  seg: { title: '3010', station: '嘉義', toStation: '彰化', dep: 831, arr: 920 },
  trainNo: '3010', delay: 40, delayOn: 'alighting',
  next: null, delays: {}, threshold: 10
});
eq('12a 無下一班 → lasttrain', c12.next.kind, 'lasttrain');
ok('12b 有延誤時 arrNew 供「收班延後」顯示', c12.arrNew === 960);

// 13. 多筆延誤取 max 不取 sum：同車次延誤為單一值（覆蓋），鏈上各班只用自己的延誤
const delays13 = { '3010': 30 };
delays13['3010'] = 50;   // 同車次再輸入 → 覆蓋（不是 30+50）
delays13['3029'] = 5;
const c13 = CORE.buildChain({
  seg: { title: '3010', station: '嘉義', toStation: '彰化', dep: 831, arr: 920 },
  trainNo: '3010', delay: delays13['3010'], delayOn: 'alighting',
  next: { title: '3029', station: '彰化', toStation: '嘉義', dep: 974, arr: 1043 },
  delays: delays13, threshold: 10
});
eq('13a 同車次延誤覆蓋不累加（50，非 80）', c13.arrNew - c13.arr, 50);
// 本班 +50、下一班自身 +5 → 緩衝以兩班各自的延誤計算（不把 +50 加到下一班）
eq('13b 緩衝＝974+5−(920+50)＝9', c13.next.buffer, 9);

// ============================================================
// 補充：內插極值／防禦
// ============================================================
eq('A1 站序位置不在任何兩停靠站之間 → null',
  CORE.interpolateAt(T_PASS_CH.stops, T_PASS_CH.stops.map((s) => IDX.posById[s[0]]), IDX.posById['0900']), null);
eq('A2 兩停靠站同站序（防除零）→ null',
  CORE.interpolateAt([['3360', 600, 600], ['3410', 660, 660]], [4, 4], 4.5), null);
const tvSame = CORE.traverseSection(T_SOUTH, idOf('彰化'), idOf('彰化'), IDX.posById, nameOf);
eq('A3 起迄相同站 → null（表單已擋，函式防禦）', tvSame, null);
eq('A4 站碼查無 pos → null',
  CORE.traverseSection(T_SOUTH, '9999', idOf('嘉義'), IDX.posById, nameOf), null);

// ============================================================
// 15. 指定車次：輸入正規化／比對（2026/11/26 新增）
// ============================================================
eq('15a 全形 １１５Ａ → 115A', CORE.normalizeTrainInput('１１５Ａ'), '115A');
eq('15b 115 a → 115A', CORE.normalizeTrainInput('115 a'), '115A');
eq('15c 3292B便 → 3292B', CORE.normalizeTrainInput('3292B便'), '3292B');
eq('15d 全形括號 ３１４８（３１４６）→ 3148', CORE.normalizeTrainInput('３１４８（３１４６）'), '3148');
const r15a = CORE.resolveTrainNo('115', ['115A']);
eq('15e 115 只有 115A → 自動對到', r15a.key, '115A');
eq('15f 自動對到規則 suffix', r15a.rule, 'suffix');
const r15b = CORE.resolveTrainNo('115', ['115', '115A']);
eq('15g 115 完全符合優先', r15b.key, '115');
eq('15h 完全符合規則 exact', r15b.rule, 'exact');
const r15c = CORE.resolveTrainNo('115', ['115A', '115B']);
eq('15i 115A/115B 並存 → ambiguous', r15c.rule, 'ambiguous');
eq('15j ambiguous 候選 2 筆', r15c.candidates.length, 2);
const r15d = CORE.resolveTrainNo('270', ['2705']);
eq('15k 270 不誤中 2705', r15d.rule, 'notfound');
const r15e = CORE.resolveTrainNo('115A', ['115']);
eq('15l 115A 不退回 115', r15e.rule, 'notfound');
const r15f = CORE.resolveTrainNo('３１４８（３１４６）', ['3148']);
eq('15m 全形括號 → 3148', r15f.key, '3148');
eq('15n 空輸入 → empty', CORE.resolveTrainNo('  ', ['115']).rule, 'empty');

// ============================================================
// 16. 起訖站搜尋（2026/11/26 新增）
// ============================================================
const ST16 = [
  { id: '1000', name: '臺北', pos: 1 },
  { id: '0900', name: '基隆', pos: 0 },
  { id: '3300', name: '臺中', pos: 3 },
  { id: '3360', name: '彰化', pos: 4 }
];
eq('16a 空查詢 → 全部', CORE.filterStations(ST16, '').length, 4);
eq('16b 空查詢依 pos 排序（基隆第一）', CORE.filterStations(ST16, '')[0].id, '0900');
eq('16c 台北 → 臺北', CORE.filterStations(ST16, '台北')[0].id, '1000');
eq('16d 臺北 → 臺北', CORE.filterStations(ST16, '臺北')[0].id, '1000');
eq('16e 台北站 → 臺北', CORE.filterStations(ST16, '台北站')[0].id, '1000');
eq('16f 站碼 1000 → 臺北', CORE.filterStations(ST16, '1000')[0].id, '1000');
eq('16g 站碼前綴 33 → 臺中/彰化', CORE.filterStations(ST16, '33').length, 2);
eq('16h 查無 → 0', CORE.filterStations(ST16, '火星').length, 0);
eq('16i resolveStation 台北 → 臺北', CORE.resolveStation(ST16, '台北').id, '1000');
eq('16j resolveStation 1000 → 臺北', CORE.resolveStation(ST16, '1000').id, '1000');
eq('16k resolveStation 台北市 → null', CORE.resolveStation(ST16, '台北市'), null);

// ============================================================
// 17. 指定車次：值乘腿排序／交接（2026/11/26 新增）
// ============================================================
const M17 = 60000;
const LEGS17 = [
  { title: '114', station: '彰化', toStation: '新竹', startMs: 630 * M17, endMs: 709 * M17, group: 'A', name: '甲' },
  { title: '114', station: '潮州', toStation: '嘉義', startMs: 450 * M17, endMs: 564 * M17, group: 'A', name: '乙' },
  { title: '114', station: '嘉義', toStation: '彰化', startMs: 566 * M17, endMs: 628 * M17, group: 'A', name: '丙' }
];
const ORD17 = CORE.orderLegs(LEGS17);
eq('17a 依 startMs 排序（潮州→嘉義第一）', ORD17[0].seg.station, '潮州');
eq('17b 第二腿 嘉義→彰化', ORD17[1].seg.station, '嘉義');
eq('17c 第三腿 彰化→新竹', ORD17[2].seg.station, '彰化');
eq('17d 嘉義交接站相同', ORD17[0].handover.sameStation, true);
eq('17e 嘉義交接不同車長', ORD17[0].handover.sameCrew, false);
eq('17f 嘉義交接間隔 2 分', ORD17[0].handover.gapMin, 2);
eq('17g 最後一腿無 handover', ORD17[2].handover, null);
const ORD17B = CORE.orderLegs([
  { title: 'X', station: 'A', toStation: 'B', startMs: 0, endMs: 10 * M17, group: 'A', name: '甲' },
  { title: 'X', station: 'C', toStation: 'D', startMs: 20 * M17, endMs: 30 * M17, group: 'A', name: '乙' }
]);
eq('17h 不同站 → sameStation false', ORD17B[0].handover.sameStation, false);
eq('17i 間隔 10 分', ORD17B[0].handover.gapMin, 10);
const ORD17C = CORE.orderLegs([
  { title: '501', station: '嘉義', toStation: '彰化', startMs: 0, endMs: 10 * M17, group: 'A', name: '甲' },
  { title: '501', station: '彰化', toStation: '台北', startMs: 10 * M17, endMs: 20 * M17, group: 'A', name: '甲' }
]);
eq('17j 同一車長續乘 → sameCrew true', ORD17C[0].handover.sameCrew, true);

// ============================================================
// 18. 2026/11/26 使用者回饋：3207（后里→彰化 11:09–12:20）延誤 90 分
//     A 車長在進入端（彰化）下車 → 抵達也延後 90（13:50）→ 接不上 2173（彰化 13:46 開）
//     原規則「下車站序 ≤ 進入端 → 未受影響」會漏掉這條鏈，改為 < 進入端才算未受影響。
// ============================================================
const r18 = CORE.classifyRider(
  { title: '3207', station: '臺中', toStation: '彰化' },
  tvS, IDX, idOf('彰化'), idOf('嘉義'));
eq('18a 3207 在進入端（彰化）下車 → 受影響', r18.affected, true);
eq('18b 延誤落在 alighting', r18.delayOn, 'alighting');
const ch18 = CORE.buildChain({
  seg: { title: '3207', station: '后里', toStation: '彰化', dep: 669, arr: 740 },   // 11:09–12:20
  trainNo: '3207', delay: 90, delayOn: 'alighting',
  next: { title: '2173', station: '彰化', toStation: '嘉義', dep: 826, arr: 910 },  // 13:46–15:10
  delays: {}, threshold: 10
});
eq('18c 3207＋90 → 彰化 13:50 到（arrNew＝830）', ch18.arrNew, 830);
eq('18d 2173 13:46 開 → 緩衝 −4 分', ch18.next.buffer, -4);
eq('18e 狀態＝趕不上（missed）', ch18.next.status, 'missed');
eq('18f 未延誤時緩衝 86 分（正常）',
  CORE.buildChain({
    seg: { title: '3207', station: '后里', toStation: '彰化', dep: 669, arr: 740 },
    trainNo: '3207', delay: 0, delayOn: 'alighting',
    next: { title: '2173', station: '彰化', toStation: '嘉義', dep: 826, arr: 910 },
    delays: {}, threshold: 10
  }).next.status, 'ok');

// ============================================================
// 19. 2026/11/27 使用者回饋：路線折返車（554 潮州→花蓮）——
//     全車首末站 45→70 是「南下」，但彰化–嘉義這一段是北上（順向）。
//     方向必須用「區間進入端→離開端」的站序判定，不能用全車首末站。
// ============================================================
const STATIONS_554 = [
  { id: '0900', name: '七堵', pos: 0 },
  { id: '1000', name: '臺北', pos: 5 },
  { id: '3360', name: '彰化', pos: 20 },
  { id: '3410', name: '員林', pos: 25 },
  { id: '4080', name: '嘉義', pos: 30 },
  { id: '5000', name: '屏東', pos: 40 },
  { id: '5050', name: '潮州', pos: 45 },
  { id: '7360', name: '瑞芳', pos: 60 },
  { id: '7000', name: '花蓮', pos: 70 }
];
const IDX_554 = CORE.makeIndex(STATIONS_554);
const nameOf554 = (id) => { const s = STATIONS_554.find((x) => x.id === id); return s ? s.name : id; };
const idOf554 = (name) => IDX_554.nameToId[CORE.normStn(name)];
// 554：潮州 11:40/11:50 → 屏東 12:00/12:02 → 嘉義 13:00/13:10 → 彰化 13:50/14:00
//      → 七堵 15:00/15:05 → 瑞芳 15:30/15:32 → 花蓮 16:00
const T_554 = {
  no: '554', type: '莒光', typeCode: '8', headsign: '往花蓮', extraTrain: false,
  serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 },
  note: '', stops: [
    ['5050', 700, 710], ['5000', 720, 722], ['4080', 780, 790],
    ['3360', 830, 840], ['0900', 900, 905], ['7360', 930, 932], ['7000', 960, 960]
  ]
};
const tv554 = CORE.traverseSection(T_554, idOf554('彰化'), idOf554('嘉義'), IDX_554.posById, nameOf554);
ok('19a 554 traverse 成功', !!tv554);
eq('19b 方向＝順向（北上；全車首末站是「南下」，不可用）', tv554 && tv554.south, false);
eq('19c 進入＝嘉義開車 790', tv554 && tv554.enter, 790);
eq('19d 離開＝彰化到達 830', tv554 && tv554.exit, 830);
eq('19e 進入端站序＝嘉義 30', tv554 && tv554.enterPos, 30);
eq('19f 離開端站序＝彰化 20', tv554 && tv554.exitPos, 20);
const r554a = CORE.classifyRider(
  { title: '554', station: '潮州', toStation: '屏東' },
  tv554, IDX_554, idOf554('彰化'), idOf554('嘉義'));
eq('19g 潮州→屏東（事故前下車）→ 未受影響', r554a.affected, false);
eq('19h 潮州→屏東 無延誤落點', r554a.delayOn, null);
const r554b = CORE.classifyRider(
  { title: '554', station: '屏東', toStation: '嘉義' },
  tv554, IDX_554, idOf554('彰化'), idOf554('嘉義'));
eq('19i 屏東→嘉義（進入端下車）→ 受影響', r554b.affected, true);
eq('19j 延誤落在 alighting', r554b.delayOn, 'alighting');
const r554c = CORE.classifyRider(
  { title: '554', station: '彰化', toStation: '七堵' },
  tv554, IDX_554, idOf554('彰化'), idOf554('嘉義'));
eq('19k 彰化→七堵（離開端上車）→ boarding', r554c.delayOn, 'boarding');
const r554d = CORE.classifyRider(
  { title: '554', station: '潮州', toStation: '彰化' },
  tv554, IDX_554, idOf554('彰化'), idOf554('嘉義'));
eq('19l 潮州→彰化（貫穿區間）→ alighting', r554d.delayOn, 'alighting');

// ============================================================
// 20. 折返車「一端不停靠」：誰先到用時間比（不用全車方向）
//     員林(25) 不停靠，內插自 嘉義 dep 790 → 彰化 arr 830 的中點 ＝ 810
// ============================================================
const tv554p = CORE.traverseSection(T_554, idOf554('員林'), idOf554('嘉義'), IDX_554.posById, nameOf554);
ok('20a 員林–嘉義 traverse 成功（員林不停靠＝離開端推估）', !!tv554p && tv554p.enterStop && !tv554p.exitStop);
eq('20b 進入＝嘉義開車 790（不是員林）', tv554p && tv554p.enter, 790);
eq('20c 離開＝員林內插 810', tv554p && tv554p.exit, 810);
eq('20d 方向＝順向', tv554p && tv554p.south, false);

// ============================================================
// 21. 起迄相同站（折返車也一樣）→ null
// ============================================================
eq('21a 嘉義→嘉義 → null',
  CORE.traverseSection(T_554, idOf554('嘉義'), idOf554('嘉義'), IDX_554.posById, nameOf554), null);

// ============================================================
// 22. 反向折返鏡像：花蓮→潮州。全車首末站 70→45 是「北上」，
//     但彰化–嘉義這一段是南下（逆向）
// ============================================================
const T_554_REV = {
  no: '555', type: '莒光', typeCode: '8', headsign: '往潮州', extraTrain: false,
  serviceDay: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1, holiday: 1 },
  note: '', stops: [
    ['7000', 700, 700], ['7360', 730, 732], ['0900', 800, 805],
    ['3360', 850, 860], ['4080', 890, 900], ['5000', 930, 932], ['5050', 950, 950]
  ]
};
const tvRev = CORE.traverseSection(T_554_REV, idOf554('彰化'), idOf554('嘉義'), IDX_554.posById, nameOf554);
eq('22a 方向＝逆向（南下）', tvRev && tvRev.south, true);
eq('22b 進入＝彰化開車 860', tvRev && tvRev.enter, 860);
eq('22c 離開＝嘉義到達 890', tvRev && tvRev.exit, 890);
eq('22d 進入端站序＝彰化 20', tvRev && tvRev.enterPos, 20);
eq('22e 離開端站序＝嘉義 30', tvRev && tvRev.exitPos, 30);
const rRevA = CORE.classifyRider(
  { title: '555', station: '花蓮', toStation: '七堵' },
  tvRev, IDX_554, idOf554('彰化'), idOf554('嘉義'));
eq('22f 花蓮→七堵（事故前下車）→ 未受影響', rRevA.affected, false);
const rRevB = CORE.classifyRider(
  { title: '555', station: '屏東', toStation: '潮州' },
  tvRev, IDX_554, idOf554('彰化'), idOf554('嘉義'));
eq('22g 屏東→潮州（事故後上車）→ boarding', rRevB.delayOn, 'boarding');
const rRevC = CORE.classifyRider(
  { title: '555', station: '彰化', toStation: '嘉義' },
  tvRev, IDX_554, idOf554('彰化'), idOf554('嘉義'));
eq('22h 彰化→嘉義（區間內）→ alighting', rRevC.delayOn, 'alighting');

// ============================================================
// 結果
// ============================================================
console.log('PASS ' + pass + ' / FAIL ' + fail);
if (fail) {
  console.log('--- failures ---');
  failures.forEach((f) => console.log('FAIL  ' + f));
  process.exit(1);
}
console.log('AFF CORE ALL PASSED');
