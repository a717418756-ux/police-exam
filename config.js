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
const APP_VERSION = 194;

/* ── 快取存活時間（統一常數，v95）─────────────────────────────────────
   v95修：原本四個快取各自寫死不同TTL（股價5分/融資5分/大盤10分/縱深10分），
   導致同一次查詢裡各層資料新鮮度不同，且重查時各層過期時機不同步——
   使用者反映「同時段查同一檔卻得到不同結果」，根因即在此。
   統一為單一常數後，所有資料層同進同出，結果具可重現性。
   ──────────────────────────────────────────────────────────────── */
/* v187 拿掉 v101 的 twMarketPhase（盤中時鐘）：它的用途是「推估盤中全日量」，v141 起盤中已改用前一根完整K棒，
   推估反而把完整量放大好幾倍；盤中判斷改用 inSession／SESS（交易所當地時間，台美都適用） */
/* ── 倉位管理兩條鐵律（v106，Alexander Elder《Trading for a Living》）──
   2%原則：單筆交易最大風險 ≤ 總資金2%（一次錯不致命）
   6%原則：當月已實現虧損累計達6% → 本月停止開新倉（連錯不致命）
   短線者尤其需要6%：2-10日週期交易頻繁，沒有月度剎車會在壞月份被凌遲。
   心理學根據：虧損後的報復性加碼（loss-chasing）是散戶帳戶歸零的主因，
   6%是「情緒失控前的硬煞車」——由規則停手，不靠意志力。
   ★ 全系統唯一的部位/風險真相來源，任何計算一律引用此常數
   ──────────────────────────────────────────────────────────────── */
const RISK_RULE = { perTrade: 2, monthly: 6 };

/* ── 證據分級規矩（v133）───────────────────────────────────────────────
     tier A：大樣本或樣本外檢驗通過，可作決策依據
     tier B：描述性/工具性，不宣稱方向，但對判斷有輔助價值
     tier X：檢驗未通過——不計分（v188 起直接刪除，不再留在畫面上）
     tier U：資料可用但判讀未經回測——只顯示、不計分
   ★ 新增任何分析功能時，先在下方「證據等級登記」寫明等級與依據；沒有依據的不可拿來擋單或給分。
   ★ 任何等級變動都必須有可重現的檢驗數據支持，不可憑感覺調整。
   ──────────────────────────────────────────────────────────────── */
/* v163：各前端檔案的「應有版本」。實際版本由各檔自己宣告到 window.SR_FV，
   app.js 啟動時比對，不符就直接點名是哪個檔沒更新——
   以前只能靠「畫面文字怎麼還是舊的」去猜，這種事發生過不只一次。 */
const FILE_VERS = {
  'help.js': 194, 'db.js': 187, 'market.js': 188, 'enhance.js': 188, 'advanced.js': 188, 'smc.js': 188, 'mainforce.js': 188, 'mtf.js': 188, 'bingfa.js': 194, 'layout.js': 188, 'journal.js': 188, 'scan.js': 188, 'intel.js': 189, 'app.js': 188
};

/* 證據等級登記（文件；各規則直接寫在使用它的地方）
     A 高波動禁止放空          24檔19年：放空每筆 −1.42%（t −6.6）；做多 −0.40% 不比平常差，只提醒減量
     A 量價事件（volEvent）     全市場2,123檔19年：盤整後爆量大漲隔日追進 20日 −0.78%（t −5.8）、爆量大跌隔日接 1~5日 −0.4%——提醒
     A 量價狀態（pvState）      全市場2,101檔19年1,260格掃描＋常見說法：發現／兩段確認、打亂對照0格、扣掉52週位置後 |t|≥3 三段同向的17種；扣掉中期合成後負面只剩 −0.33%（只提醒做多）、新高爆量 +1.54%（做多順風）
     A 追突破／盤中追跳空       全市場2,136檔19年：突破 −1.54%/筆（隨便進場 −0.87%）；跳空7~9.5%帶量 −1.79%——提醒
     A 中期因子（midFactors）   全市場2,125檔19年每月回測：52週高點、營收驚奇、營收成長、盈餘品質（v191）等權合成，最高減最低組3月超額 +4.7%（t 5.9，三段一致）——紀律門、橫幅
     A 風報比、此股中位可達停利  MFE實證；1:2／1:3 的10日達成率只有10.5%／3.9%
     B 行情溫度計、Amihud、智慧停損、圖形線位——只當風險提醒
     X 環境順逆勢、主力意圖方向、擁擠度、行為鏈、融資接刀——實測不顯著，只提醒
     U 外資台指期、選擇權PCR、情報面新聞與AI方向：未經回測——只顯示、不計分（月營收例外，見上）
   v188 刪除：專屬量化分數、機率／貝氏、多週期回測、樣本外驗證、STI/MFD/ECO/崩跌/FUSION、健康度、市場總分、多維共振。 */

