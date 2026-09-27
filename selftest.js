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
  {   // 新增前端檔時最容易漏：頁面載得到、離線就壞（v168 intel.js 起加此檢查）
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="\.\/([\w.]+\.js)"/g)].map(m => m[1]);
    const miss = scripts.filter(f => !sw.includes(`'./${f}'`));
    ok('index.html 載入的每支 js 都在 SW 離線快取清單', scripts.length > 10 && miss.length === 0, miss.join(','));
  }
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
function getChromium() {
  try { return require('playwright').chromium; }
  catch (e) { try { return require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')).chromium; }
    catch (e2) { return null; } }
}
function serveRoot(port) {
  return http.createServer((q, s) => { let p = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
    fs.readFile(p, (e, b) => { if (e) { s.writeHead(404); return s.end(); } const ext = path.extname(p);
      s.writeHead(200, { 'Content-Type': ext === '.js' ? 'text/javascript' : ext === '.html' ? 'text/html' : 'text/css' }); s.end(b); }); }).listen(port);
}

/* ── 版面幾何檢查（v167）──────────────────────────────────────────────
   不需要日K測試檔，所以與掃描流程分開跑（缺測試檔時也要能擋住這類回歸）。
   對應的真實災情：資金/風險/勝率三欄是 grid 子項，預設 min-width:auto，
   而 <input> 的瀏覽器內建最小寬度約237px，把 1fr 軌道撐到超出卡片，
   再被 .settings-row 的 overflow:hidden 切掉——手機上「1000000」只剩「1000」。
   金額被裁＝部位大小會算錯，屬於會害人賠錢的顯示錯誤，必須有檢查釘住。 */
async function layoutTests() {
  const chromium = getChromium();
  if (!chromium) return;
  const srv0 = serveRoot(8792);
  const b0 = await chromium.launch();
  const bad = [];
  for (const [W, mob] of [[320, true], [360, true], [390, true], [414, true], [768, true], [980, true], [1280, false]]) {
    const ctx = await b0.newContext({ viewport: { width: W, height: 800 }, isMobile: mob, hasTouch: mob, serviceWorkers: 'block' });
    const pg = await ctx.newPage();
    await pg.goto('http://localhost:8792/index.html');
    await pg.waitForTimeout(400);
    for (const v of ['1000000', '999999999']) {   // 預設值與九位數大額，兩種都不得被裁
      const rs = await pg.evaluate(val => {
        const row = document.querySelector('.settings-row'), rb = row.getBoundingClientRect();
        document.getElementById('in-capital').value = val;
        return [...row.querySelectorAll('.set-field')].map(f => {
          const inp = f.querySelector('input'), fb = f.getBoundingClientRect(), ib = inp.getBoundingClientRect();
          return { id: inp.id, over: +(fb.right - rb.right).toFixed(1), out: +(ib.right - rb.right).toFixed(1), clip: inp.scrollWidth > inp.clientWidth + 1 };
        });
      }, v);
      for (const x of rs) if (x.over > 0.5 || x.out > 0.5 || x.clip) bad.push(`${W}px/${v}/${x.id} 超出${x.over}px${x.clip ? '、數值被裁' : ''}`);
    }
    await ctx.close();
  }
  ok('資金/風險/勝率欄位不溢出、數值不被裁（7種寬度×2種數值）', bad.length === 0, bad.slice(0, 3).join('；'));
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  ok('.set-field 保留 min-width:0（拿掉就會再被裁）', /\.set-field\{[^}]*min-width:0/.test(css));
  ok('空間不足時縮的是標題不是數值', /\.set-label\{flex:0 1 auto/.test(css) && /\.set-field input\{flex:1 1 0;min-width:10ch/.test(css));

  /* v167 啟動動畫：好看是其次，重點是「絕不能變成蓋住 App 的黑幕」。
     所以三件事都要驗：會自己收起、收起後不擋點擊、JS 掛掉也會消失。 */
  const splash = async (url, opts = {}) => {
    const ctx = await b0.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, ...opts });
    const pg = await ctx.newPage();
    const t0 = Date.now();
    await pg.goto(url, { waitUntil: 'domcontentloaded' });
    const shown = await pg.$('#splash') != null;
    const delay = await pg.evaluate(() => { const e = document.getElementById('splash'); return e ? getComputedStyle(e).animationDelay : ''; }).catch(() => '');
    let gone = -1, blocked = null;
    try { await pg.waitForFunction(() => { const e = document.getElementById('splash');
      return !e || getComputedStyle(e).visibility === 'hidden'; }, { timeout: 9000 }); gone = Date.now() - t0; } catch (e) {}
    if (opts.javaScriptEnabled !== false) blocked = await pg.evaluate(() => { const g = document.getElementById('go-btn'), r = g.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== g; }).catch(() => true);
    await ctx.close();
    return { shown, delay, gone, blocked };
  };
  const tab = await splash('http://localhost:8792/index.html');
  ok('啟動動畫會出現且自行收起', tab.shown && tab.gone > 0, `gone=${tab.gone}`);
  ok('分頁模式約1.2秒收起（不必每次等3秒）', tab.gone > 900 && tab.gone < 2600, `${tab.gone}ms`);
  ok('收起後不擋住首頁操作', tab.blocked === false);
  const pwa = await splash('http://localhost:8792/index.html?src=pwa');
  ok('PWA模式套用長版時機（約3秒）', pwa.delay === '2.6s' && pwa.gone > 2700 && pwa.gone < 3900, `delay=${pwa.delay} gone=${pwa.gone}ms`);
  {   // JS 關閉時頁面裡跑不了 waitForFunction，改成等足時間後直接讀樣式
    const ctx = await b0.newContext({ viewport: { width: 390, height: 780 }, javaScriptEnabled: false });
    const pg = await ctx.newPage();
    await pg.goto('http://localhost:8792/index.html', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(2400);
    const v = await pg.$eval('#splash', el => getComputedStyle(el).visibility).catch(() => 'gone');
    ok('JS 失效時啟動畫面仍會自行隱藏（不會變黑幕）', v === 'hidden' || v === 'gone', v);
    await ctx.close();
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('啟動動畫的收起由 CSS 負責（JS 只做移除）', /animation:spOut[^;]*forwards/.test(html) && /visibility:hidden/.test(html));
  ok('啟動動畫有最後保險（逾時強制移除）', /setTimeout\(kill, 5000\)/.test(html));

  await b0.close(); srv0.close();
}

/* ── 掃描流程檢查（v167）──────────────────────────────────────────────
   不需要日K測試檔，用假後端跑真實前端流程。三項都對應 v166 當天寫出來的真雷：
     ① 抓池子的網路請求放在「鎖按鈕」之前 → 那幾秒重複點擊會同時跑兩輪，
        兩輪共用 _poolNote，先跑完的會配到後跑那輪的池子說明（講錯池子）。
     ② 自動填入的動態池被 closeScan() 存成「使用者自訂清單」→ 下次開啟還原，
        按「用此清單掃描」就是拿舊排行去掃（又一次靜默的過時資料）。
     ③ _autoPool 旗標在提前 return 之後才取走 → 卡在 true，下一次手動掃描
        會沿用上一輪的池子說明，且清單不存檔。 */
async function scanFlowTests() {
  const chromium = getChromium();
  if (!chromium) return;
  const srv = serveRoot(8793);
  const b = await chromium.launch();
  const ctx = await b.newContext({ serviceWorkers: 'block' });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  let poolDelay = 0, poolCalls = 0, poolCodes = ['2001', '2002', '2003'], intelDelay = 0;
  const T0 = Date.now();
  let intelResp = { ok: true, code: '2330', name: '台積電', asOf: T0, board: '上市', lastBar: '20260926',
    items: [{ kind: 'news', title: '台積電法說上修全年營收', src: '經濟日報', url: 'https://news.example/a', t: T0 - 5 * 3600e3 },
            { kind: 'ptt', title: '[標的] 2330 台積電 多', src: 'PTT［標的］', url: 'https://www.ptt.cc/bbs/Stock/M.1.A.1.html', t: T0 - 3 * 3600e3 }],
    events: [{ title: '法說上修全年營收', type: '法說', dir: 1, mag: 2, horizon: '中', conf: 0.8, ids: [0, 1], first: T0 - 5 * 3600e3, srcKinds: ['news', 'ptt'],
      study: { status: 'ok', t0: '20260926', afterClose: false, L: 2, car: 0.042, scar: 2.9, pre: 0.003, preScar: 0.4, beta: 1.1, n: 110 } }],
    tilt: { tilt: 0.8, conflict: 0, n: 1 },
    attention: { news: { n: 3, last24: 2, med: 1, ratio: 2, daily: [2, 1, 0, 0, 0, 0, 0] }, ptt: { n: 1, last24: 1, med: 0, ratio: 1, daily: [1, 0, 0, 0, 0, 0, 0], bull: 1, bear: 0 } },
    ai: { status: 'ok', model: 'gemini-test', prompt: 'v168.1', dropped: 1, summary: '市場在談法說上修[0]。' }, notes: [], srcErrors: [], snapshot: 'saved' };
  const bars = n => { const c = [], h = [], l = [], v = [];
    for (let i = 0; i < n; i++) { const x = 100 + Math.sin(i / 5) * 5 + i * 0.1;
      c.push(+x.toFixed(2)); h.push(+(x * 1.01).toFixed(2)); l.push(+(x * 0.99).toFixed(2)); v.push(5e7); }
    return { c, h, l, v }; };
  await pg.route('**/scanflow.test/**', async route => {
    const u = new URL(route.request().url()), a = u.searchParams.get('action');
    if (a === 'pool') { poolCalls++;
      if (poolDelay) await new Promise(r => setTimeout(r, poolDelay));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, codes: poolCodes, dataDate: '20260921', universe: 999, cutoff: 1e8 }) }); }
    if (a === 'intel') { if (intelDelay) await new Promise(r => setTimeout(r, intelDelay));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(intelResp) }); }
    if (a === 'scan') { const codes = u.searchParams.get('codes').split(',');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, results: codes.map(code => { const k = bars(120);
        return { code, ok: true, closes: k.c, highs: k.h, lows: k.l, volumes: k.v, opens: k.c, rawCloses: k.c, rawHighs: k.h, rawLows: k.l, price: k.c[119], lastDate: '20260921' }; }) }) }); }
    return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await pg.goto('http://localhost:8793/index.html');
  await pg.waitForTimeout(900);
  await pg.evaluate(() => { GAS_URL = 'http://scanflow.test/api'; });
  const txt = () => pg.evaluate(() => document.getElementById('scan-result').innerText);

  // ① 重複點擊
  poolDelay = 700; poolCalls = 0;
  await pg.evaluate(() => { openScan(); runScanAuto('long'); runScanAuto('short'); runScanAuto('long'); });
  await pg.waitForTimeout(300);
  ok('抓池子期間按鈕已鎖住（防重複掃描）', await pg.evaluate(() => document.getElementById('scan-short').disabled));
  await pg.waitForTimeout(3200);
  const t1 = await txt();
  ok('連按三下只跑一輪', poolCalls === 1 && (t1.match(/動態掃描池/g) || []).length === 1, `池子抓了${poolCalls}次`);
  ok('跑完後按鈕已解鎖', await pg.evaluate(() => !document.getElementById('scan-short').disabled && !document.getElementById('scan-long').disabled));
  poolDelay = 0;

  // ② 自動池不可被存成自訂清單；使用者自己改的要存
  await pg.evaluate(() => localStorage.removeItem('scanPool'));
  await pg.evaluate(() => runScanAuto('long'));
  await pg.evaluate(() => closeScan());
  ok('自動池不會被存成使用者自訂清單', !(await pg.evaluate(() => localStorage.getItem('scanPool'))));
  await pg.evaluate(() => { openScan(); const ta = document.getElementById('scan-codes'); ta.value = '2330 2317'; ta.dispatchEvent(new Event('input')); closeScan(); });
  ok('使用者自己改的清單仍會存檔', (await pg.evaluate(() => localStorage.getItem('scanPool'))) === '2330 2317');

  // ③ 提前 return 後旗標不可卡住
  poolCodes = Array.from({ length: 301 }, (_, i) => String(4000 + i));
  await pg.evaluate(() => { openScan(); runScanAuto('long'); });
  await pg.waitForTimeout(600);
  ok('超過上限會擋下（不硬送給後端）', /最多300檔/.test(await txt()));
  await pg.evaluate(() => { const ta = document.getElementById('scan-codes'); ta.value = '2330 2317'; ta.dispatchEvent(new Event('input')); });
  await pg.evaluate(() => runScan());
  await pg.waitForTimeout(900);
  ok('擋下後，手動掃描不會沿用上一輪池子說明', !/動態掃描池|內建備援清單/.test(await txt()));

  // ── v168 情報卡（真實瀏覽器）──
  const D0 = { code: '2330', currency: 'TWD', chip: { foreign5: 800, trust5: 100, n5: 5 } };
  const intelText = () => pg.evaluate(() => { const c = document.getElementById('intel-card'); return { vis: c && c.style.display !== 'none', txt: (document.getElementById('intel-content') || {}).innerText || '', html: (document.getElementById('intel-content') || {}).innerHTML || '' }; });
  await pg.evaluate(d => { window._activeCode = '2330'; return loadIntelCard(d); }, D0);
  let ic = await intelText();
  ok('情報卡：顯示並給出判讀（共振）', ic.vis && /共振/.test(ic.txt) && /法人同向/.test(ic.txt), ic.txt.slice(0, 80));
  ok('情報卡：摘要引用變成可點的來源連結', /href="https:\/\/news\.example\/a"/.test(ic.html) && /\[1\]/.test(ic.txt));
  ok('情報卡：標示剔除了幾個無引用事件、快照狀態', /剔除 1 個/.test(ic.txt) && /今日快照已存/.test(ic.txt));
  ok('情報卡：固定顯示「不計入任何分數」', /不計入任何分數/.test(ic.txt));
  // 換股競態：2330 的結果晚到時，畫面已經換成 2317，不可把 2330 的判讀蓋上去
  intelDelay = 800;
  await pg.evaluate(() => { window._intelRace = loadIntelCard({ code: '2331', currency: 'TWD', chip: null }); window._activeCode = '2317'; });
  await pg.waitForTimeout(1200);
  ic = await intelText();
  ok('情報卡：換股後丟棄遲到的結果', !/共振|法說上修/.test(ic.txt), ic.txt.slice(0, 60));
  intelDelay = 0;
  // 舊版後端（沒有 intel 端點，回一般股票資料）→ 要講清楚是後端沒更新
  const good = intelResp; intelResp = { ok: true, price: 1, closes: [1, 2] };
  await pg.evaluate(() => { window._activeCode = '2303'; return loadIntelCard({ code: '2303', currency: 'TWD' }); });
  ic = await intelText();
  ok('情報卡：舊版後端→明講需重新部署', /尚未更新到 v168/.test(ic.txt), ic.txt.slice(0, 80));
  intelResp = good;
  await pg.evaluate(() => { window._activeCode = 'AAPL'; return loadIntelCard({ code: 'AAPL', currency: 'USD' }); });
  ok('情報卡：美股不顯示（資料源只有台股）', !(await intelText()).vis);

  ok('掃描流程全程無 JavaScript 錯誤', errs.length === 0, errs.slice(0, 2).join(' | '));
  await b.close(); srv.close();
}

