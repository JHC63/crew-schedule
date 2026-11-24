// ===== GAS 環境模擬 + 固定時間 =====
'use strict';

// 固定「現在時間」= 2026/11/18 14:00 (台北)
const RealDate = Date;
const FIXED_NOW = new RealDate('2026-11-18T14:00:00+08:00').getTime();

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...args);
  }
  static now() { return FIXED_NOW; }
}
globalThis.Date = FakeDate;

const replies = [];
globalThis.__replies = replies;

globalThis.SpreadsheetApp = {
  openById() {
    return {
      getSpreadsheetTimeZone() { return 'Asia/Taipei'; },
      getSheetByName(name) {
        const data = SHEETS[name];
        if (!data) return null;
        return {
          getDataRange() {
            return {
              getValues() { return data; },
              getDisplayValues() { return data; }
            };
          }
        };
      }
    };
  }
};

globalThis.Utilities = {
  formatDate(date, tz, fmt) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'Asia/Taipei',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date);
    const get = t => parts.find(p => p.type === t).value;
    if (fmt === 'HH:mm') return `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
    if (fmt === 'yyyy/MM/dd/HH/mm') return `${get('year')}/${get('month')}/${get('day')}/${get('hour') === '24' ? '00' : get('hour')}/${get('minute')}`;
    return `${get('year')}/${get('month')}/${get('day')}`;
  }
};

globalThis.PropertiesService = {
  getScriptProperties() {
    return {
      getProperty(key) {
        if (key === 'LINE_TOKEN') return 'test-token';
        if (key === 'SPREADSHEET_ID') return '1rgjRMuvGSl8_RQplFK6EMxwkgMovwdobS8LyISkSXwQ';
        return null;
      }
    };
  }
};

const __cacheStore = new Map();
globalThis.CacheService = {
  getScriptCache() {
    return {
      get(key) { return __cacheStore.has(key) ? __cacheStore.get(key) : null; },
      put(key, value) { __cacheStore.set(key, value); },
      remove(key) { __cacheStore.delete(key); }
    };
  }
};

globalThis.UrlFetchApp = {
  fetch(url, options) {
    const payload = JSON.parse(options.payload);
    (payload.messages || []).forEach(m => replies.push(m.text));
    return { getResponseCode: () => 200 };
  }
};

// ContentService：支援 setMimeType() 鏈式呼叫與 getContent()，供 doPost/doGet JSON 回應測試
globalThis.ContentService = {
  MimeType: {
    JSON: 'application/json',
    TEXT: 'text/plain',
    JAVASCRIPT: 'application/javascript'
  },
  createTextOutput(content) {
    return {
      _content: String(content == null ? '' : content),
      _mime: 'text/plain',
      append(added) { this._content += added; return this; },
      setContent(next) { this._content = next; return this; },
      getContent() { return this._content; },
      setMimeType(mime) { this._mime = mime; return this; },
      getMimeType() { return this._mime; }
    };
  }
};