/* 條件式期望值：backtest_conditional.js 實測（24檔 2006~2026，隔日開盤進場、同K先停損、跳空開盤成交、
   進出各1檔、手續費6折＋稅＋融券費；出場固定 1×ATR 停損／1.5×ATR 目標／≤10日）。值＝[每筆淨%, 筆數]。
   v188 盤勢改用標準 Wilder ADX 重跑（與畫面的市場狀態同一算法）。20 格無一通過 t≥3＋前後段＋除權息季＋過半股票為正。
   型態×盤勢樣本<30 的格子不列，查不到時退回該型態「全部」。更新方式：重跑腳本後覆寫本表。 */
const COND_EV = {
  base: { 1: { 全部: [-0.83, 23226], 多頭: [-0.80, 5126], 空頭: [-0.86, 3599], 盤整: [-0.88, 9044], 過渡: [-0.83, 4659], 高波動: [-0.40, 798] },
         '-1': { 全部: [-0.96, 23226], 多頭: [-0.96, 5126], 空頭: [-0.92, 3599], 盤整: [-0.91, 9044], 過渡: [-1.03, 4659], 高波動: [-1.42, 798] } },
  setups: {
    '突破20日高':   { dir: 1,  全部: [-0.99, 3721], 多頭: [-1.05, 1482], 盤整: [-0.87, 1473], 過渡: [-1.05, 741] },
    '多頭排列拉回': { dir: 1,  全部: [-0.80, 4187], 多頭: [-0.77, 1975], 空頭: [+0.02, 91], 盤整: [-0.90, 1292], 過渡: [-0.89, 715], 高波動: [-0.37, 114] },
    '空頭排列反彈': { dir: -1, 全部: [-0.96, 3606], 多頭: [-1.21, 66], 空頭: [-0.89, 1337], 盤整: [-0.95, 1346], 過渡: [-0.89, 677], 高波動: [-1.78, 180] },
    '跌破20日低':   { dir: -1, 全部: [-0.90, 3316], 空頭: [-0.81, 1088], 盤整: [-0.78, 1333], 過渡: [-1.06, 683], 高波動: [-1.81, 183] },
    '假突破回落':   { dir: -1, 全部: [-0.83, 1466], 多頭: [-0.66, 690], 盤整: [-0.85, 417], 過渡: [-1.17, 326] },
  },
};

/* ── 資料落後主動偵測（v118）───────────────────────────────────────────
   問題：畫面只顯示「資料日期07/14」，使用者得自己心算現在是幾號、
   該不該有更新的資料——容易被忽略，誤把舊資料當最新判斷。
   這裡直接算出「最近一個應該有資料的交易日」，逐一比對法人/融資/借券
   的實際資料日，超過門檻就主動標紅警示，不用使用者自己算。
   時程依據：T86/MI_MARGN 約當日下午公布；SBL(借券)按慣例T+1公布。
   ──────────────────────────────────────────────────────────────── */
/* v180 使用者實測（2026/9/28 教師節，前一個交易日 9/24，9/25 中秋）：這裡只會跳過週末、不認得國定假日，
   連假時法人、融資、估值卡會誤報「資料落後約4個交易日，請暫緩採信」。
   後端抓法人（T86）時，TWSE 對休市日明確回「沒有資料」，據此算出的 chip.expected 已扣除國定假日。
   有這個提示就用它——只在「同一個推算基準日」內有效（過了16:00 或隔天就重新推算），
   而且抓取失敗的日子後端不會當成休市，所以不會把真正的落後掩蓋掉。 */
