// ===== 測試執行器 =====
const fs = require('fs');
const path = require('path');

require('./mocks.js');
require('./data.js');

// doPost 分流器在「API 請求」「JSON 解析錯誤」路徑會呼叫 handleApiRequest_／jsonResponse_
//（定義在 LiffApi.gs），兩個檔案都要載入才測得到完整 doPost。
// 注意：不能用 'use strict'，否則 eval() 的函式宣告不會外溢。
const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'LiffApi.gs'), 'utf8');
eval(code + '\n' + api);

const QUERIES = [
  // ── 1. 員工查詢 / 班表 / 車次（保留） ──
  '小林',
  '11/18 小林',
  '11/18,11/19 小林',
  '11/18-11/20 小林',
  '11/18 班表',
  '11/18 小林 3178',
  '11/18 3178',
  // ── 2. 班別：日／夜／休（日管、日內適用） ──
  '11/18 日',
  '11/18 夜',
  '11/18 休',
  '11/18 日 小林',
  // ── 3. 已移除功能：應回覆導引網頁版 ──
  '值乘',
  '值乘 14:00',
  '值乘 14:00-15:00',
  '11/18 值乘 00:05',
  '值乘 小林',
  '值乘 25:00',
  '中場',
  '中場 16:00',
  '中場 17:00-19:00',
  '11/18 中場 16:30 嘉義',
  '11/19 中場 22:00',
  '11/19 中場 22:00 潮州',
  '放假',
  '11/20 放假',
  '11/18-11/20 放假',
  '11/18 放假 嘉義',
  '簡單 11/18 3178',
  '詳細 11/18 3178',
  '簡單 11/18 小林 3178',
  '簡單 小林',
  '詳細 11/18 小林',
  'who',
  'WHO 16:00',
  '嘉義 16:00-17:00',
  '11/17 南港 23:00-23:59',
  '民雄 23:00-01:00',
  '嘉義 16:00',
  // ── 4. 邊界 ──
  '11/18',
  '6.30 小林',
  '11/18-12/05 小林',
  // ── 5. 標籤詞與全形輸入（原本會失效的寫法） ──
  '車次 3178',
  '車長姓名 小林',
  '車長姓名：小林',
  '查詢 11/18 3178',
  '１１／１８　小林',
  '?',
  // ── 6. 系統診斷 ──
  '診斷'
];

const results = [];
QUERIES.forEach(q => {
  __replies.length = 0;
  const event = {
    postData: {
      contents: JSON.stringify({
        events: [{ replyToken: 'RT', type: 'message', message: { type: 'text', text: q } }]
      })
    }
  };
  let err = null;
  try { doPost(event); } catch (e) { err = e; }
  const out = __replies.join('\n\n');
  results.push({ q, out, err });
});

let dump = '';
results.forEach(({ q, out, err }) => {
  dump += `┌─ 輸入：「${q}」\n`;
  if (err) dump += `  [例外] ${err.stack}\n`;
  dump += out ? out.split('\n').map(l => '│ ' + l).join('\n') : '│ (無回覆)';
  dump += `\n└──────────────────────────────\n\n`;
});
fs.writeFileSync(path.join(__dirname, 'results.txt'), dump, 'utf8');
console.log('done, ' + results.length + ' queries');
