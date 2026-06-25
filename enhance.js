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

/* ══ 區塊 H：ADX 市場狀態過濾器 ════════════════════════════════════════
   機構73%使用：ADX 不告訴方向，而是告訴你「該用哪種策略」
   ADX>25 趨勢明確→用趨勢指標；ADX<20 盤整→用震盪指標或觀望
   ════════════════════════════════════════════════════════════════════ */
function computeRegime(D) {
  // 複用 app.js 的 DMI 計算（已存在 calcDMI）
  const dmi = calcDMI(D.highs, D.lows, D.closes, 14);
  let regime, advice, cls, icon;
  if (dmi.adx >= 25) {
    regime = '趨勢盤';
    icon = '📈';
    cls = dmi.pdi > dmi.ndi ? 'bull' : 'bear';
    advice = `ADX ${dmi.adx.toFixed(0)} 趨勢明確（${dmi.pdi > dmi.ndi ? '多方' : '空方'}主導）→ 適合「順勢策略」：跟均線、突破、MACD。此時 RSI 超買超賣易失效（強勢可一直超買）。`;
  } else if (dmi.adx < 20) {
    regime = '盤整盤';
    icon = '🔄';
    cls = 'neutral';
    advice = `ADX ${dmi.adx.toFixed(0)} 無明顯趨勢 → 適合「震盪策略」：RSI/KD 超買超賣來回操作，或乾脆觀望。此時追突破易被巴。`;
  } else {
    regime = '過渡帶';
    icon = '⚖️';
    cls = 'neutral';
    advice = `ADX ${dmi.adx.toFixed(0)} 介於 20~25，趨勢醞釀中。建議減少部位，等方向明確再加碼。`;
  }
  return { adx: dmi.adx, pdi: dmi.pdi, ndi: dmi.ndi, regime, advice, cls, icon };
}

function renderRegime(r) {
  const card = document.getElementById('regime-card');
  card.style.display = 'block';
  const col = r.cls === 'bull' ? 'var(--buy)' : r.cls === 'bear' ? 'var(--sell)' : 'var(--warn)';
  document.getElementById('regime-icon').textContent = r.icon;
  document.getElementById('regime-name').textContent = r.regime;
  document.getElementById('regime-name').style.color = col;
  document.getElementById('regime-advice').textContent = r.advice;
}

