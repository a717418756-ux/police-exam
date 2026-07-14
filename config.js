/* ══════════════════════════════════════════════════════════════════════
   config.js — 全域設定中控
   ★ 改版時只改這裡的 APP_VERSION，sw.js 會自動破快取（與考試PWA同機制）
   ──────────────────────────────────────────────────────────────────
   ⚠️ 已知地雷／注意事項：
     - APP_VERSION同時驅動sw.js快取版本與db.js的DB_VERSION，若db schema
       有變更（新增object store），升版後務必確認openDB內有對應遷移邏輯
       （見db.js檔頭），否則舊使用者升級可能出現IndexedDB讀取錯誤
     - 每次修改任何前端檔案都必須升這個版本號，這是交付前19項檢查
       清單的固定項目，忘記升版=使用者會讀到瀏覽器快取的舊版程式碼
   ══════════════════════════════════════════════════════════════════════ */

// ▼▼▼ 每次改版把這個數字 +1（例如 6 → 7），就會自動清除舊快取 ▼▼▼
const APP_VERSION = 92;
// ▲▲▲ sw.js 和 db.js 都讀這個值，一處修改全域同步 ▲▲▲

// GAS 後端網址：改由「設定頁」輸入並存入 IndexedDB，不必改程式碼
// 啟動時 app.js 會從 DB 讀出覆寫此變數
let GAS_URL = '';
let SYNC_URL = '';
let FINMIND_TOKEN = '';
const TRADE_COST_PCT = 0.585;  // 台股波段來回成本%：證交稅0.3 + 手續費0.1425×2（當沖稅減半約0.44；美股另計）  // FinMind API token（選填，啟用主力縱深：千張/借券/分點）  // 雲端備份專用網址（選填，留空則用 GAS_URL）

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
