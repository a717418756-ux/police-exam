/* ══════════════════════════════════════════════════════════════════════
   db.js — 本地 IndexedDB 儲存 + GAS 雲端雙向同步
   依賴：config.js（APP_VERSION）
   schema 改變時，DB_VERSION 會跟著 APP_VERSION 自動升（無需手改）
   ──────────────────────────────────────────────────────────────────
   函式清單：
     openDB                    — 開啟/建立IndexedDB連線
     dbSetSetting/dbGetSetting  — 設定值存取
     dbAddTrade/dbDeleteTrade/dbGetAllTrades — 交易日誌CRUD
     computeStats                — 基礎統計（勝率/期望值，供凱利公式）
     computeAdvancedStats        — 進階統計（Wilson信賴區間/處分效應等）
     exportBackup/importBackup    — 全量備份匯出入（跨裝置搬家用）
   ⚠️ 已知地雷／注意事項：
     - computeStats只用真實單（trade.sim=false）算勝率，模擬單刻意排除，
       避免污染凱利公式回填的真實勝率——這是「AI協作交接提示詞.md」裡
       明訂的資料流鐵律，勿改成把模擬單也納入統計
     - DB_VERSION隨APP_VERSION自動升級會觸發IndexedDB的onupgradeneeded，
       若新增object store或索引，須在openDB內對應版本號區塊寫遷移邏輯，
       否則舊資料庫的使用者升級後可能讀不到新欄位
   ══════════════════════════════════════════════════════════════════════ */
/* v163 檔案版本宣告：讓前端能查出「站上哪個檔案沒更新到」。
   改這個檔時一併把數字改成當版；config.js 的 FILE_VERS 必須同步（自我檢查會擋）。 */
try { (window.SR_FV = window.SR_FV || {})['db.js'] = 183; } catch (e) {}

const DB_NAME = 'stockRadarDB';
// DB schema 版本獨立管理（schema 沒變就不用動；這裡固定 1）
const DB_SCHEMA_VERSION = 1;
let _db = null;

/* ── 開啟資料庫 ──────────────────────────────────────────────────────── */
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_SCHEMA_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('trades'))   db.createObjectStore('trades',   { keyPath: 'id' });
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

/* ── settings（鍵值對：capital/risk/winrate/gasUrl/errorLog）─────────── */
async function dbSetSetting(key, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}
async function dbGetSetting(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('settings', 'readonly').objectStore('settings').get(key);
    r.onsuccess = () => res(r.result ? r.result.value : null);
    r.onerror = () => rej(r.error);
  });
}

/* ── trades（交易紀錄）────────────────────────────────────────────────
   trade = {id,date,code,direction:'long'|'short',result:'win'|'loss',pnl:number,note}
   ──────────────────────────────────────────────────────────────────── */
async function dbAddTrade(trade) {
  const db = await openDB();
  if (!trade.id) trade.id = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  return new Promise((res, rej) => {
    const tx = db.transaction('trades', 'readwrite');
    tx.objectStore('trades').put(trade);
    tx.oncomplete = () => res(trade);
    tx.onerror = () => rej(tx.error);
  });
}
/* v177 刪除留「墓碑」：雲端載入是合併（put），不留記錄的話，雲端或另一台裝置上的舊副本
   會把刪掉的交易救回來，重新算進勝率與 6% 風險預算。墓碑隨備份上傳，載入時與本機聯集。
   v183 墓碑帶刪除時間 {id, t}：從備份檔還原的交易帶 restoredAt，「還原比刪除晚」就保留——
   原本還原後一按雲端儲存，雲端的舊墓碑又把它刪掉（誤刪救不回）。舊格式（純 id）視為 t=0。 */
async function dbDeleteTrade(id) {
  await mergeTombstones([{ id, t: Date.now() }]);
  return dbRemoveTrade(id);
}
async function dbRemoveTrade(id) {   // 只刪資料、不留墓碑（套用別處墓碑時用，避免把刪除時間改成現在）
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('trades', 'readwrite');
    tx.objectStore('trades').delete(id);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}
async function dbGetAllTrades() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('trades', 'readonly').objectStore('trades').getAll();
    r.onsuccess = () => res((r.result || []).sort((a, b) => (a.date < b.date ? 1 : -1)));
    r.onerror = () => rej(r.error);
  });
}

