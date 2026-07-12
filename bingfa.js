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
    // 空方建議前，先檢查「低檔反彈風險」——避免對急跌後、隨時要技術性反彈的股票喊做空
    // （低多方勢能≠適合做空；這是 2313/2885 走勢相反的根本原因：勢能鏡像沒把反彈風險算進去）
    const psyVal = (formulas && formulas.psy) ? formulas.psy.value : 50;
    const c = D.closes, n = c.length;
    const ma20v = n >= 20 ? c.slice(-20).reduce((a,b)=>a+b,0)/20 : c[n-1];
    const biasPct = (D.price - ma20v) / ma20v * 100;  // 負乖離過大=超跌
    // 近5日跌幅（急跌判定）
    const drop5 = n >= 6 ? (c[n-1] - c[n-6]) / c[n-6] * 100 : 0;
    const bounceRisk = psyVal <= 28 || biasPct <= -8 || drop5 <= -8;

    if (bounceRisk) {
      // 反彈風險高：降級為「不宜追空」，明確擋掉這種最危險的空點
      color = 'var(--warn)'; bg = 'var(--warn-d)';
      title = '⚠️ 空方勢能強，但此刻「不宜追空」';
      const reasons = [];
      if (psyVal <= 28) reasons.push(`PSY ${psyVal} 已入恐慌區`);
      if (biasPct <= -8) reasons.push(`負乖離 ${biasPct.toFixed(1)}%（超跌）`);
      if (drop5 <= -8) reasons.push(`近5日急跌 ${drop5.toFixed(1)}%`);
      summary = `雖然空方勢能 ${shi.shortShi} 分，但 ${reasons.join('、')}——這是「跌深隨時技術性反彈」的位置，此刻進空最容易被軋。空單要嘛等反彈到壓力區再進、要嘛放棄。切勿追空殺低。`;
    } else {
      color = 'var(--sell)'; bg = 'var(--sell-d)';
      title = `🔻 空方${shi.shortGrade}級標的，弱勢明確`;
      summary = `空方勢能 ${shi.shortShi}分（趨勢/籌碼/量能同弱），且非跌深超賣區，偏空操作可考慮。做空嚴守停損`;
    }
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
    if (dir === 1 && fusion >= 40) warn.push(`FUSION極強區（+${fusion}）：19年75,056樣本驗證，極端強勢後5日上漲率反低於基準（α-2.7）——動能極端≠續漲，不給多單加分，防追高`);
    else if (dir === -1 && fusion <= -40) warn.push(`FUSION極弱區（${fusion}）：19年驗證此區後5日51%反而上漲——不給空單加分，防追殺低點`);
    else if ((dir === 1 && fusion >= 20) || (dir === -1 && fusion <= -20)) pass.push(`順公式（FUSION ${fusion >= 0 ? '+' : ''}${fusion}）`);
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
    // 溫度計整合：訊號尾端追單=風報比最差的進場（2885追高/2313追空的量化教訓，v64真實資料驗證）
    try {
      if (typeof computeMoveStage === 'function') {
        const ms = computeMoveStage(D);
        if (ms && ms.dir === dir) {
          if (ms.stage === '尾端') warn.push(`行情溫度計「${ms.dirTxt}·尾端」(成熟度${ms.maturity})：本段已走完此股歷史${ms.magPctl}%波段，順向追單風報比差——等回檔/反彈再進`);
          else if (ms.stage === '初期') pass.push(`行情溫度計「${ms.dirTxt}·初期」：波段尚新，進場位置佳`);
        }
      }
    } catch (e) {}
    if (dir === -1) {
      if (margin && margin.shortRatio >= 30) fail.push(`券資比 ${margin.shortRatio.toFixed(0)}%：空單擁擠，軋空風險高`);
      else if (margin && margin.shortRatio >= 20) warn.push(`券資比 ${margin.shortRatio.toFixed(0)}% 偏高，空單控制部位`);
      if (psy <= 25) warn.push(`PSY ${psy} 恐慌區：空單防技術性反彈（你 2313 的教訓）`);
      // 意圖研判：洗盤≠出貨。若研判為洗盤（洗散戶將漲），做空是站到主力對面，禁止
      if (typeof computeIntentAnalysis === 'function') {
        try {
          const it = computeIntentAnalysis(D, formulas, mf);
          if (it && it.verdict === '洗盤' && it.confidence >= 50) warn.push(`意圖研判「洗盤」結構(信心${it.confidence})：量價顯示有承接痕跡。19年5055事件驗證此判定無方向預測力(α≈0)，但結構上做空需防被掃後軋，停損放寬`);
          else if (it && it.verdict === '出貨' && it.confidence >= 50) warn.push(`意圖研判「出貨」結構(信心${it.confidence})：⚠️ 19年999事件驗證，此判定後5日僅46%真的下跌(α-4，反指標傾向)——不可作為做空依據，僅代表量價結構弱`);
        } catch (e) {}
      }
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
      if (dir === -1 && mf.behavior === '出貨') warn.push(`主力行為呈出貨結構（信心${mf.confidence}）：注意此結構經19年大樣本驗證無方向優勢，不構成空單加分，僅供結構參考`);
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
  // 行為推理鏈與紀律門共用 ctx，掛在此處＝margin/deepchip 非同步補繪重呼叫本函式時，推理鏈自動同步刷新
  try { if (typeof renderBehaviorChain === 'function') renderBehaviorChain(ctx); } catch (e) {}
}