let _twHint = null;   // { base: 當時依週末推算的日期, exp: 後端扣除國定假日後的日期 }
function setTwExpected(exp, at) { if (/^\d{8}$/.test(String(exp || ''))) _twHint = { base: weekdayTradeDate(0, at), exp: String(exp) }; }   // at＝資料實際抓取時刻（快取資料要用當時的推算基準，不是現在）
function expectedTradeDate(lagDays) {
  const ymd = weekdayTradeDate(lagDays);
  return !lagDays && _twHint && _twHint.base === ymd && _twHint.exp < ymd ? _twHint.exp : ymd;
}
function weekdayTradeDate(lagDays, at) {   // 只跳週末的推算
  lagDays = lagDays || 0;
  /* v119修：原寫法 Date.now() + getTimezoneOffset()*60000 + 8h 是「重複校正」——
     Date.now() 本身已是 UTC 毫秒，再加 offset 等於多轉一次時區。
     在台北裝置(offset=-480)上會把台北16:00算成08:00，整整差8小時，
     導致「現在該不該有今天的資料」判斷全錯（誤報落後或漏報落後）。
     容器測試是UTC(offset=0)所以測不出來，只在實機發作。
     正確：UTC毫秒 + 8小時 = 台北時間，與 worker.js 的 _tpeDateStr 寫法一致。 */
  const d = new Date((at || Date.now()) + 8 * 3600000);
  const hour = d.getUTCHours();
  // 台股約15:30~16:00後T86/MI_MARGN才公布完整，之前只能拿到前一交易日
  let back = (hour < 16) ? 1 : 0;
  back += lagDays;
  let day = new Date(d.getTime() - back * 86400000);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day = new Date(day.getTime() - 86400000);
  const y = day.getUTCFullYear(), m = String(day.getUTCMonth() + 1).padStart(2, '0'), dd = String(day.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}
/* v184 盤中已去掉今天未完成的K棒（trimIntradayBar），序列最後一根是「昨天」。拿最後一根的量或K棒配漲跌時，
   價格也要用同一根——現價配昨天的量＝把兩天拼在一起（量增價漲可能是昨天爆量下跌＋今天盤中上漲）。
   收盤後 barPx＝現價、barPrev＝昨收，行為不變 */
const barPx = D => D._intraday ? D.closes[D.closes.length - 1] : D.price;
const barPrev = D => D._intraday ? D.closes[D.closes.length - 2] : D.prevClose;

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

/* ── v186 資料暫存的有效期：看資料本身的日期，不看「抓了多久」──────────────
   資料已經是最新那一天的 → 留到它「可能變新」的那一刻（開盤、16:00 盤後資料、FinMind 21:00）；
   該有新的卻還沒有（還沒公布、抓取不完整、國定假日）→ 30 分鐘後再試；盤中股價照舊 5 分鐘。
   時刻用交易所當地時間算（美股用美東時區，夏令時間由瀏覽器處理），不靠裝置時區。
   ⚠️ 只認得週末，不認得國定假日：假日時會每 30 分鐘多抓一次、拿到一樣的資料——只多花流量，不會錯 */
const CACHE_RETRY = 1800000;
const TZ_TW = 'Asia/Taipei', TZ_US = 'America/New_York';
function zoneParts(t, tz) {   // → { y, mo, d, wd(0=日), min（當地當日分鐘）, ymd }
  const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(new Date(t)).forEach(x => { p[x.type] = x.value; });
  return { y: +p.year, mo: +p.month, d: +p.day, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), min: +p.hour * 60 + +p.minute, ymd: p.year + p.month + p.day };
}
function zoneWallToUtc(y, mo, d, min, tz) {   // 當地時間 → UTC 毫秒（兩次校正，夏令時間切換日也對）
  const g = Date.UTC(y, mo - 1, d, 0, min), off = t => { const p = zoneParts(t, tz); return Date.UTC(p.y, p.mo - 1, p.d, 0, p.min) - Math.floor(t / 60000) * 60000; };
  const u = g - off(g); return g - off(u) === u ? u : g - off(u);
}
function nextWeekdayAt(t, tz, min) {   // t 之後第一個「週一～五的當地 min 分」
  const p = zoneParts(t, tz);
  for (let k = 0; k < 8; k++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + k)), wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const u = zoneWallToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), min, tz);
    if (u > t) return u;
  }
}
function lastWeekdayFrom(t, tz, min) {   // 「當地 min 分之後才算這一天」的最近一個週一～五（YYYYMMDD）
  const p = zoneParts(t, tz);
  for (let k = p.min >= min ? 0 : 1; k < 8; k++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d - k)), wd = day.getUTCDay();
    if (wd !== 0 && wd !== 6) return day.toISOString().slice(0, 10).replace(/-/g, '');
  }
}
const inSession = (t, tz, open, close) => { const p = zoneParts(t, tz); return p.wd >= 1 && p.wd <= 5 && p.min >= open && p.min < close; };
// 台股 09:00～14:00（與 trimIntradayBar 同一段）；美股 09:30～16:30（收盤後半小時內報價仍可能修正）
const SESS = { tw: [TZ_TW, 540, 840], us: [TZ_US, 570, 990] };
function cacheUntil(kind, d, t, us) {
  const retry = t + CACHE_RETRY, [tz, open, close] = SESS[us ? 'us' : 'tw'];
  const ymd = x => String(x || '').replace(/-/g, '');
  if (kind === 'intel') return t + 3600000;   // 新聞一天內也會變：1 小時（卡片有「重新抓取」）
  if (kind === 'market') {   // 大盤含台美兩地即時報價：任一邊在盤中就 5 分鐘
    if (inSession(t, ...SESS.tw) || inSession(t, ...SESS.us)) return t + CACHE_TTL;
    return Math.min(retry, nextWeekdayAt(t, TZ_TW, SESS.tw[1]), nextWeekdayAt(t, TZ_US, SESS.us[1]));
  }
  if (kind === 'px') {   // 股價（個股、大盤基準）；台股個股另含法人
    if (inSession(t, tz, open, close)) return t + CACHE_TTL;
    if (ymd(d.lastDate) < lastWeekdayFrom(t, tz, close)) return retry;   // 收盤後該有今天的K棒卻還沒有
    const u = nextWeekdayAt(t, tz, open);
    if (us || !d.chip) return u;
    /* 法人用週曆判斷「今天的該不該有了」：T86 尚未公布時證交所回「沒有資料」，後端把它當休市、expected 退回昨天，
       chipUsable 會說「完整」——若信它，16:00 後查到的昨天法人會一路留到隔天開盤 */
    if (typeof chipUsable === 'function' && !chipUsable(d.chip) || ymd(d.chip.dataDate) < lastWeekdayFrom(t, TZ_TW, 960)) return retry;
    return Math.min(u, nextWeekdayAt(t, TZ_TW, 960));   // 16:00 起當天法人可能出來
  }
  if (kind === 'post') {   // 台股盤後資料（融資、估值）：d = { date, ok }
    if (!d.ok || ymd(d.date) < lastWeekdayFrom(t, TZ_TW, 960)) return retry;
    return nextWeekdayAt(t, TZ_TW, 960);
  }
  if (kind === 'finmind') {   // FinMind 籌碼：官方標示 20:00～21:00 更新；d = { date, ok }
    if (!d.ok || (d.date && ymd(d.date) < lastWeekdayFrom(t, TZ_TW, 1260))) return retry;
    return nextWeekdayAt(t, TZ_TW, 1260);
  }
  return t + CACHE_TTL;
}

