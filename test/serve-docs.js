#!/usr/bin/env node
// ===== docs/ 本機預覽伺服器（affected.html 用；file:// 開不了 fetch，見 affected-plan.md §9）=====
//
// 用法：
//   node test\serve-docs.js          # http://127.0.0.1:8899/affected.html，Ctrl+C 結束
//   node test\serve-docs.js 9000     # 指定埠
//
// 行為：serve docs/ 靜態檔，並把 /data/timetable.json 映射到
// test/fixtures/timetable.sample.json（schema 確認用樣本；正式 timetable.json 進 docs/data/ 後
// 此映射會被真實檔案取代——本腳本優先讀 docs/data/timetable.json，不存在才退回樣本）。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'docs');
const realTt = path.join(root, 'data', 'timetable.json');
const sampleTt = path.join(__dirname, 'fixtures', 'timetable.sample.json');
const port = Number(process.argv[2] || 8899);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let file = path.join(root, p);
  if (p === '/data/timetable.json' && !fs.existsSync(realTt)) file = sampleTt;
  fs.readFile(file, (e, buf) => {
    if (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + p);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => {
  console.log('serving ' + root + ' at http://127.0.0.1:' + port + '/affected.html');
  console.log('(timetable: ' + (fs.existsSync(realTt) ? realTt : sampleTt) + ')');
  console.log('Ctrl+C to stop');
});
