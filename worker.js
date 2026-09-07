/* ══════════════════════════════════════════════════════════════════════
   worker.js — 短線雷達後端（Cloudflare Workers 版）
   取代 Google Apps Script，速度快 3-5 倍
   ──────────────────────────────────────────────────────────────────
   部署方式見檔末註解。前端只需把 GAS_URL 換成 Workers 網址即可。
   功能與 Code.gs 完全相同：
   - 個股查詢（台股 Yahoo 優先 + 籌碼 T86）/ 美股
   - 大盤環境 / 大盤基準 / 區間K線(MAE-MFE) / 進場日公式分數
   - 雲端同步（用 Workers KV，需綁定 KV namespace 名為 SYNC）
   ──────────────────────────────────────────────────────────────────
   ⚠️ 極重要：本檔與 Code.gs 必須維持「端點對等」——每個 action 分支的
   輸入輸出格式須完全一致，因為前端不知道實際連的是哪個後端。任何一邊
   改動(新增欄位/改參數)都必須同步另一邊，並用以下指令驗證端點清單一致：
     diff <(grep -o "action === '[a-z_]*'" Code.gs | sort) \
          <(grep -o "action === '[a-z_]*'" worker.js | sort)
   ──────────────────────────────────────────────────────────────────
   近期版本異動：
     v77  deep action新增 dayTrading(當沖比重) + dealer(自營自行/避險細分)
     v83  market action新增 fetchSectorBreadth()（TWSE MI_INDEX類股廣度，
          本端點無個股家數，用37類股指數漲跌計數為代理）
   ══════════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',   // v99：明示禁止瀏覽器/CDN快取查詢回應（防資料頑固不更新）
};

/* ── 超時保護（v96）────────────────────────────────────────────────────
   v96修「查詢突然變很慢（原10秒→數分鐘）」：原本所有外部請求都沒有超時，
   任一端點（TWSE/期交所/Yahoo/FinMind）回應慢或掛住，Promise.all 就會
   無限等待，整個查詢卡死。.catch() 只擋錯誤，擋不了「慢」。
   ★ 所有外部 fetch 一律走 fetchT()，勿直接用 fetch()
   ──────────────────────────────────────────────────────────────────── */
const FETCH_TIMEOUT = 8000;   // 單一外部來源最長等 8 秒，超時即視為該來源不可用
async function fetchT(url, opts = {}, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { cache: 'no-store', ...opts, signal: ctrl.signal });   // v99：對外抓取繞過邊緣快取
  } finally {
    clearTimeout(timer);
  }
}

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; StockRadar/1.0)' };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const p = url.searchParams;
    const action = p.get('action') || '';
    const code = (p.get('code') || '').trim().toUpperCase();

    const json = (obj) => new Response(JSON.stringify(obj), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    });

    try {
      // 雲端同步（POST 儲存完整備份 / GET 讀取）
      // 前端送的是完整 backup 物件（含 trades+settings），整包存取
      if (action === 'sync_save' && request.method === 'POST') {
        const backup = await request.json();   // 完整 backup 物件
        const user = backup.user || 'default';
        if (env.SYNC) await env.SYNC.put('backup_' + user, JSON.stringify(backup));
        return json({ ok: true });
      }
      if (action === 'sync_get') {
        let data = {};
        if (env.SYNC) {
          const v = await env.SYNC.get('backup_' + (p.get('user') || 'default'));
          if (v) data = JSON.parse(v);
        }
        return json({ ok: true, data });   // data = 完整 backup 物件
      }

      // 主力縱深（FinMind：千張大戶/借券空單/分點）
      if (action === 'deepchip') {
        const token = p.get('token') || '';
        if (!token) return json({ ok: false, error: 'no_token' });
        const r = await fetchDeepChip(code, token);
        return json({ ok: true, ...r });
      }

      // 基本面（估值+月營收，台股）
      if (action === 'fundamental') {
        const r = await fetchFundamental(code);
        return json({ ok: true, ...r });
      }

      // 融資融券（散戶心理+軋空）
      if (action === 'margin') {
        const r = await fetchMargin(code);
        return json({ ok: true, ...r });
      }

      // 進場日公式分數用：截至某日K線
      if (action === 'histuntil') {
        const r = await fetchHistUntil(code, p.get('until') || '');
        return json({ ok: true, ...r });
      }
      // 區間K線（MAE/MFE）
      if (action === 'range') {
        const r = await fetchRangeOHLC(code, p.get('from') || '', p.get('to') || '');
        return json({ ok: true, ...r });
      }
      // 大盤基準（RS/Beta）
      /* ── v110 批次掃描端點：一次抓多檔K線（不含籌碼，籌碼太重不適合掃描）──
         系統所有分析引擎都是純前端計算，只要拿到K線就能跑完整分析。
         因此掃描只需批次取K線，前端再逐檔跑引擎、依「風控與時機」條件排序。
         上限20檔/批（Cloudflare subrequest 限制），前端負責分批與進度。 */
      if (action === 'scan') {
        const codes = (p.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
        if (!codes.length) return json({ ok: false, error: '未提供代碼' });
        const out = await Promise.all(codes.map(async (code) => {
          try {
            const d = /^\d{4,6}$/.test(code) ? await fetchYahooTW(code) : await yahooChart(code, '2y', '1d');
            if (!d || !d.closes || d.closes.length < 60) return { code, ok: false };
            return { code, ok: true, closes: d.closes, highs: d.highs, lows: d.lows,
              volumes: d.volumes, opens: d.opens || null, price: d.closes[d.closes.length - 1],
              lastDate: d.lastDate || '' };
          } catch (e) { return { code, ok: false }; }
        }));
        return json({ ok: true, results: out });
      }
      if (action === 'benchmark') {
        const mkt = p.get('market') || 'tw';
        const sym = mkt === 'us' ? 'SPY' : '0050.TW';
        const d = await fetchYahoo(sym);
        return json({ ok: true, closes: d.closes });
      }
      // 大盤環境
      if (action === 'market') {
        const r = await fetchMarket();
        return json({ ok: true, ...r });
      }

      // 預設：個股查詢
      if (!code) return json({ ok: false, error: '缺少股票代碼' });
      let result;
      if (/^\d/.test(code)) result = await fetchTaiwan(code);
      else result = await fetchYahoo(code);
      result.ok = true;
      return json(result);

    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) });
    }
  },
};

