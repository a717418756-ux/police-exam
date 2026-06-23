/* ══════════════════════════════════════════════════════════════════════
   enhance.js — 進階分析強化模組
   ──────────────────────────────────────────────────────────────────
   區塊 A：籌碼面顯示（外資/投信買賣超 + 連買天數）
   區塊 B：VIX 恐慌指數判讀
   區塊 C：市場環境總分（外資期貨+PCR+SOX+VIX 合成）
   區塊 D：多週期回測（3/5/10/20 天勝率）
   區塊 E：進出場劇本（ATR 風控整理成操作卡）
   區塊 F：風險強化（最大回撤 + 波動率排名）
   區塊 G：個股健康度體檢報告
   依賴：app.js($/fmt/fmtV)、formula.js、quant.js
   資料限制：主力(券商分點)、產業強弱 無免費API，未實作或以近似標註
   ══════════════════════════════════════════════════════════════════════ */

/* ══ 區塊 A：籌碼面 ════════════════════════════════════════════════════ */
function renderChip(chip) {
  const card = document.getElementById('chip-card');
  if (!chip) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const fmtLot = n => (n >= 0 ? '+' : '') + fmtV(n) + ' 張';
  const boxes = [];

  // 外資
  const fBull = chip.foreign5 > 0;
  boxes.push({ cls: fBull ? 'good' : '', label: '🌎 外資買賣超',
    value: fmtLot(chip.foreign5), valCls: fBull ? 'buy' : 'sell',
    sub: `近5日｜單日 ${fmtLot(chip.foreign1)}｜20日 ${fmtLot(chip.foreign20)}` +
         (chip.foreignStreak >= 2 ? `｜🔥連買 ${chip.foreignStreak} 天` : '') });

  // 投信
  const tBull = chip.trust5 > 0;
  boxes.push({ cls: tBull ? 'good' : '', label: '🏦 投信買賣超',
    value: fmtLot(chip.trust5), valCls: tBull ? 'buy' : 'sell',
    sub: `近5日｜單日 ${fmtLot(chip.trust1)}｜20日 ${fmtLot(chip.trust20)}` +
         (chip.trustStreak >= 2 ? `｜🔥投信連買 ${chip.trustStreak} 天（飆股常見）` : '') });

  document.getElementById('chip-grid').innerHTML = boxes.map(x =>
    `<div class="risk-box ${x.cls}"><div class="rb-label">${x.label}</div><div class="rb-value ${x.valCls}">${x.value}</div><div class="rb-sub">${x.sub}</div></div>`
  ).join('');
}

/* ══ 區塊 C：市場環境總分（含 VIX）════════════════════════════════════
   合成：外資期貨方向 + PCR + SOX隔夜 + VIX → 0~100 分
   ════════════════════════════════════════════════════════════════════ */