/* ── 由交易紀錄計算真實統計 ──────────────────────────────────────────── */
function computeStats(trades) {
  if (!trades.length) return { count:0,wins:0,losses:0,winRate:0,avgWin:0,avgLoss:0,payoff:0,expectancy:0,totalPnl:0,trueWinRate:0,trueWins:0,misjudged:0,ci95:null, expTest:{ n:0, enough:false } };

  // Wilson score 信賴區間：樣本越少，區間越寬（誠實揭露「這個勝率有多可信」）
  function wilsonCI(wins, n) {
    if (!n) return null;
    const z = 1.96, p = wins / n;
    const denom = 1 + z * z / n;
    const center = p + z * z / (2 * n);
    const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return { low: Math.max(0, (center - margin) / denom), high: Math.min(1, (center + margin) / denom) };
  }
  /* ── 期望值顯著性檢定（v135）────────────────────────────────────────
     Wilson區間檢驗的是「勝率」，但決定賺不賺錢的是「每筆平均損益」。
     高勝率可以是負期望值（實測：目標0.5%/停損5%→勝率81%但每筆-0.945%）。
     這裡用單樣本 t 檢定：t = 平均 ÷ (標準差/√N)，|t|>1.96 才算統計顯著。
     ★ 本系統自身的回測實證：最佳參數組合每筆+0.0198%，但 t=0.098、
       95%CI=[-0.375%,+0.414%] 橫跨零——需60,823筆(約507年)才能證明非零。
       這說明短線的邊際優勢極易被雜訊淹沒，任何「看起來有效」都必須過此關。
     ★ 用途：當你累積實單後，這裡會誠實告訴你「目前的成績能不能證明
       你有優勢，還是只是運氣」——避免用20筆的好運說服自己去加大部位。
     ──────────────────────────────────────────────────────────────── */
  function expectancyTest(list) {
    const arr = list.map(t => Number(t.pnlPct != null ? t.pnlPct : (t.pnl || 0))).filter(x => isFinite(x));
    const n = arr.length;
    if (n < 5) return { n, enough: false };
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(arr.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
    if (!(sd > 0)) return { n, enough: false };
    const se = sd / Math.sqrt(n), t = mean / se;
    const needN = Math.abs(mean) > 0 ? Math.ceil((1.96 * sd / Math.abs(mean)) ** 2) : null;
    return { n, enough: true, mean, sd, se, t,
      ciLow: mean - 1.96 * se, ciHigh: mean + 1.96 * se,
      significant: Math.abs(t) > 1.96, needN };
  }
  const expTest = expectancyTest(trades);

  const wins   = trades.filter(t => t.result === 'win');
  const losses = trades.filter(t => t.result === 'loss');
  /* v183：金額只算「有填股數」的單（沒股數的舊單存的是盈虧%×100，不是金額）；盈虧比改用 %（不受有沒有填股數影響） */
  const amtOf = t => pnlAmt(t);
  const amt = trades.filter(t => amtOf(t) != null), amtW = amt.filter(t => t.result === 'win'), amtL = amt.filter(t => t.result === 'loss');
  const avgWin  = amtW.length ? amtW.reduce((a, t) => a + Math.abs(amtOf(t)), 0) / amtW.length : 0;
  const avgLoss = amtL.length ? amtL.reduce((a, t) => a + Math.abs(amtOf(t)), 0) / amtL.length : 0;
  const winRate = trades.length ? wins.length / trades.length : 0;        // 帳面勝率
  const pctW = wins.filter(t => t.pnlPct != null), pctL = losses.filter(t => t.pnlPct != null);
  const avgWinPct = pctW.length ? pctW.reduce((a, t) => a + Math.abs(t.pnlPct), 0) / pctW.length : 0;
  const avgLossPct = pctL.length ? pctL.reduce((a, t) => a + Math.abs(t.pnlPct), 0) / pctL.length : 0;
  const payoff  = avgLossPct > 0 ? avgWinPct / avgLossPct : 0;
  const amtWR = amt.length ? amtW.length / amt.length : 0;
  const expectancy = amtWR * avgWin - (1 - amtWR) * avgLoss;

  // ── 真實勝率：扣掉「判斷錯誤」的假贏單（凹單僥倖回本）──
  // 判斷正確且賺錢 = 真贏；判斷錯誤即使帳面賺 = 不算真贏
  const trueWins = trades.filter(t => t.result === 'win' && t.judgment !== 'wrong').length;
  const trueWinRate = trades.length ? trueWins / trades.length : 0;
  const misjudged = trades.filter(t => t.judgment === 'wrong').length; // 判斷錯誤總數（含假贏單）

  // ── 成本後真相（散戶「回測賺實單賠」第一死因：忘了成本）──
  const cost = (typeof TRADE_COST_PCT !== 'undefined') ? TRADE_COST_PCT : 0.585;
  const pcts = trades.filter(t => t.pnlPct != null);
  const avgPnlPct = pcts.length ? pcts.reduce((a, t) => a + t.pnlPct, 0) / pcts.length : 0;
  const netAvgPnlPct = avgPnlPct - cost;
  const netWins = pcts.filter(t => t.pnlPct > cost).length;
  const netWinRate = pcts.length ? netWins / pcts.length : 0;

  const ci95 = wilsonCI(wins.length, trades.length);
  const trueCi95 = wilsonCI(trueWins, trades.length);

  return { count: trades.length, wins: wins.length, losses: losses.length, winRate, avgWin, avgLoss, payoff, expectancy,
    totalPnl: amt.reduce((a, t) => a + amtOf(t), 0), amtN: amt.length, noAmt: trades.length - amt.length,
    trueWinRate, trueWins, misjudged,
    avgPnlPct, netAvgPnlPct, netWinRate, costPct: cost,
    ci95, trueCi95, expTest };
}

/* ── 進階統計（給 Markdown 匯出用）──────────────────────────────────── */
function computeAdvancedStats(trades) {
  const base = computeStats(trades);
  if (!trades.length) return Object.assign(base, { maxWinStreak:0, maxLossStreak:0, avgHoldDays:0, maxDrawdown:0, byDirection:{}, byCode:{} });

  // 依出場日排序（舊→新）算連勝連敗
  const sorted = [...trades].sort((a,b) => (a.exitDate||a.date) < (b.exitDate||b.date) ? -1 : 1);
  let maxWin=0, maxLoss=0, curWin=0, curLoss=0;
  let cumPnl=0, peak=0, maxDD=0;
  let holdSum=0, holdCount=0;
  for (const t of sorted) {
    if (t.result==='win') { curWin++; curLoss=0; } else { curLoss++; curWin=0; }
    maxWin=Math.max(maxWin,curWin); maxLoss=Math.max(maxLoss,curLoss);
    cumPnl += pnlAmt(t) || 0;   // 金額未知的單不計入金額回撤
    peak = Math.max(peak, cumPnl);
    maxDD = Math.min(maxDD, cumPnl-peak); // 最大回撤（負值）
    if (t.holdDays!=null) { holdSum+=t.holdDays; holdCount++; }
  }

  // 依方向統計
  const byDir = {};
  for (const dir of ['long','short']) {
    const arr = trades.filter(t=>t.direction===dir);
    if (arr.length) byDir[dir] = computeStats(arr);
  }
  // 依代碼統計
  const byCode = {};
  for (const t of trades) {
    const k = t.code || '未填';
    if (!byCode[k]) byCode[k] = [];
    byCode[k].push(t);
  }
  const byCodeStats = {};
  for (const k in byCode) byCodeStats[k] = computeStats(byCode[k]);

  return Object.assign(base, {
    maxWinStreak: maxWin, maxLossStreak: maxLoss,
    avgHoldDays: holdCount ? holdSum/holdCount : 0,
    maxDrawdown: maxDD,
    byDirection: byDir, byCode: byCodeStats
  });
}
/* v146：備份原本只含資金/風險%/勝率，換機或清資料後還要自己重填查詢網址、
   備份網址、FinMind token。現改為一併收錄：
     • 兩個網址：本地匯出與雲端備份都帶（換裝置直接可用）
     • FinMind token：只有「本地匯出的檔案」才帶（includeSecrets=true），
       雲端備份不帶——金鑰不該自動上傳到雲端備份，且雲端還原時本來就在原機。 */
async function exportBackup(includeSecrets) {
  const trades = await dbGetAllTrades();
  const settings = {
    capital:  await dbGetSetting('capital'),
    risk:     await dbGetSetting('risk'),
    winrate:  await dbGetSetting('winrate'),
    gasUrl:   await dbGetSetting('gasUrl'),
    syncUrl:  await dbGetSetting('syncUrl'),
  };
  if (includeSecrets) settings.finmindToken = await dbGetSetting('finmindToken');
  return {
    app: 'StockRadarPro',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    note: includeSecrets ? '本檔含後端網址與 FinMind token，請勿外流或上傳到公開空間' : '本檔含後端網址，不含 FinMind token',
    trades,
    settings,
    deletedIds: (await dbGetSetting('deletedIds')) || []
  };
}

/* 墓碑聯集（同一筆取最晚的刪除時間）→ Map(id → t) */
async function mergeTombstones(list) {
  const m = new Map();
  for (const x of [...((await dbGetSetting('deletedIds')) || []), ...(Array.isArray(list) ? list : [])]) {
    const tb = typeof x === 'string' ? { id: x, t: 0 } : x;
    if (tb && tb.id != null && !(m.has(tb.id) && m.get(tb.id) >= (tb.t || 0))) m.set(tb.id, tb.t || 0);
  }
  await dbSetSetting('deletedIds', [...m].map(([id, t]) => ({ id, t })));
  return m;
}
const tombstoned = (gone, t) => gone.has(t.id) && !((t.restoredAt || 0) > gone.get(t.id));   // 刪除比還原晚＝該刪
/* 套用墓碑：聯集後刪掉本機仍留著、而且沒有在刪除之後被還原的交易 */
async function applyTombstones(list) {
  const gone = await mergeTombstones(list);
  for (const t of await dbGetAllTrades()) if (tombstoned(gone, t)) await dbRemoveTrade(t.id);   // 別台裝置刪掉的，這台也刪
  return gone;
}
/* 合併交易：沒被刪的加進來；同一筆兩邊都有時，保留「還原時間較晚」的那份（帶著 restoredAt 才不會被舊墓碑再刪掉） */
async function mergeTrades(trades, gone) {
  const local = new Map((await dbGetAllTrades()).map(t => [t.id, t]));
  let n = 0;
  for (const t of trades) {
    if (tombstoned(gone, t)) continue;
    const l = local.get(t.id);
    if (l && (l.restoredAt || 0) >= (t.restoredAt || 0)) continue;
    await dbAddTrade(t); n++;
  }
  return n;
}
/* restore＝使用者自己挑的備份檔：檔案裡的交易就是要救回來的，即使之前刪過（否則誤刪後永遠救不回）。
   雲端載入不是 restore：墓碑優先，別台刪掉的不會被舊副本救回。 */
async function importBackup(obj, restore) {
  if (!obj || obj.app !== 'StockRadarPro') throw new Error('檔案格式不符，非本程式備份檔');
  if (obj.settings) {
    if (obj.settings.capital != null) await dbSetSetting('capital', obj.settings.capital);
    if (obj.settings.risk    != null) await dbSetSetting('risk',    obj.settings.risk);
    if (obj.settings.winrate != null) await dbSetSetting('winrate', obj.settings.winrate);
    /* v146：還原網址與 token，並同步更新記憶體中的全域變數，免得還原完還要重新載入 */
    if (obj.settings.gasUrl) { await dbSetSetting('gasUrl', obj.settings.gasUrl); try { GAS_URL = obj.settings.gasUrl; } catch (e) {} }
    if (obj.settings.syncUrl) { await dbSetSetting('syncUrl', obj.settings.syncUrl); try { SYNC_URL = obj.settings.syncUrl; } catch (e) {} }
    if (obj.settings.finmindToken) { await dbSetSetting('finmindToken', obj.settings.finmindToken); try { FINMIND_TOKEN = obj.settings.finmindToken; } catch (e) {} }
  }
  const trades = Array.isArray(obj.trades) ? obj.trades : [];
  const now = Date.now();
  const gone = await applyTombstones(restore ? [] : obj.deletedIds);
  return mergeTrades(restore ? trades.map(t => ({ ...t, restoredAt: now })) : trades, gone);   // 還原＝這些交易的還原時間是現在
}

/* ══════════════════════════════════════════════════════════════════════
   GAS 雲端雙向同步（URL 由設定頁填入，存於 IndexedDB）
   後端端點：?action=sync_get（GET）/ ?action=sync_save（POST）
   ══════════════════════════════════════════════════════════════════════ */
async function cloudSave() {
  const backupUrl = (typeof SYNC_URL !== 'undefined' && SYNC_URL) ? SYNC_URL : GAS_URL;
  if (!backupUrl || backupUrl.indexOf('http') !== 0) throw new Error('尚未設定備份網址（請填查詢網址或雲端備份網址）');
  /* v181 先讀雲端現有的刪除墓碑併進本機再存：否則一台沒載入過的舊裝置一存，雲端的墓碑就被整份覆蓋掉，
     別台刪掉的交易又回到雲端、之後新裝置載入就會救回來（重新算進勝率與 6% 預算） */
  const cur = await (await fetchT(`${backupUrl}?action=sync_get`)).json();
  if (!cur.ok) throw new Error('讀不到雲端現況，未儲存（避免蓋掉其他裝置的紀錄）：' + (cur.error || ''));
  /* v183：也要先把雲端「別台新增的交易」併進本機——原本只併墓碑，交易清單整份覆蓋，
     B 機新增並上傳的交易，A 機（沒載入過）一存就從雲端消失 */
  const gone = await applyTombstones(cur.data && cur.data.deletedIds);
  await mergeTrades(Array.isArray(cur.data && cur.data.trades) ? cur.data.trades : [], gone);
  const backup = await exportBackup();   // 完整備份內容（含 trades + settings + 版本 + 時間）
  const r = await fetchT(`${backupUrl}?action=sync_save`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 避免 CORS preflight
    body: JSON.stringify(backup)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '雲端儲存失敗');
  return j;
}

async function cloudLoad() {
  const backupUrl = (typeof SYNC_URL !== 'undefined' && SYNC_URL) ? SYNC_URL : GAS_URL;
  if (!backupUrl || backupUrl.indexOf('http') !== 0) throw new Error('尚未設定備份網址');
  const r = await fetchT(`${backupUrl}?action=sync_get`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '雲端讀取失敗');
  const data = j.data || {}, trades = Array.isArray(data.trades) ? data.trades : [];
  /* v177：沒有備份時 Worker 回 {}、GAS 回 {trades:[],settings:{}}，原本都顯示「✅ 已從雲端載入」——
     「雲端是空的」不可偽裝成「載入成功」 */
  if (!trades.length && !(data.deletedIds || []).length && !Object.values(data.settings || {}).some(v => v != null)) throw new Error('雲端沒有備份資料——請先在有資料的裝置按「雲端儲存」');
  return importBackup(data.app === 'StockRadarPro' ? data : { app: 'StockRadarPro', trades, settings: data.settings || {} });   // 後者＝相容舊格式
}


/* ══ 倉位管理兩條鐵律（v107）══════════════════════════════════════════
   Alexander Elder《Come Into My Trading Room》兩條鐵律，機構風控的個人版：
   ① 2%原則（防鯊魚咬）：單筆交易最大風險≤總資金2%——一次重傷不致命
   ② 6%原則（防食人魚）：當月已實現虧損達總資金6%即停止開新倉到月底
      ——連續小虧比單次大虧更常滅絕帳戶，這是強制冷靜的斷路器
   本函式只統計「真實單」（sim=false），模擬單不佔用風險預算。
   ⚠️ 只讀不寫：不自動改任何參數，只回報狀態供紀律門判斷（人決策原則）
   ════════════════════════════════════════════════════════════════════ */
/* v183 交易金額：有填股數才有金額。舊版沒股數時存的是「盈虧%×100」冒充金額，一律當成未知 */
function pnlAmt(t) { return t && t.shares != null && t.pnl != null ? t.pnl : null; }
function computeRiskBudget(trades, capital) {
  try {
    if (!capital || capital <= 0) return null;
    const now = new Date(Date.now() + 8 * 3600e3);   // v183：台北月份
    const ym = now.getUTCFullYear() + '-' + String(now.getUTCMonth() + 1).padStart(2, '0');
    const real = (trades || []).filter(t => !t.sim && t.date && String(t.date).slice(0, 7) === ym);
    const known = real.filter(t => pnlAmt(t) != null);
    const lossSum = known.filter(t => t.pnl < 0).reduce((a, t) => a + Math.abs(t.pnl), 0);
    const winSum = known.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const netPnl = winSum - lossSum;
    // 6%原則採「淨虧損」計算（獲利可回補預算，符合Elder原意：保護的是帳戶淨值）
    const usedPct = netPnl < 0 ? Math.abs(netPnl) / capital * 100 : 0;
    return {
      ym, trades: real.length, noAmt: real.length - known.length, lossSum, winSum, netPnl,
      usedPct: Math.round(usedPct * 100) / 100,
      remainPct: Math.round(Math.max(0, 6 - usedPct) * 100) / 100,
      blocked: usedPct >= 6,
      warn: usedPct >= 4 && usedPct < 6,
    };
  } catch (e) { return null; }
}