/* ── 前端超時保護（v96）──────────────────────────────────────────────
   v96修「查詢突然變很慢（原10秒→數分鐘）」：全系統原本零超時保護，
   任一資料來源慢或掛住，前端就無限轉圈等待。
   ★ 定義在 config.js（index.html 最早載入）供所有前端模組共用——
     若定義在 app.js（最後載入），market.js 等先載入的模組會找不到
   ★ 所有 await fetch(...) 一律改用 fetchT(...)，勿裸用 fetch
   ──────────────────────────────────────────────────────────────── */
/* v159：20→45 秒。後端的籌碼／融資抓取原本被 12 秒、10 秒的預算切掉尾巴，
   導致「20日累計」其實只用了幾天的資料卻照樣標 20 日——時間上限變成靜默的錯答案。
   後端預算已放寬（籌碼30秒、融資20秒），前端上限必須跟著放寬，否則改了也沒用。
   寧可多等幾秒，也不要拿不完整的資料冒充完整結果。 */
const FE_TIMEOUT = 45000;
async function fetchT(url, opts = {}, ms = FE_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // v99：cache:'no-store' 強制繞過瀏覽器HTTP快取。後端回應若無 no-store 標頭，
    // 手機瀏覽器會以「完整網址」為key擅自快取GET回應，重新整理也殺不死——
    // 曾導致法人資料頑固不更新，換FinMind token（網址變了）才被迫抓新，即此雷
    return await fetch(url, { cache: 'no-store', ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`後端回應超時（${Math.round(ms / 1000)}秒）——可能是某個資料來源異常，請稍後再試`);   // v176：原本寫死「20秒」，實際上限是 45／60 秒
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