/* ── 台股：Yahoo 一次抓K線 + T86 籌碼（平行，超快）── */
async function fetchTaiwan(stockNo) {
  // 平行抓 K 線與籌碼（GAS 是序列，這裡平行，更快）
  const [kline, chip] = await Promise.all([
    fetchYahooTW(stockNo),
    fetchTaiwanChip(stockNo).catch(() => null),
  ]);
  if (!kline) throw new Error('找不到 ' + stockNo + ' 的資料');
  kline.chip = chip;
  return kline;
}

/* ── Yahoo 台股（.TW 上市 → .TWO 上櫃）── */
async function fetchYahooTW(stockNo) {
  for (const suffix of ['.TW', '.TWO']) {
    const r = await yahooChart(stockNo + suffix, '2y', '1d');
    if (r && r.closes.length >= 60) { r.code = stockNo; r.currency = 'TWD'; return r; }
  }
  return null;
}

/* ── Yahoo 美股 ── */
async function fetchYahoo(symbol) {
  const r = await yahooChart(symbol, '2y', '1d');
  if (!r || r.closes.length < 10) throw new Error('找不到 ' + symbol + ' 的資料');
  r.code = symbol;
  r.currency = 'USD';
  return r;
}

/* ── Yahoo Chart API 共用 ── */
async function yahooChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includeAdjustedClose=true`;
  const resp = await fetchT(url, { headers: UA });
  if (!resp.ok) return null;
  const j = await resp.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.indicators || !res.indicators.quote) return null;
  const q = res.indicators.quote[0];
  const meta = res.meta || {};
  // 除權息還原：用 adjclose 因子等比還原整組 OHLC（消除除息假缺口）
  const adjArr = res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
  const closes = [], highs = [], lows = [], opens = [], vols = [];
  const rawCloses = [], rawHighs = [], rawLows = [];  // 未還原市價：供支撐壓力/BOS用（人類記憶的關卡是原始價，不是還原價）
  for (let i = 0; i < (q.close || []).length; i++) {
    const cl = q.close[i];
    if (cl == null) continue;
    let f = 1;
    if (adjArr && adjArr[i] != null && cl > 0) { const ff = adjArr[i] / cl; if (isFinite(ff) && ff > 0) f = ff; }
    closes.push(cl * f); highs.push(q.high[i] * f); lows.push(q.low[i] * f);
    opens.push(q.open[i] * f); vols.push(q.volume[i] || 0);
    rawCloses.push(cl); rawHighs.push(q.high[i]); rawLows.push(q.low[i]);
  }
  if (!closes.length) return null;
  const last = closes.length - 1;
  return {
    name: meta.shortName || meta.symbol || symbol,
    price: closes[last], open: opens[last], high: highs[last], low: lows[last],
    prevClose: closes[last - 1] || closes[last], volume: vols[last],
    avgVol5: vols.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, vols.length),
    closes, highs, lows, volumes: vols, opens,
    lastDate: (function(){ try { const t=res.timestamp[res.timestamp.length-1]; const d=new Date(t*1000); return d.toISOString().slice(0,10).replace(/-/g,''); } catch(e){ return ''; } })(),   // v100防呆：K線最後一根的日期
    rawCloses, rawHighs, rawLows,   // 未還原市價（支撐壓力/BOS/CHoCH 用這個，貼近真實心理關卡）
  };
}

/* ── 台股三大法人 T86（近18交易日，平行抓取超快）── */
function _tpeDateStr(offsetDays) {
  // v118修：原本用 new Date(now - d*86400000).toISOString() 取日期，
  // 該寫法用UTC切片，但TWSE日期是台北時間——台北00:00~07:59時，UTC還停在
  // 前一天，導致「今天」被誤判成「前一天」，抓取範圍系統性偏移一天。
  // 統一用台北時間計算日期字串，並回傳 weekday 供後續判斷。
  const now = Date.now() + 8 * 3600000;   // 轉換為台北時間戳
  const day = new Date(now - offsetDays * 86400000);
  const y = day.getUTCFullYear(), m = String(day.getUTCMonth() + 1).padStart(2, '0'), d2 = String(day.getUTCDate()).padStart(2, '0');
  return { ymd: `${y}${m}${d2}`, wd: day.getUTCDay() };
}
async function fetchTaiwanChip(stockNo) {
  const dates = [];
  for (let d = 25; d >= 0; d--) {
    const { ymd, wd } = _tpeDateStr(d);
    if (wd === 0 || wd === 6) continue;
    dates.push(ymd);
  }
  // 平行抓所有日期（GAS 要 sleep 序列，Workers 可平行 → 快 10 倍）
  const results = await Promise.all(dates.map(async (ymd) => {
    try {
      const url = `https://www.twse.com.tw/fund/T86?response=json&date=${ymd}&selectType=ALLBUT0999`;
      const resp = await fetchT(url, { headers: UA });
      if (!resp.ok) return null;
      const j = await resp.json();
      if (j.stat !== 'OK' || !j.data) return null;
      const F = j.fields || [];
      // 用「精確全名優先、寬鬆關鍵字備援」兩層比對（欄名含「不含外資自營商」字樣，
      // 舊版排除規則會誤刪自己要找的欄位，導致外資恆為0——這是本次修復的根本原因）
      const exact = (name) => F.indexOf(name);
      const norm = (s) => String(s).replace(/\s/g, '');
      const idxNorm = (name) => F.findIndex(x => norm(x) === norm(name));
      let iF = exact('外資及陸資買賣超股數');                        // 官方合計欄（含外資自營商），最穩定
      if (iF < 0) iF = idxNorm('外資及陸資買賣超股數');
      if (iF < 0) iF = exact('外資及陸資(不含外資自營商)買賣超股數');  // 次選：不含自營的子項
      if (iF < 0) iF = idxNorm('外資及陸資不含外資自營商買賣超股數');
      if (iF < 0) iF = F.findIndex(x => /外資|外陸資/.test(x) && /買賣超/.test(x) && /股數/.test(x));  // 最後寬鬆備援

      let iT = exact('投信買賣超股數');
      if (iT < 0) iT = F.findIndex(x => /投信/.test(x) && /買賣超/.test(x));

      let iD = exact('自營商買賣超股數');                             // 自營合計（自行+避險）
      if (iD < 0) iD = idxNorm('自營商買賣超股數');
      if (iD < 0) iD = F.findIndex(x => /自營商/.test(x) && /買賣超/.test(x) && !/自行|避險/.test(x));
      if (iD < 0) iD = F.findIndex(x => /自營商/.test(x) && /買賣超/.test(x));  // 退而求其次抓自行或避險其一
      for (const row of j.data) {
        if ((row[0] || '').trim() === stockNo) {
          return {
            ymd,
            foreign: (iF >= 0 ? num(row[iF]) : 0) / 1000,
            trust: (iT >= 0 ? num(row[iT]) : 0) / 1000,
            dealer: (iD >= 0 ? num(row[iD]) : 0) / 1000,
            _fieldMiss: iF < 0 || iT < 0 || iD < 0 ? { iF, iT, iD, fields: F } : null,  // 除錯用：配不到欄位時附上原始欄名清單
          };
        }
      }
    } catch (e) { /* skip */ }
    return null;
  }));

  const valid = results.filter(x => x).sort((a, b) => a.ymd < b.ymd ? -1 : 1);
  if (!valid.length) return null;

  const fSeries = valid.map(x => x.foreign);
  const tSeries = valid.map(x => x.trust);
  const dSeries = valid.map(x => x.dealer);
  const sumN = (arr, n) => arr.slice(-n).reduce((a, b) => a + b, 0);
  const streak = (arr) => { let s = 0; for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] > 0) s++; else break; } return s; };
  // 若最近一筆有欄位配對失敗，往上傳警訊（前端會提示，而非讓你誤判0=無買賣超）
  const lastMiss = valid[valid.length - 1]._fieldMiss || null;
  const dataDate = valid[valid.length - 1].ymd || '';   // v100：最新一筆T86的日期（防呆顯示用）

  return {
    dataDate,
    foreign1: fSeries[fSeries.length - 1] || 0, foreign5: sumN(fSeries, 5), foreign20: sumN(fSeries, 20),
    trust1: tSeries[tSeries.length - 1] || 0, trust5: sumN(tSeries, 5), trust20: sumN(tSeries, 20),
    dealer5: sumN(dSeries, 5),
    foreignStreak: streak(fSeries), trustStreak: streak(tSeries),
    fieldMiss: lastMiss,
  };
}

