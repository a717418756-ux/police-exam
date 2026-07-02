/* ══════════════════════════════════════════════════════════════════════
   worker.js — 短線雷達後端（Cloudflare Workers 版）
   取代 Google Apps Script，速度快 3-5 倍
   ──────────────────────────────────────────────────────────────────
   部署方式見檔末註解。前端只需把 GAS_URL 換成 Workers 網址即可。
   功能與 Code.gs 完全相同：
   - 個股查詢（台股 Yahoo 優先 + 籌碼 T86）/ 美股
   - 大盤環境 / 大盤基準 / 區間K線(MAE-MFE) / 進場日公式分數
   - 雲端同步（用 Workers KV，需綁定 KV namespace 名為 SYNC）
   ══════════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
    const r = await yahooChart(stockNo + suffix, '1y', '1d');
    if (r && r.closes.length >= 60) { r.code = stockNo; r.currency = 'TWD'; return r; }
  }
  return null;
}

/* ── Yahoo 美股 ── */
async function fetchYahoo(symbol) {
  const r = await yahooChart(symbol, '1y', '1d');
  if (!r || r.closes.length < 10) throw new Error('找不到 ' + symbol + ' 的資料');
  r.code = symbol;
  r.currency = 'USD';
  return r;
}

/* ── Yahoo Chart API 共用 ── */
async function yahooChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const resp = await fetch(url, { headers: UA });
  if (!resp.ok) return null;
  const j = await resp.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.indicators || !res.indicators.quote) return null;
  const q = res.indicators.quote[0];
  const meta = res.meta || {};
  const closes = [], highs = [], lows = [], opens = [], vols = [];
  for (let i = 0; i < (q.close || []).length; i++) {
    if (q.close[i] == null) continue;
    closes.push(q.close[i]); highs.push(q.high[i]); lows.push(q.low[i]);
    opens.push(q.open[i]); vols.push(q.volume[i] || 0);
  }
  if (!closes.length) return null;
  const last = closes.length - 1;
  return {
    name: meta.shortName || meta.symbol || symbol,
    price: closes[last], open: opens[last], high: highs[last], low: lows[last],
    prevClose: closes[last - 1] || closes[last], volume: vols[last],
    avgVol5: vols.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, vols.length),
    closes, highs, lows, volumes: vols,
  };
}

