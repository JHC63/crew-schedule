// ============================================================
// docs/affected-core.js——受影響列車「純邏輯」（無 DOM、無 fetch）
// ------------------------------------------------------------
// 瀏覽器：掛 window.AFFECTED_CORE（affected.html 先載本檔再載 affected.js）
// Node：  module.exports（test/run-affected.js 純函式測試用，§14）
// 規格：affected-plan.md §5 計算流程、§7 內插、§13 邊界情況
// 時間一律用「營運日 00:00 起算分鐘數」，跨夜 >1440（timetable.json 的慣例）
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AFFECTED_CORE = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 基礎 ----------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function parseHM(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  // 分鐘數 → 'HH:MM'；>1440 為隔日，顯示 '+1 HH:MM'
  function fmtMin(min) {
    var plus1 = min >= 1440 ? '+1 ' : '';
    var m = ((min % 1440) + 1440) % 1440;
    return plus1 + pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  // 車次正規化：去括號附註＋去「便」後綴（與 tools/build-timetable.js 同規則；A/B 保留）
  // 例：'1288便'→'1288'、'3148(3146)'→'3148'、'115A'→'115A'、'270A'→'270A'
  function normalizeTrainNo(train) {
    var t = String(train || '').trim();
    if (/^\d/.test(t)) {
      t = t.replace(/\([^)]*\)/g, '').trim();
      t = t.replace(/便$/, '');
    }
    return t;
  }
  // 站名正規化（與 Code.gs normalizeStationName 同規則：臺→台、去車站/站尾綴）
  function normStn(name) {
    return String(name || '')
      .replace(/\s+/g, '')
      .replace(/臺/g, '台')
      .replace(/火車站$/, '')
      .replace(/車站$/, '')
      .replace(/站$/, '')
      .trim();
  }

  // ---------- 輸入正規化（指定車次／站名搜尋用） ----------
  // 全形英數（含全形括號）→ 半形；全形空格 → 半形空格
  function toHalfWidth(s) {
    return String(s || '')
      .replace(/[\uFF01-\uFF5E]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      .replace(/\u3000/g, ' ');
  }
  // 車次輸入：全形→半形、去空白、去括號附註、去「便」、A/B 轉大寫
  // 例：'１１５Ａ'→'115A'、'115 a'→'115A'、'3292B便'→'3292B'
  function normalizeTrainInput(input) {
    var t = toHalfWidth(input).trim().replace(/\s+/g, '');
    if (/^\d/.test(t)) {
      t = t.replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '').replace(/便$/, '');
    }
    return t.toUpperCase();
  }
  // 車次比對：完全符合優先；輸入無 A/B 後綴且今日只有一個 A/B 腿 → 自動對到；
  // 多個 A/B 腿 → ambiguous；有 A/B 後綴但查無 → 不退回基數（避免對到反方向／另一班）。
  // keys = 今日班表車次字串（crew.byTrain 的 key）
  function resolveTrainNo(input, keys) {
    var query = normalizeTrainInput(input);
    var list = (keys || []).map(function (k) { return String(k); });
    if (!query) return { query: query, key: null, rule: 'empty', candidates: [] };
    var exact = list.filter(function (k) { return k === query; });
    if (exact.length) return { query: query, key: exact[0], rule: 'exact', candidates: exact };
    if (!/[AB]$/.test(query)) {
      var escQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var re = new RegExp('^' + escQ + '[AB]$');
      var vars = list.filter(function (k) { return re.test(k); }).sort();
      if (vars.length === 1) return { query: query, key: vars[0], rule: 'suffix', candidates: vars };
      if (vars.length > 1) return { query: query, key: null, rule: 'ambiguous', candidates: vars };
    }
    return { query: query, key: null, rule: 'notfound', candidates: [] };
  }

  // ---------- 站名搜尋（起訖站自刻 combobox） ----------
  // 空查詢 → 全部（依 pos 排序）；否則站名正規化子字串或站碼前綴
  function filterStations(stations, query) {
    var q = normStn(toHalfWidth(query));
    var out = [];
    (stations || []).forEach(function (s) {
      if (!q || normStn(s.name).indexOf(q) >= 0 || String(s.id).indexOf(q) === 0) out.push(s);
    });
    out.sort(function (a, b) {
      return (Number(a.pos) || 0) - (Number(b.pos) || 0) || String(a.id).localeCompare(String(b.id));
    });
    return out;
  }
  // 只接受「完全符合」的站名或站碼（給 blur／查詢前解析用）
  function resolveStation(stations, text) {
    var q = normStn(toHalfWidth(text));
    if (!q) return null;
    var list = stations || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === q || normStn(list[i].name) === q) return list[i];
    }
    return null;
  }

  // ---------- 指定車次：值乘腿排序／交接資訊 ----------
  // 回傳 [{ seg, handover }]，依 startMs 排序；handover 描述「本腿→下一腿」：
  //   sameCrew：同一車長續乘；sameStation：下車站＝下一腿上車站；gapMin：兩腿間隔（分，可負）
  function orderLegs(segments) {
    var list = (segments || []).slice().sort(function (a, b) {
      return (Number(a.startMs) || 0) - (Number(b.startMs) || 0) ||
        (Number(a.endMs) || 0) - (Number(b.endMs) || 0) ||
        String(a.title || '').localeCompare(String(b.title || ''));
    });
    return list.map(function (seg, i) {
      var next = list[i + 1] || null;
      var handover = null;
      if (next) {
        handover = {
          sameCrew: seg.group === next.group && seg.name === next.name,
          sameStation: normStn(seg.toStation) === normStn(next.station),
          gapMin: Math.round((Number(next.startMs) - Number(seg.endMs)) / 60000)
        };
      }
      return { seg: seg, handover: handover };
    });
  }

  // ---------- 站索引 ----------
  // stations = [{ id, name, pos, inStationTable }]
  // posById：站碼 → 沿線站序；nameToId：正規化站名 → 站碼（班表站名對照用）
  function makeIndex(stations) {
    var posById = {}, nameToId = {};
    (stations || []).forEach(function (s) {
      posById[s.id] = s.pos;
      var n = normStn(s.name);
      if (nameToId[n] == null) nameToId[n] = s.id;
    });
    return { posById: posById, nameToId: nameToId };
  }

  // ---------- 內插（§7：通過未停靠的列車） ----------
  // 在車次停靠序列中，找 targetPos（沿線站序位置）前後兩個停靠站 P、Q：
  //   通過時間 ≈ P 開車 ＋ (pos(站)−pos(P)) / (pos(Q)−pos(P)) × (Q 到達 − P 開車)
  // targetPos 落在該車行駛範圍外 → null（該車不經過）
  function interpolateAt(stops, stopPos, targetPos) {
    for (var i = 0; i < stops.length - 1; i++) {
      var a = stopPos[i], b = stopPos[i + 1];
      var lo = Math.min(a, b), hi = Math.max(a, b);
      if (targetPos > lo && targetPos < hi) {
        var span = b - a;
        if (span === 0) return null;
        var ratio = (targetPos - a) / span;
        return Math.round(stops[i][2] + ratio * (stops[i + 1][1] - stops[i][2]));
      }
    }
    return null;
  }
  // tooltip 用：內插來源的前後停靠站（站名＋時間）
  function passInfo(stops, stopPos, targetPos, nameOf) {
    for (var i = 0; i < stops.length - 1; i++) {
      var a = stopPos[i], b = stopPos[i + 1];
      var lo = Math.min(a, b), hi = Math.max(a, b);
      if (targetPos > lo && targetPos < hi) {
        return {
          from: nameOf(stops[i][0]) + ' ' + fmtMin(stops[i][2]),
          to: nameOf(stops[i + 1][0]) + ' ' + fmtMin(stops[i + 1][1])
        };
      }
    }
    return null;
  }

  // ---------- L1：列車在 [fromId, toId] 區間的進入／離開 ----------
  // 進入端／離開端依列車行進方向決定（停靠序列先遇到誰），不固定表單左右（§5 Step 2.2）。
  // 端點不停靠 → 內插推估，標 enterStop/exitStop = false（§7）。
  // 回傳 { enter, exit, enterStop, exitStop, south, approx: { enter?, exit? } } 或 null（不經過）。
  function traverseSection(train, fromId, toId, posById, nameOf) {
    var stops = train.stops;
    var pFrom = posById[fromId], pTo = posById[toId];
    if (pFrom == null || pTo == null) return null;
    var n = stops.length;
    if (n < 2) return null;
    var stopPos = new Array(n);
    for (var i = 0; i < n; i++) {
      var p = posById[stops[i][0]];
      if (p == null) return null;
      stopPos[i] = p;
    }
    // 行進方向：沿線 pos 遞增＝南下（站碼排序：基隆→枋寮）
    var south = stopPos[n - 1] > stopPos[0];
    var iFrom = -1, iTo = -1;
    for (var j = 0; j < n; j++) {
      if (stops[j][0] === fromId && iFrom < 0) iFrom = j;
      if (stops[j][0] === toId && iTo < 0) iTo = j;
    }
    var enter, exit, enterStop, exitStop, approx = {};
    if (iFrom >= 0 && iTo >= 0) {
      // 兩端都停靠：行進順序＝index 小者先遇到
      var first = Math.min(iFrom, iTo), last = Math.max(iFrom, iTo);
      if (first === last) return null;
      enter = stops[first][2];     // 進入端開車時間
      exit = stops[last][1];       // 離開端到達時間
      enterStop = true;
      exitStop = true;
    } else {
      var tFrom = iFrom >= 0 ? null : interpolateAt(stops, stopPos, pFrom);
      var tTo = iTo >= 0 ? null : interpolateAt(stops, stopPos, pTo);
      if (iFrom < 0 && tFrom == null) return null;
      if (iTo < 0 && tTo == null) return null;
      var enterPos = south ? Math.min(pFrom, pTo) : Math.max(pFrom, pTo);
      var fromIsEnter = pFrom === enterPos;
      if (fromIsEnter) {
        enter = iFrom >= 0 ? stops[iFrom][2] : tFrom;
        exit = iTo >= 0 ? stops[iTo][1] : tTo;
        enterStop = iFrom >= 0;
        exitStop = iTo >= 0;
        if (!enterStop) approx.enter = passInfo(stops, stopPos, pFrom, nameOf);
        if (!exitStop) approx.exit = passInfo(stops, stopPos, pTo, nameOf);
      } else {
        enter = iTo >= 0 ? stops[iTo][2] : tTo;
        exit = iFrom >= 0 ? stops[iFrom][1] : tFrom;
        enterStop = iTo >= 0;
        exitStop = iFrom >= 0;
        if (!enterStop) approx.enter = passInfo(stops, stopPos, pTo, nameOf);
        if (!exitStop) approx.exit = passInfo(stops, stopPos, pFrom, nameOf);
      }
    }
    return { enter: enter, exit: exit, enterStop: enterStop, exitStop: exitStop, south: south, approx: approx };
  }

  // ---------- L2：車長與事故區間的關係（§5 Step 3） ----------
  // seg = staffSchedule 的 train segment（station=上車、toStation=下車，班表站名）
  // 回傳 { affected, delayOn: 'alighting'|'boarding'|null, unknownStation? }
  //   - 下車站序 < 進入端 → 未受影響（車列入、車長標未受影響）
  //   - 下車站序 ＝ 進入端 → 受影響（延誤落在 alighting）
  //     （2026/11/26 使用者回饋改：3207 延誤 90 時，在彰化（進入端）下車的車長
  //      抵達也延後 90 → 接不上下一班。延誤回堵會漫延到進入端之前，寧可多提醒。）
  //   - 上車站序 ≥ 離開端 → 受影響（延誤落在 boarding）
  //   - 其他 → 受影響（延誤落在 alighting）
  function classifyRider(seg, tv, index, fromId, toId) {
    var posById = index.posById, nameToId = index.nameToId;
    var idUp = nameToId[normStn(seg.station)];
    var idDown = nameToId[normStn(seg.toStation)];
    if (idUp == null || idDown == null) return { affected: false, unknownStation: true };
    var pUp = posById[idUp], pDown = posById[idDown];
    var pFrom = posById[fromId], pTo = posById[toId];
    if (pUp == null || pDown == null || pFrom == null || pTo == null) {
      return { affected: false, unknownStation: true };
    }
    var south = tv.south;
    var enterPos = south ? Math.min(pFrom, pTo) : Math.max(pFrom, pTo);
    var exitPos = south ? Math.max(pFrom, pTo) : Math.min(pFrom, pTo);
    var offBefore = south ? (pDown < enterPos) : (pDown > enterPos);
    if (offBefore) return { affected: false, delayOn: null };
    var boardAfter = south ? (pUp >= exitPos) : (pUp <= exitPos);
    if (boardAfter) return { affected: true, delayOn: 'boarding' };
    return { affected: true, delayOn: 'alighting' };
  }

  // ---------- L3：緩衝時間檢查（§4、§5 Step 4） ----------
  // buffer = 下一班出發（含該班自己的延誤）− 本班抵達（含延誤）
  // 狀態：buffer<0 趕不上（missed）；0≤buffer<門檻 不足（short，嚴格 <）；其餘正常（ok）
  function bufferCheck(curArr, delay, nextDep, nextDelay, threshold) {
    var buffer = (nextDep + nextDelay) - (curArr + delay);
    var status;
    if (buffer < 0) status = 'missed';
    else if (buffer < threshold) status = 'short';
    else status = 'ok';
    return { buffer: buffer, status: status };
  }

  // ---------- L3：影響鏈組裝（§5 Step 4、§13 邊界） ----------
  // opt = {
  //   seg:      本班 segment { title, station, toStation, dep, arr }（dep/arr 為營運日分鐘數，跨夜 >1440）
  //   trainNo:  本班在時刻表的車次 no
  //   delay:    本班延誤（分）
  //   delayOn:  'alighting' | 'boarding'
  //   next:     下一班 segment（同形）或 null（當日最後一班）
  //   delays:   { 正規化車次 → 延誤分 }（下一班自身的延誤在這裡查）
  //   threshold: 緩衝門檻（分）
  // }
  // 回傳 { dep, arr, arrNew, next: {kind, status, buffer?, delayNext?, depNew?, detail?} }
  // kind: 'buffer'｜'lasttrain'｜'samecontinue'（同一車次續開）｜'crossnight'（下一班跨日）｜'difstation'（不同站接駁）
  // 多筆延誤取 max 不取 sum（§5 Step 4）：每班的延誤是單一值（同車次重複輸入即覆蓋），
  // 鏈上各班只套用「本班延誤」與「下一班自身延誤」，不疊加其他班的延誤。
  function buildChain(opt) {
    var seg = opt.seg, next = opt.next;
    var delay = opt.delay || 0;
    var out = {
      dep: seg.dep, arr: seg.arr,
      arrNew: seg.arr + delay,
      depNew: seg.dep + delay
    };
    if (!next) {
      out.next = { kind: 'lasttrain', status: 'ok' };
      return out;
    }
    var nextNo = normalizeTrainNo(next.title);
    var curNo = normalizeTrainNo(opt.trainNo);
    var nextDelay = Number(opt.delays && opt.delays[nextNo]) || 0;
    out.nextSeg = next;
    // 同一車次續開（兩天班）→ 延誤直接帶入，不做緩衝檢查（§13）
    if (nextNo && nextNo === curNo) {
      out.next = { kind: 'samecontinue', status: 'ok', delayNext: nextDelay };
      return out;
    }
    // 下一班在隔日 → 跨夜，需人工確認（v1 只查當日，§13）
    if (next.dep >= 1440) {
      out.next = { kind: 'crossnight', status: 'manual', delayNext: nextDelay };
      return out;
    }
    // 不同站接駁 → 需人工確認，不算數值（§13）
    if (normStn(next.station) !== normStn(seg.toStation)) {
      out.next = {
        kind: 'difstation', status: 'manual', delayNext: nextDelay,
        detail: '下一班於 ' + next.station + ' 上車（本班 ' + seg.toStation + ' 下車）'
      };
      return out;
    }
    var chk = bufferCheck(seg.arr, delay, next.dep, nextDelay, opt.threshold);
    out.next = {
      kind: 'buffer', status: chk.status, buffer: chk.buffer,
      delayNext: nextDelay, depNew: next.dep + nextDelay
    };
    return out;
  }

  return {
    pad2: pad2,
    parseHM: parseHM,
    fmtMin: fmtMin,
    normalizeTrainNo: normalizeTrainNo,
    normalizeTrainInput: normalizeTrainInput,
    resolveTrainNo: resolveTrainNo,
    normStn: normStn,
    toHalfWidth: toHalfWidth,
    filterStations: filterStations,
    resolveStation: resolveStation,
    orderLegs: orderLegs,
    makeIndex: makeIndex,
    interpolateAt: interpolateAt,
    passInfo: passInfo,
    traverseSection: traverseSection,
    classifyRider: classifyRider,
    bufferCheck: bufferCheck,
    buildChain: buildChain
  };
});