/* ── 大盤環境（完整：期交所 taifex + 美股隔夜）── */
async function fetchMarket() {
  const out = { tw: {}, us: {}, taifex: {} };

  // 平行抓所有來源（Workers 平行，比 GAS 序列快）
  const [twii, sox, nasdaq, sp500, vix, dxy, tnx, taifexFut, pcr, breadth] = await Promise.all([
    yahooQuote('^TWII'), yahooQuote('^SOX'), yahooQuote('^IXIC'),
    yahooQuote('^GSPC'), yahooQuote('^VIX'),
    yahooQuote('DX-Y.NYB'), yahooQuote('^TNX'),
    fetchTaifexFutures().catch(() => null),
    fetchTaifexPCR().catch(() => null),
    fetchSectorBreadth().catch(() => null),
  ]);

  out.tw.index = twii;
  out.us.sox = sox;
  out.us.nasdaq = nasdaq;
  out.us.sp500 = sp500;
  out.us.vix = vix;
  out.us.dxy = dxy;   // 美元指數（強美元=外資匯出台股壓力）
  out.us.tnx = tnx;   // 美債10年殖利率×10（升=資金離開風險資產）

  if (taifexFut) { out.taifex.foreignNet = taifexFut.foreignNet; out.taifex.institutionNet = taifexFut.institutionNet; out.taifex.date = taifexFut.date; }
  if (pcr) { out.taifex.pcrOI = pcr.pcrOI; out.taifex.pcrVol = pcr.pcrVol; out.taifex.pcrDate = pcr.pcrDate; }
  if (breadth) out.tw.breadth = breadth;

  return out;
}

