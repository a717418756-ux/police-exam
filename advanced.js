/* ══════════════════════════════════════════════════════════════════════
   advanced.js — 法人等級進階分析（市場→產業→個股 三層）
   ──────────────────────────────────────────────────────────────────
   A. RS Rating 相對強弱評級（vs 大盤，O'Neil 法）
   B. Beta / Alpha（個股 vs 大盤回歸）
   C. 機率預測（取代買賣燈，改顯示上漲機率%）
   D. 支撐壓力自動辨識
   E. 量價異常雷達
   F. 市場情緒儀表板（融資融券+VIX+PCR 合成）
   依賴：app.js($/fmt/fmtV)、quant.js(signalsAtIndex)
   資料限制：產業分類/籌碼集中度無免費API，以近似法或標註
   ══════════════════════════════════════════════════════════════════════ */

/* ── 大盤基準快取（避免每檔都重抓）─────────────────────────────────── */
let _benchCache = { tw: null, us: null, time: 0 };
async function fetchBenchmark(isTW) {
  const key = isTW ? 'tw' : 'us';
  // 快取 10 分鐘
  if (_benchCache[key] && (Date.now() - _benchCache.time < 600000)) return _benchCache[key];
  if (!GAS_URL || GAS_URL.indexOf('http') !== 0) return null;
  try {
    const r = await fetch(`${GAS_URL}?action=benchmark&market=${key}`);
    const j = await r.json();
    if (j.ok && j.closes) {
      _benchCache[key] = j.closes;
      _benchCache.time = Date.now();
      return j.closes;
    }
  } catch (e) {
    if (typeof ErrorLog !== 'undefined') ErrorLog.push('fetchBenchmark', e);
  }
  return null;
}

/* ══ A. RS Rating 相對強弱 ════════════════════════════════════════════
   O'Neil 法：個股近250日報酬 vs 市場，換算成 1~99 評級
   需大盤資料（從 market 帶入 benchmark 報酬）
   ════════════════════════════════════════════════════════════════════ */
function computeRSRating(D, benchReturn) {
  const c = D.closes;
  const n = c.length;
  // 個股報酬（加權近期：近63日權重高）
  const ret = (period) => {
    if (n <= period) return (c[n-1] - c[0]) / c[0];
    return (c[n-1] - c[n-1-period]) / c[n-1-period];
  };
  // O'Neil 加權：近一季 ×2 + 近半年 + 近一年
  const r63 = ret(63), r126 = ret(126), r252 = ret(252);
  const weighted = (r63 * 2 + r126 + r252) / 4;

  // 若有大盤基準，算相對強弱；否則用絕對報酬映射
  let rsRaw;
  if (benchReturn != null) {
    rsRaw = weighted - benchReturn; // 超額報酬
  } else {
    rsRaw = weighted;
  }
  // 映射到 1~99（用 tanh 壓縮，±30%超額對應極值）
  const rating = Math.round(50 + 49 * Math.tanh(rsRaw / 0.3));
  return {
    rating: Math.max(1, Math.min(99, rating)),
    r63: r63 * 100, r126: r126 * 100, r252: r252 * 100,
    weighted: weighted * 100,
    excess: benchReturn != null ? (weighted - benchReturn) * 100 : null
  };
}

function renderRSRating(rs) {
  const card = document.getElementById('rs-card');
  card.style.display = 'block';
  const col = rs.rating >= 80 ? 'var(--buy)' : rs.rating >= 50 ? 'var(--warn)' : 'var(--sell)';
  document.getElementById('rs-val').textContent = rs.rating;
  document.getElementById('rs-val').style.color = col;
  let desc;
  if (rs.rating >= 90) desc = `強於市場 ${rs.rating}% 的股票，超強勢，法人選股常要求 RS>80`;
  else if (rs.rating >= 70) desc = `強於市場 ${rs.rating}% 的股票，相對強勢`;
  else if (rs.rating >= 50) desc = `中等強度，與大盤同步`;
  else desc = `弱於市場，RS ${rs.rating}，相對弱勢，留意`;
  document.getElementById('rs-desc').textContent = desc;
  document.getElementById('rs-detail').textContent =
    `近季 ${rs.r63>=0?'+':''}${rs.r63.toFixed(1)}%｜近半年 ${rs.r126>=0?'+':''}${rs.r126.toFixed(1)}%｜近年 ${rs.r252>=0?'+':''}${rs.r252.toFixed(1)}%` +
    (rs.excess != null ? `｜超額報酬 ${rs.excess>=0?'+':''}${rs.excess.toFixed(1)}%` : '｜⚠️ 大盤資料未取得，此為絕對報酬近似（非相對強弱）');
}

