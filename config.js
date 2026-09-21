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
const APP_VERSION = 149;

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
  /* v119修：原寫法 getTime() + getTimezoneOffset()*60000 + 8h 是重複校正——
     getTime() 已是 UTC 毫秒，再加 offset 等於多轉一次時區。在台北裝置上會把
     10:30 算成 02:30，導致「盤中」永遠判定為非盤中：v101 起的盤中量能推估、
     先行足跡、盤中警示等功能，在實機上從未真正生效（容器為UTC故測不出）。
     正確：UTC毫秒 + 8小時 = 台北時間。 */
  /* v120修：v119 改用「Date.now()+8h」造出台北時間戳是對的，但下面卻用
     getHours()/getDay()（本地時區方法）去讀——在台北裝置上等於再加8小時，
     變成 UTC+16，台北10:30被讀成18:00，盤中判定依然全錯。
     ★ 鐵律：用「+8h 的時間戳」時，一律搭配 getUTC* 系列方法讀取，
       兩者必須成對，混用即錯。（worker.js 的 _tpeDateStr 已是此正確寫法） */
  const d = new Date(Date.now() + 8 * 3600000);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const open = 9 * 60, close = 13 * 60 + 30;         // 09:00 ~ 13:30 台北時間
  const isWeekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
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

/* ── 證據登記表（v133）─────────────────────────────────────────────────
   本系統一路做了大量嚴格檢驗，但結果散落在各卡片的警語裡，缺一個統一的
   「這項判斷到底可不可信」的權重來源——導致共識度把「已證偽的指標」
   和「通過19年驗證的指標」當成等值票數在算，信心度因此失真。
   這裡把所有檢驗結果登記成單一真相表，供綜合研判加權使用。
     tier A：大樣本或樣本外檢驗通過，可作決策依據
     tier B：描述性/工具性，不宣稱方向，但對判斷有輔助價值
     tier X：檢驗未通過，已除權——不計入信心，僅保留畫面描述
   ★ 新增任何分析功能時，必須在此登記其證據等級，未登記者一律視為 B。
   ★ 任何等級變動都必須有可重現的檢驗數據支持，不可憑感覺調整。
   ──────────────────────────────────────────────────────────────── */
const EVIDENCE = {
  regime:      { tier: 'X', w: 0,   note: 'v138 實測：順勢/逆勢期望值無差異（19年23,226筆），不再投方向票；僅保留高波動禁令的風控用途' },
  breakout:    { tier: 'A', w: 1.0, note: '19年3,934次：成功率38.4%，帶量40.9% vs 無量34.5%' },
  riskReward:  { tier: 'A', w: 1.0, note: 'MFE實證：中位可達幅度÷停損距離，決定期望值正負' },
  moveStage:   { tier: 'A', w: 0.9, note: '逐股波段百分位；尾端追單風險實證' },
  crowding:    { tier: 'A', w: 0.9, note: '多源直測（當沖/融資/券資比/借券），非推估' },
  amihud:      { tier: 'B', w: 0.6, note: 'Amihud 2002流動性；風險維度非方向' },
  smartStop:   { tier: 'B', w: 0.6, note: '逐股假跌破率；停損擺放工具' },
  chartLevel:  { tier: 'B', w: 0.5, note: '線位工具，提供可下單價位，非方向預測' },
  intentAlpha: { tier: 'B', w: 0.5, note: '意圖判定經逐股α閘控後才投票；全域α≈0' },
  behavior:    { tier: 'B', w: 0.5, note: '行為推理鏈：證據整合，含共線折減' },
  quantScore:  { tier: 'X', w: 0,   note: '樣本外α=-4.4（反指標）；大跌分從未觸發，已除權' },
  probCard:    { tier: 'X', w: 0,   note: 'LogLoss 6檔5檔劣於基準，無資訊量，已除權' },
  bayesProb:   { tier: 'X', w: 0,   note: '極端區間嚴重偏離（宣稱10~20%時實際64%），已壓縮並除權' },
  intentDir:   { tier: 'X', w: 0,   note: '19年7,908事件：全域方向α≈0，出貨為反指標，已除權' },
};

/* v139 條件式期望值：backtest_conditional.js 實測（24檔 2006~2026，隔日開盤進場、同K先停損、跳空開盤成交、
   進出各1檔、手續費6折＋稅＋融券費；出場固定 1×ATR 停損／1.5×ATR 目標／≤10日）。值＝[每筆淨%, 筆數]。
   型態×盤勢樣本<30 的格子不列，查不到時退回該型態「全部」。更新方式：重跑腳本後覆寫本表。 */