/* ── TWSE 類股廣度：37個類股指數的漲跌計數（本端點(MI_INDEX)不含個股漲跌家數，已以真實樣本查證；
      類股廣度為可行代理，未來若找到含家數的端點可再擴充——
      「加權漲但類股普跌」＝權值股獨撐的假強。格式已以真實樣本驗證（2026-07）。── */
async function fetchSectorBreadth() {
  const resp = await fetchT('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX', { headers: UA });
  const arr = await resp.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  let up = 0, dn = 0, flat = 0;
  for (const r of arr) {
    const name = r['指數'] || '';
    if (name.indexOf('類指數') < 0 || name.indexOf('報酬') >= 0) continue;   // 只取類股、排除報酬指數重複計
    const c = r['漲跌'];
    if (c === '+') up++; else if (c === '-') dn++; else flat++;
  }
  const total = up + dn + flat;
  if (total < 15) return null;   // 格式異常保護
  return { up, dn, flat, total, date: arr[0]['日期'] || '' };
}

/* ── 期交所：三大法人台指期淨未平倉 ── */
async function fetchTaifexFutures() {
  const url = 'https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfAsSpecificFuturesContractByDate';
  const resp = await fetchT(url, { headers: UA });
  const arr = await resp.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  // 找台指期（TX）的外資與三大法人合計
  let foreignNet = 0, totalNet = 0, date = '';
  for (const row of arr) {
    const contract = row['ContractName'] || row['契約名稱'] || '';
    if (contract.indexOf('臺股期貨') >= 0 || contract.indexOf('台指期') >= 0 || contract === 'TX') {
      const identity = row['IdentityType'] || row['身份別'] || '';
      const net = num(row['OpenInterestNetAmount'] || row['多空未平倉口數淨額'] || 0);
      date = row['Date'] || row['日期'] || date;
      if (identity.indexOf('外資') >= 0) foreignNet = net;
      totalNet += net;
    }
  }
  return { foreignNet, institutionNet: totalNet, date };
}