/* ══ B. Beta / Alpha ══════════════════════════════════════════════════
   用個股與大盤日報酬做線性回歸：報酬_股 = α + β × 報酬_大盤
   ════════════════════════════════════════════════════════════════════ */
function computeBetaAlpha(D, benchCloses) {
  if (!benchCloses || benchCloses.length < 30) return null;
  const c = D.closes;
  const len = Math.min(c.length, benchCloses.length, 120); // 用近120日
  const sr = [], mr = [];
  for (let i = 1; i < len; i++) {
    const si = c[c.length - len + i], si1 = c[c.length - len + i - 1];
    const bi = benchCloses[benchCloses.length - len + i], bi1 = benchCloses[benchCloses.length - len + i - 1];
    if (si1 && bi1) { sr.push((si - si1) / si1); mr.push((bi - bi1) / bi1); }
  }
  if (sr.length < 20) return null;
  const meanS = sr.reduce((a,b)=>a+b,0)/sr.length;
  const meanM = mr.reduce((a,b)=>a+b,0)/mr.length;
  let cov = 0, varM = 0;
  for (let i = 0; i < sr.length; i++) {
    cov += (sr[i]-meanS)*(mr[i]-meanM);
    varM += (mr[i]-meanM)**2;
  }
  const beta = varM ? cov/varM : 1;
  // Alpha（年化）：個股平均報酬 - beta×大盤平均報酬，×252
  const alpha = (meanS - beta * meanM) * 252 * 100;
  return { beta, alpha };
}

function renderBetaAlpha(ba) {
  const card = document.getElementById('beta-card');
  if (!ba) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const boxes = [
    { label: '📊 Beta 波動係數', value: ba.beta.toFixed(2),
      valCls: ba.beta > 1.3 ? 'sell' : ba.beta < 0.8 ? 'buy' : 'warn',
      cls: ba.beta > 1.3 ? '' : 'good',
      sub: ba.beta > 1.3 ? `大盤漲1%，此股約漲 ${ba.beta.toFixed(1)}%，高波動高風險` :
           ba.beta < 0.8 ? `波動低於大盤，相對抗跌` : `與大盤波動接近` },
    { label: '💎 Alpha 超額報酬(年化)', value: (ba.alpha>=0?'+':'')+ba.alpha.toFixed(1)+'%',
      valCls: ba.alpha >= 0 ? 'buy' : 'sell',
      cls: ba.alpha >= 0 ? 'good' : '',
      sub: ba.alpha >= 0 ? `扣除大盤影響後仍正報酬，真有實力` : `跑輸大盤，超額報酬為負` }
  ];
  document.getElementById('beta-grid').innerHTML = boxes.map(x =>
    `<div class="risk-box ${x.cls}"><div class="rb-label">${x.label}</div><div class="rb-value ${x.valCls}">${x.value}</div><div class="rb-sub">${x.sub}</div></div>`
  ).join('');
}

/* ══ C. 機率預測（取代買賣燈）════════════════════════════════════════
   用多週期回測的上漲機率，直接顯示 % 而非買賣燈
   ════════════════════════════════════════════════════════════════════ */