function computeMarketScore(m) {
  if (!m) return null;
  const t = m.taifex || {}, us = m.us || {};
  let score = 50; // 中性基準
  const factors = [];

  // 外資期貨淨多空（±15）
  if (t.foreignNet != null) {
    if (t.foreignNet > 0) { score += 12; factors.push('外資期貨偏多 +12'); }
    else { score -= 12; factors.push('外資期貨偏空 -12'); }
  }
  // PCR（±10）：>120 反指標偏多
  if (t.pcrOI) {
    if (t.pcrOI > 120) { score += 8; factors.push('PCR高散戶恐慌(反指標偏多) +8'); }
    else if (t.pcrOI < 80) { score -= 8; factors.push('PCR低過度樂觀 -8'); }
  }
  // SOX 隔夜（±12）
  if (us.sox) {
    const c = us.sox.changePct;
    const adj = Math.max(-12, Math.min(12, c * 3));
    score += adj; factors.push(`費半隔夜 ${c >= 0 ? '+' : ''}${c.toFixed(1)}% (${adj >= 0 ? '+' : ''}${adj.toFixed(0)})`);
  }
  // VIX（±15）：低過熱、高恐慌(可能築底)
  let vixNote = '';
  if (us.vix) {
    const v = us.vix.price;
    if (v < 15) { score += 5; vixNote = `VIX ${v.toFixed(1)} 過熱（市場自滿，留意拉回）`; factors.push('VIX過低自滿 +5'); }
    else if (v > 30) { score -= 10; vixNote = `VIX ${v.toFixed(1)} 恐慌（大跌中，但常是底部區）`; factors.push('VIX恐慌 -10'); }
    else if (v > 25) { score -= 5; vixNote = `VIX ${v.toFixed(1)} 偏高，波動加劇`; factors.push('VIX偏高 -5'); }
    else { vixNote = `VIX ${v.toFixed(1)} 正常區間`; }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let label, stars;
  if (score >= 70) { label = '偏多'; stars = '★★★★★'; }
  else if (score >= 55) { label = '偏多中性'; stars = '★★★★☆'; }
  else if (score >= 45) { label = '中性'; stars = '★★★☆☆'; }
  else if (score >= 30) { label = '偏空中性'; stars = '★★☆☆☆'; }
  else { label = '偏空'; stars = '★☆☆☆☆'; }

  return { score, label, stars, factors, vixNote, vix: us.vix ? us.vix.price : null };
}

function renderMarketScore(ms) {
  const card = document.getElementById('mktscore-card');
  if (!ms) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const col = ms.score >= 55 ? 'var(--buy)' : ms.score <= 45 ? 'var(--sell)' : 'var(--warn)';
  document.getElementById('ms-score').textContent = ms.score;
  document.getElementById('ms-score').style.color = col;
  document.getElementById('ms-label').textContent = ms.label + '　' + ms.stars;
  document.getElementById('ms-label').style.color = col;
  document.getElementById('ms-vix').textContent = ms.vixNote || '';
  document.getElementById('ms-factors').textContent = '計算：' + ms.factors.join('、');
}

/* ══ 區塊 D：多週期回測（3/5/10/20 天勝率）════════════════════════════ */
function multiPeriodBacktest(D) {
  const periods = [3, 5, 10, 20];
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes;
  const n = c.length;
  const results = [];

  for (const horizon of periods) {
    // 用「綜合買進訊號」當進場條件，統計 horizon 天後上漲機率
    let hit = 0, total = 0;
    for (let i = 60; i < n - horizon; i++) {
      const sig = signalsAtIndex(c, h, l, v, i);
      if (!sig) continue;
      // 多數指標偏多才算一次進場樣本
      const vals = Object.values(sig);
      const buys = vals.filter(s => s === 'buy').length;
      const sells = vals.filter(s => s === 'sell').length;
      if (buys > sells && buys >= 2) {
        total++;
        const future = (c[i + horizon] - c[i]) / c[i];
        if (future > 0) hit++;
      }
    }
    results.push({ horizon, winRate: total >= 3 ? hit / total : null, samples: total });
  }
  return results;
}

function renderMultiPeriod(results) {
  const card = document.getElementById('multiperiod-card');
  if (!results || results.every(r => r.winRate === null)) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  // 找最高勝率週期 → 建議玩法
  let best = null;
  for (const r of results) if (r.winRate != null && (!best || r.winRate > best.winRate)) best = r;
  const playMap = { 3: '隔日沖／極短線', 5: '短波段', 10: '波段', 20: '中長波段' };
  const advice = best ? `此股歷史上最適合「${playMap[best.horizon]}」（${best.horizon}天勝率最高）` : '樣本不足';

  const rows = results.map(r => {
    const wr = r.winRate != null ? (r.winRate * 100).toFixed(0) + '%' : '樣本不足';
    const col = r.winRate == null ? 'var(--muted)' : r.winRate >= 0.6 ? 'var(--buy)' : r.winRate >= 0.5 ? 'var(--warn)' : 'var(--sell)';
    const isBest = best && r.horizon === best.horizon;
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--bd)">
      <span style="font-family:var(--mono);font-size:13px;width:50px;color:${isBest ? 'var(--buy)' : 'var(--txt)'}">${r.horizon}天${isBest ? ' ⭐' : ''}</span>
      <div style="flex:1;height:7px;background:var(--bd);border-radius:99px;overflow:hidden"><div style="height:100%;width:${r.winRate != null ? r.winRate * 100 : 0}%;background:${col}"></div></div>
      <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:${col};width:70px;text-align:right">${wr}</span>
      <span style="font-size:9px;color:var(--muted);width:50px;text-align:right">${r.samples}樣本</span>
    </div>`;
  }).join('');
  document.getElementById('mp-rows').innerHTML = rows;
  document.getElementById('mp-advice').textContent = advice;
}

/* ══ 區塊 E：進出場劇本 ═══════════════════════════════════════════════ */
function renderPlaybook(D, atr) {
  const card = document.getElementById('playbook-card');
  card.style.display = 'block';
  const price = D.price;
  const cur = D.currency === 'TWD' ? '' : '$';

  // 進場參考：當前價附近（回測常見用前低或均線支撐，這裡用 price 與 ATR）
  const entry = price;
  const stop = price - atr * 2;             // 2×ATR 停損
  const stopDist = price - stop;
  const tp1 = price + stopDist * 2;          // 風報比 1:2
  const tp2 = price + stopDist * 3;          // 風報比 1:3
  const rr = stopDist > 0 ? ((tp2 - price) / stopDist).toFixed(1) : '—';

  const rows = [
    { label: '🎯 參考進場', value: cur + fmt(entry), col: 'var(--txt)', sub: '當前價（實際可等回踩支撐）' },
    { label: '🛑 停損', value: cur + fmt(stop), col: 'var(--sell)', sub: `2×ATR，距離 ${fmt(stopDist)}（${(stopDist / price * 100).toFixed(1)}%）` },
    { label: '✅ 停利一', value: cur + fmt(tp1), col: 'var(--buy)', sub: '風報比 1:2，可先出一半' },
    { label: '✅ 停利二', value: cur + fmt(tp2), col: 'var(--buy)', sub: '風報比 1:3，剩餘續抱' },
    { label: '⚖️ 最大風報比', value: '1 : ' + rr, col: 'var(--acc)', sub: rr >= 2 ? '風報比佳，值得進場' : '風報比偏低，不急進場' }
  ];
  document.getElementById('pb-rows').innerHTML = rows.map(r =>
    `<div class="risk-box" style="margin-bottom:8px"><div class="rb-label">${r.label}</div><div class="rb-value" style="color:${r.col}">${r.value}</div><div class="rb-sub">${r.sub}</div></div>`
  ).join('');
}

/* ══ 區塊 F：風險強化（最大回撤 + 波動率排名）════════════════════════ */
function computeRiskMetrics(D) {
  const c = D.closes;
  // 最大回撤（過去一年）
  let peak = c[0], maxDD = 0;
  for (const p of c) { peak = Math.max(peak, p); maxDD = Math.min(maxDD, (p - peak) / peak); }
  // 年化波動率（日報酬標準差 × √252）
  const rets = [];
  for (let i = 1; i < c.length; i++) rets.push((c[i] - c[i - 1]) / c[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
  const annualVol = sd * Math.sqrt(252) * 100;
  // 波動率分級（台股個股年化波動率常見 20~60%）
  let volRank, volNote;
  if (annualVol > 50) { volRank = '高'; volNote = '高波動，容易被洗，停損要寬但部位要小'; }
  else if (annualVol > 30) { volRank = '中'; volNote = '中等波動，正常操作'; }
  else { volRank = '低'; volNote = '低波動，相對穩健'; }
  return { maxDD: maxDD * 100, annualVol, volRank, volNote };
}

function renderRiskMetrics(rm) {
  const card = document.getElementById('riskmetric-card');
  card.style.display = 'block';
  const boxes = [
    { cls: rm.maxDD < -30 ? '' : 'warn', label: '📉 最大回撤（近一年）', value: rm.maxDD.toFixed(1) + '%', valCls: rm.maxDD < -30 ? 'sell' : 'warn', sub: rm.maxDD < -30 ? '回撤大，風險高，留意資金控管' : '回撤可控' },
    { cls: rm.volRank === '高' ? '' : 'good', label: '📊 年化波動率', value: rm.annualVol.toFixed(0) + '%', valCls: rm.volRank === '高' ? 'sell' : 'buy', sub: `波動${rm.volRank}｜${rm.volNote}` }
  ];
  document.getElementById('rm-grid').innerHTML = boxes.map(x =>
    `<div class="risk-box ${x.cls}"><div class="rb-label">${x.label}</div><div class="rb-value ${x.valCls}">${x.value}</div><div class="rb-sub">${x.sub}</div></div>`
  ).join('');
}

/* ══ 區塊 G：個股健康度體檢報告 ══════════════════════════════════════
   把各層級結果轉成 A~F 評級，一眼看懂
   ════════════════════════════════════════════════════════════════════ */
function renderHealthReport(ctx) {
  const card = document.getElementById('health-card');
  card.style.display = 'block';
  // ctx: {trend, formulas, riskMetrics, chip, marketScore, signals}
  const grade = (score) => score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B+' : score >= 55 ? 'B' : score >= 45 ? 'C' : score >= 35 ? 'D' : 'F';
  const gcol = (g) => g.startsWith('A') ? 'var(--buy)' : g.startsWith('B') ? 'var(--acc)' : g.startsWith('C') ? 'var(--warn)' : 'var(--sell)';

  // 各維度評分
  const items = [];
  // 趨勢
  let trendScore = ctx.trend.cls === 'bull' ? 85 : ctx.trend.cls === 'bear' ? 30 : 55;
  items.push({ name: '趨勢', grade: grade(trendScore) });
  // 動能（用 formula fusion）
  let momScore = ctx.formulas ? 50 + ctx.formulas.fusion.value / 2 : 50;
  momScore = Math.max(0, Math.min(100, momScore));
  items.push({ name: '動能', grade: grade(momScore) });
  // 風險（回撤小、波動低 = 高分）
  let riskScore = 70 + ctx.riskMetrics.maxDD / 2 - (ctx.riskMetrics.annualVol - 30) / 2;
  riskScore = Math.max(0, Math.min(100, riskScore));
  items.push({ name: '風險', grade: grade(riskScore) });
  // 籌碼
  let chipScore = 50;
  if (ctx.chip) {
    if (ctx.chip.foreign5 > 0) chipScore += 15;
    if (ctx.chip.trust5 > 0) chipScore += 15;
    if (ctx.chip.foreignStreak >= 3) chipScore += 10;
    if (ctx.chip.trustStreak >= 3) chipScore += 10;
  } else chipScore = null;
  if (chipScore != null) items.push({ name: '籌碼', grade: grade(Math.min(100, chipScore)) });
  // 市場環境
  if (ctx.marketScore) items.push({ name: '市場環境', grade: grade(ctx.marketScore.score) });

  // 總評（平均）
  const scoreMap = { 'A+': 95, 'A': 80, 'B+': 70, 'B': 60, 'C': 50, 'D': 40, 'F': 25 };
  const avg = items.reduce((a, it) => a + scoreMap[it.grade], 0) / items.length;
  const total = grade(avg);

  document.getElementById('health-total').textContent = total;
  document.getElementById('health-total').style.color = gcol(total);
  document.getElementById('health-items').innerHTML = items.map(it =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;margin-bottom:6px">
      <span style="font-size:13px;color:var(--muted)">${it.name}</span>
      <span style="font-family:var(--mono);font-size:18px;font-weight:800;color:${gcol(it.grade)}">${it.grade}</span>
    </div>`
  ).join('');
}
