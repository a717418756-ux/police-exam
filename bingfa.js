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

  // ② 籌碼分（30%）：外資/投信買賣超（台股有 chip），複用籌碼健康度
  let chipScore = 50;
  if (D.chip && typeof computeChipHealth === 'function') {
    chipScore = computeChipHealth(D.chip, D).score; // 統一用籌碼健康度評分
  } else if (D.chip) {
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

  // 分級（多空雙向：勢能極弱 = 空方強標的）
  const shortShi = 100 - shi;  // 空方勢能（趨勢/籌碼/量能分數皆有方向性，反轉即空方強度）
  let grade, gradeColor, gradeDesc, shortGrade = null;
  if (shi >= 80) { grade='A'; gradeColor='var(--buy)'; gradeDesc='多方A級 — 勢能強勁，做多優先佈局'; }
  else if (shi >= 70) { grade='B'; gradeColor='#10B981'; gradeDesc='多方B級 — 勢能良好，做多可考慮'; }
  else if (shi >= 60) { grade='C'; gradeColor='var(--warn)'; gradeDesc='多方C級 — 勢能普通，謹慎'; }
  else if (shortShi >= 80) { grade='空A'; shortGrade='A'; gradeColor='var(--sell)'; gradeDesc='空方A級 — 勢能極弱（趨勢/籌碼/量能同弱），做空優先標的'; }
  else if (shortShi >= 70) { grade='空B'; shortGrade='B'; gradeColor='#F87171'; gradeDesc='空方B級 — 勢能偏弱，做空可考慮'; }
  else { grade='D'; gradeColor='var(--muted)'; gradeDesc='多空皆不足 — 不戰而屈人之兵，觀望'; }

  return {
    shi, shortShi, grade, shortGrade, gradeColor, gradeDesc,
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
    long: {
      tp1: { price: price * 1.20, pct: 50, label: '+20% 停利 50%（知足）' },
      tp2: { price: price * 1.40, pct: 25, label: '+40% 再停利 25%（不辱）' }
    },
    short: {
      tp1: { price: price * 0.80, pct: 50, label: '+20% 停利 50%（價跌20%）' },
      tp2: { price: price * 0.60, pct: 25, label: '+40% 再停利 25%（價跌40%）' }
    },
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

  // 兵法停利策略（多空雙向：做多在上漲側、做空在下跌側）
  const exitRow=(label,price,col)=>`<div style="display:flex;justify-content:space-between;padding:5px 10px;background:${col}15;border-radius:6px;margin-bottom:3px"><span style="font-size:11px">${label}</span><span style="font-family:var(--mono);font-size:12px;color:${col}">${fmt(price)}</span></div>`;
  document.getElementById('bf-exit').innerHTML =
    `<div style="font-size:11px;color:var(--purple);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">知足不辱 — 分批停利（依你的方向看對應側）</div>
    <div style="font-size:10px;color:var(--buy);margin-bottom:4px">📈 做多側</div>
    ${exitRow(exit.long.tp1.label, exit.long.tp1.price, 'var(--buy)')}
    ${exitRow(exit.long.tp2.label, exit.long.tp2.price, 'var(--buy)')}
    <div style="font-size:10px;color:var(--sell);margin:8px 0 4px">📉 做空側</div>
    ${exitRow(exit.short.tp1.label, exit.short.tp1.price, 'var(--sell)')}
    ${exitRow(exit.short.tp2.label, exit.short.tp2.price, 'var(--sell)')}
    <div style="font-size:10px;color:var(--muted);padding:4px 10px">${exit.runner.label}</div>`;
}

/* ── 綜合決策橫幅（整合兵法分級+健康度+崩跌風險，一句話結論）──────── */
function renderVerdictBanner(shi, tradeScore, formulas, marketScore, res) {
  const banner = document.getElementById('verdict-banner');
  const inner = document.getElementById('vb-inner');
  if (!banner || !inner) return;
  banner.style.display = 'block';

  const grade = shi.grade;
  const crash = formulas && formulas.crash ? formulas.crash.score : 0;
  const fusion = formulas && formulas.fusion ? formulas.fusion.value : 0;

  // 決定主色與結論
  let color, bg, title, summary;
  if (crash >= 60) {
    color = 'var(--sell)'; bg = 'var(--sell-d)';
    title = '🚨 崩跌預警，建議避開';
    summary = `崩跌風險分 ${crash}/100，即使其他指標尚可，風險優先原則下不宜進場`;
  } else if (grade === 'A' && fusion > 20) {
    color = 'var(--buy)'; bg = 'var(--buy-d)';
    title = '🟢 A級標的，多方共振，可優先佈局';
    summary = `勢能 ${shi.shi}分、交易評分 ${tradeScore.score}、FUSION +${fusion}，順勢可為。記得設好停損與分批停利`;
  } else if (grade === 'A' || grade === 'B') {
    color = '#10B981'; bg = 'var(--buy-d)';
    title = `🟢 ${grade}級標的，條件良好`;
    summary = `勢能 ${shi.shi}分、交易評分 ${tradeScore.score}。趨勢與籌碼面尚可，留意進場時機與風控`;
  } else if (grade === 'C') {
    color = 'var(--warn)'; bg = 'var(--warn-d)';
    title = '🟡 C級標的，勢能普通，謹慎';
    summary = `勢能 ${shi.shi}分。條件中等，不急進場，等更明確訊號或更好價位`;
  } else if (shi.shortGrade === 'A' || shi.shortGrade === 'B') {
    color = 'var(--sell)'; bg = 'var(--sell-d)';
    title = `🔻 空方${shi.shortGrade}級標的，弱勢明確`;
    const psyWarn = (formulas && formulas.psy && formulas.psy.value <= 25)
      ? '。⚠️ 但 PSY 已入恐慌區，空單留意短線反彈（恐慌常有技術性反彈）' : '';
    summary = `空方勢能 ${shi.shortShi}分（趨勢/籌碼/量能同弱），偏空操作可考慮。做空嚴守停損${psyWarn}`;
  } else {
    color = 'var(--muted)'; bg = 'var(--bg)';
    title = '⚪ 多空皆不足，不戰而屈人之兵';
    summary = `多方勢能 ${shi.shi}、空方勢能 ${shi.shortShi}，皆未達70。條件不足不進場，多看少做`;
  }

  inner.style.borderColor = color;
  inner.style.background = bg;
  document.getElementById('vb-grade').textContent = grade;
  document.getElementById('vb-grade').style.color = color;
  document.getElementById('vb-title').textContent = title;
  document.getElementById('vb-title').style.color = color;
  document.getElementById('vb-summary').textContent = summary;

  // 關鍵指標小標籤
  const chip = (label, val, c) => `<div style="background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:5px 10px;font-size:11px"><span style="color:var(--muted)">${label}</span> <span style="font-family:var(--mono);font-weight:700;color:${c}">${val}</span></div>`;
  // 信心指數 = 共振共識度絕對值；維度分歧時在結論加註降信心
  const confidence = res ? Math.abs(res.consensus) : null;
  if (res && res.strength === 'weak') {
    document.getElementById('vb-summary').textContent += '。⚠️ 各維度目前分歧，信心指數低，不強行給方向——觀望也是操作';
  }
  const mkt = marketScore ? marketScore.score : null;
  document.getElementById('vb-metrics').innerHTML =
    chip('勢能', shi.shi, color) +
    chip('交易評分', tradeScore.score, 'var(--acc)') +
    chip('FUSION', (fusion>=0?'+':'')+fusion, fusion>=0?'var(--buy)':'var(--sell)') +
    chip('崩跌風險', crash, crash>=35?'var(--sell)':'var(--muted)') +
    (mkt!=null ? chip('大盤', mkt, mkt>=55?'var(--buy)':mkt<=45?'var(--sell)':'var(--warn)') : '') +
    (confidence!=null ? chip('信心', confidence, confidence>=60?'var(--buy)':confidence>=30?'var(--warn)':'var(--sell)') : '');
}
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

/* ══ 出手紀律門（Pre-Trade Gate）═════════════════════════════════════
   專業機構和散戶的最大差別：機構有「一關不過就不出手」的檢查清單。
   把全站分析濃縮成多/空兩個裁決：🟢出手 / 🟡謹慎 / 🔴禁止 + 犯規清單。
   反其道核心：散戶看到訊號就進場；獵人等散戶停損被掃完才進場。
   ════════════════════════════════════════════════════════════════════ */
function computeTradeGate(ctx) {
  // ctx: { D, regime, mtf, res, formulas, shi }
  const { D, regime, mtf, res, formulas } = ctx;
  const fusion = formulas && formulas.fusion ? formulas.fusion.value : 0;
  const psy = formulas && formulas.psy ? formulas.psy.value : 50;
  const margin = (typeof _marginCache !== 'undefined' && _marginCache[D.code]) ? _marginCache[D.code].d : null;
  const fund = (typeof _fundCache !== 'undefined' && _fundCache[D.code]) ? _fundCache[D.code].d : null;
  let crowd = null;
  try { if (typeof computeCrowding === 'function') crowd = computeCrowding(D, formulas); } catch (e) {}
  let mf = null;
  try { if (typeof computeMainForce === 'function') mf = computeMainForce(D, formulas); } catch (e) {}

  const judge = (dir) => { // dir: 1=多, -1=空
    const pass = [], fail = [], warn = [];
    // R1 市場環境（總開關）
    if (regime) {
      if (regime.regime === '高波動危險') fail.push('高波動危險態：保本金優先，此狀態禁止進場');
      else if (regime.regime === '盤整') warn.push('盤整態：波段勝率低，僅限區間短打、小部位');
      else if ((regime.regime === '多頭趨勢' && dir === 1) || (regime.regime === '空頭趨勢' && dir === -1)) pass.push(`環境順風（${regime.regime}）`);
      else if (regime.regime === '多頭趨勢' || regime.regime === '空頭趨勢') fail.push(`環境逆風（${regime.regime}）：逆環境操作是散戶最常見的死法`);
    }
    // R2 大週期 MTF
    if (mtf) {
      if (mtf.dir === dir) pass.push('週期MTF同向（大週期順風）');
      else if (mtf.dir === -dir) fail.push('週期MTF反向：逆大週期只是搶反彈，不是波段');
      else warn.push('MTF框架衝突：大小週期不一致，勝率打折');
    }
    // R3 多維共振
    if (res) {
      const c = res.consensus;
      if ((dir === 1 && c >= 25) || (dir === -1 && c <= -25)) pass.push(`共振同向（共識度 ${c}）`);
      else if ((dir === 1 && c <= -25) || (dir === -1 && c >= 25)) fail.push(`共振反向（共識度 ${c}）：多數維度不站你這邊`);
      else warn.push('共振中性：維度分歧，等更明確');
    }
    // R4 順公式（你的實戰數據教訓）
    if ((dir === 1 && fusion >= 20) || (dir === -1 && fusion <= -20)) pass.push(`順公式（FUSION ${fusion >= 0 ? '+' : ''}${fusion}）`);
    else if ((dir === 1 && fusion <= -20) || (dir === -1 && fusion >= 20)) fail.push(`逆公式（FUSION ${fusion >= 0 ? '+' : ''}${fusion}）：你的實戰統計顯示逆公式進場 MAE 深 2~4 倍`);
    else warn.push('公式中性：FUSION 未同向確認');
    // R5 反明牌（別站人多的一邊）
    if (crowd) {
      if (crowd.trap && ((crowd.trap.type === 'bull' && dir === 1) || (crowd.trap.type === 'bear' && dir === -1))) fail.push('明牌陷阱警報：教科書訊號與你同向但主力反向，你正要跟散戶擠同一邊');
      else if (crowd.crowdDir === dir && crowd.crowding >= 70) fail.push(`明牌極度擁擠（${crowd.crowding}）：這個結論所有AI散戶都看到了`);
      else if (crowd.crowdDir === dir && crowd.crowding >= 50) warn.push(`明牌偏擁擠（${crowd.crowding}）：預期先掃停損再走，進場點要選在掃盪後`);
      else pass.push('非擁擠明牌（人少的一邊，訊號含金量高）');
    }
    // R6 方向限定風險
    if (dir === -1) {
      if (margin && margin.shortRatio >= 30) fail.push(`券資比 ${margin.shortRatio.toFixed(0)}%：空單擁擠，軋空風險高`);
      else if (margin && margin.shortRatio >= 20) warn.push(`券資比 ${margin.shortRatio.toFixed(0)}% 偏高，空單控制部位`);
      if (psy <= 25) warn.push(`PSY ${psy} 恐慌區：空單防技術性反彈（你 2313 的教訓）`);
    } else {
      if (margin && margin.marginChg5 > 4 && D.closes.length >= 6 && D.price < D.closes[D.closes.length - 6]) fail.push('融資增+價跌（散戶接刀象限）：別跟散戶一起接');
      if (psy >= 80) warn.push(`PSY ${psy} 貪婪區：多單防均值回歸`);
    }

    // R7 大戶與法人（配合聰明錢，絕不對作——資料未載入時自動略過）
    if (mf && mf.confidence >= 50) {
      if (dir === 1 && (mf.behavior === '出貨' || mf.behavior === '誘多')) fail.push(`主力行為=${mf.behavior}（信心${mf.confidence}）：做多是接主力的貨`);
      if (dir === -1 && mf.behavior === '吸籌') fail.push(`主力吸籌中（信心${mf.confidence}）：你在空主力正在收的貨，逆大戶做空是散戶死法`);
      if (dir === -1 && (mf.behavior === '誘空' || mf.behavior === '洗盤')) warn.push(`${mf.behavior}型態進行中：空單易被掃後軋`);
      if (dir === 1 && mf.behavior === '吸籌') pass.push(`主力吸籌同向（信心${mf.confidence}）`);
      if (dir === -1 && mf.behavior === '出貨') pass.push(`主力出貨同向（空單與主力同邊，信心${mf.confidence}）`);
    }
    const deep = (typeof _deepCache !== 'undefined' && _deepCache[D.code]) ? _deepCache[D.code].d : null;
    if (deep && deep.big) {
      const b = deep.big;
      if (dir === -1 && b.bigChg > 0.3 && b.smallChg < -0.2) fail.push(`千張大戶吸籌中（+${b.bigChg}%）：逆大戶結構做空`);
      if (dir === 1 && b.bigChg < -0.3 && b.smallChg > 0.2) fail.push(`大戶倒貨給散戶（${b.bigChg}%）：別當接貨的散戶`);
      if (dir === -1 && b.bigChg < -0.3 && b.smallChg > 0.2) pass.push(`大戶倒貨結構（空單結構順風）`);
      if (dir === 1 && b.bigChg > 0.3 && b.smallChg < -0.2) pass.push(`籌碼流向大戶（多單結構順風）`);
    }
    if (deep && deep.lend) {
      if (dir === -1 && deep.lend.chg5 >= 8) pass.push(`法人借券空單增 +${deep.lend.chg5}%（機構隊友）`);
      if (dir === -1 && deep.lend.chg5 <= -8) warn.push(`法人借券回補中（${deep.lend.chg5}%）：空方主力撤退，別戀戰`);
    }

    // R8 基本面背景濾網（僅輔助降級/加分，不否決——基本面本質是波段的背景濾網非進出場訊號，
    // 資料未載入或無營收資料時自動略過，避免對缺資料的股票誤判）
    // 門檻與 loadFundamentalCard() 卡片顯示邏輯一致（revYoY ≤-10%/≥20%），確保兩處判讀不互相矛盾
    if (fund && fund.revYoY != null) {
      if (dir === 1 && fund.revYoY <= -10) warn.push(`營收年減 ${fund.revYoY.toFixed(1)}%：基本面逆風，非致命但反彈力道可能受限`);
      else if (dir === -1 && fund.revYoY >= 20) warn.push(`營收年增 +${fund.revYoY.toFixed(1)}%：逆基本面做空，技術轉空也要快進快出`);
      else if (dir === 1 && fund.revYoY >= 20) pass.push(`營收年增 +${fund.revYoY.toFixed(1)}%：基本面順風`);
      else if (dir === -1 && fund.revYoY <= -10) pass.push(`營收年減 ${fund.revYoY.toFixed(1)}%：基本面順風（空方）`);
    }

    // R9 樣本外訊號可信度（僅輔助降級/加分，不否決——這是「這檔股票的技術訊號歷史上準不準」的
    // 事後校驗，不是當下的多空證據，用來提醒你該多信還是少信 R3/R4 的技術面結論；
    // 樣本數<20時該模組自己都標「無法下結論」，此處沿用同一門檻，樣本不足直接略過不評論）
    if (ctx.oos && ctx.oos.test && ctx.oos.test.n >= 20) {
      const tr = ctx.oos.test.rate;
      if (tr < 0.45) warn.push(`此股樣本外測試訊號偏反指標（命中率${Math.round(tr*100)}%）：技術面可信度低，改倚重籌碼/主力維度`);
      else if (tr < 0.55) warn.push(`此股樣本外測試近似擲硬幣（命中率${Math.round(tr*100)}%）：技術訊號參考價值低`);
      else if (tr >= 0.55 && ctx.oos.drop <= 10) pass.push(`此股樣本外驗證有效（命中率${Math.round(tr*100)}%，訓練/測試差距小）：技術訊號歷史上真有預測力`);
    }

    // 裁決：任一 fail = 禁止；warn≥2 = 謹慎；pass≥3 且 warn≤1 = 出手
    let verdict, vClass;
    if (fail.length) { verdict = '禁止出手'; vClass = 'no'; }
    else if (pass.length >= 3 && warn.length <= 1) { verdict = '可出手'; vClass = 'go'; }
    else { verdict = '謹慎／等待'; vClass = 'caution'; }
    return { verdict, vClass, pass, fail, warn };
  };

  // 進場時機（反其道核心：等掃盪，不追訊號）
  let timing = null;
  if (mf) {
    if (mf.behavior === '洗盤') timing = { good: true, text: '🎯 剛出現掃停損洗盤——散戶停損被收割完的位置正是主力進貨完成點。順大方向者，此刻進場優於追價（你買在散戶的血上，而不是把血獻出去）' };
    else if (mf.behavior === '誘多') timing = { good: false, text: '🪤 誘多型態進行中——突破未帶量，追高=進主力的口袋，等回測確認' };
    else if (mf.behavior === '恐慌殺盤') timing = { good: false, text: '⏳ 恐慌殺盤中——刀還在落，接刀與追空都危險，等止穩訊號' };
  }
  return { long: judge(1), short: judge(-1), timing };
}

function _gateATR(D) {
  const h = D.highs, l = D.lows, c = D.closes, n = c.length;
  const m = Math.min(14, n - 1);
  let s = 0;
  for (let i = n - m; i < n; i++) s += Math.max(h[i] - l[i], Math.abs(h[i] - c[i-1]), Math.abs(l[i] - c[i-1]));
  return s / m;
}

function renderTradeGate(ctx) {
  const card = document.getElementById('gate-card');
  if (!card) return;
  card.style.display = 'block';
  const g = computeTradeGate(ctx);

  const colMap = { go: 'var(--buy)', caution: 'var(--warn)', no: 'var(--sell)' };
  const iconMap = { go: '🟢', caution: '🟡', no: '🔴' };
  const side = (label, r) => {
    const col = colMap[r.vClass];
    let h = `<div style="flex:1;min-width:0;border:1px solid ${col}50;border-radius:10px;padding:10px;background:${col}0a">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:12px;font-weight:700">${label}</span>
        <span style="font-size:12px;font-weight:800;color:${col}">${iconMap[r.vClass]} ${r.verdict}</span>
      </div>`;
    r.fail.forEach(x => h += `<div style="font-size:10px;color:var(--sell);line-height:1.5;padding:2px 0">✗ ${x}</div>`);
    r.warn.forEach(x => h += `<div style="font-size:10px;color:var(--warn);line-height:1.5;padding:2px 0">⚠ ${x}</div>`);
    r.pass.forEach(x => h += `<div style="font-size:10px;color:var(--buy);line-height:1.5;padding:2px 0">✓ ${x}</div>`);
    return h + '</div>';
  };

  let html = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">${side('📈 做多', g.long)}${side('📉 做空', g.short)}</div>`;
  if (g.timing) {
    const tc = g.timing.good ? 'var(--buy)' : 'var(--warn)';
    html += `<div style="padding:10px 12px;background:${tc}10;border:1px solid ${tc}50;border-radius:9px;font-size:11px;color:var(--muted);line-height:1.7;margin-bottom:10px">${g.timing.text}</div>`;
  }
  // ── 🎯 執行計畫（化繁為簡：做哪邊/幾張/停損/停利/時間停損）──
  try {
    const D = ctx.D;
    let planSide = null, half = false;
    if (g.long.vClass === 'go') planSide = 'long';
    else if (g.short.vClass === 'go') planSide = 'short';
    else if (g.long.vClass === 'caution' && g.short.vClass === 'no') { planSide = 'long'; half = true; }
    else if (g.short.vClass === 'caution' && g.long.vClass === 'no') { planSide = 'short'; half = true; }

    if (!planSide) {
      html += `<div style="padding:12px;text-align:center;background:var(--bg);border:1px dashed var(--bd);border-radius:10px;margin-bottom:10px;font-size:13px;font-weight:700;color:var(--muted)">⛔ 今日此標的無戰事<div style="font-size:11px;font-weight:400;color:var(--muted2);margin-top:3px">不出手，就是最精準的打擊</div></div>`;
    } else {
      const capital = parseFloat(document.getElementById('in-capital')?.value) || 1000000;
      const riskPct = parseFloat(document.getElementById('in-risk')?.value) || 1;
      const atr = _gateATR(D);
      let smart = null;
      try { if (typeof computeSmartStop === 'function') smart = computeSmartStop(D, atr); } catch (e) {}
      const entry = D.rawCloses ? D.rawCloses[D.rawCloses.length - 1] : D.price;
      const stop = smart ? smart[planSide].stop : (planSide === 'long' ? entry - 2 * atr : entry + 2 * atr);
      const dist = Math.abs(entry - stop);
      const sgn = planSide === 'long' ? 1 : -1;
      const tp1 = entry + sgn * 2 * dist, tp2 = entry + sgn * 3 * dist;
      let riskAmt = capital * riskPct / 100;
      if (half) riskAmt = riskAmt / 2;
      const cur = D.currency === 'TWD' ? '' : '$';
      let sizeTxt;
      if (D.currency === 'TWD') {
        const lots = dist > 0 ? Math.floor(riskAmt / (dist * 1000)) : 0;
        sizeTxt = lots >= 1 ? lots + ' 張' : '不足1張（風險額太小或停損太遠）';
      } else {
        const sh = dist > 0 ? Math.floor(riskAmt / dist) : 0;
        sizeTxt = sh >= 1 ? sh + ' 股' : '不足1股';
      }
      const pc = planSide === 'long' ? 'var(--buy)' : 'var(--sell)';
      html += `<div style="border:2px solid ${pc};border-radius:12px;padding:12px;margin-bottom:10px;background:${pc}0a">
        <div style="font-size:13px;font-weight:800;color:${pc};margin-bottom:8px">🎯 執行計畫 — ${planSide==='long'?'做多':'做空'}${half?'（黃燈半量試單）':''}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div class="risk-box"><div class="rb-label">部位</div><div class="rb-value">${sizeTxt}</div><div class="rb-sub">資金${(capital/10000).toFixed(0)}萬×風險${riskPct}%${half?'÷2':''}</div></div>
          <div class="risk-box"><div class="rb-label">進場</div><div class="rb-value">${cur}${fmt(entry)}</div><div class="rb-sub">現價（可等${planSide==='long'?'回踩':'反彈'}）</div></div>
          <div class="risk-box"><div class="rb-label">🛑 停損</div><div class="rb-value" style="color:var(--sell)">${cur}${fmt(stop)}</div><div class="rb-sub">${smart?smart[planSide].method:'2×ATR'}</div></div>
          <div class="risk-box"><div class="rb-label">✅ 停利 2R/3R</div><div class="rb-value" style="color:var(--buy)">${cur}${fmt(tp1)} / ${fmt(tp2)}</div><div class="rb-sub">出50%/25%，剩25%續抱</div></div>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:8px">⏱️ 時間停損：3~5日未朝預期發展即全撤，不等價格停損。${(function(){
          try{
            const cc=D.closes,nn=cc.length;if(nn<40)return '';
            let s2=0,m2=0;const rets=[];
            for(let i=nn-40;i<nn;i++){rets.push((cc[i]-cc[i-1])/cc[i-1]);}
            const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
            const sd=Math.sqrt(rets.reduce((a,x)=>a+(x-mean)**2,0)/rets.length);
            const lots2=(D.currency==='TWD'&&dist>0)?Math.floor(riskAmt/(dist*1000)):0;
            const posVal=D.currency==='TWD'?lots2*1000*entry:Math.floor(dist>0?riskAmt/dist:0)*entry;
            if(!posVal)return '';
            const varAmt=Math.round(1.65*sd*posVal);
            return ' 此部位單日95%VaR≈'+(D.currency==='TWD'?'':'$')+varAmt.toLocaleString()+'（正常日95%機率虧損不超過此數，超過=異常日快跑）';
          }catch(e){return '';}
        })()}</div>
      </div>`;
    }
  } catch (e) { /* 執行計畫失敗不影響裁決顯示 */ }

  html += `<div style="font-size:10px;color:var(--muted2);line-height:1.8;padding-top:8px;border-top:1px solid var(--bd)">
    <b style="color:var(--muted)">⚔️ 獵人四律（反其道心法）</b><br>
    一、只在紀律門全綠時出手——沒有交易也是一種部位<br>
    二、進場點選在散戶停損被掃之後，不在訊號剛亮時（訊號亮=散戶進場=主力的貨源）<br>
    三、出場出給追價的人——擁擠度/過熱升高時分批獲利了結，把股票賣給看到明牌的散戶<br>
    四、沒有必勝法，只有正期望值：贏在「不出手的紀律」+「順公式的統計優勢」+「停損放在掃不到的地方」
  </div>`;
  document.getElementById('gate-content').innerHTML = html;
}