function computeProbability(D) {
  const periods = [5, 10, 20];
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes;
  const n = c.length;
  const results = [];
  // 當前訊號只算一次（原本誤放在迴圈內，每根K棒重複計算 → 效能浪費）
  const curSigOnce = signalsAtIndex(c, h, l, v, n-1);
  const curBuysN = curSigOnce ? Object.values(curSigOnce).filter(s=>s==='buy').length : 0;
  const curSellsN = curSigOnce ? Object.values(curSigOnce).filter(s=>s==='sell').length : 0;
  const curBull = curBuysN > curSellsN;
  for (const horizon of periods) {
    let upCount = 0, total = 0;
    if (!curSigOnce) { results.push({ horizon, prob: null, samples: 0 }); continue; }
    for (let i = 60; i < n - horizon; i++) {
      const sig = signalsAtIndex(c, h, l, v, i);
      if (!sig) continue;
      const vals = Object.values(sig);
      const buys = vals.filter(s => s === 'buy').length;
      const sells = vals.filter(s => s === 'sell').length;
      // 只統計與當前同向的歷史情境
      if ((curBull && buys > sells) || (!curBull && sells > buys)) {
        total++;
        const fut = (c[i+horizon] - c[i]) / c[i];
        if (curBull ? fut > 0 : fut < 0) upCount++;
      }
    }
    const prob = total >= 5 ? upCount/total : null;  // 最小樣本 3→5：3筆算出的機率統計上沒意義
    results.push({ horizon, prob, samples: total });
  }
  // 當前方向
  const curSig = signalsAtIndex(c, h, l, v, n-1);
  const cb = curSig ? Object.values(curSig).filter(s=>s==='buy').length : 0;
  const cs = curSig ? Object.values(curSig).filter(s=>s==='sell').length : 0;
  return { results, direction: cb > cs ? 'up' : cb < cs ? 'down' : 'neutral' };
}