/* ── 台股三大法人 T86（近18交易日，平行抓取超快）── */
async function fetchTaiwanChip(stockNo) {
  const now = Date.now();
  const dates = [];
  for (let d = 25; d >= 0; d--) {
    const day = new Date(now - d * 86400000);
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    dates.push(day.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  // 平行抓所有日期（GAS 要 sleep 序列，Workers 可平行 → 快 10 倍）
  const results = await Promise.all(dates.map(async (ymd) => {
    try {
      const url = `https://www.twse.com.tw/fund/T86?response=json&date=${ymd}&selectType=ALLBUT0999`;
      const resp = await fetch(url, { headers: UA });
      if (!resp.ok) return null;
      const j = await resp.json();
      if (j.stat !== 'OK' || !j.data) return null;
      for (const row of j.data) {
        if ((row[0] || '').trim() === stockNo) {
          return { ymd, foreign: num(row[4]) / 1000, trust: num(row[10]) / 1000, dealer: num(row[11]) / 1000 };
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

  return {
    foreign1: fSeries[fSeries.length - 1] || 0, foreign5: sumN(fSeries, 5), foreign20: sumN(fSeries, 20),
    trust1: tSeries[tSeries.length - 1] || 0, trust5: sumN(tSeries, 5), trust20: sumN(tSeries, 20),
    dealer5: sumN(dSeries, 5),
    foreignStreak: streak(fSeries), trustStreak: streak(tSeries),
  };
}

/* ── 大盤環境（完整：期交所 taifex + 美股隔夜）── */
async function fetchMarket() {
  const out = { tw: {}, us: {}, taifex: {} };

  // 平行抓所有來源（Workers 平行，比 GAS 序列快）
  const [twii, sox, nasdaq, sp500, vix, taifexFut, pcr] = await Promise.all([
    yahooQuote('^TWII'), yahooQuote('^SOX'), yahooQuote('^IXIC'),
    yahooQuote('^GSPC'), yahooQuote('^VIX'),
    fetchTaifexFutures().catch(() => null),
    fetchTaifexPCR().catch(() => null),
  ]);

  out.tw.index = twii;
  out.us.sox = sox;
  out.us.nasdaq = nasdaq;
  out.us.sp500 = sp500;
  out.us.vix = vix;

  if (taifexFut) { out.taifex.foreignNet = taifexFut.foreignNet; out.taifex.institutionNet = taifexFut.institutionNet; out.taifex.date = taifexFut.date; }
  if (pcr) { out.taifex.pcrOI = pcr.pcrOI; out.taifex.pcrVol = pcr.pcrVol; out.taifex.pcrDate = pcr.pcrDate; }

  return out;
}

/* ── 期交所：三大法人台指期淨未平倉 ── */
async function fetchTaifexFutures() {
  const url = 'https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfAsSpecificFuturesContractByDate';
  const resp = await fetch(url, { headers: UA });
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
  const resp = await fetch(url, { headers: UA });
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`;
  const resp = await fetch(url, { headers: UA });
  const j = await resp.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('找不到區間資料');
  const q = res.indicators.quote[0];
  const highs = (q.high || []).filter(x => x != null);
  const lows = (q.low || []).filter(x => x != null);
  const closes = (q.close || []).filter(x => x != null);
  if (!highs.length) throw new Error('區間內無交易資料');
  return {
    rangeHigh: Math.max(...highs), rangeLow: Math.min(...lows),
    days: highs.length, firstClose: closes[0], lastClose: closes[closes.length - 1],
  };
}

/* ── 截至某日K線（進場日公式分數）── */
async function fetchHistUntil(code, until) {
  if (!code || !until) throw new Error('缺少參數');
  const symbol = /^\d/.test(code) ? code + '.TW' : code;
  const untilTime = Math.floor(new Date(until + 'T23:59:59Z').getTime() / 1000) + 86400;
  const fromTime = untilTime - 200 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${fromTime}&period2=${untilTime}`;
  const resp = await fetch(url, { headers: UA });
  const j = await resp.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('找不到歷史資料');
  const q = res.indicators.quote[0];
  const closes = [], highs = [], lows = [], volumes = [];
  for (let i = 0; i < (q.close || []).length; i++) {
    if (q.close[i] == null) continue;
    closes.push(q.close[i]); highs.push(q.high[i]); lows.push(q.low[i]); volumes.push(q.volume[i] || 0);
  }
  if (closes.length < 30) throw new Error('進場日前資料不足');
  return { closes, highs, lows, volumes, price: closes[closes.length - 1], prevClose: closes[closes.length - 2] || closes[closes.length - 1] };
}

/* ── 融資融券（TWSE MI_MARGN，平行抓近~12交易日）── */
async function fetchMargin(stockNo) {
  if (!/^\d/.test(stockNo)) throw new Error('僅台股上市股票提供融資融券');
  const now = Date.now();
  const dates = [];
  for (let d = 16; d >= 0; d--) {
    const day = new Date(now - d * 86400000);
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    dates.push(day.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  const results = await Promise.all(dates.map(async (ymd) => {
    try {
      const resp = await fetch(`https://www.twse.com.tw/exchange/MI_MARGN?response=json&date=${ymd}&selectType=ALL`, { headers: UA });
      if (!resp.ok) return null;
      const j = await resp.json();
      let rows = j.data || null;
      if (!rows && j.tables) {
        for (const tb of j.tables) {
          const td = tb.data || [];
          if (td.length && /^\d{4}/.test((td[0][0] || '').trim())) { rows = td; break; }
        }
      }
      if (!rows) return null;
      for (const row of rows) {
        if ((row[0] || '').trim() === stockNo) {
          return { ymd, margin: num(row[6]), shortBal: num(row[12]) };
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
