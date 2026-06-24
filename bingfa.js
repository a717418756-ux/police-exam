/* ══════════════════════════════════════════════════════════════════════
   bingfa.js — 中國兵法交易系統
   整合孫子兵法原則 + 現有量化模組，輸出「勢能分數 + A/B/C分級 + 交易評分」
   ──────────────────────────────────────────────────────────────────
   原則對應：
   ① 先求不敗 → 1%風險（風險管理層）
   ② 勝兵先勝 → 期望值>0（交易日誌）
   ③ 順勢而為 → MA20>MA60>MA120
   ④ 不戰而屈人之兵 → 條件不足不進場（A/B/C門檻）
   ⑤ 知足不辱 → +20%停利50%、+40%停利25%（分批）
   ⑥ 窮則變 → 30日勝率<40%警示（交易日誌）
   ⑦ 觀勢 → 勢能分數：趨勢40%+籌碼30%+量20%+產業10%
   ⑧ 分級 → 勢能 ≥80 A級、70~80 B級、60~70 C級
   依賴：app.js(sma/calcDMI/$/fmt)、advanced.js(RS)、formula.js
   ══════════════════════════════════════════════════════════════════════ */

/* ── 勢能分數（觀勢）────────────────────────────────────────────────
   趨勢40% + 籌碼30% + 成交量20% + 產業10%(用RS近似)
   各子項標準化到 0~100，加權合計
   ──────────────────────────────────────────────────────────────── */
function computeShiPower(D, rsRating) {
  const c = D.closes, v = D.volumes;
  const price = D.price;

  // ① 趨勢分（40%）：MA20>MA60>MA120 完美多頭排列給滿分
  const ma20 = sma(c, 20).slice(-1)[0];
  const ma60 = sma(c, Math.min(60, c.length-1)).slice(-1)[0];
  const ma120 = sma(c, Math.min(120, c.length-1)).slice(-1)[0];
  let trendScore = 50;
  if (price > ma20 && ma20 > ma60 && ma60 > ma120) trendScore = 100;       // 完美多頭
  else if (price > ma20 && ma20 > ma60) trendScore = 80;                    // 短中多頭
  else if (price > ma60) trendScore = 65;
  else if (price < ma20 && ma20 < ma60 && ma60 < ma120) trendScore = 10;    // 完美空頭
  else if (price < ma20 && ma20 < ma60) trendScore = 25;
  else trendScore = 45;
  // ADX 加成（趨勢強度）
  const dmi = calcDMI(D.highs, D.lows, c, 14);
  if (dmi.adx > 25 && dmi.pdi > dmi.ndi) trendScore = Math.min(100, trendScore + 10);

  // ② 籌碼分（30%）：外資/投信買賣超（台股有 chip）
  let chipScore = 50;
  if (D.chip) {
    chipScore = 50;
    if (D.chip.foreign5 > 0) chipScore += 12;
    if (D.chip.trust5 > 0) chipScore += 12;
    if (D.chip.foreignStreak >= 3) chipScore += 13;
    if (D.chip.trustStreak >= 3) chipScore += 13;
    if (D.chip.foreign5 < 0 && D.chip.trust5 < 0) chipScore = 30;
    chipScore = Math.min(100, chipScore);
  }

  // ③ 成交量分（20%）：量增價漲為佳
  let volScore = 50;
  if (v.length >= 6) {
    const vr = v[v.length-1] / (v.slice(-6,-1).reduce((a,b)=>a+b,0)/5);
    const priceUp = price > D.prevClose;
    if (priceUp && vr > 1.5) volScore = 90;         // 量增價漲
    else if (priceUp && vr > 1) volScore = 70;
    else if (!priceUp && vr > 1.5) volScore = 25;   // 量增價跌（出貨）
    else if (vr < 0.7) volScore = 45;               // 量縮
    else volScore = 55;
  }

  // ④ 產業分（10%）：用 RS 相對強弱近似（個股強弱反映產業輪動）
  let industryScore = 50;
  if (rsRating != null) industryScore = rsRating; // RS 本身就是 0~99

  // 加權合計
  const shi = Math.round(trendScore*0.4 + chipScore*0.3 + volScore*0.2 + industryScore*0.1);

  // 分級
  let grade, gradeColor, gradeDesc;
  if (shi >= 80) { grade='A'; gradeColor='var(--buy)'; gradeDesc='A級標的 — 勢能強勁，優先佈局'; }
  else if (shi >= 70) { grade='B'; gradeColor='#10B981'; gradeDesc='B級標的 — 勢能良好，可考慮'; }
  else if (shi >= 60) { grade='C'; gradeColor='var(--warn)'; gradeDesc='C級標的 — 勢能普通，謹慎'; }
  else { grade='D'; gradeColor='var(--sell)'; gradeDesc='未達標 — 不戰而屈人之兵，條件不足不進場'; }

  return {
    shi, grade, gradeColor, gradeDesc,
    breakdown: { trend: trendScore, chip: chipScore, vol: volScore, industry: industryScore },
    ma: { ma20, ma60, ma120 },
    maAligned: price > ma20 && ma20 > ma60 && ma60 > ma120
  };
}

/* ── 交易評分（綜合可行性）────────────────────────────────────────
   0.35趨勢 + 0.25籌碼 + 0.15產業 + 0.15動能 + 0.10風控
   ──────────────────────────────────────────────────────────────── */