function renderProbability(p) {
  const card = document.getElementById('prob-card');
  if (!p || p.results.every(r => r.prob === null)) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const dirText = p.direction === 'up' ? '上漲' : p.direction === 'down' ? '下跌' : '盤整';
  document.getElementById('prob-dir').textContent = `當前訊號偏「${dirText}」，歷史相似情境的${dirText}機率：`;
  const rows = p.results.map(r => {
    const pct = r.prob != null ? (r.prob*100).toFixed(0)+'%' : '樣本不足';
    const col = r.prob == null ? 'var(--muted)' : r.prob >= 0.6 ? 'var(--buy)' : r.prob >= 0.5 ? 'var(--warn)' : 'var(--sell)';
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd)">
      <span style="font-family:var(--mono);font-size:13px;width:46px">${r.horizon}日</span>
      <div style="flex:1;height:8px;background:var(--bd);border-radius:99px;overflow:hidden"><div style="height:100%;width:${r.prob!=null?r.prob*100:0}%;background:${col}"></div></div>
      <span style="font-family:var(--mono);font-size:15px;font-weight:700;color:${col};width:54px;text-align:right">${pct}</span>
      <span style="font-size:9px;color:var(--muted);width:48px;text-align:right">${r.samples}樣本</span>
    </div>`;
  }).join('');
  document.getElementById('prob-rows').innerHTML = rows;
}

/* ══ D. 支撐壓力自動辨識 ══════════════════════════════════════════════
   用近期轉折高低點 + 成交密集區，找出支撐壓力位
   ════════════════════════════════════════════════════════════════════ */
function computeSupportResistance(D) {
  const c = D.closes, h = D.highs, l = D.lows;
  const price = D.price;
  const N = Math.min(120, c.length);
  const hs = h.slice(-N), ls = l.slice(-N);

  // 找局部轉折高點（壓力）與低點（支撐）
  const pivots = { res: [], sup: [] };
  for (let i = 2; i < N-2; i++) {
    if (hs[i] > hs[i-1] && hs[i] > hs[i-2] && hs[i] > hs[i+1] && hs[i] > hs[i+2]) pivots.res.push(hs[i]);
    if (ls[i] < ls[i-1] && ls[i] < ls[i-2] && ls[i] < ls[i+1] && ls[i] < ls[i+2]) pivots.sup.push(ls[i]);
  }
  // 壓力：高於現價、由近到遠取3個；支撐：低於現價取3個
  const res = [...new Set(pivots.res.filter(p => p > price).map(p => Math.round(p*100)/100))].sort((a,b)=>a-b).slice(0,3);
  const sup = [...new Set(pivots.sup.filter(p => p < price).map(p => Math.round(p*100)/100))].sort((a,b)=>b-a).slice(0,3);
  return { res, sup, price };
}

function renderSupportResistance(sr) {
  const card = document.getElementById('sr-card');
  card.style.display = 'block';
  const cur = '';
  const resHtml = sr.res.length ? sr.res.map((r,i) =>
    `<div style="display:flex;justify-content:space-between;padding:5px 10px;background:var(--sell-d);border-radius:6px;margin-bottom:4px"><span style="font-size:11px;color:var(--muted)">壓力${i+1}</span><span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--sell)">${fmt(r)}</span></div>`
  ).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px">近期無明顯壓力（接近高點）</div>';
  const supHtml = sr.sup.length ? sr.sup.map((s,i) =>
    `<div style="display:flex;justify-content:space-between;padding:5px 10px;background:var(--buy-d);border-radius:6px;margin-bottom:4px"><span style="font-size:11px;color:var(--muted)">支撐${i+1}</span><span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--buy)">${fmt(s)}</span></div>`
  ).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px">近期無明顯支撐（接近低點）</div>';
  document.getElementById('sr-content').innerHTML =
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div><div style="font-size:10px;color:var(--sell);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">⬆️ 上方壓力</div>${resHtml}</div>
      <div><div style="font-size:10px;color:var(--buy);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">⬇️ 下方支撐</div>${supHtml}</div>
    </div>
    <div style="text-align:center;margin-top:10px;font-family:var(--mono);font-size:12px;color:var(--muted)">目前價格 ${fmt(sr.price)}</div>`;
}

/* ══ E. 量價異常雷達 ══════════════════════════════════════════════════ */
function computeVolPriceRadar(D) {
  const c = D.closes, v = D.volumes, h = D.highs;
  const price = D.price, prevClose = D.prevClose;
  const alerts = [];
  if (v.length < 6) return alerts;

  const vr = v[v.length-1] / (v.slice(-6,-1).reduce((a,b)=>a+b,0)/5);
  const chgPct = (price - prevClose) / prevClose * 100;

  // 量增價未漲 → 出貨疑慮
  if (vr > 2.5 && Math.abs(chgPct) < 1.5) {
    alerts.push({ type:'warn', icon:'⚠️', title:`量增 ${vr.toFixed(1)}倍 但僅漲跌 ${chgPct.toFixed(1)}%`,
      desc:'爆量卻沒推動股價，可能是高檔出貨或換手，留意主力動向' });
  }
  // 量縮創高 → 上攻動能不足
  const recentHigh = Math.max(...h.slice(-20, -1));
  if (price > recentHigh && vr < 0.8) {
    alerts.push({ type:'warn', icon:'⚠️', title:'量縮創新高',
      desc:'價格創高但量能萎縮，買盤接手意願低，上攻動能不足，留意假突破' });
  }
  // 放量大漲 → 健康攻擊
  if (vr > 1.8 && chgPct > 3) {
    alerts.push({ type:'good', icon:'🚀', title:`放量大漲 ${chgPct.toFixed(1)}%（量 ${vr.toFixed(1)}倍）`,
      desc:'量價齊揚，資金認同，屬健康攻擊型態' });
  }
  // 窒息量 → 可能變盤
  if (vr < 0.5) {
    alerts.push({ type:'warn', icon:'😴', title:`窒息量（僅均量 ${(vr*100).toFixed(0)}%）`,
      desc:'成交極度萎縮，多空觀望，常為變盤前兆，留意次日方向' });
  }
  if (alerts.length === 0) {
    alerts.push({ type:'good', icon:'✅', title:'量價關係正常', desc:'目前無明顯量價背離或異常訊號' });
  }
  return alerts;
}

function renderVolPriceRadar(alerts) {
  const card = document.getElementById('vpradar-card');
  card.style.display = 'block';
  document.getElementById('vpradar-list').innerHTML = alerts.map(a =>
    `<div class="psych-alert ${a.type==='good'?'ok':'fire'}"><span class="pa-icon">${a.icon}</span><div class="pa-body"><div class="pa-title ${a.type==='good'?'ok':'fire'}">${a.title}</div><div class="pa-desc">${a.desc}</div></div></div>`
  ).join('');
}

/* ══ 樣本外驗證（Out-of-Sample Validation）══════════════════════════
   回答「這檔股票的訊號準確率可不可信」的誠實方法：
   前70%歷史當「訓練段」、後30%當「測試段」（模型沒看過的資料）。
   訓練段命中率高但測試段掉很多 = 過擬合（歷史內漂亮、未來失效）。
   這是量化機構與散戶曲線擬合者的分水嶺。
   ════════════════════════════════════════════════════════════════════ */
function computeOOSValidation(D, horizon = 5) {
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes, n = c.length;
  if (n < 250) return null;  // 2年資料才夠切
  const split = Math.floor(n * 0.7);

  const evalRange = (from, to) => {
    let hit = 0, tot = 0;
    for (let i = from; i < to - horizon; i++) {
      const sig = signalsAtIndex(c, h, l, v, i);
      if (!sig) continue;
      const vals = Object.values(sig);
      const buys = vals.filter(s => s === 'buy').length;
      const sells = vals.filter(s => s === 'sell').length;
      if (buys === sells) continue;  // 無方向不計
      const dir = buys > sells ? 1 : -1;
      tot++;
      const fut = c[i + horizon] - c[i];
      if ((dir === 1 && fut > 0) || (dir === -1 && fut < 0)) hit++;
    }
    return { rate: tot ? hit / tot : null, n: tot };
  };

  const train = evalRange(60, split);
  const test = evalRange(split, n);
  if (train.rate == null || test.rate == null) return null;

  const drop = (train.rate - test.rate) * 100;
  let verdict, vClass;
  if (test.n < 20) { verdict = '測試樣本不足，無法下結論'; vClass = 'warn'; }
  else if (test.rate >= 0.55 && drop <= 10) { verdict = '樣本外仍有效——此股的技術訊號有實際參考價值'; vClass = 'buy'; }
  else if (drop > 12) { verdict = '過擬合警訊——歷史內漂亮但沒看過的資料上失效，此股技術訊號別重壓'; vClass = 'sell'; }
  else if (test.rate >= 0.45 && test.rate < 0.55) { verdict = '樣本外接近擲硬幣——此股技術訊號參考價值低，決策改倚重籌碼/主力/融資維度'; vClass = 'warn'; }
  else if (test.rate < 0.45) { verdict = '樣本外反向——此股訊號甚至略帶反指標性質，多空判斷需極度保守'; vClass = 'sell'; }
  else { verdict = '樣本外普通——訊號可參考但需其他維度共振確認'; vClass = 'warn'; }

  return { train, test, drop, verdict, vClass, horizon };
}

function renderOOS(D) {
  const card = document.getElementById('oos-card');
  if (!card) return;
  const o = computeOOSValidation(D);
  if (!o) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const colMap = { buy: 'var(--buy)', warn: 'var(--warn)', sell: 'var(--sell)' };
  const col = colMap[o.vClass];
  const bar = (label, r, c2) => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="font-size:11px;width:110px;color:var(--muted)">${label}</span>
      <div style="flex:1;height:8px;background:var(--bd);border-radius:99px;overflow:hidden"><div style="height:100%;width:${(r.rate*100).toFixed(0)}%;background:${c2}"></div></div>
      <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${c2};width:46px;text-align:right">${(r.rate*100).toFixed(1)}%</span>
      <span style="font-size:9px;color:var(--muted2);width:52px;text-align:right">${r.n}樣本</span>
    </div>`;
  document.getElementById('oos-content').innerHTML = `
    ${bar('訓練段（前70%歷史）', o.train, 'var(--acc)')}
    ${bar('測試段（後30%未見過）', o.test, col)}
    <div style="margin-top:10px;padding:10px 12px;background:${col}10;border:1px solid ${col}50;border-radius:9px;font-size:12px;font-weight:600;color:${col};line-height:1.6">${o.verdict}</div>
    <div style="font-size:10px;color:var(--muted2);margin-top:8px;line-height:1.6">💡 訓練段=用來「學」的歷史；測試段=模型沒看過的近期資料，最接近「未來」。兩段差距小且測試段>55% 才代表訊號真的有預測力（${o.horizon}日方向命中率，含各50%的隨機基準）。這是誠實的準確率，不是樣本內的漂亮數字。</div>`;
}