function computeChipHealth(chip, D) {
  let score = 50;
  const signals = [], warnings = [];

  if (chip.foreign5 > 0) {
    score += 12;
    if (chip.foreignStreak >= 3) { score += 8; signals.push(`外資連買 ${chip.foreignStreak} 天，資金持續流入`); }
    else signals.push('外資近5日站買方');
  } else if (chip.foreign5 < 0) { score -= 12; warnings.push('外資近5日賣超，最大資金撤離，留意賣壓'); }

  if (chip.trust5 > 0) {
    score += 10;
    if (chip.trustStreak >= 3) { score += 12; signals.push(`投信連買 ${chip.trustStreak} 天（投信認養，飆股常見型態）`); }
    else signals.push('投信近5日站買方');
  } else if (chip.trust5 < 0) { score -= 8; warnings.push('投信賣超，留意作帳行情結束'); }

  if (chip.foreign5 > 0 && chip.trust5 > 0) { score += 8; signals.push('外資投信同步買超，法人有共識（強訊號）'); }
  if (chip.foreign5 < 0 && chip.trust5 < 0) { score -= 10; warnings.push('外資投信同步賣超，法人一致看淡'); }

  const avg5 = chip.foreign5 / 5 + chip.trust5 / 5;
  const avg20 = chip.foreign20 / 20 + chip.trust20 / 20;
  let concentration = null;
  if (chip.foreign20 !== 0 || chip.trust20 !== 0) {
    if (avg5 > avg20 && avg5 > 0) { concentration = 'rising'; score += 8; signals.push('近期買超力道增強（5日>20日），主力積極吸籌'); }
    else if (avg5 < avg20 && avg5 < 0) { concentration = 'falling'; score -= 8; warnings.push('近期賣超力道增強，籌碼鬆動'); }
    else concentration = 'stable';
  }

  // 成交量量能（籌碼換手的直接證據）
  let volNote = null;
  if (D && D.volumes && D.volumes.length >= 6) {
    const vr = D.volumes[D.volumes.length-1] / (D.volumes.slice(-6,-1).reduce((a,b)=>a+b,0)/5);
    const priceUp = D.price > D.prevClose;
    if (priceUp && vr > 1.5) { score += 6; signals.push(`量增價漲（${vr.toFixed(1)}倍量），資金進場推升，量價齊揚`); volNote='healthy'; }
    else if (!priceUp && vr > 1.5) { score -= 8; warnings.push(`量增價跌（${vr.toFixed(1)}倍量），疑似主力出貨換手`); volNote='distribution'; }
    else if (vr < 0.5) { warnings.push('窒息量，成交極度萎縮，多空觀望，留意變盤'); volNote='dead'; }
    else if (priceUp && vr < 0.8) { warnings.push('量縮價漲，買盤接手意願低，動能不足'); volNote='weak'; }
  }

  score = Math.max(0, Math.min(100, score));
  let verdict, vClass;
  if (score >= 75) { verdict = '籌碼集中、主力進駐，賣壓輕、易漲難跌'; vClass = 'buy'; }
  else if (score >= 60) { verdict = '籌碼偏多，法人站買方，可留意'; vClass = 'buy'; }
  else if (score >= 45) { verdict = '籌碼中性，法人態度不明，觀望'; vClass = 'warn'; }
  else if (score >= 30) { verdict = '籌碼偏空，法人站賣方，謹慎'; vClass = 'sell'; }
  else { verdict = '籌碼鬆散、主力撤離，易跌難漲，避開'; vClass = 'sell'; }
  return { score, verdict, vClass, signals, warnings, concentration, volNote };
}

