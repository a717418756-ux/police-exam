/* ══════════════════════════════════════════════════════════════════════
   config.js — 全域設定中控
   ★ 改版時只改這裡的 APP_VERSION，sw.js 會自動破快取（與考試PWA同機制）
   ══════════════════════════════════════════════════════════════════════ */

// ▼▼▼ 每次改版把這個數字 +1（例如 6 → 7），就會自動清除舊快取 ▼▼▼
const APP_VERSION = 8;
// ▲▲▲ sw.js 和 db.js 都讀這個值，一處修改全域同步 ▲▲▲

// GAS 後端網址：改由「設定頁」輸入並存入 IndexedDB，不必改程式碼
// 啟動時 app.js 會從 DB 讀出覆寫此變數
let GAS_URL = '';

/* ── 錯誤記錄（手機看不到 F12 時，於設定頁查看）────────────────────── */
const ErrorLog = {
  _key: 'errorLog',
  async push(where, err) {
    try {
      const list = (await dbGetSetting(this._key)) || [];
      list.unshift({
        time: new Date().toLocaleString('zh-TW'),
        where,
        msg: String(err && err.message ? err.message : err)
      });
      // 只留最近 30 筆
      await dbSetSetting(this._key, list.slice(0, 30));
    } catch (e) { /* 記錄失敗就算了，不影響主流程 */ }
  },
  async getAll() { return (await dbGetSetting(this._key)) || []; },
  async clear() { await dbSetSetting(this._key, []); }
};
