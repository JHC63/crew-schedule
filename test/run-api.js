// ===== LIFF API 快速驗證（含 doGet／doPost 分流） =====
// 注意：不能用 'use strict'，否則 eval() 的函式宣告不會外溢，apiCall 會抓不到。
const fs = require('fs');
const path = require('path');

require('./mocks.js');
require('./data.js');

const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'LiffApi.gs'), 'utf8');
eval(code + '\n' + api);

function call(action, payload) {
  const res = apiCall(action, payload || {});
  if (!res.ok) throw new Error(`[${action}] ${res.error}`);
  return res.data;
}

// 走 doPost 分流器（text/plain 簡單請求，與 docs/app.js 的 fetch 同形）
function callHttp(action, payload) {
  const res = doPost({
    postData: { type: 'text/plain', contents: JSON.stringify({ action: action, payload: payload || {} }) }
  });
  return JSON.parse(res.getContent());
}

// 走 doGet（?action=&payload=）
function callGet(action, payload) {
  const params = { action: action };
  if (payload) params.payload = JSON.stringify(payload);
  return JSON.parse(doGet({ parameter: params }).getContent());
}

const checks = [];
function check(label, fn) {
  try {
    const detail = fn();
    checks.push({ ok: true, label, detail });
  } catch (e) {
    checks.push({ ok: false, label, detail: e.stack || e.message });
  }
}

let bootstrap, my, staffDay, month, all, staff, status, station, lookup, trains;

check('bootstrap', () => {
  bootstrap = call('bootstrap');
  return `staff=${bootstrap.staff.length}, stations=${bootstrap.stations.length}, today=${bootstrap.today}`;
});

check('mySchedule', () => {
  my = call('mySchedule', { name: '小林', days: 7 });
  if (!my.staffs.length) throw new Error('找不到小林');
  return my.staffs[0].days.map(d => `${d.date} ${d.kind} ${d.label || '-'} ${d.summary}`).join(' | ');
});

check('staffDay', () => {
  staffDay = call('staffDay', { name: '小林', group: 'A', date: '2026-11-18', days: 8 });
  if (staffDay.missing) throw new Error('staffDay 不應 missing');
  if (staffDay.staffs.length !== 1) throw new Error(`應為 1 位車長，實際 ${staffDay.staffs.length}`);
  const day = staffDay.staffs[0].days[0];
  if (day.date !== '2026-11-18') throw new Error(`第一天應為 2026-11-18，實際 ${day.date}`);
  if (day.kind !== 'work') throw new Error(`11-18 應為工作日，實際 ${day.kind}`);
  return `${staffDay.staffs[0].staff.name} ${day.date} ${day.kind} ${day.label} ${day.summary}`;
});

check('monthSchedule', () => {
  month = call('monthSchedule', { name: '小林', month: '2026-11' });
  if (month.month !== '2026-11') throw new Error(`月份應為 2026-11，實際 ${month.month}`);
  if (month.monthDays !== 30) throw new Error(`應為 30 天，實際 ${month.monthDays}`);
  const days = month.staffs[0].days;
  if (days.length !== 30) throw new Error(`days 應為 30，實際 ${days.length}`);
  if (days[17].date !== '2026-11-18' || days[17].kind !== 'work') {
    throw new Error(`11-18 應為工作日，實際 ${days[17].date} ${days[17].kind}`);
  }
  return `${month.month} ${month.first}~${month.last} days=${days.length} 11-18=${days[17].label}`;
});

check('allSchedules', () => {
  all = call('allSchedules', { date: '2026-11-18' });
  if (all.count !== all.schedules.length) throw new Error('count 與 schedules 不一致');
  if (all.schedules.length !== 14) throw new Error(`Schedule 應列出 14 列，實際 ${all.schedules.length}`);
  const byKey = {};
  all.schedules.forEach(r => { byKey[`${r.group}_${r.index}`] = r; });
  const expect = [
    ['A', 12, '小林', '507-1'],
    ['A', 7, '李美華', '504'],
    ['A', 2, '陳大明', '501-2']
  ];
  expect.forEach(([g, idx, name, number]) => {
    const row = byKey[`${g}_${idx}`];
    if (!row) throw new Error(`找不到 ${g}_${idx}`);
    if (!row.staff || row.staff.name !== name) throw new Error(`${g}_${idx} 應為 ${name}，實際 ${row.staff && row.staff.name}`);
    if (String(row.number).indexOf(number) !== 0) throw new Error(`${g}_${idx} 班號應為 ${number}，實際 ${row.number}`);
  });
  const sortedByOn = all.schedules.filter(r => r.on).every((r, i, arr) =>
    i === 0 || arr[i - 1].onMin <= r.onMin);
  return `count=${all.count}, 小林=${byKey.A_12.staff.name}, 未排班=${all.schedules.filter(r => !r.staff).length}, onSorted=${sortedByOn}`;
});

check('staffSchedule(簡單)', () => {
  staff = call('staffSchedule', { names: ['小林', '李美華'], date: '2026-11-18', mode: 'simple' });
  return `days=${staff.days.length}, staffs=${staff.staffs.length}, missing=${staff.missing.length}`;
});

check('staffSchedule(詳細)', () => {
  const r = call('staffSchedule', { names: ['小林'], date: '2026-11-18', mode: 'detail' });
  const d = r.days[0].staffs[0];
  return `${d.label} ${d.summary} segments=${d.segments.map(s => s.kind + ':' + s.title).join(',')}`;
});

check('status 值乘', () => {
  status = call('status', { keyword: '值乘', date: '2026-11-18', startTime: '14:00' });
  const b = status.dates[0];
  return `${b.displayName} ${b.timeLabel} count=${b.count}`;
});