function computeTradeScore(D, shi, formulas, riskMetrics, rsRating) {
  const trend = shi.breakdown.trend;
  const chip = shi.breakdown.chip;
  const industry = rsRating != null ? rsRating : 50;
  // 動能：用 FUSION 轉 0~100
  const momentum = formulas ? Math.max(0, Math.min(100, 50 + formulas.fusion.value/2)) : 50;
  // 風控：回撤小、波動低給高分
  let riskCtrl = 70;
  if (riskMetrics) {
    riskCtrl = 70 + riskMetrics.maxDD/2 - Math.max(0, riskMetrics.annualVol-30)/2;
    riskCtrl = Math.max(0, Math.min(100, riskCtrl));
  }
  const score = Math.round(trend*0.35 + chip*0.25 + industry*0.15 + momentum*0.15 + riskCtrl*0.10);
  return { score, parts: { trend, chip, industry, momentum, riskCtrl } };
}

/* ── 兵法停利策略（知足不辱）──────────────────────────────────────
   進場價已知時，算 +20%/+40% 的分批停利價
   ──────────────────────────────────────────────────────────────── */
function computeBingfaExit(price) {
  return {
    tp1: { price: price * 1.20, pct: 50, label: '+20% 停利 50%（知足）' },
    tp2: { price: price * 1.40, pct: 25, label: '+40% 再停利 25%（不辱）' },
    runner: { pct: 25, label: '剩 25% 續抱讓獲利奔跑' }
  };
}

/* ── 渲染兵法系統卡片 ──────────────────────────────────────────── */
function renderBingfa(D, shi, tradeScore, exit) {
  const card = document.getElementById('bingfa-card');
  card.style.display = 'block';

  // 大分級顯示
  document.getElementById('bf-grade').textContent = shi.grade;
  document.getElementById('bf-grade').style.color = shi.gradeColor;
  document.getElementById('bf-shi').textContent = shi.shi;
  document.getElementById('bf-shi').style.color = shi.gradeColor;
  document.getElementById('bf-desc').textContent = shi.gradeDesc;

  // 勢能分解（4因子進度條）
  const bar = (label, val, weight, col) =>
    `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
        <span style="color:var(--muted)">${label}<span style="color:var(--muted2)">（權重${weight}）</span></span>
        <span style="font-family:var(--mono);color:${col}">${Math.round(val)}</span>
      </div>
      <div style="height:6px;background:var(--bd);border-radius:99px;overflow:hidden"><div style="height:100%;width:${val}%;background:${col}"></div></div>
    </div>`;
  document.getElementById('bf-breakdown').innerHTML =
    bar('趨勢（順勢而為）', shi.breakdown.trend, '40%', 'var(--acc)') +
    bar('籌碼（觀勢）', shi.breakdown.chip, '30%', '#0EA5E9') +
    bar('成交量', shi.breakdown.vol, '20%', '#8B5CF6') +
    bar('產業強弱（RS近似）', shi.breakdown.industry, '10%', '#F59E0B');

  // MA 排列狀態（順勢而為）
  const maOk = shi.maAligned;
  document.getElementById('bf-ma').innerHTML =
    `<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:${maOk?'var(--buy-d)':'var(--warn-d)'};border-radius:8px">
      <span style="font-size:16px">${maOk?'✅':'⚠️'}</span>
      <span style="font-size:12px;color:${maOk?'var(--buy)':'var(--warn)'}">${maOk?'MA20 > MA60 > MA120 完美多頭排列，順勢可為':'均線未完美多頭排列，順勢條件未滿足'}</span>
    </div>`;

  // 交易評分
  document.getElementById('bf-tradescore').textContent = tradeScore.score;
  const ts = tradeScore.parts;
  document.getElementById('bf-tradeparts').textContent =
    `趨勢${ts.trend} · 籌碼${ts.chip} · 產業${ts.industry} · 動能${ts.momentum} · 風控${ts.riskCtrl}`;

  // 兵法停利策略
  document.getElementById('bf-exit').innerHTML =
    `<div style="font-size:11px;color:var(--purple);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">知足不辱 — 分批停利</div>
    <div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--buy-d);border-radius:6px;margin-bottom:4px"><span style="font-size:11px">${exit.tp1.label}</span><span style="font-family:var(--mono);font-size:12px;color:var(--buy)">${fmt(exit.tp1.price)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--buy-d);border-radius:6px;margin-bottom:4px"><span style="font-size:11px">${exit.tp2.label}</span><span style="font-family:var(--mono);font-size:12px;color:var(--buy)">${fmt(exit.tp2.price)}</span></div>
    <div style="font-size:10px;color:var(--muted);padding:4px 10px">${exit.runner.label}</div>`;
}

/* ── 窮則變：交易日誌30日勝率警示 ──────────────────────────────── */
async function checkBingfaWarning() {
  try {
    if (typeof dbGetAllTrades !== 'function') return;
    const trades = await dbGetAllTrades();
    const now = Date.now();
    const recent = trades.filter(t => {
      const d = new Date(t.exitDate || t.date).getTime();
      return now - d <= 30 * 86400000;
    });
    if (recent.length >= 5) {
      const wins = recent.filter(t => t.result === 'win' && t.judgment !== 'wrong').length;
      const wr = wins / recent.length;
      const box = document.getElementById('bf-warning');
      if (wr < 0.4) {
        box.style.display = 'block';
        box.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--sell-d);border:1px solid var(--sell);border-radius:10px">
          <span style="font-size:20px">⚠️</span>
          <div><div style="font-size:12px;font-weight:700;color:var(--sell)">窮則變 — 策略警示</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">近30日真實勝率 ${(wr*100).toFixed(0)}%（${recent.length}筆），低於 40% 門檻。孫子曰「窮則變」，建議檢討策略、降低部位或暫停交易。</div></div>
        </div>`;
      } else {
        box.style.display = 'none';
      }
    }
  } catch (e) { /* 略過 */ }
}
