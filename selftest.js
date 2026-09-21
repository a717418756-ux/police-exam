#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   StockRadar Pro 自動自我檢查（v143）
   ──────────────────────────────────────────────────────────────────
   用途：改版後一鍵驗證「資料層」與「分析層」有沒有壞掉，不靠人眼看畫面。
   做法：用無頭瀏覽器實際載入整個網頁、餵入真實日K（本機 {代碼}.json），
         跑完整分析流程後檢查一連串不變條件（invariants）。
   用法：
     npm i -D playwright            （只需一次；或用系統既有的 playwright）
     node selftest.js               （於本檔所在資料夾執行）
     node selftest.js /path/to/json （日K檔放別的資料夾時）
   離線純邏輯檢查（不需瀏覽器）：node selftest.js --logic
   ══════════════════════════════════════════════════════════════════════ */
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = __dirname;
const DATA = process.argv.slice(2).find(a => !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isDirectory()) || ROOT;
const LOGIC_ONLY = process.argv.includes('--logic');

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; } else { fail++; fails.push(`${name}${detail ? ' → ' + detail : ''}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ── 第一部分：純邏輯（時間／日期／缺漏判定），不需瀏覽器 ───────────── */
function logicTests() {
  const src = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  const expSeg = src.match(/const _tpeNow[\s\S]*?const expected = `[^`]*`;/);
  ok('worker.js 內含「應有交易日」推算', !!expSeg);
  if (expSeg) {
    const evalExpected = (iso) => { const real = Date.now; Date.now = () => new Date(iso).getTime();
      const v = eval('(()=>{' + expSeg[0] + ' return expected;})()'); Date.now = real; return v; };
    ok('週一10:00台北→前一交易日(週五)', evalExpected('2026-09-21T02:00:00Z') === '20260918', evalExpected('2026-09-21T02:00:00Z'));
    ok('週一17:00台北→當日', evalExpected('2026-09-21T09:00:00Z') === '20260921', evalExpected('2026-09-21T09:00:00Z'));
    ok('週六13:00台北→週五', evalExpected('2026-09-19T05:00:00Z') === '20260918', evalExpected('2026-09-19T05:00:00Z'));
    ok('週日23:00台北→週五', evalExpected('2026-09-20T15:00:00Z') === '20260918', evalExpected('2026-09-20T15:00:00Z'));
  }
  const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  const phase = cfg.match(/function twMarketPhase[\s\S]*?\n}/);
  ok('config.js 內含 twMarketPhase', !!phase);
  if (phase) {
    const run = (iso) => { const real = Date.now; Date.now = () => new Date(iso).getTime();
      const v = eval('(()=>{' + phase[0] + ' return twMarketPhase();})()'); Date.now = real; return v.phase; };
    ok('週一10:00→盤中', run('2026-09-21T02:00:00Z') === '盤中', run('2026-09-21T02:00:00Z'));
    ok('週一14:00→已收盤', run('2026-09-21T06:00:00Z') === '已收盤', run('2026-09-21T06:00:00Z'));
    ok('週一08:00→未開盤', run('2026-09-21T00:00:00Z') === '未開盤', run('2026-09-21T00:00:00Z'));
    ok('週六11:00→非交易日', run('2026-09-19T03:00:00Z') === '未開盤', run('2026-09-19T03:00:00Z'));
  }
  // 台北時間一律「+8h 時間戳搭配 getUTC*」：混用 getHours 會整個時區錯位
  for (const f of ['config.js', 'app.js', 'worker.js', 'bingfa.js', 'enhance.js']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const bad = s.match(/Date\.now\(\) \+ 8 \* 3600000[\s\S]{0,400}?\.get(?!UTC)(Hours|Day|Date|Month|FullYear)\(/);
    ok(`${f} 未混用本地時區方法讀台北時間戳`, !bad, bad ? bad[0].slice(0, 60) : '');
  }
  // 版本號一致性：sw.js 由 config.js 帶入，註冊網址需帶版本（否則改版不更新）
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  ok('SW 註冊網址帶版本（改版才會更新）', /register\('\.\/sw\.js\?v=' \+ APP_VERSION/.test(app));
  ok('SW 註冊關閉瀏覽器快取', /updateViaCache: 'none'/.test(app));
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok('SW 對同源資源採網路優先', /self\.location\.origin/.test(sw) && /caches\.match\(e\.request\)\)/.test(sw));
  for (const dom of ['workers.dev', 'script.google.com', 'yahoo', 'twse', 'finmindtrade.com', 'taifex'])
    ok(`SW 排除清單含 ${dom}`, sw.includes(dom));
  // 前端逾時與快取常數
  ok('fetchT 預設 no-store', /cache: 'no-store'/.test(cfg));
  ok('CACHE_TTL 為單一常數', /const CACHE_TTL = \d+/.test(cfg));
  // 說明頁 key 與呼叫一致（缺漏＝點ⓘ沒反應的靜默失能）
  const help = fs.readFileSync(path.join(ROOT, 'help.js'), 'utf8');
  const defined = new Set([...help.matchAll(/^\s{2}([a-z][a-zA-Z0-9_]*):\s*\{/gm)].map(m => m[1]));
  const used = new Set();
  for (const f of fs.readdirSync(ROOT).filter(x => /\.(js|html)$/.test(x) && x !== 'help.js' && x !== 'selftest.js'))
    for (const line of fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;            // 註解裡的 showHelp('key') 只是說明文字
      for (const m of line.matchAll(/showHelp\('([a-z][a-zA-Z0-9_]*)'\)/g)) used.add(m[1]);
    }
  const missing = [...used].filter(k => !defined.has(k));
  ok('所有 showHelp key 都有對應說明', missing.length === 0, missing.join(','));
}

/* ── 第二部分：實際跑整個網頁（需 playwright）────────────────────────── */
function loadBars(code) {
  const J = JSON.parse(fs.readFileSync(path.join(DATA, `${code}.json`), 'utf8'));
  const arr = Array.isArray(J) ? J : J.data;
  const seen = new Map();
  arr.filter(r => r.close > 0 && r.Trading_Volume > 0).forEach(r => seen.set(r.date, r));
  return [...seen.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}
function mkPayload(code, todayBar) {
  const r = loadBars(code), n = r.length, g = k => r.map(x => x[k]);
  const d = new Date(Date.now() + 8 * 3600000);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return { ok: true, name: code, code, currency: 'TWD', price: r[n - 1].close, open: r[n - 1].open, high: r[n - 1].max,
    low: r[n - 1].min, prevClose: r[n - 2].close, volume: r[n - 1].Trading_Volume,
    closes: g('close'), highs: g('max'), lows: g('min'), volumes: g('Trading_Volume'), opens: g('open'),
    rawCloses: g('close'), rawHighs: g('max'), rawLows: g('min'),
    lastDate: todayBar ? ymd : r[n - 1].date.replace(/-/g, '') };
}
async function browserTests() {
  let chromium;
  try { chromium = require('playwright').chromium; }
  catch (e) { try { chromium = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')).chromium; }
    catch (e2) { console.log('（找不到 playwright，略過瀏覽器檢查：npm i -D playwright 後再跑一次）'); return; } }
  const codes = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4)).slice(0, 12);
  ok('找得到日K測試檔', codes.length >= 3, `找到 ${codes.length} 檔`);
  if (codes.length < 3) return;

  const srv = http.createServer((q, s) => { let p = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
    fs.readFile(p, (e, b) => { if (e) { s.writeHead(404); return s.end(); } const ext = path.extname(p);
      s.writeHead(200, { 'Content-Type': ext === '.js' ? 'text/javascript' : ext === '.html' ? 'text/html' : 'text/css' }); s.end(b); }); }).listen(8791);
  const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block' }); const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  let todayBar = false, chip = null;
  await pg.route('https://selftest.local/**', rt => { const u = new URL(rt.request().url()); const act = u.searchParams.get('action'); const code = u.searchParams.get('code');
    if (act === 'scan') { const list = (u.searchParams.get('codes') || '').split(',').filter(c => codes.includes(c));
      return rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, results: list.map(c => { const m = mkPayload(c, todayBar);
        return { code: c, ok: true, closes: m.closes, highs: m.highs, lows: m.lows, volumes: m.volumes, opens: m.opens, price: m.price, lastDate: m.lastDate }; }) }) }); }
    if (!act && code) { const p = mkPayload(code, todayBar); if (chip) p.chip = chip; return rt.fulfill({ contentType: 'application/json', body: JSON.stringify(p) }); }
    rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'selftest-mock' }) }); });
  await pg.goto('http://localhost:8791/index.html'); await pg.waitForTimeout(1200);

  const query = async (code) => { await pg.evaluate(c => { GAS_URL = 'https://selftest.local/exec';
      Object.keys(_stockCache).forEach(k => delete _stockCache[k]);
      document.getElementById('ticker-input').value = c; return go(); }, code);
    await pg.waitForTimeout(1800);
    return pg.evaluate(() => {
      const D = window._lastD, txt = id => (document.getElementById(id) || {}).innerText || '';
      const num = s => { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
      const gate = txt('gate-content');
      const prices = [...gate.matchAll(/(進場|🛑 停損|✅ 目標[^\n]*)\n([\d.,]+)/g)].map(m => [m[1], parseFloat(m[2].replace(/,/g, ''))]);
      return { code: D && D.code, n: D ? D.closes.length : 0, price: D ? D.price : null, intraday: !!(D && D._intraday),
        rawLen: D ? (D.rawCloses || []).length : 0, gate, prices, judge: txt('vb-judgement'), pill: document.getElementById('time-pill').textContent,
        hasNaN: /NaN|undefined|Infinity/.test(document.body.innerText) };
    }); };

  for (const code of codes) {
    const r = await query(code);
    ok(`${code} 有載入資料`, r.n > 100, `${r.n} 根K`);
    ok(`${code} 還原價與原始價長度一致`, r.rawLen === r.n, `${r.rawLen} vs ${r.n}`);
    ok(`${code} 畫面無 NaN/undefined`, !r.hasNaN);
    ok(`${code} 有輸出綜合研判或期望值`, /期望值|綜合研判/.test(r.judge));
    ok(`${code} 期望值有標示樣本數`, !/期望值/.test(r.judge) || /筆/.test(r.judge));
    const sideLong = /做多[\s\S]{0,40}?(🟢|🟡|🔴)/.exec(r.gate), sideShort = /做空[\s\S]{0,40}?(🟢|🟡|🔴)/.exec(r.gate);
    ok(`${code} 多空兩側都有裁決`, !!sideLong && !!sideShort);
    if (r.prices.length >= 3) {
      const entry = r.prices[0][1], stop = r.prices[1][1], tgt = r.prices[2][1];
      const isLong = /執行計畫 — 做多/.test(r.gate);
      ok(`${code} 停損方向正確`, isLong ? stop < entry : stop > entry, `進場${entry} 停損${stop} ${isLong ? '做多' : '做空'}`);
      ok(`${code} 目標方向正確`, isLong ? tgt > entry : tgt < entry, `進場${entry} 目標${tgt}`);
      const stopPct = Math.abs(stop - entry) / entry * 100;
      ok(`${code} 停損距離合理(0.5~20%)`, stopPct > 0.5 && stopPct < 20, stopPct.toFixed(2) + '%');
      const tgtPct = Math.abs(tgt - entry) / entry * 100;
      ok(`${code} 目標為實測可達幅度(<15%)`, tgtPct < 15, tgtPct.toFixed(2) + '%');
    }
  }
  // 決定性：同一檔查兩次結果必須一字不差（否則使用者會看到結論忽多忽空）
  const a1 = await query(codes[0]); const a2 = await query(codes[0]);
  ok('同一檔重複查詢結果完全一致', a1.gate === a2.gate && a1.judge === a2.judge);
  // 盤中：今日未完成K必須被剔除，且標示清楚
  todayBar = true; const intr = await query(codes[0]); todayBar = false;
  const base = await query(codes[0]);
  /* 這項只有在台北時間週一~週五 09:00~14:00 才適用（非盤中時段本來就不該剔除），
     否則測試會因執行時間不同而誤判 */
  const _t = new Date(Date.now() + 8 * 3600000), _m = _t.getUTCHours() * 60 + _t.getUTCMinutes();
  const inSession = _t.getUTCDay() >= 1 && _t.getUTCDay() <= 5 && _m >= 540 && _m < 840;
  if (inSession) {
    ok('盤中會剔除今日未完成K', intr.n === base.n - 1 && intr.intraday, `盤中${intr.n} vs 盤後${base.n}`);
    ok('盤中有明確標示', /盤中/.test(intr.pill), intr.pill);
  } else {
    ok('非盤中時段不剔除K棒（時段外行為正確）', intr.n === base.n && !intr.intraday, `${intr.n} vs ${base.n}`);
  }
  // 籌碼不完整：必須改中性且不投票
  chip = { dataDate: '20260916', expected: '20260918', missDates: ['20260918', '20260917'], headMiss: 2, gapMiss: 0, days: 12,
    foreign1: -800, foreign5: -3000, foreign20: -9000, trust1: -100, trust5: -500, trust20: -1200, dealer5: -200, foreignStreak: 0, trustStreak: 0 };
  const bad = await query(codes[0]); chip = null;
  const chipTxt = await pg.evaluate(() => (document.getElementById('chip-card') || {}).innerText || '');
  ok('籌碼不完整→籌碼分回中性50', /籌碼健康度\s*50|健康度 50/.test(chipTxt.replace(/\n/g, ' ')), chipTxt.slice(0, 80).replace(/\n/g, ' '));
  ok('籌碼不完整→列出缺漏日期', /09\/18|09\/17/.test(chipTxt + bad.gate + bad.judge));
  // 掃描器：與個股同一套資料處理，且不得噴錯
  await pg.evaluate(cs => { TW_POOL.length = 0; cs.forEach(c => TW_POOL.push(c)); }, codes.slice(0, 6));
  await pg.evaluate(() => runScanAuto('short')); await pg.waitForTimeout(3500);
  const scan = await pg.evaluate(() => (document.getElementById('scan-result') || {}).innerText || '');
  ok('掃描器可完成', /掃描完成/.test(scan), scan.slice(0, 60).replace(/\n/g, ' '));
  ok('掃描結果無 NaN', !/NaN|undefined/.test(scan));

  ok('全程無 JavaScript 錯誤', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close(); srv.close();
}

/* ── 第三部分：後端資料正確性（worker.js 與 Code.gs 都要驗）──────────────
   這一段全部用合成的 Yahoo/TWSE 回應離線跑，不連外網。
   每一項都對應一個真實發生過的資料錯誤，改壞了會立刻紅燈。 */
async function backendTests() {
  // worker.js：去掉 Cloudflare 入口後載入工具函式
  let src = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  src = src.slice(0, src.indexOf('export default')) + src.slice(src.indexOf('/* ── 掃描用：單檔K線'));
  let fetchImpl = async () => { throw new Error('未設定'); };
  global.fetch = (...a) => fetchImpl(...a);
  const W = {};
  new Function('module', src + '\nmodule.yahooChart=yahooChart;module.fetchRangeOHLC=fetchRangeOHLC;module.fetchHistUntil=fetchHistUntil;module.fetchTaiwanChip=fetchTaiwanChip;')(W);

  // Code.gs：補上 GAS 全域物件
  const pad = n => String(n).padStart(2, '0');
  let gsFetch = () => ({ getResponseCode: () => 200, getContentText: () => '{}' });
  global.UrlFetchApp = { fetch: (...a) => gsFetch(...a) };
  global.PropertiesService = { getUserProperties: () => ({ getProperty: () => null, setProperty: () => {} }) };
  global.ContentService = { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 1 } };
  global.Utilities = { sleep() {}, formatDate(d, tz, fmt) {
    const x = new Date(d.getTime() + (tz === 'Asia/Taipei' ? 8 * 3600000 : 0));
    if (fmt === 'u') return String(x.getUTCDay() === 0 ? 7 : x.getUTCDay());
    const y = x.getUTCFullYear(), m = pad(x.getUTCMonth() + 1), dd = pad(x.getUTCDate());
    return fmt === 'yyyy-MM-dd' ? `${y}-${m}-${dd}` : `${y}${m}${dd}`;
  } };
  const G = {};
  new Function('module', fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8') + '\nmodule.fetchYahoo=fetchYahoo;module.fetchYahooTW=fetchYahooTW;module.fetchRangeOHLC=fetchRangeOHLC;module.fetchHistUntil=fetchHistUntil;module.fetchTaiwanChip=fetchTaiwanChip;')(G);

  const DAY = 86400, base = Date.parse('2026-09-14T01:00:00Z') / 1000;
  const chart = (n, o = {}) => { const ts = [], cl = [], hi = [], lo = [], op = [], vo = [], ac = [];
    for (let i = 0; i < n; i++) { ts.push(base + i * DAY);
      const nul = i >= n - (o.trailingNull || 0);
      cl.push(nul ? null : 100 + i); hi.push(nul ? null : (i === o.nullHighAt ? null : 101 + i));
      lo.push(nul ? null : 99 + i); op.push(nul ? null : 100 + i); vo.push(nul ? null : 1e6); ac.push(nul ? null : (100 + i) * 0.9); }
    return { chart: { result: [{ timestamp: ts, meta: { shortName: 'X' }, indicators: { quote: [{ close: cl, high: hi, low: lo, open: op, volume: vo }], adjclose: [{ adjclose: ac }] } }] } }; };
  const gsOf = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
  const ymdOf = t => new Date(t * 1000).toISOString().slice(0, 10).replace(/-/g, '');

  // ① 結尾有 null K棒時，lastDate 必須對齊「最後一根實際採用的K棒」
  //    （對錯日期會讓新鮮度檢查與盤中丟棄未完成K棒兩道防線一起失準）
  const want = ymdOf(base + 78 * DAY);
  fetchImpl = async () => ({ ok: true, json: async () => chart(80, { trailingNull: 1 }) });
  const wd = await W.yahooChart('2330.TW', '2y', '1d');
  ok('worker lastDate 對齊最後一根有效K棒', wd.lastDate === want, wd.lastDate);
  ok('worker 結尾 null 棒已排除', wd.closes.length === 79, String(wd.closes.length));
  gsFetch = () => gsOf(chart(80, { trailingNull: 1 }));
  ok('GAS lastDate 對齊最後一根有效K棒', G.fetchYahoo('AAPL').lastDate === want);
  ok('GAS 台股有回傳 lastDate（新鮮度檢查才有效）', G.fetchYahooTW('2330').lastDate === want);

  // ② high/low 缺值不得變成 NaN（NaN 會直接污染 ATR 與關卡）
  fetchImpl = async () => ({ ok: true, json: async () => chart(80, { nullHighAt: 40 }) });
  const wn = await W.yahooChart('2330.TW', '2y', '1d');
  ok('worker 缺值不產生 NaN', wn.highs.every(Number.isFinite) && wn.rawHighs.every(Number.isFinite));
  gsFetch = () => gsOf(chart(80, { nullHighAt: 40 }));
  const gn = G.fetchYahoo('AAPL');
  ok('GAS 缺值不產生 NaN', gn.highs.every(Number.isFinite) && gn.rawHighs.every(Number.isFinite));

  // ③ period2 不得多抓一天（histuntil 多一天＝前視偏差；range 多一天＝MAE/MFE 算大）
  const limit = Date.parse('2026-09-30T23:59:59Z') / 1000;
  let seen = '';
  fetchImpl = async u => { seen = u; return { ok: true, json: async () => chart(30) }; };
  await W.fetchHistUntil('2330', '2026-09-30');
  ok('worker histuntil 無前視偏差', +new URL(seen).searchParams.get('period2') <= limit);
  await W.fetchRangeOHLC('2330', '2026-09-01', '2026-09-30');
  ok('worker range 不含出場日次一交易日', +new URL(seen).searchParams.get('period2') <= limit);
  let gseen = '';
  gsFetch = u => { gseen = u; return gsOf(chart(30)); };
  G.fetchHistUntil('2330', '2026-09-30');
  ok('GAS histuntil 無前視偏差', +new URL(gseen).searchParams.get('period2') <= limit);
  G.fetchRangeOHLC('2330', '2026-09-01', '2026-09-30');
  ok('GAS range 不含出場日次一交易日', +new URL(gseen).searchParams.get('period2') <= limit);

  // ④ 上櫃（.TWO）標的的日誌 MAE/MFE 不能一律失敗
  let tried = [];
  fetchImpl = async u => { tried.push(u); return u.includes('.TWO') ? { ok: true, json: async () => chart(30) } : { ok: true, json: async () => ({ chart: { result: [] } }) }; };
  let rr = null; try { rr = await W.fetchRangeOHLC('6488', '2026-09-01', '2026-09-30'); } catch (e) {}
  ok('worker 上櫃會退而試 .TWO', !!rr && tried.some(u => u.includes('.TWO')));
  let gtried = [];
  gsFetch = u => { gtried.push(u); return gsOf(u.includes('.TWO') ? chart(30) : { chart: { result: [] } }); };
  let gr = null; try { gr = G.fetchRangeOHLC('6488', '2026-09-01', '2026-09-30'); } catch (e) {}
  ok('GAS 上櫃會退而試 .TWO', !!gr && gtried.some(u => u.includes('.TWO')));

  // ⑤ MAE/MFE 三組陣列必須對齊同一根K棒
  gsFetch = () => gsOf(chart(30, { nullHighAt: 10 }));
  const gra = G.fetchRangeOHLC('2330', '2026-09-01', '2026-09-30');
  ok('GAS 區間高低與收盤同一根K棒', Number.isFinite(gra.rangeHigh) && Number.isFinite(gra.rangeLow) && Number.isFinite(gra.lastClose));

  // ⑥ 籌碼：國定假日不可算成「抓取失敗」，但真失敗必須示警
  const T86 = { stat: 'OK', fields: ['證券代號', '證券名稱', '外資及陸資買賣超股數', '投信買賣超股數', '自營商買賣超股數'], data: [['2330', '台積電', '1,000,000', '500,000', '100,000']] };
  const HOL = { stat: '很抱歉，沒有符合條件的資料!' };
  const dOf = u => new URL(u).searchParams.get('date');
  let asked = [];
  fetchImpl = async u => { asked.push(dOf(u)); return { ok: true, json: async () => T86 }; };
  await W.fetchTaiwanChip('2330');
  const newest = asked.sort().slice(-1)[0];
  fetchImpl = async u => ({ ok: true, json: async () => (dOf(u) === newest ? HOL : T86) });
  const ch = await W.fetchTaiwanChip('2330');
  ok('worker 假日不算籌碼缺漏', ch.headMiss === 0, `headMiss=${ch.headMiss}`);
  ok('worker 假日時 expected 往前推', ch.expected === ch.dataDate, `${ch.expected}/${ch.dataDate}`);
  fetchImpl = async u => (dOf(u) === newest ? { ok: false, status: 500 } : { ok: true, json: async () => T86 });
  const ch2 = await W.fetchTaiwanChip('2330');
  ok('worker 真失敗仍算籌碼缺漏', ch2.headMiss > 0 && (ch2.missDates || []).includes(newest));
  let gAsked = [];
  gsFetch = u => { gAsked.push(dOf(u)); return gsOf(T86); };
  G.fetchTaiwanChip('2330');
  const gNewest = gAsked.sort().slice(-1)[0];
  gsFetch = u => gsOf(dOf(u) === gNewest ? HOL : T86);
  const gch = G.fetchTaiwanChip('2330');
  ok('GAS 有回傳 expected／headMiss（過時警示才會動）', typeof gch.expected === 'string' && typeof gch.headMiss === 'number');
  ok('GAS 假日不算籌碼缺漏', gch.headMiss === 0 && gch.expected === gch.dataDate);
  gsFetch = u => { if (dOf(u) === gNewest) throw new Error('連線失敗'); return gsOf(T86); };
  ok('GAS 真失敗仍算籌碼缺漏', G.fetchTaiwanChip('2330').headMiss > 0);

  // ⑦ 前端判定：假日不得誤報、真失敗必須示警
  const unrel = c => (c.headMiss > 0) || (c.expected && String(c.dataDate || '') < String(c.expected));
  ok('前端不會對假日誤報籌碼不完整', !unrel(ch) && !unrel(gch));
  ok('前端仍會對真失敗示警', unrel(ch2));
}

(async () => {
  console.log('═══ StockRadar 自我檢查 ═══');
  logicTests();
  await backendTests();
  if (!LOGIC_ONLY) await browserTests();
  console.log(`\n通過 ${pass} 項｜失敗 ${fail} 項`);
  if (fails.length) { console.log('\n❌ 失敗項目：'); fails.forEach(f => console.log('  - ' + f)); }
  else console.log('✅ 全部通過');
  process.exit(fail ? 1 : 0);
})();