/* ══ 行為推理鏈：指標 → 行為 → 走向 ═══════════════════════════════════
   設計理念（使用者核心哲學）：每個指標都有用處，多個指標綜合出一個「行為」，
   多個行為判斷出「走向」。此引擎不計算任何新指標——純粹把既有模組的輸出
   組織成透明的三層推理過程，讓每一個結論都能往下追到原始指標。
   ════════════════════════════════════════════════════════════════════ */
function computeBehaviorSynthesis(ctx) {
  const { D, regime, mtf, res, formulas } = ctx;
  const behaviors = [];   // { name, actor, dir(-1/0/1), strength(0~100), basis[], read }

  // ── 行為① 主力意圖（洗盤/出貨/進貨）──
  let mf = null, intent = null;
  try { if (typeof computeMainForce === 'function') mf = computeMainForce(D, formulas); } catch (e) {}
  try { if (typeof computeIntentAnalysis === 'function' && mf) intent = computeIntentAnalysis(D, formulas, mf); } catch (e) {}
  if (intent && intent.confidence > 0) {
    // ── 逐股α閘控（v75核心）：此判定在「這支股票」的歷史α決定它有沒有方向投票權 ──
    // 依據：19年16檔5055事件驗證，意圖判定的方向α全體接近0且逐股異質性大（-14~+18），
    // 全域方向投票已無正當性；改為逐股實證——α經貝氏收縮（James-Stein，Efron & Morris 1975）
    // 防小樣本誤判：shrunkα = α × n/(n+20)，樣本越少越往0收縮。shrunkα≥2 才保留方向票。
    let intentDir = intent.dir === 'up' ? 1 : intent.dir === 'down' ? -1 : intent.dir === 'bounce' ? 1 : 0;
    let alphaNote = '';
    try {
      const bt = typeof computeIntentBacktest === 'function' ? computeIntentBacktest(D) : null;
      if (bt && bt.stats[intent.verdict] && bt.stats[intent.verdict].n >= 5) {
        const s = bt.stats[intent.verdict];
        const isDown = intent.verdict === '出貨';
        const b5 = isDown ? 100 - bt.base5 : bt.base5, b10 = isDown ? 100 - bt.base10 : bt.base10;
        const aAvg = ((s.win5 / s.n * 100 - b5) + (s.win10 / s.n * 100 - b10)) / 2;
        const shrunk = aAvg * s.n / (s.n + 20);
        if (shrunk < 2) {
          intentDir = 0;
          alphaNote = `（此股${s.n}次歷史驗證α=${shrunk.toFixed(1)}無方向優勢→方向票停用，僅列結構參考）`;
        } else {
          alphaNote = `（此股${s.n}次歷史驗證α=+${shrunk.toFixed(1)}，方向票保留）`;
        }
      } else {
        intentDir = 0;
        alphaNote = '（此股歷史樣本不足，方向票保守停用）';
      }
    } catch (e) { intentDir = 0; }
    behaviors.push({
      name: `主力意圖：${intent.verdict}`, actor: '主力', group: 'mf-vol',
      dir: intentDir,
      strength: intent.confidence,
      basis: ['量價關係', 'OBV能量潮', 'Wyckoff測試', 'KBAR強度', '下影線承接', '法人買賣超'],
      read: (intent.verdict === '洗盤' ? '量價結構顯示殺低有承接、籌碼未明顯離開'
          : intent.verdict === '出貨' ? '量價結構顯示籌碼流出中'
          : '低檔量價背離，結構上有吸收痕跡') + alphaNote,
    });
  }

  // ── 行為② 主力行為推估（吸籌/誘多/誘空…）──
  if (mf && mf.confidence >= 40 && mf.behavior !== '無明顯主力行為') {
    const dirMap = { '吸籌': 1, '進貨': 1, '誘空': 1, '洗盤': 0, '出貨': -1, '誘多': -1, '恐慌殺盤': 0 };
    behaviors.push({
      name: `主力行為：${mf.behavior}`, actor: '主力', group: 'mf-vol',
      dir: dirMap[mf.behavior] != null ? dirMap[mf.behavior] : 0,
      strength: mf.confidence,
      basis: ['OBV偷跑', 'MFI資金流', 'KBAR', '影線形態', '假突破偵測'],
      read: mf.desc || '',
    });
  }

  // ── 行為③ 散戶行為（擁擠度＝反向解讀）──
  let crowd = null;
  try { if (typeof computeCrowding === 'function') crowd = computeCrowding(D, formulas); } catch (e) {}
  if (crowd && crowd.crowding >= 45 && crowd.crowdDir !== 0) {
    behaviors.push({
      name: `散戶行為：${crowd.crowdDir === 1 ? '擁擠追多' : '擁擠追空'}（${crowd.crowding}分）`, actor: '散戶',
      dir: -crowd.crowdDir * (crowd.crowding >= 70 ? 1 : 0),   // 高度擁擠才反向計分，中度僅提示
      strength: crowd.crowding,
      basis: ['教科書訊號可見度', '融資變化', '量能異常'],
      read: crowd.crowding >= 70 ? '散戶高度擠在同一邊——人多的地方常是反向燃料' : '散戶偏向一邊但未達極端，觀察即可',
    });
  }

  // ── 行為④ 散戶槓桿行為（融資融券象限）──
  const margin = (typeof _marginCache !== 'undefined' && _marginCache[D.code]) ? _marginCache[D.code].d : null;
  if (margin) {
    const c = D.closes, n = c.length;
    const priceDown5 = n >= 6 && D.price < c[n - 6];
    let mDir = 0, mRead = '融資融券無明顯異常';
    if (margin.marginChg5 > 4 && priceDown5) { mDir = -1; mRead = '融資增+價跌＝散戶逆勢接刀（歷史上最危險的象限），下跌常未完'; }
    else if (margin.marginChg5 < -3 && !priceDown5) { mDir = 1; mRead = '融資減+價漲＝籌碼從散戶流向主力（最健康的上漲）'; }
    else if (margin.shortRatio >= 25) { mDir = 1; mRead = `券資比${margin.shortRatio.toFixed(0)}%＝散戶空單擁擠，軋空燃料充足`; }
    if (mDir !== 0) {
      behaviors.push({ name: '散戶槓桿行為', actor: '散戶', dir: mDir, strength: 60,
        basis: ['融資餘額5日變化', '融券餘額', '券資比', '價格方向'], read: mRead });
    }
  }

  // ── 行為⑤ 大戶結構行為（FinMind千張剪刀差，有token才有）──
  const deep = (typeof _deepCache !== 'undefined' && _deepCache[D.code]) ? _deepCache[D.code].d : null;
  if (deep && deep.big) {
    const b = deep.big;
    if (b.bigChg > 0.3 && b.smallChg < -0.2) {
      behaviors.push({ name: '大戶結構：吸籌', actor: '大戶', dir: 1, strength: 70,
        basis: ['千張持股週變化', '散戶持股週變化'], read: `千張大戶+${b.bigChg}%、散戶${b.smallChg}%——籌碼流向大戶（結構偏多）` });
    } else if (b.bigChg < -0.3 && b.smallChg > 0.2) {
      behaviors.push({ name: '大戶結構：派發', actor: '大戶', dir: -1, strength: 70,
        basis: ['千張持股週變化', '散戶持股週變化'], read: `千張大戶${b.bigChg}%、散戶+${b.smallChg}%——大戶倒貨給散戶（結構偏空）` });
    }
  }
  if (deep && deep.lend && Math.abs(deep.lend.chg5) >= 8) {
    behaviors.push({
      name: `法人空單：${deep.lend.chg5 > 0 ? '增持' : '回補'}`, actor: '法人',
      dir: deep.lend.chg5 > 0 ? -1 : 1, strength: 55,
      basis: ['借券賣出餘額5日變化'],
      read: deep.lend.chg5 > 0 ? '聰明錢正在建立空單部位' : '機構空方撤退中',
    });
  }

  // ── 行為⑥ 市場環境行為（Regime）──
  if (regime && regime.regime) {
    const rDir = regime.regime === '多頭趨勢' ? 1 : regime.regime === '空頭趨勢' ? -1 : 0;
    behaviors.push({
      name: `環境：${regime.regime}`, actor: '市場',
      dir: rDir, strength: regime.regime === '高波動危險' ? 30 : 55,
      basis: ['ADX趨勢強度', '均線排列', '波動率'],
      read: regime.regime === '高波動危險' ? '此環境所有訊號可靠度大降，部位減半' :
            regime.regime === '盤整' ? '區間市，追突破易被巴，高賣低買' : `順著${regime.regime}方向操作勝率較高`,
    });
  }

  // ── 行為⑦ 大週期行為（MTF）──
  if (mtf && mtf.dir !== 0) {
    behaviors.push({
      name: `大週期：${mtf.dir === 1 ? '月週日偏多' : '月週日偏空'}`, actor: '市場',
      dir: mtf.dir, strength: Math.min(80, Math.abs(mtf.total || 50)),
      basis: ['月線30%', '週線40%', '日線30%'],
      read: '大週期定調——順大逆小是波段基本盤',
    });
  }

  // ── 行為⑧ 個股統計性格（自相關）──
  if (res && res.autocorr && res.autocorr.significant) {
    behaviors.push({
      name: `個股性格：${res.autocorr.character}`, actor: '統計',
      dir: 0, strength: 50,
      basis: ['日報酬一階自相關（Bartlett顯著性檢定）'],
      read: res.autocorr.r1 > 0 ? '此股漲跌有延續性，順勢訊號在此股較可信' : '此股漲多易回、跌深易彈，反指標訊號在此股較可信',
    });
  }

  // ── 行為⑨ 行情階段（溫度計，時機資訊不投方向票）──
  try {
    if (typeof computeMoveStage === 'function') {
      const ms = computeMoveStage(D);
      if (ms) {
        behaviors.push({
          name: `行情階段：${ms.dirTxt}·${ms.stage}`, actor: '時機',
          dir: 0, strength: ms.maturity,
          basis: ['ZigZag歷史波段分布', '幅度/天數百分位', '量能衰竭'],
          read: ms.stage === '尾端' ? '本段行情已屬尾端——即使走向明確，順向追單風報比差，等回檔/反彈找位' :
                ms.stage === '初期' ? '波段初期——若走向與行為共振一致，這是風報比最好的進場窗口' :
                '波段中期——持有續抱，新單需拉回找位',
        });
      }
    }
  } catch (e) {}

  // ── 走向層：加權合成 ──
  const votes = behaviors.filter(b => b.dir !== 0);
  let wSum = 0, wNet = 0;
  const seenGroupDir = {};   // 共線性折減：同源群組(共用底層指標)同方向的第二票折半，避免同一份證據投兩票
  votes.forEach(b => {
    let w = b.strength / 100;
    if (b.group) {
      const key = b.group + ':' + b.dir;
      if (seenGroupDir[key]) w *= 0.5;
      seenGroupDir[key] = true;
    }
    wSum += w; wNet += b.dir * w;
  });
  const score = wSum > 0 ? Math.round(wNet / wSum * 100) : 0;   // -100 ~ +100

  // 衝突偵測：主力方向 vs 散戶方向同邊＝警訊
  const mainDirs = behaviors.filter(b => (b.actor === '主力' || b.actor === '大戶' || b.actor === '法人') && b.dir !== 0);
  const conflict = [];
  if (intent && intent.verdict === '洗盤' && score < -20) conflict.push('意圖研判「洗盤」與整體偏空走向矛盾——洗盤情境追空易被軋，以意圖研判優先');
  const mainNet = mainDirs.reduce((a, b) => a + b.dir, 0);
  if (mainNet > 0 && score < -20) conflict.push('主力/大戶/法人合計偏多，但整體走向偏空——逆聰明錢的方向要特別小心');
  if (mainNet < 0 && score > 20) conflict.push('主力/大戶/法人合計偏空，但整體走向偏多——上漲可能是誘多或逃命波');

  let direction, dirClass;
  if (Math.abs(score) < 20 || votes.length < 3) { direction = '⚪ 走向不明——行為證據不足或互相抵消，觀望'; dirClass = 'warn'; }
  else if (score >= 50) { direction = '📈 走向偏多——多個行為指向同一邊'; dirClass = 'buy'; }
  else if (score >= 20) { direction = '📈 走向略偏多——有傾向但未共振'; dirClass = 'buy'; }
  else if (score <= -50) { direction = '📉 走向偏空——多個行為指向同一邊'; dirClass = 'sell'; }
  else { direction = '📉 走向略偏空——有傾向但未共振'; dirClass = 'sell'; }

  return { behaviors, score, direction, dirClass, conflict, voteCount: votes.length };
}