/* ── 期交所：選擇權 PCR ── */
async function fetchTaifexPCR() {
  const url = 'https://openapi.taifex.com.tw/v1/PutCallRatio';
  const resp = await fetchT(url, { headers: UA });
  const arr = await resp.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const latest = arr[arr.length - 1];
  return {
    pcrOI: num(latest['PutCallRatioOfOpenInterest'] || latest['未平倉量比率%'] || latest['PutCallRatio'] || 0),
    pcrVol: num(latest['PutCallRatioOfVolume'] || latest['成交量比率%'] || 0),
    pcrDate: latest['Date'] || latest['日期'] || '',
  };
}

async function yahooQuote(symbol) {
  try {
    const r = await yahooChart(symbol, '5d', '1d');
    if (!r) return null;
    return { price: r.price, prevClose: r.prevClose, changePct: ((r.price - r.prevClose) / r.prevClose * 100) };
  } catch (e) { return null; }
}

/* ── 區間K線（MAE/MFE）── */
async function fetchRangeOHLC(code, from, to) {
  if (!code || !from || !to) throw new Error('缺少參數');
  const symbol = /^\d/.test(code) ? code + '.TW' : code;
  const p1 = Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(new Date(to + 'T23:59:59Z').getTime() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}&includeAdjustedClose=true`;
  const resp = await fetchT(url, { headers: UA });
  const j = await resp.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('找不到區間資料');
  const q = res.indicators.quote[0];
  const adjArr = res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
  const highs = [], lows = [], closes = [];   // 還原
  const rawHighs = [], rawLows = [];           // 未還原（原始市價，對比使用者輸入的進場價）
  let hasDiv = false;
  for (let i = 0; i < (q.close || []).length; i++) {
    const cl = q.close[i];
    if (cl == null) continue;
    let f = 1;
    if (adjArr && adjArr[i] != null && cl > 0) { const ff = adjArr[i] / cl; if (isFinite(ff) && ff > 0) f = ff; if (Math.abs(ff - 1) > 0.001) hasDiv = true; }
    closes.push(cl * f); highs.push(q.high[i] * f); lows.push(q.low[i] * f);
    rawHighs.push(q.high[i]); rawLows.push(q.low[i]);
  }
  if (!highs.length) throw new Error('區間內無交易資料');
  return {
    rangeHigh: Math.max(...rawHighs), rangeLow: Math.min(...rawLows),   // MAE/MFE 用原始價（對齊使用者輸入）
    rangeHighAdj: Math.max(...highs), rangeLowAdj: Math.min(...lows),   // 還原價（技術分析用）
    hasDividend: hasDiv, days: highs.length,
    firstClose: closes[0], lastClose: closes[closes.length - 1],
  };
}

/* ── 截至某日K線（進場日公式分數）── */
async function fetchHistUntil(code, until) {
  if (!code || !until) throw new Error('缺少參數');
  const symbol = /^\d/.test(code) ? code + '.TW' : code;
  const untilTime = Math.floor(new Date(until + 'T23:59:59Z').getTime() / 1000) + 86400;
  const fromTime = untilTime - 200 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${fromTime}&period2=${untilTime}&includeAdjustedClose=true`;
  const resp = await fetchT(url, { headers: UA });
  const j = await resp.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('找不到歷史資料');
  const q = res.indicators.quote[0];
  const adjArr = res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
  const closes = [], highs = [], lows = [], volumes = [];
  for (let i = 0; i < (q.close || []).length; i++) {
    const cl = q.close[i];
    if (cl == null) continue;
    let f = 1;
    if (adjArr && adjArr[i] != null && cl > 0) { const ff = adjArr[i] / cl; if (isFinite(ff) && ff > 0) f = ff; }
    closes.push(cl * f); highs.push(q.high[i] * f); lows.push(q.low[i] * f); volumes.push(q.volume[i] || 0);
  }
  if (closes.length < 30) throw new Error('進場日前資料不足');
  return { closes, highs, lows, volumes, price: closes[closes.length - 1], prevClose: closes[closes.length - 2] || closes[closes.length - 1] };
}