async function browserTests() {
  const chromium = getChromium();
  if (!chromium) { console.log('（找不到 playwright，略過瀏覽器檢查：npm i -D playwright 後再跑一次）'); return; }
  const codes = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4)).slice(0, 12);
  ok('找得到日K測試檔', codes.length >= 3, `找到 ${codes.length} 檔`);
  if (codes.length < 3) return;

  const srv = serveRoot(8791);
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

/* ── 第一部分b：情報面前端判讀（v168）─────────────────────────────────────
   判讀規則寫錯的後果是「講反話」：市場不買單卻顯示共振。每一格都要釘住。 */
function intelFrontTests() {
  const F = new Function('window', fs.readFileSync(path.join(ROOT, 'intel.js'), 'utf8') + '\nreturn { intelVerdict, renderIntel };')({});
  const NOW = Date.now();
  const st = (car, scar, extra = {}) => ({ status: 'ok', car, scar, L: 3, pre: 0, preScar: 0, t0: '20260926', ...extra });
  const J = (tilt, study, o = {}) => ({
    ai: { status: 'ok', summary: '' }, tilt: tilt == null ? null : { tilt, conflict: o.conflict || 0, n: 1 },
    events: [{ title: '法說上修', type: '法說', dir: Math.sign(tilt || 0), mag: 2, conf: 0.8, ids: [0], first: NOW - 3600e3, study }],
    items: [{ kind: 'news', title: 'x', src: 's', url: 'https://a.b', t: NOW - 3600e3 }], attention: o.att || {}, srcErrors: [], notes: [] });
  const chip = (f, t, n5 = 5) => ({ chip: { foreign5: f, trust5: t, n5 } });
  const V = (j, d) => F.intelVerdict(j, d);

  let v = V(J(0.8, st(0.05, 3)), chip(1000, 200));
  ok('情報判讀：偏多＋CAR顯著正＋法人買→共振', v.tone === 'bull' && /共振/.test(v.head) && /法人同向/.test(v.head), v.head);
  v = V(J(0.8, st(0.05, 3)), chip(-3000, 100));
  ok('情報判讀：利多已反映但法人賣→利多出盡警示', v.tone === 'warn' && /利多出盡/.test(v.head), v.head);
  v = V(J(0.8, st(-0.04, -2.5)), chip(0, 0));
  ok('情報判讀：偏多但CAR顯著負→背離（市場不買單）', v.tone === 'warn' && /背離/.test(v.head) && /不買單/.test(v.head), v.head);
  v = V(J(0.8, st(0.01, 0.8)), chip(500, 0));
  ok('情報判讀：偏多但反應不顯著→不可說成共振', v.tone === 'info' && /尚未顯著反應/.test(v.head) && /法人已同向/.test(v.head), v.head);
  v = V(J(0.8, { status: 'pending' }), chip(0, 0));
  ok('情報判讀：消息在收盤後→明講市場尚未交易', /尚未交易/.test(v.head), v.head);
  v = V(J(-0.7, st(-0.05, -3)), chip(-100, -50));
  ok('情報判讀：偏空＋CAR顯著負→空方共振', v.tone === 'bear' && /利空已被市場確認/.test(v.head), v.head);
  v = V(J(-0.7, st(0.04, 2.4)), chip(0, 0));
  ok('情報判讀：偏空但CAR顯著正→利空不跌', /利空不跌/.test(v.head), v.head);
  v = V(J(0.1, st(0.05, 3)), chip(0, 0));
  ok('情報判讀：傾向太弱→中性，不硬給方向', v.tone === 'neutral', v.head);
  v = V(J(0.8, st(0.05, 3)), chip(-3000, 0, 2));
  ok('情報判讀：法人資料不足3日時不拿來判讀', v.tone === 'bull' && !/法人/.test(v.head), v.head);
  const noAi = J(null, st(0.03, 2.2)); noAi.ai = { status: 'no-key' }; noAi.events[0].type = '重大訊息'; noAi.events[0].title = '董事會決議配息';
  v = V(noAi, chip(0, 0));
  ok('情報判讀：無AI→只講官方公告的市場反應', v.tone === 'neutral' && /董事會決議配息/.test(v.head) && /顯著/.test(v.head) && /AI 未啟用/.test(v.sub), v.head);
  v = V(J(0.8, st(0.01, 0.5, { pre: 0.06, preScar: 2.8 })), chip(0, 0));
  ok('情報判讀：事前已顯著異常→加註可能早被交易', v.notes.some(n => /早已被交易/.test(n)));
  v = V(J(0.8, st(0.01, 0.5), { att: { ptt: { n: 10, bull: 9, bear: 1 } } }), chip(0, 0));
  ok('情報判讀：PTT一面倒→標為擁擠風險而非方向', v.notes.some(n => /擁擠/.test(n) && /不是方向訊號/.test(n)));
  v = V(J(0.8, st(0.01, 0.5), { att: { news: { saturated: true, n: 60 } } }), chip(0, 0));
  ok('情報判讀：新聞截斷→明講無法算倍數', v.notes.some(n => /上限/.test(n)));
  const tr = J(0.8, st(0.05, 3)); tr.events.unshift({ title: '股價大漲', type: '股價走勢報導', dir: 1, mag: 3, conf: 1, ids: [0], first: NOW, study: st(0.09, 5) });
  v = V(tr, chip(0, 0));
  ok('情報判讀：主要事件不取「股價走勢報導」', /法說上修/.test(v.sub), v.sub);

  // XSS：標題與網址來自新聞與PTT（任何人都能發文）
  const bad = J(0.8, st(0.05, 3));
  bad.items = [{ kind: 'ptt', title: '<img src=x onerror=alert(1)>', src: 'PTT<b>', url: 'javascript:alert(1)', t: NOW }];
  bad.events[0].title = '<script>alert(1)</script>';
  bad.ai.summary = '重點<svg onload=alert(1)>[0]';
  const html = F.renderIntel(bad, chip(0, 0));
  ok('情報卡：外部標題完整跳脫（防 XSS）', !/<img|<script|<svg/i.test(html) && /&lt;img/.test(html));
  ok('情報卡：javascript: 連結不輸出', !/javascript:/i.test(html));
  const amp = J(0.8, st(0.05, 3)); amp.items[0].title = '台積電 & 蘋果';
  ok('情報卡：& 正確顯示而非被刪掉', F.renderIntel(amp, chip(0, 0)).includes('台積電 &amp; 蘋果'));
  const trendJ = J(0.8, st(0.05, 3)); trendJ.events.push({ title: '股價創高', type: '股價走勢報導', dir: 1, mag: 1, conf: 0.5, ids: [0], first: NOW });
  const trendH = F.renderIntel(trendJ, chip(0, 0));
  ok('情報卡：走勢報導不用漲跌箭頭、標明不計入方向', /○<\/span>\s*<span[^>]*>股價創高/.test(trendH) && /不計入方向/.test(trendH));
  ok('情報卡：固定標示「未經回測・不計入任何分數」', /未經回測・不計入任何分數/.test(F.renderIntel(amp, chip(0, 0))));
  const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  ok('EVIDENCE 將情報面列為 tier U、權重 0', /intel:\s*\{\s*tier:\s*'U',\s*w:\s*0\b/.test(cfg));
  const others = fs.readdirSync(ROOT).filter(f => /\.js$/.test(f) && !['intel.js', 'selftest.js', 'app.js', 'worker.js'].includes(f));
  const leak = others.filter(f => /intelVerdict|\.tilt\b|_intelCache/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  ok('其他模組沒有讀情報結果（確保不會偷偷進分數）', leak.length === 0, leak.join(','));
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
  new Function('module', src + '\nmodule.yahooChart=yahooChart;module.fetchRangeOHLC=fetchRangeOHLC;module.fetchHistUntil=fetchHistUntil;module.fetchTaiwanChip=fetchTaiwanChip;module.fetchTaifexFutures=fetchTaifexFutures;module.fetchTaifexPCR=fetchTaifexPCR;module.fetchMargin=fetchMargin;module.fetchTopPool=fetchTopPool;module.rocToYmd=rocToYmd;module.eventStudy=eventStudy;module.attention=attention;module.infoTilt=infoTilt;module.validateAI=validateAI;module.parseRSS=parseRSS;module.parsePTT=parsePTT;module.parseAnnounce=parseAnnounce;module.fetchIntel=fetchIntel;module.dropIntraday=dropIntraday;')(W);
  const W2 = W;

  // Code.gs：補上 GAS 全域物件
  const pad = n => String(n).padStart(2, '0');
  let gsFetch = () => ({ getResponseCode: () => 200, getContentText: () => '{}' });
  global.UrlFetchApp = { fetch: (...a) => gsFetch(...a) };
  let gsProps = {};
  global.PropertiesService = { getUserProperties: () => ({ getProperty: () => null, setProperty: () => {} }),
    getScriptProperties: () => ({ getProperty: k => gsProps[k] || null }) };
  global.ContentService = { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 1 } };
  global.Utilities = { sleep() {}, formatDate(d, tz, fmt) {
    const x = new Date(d.getTime() + (tz === 'Asia/Taipei' ? 8 * 3600000 : 0));
    if (fmt === 'u') return String(x.getUTCDay() === 0 ? 7 : x.getUTCDay());
    const y = x.getUTCFullYear(), m = pad(x.getUTCMonth() + 1), dd = pad(x.getUTCDate());
    return fmt === 'yyyy-MM-dd' ? `${y}-${m}-${dd}` : `${y}${m}${dd}`;
  } };
  const G = {};
  new Function('module', fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8') + '\nmodule.fetchYahoo=fetchYahoo;module.fetchYahooTW=fetchYahooTW;module.fetchRangeOHLC=fetchRangeOHLC;module.fetchHistUntil=fetchHistUntil;module.fetchTaiwanChip=fetchTaiwanChip;module.fetchTopPool=fetchTopPool;module.rocToYmd=rocToYmd;module.eventStudy=eventStudy;module.attention=attention;module.infoTilt=infoTilt;module.validateAI=validateAI;module.parseRSS=parseRSS;module.parsePTT=parsePTT;module.parseAnnounce=parseAnnounce;module.fetchIntel=fetchIntel;module.dropIntraday=dropIntraday;')(G);

  // twseGet 會先讀 resp.text()；測試替身統一用 jt() 同時提供 text 與 json
  const jt = o => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
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

  // ①b 用「Yahoo 實際回傳」驗證時間戳慣例（2330.TW，2026-09-22 取得）：
  //     台股日K的時間戳＝當日 09:00 台北＝01:00Z。period2 用 T23:59:59Z 即可涵蓋當天，
  //     這是「不再多加一天」那個修正所依賴的前提，這裡把它釘住。
  {
    const REAL = { chart: { result: [{ meta: { shortName: 'TSMC', gmtoffset: 28800, exchangeTimezoneName: 'Asia/Taipei' },
      timestamp: [1789520400, 1789606800, 1789693200, 1789952400, 1790038800],
      indicators: { quote: [{ high: [2395, 2445, 2460, 2485, 2510], open: [2375, 2405, 2460, 2445, 2505],
        volume: [17989104, 16009127, 35352856, 14553960, 6106892], close: [2380, 2425, 2460, 2480, 2490],
        low: [2375, 2400, 2435, 2445, 2490] }], adjclose: [{ adjclose: [2380, 2425, 2460, 2480, 2490] }] } }] } };
    const everyAt0100Z = REAL.chart.result[0].timestamp.every(t => new Date(t * 1000).toISOString().slice(11) === '01:00:00.000Z');
    ok('台股日K時間戳為 01:00Z（period2 修正的前提）', everyAt0100Z);
    fetchImpl = async () => ({ ok: true, json: async () => REAL });
    const rd = await W.yahooChart('2330.TW', '5d', '1d');
    ok('實際回傳的 lastDate 正確', rd.lastDate === '20260922', rd.lastDate);
    ok('實際回傳的昨收正確（今日為未完成K棒）', rd.prevClose === 2480, String(rd.prevClose));
  }

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
  fetchImpl = async u => { asked.push(dOf(u)); return jt(T86); };
  await W.fetchTaiwanChip('2330');
  const newest = asked.sort().slice(-1)[0];
  fetchImpl = async u => jt(dOf(u) === newest ? HOL : T86);
  const ch = await W.fetchTaiwanChip('2330');
  ok('worker 假日不算籌碼缺漏', ch.headMiss === 0, `headMiss=${ch.headMiss}`);
  ok('worker 假日時 expected 往前推', ch.expected === ch.dataDate, `${ch.expected}/${ch.dataDate}`);
  fetchImpl = async u => (dOf(u) === newest ? { ok: false, status: 500, text: async () => '' } : jt(T86));
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

  // ⑦ 期交所／融資融券：不得假設「陣列最後一筆＝最新」，假日不得算成失敗
  {
    const mod = W2;
    const two = [{ Date: '20260918', ContractName: '臺股期貨', IdentityType: '外資', OpenInterestNetAmount: '100' },
                 { Date: '20260918', ContractName: '臺股期貨', IdentityType: '投信', OpenInterestNetAmount: '50' },
                 { Date: '20260917', ContractName: '臺股期貨', IdentityType: '外資', OpenInterestNetAmount: '999' },
                 { Date: '20260917', ContractName: '臺股期貨', IdentityType: '投信', OpenInterestNetAmount: '888' }];
    // 故意用降冪（最新在最前面）餵進去：舊寫法會取到最舊那天，而且跨日累加
    const jr0 = o => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
    fetchImpl = async () => jr0(two.slice().sort((a, b) => a.Date < b.Date ? 1 : -1));
    const fut = await mod.fetchTaifexFutures();
    ok('台指期只採最新日期（順序不影響）', fut.date === '20260918' && fut.foreignNet === 100 && fut.institutionNet === 150,
      `date=${fut.date} foreign=${fut.foreignNet} total=${fut.institutionNet}`);
    /* 以下用「期交所實際回傳」當測資（2026-09-22 取得）：
       ① 順序是日期降冪（最新在第一筆）——舊寫法 arr[arr.length-1] 會拿到最舊的 20260824
       ② 真實欄名是 PutCallOIRatio% / PutCallVolumeRatio%，不是程式原本猜的
          PutCallRatioOfOpenInterest——對不上就永遠是 0，而且完全不會報錯 */
    const PCR_REAL = [
      { Date: '20260921', PutVolume: '156156', CallVolume: '124823', 'PutCallVolumeRatio%': '125.10', PutOI: '59117', CallOI: '61452', 'PutCallOIRatio%': '96.20' },
      { Date: '20260918', PutVolume: '329902', CallVolume: '332047', 'PutCallVolumeRatio%': '99.35', PutOI: '35415', CallOI: '46401', 'PutCallOIRatio%': '76.32' },
      { Date: '20260824', PutVolume: '116587', CallVolume: '109801', 'PutCallVolumeRatio%': '106.18', PutOI: '50982', CallOI: '53212', 'PutCallOIRatio%': '95.81' }];
    const jr = o => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
    fetchImpl = async () => jr(PCR_REAL);
    const pcr = await mod.fetchTaifexPCR();
    ok('PCR 取到真正的最新日期（實際為降冪）', pcr.pcrDate === '20260921', String(pcr.pcrDate));
    ok('PCR 未平倉比率有值（欄名對得上）', pcr.pcrOI === 96.20, String(pcr.pcrOI));
    ok('PCR 成交量比率有值', pcr.pcrVol === 125.10, String(pcr.pcrVol));
    // 欄名若又被改掉，要能用 PutOI/CallOI 自己算出來，而不是回 0
    fetchImpl = async () => jr([{ Date: '20260921', PutOI: '59117', CallOI: '61452', PutVolume: '156156', CallVolume: '124823' }]);
    const pcr2 = await mod.fetchTaifexPCR();
    ok('PCR 欄名改變仍能自己算', Math.abs(pcr2.pcrOI - 96.20) < 0.01, String(pcr2.pcrOI));
    /* 台指期：以下為期交所實際回傳的欄位與數值（2026-09-22 取得）。
       欄名是 ContractCode / Item / OpenInterest(Net)，與程式原先猜的三個名稱全都不同。
       另外刻意保留「電子期貨」與金額欄，確保：
         ① 只取臺股期貨，不把其他契約也加進來
         ② 取到的是口數 OpenInterest(Net)，不是同列的契約金額（差三個數量級） */
    const FUT_REAL = [
      { Date: '20260921', ContractCode: '臺股期貨', Item: '自營商', 'OpenInterest(Net)': '-3354', 'ContractValueofOpenInterest(Net)(Thousands)': '-32229030' },
      { Date: '20260921', ContractCode: '臺股期貨', Item: '投信', 'OpenInterest(Net)': '74019', 'ContractValueofOpenInterest(Net)(Thousands)': '711367002' },
      { Date: '20260921', ContractCode: '臺股期貨', Item: '外資及陸資', 'OpenInterest(Net)': '-74081', 'ContractValueofOpenInterest(Net)(Thousands)': '-712023417' },
      { Date: '20260921', ContractCode: '電子期貨', Item: '外資及陸資', 'OpenInterest(Net)': '-63', 'ContractValueofOpenInterest(Net)(Thousands)': '-765349' },
      { Date: '20260921', ContractCode: '小型臺指期貨', Item: '外資及陸資', 'OpenInterest(Net)': '5667', 'ContractValueofOpenInterest(Net)(Thousands)': '13616560' }];
    fetchImpl = async () => jr(FUT_REAL);
    const futReal = await mod.fetchTaifexFutures();
    ok('外資台指期淨未平倉＝實際值 -74081', futReal && futReal.foreignNet === -74081, JSON.stringify(futReal && futReal.foreignNet));
    ok('三大法人合計＝-3354+74019-74081', futReal && futReal.institutionNet === -3416, String(futReal && futReal.institutionNet));
    ok('台指期資料日期正確', futReal && futReal.date === '20260921', String(futReal && futReal.date));
    // 欄名完全對不上時必須回 null（0 會被前端當成「外資偏空」的真訊號）
    fetchImpl = async () => jr([{ Date: '20260921', ContractCode: '臺股期貨', Item: '外資及陸資', SomeUnknownField: '123' }]);
    const futBad = await mod.fetchTaifexFutures();
    ok('台指期欄名對不上時回 null，不假裝中性', futBad === null || futBad.foreignNet === null, JSON.stringify(futBad));
    const MARGN = { stat: 'OK', fields: ['股票代號', '名稱', '融資買進', '融資賣出', '現金償還', '融資前日餘額', '融資今日餘額', '融資限額', '融券買進', '融券賣出', '現券償還', '融券前日餘額', '融券今日餘額'], data: [['2330', '台積電', '0', '0', '0', '0', '1,000', '0', '0', '0', '0', '0', '100']] };
    let mAsked = [];
    fetchImpl = async u => { mAsked.push(dOf(u)); return jt(MARGN); };
    await mod.fetchMargin('2330');
    const mNewest = mAsked.sort().slice(-1)[0];
    fetchImpl = async u => jt(dOf(u) === mNewest ? { stat: '很抱歉，沒有符合條件的資料!' } : MARGN);
    const mg = await mod.fetchMargin('2330');
    ok('融資融券：假日不算缺漏', mg.headMiss === 0, `headMiss=${mg.headMiss}`);
    fetchImpl = async u => (dOf(u) === mNewest ? { ok: false, status: 500, text: async () => '' } : jt(MARGN));
    ok('融資融券：真失敗仍算缺漏', (await mod.fetchMargin('2330')).headMiss > 0);
  }

  // ⑦a 端點名稱必須與期交所官方 OAS 清單一致（打錯字＝對方導回目錄頁，整個維度靜默消失）
  {
    const wk = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    const gs = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
    // 只檢查真正發出去的網址（註解裡提到舊名不算）
    const GOOD = /taifex\.com\.tw\/v1\/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate/;
    const BAD = /taifex\.com\.tw\/v1\/\w*AsSpecificFuturesContract\w*/;
    ok('worker 三大法人端點名稱正確', GOOD.test(wk) && !BAD.test(wk));
    ok('GAS 三大法人端點名稱正確（端點對等）', GOOD.test(gs) && !BAD.test(gs));
    ok('PCR 端點名稱正確', wk.includes('/v1/PutCallRatio') && gs.includes('/v1/PutCallRatio'));
  }

  // ⑦b 來源死掉時不可以靜默消失（期交所端點路徑已證實會導回 API 目錄頁 HTML）
  {
    fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><html>swagger</html>', json: async () => { throw new Error('Unexpected token <'); } });
    let why = '';
    try { await W2.fetchTaifexFutures(); } catch (e) { why = String(e.message || e); }
    ok('端點回傳網頁時給得出可辨識原因', /網頁而非 JSON|路徑可能已變更/.test(why), why);
    const mk = fs.readFileSync(path.join(ROOT, 'market.js'), 'utf8');
    ok('大盤卡片會列出失效來源', /sourceErrors/.test(mk) && /這些來源這次沒拿到/.test(mk));
    const wk = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    ok('worker 會回傳 sourceErrors', /out\.sourceErrors = srcErr/.test(wk));
    const gs = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
    ok('GAS 會回傳 sourceErrors（端點對等）', /out\.sourceErrors = srcErr/.test(gs));
  }

  // ⑦c 復活的維度不得在未驗證下就開始影響分數
  {
    const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
    ok('config 已登記 twFutures / pcr 為未驗證', /twFutures:\s*\{[^}]*w:\s*0/.test(cfg) && /\bpcr:\s*\{[^}]*w:\s*0/.test(cfg));
    ok('config 提供 evScorable 開關', /function evScorable/.test(cfg));
    for (const [f, k] of [['enhance.js', 'twFutures'], ['enhance.js', 'pcr'], ['quant.js', 'pcr'], ['smc.js', 'pcr']]) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      ok(`${f} 的 ${k} 已受 EVIDENCE 控制`, new RegExp(`evScorable\\('${k}'\\)`).test(src));
    }
  }

  // ⑦b2 檔案版本宣告必須與 config.js 的 FILE_VERS 完全一致（否則舊版偵測會誤報或漏報）
  {
    const cfgSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
    const m = cfgSrc.match(/const FILE_VERS = \{([^}]*)\}/);
    ok('config.js 有 FILE_VERS 表', !!m);
    if (m) {
      const want = {};
      for (const mm of m[1].matchAll(/'([\w.]+)':\s*(\d+)/g)) want[mm[1]] = +mm[2];
      const bad = [];
      for (const [f, v] of Object.entries(want)) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const d = src.match(/SR_FV[^)]*\)\['([\w.]+)'\]\s*=\s*(\d+)/);
        if (!d) bad.push(`${f} 未宣告版本`);
        else if (d[1] !== f) bad.push(`${f} 宣告成 ${d[1]}`);
        else if (+d[2] !== v) bad.push(`${f} 宣告 v${d[2]} 但 FILE_VERS 寫 v${v}`);
      }
      ok('每個前端檔的版本宣告都與 FILE_VERS 相符', bad.length === 0, bad.join('；'));
      const files = fs.readdirSync(ROOT).filter(f => /\.js$/.test(f) && !['selftest.js', 'worker.js', 'backtest_conditional.js', 'backtest_standalone.js', 'config.js', 'sw.js'].includes(f));
      const notListed = files.filter(f => !(f in want));
      ok('所有前端 js 都列進 FILE_VERS', notListed.length === 0, notListed.join('、'));
    }
    const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    ok('app.js 會偵測並點名舊版檔案', /站上 v\$\{got\}，應為 v\$\{want\}/.test(appSrc));
    // v164：橫幅不得用 fixed 蓋住標題列（它叫人去按的按鈕就在標題列裡），且必須自帶清除快取按鈕
    ok('提示橫幅不會蓋住標題列', /insertBefore\(bar, document\.body\.firstChild\)/.test(appSrc) && !/bar\.style\.cssText = 'position:fixed;top:0/.test(appSrc));
    ok('提示橫幅自帶「清除快取」按鈕', /onclick="forceUpdateApp\(\)"/.test(appSrc));
    /* v165：內建池的死代碼要能自動略過，但必須①連續兩次才除名（避免限流誤殺）
       ②只認「查無K線」③略過要明講並可復原（不能變成另一種靜默） */
    const scanSrc = fs.readFileSync(path.join(ROOT, 'scan.js'), 'utf8');
    ok('死代碼需連續2次才自動略過', /dead\[c\] >= 2/.test(scanSrc));
    ok('只有「查無K線」才計入死代碼', /查無K線\|查無此代碼/.test(scanSrc) && !/不足60日[\s\S]{0,40}deadTrack/.test(scanSrc));
    ok('略過的代碼會明講並可復原', /已自動略過/.test(scanSrc) && /function resetDead/.test(scanSrc));
  }

  // ⑦c1 TWSE 路徑失效時要能自動換路徑，而不是整個維度靜默消失
  {
    const T86ok = { stat: 'OK', fields: ['證券代號', '證券名稱', '外陸資買賣超股數(不含外資自營商)', '外資自營商買賣超股數', '投信買賣超股數', '自營商買賣超股數'], data: [['2330', '台積電', '1,000,000', '0', '500,000', '100,000']] };
    const seen = [];
    // 模擬使用者實測到的情況：/exchange/ 與 /fund/ 皆 404，只有新版 /rwd/zh/ 可用
    fetchImpl = async u => {
      seen.push(new URL(u).pathname);
      if (!/^\/rwd\/zh\//.test(new URL(u).pathname)) return { ok: false, status: 404, text: async () => 'Not Found' };
      return { ok: true, status: 200, text: async () => JSON.stringify(T86ok) };
    };
    const c = await W2.fetchTaiwanChip('2330');
    ok('舊路徑 404 時會自動改用可用路徑', !!c && c.days > 0, `days=${c && c.days}`);
    ok('找到可用路徑後不再重複試錯', seen.filter(x => !/^\/rwd\/zh\//.test(x)).length <= 3, `試錯次數 ${seen.filter(x => !/^\/rwd\/zh\//.test(x)).length}`);
    // 全部路徑都死 → 必須丟出列出每個路徑結果的錯誤，不可默默回空
    fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
    let mErr = '';
    try { await W2.fetchMargin('2330'); } catch (e) { mErr = String(e.message || e); }
    ok('全部路徑失效時給得出可辨識錯誤', /所有已知路徑都失敗|無融資融券資料/.test(mErr), mErr.slice(0, 70));
    // 非交易日（stat 非 OK）不可被誤判成路徑失效
    fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!' }) });
    let hErr = '';
    try { const ch = await W2.fetchTaiwanChip('2330'); hErr = ch === null ? 'null（無任何交易日資料，合理）' : 'ok'; } catch (e) { hErr = 'THREW:' + e.message; }
    ok('非交易日不被誤判成路徑失效', !/THREW.*所有已知路徑/.test(hErr), hErr.slice(0, 50));
    const wk4 = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    const gs4 = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
    ok('兩個後端都不再寫死 /exchange/ 路徑', !/twse\.com\.tw\/exchange\/(MI_MARGN|BWIBBU_d)/.test(wk4) && !/twse\.com\.tw\/exchange\/(MI_MARGN|BWIBBU_d)/.test(gs4));
  }

  // ⑦c1b 已用瀏覽器實測可用的 TWSE 路徑必須排第一順位；且欄名對不上時絕不可用位置猜
  {
    const wk5 = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    const gs5 = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
    ok('MI_MARGN 首選為實測可用路徑', /MI_MARGN: \['rwd\/zh\/marginTrading\/MI_MARGN'/.test(wk5));
    ok('BWIBBU_d 首選為實測可用路徑', /BWIBBU_d: \['rwd\/zh\/afterTrading\/BWIBBU_d'/.test(wk5));
    ok('兩個後端都已移除寫死的欄位索引', !/iMar = 6|iShort = 12|iY = 2, iPE = 4/.test(wk5) && !/iMar = 6|iShort = 12|iY = 2, iPE = 4/.test(gs5));
    // 欄名完全不符時：必須丟出說得出原因的錯誤，而不是回一個看似正常的數字
    const BAD = { stat: 'OK', fields: ['股票代號', '名稱', '甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸', '子'], data: [['2330', '台積電', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']] };
    fetchImpl = async () => jt(BAD);
    let bErr = '';
    try { await W2.fetchMargin('2330'); } catch (e) { bErr = String(e.message || e); }
    ok('融資欄名對不上時明講而非給錯數字', /欄位對不上/.test(bErr), bErr.slice(0, 60));
  }

  // ⑦c2 T86 欄位：用 TWSE 實際回傳核對（2026-09-22），並確保不會抓到「外資自營商」那欄
  {
    const REAL_F = ['證券代號', '證券名稱',
      '外陸資買進股數(不含外資自營商)', '外陸資賣出股數(不含外資自營商)', '外陸資買賣超股數(不含外資自營商)',
      '外資自營商買進股數', '外資自營商賣出股數', '外資自營商買賣超股數',
      '投信買進股數', '投信賣出股數', '投信買賣超股數',
      '自營商買賣超股數', '自營商買進股數(自行買賣)', '自營商賣出股數(自行買賣)', '自營商買賣超股數(自行買賣)',
      '自營商買進股數(避險)', '自營商賣出股數(避險)', '自營商買賣超股數(避險)', '三大法人買賣超股數'];
    // 2330 當日實際數值（單位：股）
    const ROW = ['2330', '台積電　', '9,832,887', '7,143,383', '2,689,504', '0', '0', '0',
      '928,551', '193,945', '734,606', '614,602', '454,602', '16,050', '438,552', '217,302', '41,252', '176,050', '4,038,712'];
    const realT86 = { stat: 'OK', fields: REAL_F, data: [ROW] };
    const dOf3 = u => new URL(u).searchParams.get('date');
    fetchImpl = async () => jt(realT86);
    const cr = await W2.fetchTaiwanChip('2330');
    ok('T86 外資＝2,689.5張（實際欄名對得上）', Math.abs(cr.foreign1 - 2689.504) < 0.01, String(cr.foreign1));
    ok('T86 投信＝734.6張', Math.abs(cr.trust1 - 734.606) < 0.01, String(cr.trust1));
    // 欄位順序若調換，仍不可抓到「外資自營商買賣超股數」（那欄幾乎天天為0）
    const swapped = REAL_F.slice(), rowS = ROW.slice();
    [swapped[4], swapped[7]] = [swapped[7], swapped[4]];
    [rowS[4], rowS[7]] = [rowS[7], rowS[4]];
    fetchImpl = async () => jt({ stat: 'OK', fields: swapped, data: [rowS] });
    const cs = await W2.fetchTaiwanChip('2330');
    ok('T86 欄位順序調換後外資仍正確（不會抓到外資自營商）', Math.abs(cs.foreign1 - 2689.504) < 0.01, String(cs.foreign1));
    const wk3 = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    const gs3 = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
    ok('兩個後端都用實際欄名比對外資（端點對等）',
      wk3.includes('外陸資買賣超股數(不含外資自營商)') && gs3.includes('外陸資買賣超股數(不含外資自營商)'));
  }

  // ⑦d 時間上限不得造成「靜默的錯答案」：N日累計必須誠實回報實際天數
  {
    const T86b = { stat: 'OK', fields: ['證券代號', '證券名稱', '外資及陸資買賣超股數', '投信買賣超股數', '自營商買賣超股數'], data: [['2330', '台積電', '1,000,000', '500,000', '100,000']] };
    const dOf2 = u => new URL(u).searchParams.get('date');
    // 只讓最新 8 個交易日有資料，其餘回非交易日 → 20日累計實際只有 8 天
    let seen8 = [];
    fetchImpl = async u => { seen8.push(dOf2(u)); return jt(T86b); };
    await W2.fetchTaiwanChip('2330');
    const newest8 = seen8.sort().slice(-8);
    fetchImpl = async u => jt(newest8.includes(dOf2(u)) ? T86b : { stat: '很抱歉，沒有符合條件的資料!' });
    const c8 = await W2.fetchTaiwanChip('2330');
    ok('籌碼回報 5日/20日實際天數', c8.n5 === 5 && c8.n20 === 8, `n5=${c8.n5} n20=${c8.n20} days=${c8.days}`);
    ok('20日累計＝實際天數的加總（不冒充20天）', c8.foreign20 === 1000 * 8, String(c8.foreign20));

    // 融資：資料不足6筆時要回報實際跨距，不能一律叫「5日變化」
    const MG = n => ({ stat: 'OK', fields: ['股票代號', '名稱', '融資買進', '融資賣出', '現金償還', '融資前日餘額', '融資今日餘額', '融資限額', '融券買進', '融券賣出', '現券償還', '融券前日餘額', '融券今日餘額'], data: [['2330', '台積電', '0', '0', '0', '0', String(n), '0', '0', '0', '0', '0', '100']] });
    let mSeen = [];
    fetchImpl = async u => { mSeen.push(dOf2(u)); return jt(MG(1000)); };
    await W2.fetchMargin('2330');
    const mNew3 = mSeen.sort().slice(-3);
    fetchImpl = async u => jt(mNew3.includes(dOf2(u)) ? MG(1000) : { stat: '很抱歉，沒有符合條件的資料!' });
    const m3 = await W2.fetchMargin('2330');
    ok('融資回報實際跨距 chg5N', m3.chg5N === 2, `chg5N=${m3.chg5N} days=${m3.days}`);

    // 原始碼層級：確保這些防線沒有被改回去
    const wk2 = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    const cfg2 = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
    const en2 = fs.readFileSync(path.join(ROOT, 'enhance.js'), 'utf8');
    const bf2 = fs.readFileSync(path.join(ROOT, 'bingfa.js'), 'utf8');
    ok('籌碼預算 ≥30 秒', /const BUDGET = (\d+)/.test(wk2) && +RegExp.$1 >= 30000, RegExp.$1);
    ok('前端逾時 ≥45 秒', /const FE_TIMEOUT = (\d+)/.test(cfg2) && +RegExp.$1 >= 45000, RegExp.$1);
    ok('法人轉向門檻改用實際天數', /chip\.n5 \|\| 5/.test(en2));
    ok('20日不足時會明確警告', /實際只用了 \$\{chip\.n20/.test(en2));
    ok('融資5日跨距不足時不觸發紀律門', /function marginSpanOK/.test(bf2) && (bf2.match(/marginSpanOK\(/g) || []).length >= 5);
  }


  /* ⑨ v166 動態掃描池：池子改由「當日全市場成交金額排行」即時產生 ────────
     這一段對應的真實風險：
       ① 兩個交易所欄名不同（上市 SecuritiesCompanyCode/TransactionAmount、
          上櫃 Code/TradeValue），抄錯任一邊 → 那個市場整個消失且無人察覺。
       ② 回應裡有大量 ETF/特別股/DR（00411A、006201、2887E、912000），
          沒濾掉就會拿去跑個股引擎，結果全是垃圾。
       ③ 日期是民國年，不換算就永遠判不出資料是哪一天。
       ④ 抓不到時若靜默改用寫死清單，使用者會以為自己掃的是今日熱門股。 */
  {
    const twseRows = [   // 取自使用者提供的實際回應結構
      { Date: '1150921', SecuritiesCompanyCode: '00411A', TransactionAmount: '9000000000' },  // ETF：要排除
      { Date: '1150921', SecuritiesCompanyCode: '2887E', TransactionAmount: '8000000000' },   // 特別股：要排除
      { Date: '1150921', SecuritiesCompanyCode: '912000', TransactionAmount: '7000000000' },  // DR：要排除
      { Date: '1150921', SecuritiesCompanyCode: '2330', TransactionAmount: '50000000000' },
      { Date: '1150921', SecuritiesCompanyCode: '2317', TransactionAmount: '30000000000' },
      { Date: '1150921', SecuritiesCompanyCode: '1101', TransactionAmount: '100000000' },
    ];
    const tpexRows = [
      { Date: '1150921', Code: '00400A', Name: '主動國泰動能高息', TradeValue: '513300022' },  // ETF：要排除
      { Date: '1150921', Code: '6488', Name: '環球晶', TradeValue: '40000000000' },
      { Date: '1150921', Code: '5483', Name: '中美晶', TradeValue: '200000000' },
    ];
    const isTwse = u => /openapi\.twse\.com\.tw/.test(String(u));
    fetchImpl = async u => jt(isTwse(u) ? twseRows : tpexRows);
    // 包起來：改壞時要變成一項紅燈，而不是讓整個檢查程式中斷（中斷會看不到其餘項目）
    const tryPool = async n => { try { return await W2.fetchTopPool(n); } catch (e) { return { codes: [], err: String(e.message || e) }; } };
    const pool = await tryPool(4);
    ok('動態池：兩個交易所都取得（欄名各自正確）',
      pool.codes.includes('2330') && pool.codes.includes('6488'), pool.codes.join(','));
    ok('動態池：依成交金額排序取前N',
      pool.codes.join(',') === '2330,6488,2317,5483', pool.codes.join(','));
    ok('動態池：排除 ETF／特別股／DR',
      !pool.codes.some(c => ['00411A', '2887E', '912000', '00400A'].includes(c)), pool.codes.join(','));
    ok('動態池：民國年換算成西元', pool.dataDate === '20260921', pool.dataDate);
    ok('動態池：回報全市場檔數與第N名門檻',
      pool.universe === 5 && pool.cutoff === 200000000, `universe=${pool.universe} cutoff=${pool.cutoff}`);
    ok('rocToYmd 只接受7碼民國日期',
      W2.rocToYmd('1150921') === '20260921' && W2.rocToYmd('20260921') === '' && W2.rocToYmd('') === '');

    // 一邊死掉：必須把「這次排行不含上櫃」講出來，不可當成完整排行
    fetchImpl = async u => isTwse(u) ? jt(twseRows) : ({ ok: false, status: 500, text: async () => 'err' });
    const half = await tryPool(10);
    ok('動態池：單一來源失敗要回報 srcErrors',
      !!(half.srcErrors && /上櫃/.test(half.srcErrors.join(''))), half.err || JSON.stringify(half.srcErrors));

    // 欄名被改掉：不可回空清單靜默，要丟錯並附上實際欄名
    fetchImpl = async () => jt([{ Date: '1150921', code: '2330', amount: '1' }]);
    let fErr = '';
    try { await W2.fetchTopPool(10); } catch (e) { fErr = String(e.message || e); }
    ok('動態池：欄名變更會丟錯並列出實際欄名',
      /欄名/.test(fErr) && /amount/.test(fErr), fErr.slice(0, 90));

    // 兩邊都死：必須丟錯（前端才會走備援並紅字示警），不可回空陣列
    fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
    let pErr = '';
    try { await W2.fetchTopPool(10); } catch (e) { pErr = String(e.message || e); }
    ok('動態池：全部來源失敗必須丟錯', /都取不到清單/.test(pErr), pErr.slice(0, 80));

    // 回傳 HTML（端點搬家）：不可讓 JSON.parse 的錯訊掩蓋真正原因
    fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><html>' });
    let hErr = '';
    try { await W2.fetchTopPool(10); } catch (e) { hErr = String(e.message || e); }
    ok('動態池：回傳網頁時要指出端點可能已變更', /端點可能已變更/.test(hErr), hErr.slice(0, 80));

    // 端點對等：GAS 必須給出與 worker 相同的結果
    gsFetch = u => gsOf(isTwse(u) ? twseRows : tpexRows);
    let gp; try { gp = G.fetchTopPool(4); } catch (e) { gp = { codes: [], dataDate: String(e.message || e) }; }
    ok('GAS 動態池與 worker 結果一致（端點對等）',
      gp.codes.join(',') === pool.codes.join(',') && gp.dataDate === pool.dataDate && gp.cutoff === pool.cutoff,
      `${gp.codes.join(',')} / ${gp.dataDate} / ${gp.cutoff}`);

    // 原始碼層級：備援不得靜默、上限要同步放寬、UI 要有檔數選擇
    const scanSrc2 = fs.readFileSync(path.join(ROOT, 'scan.js'), 'utf8');
    const htmlSrc2 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ok('掃描預設走動態池', /action=pool&n=/.test(scanSrc2) && /await fetchDynamicPool/.test(scanSrc2));
    ok('改用內建備援清單時必須明講', /這次用的是內建備援清單/.test(scanSrc2));
    ok('池子來源說明會顯示在結果上方', /let h = _poolNote/.test(scanSrc2));
    ok('掃描上限已同步放寬到300', /codes\.length > 300/.test(scanSrc2) && !/codes\.length > 130/.test(scanSrc2));
    ok('UI 提供掃描池檔數選擇', /id="scan-pool-n"/.test(htmlSrc2));
  }


  /* ⑩ v168 情報面：每一項都對應一個「會讓使用者被誤導」的具體失效 ─────────── */
  const IT = {};   // 給 GAS 對等測試共用的夾具
  {
    const NOW = Date.now(), H = 3600e3;
    // ── 事件研究：注入已知異常報酬，引擎必須算回來 ──
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const dates = []; let d = new Date('2026-01-05T00:00:00Z');
    while (dates.length < 200) { const w = d.getUTCDay(); if (w && w < 6) dates.push(d.toISOString().slice(0, 10).replace(/-/g, '')); d = new Date(d.getTime() + 864e5); }
    const build = inj => { const m = [100], s = [50];
      for (let i = 1; i < 200; i++) { const rm = gauss() * 0.01; let rs = 0.0002 + 1.3 * rm + gauss() * 0.001;
        for (const [k, a] of inj) if (i === 190 + k) rs += a;
        m.push(m[i - 1] * (1 + rm)); s.push(s[i - 1] * (1 + rs)); }
      return { ser: { dates, closes: s }, mkt: { dates, closes: m } }; };
    const cut = (b, n) => ({ dates: b.ser.dates.slice(0, n), closes: b.ser.closes.slice(0, n) });
    const T = (ymd, hm) => Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hm}:00+08:00`);
    IT.build = build; IT.cut = cut; IT.T = T; IT.dates = dates; IT.reseed = v => { seed = v; };

    seed = 42; let b = build([[0, 0.03], [1, 0.01]]);
    let r = W2.eventStudy(cut(b, 192), b.mkt, T(dates[190], '10:00'));
    ok('事件研究：盤中消息，CAR 還原注入的 +4%', r.status === 'ok' && Math.abs(r.car - 0.04) < 0.005 && r.t0 === dates[190], `t0=${r.t0} CAR=${(r.car * 100).toFixed(2)}%`);
    ok('事件研究：β 估計正確（真值1.3）', Math.abs(r.beta - 1.3) < 0.05, r.beta && r.beta.toFixed(3));
    ok('事件研究：顯著反應 |SCAR|>1.96', r.scar > 1.96, r.scar && r.scar.toFixed(1));
    IT.esIntra = r;

    seed = 42; b = build([[1, 0.03]]);
    r = W2.eventStudy(cut(b, 193), b.mkt, T(dates[190], '14:00'));
    ok('事件研究：13:30後的消息歸到「下一交易日」（防 look-ahead）', r.t0 === dates[191] && r.afterClose === true, `t0=${r.t0}`);
    ok('事件研究：盤後消息的 CAR 從隔日起算', Math.abs(r.car - 0.03) < 0.005, `CAR=${(r.car * 100).toFixed(2)}%`);
    IT.esAfter = r;
    // 邊界：13:15 盤還開著→當天；13:30 收盤那一刻起→隔日。只測 10:00/14:00 抓不到收盤時間寫錯
    ok('事件研究：13:15（盤中）歸當天', W2.eventStudy(cut(b, 193), b.mkt, T(dates[190], '13:15')).t0 === dates[190]);
    ok('事件研究：13:30（收盤）歸隔日', W2.eventStudy(cut(b, 193), b.mkt, T(dates[190], '13:30')).t0 === dates[191]);

    seed = 42; b = build([[-5, 0.008], [-4, 0.008], [-3, 0.008], [-2, 0.008], [-1, 0.008]]);
    r = W2.eventStudy(cut(b, 191), b.mkt, T(dates[190], '10:00'));
    ok('事件研究：抓得到「消息前已先漲」（事前窗顯著）', r.preScar > 1.96 && Math.abs(r.pre - 0.04) < 0.008 && Math.abs(r.car) < 0.005, `pre=${(r.pre * 100).toFixed(2)}% car=${(r.car * 100).toFixed(2)}%`);

    ok('事件研究：消息在最後一根K棒之後→明講市場尚未交易', W2.eventStudy(cut(b, 190), b.mkt, T(dates[190], '10:00')).status === 'pending');
    ok('事件研究：估計窗不足→不硬算', W2.eventStudy(cut(b, 50), b.mkt, T(dates[45], '10:00')).status === 'insufficient');

    // 日期對齊：個股停牌一天，不可與大盤錯位（尾端對齊會把整段報酬錯開一天）
    seed = 42; b = build([[0, 0.03]]);
    const skip = 185, sd2 = { dates: b.ser.dates.filter((_, i) => i !== skip).slice(0, 190), closes: b.ser.closes.filter((_, i) => i !== skip).slice(0, 190) };
    r = W2.eventStudy(sd2, b.mkt, T(dates[190], '10:00'));
    ok('事件研究：按日期對齊（個股停牌一天不會錯位）', r.status === 'ok' && Math.abs(r.car - 0.03) < 0.006, `CAR=${r.car && (r.car * 100).toFixed(2)}%`);

    // 盤中未收K棒要丟掉（與前端 v142 同規則）
    const today = new Date(NOW + 8 * H).toISOString().slice(0, 10).replace(/-/g, '');
    const noon = Date.parse(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}T11:00:00+08:00`);
    const late = Date.parse(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}T15:00:00+08:00`);
    ok('盤中未收K棒不進事件研究', W2.dropIntraday({ dates: ['20200101', today], closes: [1, 2] }, noon).dates.length === 1);
    ok('收盤後當日K棒保留', W2.dropIntraday({ dates: ['20200101', today], closes: [1, 2] }, late).dates.length === 2);

    // ── 新聞 RSS ──
    const pub = t => new Date(t).toUTCString();
    IT.rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>x</title>
<item><title>台積電法說上修全年營收 - 經濟日報</title><link>https://news.google.com/rss/articles/A1</link><pubDate>${pub(NOW - 5 * H)}</pubDate><source url="https://money.udn.com">經濟日報</source></item>
<item><title><![CDATA[台積電 &amp; 蘋果新訂單 - 鉅亨網]]></title><link>https://news.google.com/rss/articles/A2</link><pubDate>${pub(NOW - 30 * H)}</pubDate><source url="https://news.cnyes.com">鉅亨網</source></item>
<item><title>台積電股價大漲5% - 工商時報</title><link>https://news.google.com/rss/articles/A3</link><pubDate>${pub(NOW - 2 * H)}</pubDate><source url="https://ctee.com.tw">工商時報</source></item>
</channel></rss>`;
    const rs = W2.parseRSS(IT.rss);
    ok('新聞RSS：解析標題、去掉尾端媒體名', rs.length === 3 && rs[0].title === '台積電法說上修全年營收' && rs[0].src === '經濟日報', JSON.stringify(rs[0]).slice(0, 80));
    ok('新聞RSS：CDATA 與 &amp; 正確解碼', rs[1].title === '台積電 & 蘋果新訂單', rs[1].title);
    ok('新聞RSS：發布時間正確', Math.abs(rs[0].t - (NOW - 5 * H)) < 1000);
    let rErr = ''; try { W2.parseRSS('<!DOCTYPE html><html>blocked'); } catch (e) { rErr = String(e.message); }
    ok('新聞RSS：回傳網頁時丟錯（不可當成「沒有新聞」）', /不是RSS/.test(rErr), rErr);

    // ── PTT ──
    const ep = h => Math.floor((NOW - h * H) / 1000);
    IT.ptt = `<div class="r-list-container action-bar-margin bbs-screen">
<div class="r-ent"><div class="nrec"><span class="hl f3">35</span></div><div class="title"><a href="/bbs/Stock/M.${ep(3)}.A.1F2.html">[標的] 2330 台積電 多</a></div></div>
<div class="r-ent"><div class="title"><a href="/bbs/Stock/M.${ep(8)}.A.2B3.html">[標的] 2330 台積 空單</a></div></div>
<div class="r-ent"><div class="title"><a href="/bbs/Stock/M.${ep(9)}.A.3C4.html">Re: [標的] 2330 台積電 多</a></div></div>
<div class="r-ent"><div class="title"><a href="/bbs/Stock/M.${ep(20)}.A.4D5.html">[新聞] 台積電(2330)法說會重點</a></div></div>
<div class="r-ent"><div class="title"><a href="/bbs/Stock/M.${ep(40)}.A.5E6.html">[請益] 23300是什麼代號</a></div></div>
</div>`;
    const pt = W2.parsePTT(IT.ptt, '2330');
    ok('PTT：只留標題真的含該代碼的（23300 不算）', pt.length === 4 && !pt.some(x => /23300/.test(x.title)), pt.map(x => x.title).join('|'));
    ok('PTT：[標的] 多/空 直接計數，不需 AI', pt[0].side === 1 && pt[1].side === -1, `${pt[0].side},${pt[1].side}`);
    ok('PTT：回文 Re: 不重複計入多空', pt[2].side === 0);
    ok('PTT：用連結內的時間戳（精確到秒）', Math.abs(pt[0].t - (NOW - 3 * H)) < 1500);
    let pErr = ''; try { W2.parsePTT('<html>Cloudflare challenge</html>', '2330'); } catch (e) { pErr = String(e.message); }
    ok('PTT：被擋或改版時丟錯（不可當成「沒人討論」）', /格式不符/.test(pErr), pErr);

    // ── 重大訊息 ──
    const roc = t => { const x = new Date(t + 8 * H); return String(x.getUTCFullYear() - 1911) + String(x.getUTCMonth() + 1).padStart(2, '0') + String(x.getUTCDate()).padStart(2, '0'); };
    IT.ann = [
      { 出表日期: roc(NOW), 發言日期: roc(NOW - 26 * H), 發言時間: '143005', 公司代號: '2330', 公司名稱: '台積電', 主旨: '本公司董事會決議季配息', 符合條款: '第14款', 事實發生日: roc(NOW - 26 * H), 說明: '1.董事會決議日期' },
      { 出表日期: roc(NOW), 發言日期: roc(NOW - 26 * H), 發言時間: '0930', 公司代號: '2330 ', 公司名稱: '台積電', 主旨: '澄清媒體報導', 符合條款: '第51款', 事實發生日: roc(NOW), 說明: '' },
      { 出表日期: roc(NOW), 發言日期: roc(NOW), 發言時間: '101500', 公司代號: '2317', 公司名稱: '鴻海', 主旨: '其他公司', 符合條款: '', 事實發生日: '', 說明: '' },
    ];
    const an = W2.parseAnnounce(IT.ann, '2330');
    const annD = roc(NOW - 26 * H), annY = String(+annD.slice(0, 3) + 1911) + annD.slice(3);
    ok('重大訊息：只取該公司（代號含空白也對得上）', an.length === 2, String(an.length));
    ok('重大訊息：民國日期＋發言時間→精確時點（HHMMSS）', an[0].t === Date.parse(`${annY.slice(0, 4)}-${annY.slice(4, 6)}-${annY.slice(6, 8)}T14:30:05+08:00`));
    ok('重大訊息：HHMM 格式不會被補成 00:09', new Date(an[1].t + 8 * H).getUTCHours() === 9 && new Date(an[1].t + 8 * H).getUTCMinutes() === 30);
    let aErr = ''; try { W2.parseAnnounce([{ code: '2330', title: 'x' }], '2330'); } catch (e) { aErr = String(e.message); }
    ok('重大訊息：欄名變更時丟錯並列出實際欄名', /欄名不符/.test(aErr) && /code/.test(aErr), aErr);

    // ── 注意力與截斷偵測 ──
    const mk = hs => hs.map(h => ({ t: NOW - h * H }));
    const spread = [1, 2, 3, 30, 50, 55, 75, 80, 100, 120, 125, 145, 150];   // 近24h 3則，之前每日約2則
    const at = W2.attention(mk(spread), NOW, 60);
    ok('注意力：近24h vs 前6日中位數', at.last24 === 3 && at.med === 2 && Math.abs(at.ratio - 1.5) < 1e-9, JSON.stringify(at));
    const sat = W2.attention(mk(Array.from({ length: 60 }, (_, i) => i * 0.8)), NOW, 60);
    ok('注意力：筆數塞滿上限且未涵蓋6日→標記截斷、不給倍數', sat.saturated === true && sat.ratio === undefined, JSON.stringify(sat));

    // ── AI 輸出驗證：幻覺引用必須剔除 ──
    const items5 = [0, 1, 2, 3, 4].map(i => ({ t: NOW - (i + 1) * H, kind: i < 2 ? 'news' : 'ptt' }));
    const va = W2.validateAI({ summary: '市場談法說[1]，另有傳聞[99]。', events: [
      { title: '法說上修', type: '法說', dir: '多', mag: 7, horizon: '中', conf: 5, ids: [0, 1, 99] },
      { title: '憑空捏造', type: '併購合作', dir: '多', mag: 3, horizon: '長', conf: 0.9, ids: [42] },
      { title: '亂分類', type: '外星人', dir: '看漲', mag: 0, horizon: '永遠', conf: -1, ids: [3] },
    ] }, items5);
    ok('AI驗證：引用不存在條目的事件整筆剔除', va.events.length === 2 && va.dropped === 1 && !va.events.some(e => e.title === '憑空捏造'));
    ok('AI驗證：無效引用編號從事件中移除', va.events[0].ids.join() === '0,1');
    ok('AI驗證：摘要中的無效引用被拿掉', va.summary === '市場談法說[1]，另有傳聞。', va.summary);
    ok('AI驗證：數值夾在合法範圍', va.events[0].mag === 3 && va.events[0].conf === 1 && va.events[0].dir === 1);
    ok('AI驗證：非法列舉值改為安全預設', va.events[1].type === '其他' && va.events[1].dir === 0 && va.events[1].horizon === '短' && va.events[1].conf === 0);
    ok('AI驗證：首見時間由程式從條目算，不信 AI', va.events[0].first === items5[1].t);

    // ── 資訊傾向 ──
    const ev = (dir, mag, conf, hAgo, type = '法說') => ({ dir, mag, conf, first: NOW - hAgo * H, type });
    const t1 = W2.infoTilt([ev(1, 3, 1, 1), ev(-1, 1, 0.3, 1), ev(1, 3, 1, 1, '股價走勢報導')], NOW);
    ok('資訊傾向：強度×信心加權', Math.abs(t1.tilt - (3 - 0.3) / 3.3) < 1e-9 && t1.n === 2, JSON.stringify(t1));
    ok('資訊傾向：「股價走勢報導」不計（避免 價格→新聞→情緒 循環論證）', t1.n === 2);
    const t2 = W2.infoTilt([ev(1, 2, 1, 0), ev(-1, 2, 1, 24 * 8)], NOW);
    ok('資訊傾向：舊消息份量按 e^(−age/4日) 遞減', Math.abs(t2.tilt - Math.tanh(1)) < 1e-9, t2.tilt.toFixed(4));   // (1−e⁻²)/(1+e⁻²)=tanh(1)
    ok('資訊傾向：只有走勢報導時回 null（不能硬給方向）', W2.infoTilt([ev(1, 3, 1, 1, '股價走勢報導')], NOW) === null);

    // ── 整條管線（假後端）──
    const yc = (n, drift) => { const ts = [], cl = []; let p = 100;
      for (let i = n; i >= 1; i--) { ts.push(Math.floor((NOW - i * 864e5) / 1000 / 86400) * 86400 + 3600); p *= 1 + drift + Math.sin(i) * 0.01; cl.push(p); }
      return { chart: { result: [{ timestamp: ts, meta: {}, indicators: { quote: [{ close: cl, high: cl, low: cl, open: cl, volume: cl.map(() => 1e6) }], adjclose: [{ adjclose: cl }] } }] } }; };
    IT.yc = yc;
    IT.route = (u, gem) => {
      if (/news\.google\.com/.test(u)) return { txt: IT.rss };
      if (/ptt\.cc/.test(u)) return { txt: IT.ptt };
      if (/t187ap04_L/.test(u)) return { json: IT.ann };
      if (/STOCK_DAY_ALL/.test(u)) return { json: [{ Date: '1150926', SecuritiesCompanyCode: '2330', CompanyName: '台積電', TransactionAmount: '1' }] };
      if (/tpex_mainboard/.test(u)) return { json: [{ Date: '1150926', Code: '6488', Name: '環球晶', TradeValue: '1' }] };
      if (/0050\.TW/.test(u)) return { json: yc(240, 0.0003) };
      if (/finance\/chart\/2330\.TW/.test(u)) return { json: yc(240, 0.0006) };
      if (/generativelanguage/.test(u)) return gem;
      return { status: 404, txt: 'nf' };
    };
    IT.gem = { json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: '市場在談法說上修[0]。', events: [
      { title: '法說上修全年營收', type: '法說', dir: '多', mag: 2, horizon: '中', conf: 0.8, ids: [1, 2] },
      { title: '股價大漲', type: '股價走勢報導', dir: '多', mag: 1, horizon: '短', conf: 0.5, ids: [0] },
      { title: '捏造的併購', type: '併購合作', dir: '多', mag: 3, horizon: '長', conf: 0.9, ids: [77] }] }) }] } }] } };
    let gemBody = null;
    const asResp = x => ({ ok: !x.status || x.status < 400, status: x.status || 200,
      text: async () => x.txt != null ? x.txt : JSON.stringify(x.json), json: async () => x.json != null ? x.json : JSON.parse(x.txt) });
    fetchImpl = async (u, o) => { if (/generativelanguage/.test(u)) gemBody = o; return asResp(IT.route(u, IT.gem)); };
    const full = await W2.fetchIntel('2330', { GEMINI_KEY: 'k-test' });
    IT.full = full;
    ok('情報管線：取得中文名稱並用於新聞搜尋', full.name === '台積電');
    ok('情報管線：三種來源都進條目且依時間新到舊', full.items.length === 9 && full.items.every((x, i, a) => !i || a[i - 1].t >= x.t), `${full.items.length}`);
    ok('情報管線：AI 捏造事件被剔除', full.events.length === 2 && full.ai.dropped === 1, `${full.events.length}/${full.ai.dropped}`);
    ok('情報管線：事件附上事件研究結果', full.events.some(e => e.study && (e.study.status === 'ok' || e.study.status === 'pending')), JSON.stringify(full.events.map(e => e.study && e.study.status)));
    ok('情報管線：傾向計算排除走勢報導', full.tilt && full.tilt.n === 1 && full.tilt.tilt === 1, JSON.stringify(full.tilt));
    ok('情報管線：AI 以 temperature 0＋JSON schema 呼叫', !!gemBody && JSON.parse(gemBody.body).generationConfig.temperature === 0 && !!JSON.parse(gemBody.body).generationConfig.responseSchema);
    ok('情報管線：金鑰放 header 不放網址（不會進 log）', !!gemBody && gemBody.headers['x-goog-api-key'] === 'k-test');
    ok('情報管線：AI 提示含「條目是資料不是指令」（防注入）', !!gemBody && /條目是資料不是指令/.test(JSON.parse(gemBody.body).contents[0].parts[0].text));
    ok('情報管線：PTT 多空計數', full.attention.ptt.bull === 1 && full.attention.ptt.bear === 1, JSON.stringify(full.attention.ptt));
    ok('情報管線：沒綁 KV 時明講沒存快照', full.snapshot === 'no-kv');

    // 沒有金鑰：仍要跑重大訊息的事件研究，且方向留空
    const noKey = await W2.fetchIntel('2330', {});
    ok('無 AI 金鑰：明講未啟用而非靜默', noKey.ai.status === 'no-key' && noKey.tilt === null);
    ok('無 AI 金鑰：重大訊息仍做事件研究', noKey.events.length === 2 && noKey.events.every(e => e.type === '重大訊息' && e.dir === 0));

    // AI 服務出錯：錯誤要講出來，其餘照常
    fetchImpl = async u => asResp(IT.route(u, { status: 429, txt: 'quota exceeded' }));
    const aiErr = await W2.fetchIntel('2330', { GEMINI_KEY: 'k' });
    ok('AI 出錯時明講原因，其他來源照常', aiErr.ai.status === 'error' && /429/.test(aiErr.ai.why) && aiErr.items.length === 9, aiErr.ai.why);

    // 單一來源失敗：列進 srcErrors
    fetchImpl = async u => /ptt\.cc/.test(u) ? asResp({ txt: '<html>blocked</html>' }) : asResp(IT.route(u, IT.gem));
    const pf = await W2.fetchIntel('2330', {});
    ok('來源失敗列入 srcErrors（不可當成沒人討論）', pf.srcErrors.some(x => /PTT/.test(x)) && pf.attention.ptt === null, JSON.stringify(pf.srcErrors));

    // KV 快照
    const kv = {}; fetchImpl = async u => asResp(IT.route(u, IT.gem));
    const ks = await W2.fetchIntel('2330', { SYNC: { put: async (k, v) => { kv[k] = v; } } });
    ok('有綁 KV 時每日存快照（供日後回測）', ks.snapshot === 'saved' && Object.keys(kv).some(k => /^intel:2330:\d{8}$/.test(k)), Object.keys(kv).join());

    /* v168.2 用使用者實際部署的回應校正：Google 新聞對 Cloudflare 回 503、名稱查詢失敗原因被吞、PTT 0 篇無說明 */
    ok('新聞：Yahoo 不可用時改用下一個來源，並回報用了誰', full.newsVia === 'Google新聞', full.newsVia);
    IT.yrss = `<?xml version="1.0"?><rss version="2.0"><channel><title>台積電(2330) - Yahoo股市</title>
<item><title>台積電先進製程接單滿載</title><link>https://tw.stock.yahoo.com/news/a1</link><pubDate>${pub(NOW - 3 * H)}</pubDate></item>
<item><title>晶圓代工價格明年調漲</title><link>https://tw.stock.yahoo.com/news/a2</link><pubDate>${pub(NOW - 9 * H)}</pubDate></item></channel></rss>`;
    const withY = (u, gem) => /tw\.stock\.yahoo\.com\/rss\?s=2330/.test(u) ? { txt: IT.yrss } : IT.route(u, gem);
    fetchImpl = async u => asResp(withY(u, IT.gem));
    const yh = await W2.fetchIntel('2330', {});
    ok('新聞：Yahoo 個股 RSS 可用時優先使用', yh.newsVia === 'Yahoo股市' && yh.items.some(x => x.src === 'Yahoo股市' && /接單滿載/.test(x.title)), yh.newsVia);
    ok('新聞：以頻道標題確認是這檔股票（標題沒寫代碼也收）', yh.items.some(x => /晶圓代工價格/.test(x.title)));
    const generic = `<?xml version="1.0"?><rss version="2.0"><channel><title>Yahoo股市 - 最新新聞</title>
<item><title>美股收盤道瓊上漲</title><link>https://x/1</link><pubDate>${pub(NOW - H)}</pubDate></item></channel></rss>`;
    fetchImpl = async u => asResp(/tw\.stock\.yahoo\.com/.test(u) ? { txt: generic } : IT.route(u, IT.gem));
    const gy = await W2.fetchIntel('2330', {});
    ok('新聞：來源回的是整體新聞（非個股）→ 拒收、改用下一個', gy.newsVia === 'Google新聞' && !gy.items.some(x => /道瓊/.test(x.title)), gy.newsVia);
    fetchImpl = async u => /news\.google\.com|tw\.stock\.yahoo\.com/.test(u) ? asResp({ status: 503, txt: 'x' }) : asResp(IT.route(u, IT.gem));
    const nn = await W2.fetchIntel('2330', {});
    ok('新聞：全部來源都失敗→逐一列出原因', nn.srcErrors.some(x => /Yahoo股市 HTTP 503/.test(x) && /Google新聞 HTTP 503/.test(x)), JSON.stringify(nn.srcErrors));

    // 使用者實測：PTT 回了頁面但 0 篇——必須講出頁面是什麼、看到幾篇
    const emptyPtt = '<html><head><title>看板 Stock 文章列表 - 批踢踢實業坊</title></head><body><div class="r-list-container"></div></body></html>';
    fetchImpl = async u => /ptt\.cc/.test(u) ? asResp({ txt: emptyPtt }) : asResp(IT.route(u, IT.gem));
    const ep0 = await W2.fetchIntel('2330', {});
    ok('PTT 0 篇時說明頁面標題與連結數（被擋 vs 沒人討論）', ep0.notes.some(n => /看板 Stock 文章列表/.test(n) && /共 0 篇/.test(n) && /被擋/.test(n)), JSON.stringify(ep0.notes));
    const otherPtt = `<div class="r-list-container"><div class="r-ent"><a href="/bbs/Stock/M.${ep(2)}.A.AAA.html">[新聞] 聯發科法說</a></div></div>`;
    fetchImpl = async u => /ptt\.cc/.test(u) ? asResp({ txt: otherPtt }) : asResp(IT.route(u, IT.gem));
    const ep1 = await W2.fetchIntel('2330', {});
    ok('PTT 有文章但都不含代碼→講清楚看到幾篇', ep1.notes.some(n => /共 1 篇/.test(n) && !/被擋/.test(n)), JSON.stringify(ep1.notes));
    ok('PTT 連結大小寫與額外屬性都容得下', W2.parsePTT(`<div class="r-ent"><a href="/bbs/stock/M.${ep(1)}.A.1a2.html" class="x">[標的] 2330 台積電 多</a></div>`, '2330').length === 1);

    // 使用者實測：名稱查不到但沒說為什麼——用全新實例（名稱有快取）重現
    const W3 = {};
    new Function('module', src + '\nmodule.fetchIntel=fetchIntel;')(W3);
    fetchImpl = async u => /STOCK_DAY_ALL|tpex_mainboard/.test(u) ? asResp({ status: 403, txt: 'forbidden' }) : asResp(IT.route(u, IT.gem));
    const nm0 = await W3.fetchIntel('2330', {});
    IT.nameFail = nm0;
    ok('中文名稱查不到時列出每個來源的失敗原因', nm0.name === '' && nm0.notes.some(n => /上市 HTTP 403/.test(n) && /上櫃 HTTP 403/.test(n)), JSON.stringify(nm0.notes));
  }


  /* ⑩b 情報面端點對等：同一組夾具丟給 worker 與 GAS，輸出必須一致。
     兩邊各寫一份實作是無可避免的（執行環境不同），這組檢查確保它們不會各自漂移。 */
  {
    const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
      ? Object.keys(v).sort().reduce((o, k) => (v[k] === undefined ? o : (o[k] = canon(v[k]), o)), {}) : v;
    const same = (a, b, path = '') => {   // 數值用相對誤差比，避免 x**2 與 x*x 的最後一位差異造成假紅燈
      if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a)) ? '' : `${path}: ${a} ≠ ${b}`;
      if (Array.isArray(a) || (a && typeof a === 'object')) {
        const ka = Object.keys(a), kb = Object.keys(b || {});
        if (ka.join() !== kb.join()) return `${path}: 欄位不同 [${ka}] vs [${kb}]`;
        for (const k of ka) { const r = same(a[k], b[k], path + '.' + k); if (r) return r; }
        return '';
      }
      return a === b ? '' : `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
    };
    const cmp = (label, a, b) => { const d = same(canon(a), canon(b)); ok('GAS對等：' + label, !d, d); };
    IT.reseed(42); let b = IT.build([[0, 0.03], [1, 0.01]]);
    cmp('事件研究（盤中）', W2.eventStudy(IT.cut(b, 192), b.mkt, IT.T(IT.dates[190], '10:00')), G.eventStudy(IT.cut(b, 192), b.mkt, IT.T(IT.dates[190], '10:00')));
    IT.reseed(42); b = IT.build([[1, 0.03]]);
    cmp('事件研究（盤後）', W2.eventStudy(IT.cut(b, 193), b.mkt, IT.T(IT.dates[190], '14:00')), G.eventStudy(IT.cut(b, 193), b.mkt, IT.T(IT.dates[190], '14:00')));
    cmp('事件研究（13:15 邊界）', W2.eventStudy(IT.cut(b, 193), b.mkt, IT.T(IT.dates[190], '13:15')), G.eventStudy(IT.cut(b, 193), b.mkt, IT.T(IT.dates[190], '13:15')));
    cmp('事件研究（pending）', W2.eventStudy(IT.cut(b, 190), b.mkt, IT.T(IT.dates[190], '10:00')), G.eventStudy(IT.cut(b, 190), b.mkt, IT.T(IT.dates[190], '10:00')));
    cmp('新聞RSS解析', W2.parseRSS(IT.rss), G.parseRSS(IT.rss));
    cmp('PTT解析', W2.parsePTT(IT.ptt, '2330'), G.parsePTT(IT.ptt, '2330'));
    cmp('重大訊息解析', W2.parseAnnounce(IT.ann, '2330'), G.parseAnnounce(IT.ann, '2330'));
    const its = [0, 1, 2].map(i => ({ t: Date.now() - (i + 1) * 3600e3, kind: 'news' }));
    const aiIn = { summary: 'x[0] y[9]', events: [{ title: 'a', type: '法說', dir: '多', mag: 9, horizon: '中', conf: 2, ids: [0, 2, 9] }, { title: 'b', type: '?', dir: '?', mag: 0, horizon: '?', conf: -3, ids: [5] }] };
    cmp('AI輸出驗證', W2.validateAI(aiIn, its), G.validateAI(aiIn, its));

    // 整條管線：兩邊都走同一組假來源
    const now0 = Date.now();
    const gsResp = x => ({ getResponseCode: () => x.status || 200, getContentText: () => x.txt != null ? x.txt : JSON.stringify(x.json) });
    const asResp = x => ({ ok: !x.status || x.status < 400, status: x.status || 200, text: async () => x.txt != null ? x.txt : JSON.stringify(x.json), json: async () => x.json != null ? x.json : JSON.parse(x.txt) });
    fetchImpl = async u => asResp(IT.route(u, IT.gem));
    gsFetch = u => gsResp(IT.route(u, IT.gem));
    gsProps = { GEMINI_KEY: 'k-test' };
    const w = await W2.fetchIntel('2330', { GEMINI_KEY: 'k-test' }), gg = G.fetchIntel('2330');
    const strip = o => { const c = JSON.parse(JSON.stringify(o)); delete c.asOf; delete c.snapshot; return c; };
    cmp('整條情報管線（含AI）', strip(w), strip(gg));
    gsProps = {};
    const w2 = await W2.fetchIntel('2330', {}), g2 = G.fetchIntel('2330');
    cmp('整條情報管線（無金鑰）', strip(w2), strip(g2));
    ok('GAS 無 KV 時明講沒存快照', g2.snapshot === 'no-kv');
    const withY = u => /tw\.stock\.yahoo\.com\/rss\?s=2330/.test(u) ? { txt: IT.yrss } : IT.route(u, IT.gem);
    fetchImpl = async u => asResp(withY(u)); gsFetch = u => gsResp(withY(u));
    cmp('整條情報管線（Yahoo 新聞）', strip(await W2.fetchIntel('2330', {})), strip(G.fetchIntel('2330')));
    const emptyPtt = '<html><head><title>看板 Stock 文章列表</title></head><body><div class="r-list-container"></div></body></html>';
    fetchImpl = async u => /ptt\.cc/.test(u) ? asResp({ txt: emptyPtt }) : asResp(IT.route(u, IT.gem));
    gsFetch = u => /ptt\.cc/.test(u) ? gsResp({ txt: emptyPtt }) : gsResp(IT.route(u, IT.gem));
    cmp('整條情報管線（PTT 0 篇診斷）', strip(await W2.fetchIntel('2330', {})), strip(G.fetchIntel('2330')));
    gsFetch = u => /STOCK_DAY_ALL|tpex_mainboard/.test(u) ? gsResp({ status: 403, txt: 'x' }) : gsResp(IT.route(u, IT.gem));
    cmp('名稱查詢失敗訊息', IT.nameFail.notes, G.fetchIntel('2330').notes);
    gsFetch = u => gsResp(IT.route(u, IT.gem));
    gsFetch = u => /ptt\.cc/.test(u) ? gsResp({ status: 403, txt: 'x' }) : gsResp(IT.route(u, IT.gem));
    ok('GAS 單一來源失敗也列入 srcErrors', G.fetchIntel('2330').srcErrors.some(x => /PTT/.test(x) && /403/.test(x)));
  }

  // ⑧ 前端判定：假日不得誤報、真失敗必須示警
  const unrel = c => (c.headMiss > 0) || (c.expected && String(c.dataDate || '') < String(c.expected));
  ok('前端不會對假日誤報籌碼不完整', !unrel(ch) && !unrel(gch));
  ok('前端仍會對真失敗示警', unrel(ch2));
}

(async () => {
  console.log('═══ StockRadar 自我檢查 ═══');
  logicTests();
  intelFrontTests();
  await backendTests();
  if (!LOGIC_ONLY) { await layoutTests(); await scanFlowTests(); await browserTests(); }
  console.log(`\n通過 ${pass} 項｜失敗 ${fail} 項`);
  if (fails.length) { console.log('\n❌ 失敗項目：'); fails.forEach(f => console.log('  - ' + f)); }
  else console.log('✅ 全部通過');
  process.exit(fail ? 1 : 0);
})();