check('status 非值乘', () => {
  const r = call('status', { keyword: '中場', date: '2026-11-18', startTime: '16:00' });
  if (r.dates[0].displayName !== '非值乘') throw new Error(`displayName 應為「非值乘」，實際 ${r.dates[0].displayName}`);
  return `groups=${r.dates[0].groups.map(g => g.title + ':' + g.hits.length).join(',')} count=${r.dates[0].count}`;
});

check('status 放假', () => {
  const r = call('status', { keyword: '放假', date: '2026-11-20' });
  return `count=${r.dates[0].count} groups=${r.dates[0].groups.map(g => g.title).join(',')}`;
});

check('station', () => {
  station = call('station', { station: '嘉義', date: '2026-11-18', startTime: '16:00', endTime: '17:00' });
  return `count=${station.dates[0].count}`;
});

check('trainLookup', () => {
  lookup = call('trainLookup', { train: '3178', date: '2026-11-18', mode: 'detail' });
  const d = lookup.days[0];
  return `hits=${d.hits.length}, staff=${d.hits.map(h => h.staff.name + ':' + h.shiftLabel).join(',')}`;
});

check('allTrains', () => {
  trains = call('allTrains', { date: '2026-11-18' });
  // 排序：開車時間 → 起站 → 抵達時間
  const sorted = trains.trains.every((t, i, arr) => {
    if (i === 0) return true;
    const p = arr[i - 1];
    if (p.startMs !== t.startMs) return p.startMs < t.startMs;
    if (p.from !== t.from) return p.from.localeCompare(t.from, 'zh-Hant') < 0;
    return p.endMs <= t.endMs;
  });
  return `count=${trains.count}, sorted=${sorted}, first=${trains.trains[0].start} ${trains.trains[0].from} ${trains.trains[0].train}`;
});

check('validation: 基準日前', () => {
  const res = apiCall('status', { keyword: '值乘', date: '2026-06-30' });
  if (res.ok) throw new Error('應要失敗');
  return res.error;
});

check('validation: 未知操作', () => {
  const res = apiCall('nope', {});
  if (res.ok) throw new Error('應要失敗');
  return res.error;
});

// ── doGet / doPost 分流（events 優先於 action） ──

check('doGet 健康檢查', () => {
  const res = JSON.parse(doGet({ parameter: {} }).getContent());
  if (!res.ok || !res.data || res.data.service !== 'crew-schedule-api') {
    throw new Error('健康檢查格式錯誤：' + JSON.stringify(res));
  }
  return `service=${res.data.service}, version=${res.data.version}`;
});

check('doGet action 分流', () => {
  const res = callGet('bootstrap');
  if (!res.ok || !res.data || !res.data.staff || !res.data.staff.length) {
    throw new Error('doGet bootstrap 應回傳車長名單');
  }
  return `staff=${res.data.staff.length}, stations=${res.data.stations.length}`;
});

check('doGet 未知 action', () => {
  const res = callGet('nope');
  if (res.ok) throw new Error('應要失敗');
  return res.error;
});

check('doPost API 分流', () => {
  const res = callHttp('mySchedule', { name: '小林', days: 7 });
  if (!res.ok || !res.data || !res.data.staffs || !res.data.staffs.length) {
    throw new Error('doPost 應分流到 apiCall');
  }
  return `${res.data.staffs[0].days[0].date} ${res.data.staffs[0].days[0].kind}`;
});

check('doPost LINE webhook 分流', () => {
  __replies.length = 0;
  const out = doPost({
    postData: {
      type: 'application/json',
      contents: JSON.stringify({
        events: [{ replyToken: 'RT', type: 'message', message: { type: 'text', text: '11/18 小林' } }]
      })
    }
  });
  if (String(out.getContent()) !== 'OK') throw new Error('LINE 分流應回傳 OK');
  if (!__replies.length) throw new Error('LINE 分流應回覆訊息');
  return `reply=${__replies[0].split('\n')[3]}, messages=${__replies.length}`;
});

check('doPost 分流優先序：events 優先於 action', () => {
  __replies.length = 0;
  const out = doPost({
    postData: {
      type: 'application/json',
      contents: JSON.stringify({
        action: 'bootstrap',
        events: [{ replyToken: 'RT', type: 'message', message: { type: 'text', text: '11/18 小林' } }]
      })
    }
  });
  if (String(out.getContent()) !== 'OK') throw new Error('events 與 action 並存時應優先走 LINE 分流');
  if (!__replies.length) throw new Error('應回覆 LINE 訊息，而非回傳 bootstrap JSON');
  return `LINE 分流，messages=${__replies.length}`;
});

check('doPost 無效 JSON（application/json → OK）', () => {
  const out = doPost({ postData: { type: 'application/json', contents: '{bad' } });
  if (String(out.getContent()) !== 'OK') throw new Error('LINE webhook 解析失敗應回 OK 防 LINE 重試');
  return 'OK';
});

check('doPost 無效 JSON（其他 Content-Type → JSON 錯誤）', () => {
  const res = JSON.parse(doPost({ postData: { type: 'text/plain', contents: '{bad' } }).getContent());
  if (res.ok) throw new Error('應要失敗');
  return res.error;
});

check('doPost 無法辨識的請求格式', () => {
  const res = JSON.parse(doPost({ postData: { type: 'text/plain', contents: '{}' } }).getContent());
  if (res.ok) throw new Error('應要失敗');
  if (res.error !== '無法辨識的請求格式') throw new Error(`錯誤訊息不符：${res.error}`);
  return res.error;
});

console.log('');
checks.forEach(c => {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`);
  console.log(`      ${String(c.detail).replace(/\n/g, '\n      ')}`);
});
const failed = checks.filter(c => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exitCode = failed ? 1 : 0;
