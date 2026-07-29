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
const APP_VERSION = 114;

/* ── 快取存活時間（統一常數，v95）─────────────────────────────────────
   v95修：原本四個快取各自寫死不同TTL（股價5分/融資5分/大盤10分/縱深10分），
   導致同一次查詢裡各層資料新鮮度不同，且重查時各層過期時機不同步——
   使用者反映「同時段查同一檔卻得到不同結果」，根因即在此。
   統一為單一常數後，所有資料層同進同出，結果具可重現性。
   ──────────────────────────────────────────────────────────────── */
/* ── 台股盤中時鐘（v101）────────────────────────────────────────────
   「奪先機」的前提是知道資訊時差：價量=T+0即時、法人籌碼=T+1盤後、
   大戶持股=週更。盤中查詢時今日K線是未完成的（量只有部分天），
   量能類檢查若拿部分日量比全日均量，必然偏低誤判——此工具讓各模組
   知道現在是否盤中、已開盤多少比例，據以「推估全日量」防呆。
   假設使用者在台灣時區（本專案使用者確定如此）。──────────────── */
function twMarketPhase() {
  /* v108修：原用 new Date().getHours()＝裝置本地時區——電腦若設非台北時區
     （或使用者在國外），盤中判定會整個錯位，導致同一時刻手機說「盤中」、
     電腦說「已收盤」，量能推估/先行足跡/盤中警示全部不同。
     改為固定以台北時間(UTC+8)計算，與裝置時區設定無關。 */
  const now = new Date();
  const d = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (8 * 3600000));
  const mins = d.getHours() * 60 + d.getMinutes();
  const open = 9 * 60, close = 13 * 60 + 30;         // 09:00 ~ 13:30 台北時間
  const isWeekday = d.getDay() >= 1 && d.getDay() <= 5;
  if (!isWeekday || mins < open) return { open: false, elapsed: 0, phase: '未開盤' };
  if (mins >= close) return { open: false, elapsed: 1, phase: '已收盤' };
  return { open: true, elapsed: Math.max(0.05, (mins - open) / (close - open)), phase: '盤中' };
}

/* ── 倉位管理兩條鐵律（v106，Alexander Elder《Trading for a Living》）──
   2%原則：單筆交易最大風險 ≤ 總資金2%（一次錯不致命）
   6%原則：當月已實現虧損累計達6% → 本月停止開新倉（連錯不致命）
   短線者尤其需要6%：2-10日週期交易頻繁，沒有月度剎車會在壞月份被凌遲。
   心理學根據：虧損後的報復性加碼（loss-chasing）是散戶帳戶歸零的主因，
   6%是「情緒失控前的硬煞車」——由規則停手，不靠意志力。
   ★ 全系統唯一的部位/風險真相來源，任何計算一律引用此常數
   ──────────────────────────────────────────────────────────────── */
const RISK_RULE = { perTrade: 2, monthly: 6 };

const CACHE_TTL = 300000;   // 5分鐘：所有資料層統一（股價/融資/大盤/主力縱深/基本面）

/* ── 前端超時保護（v96）──────────────────────────────────────────────
   v96修「查詢突然變很慢（原10秒→數分鐘）」：全系統原本零超時保護，
   任一資料來源慢或掛住，前端就無限轉圈等待。
   ★ 定義在 config.js（index.html 最早載入）供所有前端模組共用——
     若定義在 app.js（最後載入），market.js 等先載入的模組會找不到
   ★ 所有 await fetch(...) 一律改用 fetchT(...)，勿裸用 fetch
   ──────────────────────────────────────────────────────────────── */
const FE_TIMEOUT = 20000;   // 後端最長等 20 秒（後端內部單一來源另限 8 秒）
async function fetchT(url, opts = {}, ms = FE_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // v99：cache:'no-store' 強制繞過瀏覽器HTTP快取。後端回應若無 no-store 標頭，
    // 手機瀏覽器會以「完整網址」為key擅自快取GET回應，重新整理也殺不死——
    // 曾導致法人資料頑固不更新，換FinMind token（網址變了）才被迫抓新，即此雷
    return await fetch(url, { cache: 'no-store', ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('後端回應超時（20秒）——可能是某個資料來源異常，請稍後再試');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
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