/* ── FinMind 通用取數 ── */
async function fmGet(dataset, params, token) {
  const u = new URL('https://api.finmindtrade.com/api/v4/data');
  u.searchParams.set('dataset', dataset);
  for (const k in params) u.searchParams.set(k, params[k]);
  const r = await fetchT(u.toString(), { headers: { Authorization: 'Bearer ' + token, ...UA } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j && j.data) || [];
}

/* ── 主力縱深：千張大戶(週) + 借券空單(日) + 分點(日) ── */
async function fetchDeepChip(stockNo, token) {
  if (!/^\d/.test(stockNo)) throw new Error('僅台股提供主力縱深');
  const iso = (d) => { const t = _tpeDateStr(d).ymd; return `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}`; };   // v118：台北時間

  const [holding, sbl, dayTrade, inst] = await Promise.all([
    fmGet('TaiwanStockHoldingSharesPer', { data_id: stockNo, start_date: iso(70) }, token),
    fmGet('TaiwanDailyShortSaleBalances', { data_id: stockNo, start_date: iso(20) }, token),
    fmGet('TaiwanStockDayTrading', { data_id: stockNo, start_date: iso(20) }, token).catch(() => []),
    fmGet('TaiwanStockInstitutionalInvestorsBuySell', { data_id: stockNo, start_date: iso(15) }, token).catch(() => []),
  ]);

  // ── 千張大戶剪刀差（週資料）──
  // 級距字串如 "1,000,001-5,000,000"，取下界：>=1,000,001股 = 千張以上
  let big = null;
  if (holding.length) {
    const byDate = {};
    for (const row of holding) {
      const lvl = String(row.HoldingSharesLevel || '');
      if (/合|total/i.test(lvl)) continue;
      const first = parseInt(lvl.replace(/,/g, '').match(/\d+/)?.[0] || '0', 10);
      const pct = Number(row.percent) || 0;
      if (pct >= 100) continue;
      const d = row.date;
      byDate[d] = byDate[d] || { big: 0, small: 0 };
      if (first >= 1000001) byDate[d].big += pct;
      else if (first < 50001) byDate[d].small += pct;   // 50張以下=散戶
    }
    const dates = Object.keys(byDate).sort();
    if (dates.length) {
      const last = byDate[dates[dates.length - 1]], first0 = byDate[dates[0]];
      big = {
        bigPct: Math.round(last.big * 100) / 100,
        bigChg: Math.round((last.big - first0.big) * 100) / 100,
        smallPct: Math.round(last.small * 100) / 100,
        smallChg: Math.round((last.small - first0.small) * 100) / 100,
        weeks: dates.length, lastDate: dates[dates.length - 1],
      };
    }
  }

  // ── 借券賣出餘額（法人空單）──
  let lend = null;
  if (sbl.length) {
    const keys = Object.keys(sbl[0]);
    const sblKey = keys.find(k => /SBL/i.test(k) && /Balance/i.test(k) && !/Limit|Quota/i.test(k));
    if (sblKey) {
      const series = sbl.map(r => Number(r[sblKey]) || 0);
      const bal = series[series.length - 1];
      const base = series.length > 5 ? series[series.length - 6] : series[0];
      lend = { bal: Math.round(bal / 1000), chg5: base ? Math.round((bal - base) / base * 1000) / 10 : 0 };
    }
  }

  // ── 分點主力動向（用 sbl 的日期序列當交易日，取近3日平行抓）──
  let brokers = [];
  const tdates = sbl.map(r => r.date).filter(Boolean).sort().slice(-3);
  if (tdates.length) {
    const reps = await Promise.all(tdates.map(d =>
      fmGet('TaiwanStockTradingDailyReport', { data_id: stockNo, date: d }, token).catch(() => [])
    ));
    brokers = reps.map((rows, i) => {
      if (!rows.length) return null;
      let sumBuy = 0, sumSell = 0;
      const nets = rows.map(r => { const b = Number(r.buy) || 0, s = Number(r.sell) || 0; sumBuy += b; sumSell += s; return b - s; })
        .sort((a, b) => b - a);
      const mainBuy = nets.slice(0, 15).filter(x => x > 0).reduce((a, b) => a + b, 0);
      const mainSell = nets.slice(-15).filter(x => x < 0).reduce((a, b) => a + b, 0);
      const tot = sumBuy + sumSell;
      return {
        date: tdates[i],
        mainNet: Math.round((mainBuy + mainSell) / 1000),           // 前15大分點淨額（張）
        conc: tot ? Math.round((mainBuy - mainSell) / tot * 1000) / 10 : 0,  // 集中度%
      };
    }).filter(x => x);
  }

  if (!big && !lend && !brokers.length) throw new Error('FinMind 無此股資料或 token 無效');
  // ── 當沖比重（散戶投機直接溫度計）──
  // TaiwanStockDayTrading：BuyAfterSale(當沖成交股數)/Volume。比重高=短線投機客聚集
  let dayTrading = null;
  if (dayTrade.length) {
    const rows = dayTrade.filter(r => Number(r.Volume) > 0);
    if (rows.length >= 3) {
      const ratios = rows.map(r => (Number(r.BuyAfterSale) || 0) / Number(r.Volume) * 100);
      const cur = ratios[ratios.length - 1];
      const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      dayTrading = { cur: Math.round(cur * 10) / 10, avg20: Math.round(avg * 10) / 10, days: rows.length };
    }
  }

  // ── 自營商自行 vs 避險細分（權證避險行為與真實自營意圖分離）──
  let dealer = null;
  if (inst.length) {
    let self5 = 0, hedge5 = 0, seen = new Set();
    for (const r of inst) {
      if (r.name === 'Dealer_self') { self5 += (Number(r.buy) - Number(r.sell)) || 0; seen.add(r.date); }
      if (r.name === 'Dealer_Hedging') { hedge5 += (Number(r.buy) - Number(r.sell)) || 0; }
    }
    if (seen.size >= 3) {
      dealer = { selfNet: Math.round(self5 / 1000), hedgeNet: Math.round(hedge5 / 1000), days: seen.size };  // 千股
    }
  }

  return { big, lend, brokers, dayTrading, dealer };
}

/* ── 基本面：估值(BWIBBU) + 月營收(OpenAPI)，平行抓 ── */
async function fetchFundamental(stockNo) {
  if (!/^\d/.test(stockNo)) throw new Error('僅台股上市提供基本面資料');

  const [val, rev] = await Promise.all([
    (async () => {  // BWIBBU_d：殖利率/本益比/股價淨值比（往回找最近交易日）
      for (let d = 0; d <= 7; d++) {
        const { ymd, wd } = _tpeDateStr(d);   // v118：台北時間（原UTC切片在台北凌晨時段會抓錯一天）
        if (wd === 0 || wd === 6) continue;
        try {
          const resp = await fetchT(`https://www.twse.com.tw/exchange/BWIBBU_d?response=json&date=${ymd}&selectType=ALL`, { headers: UA });
          const j = await resp.json();
          let rows = j.data || null, fields = j.fields || null;
          if (!rows && j.tables) { for (const tb of j.tables) { const td = tb.data || []; if (td.length && /^\d{4}/.test((td[0][0] || '').trim())) { rows = td; fields = tb.fields || j.fields; break; } } }
          if (!rows) continue;
          let iY = 2, iPE = 4, iPB = 5;
          if (fields) {
            const fi = (kw, ex) => fields.findIndex(x => { const s = String(x); return kw.every(k => s.includes(k)) && (!ex || !ex.some(e => s.includes(e))); });
            const a = fi(['殖利率']); if (a >= 0) iY = a;
            const b = fi(['本益比']); if (b >= 0) iPE = b;
            const c = fi(['淨值比']); if (c >= 0) iPB = c;
          }
          for (const row of rows) {
            if ((row[0] || '').trim() === stockNo) {
              return { dividendYield: num(row[iY]), pe: num(row[iPE]), pb: num(row[iPB]), valDate: ymd };
            }
          }
          return null;  // 該日有資料但無此股
        } catch (e) { /* 試前一天 */ }
      }
      return null;
    })(),
    (async () => {  // 月營收：OpenAPI t187ap05_L（欄位為中文鍵，以子字串比對防改版）
      for (const src2 of ['t187ap05_L', 't187ap05_O']) {  // 上市 → 上櫃 fallback
      try {
        const resp = await fetchT('https://openapi.twse.com.tw/v1/opendata/' + src2, { headers: UA });
        const arr = await resp.json();
        if (!Array.isArray(arr)) continue;
        for (const row of arr) {
          let code2 = null, mom = null, yoy = null, ym = null;
          for (const [k, v] of Object.entries(row)) {
            if (k.indexOf('公司代號') >= 0) code2 = String(v).trim();
            else if (k.indexOf('上月比較') >= 0) mom = num(v);
            else if (k.indexOf('去年同月') >= 0) yoy = num(v);
            else if (k.indexOf('資料年月') >= 0) ym = String(v).trim();
          }
          if (code2 === stockNo) return { revMoM: mom, revYoY: yoy, revMonth: ym };
        }
      } catch (e) { /* 換下一來源 */ }
      }
      return null;
    })(),
  ]);

  if (!val && !rev) throw new Error('無基本面資料');
  return {
    pe: val ? val.pe : null, pb: val ? val.pb : null,
    dividendYield: val ? val.dividendYield : null,
    revMoM: rev ? rev.revMoM : null, revYoY: rev ? rev.revYoY : null,
    revMonth: rev ? rev.revMonth : null,
  };
}

/* ── 融資融券（TWSE MI_MARGN，平行抓近~12交易日）── */
async function fetchMargin(stockNo) {
  if (!/^\d/.test(stockNo)) throw new Error('僅台股上市股票提供融資融券');
  const dates = [];
  for (let d = 16; d >= 0; d--) {
    const { ymd, wd } = _tpeDateStr(d);   // v118：台北時間
    if (wd === 0 || wd === 6) continue;
    dates.push(ymd);
  }
  const results = await Promise.all(dates.map(async (ymd) => {
    try {
      const resp = await fetchT(`https://www.twse.com.tw/exchange/MI_MARGN?response=json&date=${ymd}&selectType=ALL`, { headers: UA });
      if (!resp.ok) return null;
      const j = await resp.json();
      let rows = j.data || null, fields = j.fields || null;
      if (!rows && j.tables) {
        for (const tb of j.tables) {
          const td = tb.data || [];
          if (td.length && /^\d{4}/.test((td[0][0] || '').trim())) { rows = td; fields = tb.fields || j.fields; break; }
        }
      }
      if (!rows) return null;
      // 融資「今日餘額」＝資買+資賣後的餘額；融券同。欄名定位防改版；找不到才用預設索引
      let iMar = 6, iShort = 12;
      if (fields) {
        const fi = (kw) => fields.findIndex(x => { const s = String(x); return kw.every(k => s.includes(k)); });
        const a = fi(['融資', '今日餘額']); if (a >= 0) iMar = a;
        const b = fi(['融券', '今日餘額']); if (b >= 0) iShort = b;
      }
      for (const row of rows) {
        if ((row[0] || '').trim() === stockNo) {
          return { ymd, margin: num(row[iMar]), shortBal: num(row[iShort]) };
        }
      }
    } catch (e) { /* skip */ }
    return null;
  }));
  const series = results.filter(x => x).sort((a, b) => a.ymd < b.ymd ? -1 : 1);
  if (!series.length) throw new Error('無融資融券資料（可能為上櫃股或無信用交易）');
  const last = series[series.length - 1];
  const base = series.length > 5 ? series[series.length - 6].margin : series[0].margin;
  return {
    dataDate: last.ymd || '',   // v100：最新一筆MI_MARGN的日期（防呆顯示用）
    marginBal: last.margin,
    marginChg5: base ? (last.margin - base) / base * 100 : 0,
    shortBal: last.shortBal,
    shortRatio: last.margin ? last.shortBal / last.margin * 100 : 0,
    days: series.length
  };
}

function num(s) {
  if (s == null) return 0;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

/* ══════════════════════════════════════════════════════════════════════
   部署步驟（5分鐘，免費）：
   1. 註冊 Cloudflare 帳號 → dash.cloudflare.com
   2. 左側 Workers & Pages → Create → Create Worker
   3. 取個名字（如 stock-radar）→ Deploy
   4. 點 "Edit code"，把本檔全部內容貼上 → 右上 Deploy
   5. 雲端同步功能（選用）：
      - Workers & Pages → KV → Create namespace（名稱 SYNC）
      - 回到 Worker → Settings → Variables → KV Namespace Bindings
      - Variable name 填 SYNC，選剛建的 namespace → Save
   6. 複製 Worker 網址（如 https://stock-radar.xxx.workers.dev）
   7. 開啟你的 PWA → 設定 → 把網址貼進「GAS 網址」欄（同一個欄位）→ 測試連線
   完成！速度會比 GAS 快很多。
   ══════════════════════════════════════════════════════════════════════ */