const COND_EV = {
  base: { 1: { 全部: [-0.83, 23226], 多頭: [-0.79, 6684], 空頭: [-0.83, 5110], 盤整: [-0.89, 7556], 過渡: [-0.94, 3078], 高波動: [-0.40, 798] },
         '-1': { 全部: [-0.96, 23226], 多頭: [-0.97, 6684], 空頭: [-0.94, 5110], 盤整: [-0.93, 7556], 過渡: [-0.95, 3078], 高波動: [-1.42, 798] } },
  setups: {
    '突破20日高':   { dir: 1,  全部: [-0.99, 3721], 多頭: [-1.12, 1889], 空頭: [-1.17, 104], 盤整: [-0.64, 1252], 過渡: [-1.33, 476] },
    '多頭排列拉回': { dir: 1,  全部: [-0.80, 4187], 多頭: [-0.73, 2368], 空頭: [-1.00, 155], 盤整: [-0.88, 1141], 過渡: [-1.05, 409], 高波動: [-0.37, 114] },
    '空頭排列反彈': { dir: -1, 全部: [-0.96, 3606], 多頭: [-0.80, 183], 空頭: [-0.92, 1701], 盤整: [-0.97, 1136], 過渡: [-0.83, 406], 高波動: [-1.78, 180] },
    '跌破20日低':   { dir: -1, 全部: [-0.90, 3316], 多頭: [-0.80, 128], 空頭: [-0.90, 1464], 盤整: [-0.74, 1115], 過渡: [-0.98, 426], 高波動: [-1.81, 183] },
    '假突破回落':   { dir: -1, 全部: [-0.83, 1466], 多頭: [-0.78, 819], 空頭: [-0.53, 45], 盤整: [-0.98, 383], 過渡: [-0.77, 199] },
  },
};

/* ── 資料落後主動偵測（v118）───────────────────────────────────────────
   問題：畫面只顯示「資料日期07/14」，使用者得自己心算現在是幾號、
   該不該有更新的資料——容易被忽略，誤把舊資料當最新判斷。
   這裡直接算出「最近一個應該有資料的交易日」，逐一比對法人/融資/借券
   的實際資料日，超過門檻就主動標紅警示，不用使用者自己算。
   時程依據：T86/MI_MARGN 約當日下午公布；SBL(借券)按慣例T+1公布。
   ──────────────────────────────────────────────────────────────── */
function expectedTradeDate(lagDays) {
  lagDays = lagDays || 0;
  /* v119修：原寫法 Date.now() + getTimezoneOffset()*60000 + 8h 是「重複校正」——
     Date.now() 本身已是 UTC 毫秒，再加 offset 等於多轉一次時區。
     在台北裝置(offset=-480)上會把台北16:00算成08:00，整整差8小時，
     導致「現在該不該有今天的資料」判斷全錯（誤報落後或漏報落後）。
     容器測試是UTC(offset=0)所以測不出來，只在實機發作。
     正確：UTC毫秒 + 8小時 = 台北時間，與 worker.js 的 _tpeDateStr 寫法一致。 */
  const d = new Date(Date.now() + 8 * 3600000);
  const hour = d.getUTCHours();
  // 台股約15:30~16:00後T86/MI_MARGN才公布完整，之前只能拿到前一交易日
  let back = (hour < 16) ? 1 : 0;
  back += lagDays;
  let day = new Date(d.getTime() - back * 86400000);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day = new Date(day.getTime() - 86400000);
  const y = day.getUTCFullYear(), m = String(day.getUTCMonth() + 1).padStart(2, '0'), dd = String(day.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}
function checkDataFreshness(dataDate, lagDays) {
  if (!dataDate) return null;
  const ds = String(dataDate);
  if (!/^\d{8}$/.test(ds)) return null;   // v118修：格式異常(非8位數字)時安全跳過，不誤判為「正常」
  const expected = expectedTradeDate(lagDays);
  if (ds >= expected) return { stale: false, expected };
  // 算落後幾個交易日（粗估，僅供顯示嚴重程度）
  const d1 = new Date(+ds.slice(0,4), +ds.slice(4,6)-1, +ds.slice(6,8));
  const d2 = new Date(+expected.slice(0,4), +expected.slice(4,6)-1, +expected.slice(6,8));
  const gapDays = Math.round((d2 - d1) / 86400000);
  return { stale: true, expected, gapDays };
}

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
/* v137 台股升降單位（原始市價）：短線近停損時，1檔常占停損距離的一成以上，必須計入 */
const twTick = p => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
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
