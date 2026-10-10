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
  { // v186 暫存有效期：看資料日期，不看抓了多久（台股用台北時間、美股用美東時間，夏令時間也要對）
    const seg = cfg.slice(cfg.indexOf('const CACHE_TTL ='), cfg.indexOf('/* ── 前端超時保護'));
    const C = new Function('chipUsable', seg + '\nreturn { cacheUntil, nextWeekdayAt, lastWeekdayFrom };')(ch => !ch.bad);
    const at = x => Date.parse(x), iso = t => new Date(t).toISOString().slice(0, 16);
    const px = (t, d, us) => iso(C.cacheUntil('px', d, at(t), us));
    ok('暫存：台股盤中 5 分鐘（現價會變）', px('2026-10-01T10:00:00+08:00', { lastDate: '20260930' }) === iso(at('2026-10-01T10:05:00+08:00')));
    ok('暫存：收盤後K棒到了、法人還沒（昨天的仍算最新）→ 留到 16:00 法人公布', px('2026-10-01T14:30:00+08:00', { lastDate: '20261001', chip: { dataDate: '20260930' } }) === iso(at('2026-10-01T16:00:00+08:00')));
    // v187 審查：T86 尚未公布時後端把 expected 退回昨天（chipUsable 說完整）——16:00 後拿到昨天的法人不可留到隔天開盤
    ok('暫存：16:00 後法人仍是昨天的（尚未公布）→ 30 分鐘後再試，不留到隔天', px('2026-10-01T16:05:00+08:00', { lastDate: '20261001', chip: { dataDate: '20260930' } }) === iso(at('2026-10-01T16:35:00+08:00')));
    ok('暫存：16:00 後法人也到了 → 留到隔天開盤；週五留到週一 09:00', px('2026-10-01T17:00:00+08:00', { lastDate: '20261001', chip: { dataDate: '20261001' } }) === iso(at('2026-10-02T09:00:00+08:00'))
      && px('2026-10-02T20:00:00+08:00', { lastDate: '20261002', chip: { dataDate: '20261002' } }) === iso(at('2026-10-05T09:00:00+08:00')));
    ok('暫存：該有今天K棒卻還沒有、或法人不完整 → 30 分鐘後再試', px('2026-10-01T15:00:00+08:00', { lastDate: '20260930' }) === iso(at('2026-10-01T15:30:00+08:00'))
      && px('2026-10-01T17:00:00+08:00', { lastDate: '20261001', chip: { bad: 1, dataDate: '20261001' } }) === iso(at('2026-10-01T17:30:00+08:00')));
    ok('暫存：週末查（資料是週五的）→ 留到週一開盤', px('2026-10-03T12:00:00+08:00', { lastDate: '20261002' }) === iso(at('2026-10-05T09:00:00+08:00')));
    // 美股：台北週五 10:00＝美東週四 22:00（夏令）；資料到週四 → 留到美東週五 09:30
    ok('暫存：美股用美東時間（夏令 09:30＝台北 21:30）', px('2026-10-02T10:00:00+08:00', { lastDate: '20261001' }, true) === iso(at('2026-10-02T09:30:00-04:00')));
    ok('暫存：美股冬令時間自動換算（11/2 起 09:30＝台北 22:30）', iso(C.nextWeekdayAt(at('2026-11-02T08:00:00Z'), 'America/New_York', 570)) === iso(at('2026-11-02T09:30:00-05:00')));
    ok('暫存：美股盤中 5 分鐘', px('2026-10-01T23:00:00+08:00', { lastDate: '20260930' }, true) === iso(at('2026-10-01T23:05:00+08:00')));
    const post = (t, d) => iso(C.cacheUntil('post', d, at(t)));
    ok('暫存：融資／估值 當天的到了且抓齊 → 留到下一個 16:00；還沒到或缺漏 → 30 分鐘', post('2026-10-01T17:00:00+08:00', { date: '20261001', ok: true }) === iso(at('2026-10-02T16:00:00+08:00'))
      && post('2026-10-01T15:00:00+08:00', { date: '20260930', ok: true }) === iso(at('2026-10-01T16:00:00+08:00'))
      && post('2026-10-01T17:00:00+08:00', { date: '20260930', ok: true }) === iso(at('2026-10-01T17:30:00+08:00'))
      && post('2026-10-01T17:00:00+08:00', { date: '20261001', ok: false }) === iso(at('2026-10-01T17:30:00+08:00')));
    ok('暫存：FinMind 籌碼以 21:00 為界（借券日期是 YYYY-MM-DD 也要認得）', iso(C.cacheUntil('finmind', { date: '2026-10-01', ok: true }, at('2026-10-01T21:30:00+08:00'))) === iso(at('2026-10-02T21:00:00+08:00'))
      && iso(C.cacheUntil('finmind', { date: '2026-09-30', ok: true }, at('2026-10-01T21:30:00+08:00'))) === iso(at('2026-10-01T22:00:00+08:00')));
    ok('暫存：大盤盤中 5 分鐘、週末最多 30 分鐘；情報面 1 小時', iso(C.cacheUntil('market', {}, at('2026-10-01T10:00:00+08:00'))) === iso(at('2026-10-01T10:05:00+08:00'))
      && iso(C.cacheUntil('market', {}, at('2026-10-03T12:00:00+08:00'))) === iso(at('2026-10-03T12:30:00+08:00'))
      && iso(C.cacheUntil('intel', {}, at('2026-10-01T10:00:00+08:00'))) === iso(at('2026-10-01T11:00:00+08:00')));
  }
  { // v188 工具盤點後的整併：每個工具都要有用處——永遠不會亮、跟別張卡重複、或已證實無效的都已刪除
    const FRONT = ['config.js', 'help.js', 'db.js', 'market.js', 'enhance.js', 'advanced.js', 'smc.js', 'mainforce.js', 'mtf.js', 'bingfa.js', 'layout.js', 'journal.js', 'scan.js', 'intel.js', 'app.js'];
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const all = FRONT.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n') + html;
    const code = all.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // 死碼守門：前端每個頂層函式都要至少被用到一次
    const defs = [...code.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_][\w]*)\s*\(/g)].map(m => m[1]);
    const dead = defs.filter(n => (code.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length <= 1);
    ok('死碼：前端沒有定義了卻沒人用的函式', dead.length === 0, dead.join(','));
    const gone = ['formula.js', 'quant.js', 'resonance.js'];
    ok('已刪除的檔案不再被載入或預快取', gone.every(f => !html.includes(f) && !sw.includes(f) && !fs.existsSync(path.join(ROOT, f))));
    const goneIds = ['quant-card', 'formula-card', 'prob-card', 'bayes-box', 'oos-card', 'multiperiod-card', 'health-card', 'mktscore-card', 'resonance-card', 'vpradar-card', 'bf-exit', 'bf-tradescore'];
    ok('已刪除的卡片沒有殘留（畫面、分頁、重置清單）', goneIds.every(id => !all.includes(id)), goneIds.filter(id => all.includes(id)).join(','));
    const goneFns = ['computeFormulas', 'calcSTI', 'computeResonance', 'computeProbability', 'computeBayesProb', 'computeProprietaryScore', 'computeTradeScore', 'computeMarketScore', 'renderHealthReport', 'computeOverheat', 'computeLiquidityPools', 'signalsAtIndex', 'computeOOSValidation', 'multiPeriodBacktest', 'computeVolPriceRadar', 'evScorable'];
    ok('已刪除的工具沒有人再呼叫', goneFns.every(f => !code.includes(f)), goneFns.filter(f => code.includes(f)).join(','));
    const bf = fs.readFileSync(path.join(ROOT, 'bingfa.js'), 'utf8'), ap = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), en = fs.readFileSync(path.join(ROOT, 'enhance.js'), 'utf8'), jn = fs.readFileSync(path.join(ROOT, 'journal.js'), 'utf8');
    ok('紀律門：大週期反向只提醒（順逆勢期望值無差異）；主力行為推估只提醒（未經驗證）', /else if \(mtf\.dir === -dir\) warn\.push/.test(bf) && /mf\.behavior === '吸籌'\) warn\.push/.test(bf) && !/mf\.behavior === '吸籌'\) fail\.push/.test(bf));
    ok('停利改用此股中位可達（風險卡、劇本）；不再用 1:2／1:3、2R／3R', /tp5 = row5/.test(ap) && /const \[longTp1, longTp2\] = tgt\(1, distL\)/.test(en) && !/stopDist\*2|distL \* 2|distS \* 3/.test(ap + en));
    ok('日誌：進場時記證據（波段階段／風報比／高波動，標明各自證據等級），匯出有對照表', /entryEvidence = \{ stage:/.test(jn) && /進場時的證據 vs 實際結果/.test(jn) && !/A 級證據/.test(jn));
    ok('擁擠度與指標卡用同一套 RSI／KD／MACD（不再有 quant.js 的第二份算法）', /const rsi = calcRSI\(c, 14\)/.test(fs.readFileSync(path.join(ROOT, 'mainforce.js'), 'utf8')));
    // ADX：標準 Wilder（從頭平滑）；回測腳本必須用同一算法，否則期望值表的盤勢分類會和畫面對不上
    const grab = (src, n) => { const i = src.indexOf('function ' + n + '('); let d = 0, j = src.indexOf('{', i); for (;; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && !--d) break; } return src.slice(i, j + 1); };
    const bt = fs.readFileSync(path.join(ROOT, 'backtest_conditional.js'), 'utf8');
    const X = new Function(grab(ap, 'calcDMI') + grab(bt, 'adxSeries') + ';return { calcDMI, adxSeries };')();
    const f2330 = path.join(DATA, '2330.json');
    if (fs.existsSync(f2330)) { const r = JSON.parse(fs.readFileSync(f2330, 'utf8'));
      if (Array.isArray(r)) { const h = r.map(x => x.max), l = r.map(x => x.min), c = r.map(x => x.close), a = X.calcDMI(h, l, c).adx, b = X.adxSeries({ h, l, c }).at(-1).adx;
        ok('ADX：標準 Wilder 算法（2330 實測 15.9，與獨立參考實作一致），回測腳本算出的完全相同', Math.abs(a - 15.9) < 0.15 && Math.abs(a - b) < 1e-9, `${a.toFixed(3)}／${b.toFixed(3)}`); } }
    // v188 重測後的修正：工具要能亮、亮了要有意義
    const mk = fs.readFileSync(path.join(ROOT, 'market.js'), 'utf8');
    { const tg = bf.slice(bf.indexOf('function computeTradeGate('), bf.indexOf('function renderTradeGate('));
      ok('紀律門：唯一的禁止是「高波動時放空」（19年 −1.42%/筆，t−6.6）；高波動做多改提醒（−0.40%，比平常不差）', !/fail\.push\(/.test(tg) && /\(dir === -1 && tw \? fail : warn\)\.push/.test(tg)
        && /regime\.regime === '高波動危險' && dir === -1 && D\.currency === 'TWD'\) \{ fail\.push/.test(fs.readFileSync(path.join(ROOT, 'scan.js'), 'utf8')));
      ok('追突破：台股一律用全市場實測（−1.54% vs 隨便進場 −0.87%），不再有未驗證的逐股 38%／48% 綠燈', /全市場2,136檔19年實測，突破20日高進場每筆−1\.54%/.test(tg) && !/優於台股基準38\.4%/.test(tg));
      const GC = new Function(grab(bf, 'gapChase') + ';return gapChase;')();
      const mkG = (open, vol, o = {}) => ({ _intraday: '20261002', currency: 'TWD', open, volume: vol, closes: Array(60).fill(100), volumes: Array(60).fill(1000), ...o });
      ok('盤中追跳空：只在台股盤中、跳空 7~9.5%、量已達 50 日均量 3 倍才提醒（與回測同條件）',
        Math.abs(GC(mkG(108, 3000)) - 8) < 1e-9 && GC(mkG(108, 2999)) === null && GC(mkG(106.9, 9000)) === null && GC(mkG(109.6, 9000)) === null
        && GC(mkG(108, 9000, { _intraday: undefined })) === null && GC(mkG(108, 9000, { currency: 'USD' })) === null);
      ok('紀律門：只剩「禁止／未觸禁止＋提醒」兩級（「可出手」兩份資料都是 0 次，已移除）', /const vClass = fail\.length \? 'no' : 'ok'/.test(tg) && !/'go'|'caution'|rrBad/.test(bf)); }
    ok('執行計畫：方向依勢能等級、該方向被禁止就不給；一律試單（風險減半）', /const planSide = want && g\[want\]\.vClass !== 'no' \? want : null/.test(bf) && /riskAmt2 = riskAmt2 \/ 2;/.test(bf) && !/\bhalf\b/.test(bf));
    ok('擁擠度：沒有「非擁擠」預設綠燈（沒資料時 95% 都亮）', !/pass\.push\('非擁擠明牌/.test(bf));
    ok('行為鏈：不足 3 票不顯示 ±100 分數', /\$\{syn\.decisive \? `綜合分數/.test(bf));
    ok('線位警示：K 棒真的碰到確認過的線才亮（不是現價接近就亮）', /lo <= p\.level && p\.level <= hi/.test(bf) && !/Math\.abs\(px - p\.level\)/.test(bf));
    ok('go()：趨勢／風險／心理／訊號／大盤卡各自 try，單卡壞掉不拖垮整頁', ['趨勢卡', '風險卡', '心理卡', '訊號卡', '大盤卡'].every(k => ap.includes(`ErrorLog.push('${k}',err)`)));
    { const ev = bf.match(/const MID_EV = \{[\s\S]*?\n\};/)[0];
      const MF = new Function('_intelCache', 'APP_VERSION', ev + grab(bf, 'midPct') + 'const midQ = (v, cut) => cut.filter(c => v >= c).length;' + grab(bf, 'midFactors') + ';return { midPct, midQ, midFactors, MID_EV };')({ X: { v: 1, t: Date.now() - 3 * 36e5, d: { revenue: { ym: 202608, sur: 1.12, rev3: 0.311 }, quality: { acc: 0.0717, q: '2026Q2' } } } }, 1);   // 3 小時前抓的（情報暫存已過期）仍要用
      const mkD = (f, o = {}) => ({ code: 'X', currency: 'TWD', closes: Array.from({ length: 300 }, (_, i) => f(i)), volumes: Array(300).fill(1e6), ...o });
      const up = MF.midFactors(mkD(i => 50 + i * 0.05)), cut = MF.MID_EV.hi52.cut;
      ok('中期因子：門檻內插（分界點＝20/40/60/80 百分位，兩端夾在 0~1）、分組', Math.abs(MF.midPct(cut[1], cut) - 0.4) < 1e-9 && MF.midPct(0, cut) === 0 && MF.midPct(9, cut) === 1 && MF.midQ(cut[3], cut) === 4 && MF.midQ(cut[0] - 1e-9, cut) === 0);
      ok('中期因子：創一年新高＋營收驚奇、營收成長、盈餘品質都在最高組界線→四者合成 (0.5+0.3×3)/4、最高組', Math.abs(up.hi52 - 1) < 1e-12 && Math.abs(up.comp - (0.5 + 0.3 * 3) / 4) < 1e-9 && up.qq === '2026Q2' && MF.midQ(up.comp, MF.MID_EV.comp.cut) === 4, JSON.stringify(up));
      ok('中期因子：與回測同樣的排除（成交值不足、近一年單日漲跌>11%、美股、不足一年）', /2,000 萬/.test(MF.midFactors(mkD(i => 10, { volumes: Array(300).fill(1e5) })).why)
        && /11%/.test(MF.midFactors(mkD(i => i === 200 ? 60 : 50)).why) && MF.midFactors(mkD(i => 50, { currency: 'USD' })) === null && /一年/.test(MF.midFactors({ ...mkD(i => 50), closes: Array(200).fill(50) }).why)); }
    { const VE = new Function(bf.match(/const VOL_EV = \{[\s\S]*?\n\};/)[0] + grab(bf, 'volEvent') + ';return volEvent;')();
      const mk = (f, vol, o = {}) => { const c = Array.from({ length: 100 }, (_, i) => f(i)); return { currency: 'TWD', rawCloses: c, rawHighs: c.map(x => x * 1.01), rawLows: c.map(x => x * 0.99), volumes: Array.from({ length: 100 }, (_, i) => vol(i)), ...o }; };
      const flat = i => 100 + (i % 2), V = i => 1e6;
      ok('量價事件：盤整後爆量大漲（漲≥5%、量≥3倍、前20日高低差≤15%）', VE(mk(i => i === 99 ? 106 : flat(i), i => i === 99 ? 3e6 : 1e6)) === 'B1' && VE(mk(i => i === 99 ? 106 : flat(i), i => i === 99 ? 2.9e6 : 1e6)) === null);
      ok('量價事件：爆量大跌；之後第一根帶量反彈（只認最後一根就是第一根）', VE(mk(i => i === 99 ? 94 : 100, i => i === 99 ? 3e6 : 1e6)) === 'A1'
        && VE(mk(i => i < 90 ? 100 : i < 99 ? 94 : 97, i => i === 90 ? 4e6 : i === 99 ? 2.2e6 : 1e6)) === 'A2'
        && VE(mk(i => i < 90 ? 100 : i < 95 ? 94 : i < 99 ? 97 : 100.5, i => i === 90 ? 4e6 : i >= 95 ? 2.2e6 : 1e6)) === null);
      ok('量價事件：與回測相同的排除（美股、成交值不足、近60日有>11%單日漲跌）', VE(mk(i => i === 99 ? 106 : flat(i), i => i === 99 ? 3e6 : 1e6, { currency: 'USD' })) === null
        && VE(mk(i => i === 99 ? 106 : flat(i) / 50, i => i === 99 ? 3e6 : 1e6)) === null && VE(mk(i => i === 99 ? 106 : i === 60 ? 115 : flat(i), i => i === 99 ? 3e6 : 1e6)) === null); }
    { const PV = new Function(bf.match(/const PV_EV = \{[\s\S]*?\n\};/)[0] + grab(bf, 'pvState') + ';return pvState;')();
      const mk = (f, vol, o = {}) => { const c = Array.from({ length: 300 }, (_, i) => f(i)); return { currency: 'TWD', rawCloses: c, rawHighs: c.map(x => x * 1.01), rawLows: c.map(x => x * 0.99), volumes: Array.from({ length: 300 }, (_, i) => vol(i)), ...o }; };
      // 一年內高 120、低 80，近期盤整 100：最後一天漲 2%、量 3.5 倍、收在高檔 → 漲1~3%·量≥3倍·盤整·52週中間·收高（C867）
      const s1 = mk(i => i < 100 ? 120 : i < 150 ? 80 : i === 299 ? 102 : 100 + (i % 2) * 0.5, i => i === 299 ? 3.5e6 : 1e6);
      s1.rawHighs[299] = 102.1; s1.rawLows[299] = 100;
      const r1 = PV(s1);
      // 創一年新高、漲 4%、量 2.5 倍 → 常見說法「創52週新高且爆量」（N4，唯一偏多）
      const s2 = mk(i => i === 299 ? 104 : 100, i => i === 299 ? 2.5e6 : 1e6), r2 = PV(s2);
      ok('量價狀態：與回測同一套分格（漲跌×量比×前20日走勢×52週位置×收盤位置）與常見說法', r1.length === 1 && r1[0][0] === '漲1~3%·量≥3倍·盤整·52週中間·收高' && r2.some(e => /創52週新高且爆量/.test(e[0]) && e[1] > 0), JSON.stringify([r1, r2]));
      ok('量價狀態：與回測相同的排除（美股、不足一年、成交值不足、近60日單日>11%）', PV({ ...s1, currency: 'USD' }).length === 0 && PV(mk(i => 100, i => 1e6, { rawCloses: Array(200).fill(100) })).length === 0
        && PV({ ...s1, volumes: s1.volumes.map(x => x / 100) }).length === 0 && PV({ ...s1, rawCloses: s1.rawCloses.map((x, i) => i === 270 ? 115 : x) }).length === 0);
      const SUM = new Function('pvState', 'midDirection', 'midFactors', bf.match(/const PV_MID = \{[^\n]*\n/)[0] + grab(bf, 'pvSummary') + ';return pvSummary;');
      const neg = [PV(s1)[0]], posv = [['創52週新高且爆量（量≥2倍、漲≥3%）', 0.73, 4.5]];
      const a = SUM(() => neg, () => ({ q: 4 }), () => ({}))({}), b = SUM(() => neg, () => null, () => ({}))({}), c = SUM(() => posv, () => ({ q: 0 }), () => ({}))({});
      ok('量價狀態＋中期因子：有中期組別就用交叉表（最強組遇到負面量價 20日 +0.17%、60日 +1.27%，不改變中期方向）；沒有就用扣52週位置的數字；新高爆量偏多', a.side === -1 && /中期第 5／5 組/.test(a.txt) && /\+0\.17%、60日 \+1\.27%/.test(a.txt) && /不改變中期方向/.test(a.txt)
        && b.side === -1 && /扣掉52週位置後之後20日仍 -0\.86%/.test(b.txt) && c.side === 1 && /\+1\.54%/.test(c.txt) && SUM(() => [], () => null, () => null)({}) === null, JSON.stringify([a, b, c]));
      ok('量價狀態進橫幅、🧭分析方向與紀律門（偏多：做多順風／放空提醒；負面：只提醒做多）', /const pv = pvSummary\(D\); if \(pv\) addW\(2, '📊'/.test(bf) && /pv \? `量價（約 1~3 個月）/.test(bf)
        && /if \(pv && \(pv\.side === 1 \|\| dir === 1\)\) \(pv\.side === dir \? pass : warn\)/.test(bf)); }
    { const sc = fs.readFileSync(path.join(ROOT, 'scan.js'), 'utf8'), ev = sc.slice(sc.indexOf('function evalScanConditions('), sc.indexOf('/* 掃描主流程'));
      ok('掃描只用有回測的條件排序（中期因子分組超額；高波動禁空；量價狀態／事件列逆風），未回測的尾端／Amihud／急跌／此股突破率／勢能不進掃描', /midFactors\(D\)/.test(ev) && /score: hard \? -99 : ex == null \? -50 : ex \* dir/.test(ev)
        && !/computeMoveStage|computeAmihud|computeCrashPhase|computeBreakoutStats|computeShiPower/.test(ev) && !/唯一有實證/.test(sc + fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
      ok('橫幅標題：勢能與中期因子相反時以中期為準（與執行計畫一致）；勢能盤中用前一日收盤', /但中期因子最弱 20%/.test(bf) && /但中期因子最強 20%/.test(bf) && /const price = barPx\(D\);/.test(bf));
      ok('急跌末端不再說「有人接貨、追空會被軋」（全市場同類K棒 20 日 −1.29%）；只提醒做多', !/FUSION≤-40/.test(bf + fs.readFileSync(path.join(ROOT, 'help.js'), 'utf8')) && /if \(cp && dir === 1\) warn\.push\(cp\.note\)/.test(bf) && !/紀律門全綠/.test(bf)); }
    { const all = ['bingfa.js', 'app.js', 'mtf.js', 'mainforce.js', 'smc.js', 'enhance.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
      ok('v197 盤中判斷一律用完整K棒：趨勢／心理／MTF／主力意圖／擁擠度／VWAP／目標價不再拿即時價', !/const c=D\.closes, price=D\.price;|const price = D\.price;|D\.price > ma20|const price = D\.price \|\| c\[n - 1\]/.test(all));
      ok('v197 台股回測不外推美股：期望值表、高波動禁空、急跌數字只限台股', /COND_EV === 'undefined' \|\| D\.currency !== 'TWD'/.test(bf) && /dir === -1 && tw \? fail : warn/.test(bf) && /D\.currency === 'TWD' \? '，但台股19年相近型態/.test(bf));
      ok('v197 行為鏈：融資象限、大週期不投方向票（回測沒有差異），文字不再說「最可信」', /behaviors\.push\(\{ name: '散戶槓桿行為', actor: '散戶', dir: 0/.test(bf) && /dir: 0, strength: Math\.min\(80, Math\.abs\(mtf\.total/.test(bf) && !/最可信/.test(bf + fs.readFileSync(path.join(ROOT, 'help.js'), 'utf8')));
      ok('v197 籌碼抓不到要明講（後端 chipErr、前端顯示），不再整張卡無聲消失', /kline\.chipErr = /.test(fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8')) && /ydata\.chipErr = /.test(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8')) && /D && D\.chipErr/.test(fs.readFileSync(path.join(ROOT, 'enhance.js'), 'utf8'))); }
    ok('量價事件進紀律門（做多提醒）與橫幅', /const ve = volEvent\(D\);\n      if \(ve\) warn\.push\(VOL_EV\[ve\]\);/.test(bf) && /addW\(2, '📊', `最近一根K棒\$\{D\._intraday \? '（昨日）' : ''\}\$\{VOL_EV\[ve\]\}`\)/.test(bf));
    ok('分析方向：中期合成五組→偏空～偏多，只有最強／最弱 20% 才給方向；執行計畫先看中期因子、沒有才用勢能（標明未經回測）', /const MID_DIR = \['偏空', '略偏空', '中性', '略偏多', '偏多'\]/.test(bf) && /side: q === 4 \? 'long' : q === 0 \? 'short' : null/.test(bf)
      && /const want = md && md\.side \? md\.side :/.test(bf) && /勢能等級（未經回測，僅供參考）/.test(bf) && /🧭 分析方向：中期/.test(bf));
    ok('中期因子進紀律門（只有最高／最低 20%）與橫幅；情報面到了就重繪', /const mid = midFactors\(D\);   \/\/ v190/.test(bf) && /q === 4 \|\| q === 0/.test(bf) && /📊 中期因子/.test(bf)
      && /refreshAsyncDependents\(D\.code\);[^\n]*\n  try \{ box\.innerHTML = renderIntel/.test(fs.readFileSync(path.join(ROOT, 'intel.js'), 'utf8')));
    ok('VIX 漲跌缺值時不炸、顯示「—」', /us\.vix\.changePct != null \?/.test(mk));
    ok('凱利為 0 時顯示「不下注＋此股需要的勝率」而不是 0.0%（預設 50% 勝率下幾乎都是 0，門檻勝率才是每檔不同的資訊）', /:`不下注｜需勝率≥\$\{\(r\.breakevenWR\*100\)/.test(ap));
    { const wk = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8'), gs2 = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8'), av2 = fs.readFileSync(path.join(ROOT, 'advanced.js'), 'utf8');
      ok('上櫃月營收：兩個後端都改用 TPEx mopsfin_t187ap05_O（TWSE 的 t187ap05_O 不存在），失敗原因回傳並顯示在基本面卡', [wk, gs2].every(x => x.includes('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O') && !/'t187ap05_O'/.test(x) && /revErr/.test(x)) && /月營收抓不到：/.test(av2) && /!j\.revErr/.test(av2)); }
    ok('ADX：期望值表已用標準 ADX 重跑，查表用畫面同一個盤勢分類；舊版算法已移除', /const rgNow = computeRegime\(D\)/.test(bf) && !/calcDMILegacy|legacy/.test(ap + en + bf) && /多頭: \[-0\.80, 5126\]/.test(cfg));
  }
  ok('盤中時鐘 twMarketPhase 已移除（推估全日量的依據已不存在），沒有殘留呼叫', !/twMarketPhase/.test(['config.js', 'bingfa.js', 'enhance.js', 'mainforce.js', 'app.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('')));
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
  ok('SW 對同源資源採網路優先（離線時頁面導覽忽略查詢字串）', /self\.location\.origin/.test(sw) && /\.catch\(\(\) => caches\.match\(e\.request, \{ ignoreSearch: e\.request\.mode === 'navigate' \}\)\)/.test(sw));
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
  /* v176：新卡片必須三處同步（index.html／layout.js 分頁／app.js 重置清單），漏一處就是「幽靈卡」——
     每個分頁都看得到它。layout.js 檔頭早就寫了這條，v168 加情報卡時還是漏了，改成自動檢查。 */
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), lay = fs.readFileSync(path.join(ROOT, 'layout.js'), 'utf8');
    const cards = [...html.matchAll(/<div id="([\w-]+-card)"/g)].map(m => m[1]);
    const tabs = new Set([...lay.matchAll(/cards:\[([^\]]*)\]/g)].flatMap(m => m[1].match(/[\w-]+/g)));
    const rm = app.match(/\[('stock-bar'[^\]]*)\]\.forEach\(id=>\$\(id\)\.style\.display='none'\)/), reset = new Set(rm ? rm[1].match(/[\w-]+/g) : []);
    ok('每張卡片都歸到某個分頁（否則每個分頁都會出現它）', cards.length > 15 && cards.every(c => tabs.has(c)), cards.filter(c => !tabs.has(c)).join(','));
    ok('每張卡片都在換股時的重置清單', cards.every(c => reset.has(c)), cards.filter(c => !reset.has(c)).join(','));
  }
  const gs = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  ok('GAS 不再傳 UrlFetchApp 不支援的 timeout 參數（它一直被忽略，會誤導讀者）', !/timeout:\s*FETCH_TIMEOUT_SEC/.test(gs) && !/var FETCH_TIMEOUT_SEC/.test(gs));
  ok('逾時訊息講的是實際秒數（原本寫死 20 秒）', /後端回應超時（\$\{Math\.round\(ms \/ 1000\)\}秒）/.test(cfg) && !/超時（20秒）/.test(cfg));
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
  let snapResp = () => ({ ok: true, rows: [], noMeta: 0 });
  let poolDelay = 0, poolCalls = 0, poolCodes = ['2001', '2002', '2003'], intelDelay = 0; const intelCalls = {};
  const T0 = Date.now();
  let intelResp = { ok: true, code: '2330', name: '台積電', asOf: T0, board: '上市', lastBar: '20260926',
    items: [{ kind: 'news', title: '台積電法說上修全年營收', src: '經濟日報', url: 'https://news.example/a', t: T0 - 5 * 3600e3 },
            { kind: 'ptt', title: '[標的] 2330 台積電 多', src: 'PTT［標的］', url: 'https://www.ptt.cc/bbs/Stock/M.1.A.1.html', t: T0 - 3 * 3600e3 }],
    events: [{ title: '法說上修全年營收', type: '法說', dir: 1, mag: 2, horizon: '中', conf: 0.8, ids: [0, 1], first: T0 - 5 * 3600e3, srcKinds: ['news', 'ptt'],
      study: { status: 'ok', t0: '20260926', afterClose: false, L: 2, car: 0.042, scar: 2.9, pre: 0.003, preScar: 0.4, beta: 1.1, n: 110 } }],
    tilt: { tilt: 0.8, conflict: 0, n: 1 },
    attention: { news: { n: 9, series: [{ d: '20260922', n: 2 }, { d: '20260923', n: 3 }, { d: '20260924', n: 4 }], pending: 2, med: 2.5, ratio: 1.75, trend: '升溫' },
      ptt: { n: 1, series: [], pending: 1, bull: 1, bear: 0, hot: 1, boo: 0 }, intl: 2 },
    revenue: { ym: 202608, rev: 3.2e11, yoy: 0.6, mom: 0.08, ytd: 0.31, mean: 0.2, n: 24, sur: 19.6, streak: 28, seen: '2026-09-09', t: 0,
      study: { status: 'ok', t0: '20260910', L: 12, car: 0.051, scar: 2.6, pre: 0.004, preScar: 0.3, beta: 1.1, n: 110 } },
    ai: { status: 'ok', model: 'gemini-test', prompt: 'v168.1', dropped: 1, summary: '市場在談法說上修[0]。', outlook: '若開盤延續法說利多[0]，則留意追價量能。' },
    moves: { beta: 1.3, sd: 0.012, n: 120, pending: [1], days: [
      { d: '20260929', ret: -0.051, mret: -0.009, mkt: -0.012, ar: -0.039, z: -3.2, ids: [], why: '', whyIds: [] },
      { d: '20260930', ret: 0.061, mret: 0.008, mkt: 0.011, ar: 0.05, z: 4.1, ids: [0], why: '法說上修全年營收[0]', whyIds: [0] },
      { d: '20261002', ret: -0.039, mret: -0.03, mkt: -0.039, ar: 0.0005, z: 0.04, ids: [], why: '', whyIds: [] }] },
    notes: [], srcErrors: [], snapshot: 'saved' };
  const bars = n => { const c = [], h = [], l = [], v = [];
    for (let i = 0; i < n; i++) { const x = 100 + Math.sin(i / 5) * 5 + i * 0.1;
      c.push(+x.toFixed(2)); h.push(+(x * 1.01).toFixed(2)); l.push(+(x * 0.99).toFixed(2)); v.push(5e7); }
    return { c, h, l, v }; };
  await pg.route('**/scanflow.test/**', async route => {
    const u = new URL(route.request().url()), a = u.searchParams.get('action');
    if (a === 'pool') { poolCalls++;
      if (poolDelay) await new Promise(r => setTimeout(r, poolDelay));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, codes: poolCodes, dataDate: '20260921', universe: 999, cutoff: 1e8 }) }); }
    if (a === 'intel') { intelCalls[u.searchParams.get('code')] = (intelCalls[u.searchParams.get('code')] || 0) + 1; if (intelDelay) await new Promise(r => setTimeout(r, intelDelay));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(intelResp) }); }
    if (a === 'intelsnaps') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapResp(u.searchParams.get('code'))) });
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
  // v179 月營收、國際外電、PTT 反應
  ok('情報卡：月營收顯示年增、驚奇度與公布後市場反應', /2026\/8 月營收（官方）/.test(ic.txt) && /年增 \+60\.0%/.test(ic.txt) && /驚奇度 \+19\.6，明顯優於常態/.test(ic.txt) && /連續 28 個月年增/.test(ic.txt) && /約 9\/9 公布 → 市場反應 CAR \+5\.1%.*顯著/.test(ic.txt), ic.txt.slice(ic.txt.indexOf('月營收') - 10, ic.txt.indexOf('月營收') + 160));
  ok('情報卡：國際外電則數、PTT 爆文數', /國際外電 7日 2 則/.test(ic.txt) && /爆文 1/.test(ic.txt) && !/噓文/.test(ic.txt), ic.txt.slice(ic.txt.indexOf('新聞 7日'), ic.txt.indexOf('新聞 7日') + 120));
  // v178 AI 綜合研判（Gemini）：與情報卡共用同一次回應
  const aiText = () => pg.evaluate(() => { const c = document.getElementById('ai-card'); return { vis: c && c.style.display !== 'none', txt: document.getElementById('ai-body').innerText, html: document.getElementById('ai-body').innerHTML }; });
  let ac = await aiText();
  ok('AI研判：個股自己漲的那天給出引用當天消息的原因', ac.vis && /9\/30（三）/.test(ac.txt) && /可能原因：法說上修全年營收/.test(ac.txt) && /href="https:\/\/news\.example\/a"/.test(ac.html), ac.txt.slice(0, 120));
  ok('AI研判：跟大盤跌的那天明講不顯著、不硬配消息', /10\/2（五）[\s\S]*?不顯著——主要是跟著大盤/.test(ac.txt), ac.txt);
  ok('AI研判：顯著但當天沒有消息能解釋→明講查無原因', /9\/29（二）[\s\S]*?當天的消息都解釋不了/.test(ac.txt));
  ok('AI研判：下一個交易日展望＋收盤後消息數，標明是情境不是預測', /收盤後 1 則新消息/.test(ac.txt) && /若開盤延續法說利多/.test(ac.txt) && /不是漲跌預測/.test(ac.txt) && /不計入任何分數/.test(ac.txt));
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
  ok('AI研判：情報面沒拿到時明講，不留在「等待中」', /情報面資料沒拿到/.test((await aiText()).txt));
  intelResp = good;
  await pg.evaluate(() => { window._activeCode = 'AAPL'; return loadIntelCard({ code: 'AAPL', currency: 'USD' }); });
  ok('情報卡：美股不顯示（資料源只有台股）', !(await intelText()).vis);
  ok('AI研判：美股不顯示（逐日歸因用的是台股消息）', !(await aiText()).vis);
  const noMv = intelResp; intelResp = Object.assign({}, noMv, { moves: undefined, code: '2105' });
  await pg.evaluate(() => { window._activeCode = '2105'; return loadIntelCard({ code: '2105', currency: 'TWD' }); });
  ok('AI研判：v177 以前的後端（沒有逐日欄位）→ 明講要重新部署，不誤說資料不足', /還沒更新到 v178/.test((await aiText()).txt), (await aiText()).txt.slice(0, 60));
  intelResp = noMv;

  // v176 進度顯示
  intelDelay = 2600;
  await pg.evaluate(() => { window._activeCode = '2412'; window._ip = loadIntelCard({ code: '2412', currency: 'TWD', chip: null }); });
  await pg.waitForTimeout(1400);
  ic = await intelText();
  ok('情報卡：抓取中顯示已等秒數與預估階段（區分當機／抓取中）', /已等 [12] 秒/.test(ic.txt) && /預估/.test(ic.txt) && /最多等 90 秒/.test(ic.txt), ic.txt.slice(0, 80));
  await pg.evaluate(() => window._ip);
  ic = await intelText();
  ok('情報卡：完成後進度換成結果', !/已等/.test(ic.txt) && /共振/.test(ic.txt), ic.txt.slice(0, 60));
  // 逾時：上限調短來測
  intelDelay = 2500;
  await pg.evaluate(() => { INTEL_WAIT = 1200; window._activeCode = '2603'; return loadIntelCard({ code: '2603', currency: 'TWD', chip: null }); });
  ic = await intelText();
  ok('情報卡：逾時明講「不是頁面當機」並給重試', /沒有回應/.test(ic.txt) && /不是頁面當機/.test(ic.txt) && /重試/.test(ic.txt), ic.txt.slice(0, 80));
  intelDelay = 0;
  await pg.evaluate(() => { INTEL_WAIT = 60000; });
  await pg.evaluate(() => document.querySelector('#intel-content button').click());   // 掃描面板仍蓋在上層，直接觸發按鈕本身的 onclick
  await pg.waitForTimeout(700);
  ok('情報卡：按重試會重新抓並顯示結果', /共振/.test((await intelText()).txt));
  // 換股不互蓋：兩檔都沒快取、都在抓。舊計時器不可停掉新股票的計時，也不可蓋掉新畫面
  intelDelay = 3000;
  await pg.evaluate(() => { window._activeCode = '2882'; loadIntelCard({ code: '2882', currency: 'TWD', chip: null }); });
  await pg.waitForTimeout(300);
  await pg.evaluate(() => { window._activeCode = '2454'; window._ip2 = loadIntelCard({ code: '2454', currency: 'TWD', chip: null }); });
  await pg.waitForTimeout(2300);
  ic = await intelText();
  ok('情報卡：換股後新股票的秒數照常往上跳（沒被舊計時器停掉）', /已等 2 秒/.test(ic.txt), ic.txt.slice(0, 50));
  await pg.evaluate(() => window._ip2); await pg.waitForTimeout(1500);
  ic = await intelText();
  ok('情報卡：換股後舊的計時與結果都不會蓋掉新股票畫面', /共振/.test(ic.txt) && !/已等/.test(ic.txt), ic.txt.slice(0, 60));
  // 同一檔連點兩次：結果出來後不可再被「已等 N 秒」蓋掉
  intelDelay = 1500;
  await pg.evaluate(() => { window._activeCode = '1101'; loadIntelCard({ code: '1101', currency: 'TWD', chip: null }); window._ip3 = loadIntelCard({ code: '1101', currency: 'TWD', chip: null }); });
  await pg.evaluate(() => window._ip3); await pg.waitForTimeout(1600);
  ic = await intelText();
  ok('情報卡：同一檔連點兩次，結果出來後不會再被進度蓋掉', /共振/.test(ic.txt) && !/已等/.test(ic.txt), ic.txt.slice(0, 60));
  intelDelay = 0;
  // v181 A→B→A 快速切回：共用進行中的請求（不重打 Gemini，也不讓後到的失敗蓋掉好結果）
  intelDelay = 1200;
  await pg.evaluate(() => { window._activeCode = '3008'; loadIntelCard({ code: '3008', currency: 'TWD', chip: null });
    window._activeCode = '3034'; loadIntelCard({ code: '3034', currency: 'TWD', chip: null });
    window._activeCode = '3008'; window._ip4 = loadIntelCard({ code: '3008', currency: 'TWD', chip: null }); });
  await pg.evaluate(() => window._ip4); await pg.waitForTimeout(300);
  ok('情報卡：同一檔進行中的請求共用，後端只被打一次', intelCalls['3008'] === 1 && /共振/.test((await intelText()).txt), JSON.stringify(intelCalls));
  intelDelay = 0;
  // 資料到了但顯示程式出錯：兩張卡都要明講，不可停在「已等 N 秒」「等待中」
  const okResp = intelResp; intelResp = Object.assign({}, okResp, { code: '2408', moves: { beta: 1, sd: 0.01, n: 60, pending: [], days: 'x' } });
  await pg.evaluate(() => { window._activeCode = '2408'; return loadIntelCard({ code: '2408', currency: 'TWD', chip: null }); });
  const rErr = await pg.evaluate(() => [document.getElementById('intel-content').innerText, document.getElementById('ai-body').innerText]);
  ok('情報卡：顯示出錯時兩張卡都明講，不會卡在等待', rErr.every(t => /顯示時出錯/.test(t)), rErr.join('｜').slice(0, 120));
  intelResp = okResp;
  // 卡片進「心理AI」分頁，不再每頁都出現
  const pane = await pg.evaluate(() => { if (typeof buildLayout === 'function') buildLayout(); const c = document.getElementById('intel-card'), p = c && c.closest('.tab-pane'); return p ? p.id : '(不在任何分頁)'; });
  ok('情報卡：只出現在「心理AI」分頁', pane === 'pane-t-mind', pane);
  const aiSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  ok('AI研判：不再從瀏覽器直接呼叫 Claude（沒有金鑰、從來沒成功過）', !/api\.anthropic\.com|aiAnalysis/.test(aiSrc));

  // v180 使用者實測：9/28 教師節（9/25 中秋），最後交易日 9/24。只跳週末的推算會期待 9/28 → 法人、融資、估值卡全部誤報落後
  const hol = await pg.evaluate(() => {
    const n0 = Date.now, at = iso => { Date.now = () => Date.parse(iso); };
    try {
      _twHint = null; at('2026-09-28T17:05:00+08:00');
      const noHint = checkDataFreshness('20260924', 0);
      setTwExpected('20260924');
      const withHint = checkDataFreshness('20260924', 0), realLag = checkDataFreshness('20260923', 0);
      at('2026-09-29T17:00:00+08:00');
      const nextDay = checkDataFreshness('20260924', 0);
      return { noHint: noHint.stale, withHint: withHint.stale, realLag: realLag.stale, nextDay: nextDay.stale, exp: nextDay.expected };
    } finally { Date.now = n0; _twHint = null; }
  });
  ok('連假：沒有後端提示時只會跳週末（重現誤報）', hol.noHint === true);
  ok('連假：用後端扣除國定假日的日期，9/24 不再誤報落後', hol.withHint === false, JSON.stringify(hol));
  ok('連假：真的落後（9/23）照樣會報', hol.realLag === true);
  ok('連假：提示只在同一個推算日有效，隔天 9/29 收盤後就要 9/29 的資料', hol.nextDay === true && hol.exp === '20260929', JSON.stringify(hol));
  ok('連假：查詢時把後端的應有交易日連同「資料抓取時刻」交給推算', /setTwExpected\(D\.chip\.expected,window\._dataFetchedAt\)/.test(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')));
  // v181 審查發現：快取的資料（15:58 抓、16:02 重查）若用「現在」當推算基準，提示會一路掩蓋到隔天 16:00
  const hol2 = await pg.evaluate(() => {
    const n0 = Date.now;
    try { _twHint = null; Date.now = () => Date.parse('2026-09-30T16:02:00+08:00');
      setTwExpected('20260929', Date.parse('2026-09-30T15:58:00+08:00'));
      return checkDataFreshness('20260929', 0); } finally { Date.now = n0; _twHint = null; }
  });
  ok('連假：快取資料的提示用當時的推算基準，不掩蓋 16:00 後真正該有的新資料', hol2.stale === true && hol2.expected === '20260930', JSON.stringify(hol2));

  // v177 大盤基準：台美各自計時（原本共用時間戳，剛抓過美股會讓過期的台股基準繼續被用）
  const bc = await pg.evaluate(async () => {
    _benchCache = {}; await new Promise(async r => { const tx = (await pcOpen()).transaction('c', 'readwrite'); tx.objectStore('c').clear(); tx.oncomplete = r; }); const calls = [], f0 = window.fetchT, n0 = Date.now; let now = n0();
    Date.now = () => now; window.fetchT = async u => { calls.push(u); return { json: async () => ({ ok: true, closes: [calls.length] }) }; };
    try { await fetchBenchmark(true); now += 3 * 864e5; await fetchBenchmark(false); const tw = await fetchBenchmark(true); return { calls: calls.length, tw }; }
    finally { window.fetchT = f0; Date.now = n0; _benchCache = {}; }
  });
  ok('大盤基準：台美各自計時，過期的台股基準會重抓', bc.calls === 3 && bc.tw[0] === 3, JSON.stringify(bc));

  // v177 融資跨距不足：擁擠度不加分、融資卡不判讀並照實標示天數（同 v159 紀律門）
  const mg = await pg.evaluate(async () => {
    const c = Array.from({ length: 120 }, (_, i) => 100 + i); c[119] = 230;   // 多頭排列＋突破＋連漲＝散戶擁擠在多方
    const D = { code: 'TSTM', currency: 'TWD', closes: c, highs: c.map(x => x * 1.01), lows: c.map(x => x * 0.99), volumes: c.map(() => 1e6), price: 230 };
    const set = n => { _marginCache.TSTM = { d: { marginBal: 1000, shortBal: 50, shortRatio: 5, marginChg5: 9, chg5N: n }, t: Date.now() }; };
    const run = n => { set(n); const r = computeCrowding(D, null); return { dir: r.crowdDir, note: r.marginNote }; };
    const out = { short: run(2), full: run(5) };
    set(2); window._activeCode = 'TSTM'; await loadMarginCard(D);
    out.card = document.getElementById('margin-content').innerText;
    delete _marginCache.TSTM; return out;
  });
  ok('擁擠度：融資只跨 2 日時不加分（跨足 5 日才加）', mg.full.dir === 1 && !!mg.full.note && !mg.short.note, JSON.stringify({ short: mg.short, full: mg.full }));
  ok('融資卡：跨距不足時不判讀方向、照實標示天數', /資料天數不足/.test(mg.card) && /2日變化/.test(mg.card) && !/散戶追價|散戶接刀/.test(mg.card), mg.card.slice(0, 80));

  // v177 雲端載入：空備份要明講；刪掉的交易不可被雲端舊副本救回
  const cl = await pg.evaluate(async () => {
    const f0 = window.fetch; let cloud = { trades: [], settings: {} };
    window.fetch = async (u, o) => /sync_save/.test(u) ? (cloud = JSON.parse(o.body), { json: async () => ({ ok: true }) })
      : /sync_get/.test(u) ? { json: async () => ({ ok: true, data: cloud }) } : f0(u, o);
    const out = {}, has = async id => (await dbGetAllTrades()).some(t => t.id === id), err = async () => { try { await cloudLoad(); return '（沒有報錯）'; } catch (e) { return e.message; } };
    try {
      GAS_URL = 'https://selftest.local/exec';
      out.gasEmpty = await err(); cloud = {}; out.cfEmpty = await err();
      await dbAddTrade({ id: 't_tomb', date: '2026-09-01', code: '9999' }); await cloudSave();
      await dbDeleteTrade('t_tomb'); await cloudLoad();
      out.revived = await has('t_tomb');
      await cloudSave(); await dbSetSetting('deletedIds', []); await dbAddTrade({ id: 't_tomb', date: '2026-09-01', code: '9999' });   // 另一台裝置還留著這筆
      out.n = await cloudLoad(); out.otherKept = await has('t_tomb');
    } finally { window.fetch = f0; await dbDeleteTrade('t_tomb'); await dbSetSetting('deletedIds', []); }
    return out;
  });
  ok('雲端載入：沒有備份時明講（兩種後端的空回應都算）', /沒有備份/.test(cl.gasEmpty) && /沒有備份/.test(cl.cfEmpty), `${cl.gasEmpty}｜${cl.cfEmpty}`);
  ok('雲端載入：刪掉的交易不會被雲端舊副本救回', cl.revived === false);
  ok('雲端載入：別台裝置刪掉的交易，這台載入後也刪掉', cl.otherKept === false && cl.n === 0, JSON.stringify(cl));
  // v181 審查發現：舊裝置一存就把雲端的刪除紀錄整份蓋掉；誤刪後拿備份檔也救不回
  const cl2 = await pg.evaluate(async () => {
    const f0 = window.fetch; let cloud = { app: 'StockRadarPro', trades: [], settings: {}, deletedIds: ['t_x'] };
    window.fetch = async (u, o) => /sync_save/.test(u) ? (cloud = JSON.parse(o.body), { json: async () => ({ ok: true }) })
      : /sync_get/.test(u) ? { json: async () => ({ ok: true, data: cloud }) } : f0(u, o);
    const has = async id => (await dbGetAllTrades()).some(t => t.id === id), out = {};
    try {
      GAS_URL = 'https://selftest.local/exec';
      await dbSetSetting('deletedIds', []); await dbAddTrade({ id: 't_x', date: '2026-09-01', code: '9999' });   // 舊裝置：還留著、也沒載入過
      await cloudSave();
      const tombIds = () => (cloud.deletedIds || []).map(x => typeof x === 'string' ? x : x.id);
      out.cloudKeepsTomb = tombIds().includes('t_x'); out.cloudHasTrade = cloud.trades.some(t => t.id === 't_x'); out.localHas = await has('t_x');
      const n = await importBackup({ app: 'StockRadarPro', trades: [{ id: 't_x', date: '2026-09-01', code: '9999' }], settings: {} }, true);   // 使用者拿舊備份檔救回
      out.restored = n === 1 && await has('t_x');
      await cloudSave();   // v183 審查：原本這一存，雲端的舊墓碑又把剛還原的交易刪掉
      out.survivesSave = await has('t_x') && cloud.trades.some(t => t.id === 't_x');
      // 還原之後又刪一次：新的刪除比還原晚，要刪得掉
      await dbDeleteTrade('t_x'); await cloudSave();
      out.redeleted = !(await has('t_x')) && !cloud.trades.some(t => t.id === 't_x');
      // 別台新增並上傳的交易：這台（沒載入過）一存不可讓它從雲端消失
      cloud.trades.push({ id: 't_other', date: '2026-09-02', code: '8888' });
      await cloudSave();
      out.otherKept = cloud.trades.some(t => t.id === 't_other') && await has('t_other');
      await dbRemoveTrade('t_other');
    } finally { window.fetch = f0; await dbDeleteTrade('t_x'); await dbSetSetting('deletedIds', []); }
    return out;
  });
  ok('雲端儲存：先併入雲端的刪除紀錄，舊裝置一存不會把刪掉的交易送回雲端', cl2.cloudKeepsTomb && !cl2.cloudHasTrade && !cl2.localHas, JSON.stringify(cl2));
  ok('備份檔還原：使用者自己挑的檔案可以救回之前刪掉的交易', cl2.restored, JSON.stringify(cl2));
  ok('備份檔還原：之後按雲端儲存不會被舊的刪除紀錄再刪掉', cl2.survivesSave === true, JSON.stringify(cl2));
  ok('備份檔還原：還原後又刪一次，照樣刪得掉（刪除比還原晚）', cl2.redeleted === true, JSON.stringify(cl2));
  ok('雲端儲存：先併入別台裝置新增的交易，不會把它從雲端蓋掉', cl2.otherKept === true, JSON.stringify(cl2));

  // ── v182 數值誠實性稽核：沒有值就不可顯示成有值、不可拿去計分 ──
  const nv = await pg.evaluate(async () => {
    const out = {}, base = { dataDate: '20260924', expected: '20260924', headMiss: 0, n5: 5, n20: 20, foreign1: 100, foreign5: 500, foreign20: 800, trust1: 0, trust5: 0, trust20: 0, foreignStreak: 5, trustStreak: 0 };
    out.usable = [chipUsable(base), chipUsable({ ...base, fieldMiss: 'x' }), chipUsable({ ...base, headMiss: 1 }), chipUsable({ ...base, dataDate: '20260923' }), chipUsable(null)];
    const c = Array.from({ length: 120 }, (_, i) => 100 + i * 0.1), D = { code: 'TCHP', closes: c, highs: c.map(x => x * 1.01), lows: c.map(x => x * 0.99), volumes: c.map(() => 1e6), price: c[119], prevClose: c[118] };
    // 每天 +100 張、只抓到 8 天：20 日均應是 100（除以 8），不是 40（除以 20）
    out.fake = computeChipHealth({ ...base, n20: 8 }, D).signals.some(t => /5日>20日/.test(t));
    const up = c.slice(); up[119] = up[118] * 1.02; const v = c.map(() => 1e6); v[119] = 2e6;
    const Dup = { code: 'TUP', closes: up, highs: up.map(x => x * 1.01), lows: up.map(x => x * 0.99), volumes: v, price: up[119], prevClose: up[118] };
    out.volWithPrev = computeShiPower(Dup, null).breakdown.vol;
    const sh = computeShiPower({ ...Dup, prevClose: undefined, chip: undefined }, null).breakdown;
    out.na = [sh.chipNA, sh.industryNA];
    FINMIND_TOKEN = 'x'; window._activeCode = 'TLND';
    _deepCache.TLND = { d: { ok: true, lend: { bal: 1000, chg5: 12, chg5N: 2 } }, t: Date.now() };
    await loadDeepChipCard({ code: 'TLND', currency: 'TWD', price: 100, closes: c });
    out.lend2 = document.getElementById('deepchip-content').innerText;
    _deepCache.TLND = { d: { ok: true, lend: { bal: 1000, chg5: null, chg5N: 5 } }, t: Date.now() };
    await loadDeepChipCard({ code: 'TLND', currency: 'TWD', price: 100, closes: c });
    out.lend0 = document.getElementById('deepchip-content').innerText;
    FINMIND_TOKEN = ''; delete _deepCache.TLND;
    return out;
  });
  ok('籌碼可用性：欄名配不到、最新幾天缺漏、資料落後、沒有資料——一律不可用', JSON.stringify(nv.usable) === '[true,false,false,false,false]', JSON.stringify(nv.usable));
  ok('籌碼：20日均除以實際天數（只抓到8天不可假性「5日>20日＝吸籌」）', nv.fake === false);
  ok('勢能：有前一日收盤時，量增價漲＝90 分（掃描原本沒給前一日收盤，一律算成量增價跌）', nv.volWithPrev === 90, String(nv.volWithPrev));
  ok('勢能：沒有籌碼與大盤基準時標明「以中性50計」', nv.na[0] === true && nv.na[1] === true, JSON.stringify(nv.na));
  ok('借券：只跨 2 日時不判讀、照實寫天數（不寫「5日」「明顯增」）', /只跨 2 個交易日/.test(nv.lend2) && /2日 \+12%/.test(nv.lend2) && !/明顯增/.test(nv.lend2), nv.lend2.slice(0, 160));
  ok('借券：基期為 0 時寫「算不出」，不寫 0%', /基期為 0/.test(nv.lend0) && /變化率：—/.test(nv.lend0) && !/\+0%/.test(nv.lend0), nv.lend0.slice(0, 160));
  ok('scan.js：掃描的 D 帶前一日收盤', /prevClose: it\.closes\[it\.closes\.length - \(it\._trimmed \? 1 : 2\)\]/.test(fs.readFileSync(path.join(ROOT, 'scan.js'), 'utf8')));
  { const mf = fs.readFileSync(path.join(ROOT, 'mainforce.js'), 'utf8'), it = fs.readFileSync(path.join(ROOT, 'intel.js'), 'utf8');
    ok('籌碼：主力行為、擁擠度、明牌陷阱、情報判讀的法人加總都先過「可用」檢查（不把缺的當 0）',
      /if \(chipUsable\(chip\)\) \{[^\n]*\n\s*const instBuy = chip\.foreign5 \+ chip\.trust5;/.test(mf) && (mf.match(/chipUsable\(D\.chip\) \? D\.chip\.foreign5 \+ D\.chip\.trust5 : null/g) || []).length === 2
      && !/foreign5\s*\|\|\s*0/.test(mf + it) && /chipUsable\(ch\) && \(ch\.n5/.test(it)); }
  // 情報卡狀態列：實際耗時、或取自後端快取
  const tm0 = intelResp;
  intelResp = Object.assign({}, tm0, { code: '1216', timing: { fetch: 7400, ai: 18600 } });
  await pg.evaluate(() => { GAS_URL = 'http://scanflow.test/api'; window._activeCode = '1216'; return loadIntelCard({ code: '1216', currency: 'TWD', chip: null }); });
  const tmTxt = (await intelText()).txt;
  intelResp = Object.assign({}, tm0, { code: '1217', cached: true });
  await pg.evaluate(() => { window._activeCode = '1217'; return loadIntelCard({ code: '1217', currency: 'TWD', chip: null }); });
  const caTxt = (await intelText()).txt;
  intelResp = tm0;
  ok('情報卡：顯示實際耗時（抓資料／AI 分開），或標明取自後端快取', /耗時：抓資料 7 秒、AI 19 秒/.test(tmTxt) && /取自後端 10 分鐘快取/.test(caTxt) && !/耗時/.test(caTxt), tmTxt.slice(-160));

  // ── v183 全面稽核：前端數學、決策、日誌 ──
  const v3 = await pg.evaluate(async () => {
    const o = {}, n0 = Date.now;
    const mk = (n, f) => { const c = Array.from({ length: n }, (_, i) => f(i)); return { code: 'T183', currency: 'TWD', closes: c, highs: c.map(x => x * 1.01), lows: c.map(x => x * 0.99), volumes: c.map(() => 1e6), opens: c.slice(), price: c[n - 1], prevClose: c[n - 2], rawCloses: c, rawHighs: c.map(x => x * 1.01), rawLows: c.map(x => x * 0.99) }; };
    const D = mk(300, i => 100 * Math.exp(i * 0.003) * (1 + 0.02 * Math.sin(i / 3)));
    o.rsSelf = computeRSRating(D, D.closes);   // 自己對自己＝沒有超額報酬
    // 大盤基準：盤中要跟個股一樣去掉今天未完成的K棒
    try {
      Date.now = () => Date.parse('2026-09-30T10:00:00+08:00'); _benchCache = {}; await new Promise(async r => { const tx = (await pcOpen()).transaction('c', 'readwrite'); tx.objectStore('c').clear(); tx.oncomplete = r; });
      const f0 = window.fetchT; window.fetchT = async () => ({ json: async () => ({ ok: true, closes: D.closes.slice(), lastDate: '20260930' }) });
      o.benchLen = (await fetchBenchmark(true)).length; window.fetchT = f0;
    } finally { Date.now = n0; _benchCache = {}; }
    // 最大回撤只看近一年（252 根）
    const Ddd = mk(500, i => i < 100 ? 100 - i * 0.5 : 50 + (i - 100) * 0.2);   // 前 100 根腰斬，之後一路漲
    o.maxDD = computeRiskMetrics(Ddd).maxDD;
    // 融資四象限：全站同一套
    const today = expectedTradeDate(0), Dq = mk(60, i => 100); Dq.price = 99.5;   // 5 日跌 0.5%
    o.q = [marginQuadrant({ marginChg5: 5, chg5N: 5, dataDate: today }, Dq), marginQuadrant({ marginChg5: 5, chg5N: 5, dataDate: today }, { ...Dq, price: 98 }),
      marginQuadrant({ marginChg5: 5, chg5N: 5, dataDate: today, headMiss: 1 }, { ...Dq, price: 98 }), marginQuadrant({ marginChg5: null, chg5N: 5, dataDate: today }, { ...Dq, price: 98 })];
    // v184 盤中：量是昨天的，漲跌也要昨天那根（現價暴跌不可讓融資判成「接刀」、量價判成出貨）
    const Dqi = { ...Dq, closes: Dq.closes.slice(), price: 90, prevClose: 100, _intraday: '20260930' };
    o.qIntra = marginQuadrant({ marginChg5: 5, chg5N: 5, dataDate: today }, Dqi);
    o.bar = [barPx(Dqi), barPrev(Dqi), barPx({ ...Dq, price: 95, prevClose: 97 }), barPrev({ ...Dq, price: 95, prevClose: 97 })];
    const Dl = mk(300, i => 100 * Math.exp(i * 0.003));   // 大盤只有 200 根：區間要用兩邊都有的長度
    o.rsShort = computeRSRating(Dl, Dl.closes.slice(-200));
    // 分批進場：沒填張數不可冒出股數；沒代碼分不出張或股
    document.getElementById('batch-rows').innerHTML = ''; addBatchRow(); document.getElementById('tr-shares').value = '';
    { const bid = document.querySelector('[id^="batch-qty-"]').id.replace('batch-qty-', '');
      document.getElementById('batch-date-' + bid).value = '2026-09-01'; document.getElementById('batch-price-' + bid).value = '100';
      document.getElementById('tr-code').value = '2330'; calcBatch(); o.blankQty = document.getElementById('tr-shares').value;
      document.getElementById('batch-qty-' + bid).value = '2'; document.getElementById('tr-code').value = ''; calcBatch(); o.noCode = document.getElementById('tr-shares').value;
      document.getElementById('batch-rows').innerHTML = ''; }
    // 時鐘較慢的裝置刪掉「別台（時鐘較快）還原」的交易：刪除時間要比還原晚，雲端合併時不可復活
    { const ra = Date.now() + 600000; await dbAddTrade({ id: 't_skew', date: '2026-09-01', code: '9999', restoredAt: ra });
      await dbDeleteTrade('t_skew'); const gone = await applyTombstones([]);
      o.skew = { later: gone.get('t_skew') > ra, revived: await mergeTrades([{ id: 't_skew', date: '2026-09-01', code: '9999', restoredAt: ra }], gone) };
      await dbSetSetting('deletedIds', []); }
    // v187 紀律門讀風報比（A 級、權重最高）：與執行計畫同一算法，<1 必擋
    { const Dg = mk(300, i => 100 * (1 + 0.01 * Math.sin(i / 2)) + i * 0.02), g = computeTradeGate({ D: Dg }), pb = planBasis(Dg, 'long');
      o.gateRR = { rr: pb.rr, warnRR: g.long.warn.some(x => /風報比/.test(x)), v: g.long.vClass }; }
    // v187 美股盤中也去掉未完成的K棒（美東時段、美東日期）
    { const n1 = Date.now; try { Date.now = () => Date.parse('2026-10-01T11:00:00-04:00');
        const mkJ = cur => ({ closes: Array.from({ length: 80 }, (_, i) => i), lastDate: '20261001', currency: cur });
        o.usTrim = [trimIntradayBar(mkJ('USD')).closes.length, trimIntradayBar(mkJ('TWD')).closes.length];
        Date.now = () => Date.parse('2026-10-01T10:00:00+08:00'); o.twTrim = trimIntradayBar(mkJ('TWD')).closes.length; } finally { Date.now = n1; } }
    // v187 升版後舊暫存作廢
    { const db = await pcOpen(); await new Promise(r => { const tx = db.transaction('c', 'readwrite'); tx.objectStore('c').put({ k: 'fund:TOLD', d: { a: 1 }, t: Date.now(), until: Date.now() + 1e7, v: 1 }); tx.oncomplete = r; });
      o.oldVer = await pcGet({}, 'TOLD', 'fund'); }
    // 日誌：沒填股數＝金額未知；舊版「盈虧%×100」冒充金額的單也不算
    const ym = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);   // 預算看「台北本月」（每月 1 號時 expectedTradeDate 還是上個月）
    const T = [{ result: 'loss', pnlPct: -5, pnl: -500, shares: null, date: ym + '-01' },
               { result: 'loss', pnlPct: -5, pnl: -50000, shares: 1000, date: ym + '-01' },
               { result: 'win', pnlPct: 10, pnl: null, shares: null, date: ym + '-01' }];
    const st = computeStats(T), rb = computeRiskBudget(T, 1000000);
    o.stats = { total: st.totalPnl, noAmt: st.noAmt, payoff: +st.payoff.toFixed(2) };
    o.rb = { used: rb.usedPct, noAmt: rb.noAmt };
    // 分批進場填的是「張」，股數欄要 ×1000
    document.getElementById('tr-code').value = '2330'; document.getElementById('batch-rows').innerHTML = ''; addBatchRow();
    const id = document.querySelector('[id^="batch-qty-"]').id.replace('batch-qty-', '');
    document.getElementById('batch-date-' + id).value = '2026-09-01'; document.getElementById('batch-price-' + id).value = '100'; document.getElementById('batch-qty-' + id).value = '3';
    calcBatch(); o.shares = document.getElementById('tr-shares').value;
    document.getElementById('tr-shares').value = ''; document.getElementById('batch-rows').innerHTML = '';
    // 雲端／備份檔來的文字要跳脫
    window._xss = 0; await dbAddTrade({ id: 't_xss', date: today.slice(0, 4) + '-01-01', code: '<img src=x onerror="window._xss=1">', result: 'win', pnlPct: 1, judgment: 'wrong', judgmentReason: '"><img src=x onerror="window._xss=2">' });
    await refreshJournal(); await new Promise(r => setTimeout(r, 200)); o.xss = window._xss; await dbRemoveTrade('t_xss'); await refreshJournal();
    return o;
  });
  ok('盤中：融資四象限用昨天收盤（現價盤中暴跌不算「接刀」）', v3.qIntra === 'flat', String(v3.qIntra));
  ok('盤中：同一根K棒的價（盤中＝最後一根與前一根收盤；收盤後＝現價與昨收）', JSON.stringify(v3.bar) === '[100,100,95,97]', JSON.stringify(v3.bar));
  ok('RS：大盤較短時兩邊用同一段區間（同一條序列＝50）', v3.rsShort.rating === 50 && Math.abs(v3.rsShort.excess) < 1e-9, JSON.stringify(v3.rsShort));
  ok('分批進場：有批次沒填張數就不填股數；沒填代碼也不填（分不出張或股）', v3.blankQty === '' && v3.noCode === '', JSON.stringify([v3.blankQty, v3.noCode]));
  ok('同步：時鐘較慢的裝置刪除「別台還原的交易」照樣刪得掉，不會在合併時復活', v3.skew.later && v3.skew.revived === 0, JSON.stringify(v3.skew));
  ok('紀律門：風報比 <1 列入提醒（與執行計畫同一算法）', v3.gateRR.rr != null && v3.gateRR.warnRR === (v3.gateRR.rr < 1) && ['ok', 'no'].includes(v3.gateRR.v), JSON.stringify(v3.gateRR));
  ok('盤中：美股在美東盤中也去掉未完成的K棒；台股照舊（各用自己的時段）', JSON.stringify(v3.usTrim) === '[79,80]' && v3.twTrim === 79, JSON.stringify([v3.usTrim, v3.twTrim]));
  ok('暫存：升版後舊版本存的資料不再使用', v3.oldVer === null, JSON.stringify(v3.oldVer));
  ok('RS：大盤用同樣的加權（自己對自己＝50、超額 0）', v3.rsSelf.rating === 50 && Math.abs(v3.rsSelf.excess) < 1e-9, JSON.stringify(v3.rsSelf));
  ok('大盤基準：盤中去掉今天未完成的K棒（與個股對齊，Beta 不錯位）', v3.benchLen === 299, String(v3.benchLen));
  ok('最大回撤：只看近一年（兩年前的腰斬不算）', v3.maxDD > -0.05, String(v3.maxDD));
  ok('融資四象限：股價只跌 0.5% 不算「散戶接刀」（與融資卡一致）；落後或基期 0 不判讀', JSON.stringify(v3.q) === '["flat","knife",null,null]', JSON.stringify(v3.q));
  ok('日誌：金額只算有填股數的單、盈虧比用%；6%預算明講有幾筆沒算', v3.stats.total === -50000 && v3.stats.noAmt === 2 && v3.stats.payoff === 2 && v3.rb.used === 5 && v3.rb.noAmt === 2, JSON.stringify([v3.stats, v3.rb]));
  ok('日誌：分批進場 3 張＝3000 股（原本填成 3 股，金額小 1000 倍）', v3.shares === '3000', v3.shares);
  ok('日誌：代碼與判斷理由裡的 HTML 不會被執行', v3.xss === 0, String(v3.xss));
  { const ap = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), bf = fs.readFileSync(path.join(ROOT, 'bingfa.js'), 'utf8'), av = fs.readFileSync(path.join(ROOT, 'advanced.js'), 'utf8');
    ok('本次的 D 在啟動非同步卡片之前就登記', ap.indexOf('window._lastD=D;') < ap.indexOf("loadFundamentalCard(D)") && ap.indexOf('window._lastD=D;') > 0);
    { const src = ['bingfa.js', 'enhance.js', 'mainforce.js', 'advanced.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'), jn = fs.readFileSync(path.join(ROOT, 'journal.js'), 'utf8'), sc = fs.readFileSync(path.join(ROOT, 'scan.js'), 'utf8');
      ok('盤中量價：分析檔不再拿現價配昨天的量（price／D.price 對 prevClose）', !/(\bprice|D\.price) > D\.prevClose|\(price - D\.prevClose\)|\(D\.price - c\[n - 6\]\)|\(price - c\[n-6\]\)/.test(src) && /_intraday: it\._intraday/.test(sc));
      ok('券資比「軋空燃料」與融資卡同一條線；融資卡過期資料不判軋空；橫幅籌碼警告用 chipUsable', !/shortRatio >= 25/.test(src) && /const sr = marginFresh\(m\) \? m\.shortRatio : null/.test(src) && /if \(cp && !chipUsable\(cp\)\) addW/.test(src));
      ok('匯出：沒有金額的統計印「—」不印 +0；紀律門重繪出錯不清掉 6% 預算', !/cur\((s|d|rs|ss)\.(totalPnl|expectancy|avgWin|avgLoss|maxDrawdown)\)/.test(jn) && /catch \(e\) \{ if \(typeof ErrorLog !== 'undefined'\) ErrorLog\.push\('紀律門重繪'/.test(jn));
      ok('掃描池說明裡的後端文字有跳脫', /escI\(p\.srcErrors\.join/.test(sc) && /動態池取得失敗：\$\{escI\(/.test(sc)); }
    { const bf = fs.readFileSync(path.join(ROOT, 'bingfa.js'), 'utf8'), en = fs.readFileSync(path.join(ROOT, 'enhance.js'), 'utf8'), mf = fs.readFileSync(path.join(ROOT, 'mainforce.js'), 'utf8'),
        jn = fs.readFileSync(path.join(ROOT, 'journal.js'), 'utf8'), mk = fs.readFileSync(path.join(ROOT, 'market.js'), 'utf8'), av = fs.readFileSync(path.join(ROOT, 'advanced.js'), 'utf8');
      ok('行為結構：不足 3 票不當方向證據（橫幅、綜合研判、敘事、翻盤條件都看 decisive）', /decisive: votes\.length >= 3/.test(bf) && /syn\.decisive \? \(syn\.score/.test(bf) && /if \(syn && syn\.decisive\) inval/.test(bf));
      ok('橫幅：空方也先看紀律門；營收窗口不重複兩條', /gS && gS\.fail\.length/.test(bf) && /if \(!ew\) try \{/.test(bf));
      ok('主力意圖：回測與即時餵同樣欄位；信心 <50 不投方向票', /opens: D\.opens \? D\.opens\.slice\(0, i \+ 1\) : undefined/.test(mf) && /prevClose: D\.closes\[i - 1\]/.test(mf) && /if \(intent\.confidence < 50\) \{ intentDir = 0/.test(bf));
      ok('盤中量能：不再「推估全日量」（最後一根已是完整K棒）', !/ph\.elapsed/.test(en + mf + bf));
      ok('勢能 5 日趨勢帶前一日收盤；開盤缺口盤中用今天開盤；Amihud 報酬用還原價', /prevClose: D\.closes\[n - 2\]/.test(en) && /live \? \(D\.open - c\[n - 1\]\)/.test(en) && /const dollar = raw\[i\] \* v\[i\]/.test(en));
      ok('融資卡文字與四象限同一段股價；RS 沒有大盤時不當相對強弱', /chg5 = n >= 6 \? \(barPx\(D\) - c\[n-6\]\)/.test(mf) && /rsRating=rs\.excess!=null\?rs\.rating:null/.test(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')));
      ok('日誌進場公式只用進場日之前的K線；基本面失敗講原因；盤中不比類股廣度', /until=\$\{dayBefore\(entryDate\)\}/.test(jn) && /基本面取得失敗/.test(av) && /const live = inSession\(Date\.now\(\), \.\.\.SESS\.tw\)/.test(mk)); }
    ok('凱利 b：風險卡是做多配置，兩處都用「上漲」可達幅度', (ap.match(/computeRealisticTargets\(D, 1, stopPct\)/g) || []).length === 2 && !/computeRealisticTargets\(D, *(dir|sgn|-1)[^)]*stopPct\)/.test(ap));
    ok('盤中：量價訊號用同一天（昨天）的K棒', /kC=barPx\(D\), kO=D\._intraday\?\(D\.opens\?D\.opens\[D\.opens\.length-1\]:barPrev\(D\)\):open/.test(ap));
    ok('橫幅遇紀律門禁止時不叫你進場', /computeTradeGate\(\{ D, regime, mtf, shi \}\)/.test(bf));
    ok('券資比門檻全站同一條（18%／30%）', /SHORT_RATIO_HOT/.test(fs.readFileSync(path.join(ROOT, 'mainforce.js'), 'utf8')) && !/shortRatio >= (15|20)\b/.test(bf + fs.readFileSync(path.join(ROOT, 'mainforce.js'), 'utf8'))); }
  // 掃描：三顆按鈕同一把鎖
  poolDelay = 800;
  await pg.evaluate(() => { openScan(); window._sa = runScanAuto('long'); });
  await pg.waitForTimeout(200);
  const lockAll = await pg.evaluate(() => ['scan-short', 'scan-long', 'scan-run'].map(id => document.getElementById(id).disabled));
  await pg.evaluate(() => window._sa); poolDelay = 0;
  ok('掃描：自動池抓取中，「用此清單掃描」也鎖住（不會兩輪同時跑）', lockAll.every(Boolean), JSON.stringify(lockAll));
  await pg.evaluate(() => closeScan());

  // v184 資訊面校準面板
  snapResp = code => code ? { ok: true, noMeta: 0, rows: [{ code, d: '20260901', asOf: 1, ai: 'ok', tilt: 0.6, prompt: 'v180', fwd: { entry: '20260901', r5: 0.03, ex5: 0.02 } }] }
    : { ok: true, noMeta: 1, rows: [{ code: '2330', d: '20260901', asOf: 1, ai: 'ok', tilt: 0.6 }, { code: '2317', d: '20260902', asOf: 2, ai: 'ok', tilt: -0.6 }] };
  await pg.evaluate(() => runIntelCalib());
  const cal = await pg.evaluate(() => document.getElementById('intel-calib').innerText);
  ok('資訊面校準：逐檔抓之後 5 日、列出方向組別與樣本不足', /共 2 筆已滿 5 日的快照（2 檔）/.test(cal) && /1 筆內容無法判讀/.test(cal) && /偏多 \| 2 \|/.test(cal) && /樣本不足/.test(cal), cal.slice(0, 300));
  snapResp = () => ({ ok: false, error: '這支 Worker 沒有綁定 KV（名稱須為 SYNC），沒有快照可讀' });
  await pg.evaluate(() => runIntelCalib());
  const calE = await pg.evaluate(() => document.getElementById('intel-calib').innerText);
  ok('資訊面校準：後端讀不到快照時明講原因', /❌.*沒有綁定 KV/.test(calE), calE);

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
  let todayBar = false, chip = null, slowCode = null, stockCalls = {}, intelMock = null;
  await pg.route('https://selftest.local/**', async rt => { if (slowCode && new URL(rt.request().url()).searchParams.get('code') === slowCode) await new Promise(r => setTimeout(r, 1200)); const u = new URL(rt.request().url()); const act = u.searchParams.get('action'); const code = u.searchParams.get('code');
    if (act === 'scan') { const list = (u.searchParams.get('codes') || '').split(',').filter(c => codes.includes(c));
      return rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, results: list.map(c => { const m = mkPayload(c, todayBar);
        return { code: c, ok: true, closes: m.closes, highs: m.highs, lows: m.lows, volumes: m.volumes, opens: m.opens, price: m.price, lastDate: m.lastDate }; }) }) }); }
    if (!act && code) { stockCalls[code] = (stockCalls[code] || 0) + 1; const p = mkPayload(code, todayBar); if (chip) p.chip = chip; return rt.fulfill({ contentType: 'application/json', body: JSON.stringify(p) }); }
    if (act === 'intel' && intelMock) return rt.fulfill({ contentType: 'application/json', body: JSON.stringify(intelMock) });
    rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'selftest-mock' }) }); });
  await pg.goto('http://localhost:8791/index.html'); await pg.waitForTimeout(1200);

  const query = async (code) => { await pg.evaluate(async c => { GAS_URL = 'https://selftest.local/exec';
      Object.keys(_stockCache).forEach(k => delete _stockCache[k]); await new Promise(async r => { const tx = (await pcOpen()).transaction('c', 'readwrite'); tx.objectStore('c').clear(); tx.oncomplete = r; });
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
  intelMock = { ok: true, code: codes[0], items: [], events: [], ai: { status: 'ok', summary: '' }, attention: {}, srcErrors: [], notes: [],
    revenue: { ym: 202608, rev: 1e9, yoy: 0.6, mom: 0.08, ytd: null, mean: 0.2, n: 12, sur: 19.6, streak: 3, seen: '' } };
  { await query(codes[0]); const nar = await pg.evaluate(() => [(document.getElementById('vb-narrative') || {}).innerText || '', (document.getElementById('vb-judgement') || {}).innerText || '']);
    ok('敘事：風報比同時列做多與做空（原本依 X 級的「環境」選一邊、且沒寫是哪邊）', !/結構/.test(nar[0]) || (/做多/.test(nar[0]) && /做空/.test(nar[0])), nar[0].slice(0, 200));
    ok('v188 綜合研判：不再出現永遠「證據分散」的那一行，只留有回測數字的期望值', !/綜合研判/.test(nar[1]) && /期望值（19年24檔/.test(nar[1]), nar[1].slice(0, 160));
    // v190 端到端：情報面（月營收驚奇 +19.6）到了之後，橫幅的中期因子出現營收列與合成組別
    const got = await pg.waitForFunction(() => /營收驚奇 \+19\.6/.test((document.getElementById('vb-judgement') || {}).innerText || ''), null, { timeout: 15000 }).then(() => true, () => false);
    const e2e = await pg.evaluate(() => (document.getElementById('vb-judgement') || {}).innerText || '');
    ok('中期因子端到端：情報面到了→橫幅顯示52週高點、營收驚奇（最高組）與三者合成', got && /距52週高點 [-+]\d/.test(e2e) && /8月營收驚奇 \+19\.6｜約全市場第 100 百分位（第 5／5 組）→ 該組之後3個月平均超額 \+1\.93%/.test(e2e)
      && /四者等權合成：第 \d／5 組/.test(e2e) && /🧭 分析方向：中期(偏空|略偏空|中性|略偏多|偏多)/.test(e2e) && /短線風險：做多 🟡未禁止/.test(e2e), e2e.slice(e2e.indexOf('📊'), e2e.indexOf('📊') + 200)); }
  // v177 兩次查詢重疊（Enter／最近查詢／掃描不經過停用的按鈕）：先查的晚回來，不可把它的卡片畫進後查那檔
  slowCode = codes[1];
  await pg.evaluate(async ([a, c2]) => { GAS_URL = 'https://selftest.local/exec'; Object.keys(_stockCache).forEach(k => delete _stockCache[k]); await new Promise(async r => { const tx = (await pcOpen()).transaction('c', 'readwrite'); tx.objectStore('c').clear(); tx.oncomplete = r; });
    const inp = document.getElementById('ticker-input'); inp.value = a; window._r1 = go(); inp.value = c2; window._r2 = go(); }, [codes[1], codes[2]]);
  await pg.evaluate(() => Promise.all([window._r1, window._r2])); await pg.waitForTimeout(1800);
  const race = await pg.evaluate(() => ({ bar: document.getElementById('sb-code').textContent, last: window._lastD && window._lastD.code, btn: document.getElementById('go-btn').disabled }));
  ok('重疊查詢：先查的晚回來不會蓋掉後查那檔', race.bar === codes[2] && race.last === codes[2] && !race.btn, JSON.stringify(race));
  slowCode = null;
  // v186 暫存：關掉 App 也還在；⟳ 重新抓取會真的重抓
  { await query(codes[3]); stockCalls = {};
    await pg.evaluate(async c => { document.getElementById('ticker-input').value = c; await go(); }, codes[3]);
    const second = stockCalls[codes[3]] || 0;
    const pill1 = await pg.evaluate(() => [document.getElementById('time-pill').textContent, getComputedStyle(document.getElementById('refresh-btn')).display]);
    await pg.reload(); await pg.waitForTimeout(1200);
    await pg.evaluate(async c => { GAS_URL = 'https://selftest.local/exec'; document.getElementById('ticker-input').value = c; await go(); }, codes[3]);
    const afterReload = stockCalls[codes[3]] || 0;
    await pg.evaluate(() => forceRefresh()); await pg.waitForTimeout(600);
    const pill2 = await pg.evaluate(() => document.getElementById('time-pill').textContent);
    const ttl = await pg.evaluate(async () => { const m = {}; pcSet(m, 'TX', 'fund', { a: 1 }, Date.now() - 1); delete m.TX; await new Promise(r => setTimeout(r, 200)); return await pcGet(m, 'TX', 'fund'); });
    ok('暫存：同一檔再查不打後端', second === 0, String(second));
    { const it = fs.readFileSync(path.join(ROOT, 'intel.js'), 'utf8'), mk = fs.readFileSync(path.join(ROOT, 'market.js'), 'utf8'), mf = fs.readFileSync(path.join(ROOT, 'mainforce.js'), 'utf8');
      ok('暫存：情報面／大盤有失敗的只留 5 分鐘；FinMind 只有「需付費方案」不算暫時性錯誤', /j\.ai\.status === 'ok' && !j\.srcErrors\.length \? cacheUntil\('intel'/.test(it)
        && /\(j\.sourceErrors \|\| \[\]\)\.length \? Date\.now\(\) \+ CACHE_TTL : cacheUntil\('market'/.test(mk) && /\[j\.bigErr, j\.brokerErr\]\.some\(x => fetchFail\(x\) && !\/402\/\.test\(x\)\)/.test(mf)); }
    ok('暫存：時間標籤寫「暫存」，⟳ 顯示', /（暫存）/.test(pill1[0]) && pill1[1] === 'flex', JSON.stringify(pill1));
    ok('暫存：關掉 App（重新載入）後仍沿用，不重打後端', afterReload === 0, String(afterReload));
    ok('暫存：⟳ 重新抓取會真的打後端，標示「即時」', stockCalls[codes[3]] === 1 && /即時/.test(pill2), `${JSON.stringify(stockCalls)} ${pill2}`);
    ok('暫存：過期的不拿出來用', ttl === null, JSON.stringify(ttl)); }
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
  const chipUsableSrc = (fs.readFileSync(path.join(ROOT, 'enhance.js'), 'utf8').match(/function chipUsable[\s\S]*?\n}/) || [''])[0];   // 頁面上由 enhance.js 提供
  const F = new Function('window', chipUsableSrc + '\n' + fs.readFileSync(path.join(ROOT, 'intel.js'), 'utf8') + '\nreturn { intelVerdict, renderIntel, snapDir, calibStats, calibMd, tradeSnap, intelTradeMd, hitVerdict };')({});
  const NOW = Date.now();
  const st = (car, scar, extra = {}) => ({ status: 'ok', car, scar, L: 3, pre: 0, preScar: 0, t0: '20260926', ...extra });
  const J = (tilt, study, o = {}) => ({
    ai: { status: 'ok', summary: '' }, tilt: tilt == null ? null : { tilt, conflict: o.conflict || 0, n: 1 },
    events: [{ title: '法說上修', type: '法說', dir: Math.sign(tilt || 0), mag: 2, conf: 0.8, ids: [0], first: NOW - 3600e3, study }],
    items: [{ kind: 'news', title: 'x', src: 's', url: 'https://a.b', t: NOW - 3600e3 }], attention: o.att || {}, srcErrors: [], notes: [] });
  const chip = (f, t, n5 = 5) => ({ chip: { foreign5: f, trust5: t, n5 } });
  const V = (j, d) => F.intelVerdict(j, d);

  // ── v184 資訊面回測 ──
  ok('快照方向：AI 沒成功＝沒有方向（不可當中性）；沒有事件＝中性；門檻同卡片',
    JSON.stringify([{ ai: 'error', tilt: 0.9 }, { ai: 'ok', tilt: null }, { ai: 'ok', tilt: 0.3 }, { ai: 'ok', tilt: -0.3 }, { ai: 'ok', tilt: 0.2 }].map(F.snapDir)) === '[null,0,1,-1,0]');
  { const R = (tilt, ex5, ai = 'ok') => ({ code: '2330', d: '20260901', ai, tilt, prompt: 'v180', fwd: { ex5, r5: ex5 } });
    const rows = [].concat(Array.from({ length: 30 }, (_, i) => R(0.5, i < 24 ? 0.02 : -0.01)), Array.from({ length: 10 }, (_, i) => R(-0.5, i < 2 ? 0.01 : -0.02)),
      Array.from({ length: 10 }, () => R(0.1, 0.01)), [R(0.9, 0.05, 'error'), { code: '2330', d: '20260928', ai: 'ok', tilt: 0.5, fwd: { why: 'pending' } }]);
    const c = F.calibStats(rows), md = F.calibMd({ ...c, noMeta: 0, errs: [] });
    // 超額報酬為正：偏多 24 + 偏空 2 + 中性 10 + AI失敗 1 = 37 / 51
    ok('校準：命中率與基準（超額報酬為正的比例）算對；AI 失敗與未滿 5 日分開列', c.n === 51 && Math.abs(c.up - 37 / 51) < 1e-9 && c.bull.n === 30 && Math.abs(c.bull.hit - 0.8) < 1e-9
      && c.bear.n === 10 && Math.abs(c.bear.p0 - 14 / 51) < 1e-9 && c.noAI === 1 && c.pending === 1, JSON.stringify(c).slice(0, 200));
    ok('校準：未達 20 筆明講樣本不足，不下結論', /偏空 \| 10 \|[^\n]*樣本不足/.test(md) && /偏多 \| 30 \|/.test(md), md.slice(0, 400));
    ok('校準：沒有樣本時明講，不給空表格', /還沒有可檢驗的樣本/.test(F.calibMd({ ...F.calibStats([]), noMeta: 0, errs: [] })));
    ok('校準：z 檢定方向正確（高於基準＝優、低於＝反指標）', /顯著優於/.test(F.hitVerdict(100, 0.7, 0.5, 20)) && /反指標/.test(F.hitVerdict(100, 0.3, 0.5, 20)) && /無差異/.test(F.hitVerdict(100, 0.55, 0.5, 20))); }
  { const S = (d, tilt) => ({ code: '2330', d, ai: 'ok', tilt });
    const rows = [S('20260910', -0.5), S('20260908', 0.5), S('20260911', 0.9), S('20260901', 0.9), { ...S('20260909', 0.9), code: '2317' }];
    const t = { code: '2330', entryDate: '2026-09-11', direction: 'long', result: 'win', pnlPct: 3 };
    ok('交易對照：用進場日「之前」最近的快照（當天的可能是收盤後才查的）；超過 7 天不算', (F.tradeSnap(t, rows) || {}).d === '20260910'
      && F.tradeSnap({ ...t, entryDate: '2026-09-20' }, rows) === null && (F.tradeSnap({ ...t, code: '2330.TW' }, rows) || {}).d === '20260910');
    const md = F.intelTradeMd([t, { ...t, direction: 'short', result: 'loss', pnlPct: -2 }, { ...t, entryDate: '2026-09-30' }], rows);
    const mdUS = F.intelTradeMd([t, { ...t, code: 'AAPL', result: 'loss' }], rows);
    ok('交易對照：美股沒有資訊面，不列入各組也不拉低基準', /沒查資訊面[^|]*\| 0 \|/.test(mdUS) && /全部台股交易勝率 100\.0%（另 1 筆非台股/.test(mdUS), mdUS);
    ok('交易對照：做多遇偏空快照＝逆、做空遇偏空＝順、沒快照另列', /順著資訊面 \| 1 \| 0\.0%/.test(md) && /逆著資訊面 \| 1 \| 100\.0%/.test(md) && /沒查資訊面[^|]*\| 1 \|/.test(md), md); }

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
  const ser3 = [{ d: '20260922', n: 2 }, { d: '20260923', n: 3 }, { d: '20260924', n: 2 }];
  v = V(J(0.8, st(0.01, 0.5), { att: { news: { n: 19, series: ser3, pending: 12, med: 2.5, ratio: 1, trend: '持平' } } }), chip(0, 0));
  ok('情報判讀：收盤後（連假）累積暴增→提醒將影響下一交易日', v.notes.some(n => /收盤後已累積 12 則/.test(n) && /下一個交易日/.test(n)), JSON.stringify(v.notes));
  v = V(J(0.8, st(0.01, 0.5), { att: { news: { n: 16, series: [{ d: '20260922', n: 2 }, { d: '20260923', n: 3 }, { d: '20260924', n: 9 }], pending: 1, med: 2.5, ratio: 2.4, trend: '升溫' } } }), chip(0, 0));
  ok('情報判讀：最新交易日暴增→標出日期與倍數', v.notes.some(n => /09\/24 當日 9 則/.test(n) && /3\.6 倍/.test(n)), JSON.stringify(v.notes));
  v = V(J(0.8, st(0.01, 0.5), { att: { news: { n: 9, series: ser3, pending: 2, med: 2.5, ratio: 1, trend: '持平' } } }), chip(0, 0));
  ok('情報判讀：熱度正常時不發暴增警示', !v.notes.some(n => /暴增/.test(n)));
  const oldBk = J(0.8, st(0.01, 0.5), { att: { news: { n: 3, last24: 2, med: 1, ratio: 2, daily: [2, 1, 0, 0, 0, 0, 0] } } });
  let oldErr = ''; try { F.renderIntel(oldBk, chip(0, 0)); } catch (e) { oldErr = e.message; }
  ok('情報卡：舊版後端（v174 以前的格式）不會讓卡片崩潰', !oldErr, oldErr);
  const barH = F.renderIntel(J(0.8, st(0.05, 3), { att: { news: { n: 9, series: ser3, pending: 5, med: 2.5, ratio: 1, trend: '持平' } } }), chip(0, 0));
  ok('情報卡：每交易日長條圖＋「待開盤」虛線', /9\/22/.test(barH) && /待開盤/.test(barH) && /dashed/.test(barH) && /熱度持平/.test(barH));
  ok('情報卡：有 FinMind token 時一併送給後端', /action=intel&code=\$\{encodeURIComponent\(code\)\}\$\{tk\}/.test(fs.readFileSync(path.join(ROOT, 'intel.js'), 'utf8')));
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
  ok('證據登記：情報面新聞與AI方向列為 U（只顯示不計分），月營收驚奇為 A', /U 外資台指期、選擇權PCR、情報面新聞與AI方向/.test(cfg) && /A 中期因子（midFactors）/.test(cfg));
  const others = fs.readdirSync(ROOT).filter(f => /\.js$/.test(f) && !['intel.js', 'selftest.js', 'app.js', 'worker.js'].includes(f));
  // v190 唯一例外：月營收（全市場回測★）只能經由 bingfa.js 的 midFactors() 讀 revenue 欄位；新聞／AI 方向仍不准進分數
  const noRev = src => src.replace(/function midFactors\(D\) \{[\s\S]*?\n\}/, '');
  const leak = others.filter(f => /intelVerdict|\.tilt\b|_intelCache/.test(noRev(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
  ok('其他模組沒有讀情報結果（確保不會偷偷進分數；只有 midFactors 可讀月營收與財報）', leak.length === 0 && /ic = e0 && e0\.v === APP_VERSION && Date\.now\(\) - e0\.t < 864e5 && e0, rv = ic && ic\.d && ic\.d\.revenue, ql = ic && ic\.d && ic\.d\.quality;/.test(fs.readFileSync(path.join(ROOT, 'bingfa.js'), 'utf8')), leak.join(','));
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
  new Function('module', src + '\nmodule.yahooChart=yahooChart;module.fetchRangeOHLC=fetchRangeOHLC;module.fetchHistUntil=fetchHistUntil;module.fetchTaiwanChip=fetchTaiwanChip;module.fetchTaifexFutures=fetchTaifexFutures;module.fetchTaifexPCR=fetchTaifexPCR;module.fetchMargin=fetchMargin;module.fetchTopPool=fetchTopPool;module.rocToYmd=rocToYmd;module.eventStudy=eventStudy;module.infoTilt=infoTilt;module.validateAI=validateAI;module.parseRSS=parseRSS;module.parsePTT=parsePTT;module.parseAnnounce=parseAnnounce;module.fetchIntel=fetchIntel;module.dropIntraday=dropIntraday;module.fetchNews=fetchNews;module.fetchIntelRouted=fetchIntelRouted;module.dedupKey=dedupKey;module.heat=heat;module.parseFinMindNews=parseFinMindNews;module.dayMoves=dayMoves;module.mergeDays=mergeDays;module.intelPrompt=intelPrompt;module.revSurprise=revSurprise;module.fetchNewsEn=fetchNewsEn;module.normCite=normCite;module.yahooQuote=yahooQuote;module.numN=numN;module.peN=peN;module.fetchDeepChip=fetchDeepChip;module.fetchMarket=fetchMarket;module.fetchFundamental=fetchFundamental;module.saveIntelSnap=saveIntelSnap;module.listIntelSnaps=listIntelSnaps;module.snapFwd=snapFwd;module.fetchTaiwan=fetchTaiwan;')(W);
  const W2 = W;

  // Code.gs：補上 GAS 全域物件
  const pad = n => String(n).padStart(2, '0');
  let gsFetch = () => ({ getResponseCode: () => 200, getContentText: () => '{}' });
  global.UrlFetchApp = { fetch: (...a) => gsFetch(...a), fetchAll: reqs => reqs.map(r => gsFetch(r.url, r)) };
  let gsProps = {};
  /* 使用者屬性庫：照 Google 實際限制——單一值超過 9KB 就丟錯（v174 以前的測試替身不擋，所以一直沒發現） */
  const userStore = {};
  const u8 = v => Buffer.byteLength(String(v), 'utf8');
  const userProps = {
    getProperty: k => (k in userStore ? userStore[k] : null),
    // 真的屬性庫以 UTF-8 儲存：被切開的半個 emoji 會變成 �（Node 的 UTF-8 編碼行為相同）
    setProperty: (k, v) => { if (u8(v) > 9216) throw new Error('Argument too large: value'); userStore[k] = Buffer.from(String(v), 'utf8').toString('utf8'); },
    setProperties: o => { for (const k in o) if (u8(o[k]) > 9216) throw new Error('Argument too large: value'); for (const k in o) userStore[k] = Buffer.from(String(o[k]), 'utf8').toString('utf8'); },
    getKeys: () => Object.keys(userStore), deleteProperty: k => { delete userStore[k]; },
  };
  global.PropertiesService = { getUserProperties: () => userProps,
    getScriptProperties: () => ({ getProperty: k => gsProps[k] || null }) };
  let lockHeld = false;   // 照 GAS 行為：同一時間只有一個執行者拿得到鎖
  global.LockService = { getScriptLock: () => ({ tryLock: () => (lockHeld ? false : (lockHeld = true)), releaseLock: () => { lockHeld = false; } }) };
  global.ContentService = { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 1 } };
  global.Utilities = { sleep() {}, formatDate(d, tz, fmt) {
    const x = new Date(d.getTime() + (tz === 'Asia/Taipei' ? 8 * 3600000 : 0));
    if (fmt === 'u') return String(x.getUTCDay() === 0 ? 7 : x.getUTCDay());
    const y = x.getUTCFullYear(), m = pad(x.getUTCMonth() + 1), dd = pad(x.getUTCDate());
    return fmt === 'yyyy-MM-dd' ? `${y}-${m}-${dd}` : `${y}${m}${dd}`;
  } };
  /* v179 Code.gs 必須是 ES5（舊版 Rhino 執行環境一個 ES6 語法就整支腳本無法解析）——先前只靠人工檢查 */
  {
    const code = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    const bad = [['=>', /=>/], ['let/const', /\b(let|const)\s/], ['樣板字串', /`[^`\n]*\$\{/], ['.includes', /\.includes\(/], ['.find', /\.find(Index)?\(/],
      ['padStart', /padStart/], ['Math.sign', /Math\.sign/], ['展開 ...', /\.\.\.[A-Za-z_(\[]/], ['Set/Map', /new (Set|Map)\b/], ['\\p{}', /\\p\{/]]
      .filter(([, re]) => re.test(code)).map(([n]) => n);
    ok('Code.gs 只用 ES5 語法（Rhino 可解析）', !bad.length, bad.join('、'));
  }
  const G = {};
  new Function('module', fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8') + '\nmodule.fetchYahoo=fetchYahoo;module.fetchYahooTW=fetchYahooTW;module.fetchRangeOHLC=fetchRangeOHLC;module.fetchHistUntil=fetchHistUntil;module.fetchTaiwanChip=fetchTaiwanChip;module.fetchTopPool=fetchTopPool;module.rocToYmd=rocToYmd;module.eventStudy=eventStudy;module.infoTilt=infoTilt;module.validateAI=validateAI;module.parseRSS=parseRSS;module.parsePTT=parsePTT;module.parseAnnounce=parseAnnounce;module.fetchIntel=fetchIntel;module.dropIntraday=dropIntraday;module.fetchNews=fetchNews;module.dedupKey=dedupKey;module.doGet=doGet;module.doPost=doPost;module.heat=heat;module.parseFinMindNews=parseFinMindNews;module.dayMoves=dayMoves;module.mergeDays=mergeDays;module.intelPrompt=intelPrompt;module.revSurprise=revSurprise;module.fetchNewsEn=fetchNewsEn;module.normCite=normCite;module.yahooQuote=yahooQuote;module.numN=numN;module.peN=peN;module.fetchDeepChip=fetchDeepChip;module.fetchMarket=fetchMarket;module.fetchTaiwan=fetchTaiwan;module.fetchMargin=fetchMargin;module.fetchFundamental=fetchFundamental;')(G);

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
  { // v187 剛從上櫃轉上市：.TW 不滿 60 日、.TWO 停在轉板日——不可拿舊K線冒充最新
    const sh = (c, k) => { const r = JSON.parse(JSON.stringify(c)); r.chart.result[0].timestamp = r.chart.result[0].timestamp.map(t => t + k * DAY); return r; };
    const TW = sh(chart(30), 200), TWO = chart(100);
    fetchImpl = async u => ({ ok: true, json: async () => (u.includes('.TWO') ? TWO : TW) });
    let we = ''; try { await W.fetchTaiwan('6488'); } catch (e) { we = e.message; }
    gsFetch = u => /STOCK_DAY/.test(u) ? gsOf({ stat: 'X' }) : gsOf(u.includes('.TWO') ? TWO : TW);
    let ge = ''; try { G.fetchYahooTW('6488'); } catch (e) { ge = e.message; }
    ok('剛轉上市：不拿上櫃的舊K線冒充最新，明講只有幾日', /上市只有 30 個交易日/.test(we) && /上市只有 30 個交易日/.test(ge), `${we}｜${ge}`);
    fetchImpl = async u => ({ ok: true, json: async () => (u.includes('.TWO') ? { chart: { result: [] } } : chart(30)) });
    let we2 = ''; try { await W.fetchTaiwan('7777'); } catch (e) { we2 = e.message; }
    ok('新上市不滿 60 日：講出實際天數（原本只說「找不到」）', /只有 30 個交易日/.test(we2), we2);
    // 還原係數整段固定（之後才除息）≠ 區間內除息
    fetchImpl = async () => ({ ok: true, json: async () => chart(30) }); gsFetch = () => gsOf(chart(30));
    const wr = await W.fetchRangeOHLC('2330', '2026-09-01', '2026-09-30'), grr = G.fetchRangeOHLC('2330', '2026-09-01', '2026-09-30');
    const div = chart(30); div.chart.result[0].indicators.adjclose[0].adjclose = div.chart.result[0].indicators.quote[0].close.map((c, i) => c * (i < 15 ? 0.95 : 1));
    fetchImpl = async () => ({ ok: true, json: async () => div }); gsFetch = () => gsOf(div);
    const wd = await W.fetchRangeOHLC('2330', '2026-09-01', '2026-09-30'), gd = G.fetchRangeOHLC('2330', '2026-09-01', '2026-09-30');
    ok('日誌除權息標示：區間內係數有變才算（原本之後才除息也標示）', !wr.hasDividend && !grr.hasDividend && wd.hasDividend && gd.hasDividend, JSON.stringify([wr.hasDividend, grr.hasDividend, wd.hasDividend, gd.hasDividend])); }

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
  // v182 審查：證交所改欄名時，配不到的欄原本被當成 0（畫面「外資 0 張」並拿去計分），前端也從沒讀過除錯欄位
  { const BAD = { stat: 'OK', fields: ['證券代號', '證券名稱', 'Foreign Net', '投信買賣超股數', '自營商買賣超股數'], data: [['2330', '台積電', '9', '500,000', '100,000']] };
    fetchImpl = async u => jt(dOf(u) === newest ? BAD : T86);
    const wb = await W.fetchTaiwanChip('2330');
    gsFetch = u => gsOf(dOf(u) === gNewest ? BAD : T86);
    const gb = G.fetchTaiwanChip('2330');
    ok('籌碼：欄名配不到的那天算缺漏、回報實際欄名，不當成 0', [wb, gb].every(c => c.headMiss > 0 && /Foreign Net/.test(c.fieldMiss) && c.dataDate < newest), JSON.stringify([wb.headMiss, wb.fieldMiss, gb.headMiss, gb.fieldMiss]));
    fetchImpl = async u => jt(T86); gsFetch = u => gsOf(T86);
    ok('籌碼：欄名正常時 fieldMiss 為空', !(await W.fetchTaiwanChip('2330')).fieldMiss && !G.fetchTaiwanChip('2330').fieldMiss); }
  // v182 審查：GAS 隔夜漲跌用 chartPreviousClose（整段 5 日圖開始前的收盤），其實是 5 日變化；只有一根K棒時不可寫 0%
  { const q5 = { chart: { result: [{ meta: { regularMarketPrice: 110, chartPreviousClose: 90 }, timestamp: [1, 2, 3, 4, 5],
      indicators: { quote: [{ close: [95, 100, 104, 100, 110], high: [1, 1, 1, 1, 1], low: [1, 1, 1, 1, 1], open: [1, 1, 1, 1, 1], volume: [1, 1, 1, 1, 1] }], adjclose: [{ adjclose: [95, 100, 104, 100, 110] }] } }] } };
    const q1 = JSON.parse(JSON.stringify(q5)); const r1 = q1.chart.result[0]; r1.timestamp = [5]; r1.indicators.quote[0] = { close: [110], high: [1], low: [1], open: [1], volume: [1] }; r1.indicators.adjclose = [{ adjclose: [110] }];
    gsFetch = () => gsOf(q5); const g5 = G.yahooQuote('^SOX'); gsFetch = () => gsOf(q1); const g1 = G.yahooQuote('^SOX');
    fetchImpl = async () => ({ ok: true, json: async () => q5 }); const w5 = await W.yahooQuote('^SOX');
    fetchImpl = async () => ({ ok: true, json: async () => q1 }); const w1 = await W.yahooQuote('^SOX');
    ok('隔夜漲跌：用前一根K棒（+10%），不是整段5日圖開始前（+22%）；兩個後端一致', Math.abs(g5.changePct - 10) < 1e-9 && Math.abs(w5.changePct - 10) < 1e-9, `${g5.changePct}／${w5.changePct}`);
    ok('隔夜漲跌：只有一根K棒時不給（不寫 0%）', g1 === null && w1 === null, JSON.stringify([g1, w1])); }
  // v182 審查：空白、「-」、無法解析＝沒有值（null），不可變成「+0.0%」；本益比的「-」是證交所的虧損標記
  ok('數值解析：空白、--、文字＝null；「-」本益比＝虧損(0)；千分位照讀', [W, G].every(M => M.numN('') === null && M.numN('--') === null && M.numN('N/A') === null && M.numN('1,234.5') === 1234.5 && M.peN('-') === 0 && M.peN('') === null && M.peN('15.2') === 15.2));
  // ── v183 全面稽核：後端資料層 ──
  { // 籌碼：20日累計要真的湊得到 20 個交易日；當天有公布但沒有這檔（暫停交易／上櫃）＝沒資料，不是抓取失敗
    let calls = {};
    fetchImpl = async u => { const d = dOf(u); calls[d] = (calls[d] || 0) + 1; return jt(T86); };
    const c20 = await W.fetchTaiwanChip('2330');
    gsFetch = u => gsOf(T86); const g20 = G.fetchTaiwanChip('2330');
    ok('籌碼：20日累計湊得滿 20 個交易日（原本往回 25 天最多 18 天）', c20.n20 === 20 && g20.n20 === 20, `${c20.n20}／${g20.n20}`);
    const NOROW = { stat: 'OK', fields: T86.fields, data: [['1101', '台泥', '1', '1', '1']] };
    calls = {}; fetchImpl = async u => { const d = dOf(u); calls[d] = (calls[d] || 0) + 1; return jt(d === newest ? NOROW : T86); };
    const ch3 = await W.fetchTaiwanChip('2330');
    gsFetch = u => gsOf(dOf(u) === gNewest ? NOROW : T86); const gh3 = G.fetchTaiwanChip('2330');
    ok('籌碼：當天有公布但沒有這檔＝沒資料（與 GAS 一致），不重試、不誤報限流', ch3.headMiss === 0 && gh3.headMiss === 0 && calls[newest] === 1, `worker headMiss=${ch3.headMiss} 重試${calls[newest]}次／GAS ${gh3.headMiss}`);
    fetchImpl = async u => jt(T86); gsFetch = u => gsOf(T86); }
  { // 主力縱深：當沖比重、借券當日餘額、分點依券商加總、持股分級需付費方案
    const days = [1, 2, 3, 4, 5].map(k => `2026-09-${String(20 + k).padStart(2, '0')}`);
    const DS = { TaiwanStockDayTrading: days.map(d => ({ date: d, stock_id: '2330', BuyAfterSale: 'Y', Volume: 3000000, BuyAmount: 1, SellAmount: 1 })),
      TaiwanStockPrice: days.map(d => ({ date: d, stock_id: '2330', Trading_Volume: 10000000 })),
      TaiwanDailyShortSaleBalances: days.map((d, i) => ({ date: d, SBLShortSalesPreviousDayBalance: 999000, SBLShortSalesCurrentDayBalance: 1000000 + i * 100000 })),
      TaiwanStockTradingDailyReport: [{ securities_trader_id: 'A', price: 100, buy: 3000, sell: 0 }, { securities_trader_id: 'A', price: 101, buy: 3000, sell: 0 }, { securities_trader_id: 'B', price: 100, buy: 0, sell: 5000 }] };
    const dsOf = u => new URL(u).searchParams.get('dataset');
    const route = (over) => u => { const k = dsOf(u); if (over && k in over) return over[k]; return k in DS ? { json: { data: DS[k] } } : { json: { data: [] } }; };
    const run = async over => { const r = route(over); fetchImpl = async u => { const x = r(u); return x.status ? { ok: false, status: x.status, text: async () => '', json: async () => ({}) } : jt(x.json); };
      gsFetch = u => { const x = r(u); return x.status ? { getResponseCode: () => x.status, getContentText: () => '' } : gsOf(x.json); };
      return [await W.fetchDeepChip('2330', 'tok'), G.fetchDeepChip('2330', 'tok')]; };
    let [w, g] = await run();
    ok('當沖比重＝當沖量÷當日總成交量（原本「可否先賣後買」標記÷當沖量，永遠 0%）', w.dayTrading && w.dayTrading.cur === 30 && g.dayTrading && g.dayTrading.cur === 30 && w.dayTrading.days === 5, JSON.stringify([w.dayTrading, g.dayTrading]));
    ok('借券：取「當日餘額」，不是排在前面的「前一日餘額」', w.lend.bal === 1400 && g.lend.bal === 1400, `${w.lend.bal}／${g.lend.bal}`);
    ok('分點：先依券商加總（同一家不同價位的列合併）', w.brokers[0].mainNet === 1 && g.brokers[0].mainNet === 1, JSON.stringify([w.brokers[0], g.brokers[0]]));
    [w, g] = await run({ TaiwanStockPrice: { json: { data: days.map(d => ({ date: d, Trading_Volume: 9e12 })) } } });
    ok('當沖比重：單位對不上（比重小得不合理）就不給數字，並說明', !w.dayTrading && /單位對不上/.test(w.dayTradeErr) && !g.dayTrading && /單位對不上/.test(g.dayTradeErr), w.dayTradeErr);
    [w, g] = await run({ TaiwanStockHoldingSharesPer: { status: 402 }, TaiwanStockTradingDailyReport: { status: 402 } });
    ok('主力縱深：持股分級／分點要付費方案（402）時，借券等其餘照常，並說明原因', w.lend && g.lend && /402/.test(w.bigErr) && /402/.test(g.bigErr) && !w.big && !g.big, JSON.stringify([w.bigErr, g.bigErr]));
    ok('主力縱深：分點拿不到要講原因（原本整塊默默消失）', /402/.test(w.brokerErr) && /402/.test(g.brokerErr) && !w.brokers.length, JSON.stringify([w.brokerErr, g.brokerErr]));
    [w, g] = await run({ TaiwanStockPrice: { status: 429 } });
    ok('主力縱深：當沖分母（總成交量）抓失敗要講原因，不是空白', !w.dayTrading && /總成交量.*429/.test(w.dayTradeErr) && /總成交量.*429/.test(g.dayTradeErr), JSON.stringify([w.dayTradeErr, g.dayTradeErr]));
    [w, g] = await run({ TaiwanStockDayTrading: { json: { data: [] } } });
    ok('主力縱深：沒有當沖資料時明講（不是讓那塊消失）', /沒有此股的當沖資料/.test(w.dayTradeErr) && /沒有此股的當沖資料/.test(g.dayTradeErr), JSON.stringify([w.dayTradeErr, g.dayTradeErr]));
    let de = ['', '']; [w, g] = [null, null];
    try { await run({ TaiwanStockHoldingSharesPer: { status: 402 }, TaiwanDailyShortSaleBalances: { json: { data: [] } }, TaiwanStockTradingDailyReport: { json: { data: [] } } }); } catch (e) { de[0] = e.message; }
    try { G.fetchDeepChip('2330', 'tok'); } catch (e) { de[1] = e.message; }
    ok('主力縱深：全部拿不到時，錯誤訊息帶真正原因（402），不只「無此股資料」', /402/.test(de[0]) && /402/.test(de[1]), JSON.stringify(de));
    fetchImpl = async u => jt(T86); gsFetch = u => gsOf(T86); }
  { // 大盤：GAS 原本沒抓加權指數；一檔報價失敗其餘不可跟著消失，且要列在來源錯誤
    const qq = c => ({ chart: { result: [{ meta: {}, timestamp: [1, 2], indicators: { quote: [{ close: [100, c], high: [1, 1], low: [1, 1], open: [1, 1], volume: [1, 1] }], adjclose: [{ adjclose: [100, c] }] } }] } });
    gsFetch = u => /finance\/chart\/%5ESOX|chart\/\^SOX/.test(u) ? { getResponseCode: () => 429, getContentText: () => '<html>' } : /finance\/chart/.test(u) ? gsOf(qq(101)) : gsOf([]);
    const gm = G.fetchMarket();
    ok('大盤（GAS）：有加權指數；一檔報價失敗其餘照常，並列出沒拿到的', gm.tw && gm.tw.index && Math.abs(gm.tw.index.changePct - 1) < 1e-9 && !gm.us.sox && gm.us.nasdaq && (gm.sourceErrors || []).some(x => /費半/.test(x.why)), JSON.stringify(gm.sourceErrors));
    gsFetch = u => gsOf(T86); }
  { const wk = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8'), gs = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
    ok('PCR：欄名改版（取不到 pcrOI）時 Worker 也列入來源錯誤（與 GAS 一致）', /\(!pcr \|\| pcr\.pcrOI == null\) && !srcErr\.some/.test(wk));
    ok('掃描：台股判斷與個股查詢相同（首字是數字；00632R 這類 ETF 不再被當美股）', /const isTW = \/\^\\d\/\.test\(code\)/.test(wk) && /dd = \/\^\\d\/\.test\(cd\) \? fetchYahooTW/.test(gs) && /trimIntradayBar\(\{ \.\.\.item, currency: \/\^\\d\/\.test\(item\.code\)/.test(fs.readFileSync(path.join(ROOT, 'scan.js'), 'utf8'))); }
  { // v187 當天有公布但表裡沒有這檔（暫停交易／不得信用交易）＝沒資料，不是限流
    const MF = ['代號', '名稱', '融資今日餘額', '融券今日餘額'], MX = { stat: 'OK', fields: MF, data: [['1101', '台泥', '10', '1']] }, MH = { stat: 'OK', fields: MF, data: [['2330', '台積電', '1000', '50']] };
    const mDates = []; fetchImpl = async u => { mDates.push(dOf(u)); return jt(MH); }; await W.fetchMargin('2330');
    const mNew = mDates.sort().slice(-1)[0];   // 最新那天沒有這檔，其餘有
    fetchImpl = async u => jt(dOf(u) === mNew ? MX : MH); let wx = null, wxe = ''; try { wx = await W.fetchMargin('2330'); } catch (e) { wxe = e.message; }
    ok('融資：表裡沒有這檔不算抓取失敗（不再誤報限流、與 GAS 一致）', !!wx && wx.headMiss === 0, wxe || JSON.stringify(wx && { headMiss: wx.headMiss }));
    fetchImpl = async u => jt(T86); }
  { // 基期為 0：融資變化、券資比都沒有定義，不可寫 0%
    const MM = { stat: 'OK', fields: ['代號', '名稱', '融資今日餘額', '融券今日餘額'], data: [['2330', '台積電', '0', '0']] };
    fetchImpl = async () => jt(MM); gsFetch = () => gsOf(MM);
    let wm = null, gm2 = null; try { wm = await W.fetchMargin('2330'); } catch (e) {} try { gm2 = G.fetchMargin('2330'); } catch (e) {}
    ok('融資：基期為 0 時變化率與券資比是 null（不是 0%）；GAS 也回報 headMiss', wm && wm.marginChg5 === null && wm.shortRatio === null && gm2 && gm2.marginChg5 === null && gm2.shortRatio === null && typeof gm2.headMiss === 'number', JSON.stringify([wm, gm2]).slice(0, 200));
    fetchImpl = async u => jt(T86); gsFetch = u => gsOf(T86); }
  { // v197 證交所新版 groups 格式：GAS 與 worker 讀到同一個數字
    const MG3 = { stat: 'OK', tables: [{ groups: [{ title: '股票', span: 2 }, { title: '融資', span: 6 }, { title: '融券', span: 6 }], fields: ['代號', '名稱', '買進', '賣出', '現金償還', '前日餘額', '今日餘額', '次一營業日限額', '買進', '賣出', '現券償還', '前日餘額', '今日餘額', '次一營業日限額'],
      data: [['2330', '台積電', '0', '0', '0', '0', '2,000', '9', '0', '0', '0', '0', '300', '9']] }] };
    fetchImpl = async () => jt(MG3); gsFetch = () => gsOf(MG3);
    let wm = null, gm = null; try { wm = await W.fetchMargin('2330'); } catch (e) {} try { gm = G.fetchMargin('2330'); } catch (e) {}
    ok('融資：證交所 groups 格式 worker／GAS 都讀到融資 2000、融券 300', wm && gm && wm.marginBal === 2000 && gm.marginBal === 2000 && wm.shortBal === 300 && gm.shortBal === 300, JSON.stringify([wm && wm.marginBal, gm && gm.marginBal]));
    fetchImpl = async u => jt(T86); gsFetch = u => gsOf(T86); }
  { // 估值欄名全部對不上：原本 throw 在 try 裡被自己吞掉，診斷訊息到不了前端
    const BW = { stat: 'OK', fields: ['代號', 'X', 'Y'], data: [['2330', '1', '2']] };
    fetchImpl = async () => jt(BW);
    let fe = ''; try { await W.fetchFundamental('2330'); } catch (e) { fe = e.message; }
    ok('估值：欄名對不上時把實際欄名講出來（不是只說「無基本面資料」）', /BWIBBU_d 欄位全部對不上/.test(fe), fe);
    gsFetch = () => gsOf(BW); let ge = ''; try { G.fetchFundamental('2330'); } catch (e) { ge = e.message; }
    ok('估值（GAS）：欄名對不上同樣講出來（與 Worker 對等）', /BWIBBU_d 欄位全部對不上/.test(ge), ge);
    // 找得到營收列、但年增是「-」（上市未滿一年）且不在估值表：Worker 回部分資料，GAS 原本丟「無基本面資料」
    const BW0 = { stat: 'OK', fields: ['證券代號', '殖利率(%)', '本益比', '股價淨值比'], data: [['1101', '1', '2', '3']] };
    const RV = [{ '公司代號': '2330', '營業收入-上月比較增減(%)': '5.5', '營業收入-去年同月增減(%)': '-', '資料年月': '11508' }];
    fetchImpl = async u => jt(/openapi/.test(u) ? RV : BW0); gsFetch = u => gsOf(/openapi/.test(u) ? RV : BW0);
    let wf = null, gf = null, fe2 = ''; try { wf = await W.fetchFundamental('2330'); } catch (e) { fe2 = 'W:' + e.message; } try { gf = G.fetchFundamental('2330'); } catch (e) { fe2 += ' G:' + e.message; }
    ok('基本面：有營收列但年增為空時兩邊都回部分資料（不丟例外、不寫 0）', wf && gf && wf.revMoM === 5.5 && gf.revMoM === 5.5 && wf.revYoY === null && gf.revYoY === null, fe2 || JSON.stringify([wf, gf]));
    fetchImpl = async u => jt(T86); gsFetch = u => gsOf(T86); }
  ok('GAS 情報快取：只存完整成功的結果（AI 失敗或來源失敗不存）；有無 token 分開存', /if \(result\.ai\.status === 'ok' && !result\.srcErrors\.length\) try \{[^\n]*cache\.put/.test(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8'))
    && /ck = 'intel_' \+ ic \+ \(itk \? '_t' : ''\)/.test(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8')));
  ok('Code.gs 不再用 getDay()（專案時區；星期要用台北時區算）', !/\.getDay\(\)/.test(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
  { // GAS 備援（Yahoo 失敗改用證交所月資料）：原本沒有 lastDate 與原始價序列
    const SD = { stat: 'OK', title: '115年09月 2330 台積電 各日成交資訊', data: Array.from({ length: 20 }, (_, i) => [`115/09/${String(i + 1).padStart(2, '0')}`, '1,000', '1', '100', '101', '99', String(100 + i), '0', '1']) };
    gsFetch = u => /STOCK_DAY/.test(u) ? gsOf(SD) : /finance\/chart/.test(u) ? { getResponseCode: () => 500, getContentText: () => 'x' } : gsOf(T86);
    let tw = null, twe = ''; try { tw = G.fetchTaiwan('2330'); } catch (e) { twe = e.message; }
    ok('GAS 備援：證交所月資料也回傳 lastDate（民國轉西元）與原始價序列', tw && tw.lastDate === '20260920' && Array.isArray(tw.rawCloses) && tw.rawCloses.length === tw.closes.length, twe || JSON.stringify(tw && { lastDate: tw.lastDate, raw: (tw.rawCloses || []).length }));
    gsFetch = u => gsOf(T86); }
  { // 掃描池：上市、上櫃日期不同要講
    const L = [{ Date: '1150925', SecuritiesCompanyCode: '2330', TransactionAmount: '9' }], O = [{ Date: '1150924', Code: '8069', TradeValue: '8' }];
    const pr = u => /tpex/.test(u) ? O : L;
    fetchImpl = async u => jt(pr(u)); gsFetch = u => gsOf(pr(u));
    let wp = null, gp = null; try { wp = await W.fetchTopPool(10); } catch (e) { wp = { err: e.message }; } try { gp = G.fetchTopPool(10); } catch (e) { gp = { err: e.message }; }
    ok('掃描池：上市與上櫃資料日期不同時明講（排行混了兩天）', [wp, gp].every(p => (p.srcErrors || []).some(x => /日期不一致/.test(x))), JSON.stringify([wp, gp]).slice(0, 220));
    fetchImpl = async u => jt(T86); gsFetch = u => gsOf(T86); }

  // v182 審查：GAS 借券註解說有依日期排序但沒排；基期為 0 時不可寫成 0%
  { const sblRows = [5, 4, 3, 2, 1, 0].map(k => ({ date: `2026-09-${String(20 + k).padStart(2, '0')}`, SBLShortSalesCurrentDayBalance: 1000000 + k * 100000 }));   // 日期降冪
    const dc = base => u => { const ds = new URL(u).searchParams.get('dataset'); return ds === 'TaiwanDailyShortSaleBalances' ? { data: base } : { data: [] }; };
    fetchImpl = async u => jt(dc(sblRows)(u)); gsFetch = u => gsOf(dc(sblRows)(u));
    const wl = (await W.fetchDeepChip('2330', 'tok')).lend, gl = G.fetchDeepChip('2330', 'tok').lend;
    ok('借券：依日期排序後才取最新與5日前（兩個後端一致）', wl.bal === 1500 && gl.bal === 1500 && wl.chg5 === 50 && gl.chg5 === 50 && gl.chg5N === 5, JSON.stringify([wl, gl]));
    const zero = sblRows.map((r, i) => i === 5 ? { ...r, SBLShortSalesCurrentDayBalance: 0 } : r);
    fetchImpl = async u => jt(dc(zero)(u)); gsFetch = u => gsOf(dc(zero)(u));
    ok('借券：基期為 0 算不出變化率→null，不寫 0%', (await W.fetchDeepChip('2330', 'tok')).lend.chg5 === null && G.fetchDeepChip('2330', 'tok').lend.chg5 === null); }

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
    // v197 證交所新版：欄名只剩重複的「今日餘額」，融資／融券寫在 tables[].groups
    const MG2 = { stat: 'OK', tables: [{ title: '信用交易統計', fields: ['項目', '買進'], data: [['融資(交易單位)', '1']] }, { title: '融資融券彙總', groups: [{ title: '股票', span: 2 }, { title: '融資', span: 6 }, { title: '融券', span: 6 }, { title: '', span: 1 }, { title: '', span: 1 }],   // 2026-10-08 真實回傳的結構
      fields: ['代號', '名稱', '買進', '賣出', '現金償還', '前日餘額', '今日餘額', '次一營業日限額', '買進', '賣出', '現券償還', '前日餘額', '今日餘額', '次一營業日限額', '資券互抵', '註記'],
      data: [['2330', '台積電', '1,699', '361', '30', '30,278', '31,586', '6,483,092', '13', '8', '0', '50', '45', '6,483,092', '4', ' ']] }] };
    fetchImpl = async () => jt(MG2);
    const mg2 = await mod.fetchMargin('2330');
    ok('融資融券：證交所現行格式（groups 只有 span）讀得到 2330 真實值（融資 31,586、融券 45），不靠位置猜', mg2 && mg2.marginBal === 31586 && mg2.shortBal === 45, JSON.stringify(mg2));
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

  // ⑦c 未驗證的外資台指期／PCR 只在大盤卡顯示，不進任何分數或門檻（v188 起計分的地方都已移除）
  { const front = ['bingfa.js', 'enhance.js', 'mainforce.js', 'advanced.js', 'smc.js', 'mtf.js', 'app.js', 'journal.js', 'scan.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    ok('外資台指期／PCR 只在大盤卡顯示，不進分數', !/pcrOI|foreignNet/.test(front)); }

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
    ok('T86 外資＝2,690張（實際欄名對得上；v183 起與 GAS 一樣取整數張）', cr.foreign1 === 2690, String(cr.foreign1));
    ok('T86 投信＝735張', cr.trust1 === 735, String(cr.trust1));
    // 欄位順序若調換，仍不可抓到「外資自營商買賣超股數」（那欄幾乎天天為0）
    const swapped = REAL_F.slice(), rowS = ROW.slice();
    [swapped[4], swapped[7]] = [swapped[7], swapped[4]];
    [rowS[4], rowS[7]] = [rowS[7], rowS[4]];
    fetchImpl = async () => jt({ stat: 'OK', fields: swapped, data: [rowS] });
    const cs = await W2.fetchTaiwanChip('2330');
    ok('T86 欄位順序調換後外資仍正確（不會抓到外資自營商）', cs.foreign1 === 2690, String(cs.foreign1));
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

    /* v178 逐日拆解：重現使用者的情境——今天週一（10/5 開盤前），上週三個股自己大漲、週五跟著大盤大跌。
       週二另有一天個股自己跌，但當天沒有任何消息（AI 若拿別天的消息來解釋，必須被擋下）。 */
    {
      const dts = dates.slice(0, 195), m = [100], s = [50];   // dates[191..194] = 9/29二 9/30三 10/1四 10/2五
      for (let i = 1; i < 195; i++) { const rm = i === 194 ? -0.03 : 0.01 * Math.sin(i * 1.7); let rs = 0.0002 + 1.3 * rm + 0.001 * Math.sin(i * 3.1 + 1);
        if (i === 192) rs += 0.05; if (i === 191) rs -= 0.04; m.push(m[i - 1] * (1 + rm)); s.push(s[i - 1] * (1 + rs)); }
      const ser = { dates: dts, closes: s }, mkt = { dates: dts, closes: m }, now = T('20261005', '08:30');
      const its = [['20260929', '14:00'], ['20260930', '10:00'], ['20261001', '11:00'], ['20261003', '10:00'], ['20261002', '13:45'], ['20260927', '10:00']]
        .map(([d, hm], i) => ({ t: T(d, hm), kind: 'news', src: 'x', title: '條目' + i }));
      const dm = W2.dayMoves(ser, mkt, its, now), day = d => dm && dm.days.find(x => x.d === d) || {};
      ok('逐日拆解：分析的是7日窗內完整的交易日（上週二～五）', !!dm && dm.days.map(x => x.d).join() === '20260929,20260930,20261001,20261002', dm && dm.days.map(x => x.d).join());
      ok('逐日拆解：β 估對（真值1.3，估計窗不含分析期間）', dm && Math.abs(dm.beta - 1.3) < 0.05, dm && dm.beta.toFixed(3));
      ok('逐日拆解：週三個股自己漲 +5% → 顯著', Math.abs(day('20260930').ar - 0.05) < 0.005 && day('20260930').z >= 1.96, JSON.stringify(day('20260930')));
      ok('逐日拆解：週五大跌是大盤帶動 → 個股自身不顯著', day('20261002').ret < -0.035 && Math.abs(day('20261002').mkt - day('20261002').ret) < 0.003 && Math.abs(day('20261002').z) < 1.96, JSON.stringify(day('20261002')));
      ok('逐日拆解：消息歸日（週二盤後→週三、週三盤中→週三）', day('20260930').ids.join() === '0,1' && day('20261001').ids.join() === '2' && day('20260929').ids.length === 0, JSON.stringify(dm && dm.days.map(x => x.ids)));
      ok('逐日拆解：週五收盤後與週末的消息→待開盤（影響今天週一）', dm && dm.pending.join() === '3,4', dm && dm.pending.join());
      const aiDays = [{ d: '20260930', why: '法說上修[0]，另見[2]', ids: [0, 2] }, { d: '20260929', why: '被法說拖累[0]', ids: [0] }, { d: '20261002', why: '利空[4]', ids: [4] }];
      const mg = W2.mergeDays(JSON.parse(JSON.stringify(dm)), aiDays), mday = d => mg.days.find(x => x.d === d);
      ok('逐日歸因：只收當日條目（別天的引用剔除）', mday('20260930').whyIds.join() === '0' && mday('20260930').why === '法說上修[0]，另見', JSON.stringify(mday('20260930')));
      ok('逐日歸因：當天沒有消息卻拿別天的來解釋→不採用', mday('20260929').why === '' && mday('20260929').z <= -1.96, JSON.stringify(mday('20260929')));
      ok('逐日歸因：不顯著的日子不收 AI 的原因（跟大盤走，不看圖說故事）', mday('20261002').why === '', mday('20261002').why);
      const pr = W2.intelPrompt('2330', '台積電', its, dm);
      ok('逐日歸因：prompt 帶入程式算好的拆解與待開盤條目', /20260930｜個股 [+-]\d+\.\d%｜大盤 [^\n]*個股自身 \+[45]\.\d%（顯著）/.test(pr) && /收盤後（影響下一個交易日）的條目：\[3\]\[4\]/.test(pr), pr.slice(pr.indexOf('6. 逐日'), pr.indexOf('6. 逐日') + 120));
      IT.dm = { ser, mkt, its, now, aiDays };
      // v180 使用者實測：AI 把多個引用寫在同一個括號「[1, 22]」→ 不會變連結、也逃過無效引用檢查
      const vl = W2.validateAI({ summary: '擴產[1, 2]；赴美投資[3，99]、[4、0]', outlook: '若續強則留意[1, 7]', events: [] }, its);
      ok('引用格式：「[1, 2]」拆成「[1][2]」，無效的編號照樣剔除', vl.summary === '擴產[1][2]；赴美投資[3]、[4][0]' && vl.outlook === '若續強則留意[1]', `${vl.summary}｜${vl.outlook}`);
      const ml = W2.mergeDays(JSON.parse(JSON.stringify(dm)), [{ d: '20260930', why: '法說上修[0, 2]', ids: [0, 2] }]);
      ok('引用格式：逐日原因裡的「[0, 2]」也要拆開，別天的引用照樣剔除', ml.days.find(x => x.d === '20260930').why === '法說上修[0]', ml.days.find(x => x.d === '20260930').why);
      IT.citeIn = { summary: '擴產[1, 2]；赴美投資[3，99]、[4、0]', outlook: '若續強則留意[1, 7]', events: [] };
    }

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
    const rs = W2.parseRSS(IT.rss).items;
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
    const pt = W2.parsePTT(IT.ptt, '2330').items;
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

    // ── 熱度與趨勢（v175）：依「影響哪個交易日」歸戶，真實日曆：9/25 中秋、9/26-27 週末 ──
    const TPE = (d, hm) => Date.parse(`2026-09-${d}T${hm}:00+08:00`);
    const HNOW = TPE('28', '10:00');   // 週一盤中：K 線已丟掉今天未收的那根
    const HD = ['20260917', '20260918', '20260921', '20260922', '20260923', '20260924'];
    const hItems = [['21', '09:00'], ['21', '14:00'], ['22', '10:00'], ['22', '13:29'], ['22', '13:30'], ['23', '12:00'], ['23', '20:00'],
      ...Array(6).fill(['24', '09:00']), ['25', '10:00'], ['26', '12:00'], ['28', '09:30']].map(([d, hm]) => ({ t: TPE(d, hm) }));
    const ht = W2.heat(hItems, HNOW, 20, hItems, HD, true);
    IT.heat = { hItems, HNOW, HD };
    ok('熱度：13:29 算當天、13:30（收盤）起算下一交易日', ht.series.find(x => x.d === '20260922').n === 3 && ht.series.find(x => x.d === '20260923').n === 2, JSON.stringify(ht.series));
    ok('熱度：中秋、週末、今天盤中的消息都歸「下一交易日累積中」，不當成冷清的日子', ht.pending === 3, String(ht.pending));
    ok('熱度：最前面那個交易日的消息期間早於蒐集窗→不完整，不列入', ht.series[0].d === '20260922', ht.series[0].d);
    ok('熱度：每交易日計數與趨勢', JSON.stringify(ht.series.map(x => x.n)) === '[3,2,7]' && ht.med === 2.5 && ht.ratio === 1.5 && ht.trend === '升溫', JSON.stringify(ht));
    const hc = W2.heat(hItems, HNOW, 5, hItems.slice(5), HD, false);   // 來源被截斷：最舊一筆 9/23 12:00
    ok('熱度：來源截斷時，早於最舊一筆的交易日不列入；不足3日→不給趨勢', hc.saturated === true, JSON.stringify(hc));
    ok('熱度：逐日完整的來源（FinMind）不受筆數上限影響', W2.heat(hItems, HNOW, 5, hItems.slice(5), HD, true).trend === '升溫');
    ok('熱度：沒有交易日清單時只給總數', JSON.stringify(W2.heat(hItems, HNOW, 20, hItems, null, true)) === JSON.stringify({ n: 15 }));   // 9/21 09:00 在窗外

    // ── FinMind 新聞：使用者實測回應的三個特性 ──
    const fmRows = [
      { date: '2026-09-24 06:24:25', stock_id: '2330', link: 'https://tw.stock.yahoo.com/news/a', source: 'Yahoo股市', title: '4萬8大關驚險守住！台股終場下跌132點 台積電收2475元 - Yahoo股市' },
      { date: '2026-09-24 06:24:25', stock_id: '2330', link: 'https://tw.stock.yahoo.com/news/a', source: 'tw.stock.yahoo.com', title: '4萬8大關驚險守住！台股終場下跌132點 台積電收2475元 - tw.stock.yahoo.com' },
      { date: '2026-09-24 03:46:48', stock_id: '2330', link: 'https://www.cmoney.tw/forum/article/1', source: 'CMoney', title: '2330 台積電 - 半導體管線題材燒不停！- 股市爆料同學會 - CMoney' },
    ];
    const fp = W2.parseFinMindNews(fmRows);
    ok('FinMind：時間是 UTC（「終場下跌」06:24 ＝ 台北 14:24 收盤後）', fp[0].t === Date.parse('2026-09-24T06:24:25Z') && new Date(fp[0].t + 8 * H).getUTCHours() === 14, new Date(fp[0].t).toISOString());
    ok('FinMind：同一連結兩種來源寫法只算一則', fp.length === 2, String(fp.length));
    ok('FinMind：去掉標題尾巴「 - 來源」', fp[0].title === '4萬8大關驚險守住！台股終場下跌132點 台積電收2475元', fp[0].title);
    ok('FinMind：CMoney 論壇標為社群並清標題', fp[1].kind === 'social' && fp[1].title === '半導體管線題材燒不停！', JSON.stringify(fp[1]));
    const hu = W2.heat(fp.filter(x => x.kind === 'news'), TPE('28', '10:00'), 20, fp, HD, true);
    ok('FinMind：盤後新聞歸到下一交易日（若誤當台北時間會算進 9/24）', hu.pending === 1 && !hu.series.some(x => x.n), JSON.stringify(hu));

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
    /* v179 英文外電、月營收、PTT 推文淨值 */
    IT.rssEn = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>x</title>
<item><title>TSMC lifts 2026 revenue outlook on AI demand - Reuters</title><link>https://news.google.com/rss/articles/E1</link><pubDate>${pub(NOW - 7 * H)}</pubDate><source url="https://www.reuters.com">Reuters</source></item>
<item><title>Taiwan exports hit record as chip demand surges - Bloomberg</title><link>https://news.google.com/rss/articles/E2</link><pubDate>${pub(NOW - 9 * H)}</pubDate><source url="https://www.bloomberg.com">Bloomberg</source></item>
<item><title>TSMCX is not the same company - Foo</title><link>https://news.google.com/rss/articles/E3</link><pubDate>${pub(NOW - 9 * H)}</pubDate><source url="https://foo.com">Foo</source></item>
</channel></rss>`;
    // 40 個月（2023/05～2026/08）：前12個月當基期，之後年增率 18%/22% 交替（平均20%），最後一個月突然年增 60%
    IT.revRows = seen => { const out = [], v = [];
      for (let i = 0; i < 40; i++) { const y = 2023 + Math.floor((4 + i) / 12), m = (4 + i) % 12 + 1;
        v.push(i < 12 ? 100e9 * (1 + 0.01 * i) : v[i - 12] * (1 + (i === 39 ? 0.6 : i % 2 ? 0.22 : 0.18)));
        out.push({ date: `${m === 12 ? y + 1 : y}-${String(m % 12 + 1).padStart(2, '0')}-01`, stock_id: '2330', country: 'Taiwan', revenue: Math.round(v[i]), revenue_month: m, revenue_year: y, create_time: i === 39 ? seen : '' }); }
      return out; };
    IT.revSeen = new Date(NOW - 2 * 864e5 + 8 * H).toISOString().slice(0, 10);   // 兩天前（台北日期）入庫
    {
      const rr = IT.revRows('2026-09-09'), rs = W2.revSurprise(rr), v = rr.map(x => x.revenue);
      ok('月營收：本月年增率、月增率正確', rs && Math.abs(rs.yoy - 0.6) < 1e-6 && Math.abs(rs.mom - (v[39] / v[38] - 1)) < 1e-9 && rs.ym === 202608, JSON.stringify(rs));
      { // v191 盈餘品質：兩個後端同一算法；現金流年初累計→單季；只用法定期限已過的財報
        const W3 = new Function(fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8').match(/const QUAL_PAT[\s\S]*?\n\}\n/)[0] + ';return quality;')();
        const G3 = new Function(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8').match(/var QUAL_PAT[\s\S]*?\n\}\n/)[0] + ';return quality;')();
        const qe = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'], ni = [10, 12, 9, 11, 13, 14], ocfQ = [5, 20, 7, 15, 9, 30];
        const IS = qe.map((d, i) => ({ date: d, type: 'IncomeAfterTaxes', value: ni[i] })), BS = qe.map(d => ({ date: d, type: 'TotalAssets', value: 1000 }));
        const CF = qe.map((d, i) => ({ date: d, type: 'CashFlowsFromOperatingActivities', value: ocfQ.slice(d.slice(0, 4) === '2025' ? 0 : 4, i + 1).reduce((a, b) => a + b, 0) }));   // 年初累計
        const at = s => Date.parse(s + 'T12:00:00+08:00'), a1 = W3(IS, BS, CF, at('2026-08-20')), a2 = W3(IS, BS, CF, at('2026-08-10'));
        ok('盈餘品質：近四季（現金流−淨利）÷總資產，現金流由年初累計換成單季', a1 && a1.q === '2026Q2' && Math.abs(a1.acc - ((7 + 15 + 9 + 30) - (9 + 11 + 13 + 14)) / 1000) < 1e-12, JSON.stringify(a1));
        ok('盈餘品質：Q2 財報 8/14 法定期限前不用（與回測同）、Q4 要 90 天', a2 && a2.q === '2026Q1' && W3(IS, BS, CF, at('2026-04-02')).q === '2025Q4' && W3(IS, BS, CF, at('2026-03-30')) === null, JSON.stringify(a2));
        ok('盈餘品質：缺一季就不算（不硬湊）；GAS 與 Worker 結果相同', W3(IS.filter((_, i) => i !== 4), BS, CF, at('2026-08-20')) === null && JSON.stringify(G3(IS, BS, CF, at('2026-08-20'))) === JSON.stringify(a1)); }
      ok('月營收：近3月營收年增＝最近 3 個有年增率月份的平均（中期因子用）', rs && Math.abs(rs.rev3 - (0.6 + 0.22 + 0.18) / 3) < 1e-9, rs && String(rs.rev3));
      ok('月營收：驚奇度＝偏離之前 12 個月常態、母體標準差（v189 與回測同定義；平均20%、標準差2%、年增60%→20）', rs && rs.n === 12 && Math.abs(rs.mean - 0.2) < 1e-9 && Math.abs(rs.sur - 20) < 1e-6, rs && `${rs.n} ${rs.mean} ${rs.sur}`);
      { const GS = new Function(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8') + '\nreturn revSurprise;')();
        const g2 = GS(rr), g3 = GS(rr.slice(-20));
        ok('月營收：GAS 與 Worker 驚奇度算法完全相同', g2 && Math.abs(g2.sur - rs.sur) < 1e-9 && g2.n === rs.n && g3.sur === null && g3.n === 7, g2 && `${g2.n} ${g2.sur}`); }
      const ytd = [31, 32, 33, 34, 35, 36, 37, 38, 39].slice(-8).reduce((a, i) => a + v[i], 0) / [19, 20, 21, 22, 23, 24, 25, 26, 27].slice(-8).reduce((a, i) => a + v[i], 0) - 1;
      ok('月營收：今年累計年增、連續年增月數', rs && Math.abs(rs.ytd - ytd) < 1e-9 && rs.streak === 28, rs && `${rs.ytd} vs ${ytd}｜${rs.streak}`);
      ok('月營收：公布日取 FinMind 入庫日', rs && rs.seen === '2026-09-09');
      const stable = IT.revRows(''); stable[39].revenue = Math.round(stable[27].revenue * 1.22);
      const st = W2.revSurprise(stable);
      ok('月營收：年增率高但一向這麼高→驚奇度在常態內', st && st.yoy > 0.2 && Math.abs(st.sur) < 2 && st.seen === '', st && `${st.yoy} ${st.sur}`);
      ok('月營收：歷史不足 12 個月→不算驚奇度（不用太少的樣本亂算）', W2.revSurprise(rr.slice(-20)).sur === null && W2.revSurprise(rr.slice(-20)).n === 7);
      { const gap = IT.revRows(''); gap.splice(27, 1);   // 最新月份的去年同月缺資料 → 改用前一個有年增率的月份（不讓整檔失效）
        const a = W2.revSurprise(gap), b = new Function(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8') + '\nreturn revSurprise;')()(gap);
        ok('月營收：最新月份沒有去年同月時，用最新一個有年增率的月份（兩個後端相同）', a && a.ym === 202607 && b && b.ym === 202607 && Math.abs(a.sur - b.sur) < 1e-12, JSON.stringify([a && a.ym, b && b.ym])); }
      ok('月營收：沒有去年同月→回 null（不硬算）', W2.revSurprise(rr.slice(-6)) === null && W2.revSurprise([]) === null);
      const ep2 = h => Math.floor((NOW - h * H) / 1000);
      IT.pttPush = `<div class="r-list-container"><div class="r-ent"><div class="nrec"><span class="hl f1">爆</span></div><div class="title"><a href="/bbs/Stock/M.${ep2(1)}.A.111.html">[標的] 2330 台積電 多</a></div></div>
<div class="r-ent"><div class="nrec"><span class="hl f2">X3</span></div><div class="title"><a href="/bbs/Stock/M.${ep2(2)}.A.222.html">[標的] 2330 台積電 空</a></div></div>
<div class="r-ent"><div class="nrec"></div><div class="title"><a href="/bbs/Stock/M.${ep2(3)}.A.333.html">[新聞] 台積電擴產</a></div></div>
<div class="r-ent"><div class="nrec"><span class="hl f3">12</span></div><div class="title"><a href="/bbs/Stock/M.${ep2(4)}.A.444.html">[心得] 2330 抱牢</a></div></div></div>`;
      const pp = W2.parsePTT(IT.pttPush, '2330', '台積電').items;
      ok('PTT：推文淨值（爆＝100、X3＝噓多30以上、空白＝0、數字照讀）', pp.map(x => x.push).join() === '100,-30,0,12', pp.map(x => x.push).join());
      ok('PTT：推文淨值帶給 AI（標明是反應熱度）', pp[0].detail === '推文淨值 +100（爆）' && pp[2].detail === '', pp[0].detail);
    }
    IT.route = (u, gem) => {
      if (/TaiwanStockMonthRevenue/.test(u)) return { json: { msg: 'success', status: 200, data: IT.revRows(IT.revSeen) } };
      if (/TaiwanStock(FinancialStatements|BalanceSheet|CashFlowsStatement)/.test(u)) return { json: { msg: 'success', status: 200, data: [] } };   // v191 財報（盈餘品質）
      if (/news\.google\.com[^#]*hl=en-US/.test(u)) return { txt: IT.rssEn };
      if (/news\.google\.com/.test(u)) return { txt: IT.rss };
      if (/ptt\.cc/.test(u)) return { txt: IT.ptt };
      if (/t187ap04_L/.test(u)) return { json: IT.ann };
      if (/t187ap03_L/.test(u)) return { json: [
        { 出表日期: '1150926', 公司代號: '2330', 公司名稱: '台灣積體電路製造股份有限公司', 英文簡稱: 'TSMC', 公司簡稱: '台積電', 外國企業註冊地國: '－' },   // 英文簡稱故意排在前面：抓「簡稱」不可抓到英文的
        { 出表日期: '1150926', 公司代號: '2317', 公司名稱: '鴻海精密工業股份有限公司', 英文簡稱: 'HON HAI', 公司簡稱: '鴻海', 外國企業註冊地國: '－' }] };
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
    ok('情報管線：各來源都進條目且依時間新到舊（v179 起多了國際新聞與月營收各 1）', full.items.length === 11 && full.items.every((x, i, a) => !i || a[i - 1].t >= x.t), `${full.items.length}`);
    ok('情報管線：AI 捏造事件被剔除', full.events.length === 2 && full.ai.dropped === 1, `${full.events.length}/${full.ai.dropped}`);
    ok('情報管線：事件附上事件研究結果', full.events.some(e => e.study && (e.study.status === 'ok' || e.study.status === 'pending')), JSON.stringify(full.events.map(e => e.study && e.study.status)));
    ok('情報管線：傾向計算排除走勢報導', full.tilt && full.tilt.n === 1 && full.tilt.tilt === 1, JSON.stringify(full.tilt));
    ok('情報管線：AI 以 temperature 0＋JSON schema 呼叫', !!gemBody && JSON.parse(gemBody.body).generationConfig.temperature === 0 && !!JSON.parse(gemBody.body).generationConfig.responseSchema);
    ok('情報管線：金鑰放 header 不放網址（不會進 log）', !!gemBody && gemBody.headers['x-goog-api-key'] === 'k-test');
    ok('AI：思考上限 1024 token（預設動態思考最多 24,576 個，是整條管線最慢的一段）', !!gemBody && (JSON.parse(gemBody.body).generationConfig.thinkingConfig || {}).thinkingBudget === 1024);
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
    ok('AI 出錯時明講原因，其他來源照常', aiErr.ai.status === 'error' && /429/.test(aiErr.ai.why) && aiErr.items.length === 11, aiErr.ai.why);

    // 單一來源失敗：列進 srcErrors
    fetchImpl = async u => /ptt\.cc/.test(u) ? asResp({ txt: '<html>blocked</html>' }) : asResp(IT.route(u, IT.gem));
    const pf = await W2.fetchIntel('2330', {});
    ok('來源失敗列入 srcErrors（不可當成沒人討論）', pf.srcErrors.some(x => /PTT/.test(x)) && pf.attention.ptt === null, JSON.stringify(pf.srcErrors));

    // KV 快照
    const kv = {}; fetchImpl = async u => asResp(IT.route(u, IT.gem));
    const ks = await W2.fetchIntel('2330', { SYNC: { put: async (k, v) => { kv[k] = v; }, getWithMetadata: async () => null } });
    ok('有綁 KV 時每日存快照（供日後回測）', ks.snapshot === 'saved' && Object.keys(kv).some(k => /^intel:2330:\d{8}$/.test(k)), Object.keys(kv).join());
    // v184 快照瘦身＋摘要放 metadata
    { let put = null; await W2.saveIntelSnap({ SYNC: { put: async (k, v, o) => { put = { v, o }; } } }, '2330', Date.now(), IT.full);
      const sv = put && JSON.parse(put.v), meta = put && put.o && put.o.metadata, full = JSON.stringify(IT.full).length;
      ok('快照瘦身：不存新聞網址、逐日拆解、耗時，保留判讀與 AI 提示詞版本', !!sv && !/"url"/.test(put.v) && sv.moves === undefined && sv.timing === undefined
        && sv.items.length === IT.full.items.length && sv.events.length === IT.full.events.length && sv.ai.prompt === IT.full.ai.prompt && sv.tilt.tilt === IT.full.tilt.tilt && Array.isArray(sv.srcErrors),
        put ? `${put.v.length}/${full}` : '沒寫入');
      console.log(`    （快照大小：測試資料 ${full} → ${put ? put.v.length : '?'} 字元）`);
      const mk = old => { const st = { n: 0 }; return { st, env: { SYNC: { put: async () => { st.n++; }, getWithMetadata: async () => old } } }; };
      const noAi = { ...IT.full, ai: { status: 'error', why: 'quota' }, tilt: null };
      const k1 = mk({ value: '{}', metadata: { ai: 'ok' } }), k2 = mk({ value: '{}', metadata: { ai: 'error' } }), k3 = mk(null);
      const r1 = await W2.saveIntelSnap(k1.env, '2330', Date.now(), noAi), r2 = await W2.saveIntelSnap(k2.env, '2330', Date.now(), noAi), r3 = await W2.saveIntelSnap(k3.env, '2330', Date.now(), noAi);
      ok('快照：當天已有 AI 成功的，重查 AI 失敗不覆蓋；原本就失敗或沒有則照存', r1 === 'kept' && k1.st.n === 0 && r2 === 'saved' && k2.st.n === 1 && r3 === 'saved' && k3.st.n === 1, [r1, r2, r3].join());
      ok('快照摘要放 KV metadata（列表一次拿全部；上限 1024 bytes）', !!meta && meta.ai === 'ok' && meta.tilt === 1 && meta.prompt === IT.full.ai.prompt && meta.asOf > 0
        && Buffer.byteLength(JSON.stringify(meta)) < 1024, JSON.stringify(meta)); }
    { const ser = { dates: ['20260901', '20260902', '20260903', '20260904', '20260907', '20260908', '20260909', '20260910', '20260911', '20260914', '20260915'], closes: [100, 101, 102, 103, 104, 105, 106, 107, 110, 111, 112] };
      const mkt = { dates: ser.dates, closes: ser.closes.map(() => 50).map((x, i) => i === 7 ? 51 : x) };
      const at = (d, hm) => Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${hm}:00+08:00`);
      const a = W2.snapFwd(ser, mkt, at('20260902', '10:00')), b = W2.snapFwd(ser, mkt, at('20260902', '14:00')), c = W2.snapFwd(ser, mkt, at('20260906', '12:00'));
      ok('之後5日報酬：13:30 前查＝當天收盤進場、之後查＝下一個交易日、假日查＝下一個交易日', a.entry === '20260902' && b.entry === '20260903' && c.entry === '20260907', JSON.stringify([a, b, c]));
      ok('之後5日報酬：超額＝個股 − 0050 同期', Math.abs(a.r5 - (106 / 101 - 1)) < 1e-12 && Math.abs(a.ex5 - a.r5) < 1e-12 && Math.abs(b.ex5 - ((107 / 102 - 1) - (51 / 50 - 1))) < 1e-12, JSON.stringify(b));
      ok('之後5日報酬：還沒滿 5 日／早於價格資料 分開標，不給數字', W2.snapFwd(ser, mkt, at('20260910', '10:00')).why === 'pending' && W2.snapFwd(ser, mkt, at('20250101', '10:00')).why === 'old'); }
    { const keys = [{ name: 'intel:2330:20260901', metadata: { asOf: 1, ai: 'ok', tilt: 0.5 } }, { name: 'intel:2330:20260902' }, { name: 'intel:2330:20260904' }, { name: 'intel:2317:20260903', metadata: { asOf: 2, ai: 'error', tilt: null } }];
      const vals = { 'intel:2330:20260902': IT.full, 'intel:2330:20260904': 'garbage' }, wrote = [];
      const seen = []; const env = { SYNC: { get: async k => vals[k], put: async (k, v, o) => { wrote.push([k, o && o.metadata]); }, list: async o => { seen.push(o); return o.cursor ? { keys: keys.slice(3), list_complete: true } : { keys: keys.slice(0, 3), list_complete: false, cursor: 'c1' }; } } };
      const L = await W2.listIntelSnaps(env, '');
      ok('快照清單：分頁讀完；v183 沒摘要的舊快照讀內容補算；讀不出的明講筆數', L.rows.length === 3 && L.noMeta === 1 && L.rows[1].d === '20260902' && L.rows[1].ai === 'ok' && L.rows[1].tilt === 1
        && L.rows[2].code === '2317' && seen.length === 2 && seen[1].cursor === 'c1', JSON.stringify(L));
      ok('快照清單：舊快照補算的摘要寫回去（只讀一次）', wrote.length === 1 && wrote[0][0] === 'intel:2330:20260902' && wrote[0][1].ai === 'ok', JSON.stringify(wrote));
      const L2 = await W2.listIntelSnaps({ SYNC: { get: async () => { throw new Error('KV 503'); }, list: async () => ({ keys: [{ name: 'intel:2330:20260902' }], list_complete: true }) } }, '');
      ok('快照清單：讀取失敗另外計數，不混成「內容無法判讀」', L2.readErr === 1 && L2.noMeta === 0, JSON.stringify(L2));
      let kvErr = ''; try { await W2.listIntelSnaps({}, ''); } catch (e) { kvErr = e.message; }
      ok('快照清單：沒綁 KV 丟出原因（不回空清單假裝沒資料）', /沒有綁定 KV/.test(kvErr), kvErr); }
    ok('GAS：intelsnaps 明講快照只在 Worker（端點對等，不回空清單）', /action === 'intelsnaps'\) return[^\n]*ok: false[^\n]*Worker/.test(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8')));

    // ── v175 FinMind 管線：8 個 UTC 日、熱度只用 FinMind、token、部分失敗 ──
    IT.fmRows = fmRows;
    IT.fmResp = u => { const d = new URL(u).searchParams.get('start_date');
      return { msg: 'success', status: 200, data: [0, 1].map(k => ({ date: `${d} 0${2 + k}:00:00`, stock_id: '2330', link: `https://fm/${d}/${k}`, source: '經濟日報', title: `台積電先進製程消息${d}-${k} - 經濟日報` })) }; };
    const fmSeen = []; let fmAuth = null;
    fetchImpl = async (u, o) => { if (/TaiwanStockNews/.test(u)) { fmSeen.push(new URL(u).searchParams.get('start_date')); fmAuth = o && o.headers && o.headers.Authorization; return asResp({ json: IT.fmResp(u) }); } return asResp(IT.route(u, IT.gem)); };
    const fmI = await W2.fetchIntel('2330', {}, 'tok-1');
    const nowD = new Date().toISOString().slice(0, 10);
    ok('FinMind：抓 8 個 UTC 日（涵蓋台北 7×24 小時）', fmSeen.length === 8 && new Set(fmSeen).size === 8 && fmSeen.includes(nowD), fmSeen.join(','));
    ok('FinMind：有 token 時放 Authorization header', fmAuth === 'Bearer tok-1', String(fmAuth));
    ok('新聞：FinMind 與 Google 合併、標示來源', fmI.newsVia === 'FinMind＋Google新聞' && fmI.items.some(x => /先進製程消息/.test(x.title)) && fmI.items.some(x => /法說上修/.test(x.title)), fmI.newsVia);
    const fmNewsN = [].concat(...[...new Set(fmSeen)].map(d => IT.fmResp('https://x/?start_date=' + d).data)).filter(r => { const a = Date.now() - Date.parse(r.date.replace(' ', 'T') + 'Z'); return a >= 0 && a < 7 * 864e5; }).length;   // 今天 UTC 日晚於現在的不算
    ok('熱度：只用 FinMind 計數（不混 Google，避免近期假升溫）', fmI.attention.news.n === fmNewsN, `heat.n=${fmI.attention.news.n} FinMind=${fmNewsN}`);
    fetchImpl = async (u, o) => { if (/finmindtrade/.test(u)) { fmAuth = o && o.headers && o.headers.Authorization; return asResp({ json: IT.fmResp(u) }); } return asResp(IT.route(u, IT.gem)); };
    await W2.fetchIntel('2330', {}, '');
    ok('FinMind：沒有 token 也能呼叫（不送空的 Authorization）', fmAuth === undefined, String(fmAuth));
    let fmN = 0;
    fetchImpl = async u => /finmindtrade/.test(u) ? (/TaiwanStockNews/.test(u) && ++fmN === 3 ? asResp({ status: 402, txt: 'quota' }) : asResp({ json: IT.fmResp(u) })) : asResp(IT.route(u, IT.gem));
    const fmPart = await W2.fetchIntel('2330', {}, '');
    ok('FinMind：任一天失敗→整批不用（缺一天計數就不準），改用 Google 並講明', fmPart.newsVia === 'Google新聞' && fmPart.notes.some(n => /FinMind HTTP 402/.test(n) && /額度/.test(n) && /改用 Google/.test(n)), JSON.stringify(fmPart.notes));
    let relayU = '';
    fetchImpl = async u => /relay\.test/.test(u) ? (relayU = u, asResp({ txt: 'x' })) : asResp(IT.route(u, IT.gem));
    await W2.fetchIntelRouted('2330', { GAS_RELAY: 'https://relay.test/exec' }, 'tok-2');
    ok('整筆轉接：FinMind token 一併轉給 GAS', /&token=tok-2/.test(relayU), relayU);
    fetchImpl = async u => asResp(IT.route(u, IT.gem));

    /* v170 依使用者兩個後端同時實測的回應校正（2026-09-28）：
       Google 新聞只擋 Cloudflare、STOCK_DAY_ALL 沒有中文名稱、櫃買中心擋雲端主機、
       Yahoo rss?s= 不是個股參數、「股市爆料同學會」是網友發文不是新聞 */
    ok('名稱：取自上市公司基本資料的「公司簡稱」而非全名', full.name === '台積電', full.name);
    const intlI = full.items.filter(x => x.kind === 'intl');
    ok('國際新聞：用英文簡稱查，只收標題含公司英文名的（TSMCX、無關的台灣出口新聞不收）', intlI.length === 1 && /TSMC lifts/.test(intlI[0].title) && full.attention.intl === 1, JSON.stringify(intlI.map(x => x.title)));
    ok('國際新聞：不計入新聞熱度', !!full.attention.news && full.attention.news.n === full.items.filter(x => x.kind === 'news').length, JSON.stringify(full.attention.news || null).slice(0, 80));
    const revI = full.items.filter(x => x.kind === 'rev');
    ok('月營收：7日內公布→當成官方條目交給 AI，時間視為入庫日收盤後', revI.length === 1 && /8月營收年增 \+60\.0%/.test(revI[0].title) && revI[0].t === Date.parse(IT.revSeen + 'T14:00:00+08:00'), JSON.stringify(revI));
    ok('月營收：輸出驚奇度與公布後的市場反應（事件研究）', full.revenue && full.revenue.sur > 2 && full.revenue.study && /ok|pending/.test(full.revenue.study.status), JSON.stringify(full.revenue && full.revenue.study));
    ok('新聞：Google 直連成功時回報來源', full.newsVia === 'Google新聞', full.newsVia);

    // 社群發文分類（實測 60 則裡約 35 則是 CMoney 網友發文）
    const socialRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>"2330 台積電 when:7d" - Google 新聞</title>
<item><title>2330 台積電 - 外資同步落跑！主動ETF也大賣- 股市爆料同學會</title><link>https://n/1</link><pubDate>${pub(NOW - 2 * H)}</pubDate><source url="https://cmoney.tw">CMoney</source></item>
<item><title>2330 台積電 - 👍👍👍 - 股市爆料同學會</title><link>https://n/2</link><pubDate>${pub(NOW - 4 * H)}</pubDate><source url="https://cmoney.tw">CMoney</source></item>
<item><title>台股收盤／跌132點 台積電收2,475元跌1% - 經濟日報</title><link>https://n/3</link><pubDate>${pub(NOW - 6 * H)}</pubDate><source url="https://udn.com">經濟日報</source></item>
</channel></rss>`;
    fetchImpl = async u => /news\.google\.com/.test(u) ? asResp({ txt: socialRss }) : asResp(IT.route(u, IT.gem));
    const so = await W2.fetchIntel('2330', {});
    const raw = (await W2.fetchNews('2330', '台積電')).items.filter(x => x.kind === 'social');
    ok('社群：「股市爆料同學會」標為網友社群而非新聞', raw.length === 2 && raw.every(x => x.src === 'CMoney社群'), JSON.stringify(raw.map(x => x.src)));
    ok('社群：去掉「2330 台積電 - 」前綴與尾巴', raw.some(x => x.title === '外資同步落跑！主動ETF也大賣'), raw.map(x => x.title).join('|'));
    ok('社群：不計入新聞注意力，另外計數', so.attention.news.n === 1 && so.attention.social === 2, JSON.stringify(so.attention));
    ok('社群：標題沒提到本公司的不進條目（前綴是論壇標籤不算）', !so.items.some(x => x.kind === 'social'), JSON.stringify(so.items.map(x => x.title)));

    // v172 重現使用者實測：87 則社群發文洗版、真新聞只剩 9 則
    let gq = '';
    const flood = `<?xml version="1.0"?><rss version="2.0"><channel><title>"2330 台積電" - Google 新聞</title>
${Array.from({ length: 40 }, (_, i) => `<item><title>2330 台積電 - 【美股快訊】特斯拉第${i}季交車 - 股市爆料同學會</title><link>https://n/s${i}</link><pubDate>${pub(NOW - (i + 1) * 0.5 * H)}</pubDate><source url="https://cmoney.tw">CMoney</source></item>`).join('\n')}
${Array.from({ length: 8 }, (_, i) => `<item><title>2330 台積電 - 台積電傳明年漲價第${i}波 - 股市爆料同學會</title><link>https://n/r${i}</link><pubDate>${pub(NOW - (i + 1) * 0.6 * H)}</pubDate><source url="https://cmoney.tw">CMoney</source></item>`).join('\n')}
${Array.from({ length: 3 }, (_, i) => `<item><title>台積電法說重點第${i}則 - 經濟日報</title><link>https://n/n${i}</link><pubDate>${pub(NOW - (i + 30) * H)}</pubDate><source url="https://udn.com">經濟日報</source></item>`).join('\n')}
</channel></rss>`;
    fetchImpl = async u => { if (/news\.google\.com/.test(u) && /hl=zh-TW/.test(u)) { gq = decodeURIComponent(u); return asResp({ txt: flood }); } return asResp(IT.route(u, IT.gem)); };
    const fl = await W2.fetchIntel('2330', {});
    const byKind = k => fl.items.filter(x => x.kind === k);
    ok('社群洗版：查詢排除 CMoney（把名額留給真新聞）', /-site:cmoney\.tw/.test(gq), gq);
    ok('社群洗版：真新聞較舊也不會被擠掉', byKind('news').length === 3, String(byKind('news').length));
    ok('社群洗版：社群最多5則且都提到本公司', byKind('social').length === 5 && byKind('social').every(x => /台積電/.test(x.title)), byKind('social').map(x => x.title).join('|'));
    ok('社群洗版：公告與PTT照常保留', byKind('mops').length === 2 && byKind('ptt').length === 4, `mops=${byKind('mops').length} ptt=${byKind('ptt').length}`);
    IT.flood = flood;
    IT.socialRss = socialRss;

    /* v173 ① 雲端備份：沒綁 KV 時原本回 ok:true 卻什麼都沒存（使用者實測 snapshot=no-kv 才發現）。
       直接呼叫 Worker 真正的請求處理函式，不是只測內部函式。 */
    const WH = {};
    new Function('module', fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8').replace('export default', 'module.handler =') )(WH);
    const call = async (u, env, init) => JSON.parse(await (await WH.handler.fetch(new Request('https://w.test/?' + u, init), env)).text());
    const bk = { app: 'StockRadarPro', user: 'u1', trades: [{ id: 1 }] };
    const s0 = await call('action=sync_save', {}, { method: 'POST', body: JSON.stringify(bk) });
    ok('雲端備份：沒綁 KV 時儲存必須回失敗（不可假裝成功）', s0.ok === false && /沒有綁定 KV/.test(s0.error), JSON.stringify(s0));
    const g0 = await call('action=sync_get&user=u1', {});
    ok('雲端備份：沒綁 KV 時讀取必須回失敗（不可偽裝成空備份）', g0.ok === false && /沒有綁定 KV/.test(g0.error), JSON.stringify(g0));
    const store = {}, kvE = { SYNC: { put: async (k, v) => { store[k] = v; }, get: async k => store[k] || null } };
    const s1 = await call('action=sync_save', kvE, { method: 'POST', body: JSON.stringify(bk) });
    const g1 = await call('action=sync_get&user=u1', kvE);
    ok('雲端備份：有綁 KV 時存得進、讀得回', s1.ok === true && g1.ok === true && g1.data.trades[0].id === 1, JSON.stringify(g1));

    /* ③ 去重：使用者實測同一則新聞三種寫法 */
    const dup = ['嘉科3期計劃啟動 點名台積電增設5座封裝廠 | ETtoday新聞雲', '嘉科3期計劃啟動　點名台積電增設5座封裝廠', '嘉科3期計劃啟動 點名台積電增設5座封裝廠'];
    ok('去重：轉載尾巴、全形空白視為同一則', new Set(dup.map(W2.dedupKey)).size === 1, dup.map(W2.dedupKey).join(' / '));
    ok('去重：UDN「| 股市要聞| 股市」尾巴與半形空白', W2.dedupKey('台積電盤後鉅額交易飆2,749元再創新天價| 股市要聞| 股市') === W2.dedupKey('台積電盤後鉅額交易飆2,749元 再創新天價'));
    ok('去重：不同新聞不會被誤合併', W2.dedupKey('台積電A16量產倒數') !== W2.dedupKey('台積電A14量產倒數'));
    IT.dup = dup;

    // v171 整筆交給 GAS：Cloudflare 連 Google 新聞被擋、連 Gemini 被地區限制（使用者實測）
    const gasIntel = { ok: true, code: '2330', name: '台積電', asOf: NOW, engine: 'GAS', items: [{ kind: 'news', title: '台積電法說上修', src: '經濟日報', url: 'https://n/9', t: NOW - 3 * H }],
      events: [], tilt: null, newsVia: 'Google新聞', attention: {}, ai: { status: 'ok', summary: 'x' }, notes: [], srcErrors: [], snapshot: 'no-kv' };
    let relayUrl = '';
    const kv2 = {};
    // 包起來：改壞時變成一項紅燈，而不是讓整個檢查程式中斷
    const routed = async env => { try { return await W2.fetchIntelRouted('2330', env); } catch (e) { return { engine: '（丟出例外）', srcErrors: [String(e.message || e)], items: [] }; } };
    fetchImpl = async u => /relay\.test/.test(u) ? (relayUrl = u, asResp({ json: gasIntel })) : asResp(IT.route(u, IT.gem));
    const rl = await routed({ GAS_RELAY: 'https://relay.test/exec', SYNC: { put: async (k, v) => { kv2[k] = JSON.parse(v); } } });
    ok('整筆轉接：設定 GAS_RELAY 時由 GAS 處理', rl.engine === 'GAS' && /action=intel&code=2330/.test(relayUrl) && rl.items[0].title === '台積電法說上修', relayUrl);
    ok('整筆轉接：Worker 仍負責存 KV 快照（GAS 做不到）', rl.snapshot === 'saved' && Object.values(kv2).some(v => v.engine === 'GAS'), rl.snapshot);
    fetchImpl = async u => /relay\.test/.test(u) ? asResp({ txt: '<html>Google 登入</html>' }) : asResp(IT.route(u, IT.gem));
    const rb = await routed({ GAS_RELAY: 'https://relay.test/exec' });
    ok('整筆轉接：GAS 失敗→退回 Cloudflare 自己抓，並把原因放第一條', rb.engine === 'Cloudflare' && /GAS 處理失敗/.test(rb.srcErrors[0]) && /不是JSON/.test(rb.srcErrors[0]) && rb.items.length > 0, rb.srcErrors[0]);
    fetchImpl = async u => /relay\.test/.test(u) ? asResp({ json: { ok: true, price: 1 } }) : asResp(IT.route(u, IT.gem));
    const ro = await routed({ GAS_RELAY: 'https://relay.test/exec' });
    ok('整筆轉接：GAS 版本過舊（沒有情報欄位）→ 講明並退回', /版本過舊/.test(ro.srcErrors[0]), ro.srcErrors[0]);
    // v177 時間預算：GAS 逾時後若再自己抓一輪，總時間超過前端上限，使用者只看到「沒回應」看不到原因
    let localN = 0;
    fetchImpl = async u => { if (/relay\.test/.test(u)) { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; } localN++; return asResp(IT.route(u, IT.gem)); };
    const rt = await routed({ GAS_RELAY: 'https://relay.test/exec' });
    ok('整筆轉接：GAS 逾時就明講，不再自己抓一輪', rt.engine === '（丟出例外）' && /80 秒/.test(rt.srcErrors[0]) && /保留結果 10 分鐘/.test(rt.srcErrors[0]) && localN === 0, `${rt.srcErrors[0]}｜本地又抓了 ${localN} 次`);
    { const n0 = Date.now; let clock = n0(); Date.now = () => clock; localN = 0;   // v181：40 秒後才回 5xx，剩下的時間不夠再抓一輪
      fetchImpl = async u => { if (/relay\.test/.test(u)) { clock += 40000; return asResp({ status: 502, txt: 'bad gateway' }); } localN++; return asResp(IT.route(u, IT.gem)); };
      const rl2 = await routed({ GAS_RELAY: 'https://relay.test/exec' }); Date.now = n0;
      ok('整筆轉接：GAS 很晚才失敗→明講原因，不再自己抓一輪（會超過前端上限）', rl2.engine === '（丟出例外）' && /40 秒後失敗/.test(rl2.srcErrors[0]) && localN === 0, `${rl2.srcErrors[0]}｜${localN}`); }
    const relayMs = +(fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8').match(/GAS_RELAY\}\?action=intel[^\n]*\{\}, (\d+)\)/) || [])[1];
    const pageMs = +(fs.readFileSync(path.join(ROOT, 'intel.js'), 'utf8').match(/let INTEL_WAIT = (\d+)/) || [])[1];
    ok('時間預算：Worker 等 GAS 的上限比前端上限短至少 5 秒', relayMs > 0 && pageMs - relayMs >= 5000, `Worker ${relayMs} ms／前端 ${pageMs} ms`);
    fetchImpl = async u => asResp(IT.route(u, IT.gem));
    ok('整筆轉接：沒設 GAS_RELAY 時由 Cloudflare 處理', (await routed({})).engine === 'Cloudflare');
    fetchImpl = async u => /news\.google\.com/.test(u) ? asResp({ status: 503, txt: 'x' }) : asResp(IT.route(u, IT.gem));
    const envDiag = await routed({ GEMINI_KEY: 'secret-value', GAS_RELAY_: 'https://typo', SYNC: { put: async () => {} } });
    ok('沒讀到 GAS_RELAY 且被擋時，列出 Worker 實際讀到的變數名稱', envDiag.notes.some(n => /未讀到 GAS_RELAY/.test(n) && /「GAS_RELAY_」/.test(n) && /「GEMINI_KEY」/.test(n)), JSON.stringify(envDiag.notes));
    ok('變數診斷只列名稱，絕不洩漏值', !JSON.stringify(envDiag).includes('secret-value'));
    fetchImpl = async u => asResp(IT.route(u, IT.gem));
    ok('沒被擋時不顯示這個提示（避免雜訊）', !(await routed({})).notes.some(n => /GAS_RELAY/.test(n)));
    ok('intel 路由走 fetchIntelRouted', /action === 'intel'[\s\S]{0,200}fetchIntelRouted\(code, env, p\.get\('token'\)/.test(fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8')));
    // Gemini 地區限制（使用者實測訊息原文）
    fetchImpl = async u => asResp(IT.route(u, { status: 400, txt: '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}' }));
    const loc = await W2.fetchIntel('2330', { GEMINI_KEY: 'k' });
    ok('AI 地區限制：講出原因與解法（設定 GAS_RELAY）', loc.ai.status === 'error' && /香港/.test(loc.ai.why) && /GAS_RELAY/.test(loc.ai.why), loc.ai.why);
    fetchImpl = async u => /news\.google\.com/.test(u) ? asResp({ status: 503, txt: 'x' }) : asResp(IT.route(u, IT.gem));
    const nn = await W2.fetchIntel('2330', {});
    ok('新聞：Google 擋掉時講出原因，不是靜默沒新聞', nn.srcErrors.some(x => /Google新聞 HTTP 503/.test(x)), JSON.stringify(nn.srcErrors));
    const generic = `<?xml version="1.0"?><rss version="2.0"><channel><title>財經要聞</title>
<item><title>美股收盤道瓊上漲</title><link>https://x/1</link><pubDate>${pub(NOW - H)}</pubDate></item></channel></rss>`;
    fetchImpl = async u => asResp(/news\.google\.com/.test(u) ? { txt: generic } : IT.route(u, IT.gem));
    const gy = await W2.fetchIntel('2330', {});
    ok('新聞：來源回整體新聞（非該股）→ 拒收', gy.srcErrors.some(x => /不是這檔股票的新聞/.test(x)) && !gy.items.some(x => /道瓊/.test(x.title)), JSON.stringify(gy.srcErrors));

    // PTT：用名稱搜（[新聞]/[心得] 常只寫公司名）
    let pttUrl = '';
    fetchImpl = async u => { if (/ptt\.cc/.test(u)) pttUrl = u; return asResp(IT.route(u, IT.gem)); };
    const pn = await W2.fetchIntel('2330', {});
    ok('PTT：有中文名稱時用名稱搜尋', /search\?q=%E5%8F%B0%E7%A9%8D%E9%9B%BB/.test(pttUrl), pttUrl);
    ok('PTT：標題只寫公司名也算（不只看代碼）', W2.parsePTT(`<div class="r-ent"><a href="/bbs/Stock/M.${ep(1)}.A.1A2.html">[新聞] 台積電先進封裝擴產</a></div>`, '2330', '台積電').items.length === 1);
    ok('PTT：多空計數仍正確', pn.attention.ptt.bull === 1 && pn.attention.ptt.bear === 1);
    const oldPtt = `<div class="r-list-container"><div class="r-ent"><a href="/bbs/Stock/M.${ep(24 * 12)}.A.AAA.html">[標的] 2330 台積電 多</a></div></div>`;
    fetchImpl = async u => /ptt\.cc/.test(u) ? asResp({ txt: oldPtt }) : asResp(IT.route(u, IT.gem));
    const po = await W2.fetchIntel('2330', {});
    const oldYmd = new Date(NOW - 12 * 864e5 + 8 * H).toISOString().slice(5, 10).replace('-', '/');
    ok('PTT：近7日沒有時，講出最近一篇在哪天（使用者實測情境）', po.notes.some(n => n.includes(`最近一篇相關文章在 ${oldYmd}`)), JSON.stringify(po.notes));

    // PTT 0 篇診斷（保留）
    const emptyPtt = '<html><head><title>看板 Stock 文章列表 - 批踢踢實業坊</title></head><body><div class="r-list-container"></div></body></html>';
    fetchImpl = async u => /ptt\.cc/.test(u) ? asResp({ txt: emptyPtt }) : asResp(IT.route(u, IT.gem));
    const ep0 = await W2.fetchIntel('2330', {});
    ok('PTT 0 篇時說明頁面標題與連結數（被擋 vs 沒人討論）', ep0.notes.some(n => /看板 Stock 文章列表/.test(n) && /共 0 篇/.test(n) && /被擋/.test(n)), JSON.stringify(ep0.notes));
    const otherPtt = `<div class="r-list-container"><div class="r-ent"><a href="/bbs/Stock/M.${ep(2)}.A.AAA.html">[新聞] 聯發科法說</a></div></div>`;
    fetchImpl = async u => /ptt\.cc/.test(u) ? asResp({ txt: otherPtt }) : asResp(IT.route(u, IT.gem));
    const ep1 = await W2.fetchIntel('2330', {});
    ok('PTT 有文章但都不相關→講清楚看到幾篇', ep1.notes.some(n => /共 1 篇/.test(n) && !/被擋/.test(n)), JSON.stringify(ep1.notes));
    ok('PTT 連結大小寫與額外屬性都容得下', W2.parsePTT(`<div class="r-ent"><a href="/bbs/stock/M.${ep(1)}.A.1a2.html" class="x">[標的] 2330 台積電 多</a></div>`, '2330').items.length === 1);

    // 名稱：失敗原因要講出來；欄名用關鍵字找；上櫃代碼要說明原因（用全新實例，名稱有快取）
    const fresh = () => { const w = {}; new Function('module', src + '\nmodule.fetchIntel=fetchIntel;')(w); return w; };
    fetchImpl = async u => /t187ap03_L/.test(u) ? asResp({ status: 403, txt: 'forbidden' }) : asResp(IT.route(u, IT.gem));
    const nm0 = await fresh().fetchIntel('2330', {});
    IT.nameFail = nm0;
    ok('名稱：查詢失敗時講出原因', nm0.name === '' && nm0.notes.some(n => /上市公司基本資料 HTTP 403/.test(n)), JSON.stringify(nm0.notes));
    fetchImpl = async u => /t187ap03_L/.test(u) ? asResp({ json: [{ code: '2330', shortName: 'TSMC' }] }) : asResp(IT.route(u, IT.gem));
    const nm1 = await fresh().fetchIntel('2330', {});
    ok('名稱：欄名對不上時列出實際欄名', nm1.notes.some(n => /欄名不符/.test(n) && /shortName/.test(n)), JSON.stringify(nm1.notes));
    fetchImpl = async u => asResp(IT.route(u, IT.gem));
    const nm2 = await fresh().fetchIntel('6488', {});
    ok('名稱：上櫃代碼查不到時說明是來源被擋', nm2.notes.some(n => /上市清單無此代碼/.test(n) && /櫃買中心/.test(n)), JSON.stringify(nm2.notes));
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
    const Q = IT.dm, wdm = W2.dayMoves(Q.ser, Q.mkt, Q.its, Q.now);
    cmp('引用格式（清單拆開）', W2.validateAI(IT.citeIn, IT.dm.its), G.validateAI(IT.citeIn, IT.dm.its));
    cmp('PTT 推文淨值', W2.parsePTT(IT.pttPush, '2330', '台積電'), G.parsePTT(IT.pttPush, '2330', '台積電'));
    cmp('月營收驚奇度', W2.revSurprise(IT.revRows('2026-09-09')), G.revSurprise(IT.revRows('2026-09-09')));
    cmp('月營收（歷史不足）', W2.revSurprise(IT.revRows('').slice(-20)), G.revSurprise(IT.revRows('').slice(-20)));
    cmp('逐日拆解', wdm, G.dayMoves(Q.ser, Q.mkt, Q.its, Q.now));
    cmp('逐日歸因合併', W2.mergeDays(JSON.parse(JSON.stringify(wdm)), Q.aiDays), G.mergeDays(JSON.parse(JSON.stringify(wdm)), Q.aiDays));
    cmp('AI prompt（含逐日拆解）', W2.intelPrompt('2330', '台積電', Q.its, wdm), G.intelPrompt('2330', '台積電', Q.its, wdm));

    // 整條管線：兩邊都走同一組假來源
    const now0 = Date.now();
    const gsResp = x => ({ getResponseCode: () => x.status || 200, getContentText: () => x.txt != null ? x.txt : JSON.stringify(x.json) });
    const asResp = x => ({ ok: !x.status || x.status < 400, status: x.status || 200, text: async () => x.txt != null ? x.txt : JSON.stringify(x.json), json: async () => x.json != null ? x.json : JSON.parse(x.txt) });
    fetchImpl = async u => asResp(IT.route(u, IT.gem));
    gsFetch = u => gsResp(IT.route(u, IT.gem));
    gsProps = { GEMINI_KEY: 'k-test' };
    const w = await W2.fetchIntel('2330', { GEMINI_KEY: 'k-test' }), gg = G.fetchIntel('2330');
    const strip = o => { const c = JSON.parse(JSON.stringify(o)); delete c.asOf; delete c.snapshot; delete c.engine; delete c.timing; return c; };   // engine 本來就不同；timing 是實際耗時
    cmp('整條情報管線（含AI）', strip(w), strip(gg));
    { let gp = null; const g0 = gsFetch; gsFetch = (u, o) => { if (/generativelanguage/.test(u)) gp = o && o.payload; return g0(u, o); }; gsProps = { GEMINI_KEY: 'k-test' }; G.fetchIntel('2330'); gsFetch = g0;
      const gc = JSON.parse(gp).generationConfig;
      ok('AI（GAS）：思考上限 1024 token，與 worker 一致', gc.thinkingConfig && gc.thinkingConfig.thinkingBudget === 1024, JSON.stringify(gc.thinkingConfig)); }
    ok('逐段計時：兩個後端都回報抓資料與 AI 的實際毫秒數', [w, gg].every(o => o.timing && o.timing.fetch >= 0 && o.timing.ai >= 0), JSON.stringify([w.timing, gg.timing]));
    // v181 GAS 平行預抓：已知網址一次發出（不再一個接一個相加）；fetchAll 整批失敗時退回逐一抓，結果不變
    { const U0 = global.UrlFetchApp, batches = [], singles = [];
      global.UrlFetchApp = { fetch: (u, o) => { singles.push(u); return U0.fetch(u, o); }, fetchAll: rq => { batches.push(rq.map(r => r.url)); return U0.fetchAll(rq); } };
      gsProps = { GEMINI_KEY: 'k-test' };
      const gp = G.fetchIntel('2330'), big = batches.find(b => b.length >= 6) || [];
      ok('GAS：新聞、PTT、公告、日K、月營收、國際新聞一次平行發出', ['news.google.com/rss/search?q=2330', 'ptt.cc', 't187ap04_L', '2330.TW', '0050.TW', 'TaiwanStockMonthRevenue', 'hl=en-US'].every(k => big.some(u => u.indexOf(k) >= 0))
        && !singles.some(u => /ptt\.cc|t187ap04_L|finance\/chart|MonthRevenue/.test(u)), `批次 ${big.length} 個；逐一 ${singles.filter(u => !/generativelanguage|t187ap03_L/.test(u)).join(',').slice(0, 120)}`);
      global.UrlFetchApp = { fetch: U0.fetch, fetchAll: rq => { if (rq.some(r => /ptt\.cc/.test(r.url))) throw new Error('Timeout'); return U0.fetchAll(rq); } };
      cmp('GAS：預抓整批失敗→逐一抓，結果與預抓相同', strip(G.fetchIntel('2330')), strip(gp));
      global.UrlFetchApp = U0; gsProps = {}; }
    // v181 入庫當天 14:00 前查詢：FinMind 已經有＝早就公布，時間不可排到未來（原本會被當成未來消息丟掉）
    { const n0 = Date.now, fake = Date.parse(new Date(n0() + 8 * 3600e3).toISOString().slice(0, 10) + 'T10:00:00+08:00'), seen0 = IT.revSeen;
      IT.revSeen = new Date(fake + 8 * 3600e3).toISOString().slice(0, 10); Date.now = () => fake;
      fetchImpl = async u => asResp(IT.route(u, IT.gem)); gsFetch = u => gsResp(IT.route(u, IT.gem));
      const wr = await W2.fetchIntel('2330', {}), gr = G.fetchIntel('2330');
      Date.now = n0; IT.revSeen = seen0;
      const ri = o => o.items.find(x => x.kind === 'rev');
      ok('月營收：入庫當天盤中查詢仍列入條目，時間取「現在」', ri(wr) && ri(wr).t === fake && ri(gr) && ri(gr).t === fake, JSON.stringify([ri(wr), ri(gr)]).slice(0, 120)); }
    // v181 ETF／新上市沒有月營收：不是抓取失敗，不列入來源錯誤
    { const noRev = u => /TaiwanStockMonthRevenue/.test(u) ? { json: { msg: 'success', status: 200, data: [] } } : IT.route(u, IT.gem);
      fetchImpl = async u => asResp(noRev(u)); gsFetch = u => gsResp(noRev(u));
      const we = await W2.fetchIntel('2330', {}), ge = G.fetchIntel('2330');
      ok('月營收：ETF／新上市沒有資料→註明，不列為來源失敗', [we, ge].every(o => o.revenue === null && !o.srcErrors.some(x => /月營收/.test(x)) && o.notes.some(x => /沒有可比的月營收/.test(x))), JSON.stringify([we.srcErrors, we.notes]).slice(0, 160));
      fetchImpl = async u => asResp(IT.route(u, IT.gem)); gsFetch = u => gsResp(IT.route(u, IT.gem)); }
    ok('引用格式：括號內有空白也拆（[ 1, 2 ]、[ 3 ]）', W2.normCite('a[ 1, 2 ]b[ 3 ]') === 'a[1][2]b[3]' && G.normCite('a[ 1, 2 ]b[ 3 ]') === 'a[1][2]b[3]', W2.normCite('a[ 1, 2 ]b[ 3 ]'));
    gsProps = {};
    const w2 = await W2.fetchIntel('2330', {}), g2 = G.fetchIntel('2330');
    cmp('整條情報管線（無金鑰）', strip(w2), strip(g2));
    ok('GAS 無 KV 時明講沒存快照', g2.snapshot === 'no-kv');
    const withS = u => /news\.google\.com/.test(u) ? { txt: IT.socialRss } : IT.route(u, IT.gem);
    fetchImpl = async u => asResp(withS(u)); gsFetch = u => gsResp(withS(u));
    cmp('整條情報管線（社群分類）', strip(await W2.fetchIntel('2330', {})), strip(G.fetchIntel('2330')));
    const withF = u => /news\.google\.com/.test(u) ? { txt: IT.flood } : IT.route(u, IT.gem);
    fetchImpl = async u => asResp(withF(u)); gsFetch = u => gsResp(withF(u));
    cmp('整條情報管線（社群洗版配額）', strip(await W2.fetchIntel('2330', {})), strip(G.fetchIntel('2330')));
    fetchImpl = async u => asResp(withS(u)); gsFetch = u => gsResp(withS(u));
    cmp('新聞抓取與社群分類', await W2.fetchNews('2330', '台積電'), G.fetchNews('2330', '台積電'));
    cmp('交易日熱度', W2.heat(IT.heat.hItems, IT.heat.HNOW, 20, IT.heat.hItems, IT.heat.HD, true), G.heat(IT.heat.hItems, IT.heat.HNOW, 20, IT.heat.hItems, IT.heat.HD, true));
    cmp('交易日熱度（來源截斷）', W2.heat(IT.heat.hItems, IT.heat.HNOW, 5, IT.heat.hItems.slice(5), IT.heat.HD, false), G.heat(IT.heat.hItems, IT.heat.HNOW, 5, IT.heat.hItems.slice(5), IT.heat.HD, false));
    cmp('FinMind 新聞解析', W2.parseFinMindNews(IT.fmRows), G.parseFinMindNews(IT.fmRows));
    const withFM = u => /finmindtrade/.test(u) ? { json: IT.fmResp(u) } : IT.route(u, IT.gem);
    fetchImpl = async u => asResp(withFM(u)); gsFetch = u => gsResp(withFM(u));
    cmp('整條情報管線（FinMind＋Google）', strip(await W2.fetchIntel('2330', {}, '')), strip(G.fetchIntel('2330', '')));
    fetchImpl = async u => asResp(IT.route(u, IT.gem)); gsFetch = u => gsResp(IT.route(u, IT.gem));
    cmp('去重鍵', IT.dup.map(W2.dedupKey), IT.dup.map(G.dedupKey));
    ok('GAS 標示由 GAS 處理', G.fetchIntel('2330').engine === 'GAS');
    const emptyPtt = '<html><head><title>看板 Stock 文章列表</title></head><body><div class="r-list-container"></div></body></html>';
    fetchImpl = async u => /ptt\.cc/.test(u) ? asResp({ txt: emptyPtt }) : asResp(IT.route(u, IT.gem));
    gsFetch = u => /ptt\.cc/.test(u) ? gsResp({ txt: emptyPtt }) : gsResp(IT.route(u, IT.gem));
    cmp('整條情報管線（PTT 0 篇診斷）', strip(await W2.fetchIntel('2330', {})), strip(G.fetchIntel('2330')));
    gsFetch = u => /t187ap03_L/.test(u) ? gsResp({ status: 403, txt: 'x' }) : gsResp(IT.route(u, IT.gem));
    cmp('名稱查詢失敗訊息', IT.nameFail.notes, G.fetchIntel('2330').notes);
    gsFetch = u => gsResp(IT.route(u, IT.gem));
    gsFetch = u => /ptt\.cc/.test(u) ? gsResp({ status: 403, txt: 'x' }) : gsResp(IT.route(u, IT.gem));
    ok('GAS 單一來源失敗也列入 srcErrors', G.fetchIntel('2330').srcErrors.some(x => /PTT/.test(x) && /403/.test(x)));
  }

  /* ⑪ v174 GAS 雲端備份：單一值 9KB 上限（一筆交易約 800 bytes，約 11 筆就爆） */
  {
    const trade = i => ({ date: '2026-09-24', entryDate: '2026-09-10', code: '2330', direction: 'long', result: 'win', entryPrice: 2350, exitPrice: 2475,
      pnlPct: 5.32, pnl: 125000, shares: 1000, mae: -2.1, mfe: 7.4, plannedStop: 2280, exitReason: '達目標', judgment: 'good',
      judgmentReason: '順勢進場、停損依ATR、分批出場符合計畫🎯第' + i + '筆', entryFormulas: { probWin: 57, sti: 1.2, mfd: 0.35, eco: 61, psy: 48, fusion: 22, crash: 10 },
      batchRecords: [{ date: '2026-09-10', price: 2350, qty: 500 }], exitRecords: [{ date: '2026-09-24', price: 2475, qty: 500, exitJudge: '達目標' }], sim: false, id: i });
    const backup = n => ({ app: 'StockRadarPro', version: 174, settings: { capital: 1000000, risk: 1 }, trades: Array.from({ length: n }, (_, i) => trade(i)) });
    const post = b => JSON.parse(G.doPost({ parameter: { action: 'sync_save' }, postData: { contents: JSON.stringify(b) } }));
    const get = () => JSON.parse(G.doGet({ parameter: { action: 'sync_get' } }));
    const reset = () => { for (const k in userStore) delete userStore[k]; };

    reset();
    let oldErr = ''; try { userProps.setProperty('sync_data', JSON.stringify(backup(20))); } catch (e) { oldErr = e.message; }
    ok('（重現）舊做法：20 筆交易存成單一值就超過 9KB', /too large/.test(oldErr), oldErr);

    reset();
    const b50 = backup(50), r50 = post(b50);
    ok('雲端備份：50 筆交易存得進去', r50.ok === true && r50.usedPct > 0, JSON.stringify(r50));
    const g50 = get();
    ok('雲端備份：讀回來與存進去完全一致', g50.ok && JSON.stringify(g50.data) === JSON.stringify(b50));
    ok('雲端備份：每一段都在 9KB 以內', Object.keys(userStore).filter(k => /^sync_data_\d+$/.test(k)).every(k => u8(userStore[k]) <= 9216));

    // emoji 剛好落在切段處（UTF-16 代理對不可被切開）
    reset();
    const L0 = JSON.stringify({ app: 'StockRadarPro', note: '' }).length;   // note 內容從 L0-2 開始
    const pad = { app: 'StockRadarPro', note: 'x'.repeat(1999 - (L0 - 2)) + '🎯🎯🎯🎯' };
    ok('（夾具自檢）emoji 的前半確實落在切段處', JSON.stringify(pad).charCodeAt(1999) >= 0xD800 && JSON.stringify(pad).charCodeAt(1999) <= 0xDBFF);
    const re = post(pad), ge = get();
    ok('雲端備份：emoji 落在切段處也不會壞', re.ok && ge.ok && ge.data.note === pad.note, ge.data && ge.data.note && ge.data.note.slice(-6));

    // 備份變短：上一次多出來的段落要清掉，不能混進新資料
    reset(); post(backup(50)); const b5 = backup(5); post(b5);
    ok('雲端備份：備份變短後讀回的是新資料（不殘留舊段）', JSON.stringify(get().data) === JSON.stringify(b5) && !Object.keys(userStore).some(k => /^sync_data_(\d+)$/.test(k) && +k.split('_')[2] >= +userStore.sync_data_n));

    // v177 兩台裝置同時備份：拿不到鎖就明講，不硬寫（硬寫時一邊清殘段會刪掉另一邊剛寫的段）
    reset(); lockHeld = true;
    const busy = post(backup(2)), busyG = get();
    lockHeld = false;
    ok('雲端備份：另一台正在備份時明講請稍後，不硬寫也不硬讀', busy.ok === false && /10 秒後再試/.test(busy.error) && busyG.ok === false && !Object.keys(userStore).length, JSON.stringify(busy));
    // v182 GAS 算完的情報保留 10 分鐘：前端等不及斷線，GAS 仍跑完；重試直接拿到，不重打 Gemini
    { const store = {}; let n = 0; const gsResp = x => ({ getResponseCode: () => x.status || 200, getContentText: () => x.txt != null ? x.txt : JSON.stringify(x.json) });
      global.CacheService = { getScriptCache: () => ({ get: k => (k in store ? store[k] : null), put: (k, v) => { store[k] = v; } }) };
      gsFetch = u => { if (/generativelanguage/.test(u)) n++; return gsResp(IT.route(u, IT.gem)); }; gsProps = { GEMINI_KEY: 'k-test' };
      const a1 = JSON.parse(G.doGet({ parameter: { action: 'intel', code: '2330' } })), a2 = JSON.parse(G.doGet({ parameter: { action: 'intel', code: '2330' } }));
      ok('GAS：同一檔 10 分鐘內第二次直接取快取，不重打 Gemini', a1.ok && !a1.cached && a2.cached === true && n === 1 && a2.items.length === a1.items.length, `Gemini ${n} 次`);
      delete global.CacheService; gsProps = {}; }
    ok('雲端備份：做完會放開鎖（下一次照常）', post(backup(2)).ok === true && get().data.trades.length === 2);

    // 舊格式相容：v173 以前存的單一值讀得到，新存一次後自動換成分段格式
    reset(); userStore.sync_data = JSON.stringify(backup(3));
    ok('雲端備份：舊格式備份仍讀得回來', get().data.trades.length === 3);
    post(backup(4));
    ok('雲端備份：新存一次後舊格式自動清除', !('sync_data' in userStore) && get().data.trades.length === 4);

    // 少一段：寧可失敗，也不要還原出殘缺資料覆蓋手機
    reset(); post(backup(50)); delete userStore.sync_data_1;
    const gm = get();
    ok('雲端備份：缺段時拒絕還原並講明原因', gm.ok === false && /缺第 2\//.test(gm.error), JSON.stringify(gm).slice(0, 100));

    // 超過總上限：明講改用下載備份檔
    reset();
    const huge = post({ app: 'StockRadarPro', blob: 'x'.repeat(470 * 1024) });
    ok('雲端備份：超過 GAS 總上限時明講改用下載備份檔', huge.ok === false && /下載備份檔/.test(huge.error), huge.error);
    reset();
    ok('前端：存檔成功時顯示已用空間、接近上限時提醒', /j\.usedPct >= 70/.test(fs.readFileSync(path.join(ROOT, 'journal.js'), 'utf8')));
  }

  // ⑧ 前端判定：假日不得誤報、真失敗必須示警
  const unrel = c => (c.headMiss > 0) || (c.expected && String(c.dataDate || '') < String(c.expected));
  ok('前端不會對假日誤報籌碼不完整', !unrel(ch) && !unrel(gch));
  ok('前端仍會對真失敗示警', unrel(ch2));
}

(async () => {
  console.log('═══ StockRadar 自我檢查 ═══');
  /* v176：任何一段丟出例外時，記成一項失敗並照樣印出總結——原本會整個中斷、看不到其餘結果 */
  for (const [name, fn] of [['邏輯', logicTests], ['情報前端', intelFrontTests], ['後端', backendTests],
    ...(LOGIC_ONLY ? [] : [['版面', layoutTests], ['掃描流程', scanFlowTests], ['瀏覽器', browserTests]])]) {
    try { await fn(); } catch (e) { ok(`「${name}」檢查段中斷`, false, String(e && e.message || e).slice(0, 160)); }
  }
  console.log(`\n通過 ${pass} 項｜失敗 ${fail} 項`);
  if (fails.length) { console.log('\n❌ 失敗項目：'); fails.forEach(f => console.log('  - ' + f)); }
  else console.log('✅ 全部通過');
  process.exit(fail ? 1 : 0);
})();