function renderBehaviorChain(ctx) {
  const card = document.getElementById('behavior-chain-card');
  if (!card) return;
  let syn = null;
  try { syn = computeBehaviorSynthesis(ctx); } catch (e) { card.style.display = 'none'; return; }
  if (!syn || !syn.behaviors.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const dCol = syn.dirClass === 'buy' ? 'var(--buy)' : syn.dirClass === 'sell' ? 'var(--sell)' : 'var(--warn)';
  let html = `<div style="padding:11px 13px;background:${dCol}12;border:1.5px solid ${dCol}60;border-radius:10px;margin-bottom:12px">
    <div style="font-size:14px;font-weight:800;color:${dCol}">${syn.direction}</div>
    <div style="font-size:11px;color:var(--muted);margin-top:3px">綜合分數 ${syn.score >= 0 ? '+' : ''}${syn.score}（-100全空 ~ +100全多）｜由 ${syn.voteCount} 個有方向的行為加權合成</div>
  </div>`;

  if (syn.conflict.length) {
    syn.conflict.forEach(cf => {
      html += `<div style="padding:8px 12px;background:var(--warn-d);border:1px solid var(--warn);border-radius:8px;margin-bottom:8px;font-size:11px;color:var(--muted);line-height:1.6">⚡ <b style="color:var(--warn)">行為衝突</b>：${cf}</div>`;
    });
  }

  html += `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">行為層（每個行為由下列指標綜合而來）</div>`;
  syn.behaviors.forEach(b => {
    const bCol = b.dir === 1 ? 'var(--buy)' : b.dir === -1 ? 'var(--sell)' : 'var(--muted)';
    const arrow = b.dir === 1 ? '↗ 偏多' : b.dir === -1 ? '↘ 偏空' : '— 中性/性格';
    html += `<div style="padding:8px 10px;background:var(--bg);border:1px solid var(--bd);border-left:3px solid ${bCol};border-radius:8px;margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;font-weight:700">${b.name} <span style="font-size:10px;color:var(--muted2)">［${b.actor}］</span></span>
        <span style="font-family:var(--mono);font-size:11px;color:${bCol};font-weight:700">${arrow} ${b.strength}</span>
      </div>
      <div style="font-size:11px;color:var(--muted);line-height:1.55;margin-top:3px">${b.read}</div>
      <div style="font-size:9px;color:var(--muted2);margin-top:3px">↑ 指標層：${b.basis.join(' · ')}</div>
    </div>`;
  });

  html += `<div style="font-size:10px;color:var(--muted2);margin-top:8px;line-height:1.6">💡 推理鏈設計：指標→行為→走向。單一指標會騙人、單一行為會誤判，但「主力、大戶、法人、散戶、市場」五方行為同時指向一邊時，就是全系統最可信的訊號。此卡不計算新指標，是既有模組結果的透明彙整——每個結論都能往下追到原始指標。行為衝突時，以「主力意圖研判」與「出手紀律門」優先。</div>`;
  document.getElementById('behavior-chain-content').innerHTML = html;
}
