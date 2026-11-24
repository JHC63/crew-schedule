# 將 .gs / 測試資料組成可在瀏覽器直接執行的 API 測試頁
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Read-Utf8([string]$path) {
  return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
}

$head = @'
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>API TEST</title>
<style>body{font:13px/1.5 Consolas,monospace;white-space:pre-wrap;padding:16px}</style>
</head>
<body>
<pre id="out">running...</pre>
<script>
window.addEventListener('error', function (e) {
  var el = document.getElementById('out');
  if (el) el.textContent = 'SCRIPT ERROR\n' + e.message + '\n' + (e.error && e.error.stack || '');
});
</script>
<script>
'@

$tail = @'
</script>
</body>
</html>
'@

$runner = @'
(function () {
  var lines = [];
  var fails = 0;
  function call(action, payload) {
    var res = apiCall(action, payload || {});
    if (!res.ok) throw new Error('[' + action + '] ' + res.error);
    return res.data;
  }
  function check(label, fn) {
    try {
      var d = fn();
      lines.push('PASS  ' + label + '  ::  ' + d);
    } catch (e) {
      fails++;
      lines.push('FAIL  ' + label + '  ::  ' + (e && e.stack || e));
    }
  }
  function callHttp(action, payload) {
    var out = doPost({
      postData: { type: 'text/plain', contents: JSON.stringify({ action: action, payload: payload || {} }) }
    });
    return JSON.parse(out.getContent());
  }
  function callGet(action, payload) {
    var params = { action: action };
    if (payload) params.payload = JSON.stringify(payload);
    var out = doGet({ parameter: params });
    return JSON.parse(out.getContent());
  }

  check('bootstrap', function () {
    var b = call('bootstrap');
    var expected = '七堵,南港,新竹,后里,彰化,斗六,民雄,嘉義,潮州';
    if (b.stations.join(',') !== expected) {
      throw new Error('車站站序不符：' + b.stations.join(','));
    }
    if (!b.stationKms || b.stationKms['嘉義'] !== 291.8 || b.stationKms['民雄'] !== 282.5) {
      throw new Error('車站里程不符：' + JSON.stringify(b.stationKms));
    }
    return 'staff=' + b.staff.length + ', stations=' + b.stations.length + ' (' + b.stations.join(' → ') + '), kms=' + Object.keys(b.stationKms).length + ', today=' + b.today + ', groups=' + b.groups.join('/');
  });

  check('mySchedule', function () {
    var m = call('mySchedule', { name: '小林', days: 7 });
    if (!m.staffs.length) throw new Error('找不到小林');
    return m.staffs[0].days.map(function (d) {
      return d.date + ' ' + d.kind + ' ' + (d.label || '-') + ' ' + d.summary;
    }).join(' | ');
  });

  check('staffDay', function () {
    var r = call('staffDay', { name: '小林', group: 'A', date: '2026-11-18', days: 8 });
    if (r.missing) throw new Error('staffDay 不應 missing');
    if (r.staffs.length !== 1) throw new Error('應為 1 位車長，實際 ' + r.staffs.length);
    var day = r.staffs[0].days[0];
    if (day.date !== '2026-11-18' || day.kind !== 'work') {
      throw new Error('第一天應為 2026-11-18 工作日，實際 ' + day.date + ' ' + day.kind);
    }
    return r.staffs[0].staff.name + ' ' + day.date + ' ' + day.kind + ' ' + day.label + ' ' + day.summary;
  });

  check('monthSchedule', function () {
    var r = call('monthSchedule', { name: '小林', month: '2026-11' });
    if (r.month !== '2026-11') throw new Error('月份應為 2026-11，實際 ' + r.month);
    if (r.monthDays !== 30) throw new Error('應為 30 天，實際 ' + r.monthDays);
    var days = r.staffs[0].days;
    if (days.length !== 30) throw new Error('days 應為 30，實際 ' + days.length);
    if (days[17].date !== '2026-11-18' || days[17].kind !== 'work') {
      throw new Error('11-18 應為工作日，實際 ' + days[17].date + ' ' + days[17].kind);
    }
    return r.month + ' ' + r.first + '~' + r.last + ' days=' + days.length + ' 11-18=' + days[17].label;
  });

  check('allSchedules', function () {
    var r = call('allSchedules', { date: '2026-11-18' });
    if (r.count !== r.schedules.length) throw new Error('count 與 schedules 不一致');
    if (r.schedules.length !== 14) throw new Error('Schedule 應列出 14 列，實際 ' + r.schedules.length);
    var byKey = {};
    r.schedules.forEach(function (row) { byKey[row.group + '_' + row.index] = row; });
    [['A', 12, '小林', '507-1'], ['A', 7, '李美華', '504'], ['A', 2, '陳大明', '501-2']]
      .forEach(function (exp) {
        var row = byKey[exp[0] + '_' + exp[1]];
        if (!row) throw new Error('找不到 ' + exp[0] + '_' + exp[1]);
        if (!row.staff || row.staff.name !== exp[2]) {
          throw new Error(exp[0] + '_' + exp[1] + ' 應為 ' + exp[2] + '，實際 ' + (row.staff && row.staff.name));
        }
        if (String(row.number).indexOf(exp[3]) !== 0) {
          throw new Error(exp[0] + '_' + exp[1] + ' 班號應為 ' + exp[3] + '，實際 ' + row.number);
        }
      });
    var unassigned = r.schedules.filter(function (row) { return !row.staff; }).length;
    return 'count=' + r.count + ', 小林=' + byKey.A_12.staff.name + ', 未排班=' + unassigned;
  });

  check('staffSchedule simple', function () {
    var r = call('staffSchedule', { names: ['小林', '李美華'], date: '2026-11-18', mode: 'simple' });
    return 'days=' + r.days.length + ', staffs=' + r.staffs.length + ', missing=' + r.missing.length;
  });

  check('staffSchedule detail', function () {
    var r = call('staffSchedule', { names: ['小林'], date: '2026-11-18', mode: 'detail' });
    var d = r.days[0].staffs[0];
    return d.label + ' ' + d.summary + ' :: ' + d.segments.map(function (s) { return s.kind + ':' + s.title + '(' + s.start + '-' + s.end + ')'; }).join(' / ');
  });

  check('staffSchedule 多日多人', function () {
    var r = call('staffSchedule', { names: ['小林', '李美華'], dates: ['2026-11-18', '2026-11-19', '2026-11-20'], mode: 'simple' });
    if (r.days.length !== 3) throw new Error('應為 3 天，實際 ' + r.days.length);
    if (r.staffs.length !== 2) throw new Error('應為 2 位車長，實際 ' + r.staffs.length);
    return 'days=' + r.days.length + ', staffs=' + r.staffs.length + ' :: ' +
      r.days.map(function (d) { return d.date + '=' + d.staffs.length + '人'; }).join(' ');
  });

  check('status 值乘', function () {
    var r = call('status', { keyword: '值乘', date: '2026-11-18', startTime: '14:00' });
    var b = r.dates[0];
    return b.displayName + ' ' + b.timeLabel + ' count=' + b.count + ' :: ' + b.groups.map(function (g) { return g.hits.map(function (h) { return h.staff.name + ':' + h.title; }).join(','); }).join(' | ');
  });

  check('status 非值乘', function () {
    var r = call('status', { keyword: '中場', date: '2026-11-18', startTime: '16:00' });
    var b = r.dates[0];
    if (b.displayName !== '非值乘') throw new Error('displayName 應為「非值乘」，實際 ' + b.displayName);
    return 'count=' + b.count + ' groups=' + b.groups.map(function (g) { return g.title + ':' + g.hits.length; }).join(',');
  });

  check('status 放假', function () {
    var r = call('status', { keyword: '放假', date: '2026-11-20' });
    return 'count=' + r.dates[0].count + ' groups=' + r.dates[0].groups.map(function (g) { return g.title; }).join(',');
  });

  check('station', function () {
    var r = call('station', { station: '嘉義', date: '2026-11-18', startTime: '16:00', endTime: '17:00' });
    return 'count=' + r.dates[0].count;
  });

  check('trainLookup', function () {
    var r = call('trainLookup', { train: '3178', date: '2026-11-18', mode: 'detail' });
    return 'hits=' + r.days[0].hits.length + ' :: ' + r.days[0].hits.map(function (h) { return h.staff.name + ':' + h.shiftLabel; }).join(',');
  });

  check('trainLookup 多車次多日', function () {
    var r = call('trainLookup', { trains: ['3178', '3257'], dates: ['2026-11-18', '2026-11-19'], mode: 'simple' });
    if (r.days.length !== 2) throw new Error('應為 2 天，實際 ' + r.days.length);
    var hits = r.days[0].hits || [];
    var names = hits.map(function (h) { return h.staff.name; });
    if (names.indexOf('小林') < 0) throw new Error('11-18 應命中操作 3178/3257 的小林');
    var matched = hits[0] ? hits[0].matched.length : 0;
    if (matched < 2) throw new Error('小林應同時命中 3178 與 3257');
    return 'days=' + r.days.length + ', trains=' + r.trains.join('+') + ', 11-18 hits=' + hits.length + ' (' + names.join(',') + '), matched=' + matched;
  });

  check('allTrains', function () {
    var r = call('allTrains', { date: '2026-11-18' });
    // 排序：開車時間 → 起站 → 抵達時間
    var sorted = r.trains.every(function (t, i) {
      if (i === 0) return true;
      var p = r.trains[i - 1];
      if (p.startMs !== t.startMs) return p.startMs < t.startMs;
      if (p.from !== t.from) return p.from.localeCompare(t.from, 'zh-Hant') < 0;
      return p.endMs <= t.endMs;
    });
    return 'count=' + r.count + ', sorted=' + sorted + ', first=' + (r.trains[0] ? r.trains[0].start + ' ' + r.trains[0].from + ' ' + r.trains[0].train : 'none');
  });

  check('allTrains 11-19 含 270A', function () {
    var r = call('allTrains', { date: '2026-11-19' });
    var t = r.trains.filter(function (x) { return x.train === '270A'; });
    if (!t.length) {
      throw new Error('11-19 找不到 270A：' + r.trains.map(function (x) { return x.train + '(' + x.from + '→' + x.to + ')'; }).join(','));
    }
    if (t[0].from !== '民雄' || t[0].to !== '嘉義') {
      throw new Error('270A 起訖不符：' + t[0].from + '→' + t[0].to);
    }
    return '270A ' + t[0].from + '→' + t[0].to + ' ' + t[0].start + '（民雄 282.5 → 嘉義 291.8 = 逆向）';
  });

  check('validation: 基準日前', function () {
    var res = apiCall('status', { keyword: '值乘', date: '2026-06-30' });
    if (res.ok) throw new Error('應要失敗');
    return res.error;
  });

  check('validation: 未知操作', function () {
    var res = apiCall('nope', {});
    if (res.ok) throw new Error('應要失敗');
    return res.error;
  });

  check('doGet health', function () {
    var res = JSON.parse(doGet({ parameter: {} }).getContent());
    if (!res.ok || !res.data || res.data.service !== 'crew-schedule-api') {
      throw new Error('健康檢查格式錯誤：' + JSON.stringify(res));
    }
    return 'service=' + res.data.service + ', version=' + res.data.version;
  });

  check('doGet bootstrap', function () {
    var res = callGet('bootstrap');
    if (!res.ok || !res.data || !res.data.staff || !res.data.staff.length) {
      throw new Error('doGet bootstrap 應回傳車長名單');
    }
    return 'staff=' + res.data.staff.length + ', stations=' + res.data.stations.length;
  });

  check('doPost API 分流', function () {
    var res = callHttp('mySchedule', { name: '小林', days: 7 });
    if (!res.ok || !res.data || !res.data.staffs || !res.data.staffs.length) {
      throw new Error('doPost 應分流到 apiCall');
    }
    return res.data.staffs[0].days[0].date + ' ' + res.data.staffs[0].days[0].kind;
  });

  check('doPost LINE webhook 分流', function () {
    __replies.length = 0;
    var out = doPost({
      postData: {
        type: 'application/json',
        contents: JSON.stringify({
          events: [{ replyToken: 'RT', type: 'message', message: { type: 'text', text: '11/18 小林' } }]
        })
      }
    });
    if (String(out.getContent()) !== 'OK') throw new Error('LINE 分流應回傳 OK');
    if (!__replies.length) throw new Error('LINE 分流應回覆訊息');
    var text = __replies[0];
    return 'reply=' + text.split('\n')[3] + ', messages=' + __replies.length;
  });

  check('doPost 無效 JSON', function () {
    var res = JSON.parse(doPost({ postData: { type: 'text/plain', contents: '{bad' } }).getContent());
    if (res.ok) throw new Error('應要失敗');
    return res.error;
  });

  check('doPost 未知 action', function () {
    var res = callHttp('nope', {});
    if (res.ok) throw new Error('應要失敗');
    return res.error;
  });

  var out = lines.join('\n') + '\n\n' + (fails ? fails + ' FAILED' : 'ALL PASSED');
  document.getElementById('out').textContent = out;
  document.title = fails ? 'FAILED ' + fails : 'ALL PASSED';
})();
'@

$parts = @(
  $head,
  (Read-Utf8 (Join-Path $PSScriptRoot 'mocks.js')),
  "`n</script><script>`n",
  (Read-Utf8 (Join-Path $PSScriptRoot 'data.js')),
  "`n</script><script>`n",
  (Read-Utf8 (Join-Path $root 'Code.gs')),
  "`n</script><script>`n",
  (Read-Utf8 (Join-Path $root 'LiffApi.gs')),
  "`n</script><script>`n",
  $runner,
  $tail
)

$content = $parts -join ''
$target = Join-Path $PSScriptRoot '_api-test.html'
[IO.File]::WriteAllText($target, $content, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $target