/* ══ 基本面體檢（台股：估值 + 月營收）════════════════════════════════
   定位：背景濾網，不是進出場訊號。波段層級的用途：
   ①營收連續衰退 = 空單的基本面順風 ②估值極端 = 泡沫語境
   ③殖利率 = 空單除息成本提醒
   ════════════════════════════════════════════════════════════════════ */
const _fundCache = {};
async function loadFundamentalCard(D) {
  const card = document.getElementById('fundamental-card');
  if (!card) return;
  if (D.currency !== 'TWD') { card.style.display = 'none'; return; }
  let f = null;
  const hit = _fundCache[D.code];
  if (hit && Date.now() - hit.t < 600000) f = hit.d;
  else {
    try {
      const r = await fetch(`${GAS_URL}?action=fundamental&code=${encodeURIComponent(D.code)}`);
      const j = await r.json();
      if (j.ok) { f = j; _fundCache[D.code] = { d: j, t: Date.now() }; }
    } catch (e) { if (typeof ErrorLog !== 'undefined') ErrorLog.push('基本面', e); }
  }
  if (!f) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  // 判讀（空方交易者視角）
  const notes = [];
  if (f.revYoY != null) {
    if (f.revYoY <= -10) notes.push({ c: 'var(--sell)', t: `營收年減 ${f.revYoY.toFixed(1)}%——基本面偏空順風：空單有基本面支持，反彈是空點不是買點` });
    else if (f.revYoY >= 20) notes.push({ c: 'var(--buy)', t: `營收年增 +${f.revYoY.toFixed(1)}%——成長強勁：做空=逆基本面，技術翻空也要快進快出別戀戰` });
  }
  if (f.pe != null && f.pe > 0) {
    if (f.pe >= 40) notes.push({ c: 'var(--warn)', t: `本益比 ${f.pe.toFixed(1)} 偏高——估值進入泡沫語境，若同時過熱/擁擠，大跌燃料充足` });
    else if (f.pe <= 10) notes.push({ c: 'var(--muted)', t: `本益比 ${f.pe.toFixed(1)} 偏低——便宜不是買進理由（可能是價值陷阱），但重挫後支撐較實` });
  } else if (f.pe === 0) {
    notes.push({ c: 'var(--sell)', t: '本益比無法計算（虧損中）——虧損股是空方的基本面獵物，但也最容易暴力軋空，嚴設停損' });
  }
  if (f.dividendYield != null && f.dividendYield >= 5) {
    notes.push({ c: 'var(--warn)', t: `殖利率 ${f.dividendYield.toFixed(1)}%——空單跨除息日要付股息（成本），留意除息時程` });
  }

  const box = (label, val, sub) => `<div class="risk-box"><div class="rb-label">${label}</div><div class="rb-value">${val}</div><div class="rb-sub">${sub}</div></div>`;
  let html = `<div class="risk-grid">
    ${box('📈 月營收 YoY', f.revYoY != null ? (f.revYoY >= 0 ? '+' : '') + f.revYoY.toFixed(1) + '%' : '—', f.revMonth ? '資料月份 ' + f.revMonth : '去年同月比')}
    ${box('📊 月營收 MoM', f.revMoM != null ? (f.revMoM >= 0 ? '+' : '') + f.revMoM.toFixed(1) + '%' : '—', '上月比較')}
    ${box('💰 本益比', f.pe != null && f.pe > 0 ? f.pe.toFixed(1) : (f.pe === 0 ? '虧損' : '—'), 'PE')}
    ${box('🏦 股價淨值比', f.pb != null && f.pb > 0 ? f.pb.toFixed(2) : '—', 'PB')}
  </div>`;
  if (f.dividendYield != null && f.dividendYield > 0) html += `<div style="font-size:11px;color:var(--muted);margin-top:8px">殖利率 ${f.dividendYield.toFixed(2)}%</div>`;
  notes.forEach(x => { html += `<div style="margin-top:8px;padding:9px 12px;background:${x.c}10;border:1px solid ${x.c}50;border-radius:8px;font-size:11px;color:var(--muted);line-height:1.6">${x.t}</div>`; });
  html += `<div style="font-size:10px;color:var(--muted2);margin-top:10px;line-height:1.6">💡 基本面在波段層級是「背景濾網」不是進出場訊號：避免逆重大基本面做單、放大泡沫判斷。台股月營收每月10日前公布，常是行情引爆點。資料：證交所 BWIBBU / 月營收彙總。</div>`;
  document.getElementById('fundamental-content').innerHTML = html;
}