function renderChip(chip, D) {
  const card = document.getElementById('chip-card');
  if (!chip) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const health = computeChipHealth(chip, D);
  const fmtLot = n => (n >= 0 ? '+' : '') + fmtV(n) + ' 張';
  const colMap = { buy: 'var(--buy)', warn: 'var(--warn)', sell: 'var(--sell)' };

  let html = `<div style="text-align:center;padding:14px;background:var(--bg);border:1px solid var(--bd);border-radius:12px;margin-bottom:14px">
    <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">籌碼健康度</div>
    <div style="font-family:var(--mono);font-size:34px;font-weight:800;color:${colMap[health.vClass]};line-height:1">${health.score}</div>
    <div style="font-size:13px;font-weight:700;color:${colMap[health.vClass]};margin-top:6px">${health.verdict}</div>
  </div>`;

  const chipBox = (label, d5, d1, d20, streak, bullDesc, bearDesc) => {
    const bull = d5 > 0;
    return `<div class="risk-box ${bull ? 'good' : ''}">
      <div class="rb-label">${label}</div>
      <div class="rb-value ${bull ? 'buy' : 'sell'}">${fmtLot(d5)}<span style="font-size:10px;color:var(--muted)"> 近5日</span></div>
      <div class="rb-sub">單日 ${fmtLot(d1)}｜20日 ${fmtLot(d20)}${streak >= 2 ? `｜🔥連買${streak}天` : ''}</div>
      <div style="font-size:11px;color:${bull ? 'var(--buy)' : 'var(--sell)'};margin-top:6px;line-height:1.5">${bull ? bullDesc : bearDesc}</div>
    </div>`;
  };
  html += '<div class="risk-grid">';
  html += chipBox('🌎 外資（資金最大）', chip.foreign5, chip.foreign1, chip.foreign20, chip.foreignStreak,
    '👉 外資買超，最大資金進場，權值股有撐', '👉 外資賣超，留意大盤連動與賣壓');
  html += chipBox('🏦 投信（飆股推手）', chip.trust5, chip.trust1, chip.trust20, chip.trustStreak,
    '👉 投信買超，常認養中小型飆股，可留意', '👉 投信賣超，作帳行情或轉弱');
  html += '</div>';

  if (health.concentration) {
    const concMap = {
      rising: { t: '📈 籌碼趨向集中', d: '近5日買超力道 > 20日平均，主力積極吸籌（類似5日均線>20日線），股價較易上漲', c: 'var(--buy)' },
      falling: { t: '📉 籌碼趨向分散', d: '近5日賣壓 > 20日平均，主力可能出貨給散戶，籌碼鬆動需警覺', c: 'var(--sell)' },
      stable: { t: '➖ 籌碼變化平穩', d: '近期買賣力道與中期相當，無明顯集中或分散', c: 'var(--muted)' }
    };
    const cc = concMap[health.concentration];
    html += `<div style="margin-top:12px;padding:12px;background:var(--bg);border:1px solid var(--bd);border-radius:10px">
      <div style="font-size:12px;font-weight:700;color:${cc.c};margin-bottom:4px">${cc.t}</div>
      <div style="font-size:11px;color:var(--muted);line-height:1.6">${cc.d}</div></div>`;
  }

  // 量能狀態（成交量是籌碼換手的直接證據）
  if (health.volNote) {
    const volMap = {
      healthy: { t: '🔊 量增價漲', d: '成交量放大且股價上漲，資金實質進場推升，量價齊揚為健康攻擊', c: 'var(--buy)' },
      distribution: { t: '⚠️ 量增價跌', d: '爆量但股價下跌，疑似主力趁高出貨換手給散戶，籌碼面警訊', c: 'var(--sell)' },
      dead: { t: '😴 窒息量', d: '成交量極度萎縮，多空雙方觀望，常為變盤前兆，留意次日方向', c: 'var(--warn)' },
      weak: { t: '🔇 量縮價漲', d: '股價漲但量能不足，買盤接手意願低，上攻動能存疑，留意假突破', c: 'var(--warn)' }
    };
    const vc = volMap[health.volNote];
    html += `<div style="margin-top:10px;padding:12px;background:var(--bg);border:1px solid var(--bd);border-radius:10px">
      <div style="font-size:12px;font-weight:700;color:${vc.c};margin-bottom:4px">${vc.t}</div>
      <div style="font-size:11px;color:var(--muted);line-height:1.6">${vc.d}</div></div>`;
  }

  if (health.signals.length || health.warnings.length) {
    html += '<div style="margin-top:12px">';
    health.signals.forEach(s => { html += `<div style="display:flex;gap:8px;align-items:flex-start;padding:5px 0"><span style="color:var(--buy)">✓</span><span style="font-size:11px;color:var(--muted);line-height:1.5">${s}</span></div>`; });
    health.warnings.forEach(w => { html += `<div style="display:flex;gap:8px;align-items:flex-start;padding:5px 0"><span style="color:var(--sell)">⚠</span><span style="font-size:11px;color:var(--muted);line-height:1.5">${w}</span></div>`; });
    html += '</div>';
  }

  html += `<div style="margin-top:12px;padding:10px 12px;background:#F59E0B0a;border:1px solid #F59E0B30;border-radius:8px">
    <div style="font-size:10px;color:var(--warn);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">⚠️ 籌碼判讀陷阱（務必交叉驗證）</div>
    <div style="font-size:10px;color:var(--muted);line-height:1.7">• 法人買超 ≠ 必漲（可能避險佈局）<br>• 主力連買 ≠ 沒風險（可能誘多吸籌）<br>• 籌碼與技術背離時（主力買但K線破底）要警覺<br>• 籌碼為盤後資料，散戶成本恐落後大戶</div>
  </div>`;

  document.getElementById('chip-grid').innerHTML = html;
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
