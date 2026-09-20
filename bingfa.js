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
   ──────────────────────────────────────────────────────────────────
   函式清單（依出現順序）：
     computeShiPower                  — 勢能分數（趨勢/籌碼/量/產業）
     computeTradeScore                — 交易評分（進場時機）
     renderVerdictBanner              — ★決策橫幅：全系統警示彙整出口
                                         (D/regime/mtf 為必要參數，勿省略)
     computeBehaviorSynthesis         — 行為推理鏈：指標→行為→走向
                                         三層推理；主力意圖投票經逐股α閘控
                                         (group欄位標記共線證據，同組同向
                                         第二票折半，見votes計算段)
     renderTradeGate / 出手紀律門       — R1~R6七道關卡；R6含突破統計聯動
     renderPlaybook相關（見mainforce.js）
   ──────────────────────────────────────────────────────────────────
   近期版本異動（供排雷定位用）：
     v60  共線折減機制（同group同向第二票×0.5）
     v75  主力意圖投票改「逐股α閘控」：computeIntentBacktest算此股α，
          貝氏收縮(James-Stein)後shrunkα≥2才保留方向票，否則dir=0僅列
          結構參考。此邏輯若被覆寫會讓已證偽的方向訊號重新投票，須小心
     v76  出貨/洗盤紀律門文字改為警告(非fail)，FUSION極端區除權(不再加分)
     v78  ★大整合：renderVerdictBanner簽名擴為8參數含D/regime/mtf；
          修復潛伏雷「舊版空方分支引用未定義變數D」（生產環境曾靜默失效）
     v80  五條聯動：線位→橫幅、當沖→擁擠度、自營自行→行為鏈投票、
          停損×線位重疊偵測、deep到達補繪擁擠雷達
     v87  突破統計(computeBreakoutStats)接入R6紀律門 + 橫幅
     v89  突破統計跨市場分離：非台股(isTW=false)不套用台股38.4%基準，
          否則會對美股股票錯誤外推台股統計結論
     v90  橫幅與紀律門突破警示門檻對齊(48%)，避免同股同時被pass又warn；
          支撐壓力卡的重複假突破數字移除，改指向溫度計卡（單一真相來源）
   ⚠️ 已知地雷／注意事項：
     - v93修復：本檔曾有獨立的_gateATR實作（簡單平均+還原價），與app.js的
       calcATR（Wilder平滑+原始價）算出不同數值（實測2313差14.7%），導致
       紀律門的停損/部位與執行計畫/劇本不一致。教訓：任何指標只能有一個
       實作來源，不可為了「這裡方便」另寫簡化版——會產生前後矛盾的數字
     - renderVerdictBanner的空方判斷分支需要D參數(現價/PSY/乖離計算)，
       str_replace編輯此函式時務必確認函式簽名8個參數完整帶入
     - computeBehaviorSynthesis內任何新增behaviors.push()若與既有證據
       共用底層指標(如OBV/KBAR)，須標記相同group讓折減機制生效，否則
       等於讓同一份證據重複投票
     - 突破統計相關的3處warn/pass判斷(banner/gate)門檻須保持一致(當前48%)，
       改動其一必須同步改另一處，否則同股票會出現互相矛盾的訊息
   ══════════════════════════════════════════════════════════════════════ */

/* ── 勢能分數（觀勢）────────────────────────────────────────────────
   趨勢40% + 籌碼30% + 成交量20% + 產業10%(用RS近似)
   各子項標準化到 0~100，加權合計
   ──────────────────────────────────────────────────────────────── */
/* ══ 【區塊 A】勢能與評分 ═══════════════════════════════════════════════
   computeShiPower / computeTradeScore / computeBingfaExit / renderBingfa
   ⚠️ 改動勢能公式會連動：決策橫幅的等級判定、紀律門的分級門檻
   ════════════════════════════════════════════════════════════════════ */
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
/* ══ 【區塊 B】決策橫幅 ═══════════════════════════════════════════════
   全系統警示的唯一彙整出口。8參數缺一不可（D/regime/mtf為v78新增）。
   ⚠️ 新增警示時：加在 warns 陣列並設優先序 pri，勿另開顯示區塊
   ⚠️ 突破警示門檻(48%)須與區塊D紀律門保持一致，否則同股會被同時
      pass又warn（v90修過此衝突）
   ════════════════════════════════════════════════════════════════════ */
function renderVerdictBanner(shi, tradeScore, formulas, marketScore, res, D, regime, mtf) {
  const banner = document.getElementById('verdict-banner');
  const inner = document.getElementById('vb-inner');
  if (!banner || !inner) return;
  banner.style.display = 'block';

  const grade = shi.grade;
  const crash = formulas && formulas.crash ? formulas.crash.score : 0;
  const fusion = formulas && formulas.fusion ? formulas.fusion.value : 0;

  // ══ 全系統避險警示彙整（v78 大整合：把 v59-v77 所有已驗證的風險偵測收攏到一處）══
  // 優先序：環境級 > 時機級 > 結構衝突 > 擁擠/槓桿 > 提示級
  const warns = [];
  const addW = (pri, icon, text) => warns.push({ pri, icon, text });
  let syn = null, ms = null, crowd = null;
  try { if (typeof computeMoveStage === 'function') ms = computeMoveStage(D); } catch (e) {}
  try { if (typeof computeBehaviorSynthesis === 'function') syn = computeBehaviorSynthesis({ D, regime, mtf, res, formulas }); } catch (e) {}
  try { if (typeof computeCrowding === 'function') crowd = computeCrowding(D, formulas); } catch (e) {}

  try { if (regime && regime.regime === '高波動危險') addW(1, '🌪', '環境「高波動危險」：所有訊號可靠度大降，部位至少減半或觀望'); } catch (e) {}
  try { if (ms && ms.stage === '尾端') addW(2, '🌡', `行情「${ms.dirTxt}·尾端」（成熟度${ms.maturity}）：本段已走完此股歷史${ms.magPctl}%波段——順向追單風報比差，等回檔/反彈找位`); } catch (e) {}
  try { if (syn && syn.conflict && syn.conflict.length) addW(3, '⚡', `行為衝突：${syn.conflict[0]}`); } catch (e) {}
  try { if (crowd && crowd.crowding >= 70) addW(4, '👥', `散戶擁擠度 ${crowd.crowding}/100：教科書訊號人人可見，停損密集區易被掃——與主力反向時是陷阱`); } catch (e) {}
  try {
    const mg = (typeof _marginCache !== 'undefined' && _marginCache[D.code]) ? _marginCache[D.code].d : null;
    if (mg && D.closes.length >= 6 && mg.marginChg5 > 4 && D.price < D.closes[D.closes.length - 6]) addW(4, '💳', '融資增+價跌：散戶逆勢接刀象限（歷史最危險），下跌常未完，做多再等');
  } catch (e) {}
  try {
    const dp = (typeof _deepCache !== 'undefined' && _deepCache[D.code]) ? _deepCache[D.code].d : null;
    if (dp && dp.dayTrading && (dp.dayTrading.cur >= 30 || (dp.dayTrading.avg20 > 0 && dp.dayTrading.cur > dp.dayTrading.avg20 * 1.5))) addW(5, '⚡', `當沖比重 ${dp.dayTrading.cur}%：投機盤主導，波動放大且日內訊號雜訊高`);
  } catch (e) {}
  try { if (fusion >= 40) addW(5, '🔥', `FUSION 極強區（+${fusion}）：19年驗證極端強勢無續漲優勢——防追高`); } catch (e) {}
  try { if (fusion <= -40) addW(5, '🧊', `FUSION 極弱區（${fusion}）：19年驗證此區51%反而上漲——防追殺低點`); } catch (e) {}
  try {
    if (typeof computeChartPatterns === 'function') {
      const cp = computeChartPatterns(D);
      if (cp) {
        const px = D.rawCloses ? D.rawCloses[D.rawCloses.length - 1] : D.price;
        const onLine = cp.patterns.find(p => Math.abs(px - p.level) / p.level * 100 < cp.tol);
        if (onLine) addW(4, '📐', `現價正處「${onLine.kind}」線位 ${onLine.level.toFixed(2)}——全市場都看得到的關卡，突破/跌破未經收盤+量能確認前別搶方向`);
      }
    }
  } catch (e) {}
  try {
    const bs3 = (typeof computeBreakoutStats === 'function') ? computeBreakoutStats(D) : null;
    const sq3 = (typeof computeSetupQuality === 'function') ? computeSetupQuality(D) : null;
    if (bs3 && sq3 && sq3.breakout && !(bs3.tier === 'high' && bs3.all.rate >= 48)) addW(3, '📊', bs3.tier === 'high'
      ? `正在突破：此股歷史成功率 ${bs3.all.rate.toFixed(0)}%（假突破率${bs3.fakeRate.toFixed(0)}%，${bs3.all.n}次樣本）${bs3.isTW ? '｜台股基準38.4%' : ''}——追突破期望值偏低，寧可等回測前高不破再進，或只在帶量時進`
      : (bs3.isTW
        ? `正在突破：台股19年3,934次驗證，突破成功率僅38.4%（假突破率61.6%）——追突破期望值為負。此股樣本${bs3.all.n}次不足採信，請以台股基準判斷，帶量進場較佳`
        : `正在突破：此股樣本僅${bs3.all.n}次，統計參考價值低。追突破普遍假突破率偏高，務必設好停損`));
  } catch (e) {}
  try {
    const am2 = (D && typeof computeAmihud === 'function') ? computeAmihud(D) : null;
    if (am2 && am2.level === '稀薄') addW(5, '💧', am2.note);
  } catch (e) {}
  try {
    const cp2 = (D && typeof computeCrashPhase === 'function') ? computeCrashPhase(D) : null;
    if (cp2) addW(cp2.phase === '急跌末端' ? 2 : 4, cp2.phase === '急跌末端' ? '🛑' : '🌊', cp2.note);
  } catch (e) {}
  try {
    const ph = (D && D.currency === 'TWD' && typeof twMarketPhase === 'function') ? twMarketPhase() : null;
    if (ph && ph.open) addW(7, '⏱', `盤中查詢（已開盤${Math.round(ph.elapsed * 100)}%）：今日K線未完成——量能為推估、所有含今日的訊號收盤前都可能翻轉。奪先機的代價是雜訊，盤中進場部位建議再縮`);
  } catch (e) {}
  try { const ew = (typeof checkEarningsWindow === 'function') ? checkEarningsWindow() : null; if (ew) addW(5, '📊', ew.text); } catch (e) {}
  try {
    // v104 營收公布窗口：台股上市櫃每月10日前須公布月營收——2-10日波段常跨到公布日，
    // 營收意外=跳空，技術停損擋不住跳空。這是基本面對「短線」唯一的直接殺傷路徑
    const d4 = new Date(), dom = d4.getDate();
    if (dom >= 1 && dom <= 10) addW(5, '📊', `月營收公布窗口（每月10日前）：持單跨公布日有跳空風險，技術停損擋不住跳空——重倉單建議在公布前減碼或確認本月已公布（尤其空單遇營收意外年增=軋空跳空）`);
  } catch (e) {}
  try { const etf = (typeof checkETFRebalanceWindow === 'function') ? checkETFRebalanceWindow() : null; if (etf) addW(6, '📅', etf.text + '——留意搶跑效應（概估窗口）'); } catch (e) {}
  warns.sort((a, b) => a.pri - b.pri);

  // ══ 主結論（v78 修復：D 改由參數傳入——先前引用未定義變數導致空方分支靜默失效）══
  let color, bg, title, summary;
  if (crash >= 60) {
    color = 'var(--sell)'; bg = 'var(--sell-d)';
    title = '🚨 崩跌預警，建議避開';
    summary = `崩跌風險分 ${crash}/100，即使其他指標尚可，風險優先原則下不宜進場`;
  } else if (grade === 'A' || grade === 'B') {
    color = grade === 'A' ? 'var(--buy)' : '#10B981'; bg = 'var(--buy-d)';
    title = `🟢 ${grade}級標的，多方條件${grade === 'A' ? '完整' : '良好'}`;
    summary = `勢能 ${shi.shi}分、交易評分 ${tradeScore.score}${syn ? `、行為結構 ${syn.score >= 0 ? '+' : ''}${syn.score}` : ''}。${warns.length ? '但有警示需先處理（見下方）' : '結構乾淨，依出手紀律門的執行計畫進場，嚴設停損分批停利'}`;
  } else if (grade === 'C') {
    color = 'var(--warn)'; bg = 'var(--warn-d)';
    title = '🟡 C級標的，勢能普通，謹慎';
    summary = `勢能 ${shi.shi}分。條件中等，不急進場，等更明確訊號或更好價位`;
  } else if (shi.shortGrade === 'A' || shi.shortGrade === 'B') {
    const psyVal = (formulas && formulas.psy) ? formulas.psy.value : 50;
    const c = D.closes, n = c.length;
    const ma20v = n >= 20 ? c.slice(-20).reduce((a, b) => a + b, 0) / 20 : c[n - 1];
    const biasPct = (D.price - ma20v) / ma20v * 100;
    const drop5 = n >= 6 ? (c[n - 1] - c[n - 6]) / c[n - 6] * 100 : 0;
    const bounceRisk = psyVal <= 28 || biasPct <= -8 || drop5 <= -8;
    if (bounceRisk) {
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
      summary = `空方勢能 ${shi.shortShi}分（趨勢/籌碼/量能同弱），且非跌深超賣區${ms && ms.stage === '尾端' && ms.dir === -1 ? '，但行情已尾端——等反彈找位而非市價追' : '，偏空可依紀律門評估'}。做空嚴守停損`;
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

  const chip = (label, val, c) => `<div style="background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:5px 10px;font-size:11px"><span style="color:var(--muted)">${label}</span> <span style="font-family:var(--mono);font-weight:700;color:${c}">${val}</span></div>`;
  const confidence = res ? Math.abs(res.consensus) : null;
  if (res && res.strength === 'weak') {
    document.getElementById('vb-summary').textContent += '。⚠️ 各維度目前分歧，信心指數低，不強行給方向——觀望也是操作';
  }
  const mkt = marketScore ? marketScore.score : null;
  document.getElementById('vb-metrics').innerHTML =
    chip('勢能', shi.shi, color) +
    chip('交易評分', tradeScore.score, 'var(--acc)') +
    (syn ? chip('行為結構', (syn.score >= 0 ? '+' : '') + syn.score, syn.score >= 20 ? 'var(--buy)' : syn.score <= -20 ? 'var(--sell)' : 'var(--muted)') : '') +
    (ms ? chip('行情階段', ms.stage, ms.cls === 'buy' ? 'var(--buy)' : ms.cls === 'sell' ? 'var(--sell)' : 'var(--warn)') : '') +
    chip('崩跌風險', crash, crash >= 35 ? 'var(--sell)' : 'var(--muted)') +
    (mkt != null ? chip('大盤', mkt, mkt >= 55 ? 'var(--buy)' : mkt <= 45 ? 'var(--sell)' : 'var(--warn)') : '') +
    (confidence != null ? chip('信心', confidence, confidence >= 60 ? 'var(--buy)' : confidence >= 30 ? 'var(--warn)' : 'var(--sell)') : '');

  /* ══ v133 綜合研判：依證據等級加權，把散落判斷收斂成一句明確結論 ═════
     原本的「信心指數」只算各維度的共識度，把「已證偽的指標」與「通過
     19年驗證的指標」當等值票在算，信心因此失真。
     改為：只有 EVIDENCE 登記為 A/B 級的項目才計入，X 級（已除權）完全
     不參與；並依 w 加權。同時明確報告「用了幾項證據、缺哪些、衝突幾項」，
     讓使用者知道這個結論建立在什麼之上——而不是一個來路不明的分數。 */
  const judgeEl = document.getElementById('vb-judgement');
  if (judgeEl) {
    try {
      const EV = (typeof EVIDENCE !== 'undefined') ? EVIDENCE : {};
      const items = [];   // {key, dir(-1/0/1), label}
      const push = (key, dir, label) => { const e = EV[key]; if (e && e.tier !== 'X') items.push({ key, dir, label, w: e.w, tier: e.tier }); };

      if (ms && ms.maturity != null) push('moveStage', ms.maturity >= 75 ? 0 : ms.dir, `波段${ms.maturity.toFixed(0)}%`);
      if (syn) push('behavior', syn.score >= 20 ? 1 : syn.score <= -20 ? -1 : 0, `行為結構${syn.score >= 0 ? '+' : ''}${syn.score}`);
      try { const bsJ = (typeof computeBreakoutStats === 'function') ? computeBreakoutStats(D) : null;
        if (bsJ && bsJ.tier === 'high') push('breakout', 0, `突破成功率${bsJ.all.rate.toFixed(0)}%`); } catch (e) {}
      try { const amJ = (typeof computeAmihud === 'function') ? computeAmihud(D) : null;
        if (amJ) push('amihud', 0, `流動性${amJ.level}`); } catch (e) {}
      try { const cwJ = (typeof computeCrowding === 'function') ? computeCrowding(D) : null;
        if (cwJ && cwJ.score != null) push('crowding', 0, `擁擠度${cwJ.score}`); } catch (e) {}

      if (items.length) {
        const dirW = items.reduce((a, x) => a + x.dir * x.w, 0);
        const totW = items.reduce((a, x) => a + x.w, 0);
        const lean = totW > 0 ? dirW / totW : 0;                       // -1~1
        const directional = items.filter(x => x.dir !== 0);
        const conflict = directional.length > 1 && directional.some(x => x.dir > 0) && directional.some(x => x.dir < 0);
        const aCount = items.filter(x => x.tier === 'A').length;
        const excluded = Object.values(EV).filter(e => e.tier === 'X').length;
        const conf = Math.round(Math.min(100, Math.abs(lean) * 100 * (conflict ? 0.5 : 1) * (aCount >= 3 ? 1 : 0.7)));
        const verdictTxt = conflict ? '證據互相衝突，不給方向——觀望'
          : Math.abs(lean) < 0.25 ? '證據分散，無主導方向——多看少做'
          : lean < 0 ? '偏空條件較集中' : '偏多條件較集中';
        const col = conflict || Math.abs(lean) < 0.25 ? 'var(--warn)' : lean < 0 ? 'var(--sell)' : 'var(--buy)';
        judgeEl.innerHTML = `<div style="margin-top:10px;padding:9px 11px;background:${col}0d;border:1px solid ${col}55;border-radius:9px">
          <div style="font-size:12px;font-weight:700;color:${col};margin-bottom:4px">🎯 綜合研判：${verdictTxt}（信心 ${conf}）</div>
          <div style="font-size:10px;color:var(--muted);line-height:1.6">
            採計 ${items.length} 項證據（其中 A 級可決策 ${aCount} 項）：${items.map(x => x.label).join('、')}<br>
            <span style="color:var(--muted2)">已排除 ${excluded} 項未通過檢驗的指標（專屬分數α=-4.4、機率卡LogLoss劣於基準、貝氏極端區偏離、意圖方向α≈0）——它們仍顯示在各自卡片供參考，但不計入本結論。</span>
            ${conflict ? '<br><span style="color:var(--warn)">⚠️ 偵測到方向證據互相衝突，信心已折半</span>' : ''}
            ${aCount < 3 ? '<br><span style="color:var(--warn)">⚠️ A級證據不足3項，信心已下調</span>' : ''}
          </div></div>`;
      } else judgeEl.innerHTML = '';
      const cev = computeCondEV(D, regime);
      if (cev) {
        const pc = v => `${v[0] >= 0 ? '+' : ''}${v[0].toFixed(2)}%/筆（${v[1].toLocaleString()}筆）`;
        const line = (lbl, s) => s.setups.length
          ? `${lbl}｜今日型態 ${s.setups.map(x => `「${x.name}」${x.rg === '全部' ? '（此盤勢樣本不足，用全盤勢）' : ''} ${pc(x.v)}`).join('、')}；同盤勢任意日 ${pc(s.base)}`
          : `${lbl}｜今日無已回測型態；同盤勢任意日 ${pc(s.base)}`;
        const best = Math.max(cev.long.base[0], cev.short.base[0], ...cev.long.setups.map(x => x.v[0]), ...cev.short.setups.map(x => x.v[0]));
        judgeEl.innerHTML += `<div style="margin-top:8px;padding:9px 11px;background:var(--bg);border:1px solid var(--bd);border-radius:9px;font-size:10px;color:var(--muted);line-height:1.7">
          <div style="font-size:12px;font-weight:700;color:${best < 0 ? 'var(--warn)' : 'var(--buy)'};margin-bottom:4px">💰 期望值（19年24檔，盤勢：${cev.rg}，已含成本與滑價）</div>
          ${line('做多', cev.long)}<br>${line('做空', cev.short)}<br>
          ${best < 0 ? '<b>兩邊皆為負：不交易（期望值 0）是數學上最好的選擇。</b>若仍要做，視為付費換經驗——最小部位、當沖稅率或議價手續費，並嚴守紀律門與停損。' : '有非負格子，但仍須通過紀律門與停損檢查。'}
          <br><span style="color:var(--muted2)">出場固定為 1×ATR 停損／1.5×ATR 目標／最多10日；上方「綜合研判」只代表條件集中度，不改變這裡的期望值。</span></div>`;
      }
    } catch (e) { judgeEl.innerHTML = ''; }
  }

  /* ══ v132 趨勢敘事鏈：把並列的指標串成因果邏輯 ══════════════════════
     問題：橫幅原本只並列「勢能71｜階段初期｜崩跌30」等數字，使用者看完
     仍不知道「這檔現在到底什麼狀況、走到哪、什麼時候該改變看法」。
     這裡不新增任何計算，只把既有結果依交易邏輯順序串起來：
       環境 → 走到哪 → 誰在動 → 結構是否支持 → 何時翻盤
     最後一項「翻盤條件」是專業交易最重要卻最常缺的：事先寫下
     「什麼證據出現代表我錯了」，避免事後找理由凹單。 */
  const narrEl = document.getElementById('vb-narrative');
  if (narrEl) {
    try {
      const seg = [];
      const dirTxt = regime && regime.regime === '多頭趨勢' ? '多' : '空';
      // ① 環境
      if (regime) seg.push({ k: '環境', v: regime.regime === '高波動危險' ? '高波動危險——19年實測此時放空每筆約虧1.4~1.8%，不進場' : `${regime.regime}——僅作背景：19年實測順勢、逆勢的期望值沒有差異` });
      // ② 走到哪（溫度計＋持續天數）
      if (ms && ms.maturity != null) {
        seg.push({ k: '進程', v: `${ms.dirTxt}波段已走 ${ms.maturity.toFixed(0)}%${ms.maturity >= 75 ? '——接近尾端，此時追單是接最後一棒' : ms.maturity <= 30 ? '——仍在初期，空間相對完整' : '——中段，續走與反轉機率相當'}` });
      }
      // ③ 誰在動（行為結構）
      if (syn) seg.push({ k: '參與者', v: `行為結構 ${syn.score >= 0 ? '+' : ''}${syn.score}${syn.conflict && syn.conflict.length ? `，但有 ${syn.conflict.length} 項證據互相衝突——分歧時勿重倉` : syn.score >= 20 ? '，多方證據集中' : syn.score <= -20 ? '，空方證據集中' : '，證據分散無主導方' }` });
      // ④ 結構是否支持（風報比＝能不能賺）
      try {
        const atrN = calcATR(D.rawHighs || D.highs, D.rawLows || D.lows, D.rawCloses || D.closes, 14);
        const stopPctN = atrN * 2 / (D.price || 1) * 100;
        const rtN = (typeof computeRealisticTargets === 'function') ? computeRealisticTargets(D, dirTxt === '空' ? -1 : 1, stopPctN) : null;
        const r5N = rtN && rtN.rows ? rtN.rows.find(r => r.days === 5) : null;
        if (r5N) seg.push({ k: '結構', v: `以2×ATR停損計，風報比 1:${r5N.rr.toFixed(2)}${r5N.rr < 1 ? `——即使方向做對也難獲利，需等回測關鍵位讓停損變近（見風險卡「出路」）` : '——結構可接受'}` });
      } catch (e) {}
      // ⑤ 翻盤條件（最關鍵：事先寫下我錯了的證據）
      const inval = [];
      if (ms && ms.maturity != null && ms.maturity < 75) inval.push(`波段成熟度突破75%（進入尾端）`);
      if (syn) inval.push(`行為結構分數翻過 ${syn.score >= 0 ? '-20' : '+20'}`);
      if (inval.length) seg.push({ k: '翻盤條件', v: inval.join('｜') + ' —— 出現任一項即重新評估，不凹單' });

      narrEl.innerHTML = seg.length ? `<div style="margin-top:10px;padding:9px 11px;background:var(--bg);border:1px solid var(--bd);border-radius:9px">
        <div style="font-size:10px;color:var(--muted2);margin-bottom:5px">🔗 趨勢邏輯鏈（同一組數據，依交易順序串起）</div>
        ${seg.map((s, i) => `<div style="font-size:11px;color:var(--muted);line-height:1.65;display:flex;gap:6px">
          <span style="color:${s.k === '翻盤條件' ? 'var(--warn)' : 'var(--muted2)'};min-width:52px;font-weight:700">${s.k}</span>
          <span>${s.v}</span></div>`).join('')}
      </div>` : '';
    } catch (e) { narrEl.innerHTML = ''; }
  }

  // ══ 避險警示區（最多3條，其餘計數；無警示顯示綠色安心線）══
  const wEl = document.getElementById('vb-warns');
  if (wEl) {
    if (warns.length) {
      let wh = warns.slice(0, 3).map(w => `<div style="display:flex;gap:7px;align-items:flex-start;padding:6px 10px;background:var(--warn-d);border:1px solid var(--warn);border-radius:8px;margin-bottom:5px;font-size:11px;color:var(--muted);line-height:1.55"><span>${w.icon}</span><span>${w.text}</span></div>`).join('');
      if (warns.length > 3) wh += `<div style="font-size:10px;color:var(--muted2);padding:2px 4px">另有 ${warns.length - 3} 項提示，詳見各分析卡</div>`;
      wEl.innerHTML = wh;
    } else {
      wEl.innerHTML = `<div style="font-size:10px;color:var(--buy);padding:2px 4px">✓ 全系統避險掃描（環境/階段/衝突/擁擠/槓桿/極端值/ETF窗口）無警示</div>`;
    }
  }
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
/* ══ 【區塊 C】出手紀律門（計算層）═══════════════════════════════════
   R1~R6 七道關卡，回傳 {pass[], warn[], fail[]}
   ⚠️ fail = 禁止進場（紅燈），warn = 提醒但不擋，pass = 加分
      新增規則前先確認該證據是否已被大樣本驗證（無證據的規則不該給 fail）
   ════════════════════════════════════════════════════════════════════ */
/* ══ 【區塊 C0】急跌階段機（v103，空方戰情核心）════════════════════════
   專業空頭鐵律：吃魚身、不追魚尾。三階段判定（全用T+0價量）：
   急跌進行＝3日跌幅>2.5×ATR%且無承接棒 → 空單順風（移動停利保護利潤）
   急跌末端＝急跌中出現「承接棒」（振幅>1.8×ATR、量>2×均量、收在當日
   上半部）＝高潮量有人接貨 → 追空=撿人家出完的（19年實證背書：
   FUSION≤-40後5日反彈率51.6%，跌深處統計偏反彈）
   ⚠️ 此為風控/時機判定（本系統唯一有實證的車道），非方向預測
   ════════════════════════════════════════════════════════════════════ */
/* v139 期望值整合：偵測今日符合哪個已回測型態（定義與 backtest_conditional.js 相同，原始價），
   查 COND_EV 取「同盤勢×同型態」的19年實測每筆淨期望值；無型態時用同盤勢任意日基準。 */
function computeCondEV(D, regime) {
  try {
    if (typeof COND_EV === 'undefined') return null;
    const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows, i = c.length - 1;
    if (i < 70) return null;
    const hi = (a, b) => Math.max(...h.slice(a, b + 1)), lo = (a, b) => Math.min(...l.slice(a, b + 1));
    const ma = n => c.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
    const m5 = ma(5), m20 = ma(20), m60 = ma(60);
    const hit = {
      '突破20日高': c[i] > hi(i - 20, i - 1) && c[i - 1] <= hi(i - 21, i - 2),
      '多頭排列拉回': m5 > m20 && m20 > m60 && c[i] <= lo(i - 5, i - 1) * 1.015,
      '空頭排列反彈': m5 < m20 && m20 < m60 && c[i] >= hi(i - 5, i - 1) * 0.985,
      '跌破20日低': c[i] < lo(i - 20, i - 1) && c[i - 1] >= lo(i - 21, i - 2),
      '假突破回落': c[i - 1] > hi(i - 21, i - 2) && c[i] < hi(i - 21, i - 2),
    };
    const rg = ({ 多頭趨勢: '多頭', 空頭趨勢: '空頭', 盤整: '盤整', 過渡帶: '過渡', 高波動危險: '高波動' })[regime && regime.regime] || '全部';
    const side = dir => {
      const base = COND_EV.base[dir][rg] || COND_EV.base[dir]['全部'];
      const m = Object.entries(COND_EV.setups).filter(([k, s]) => s.dir === dir && hit[k])
        .map(([k, s]) => ({ name: k, v: s[rg] || s['全部'], rg: s[rg] ? rg : '全部' }));
      return { base, setups: m };
    };
    return { rg, long: side(1), short: side(-1) };
  } catch (e) { return null; }
}

function computeCrashPhase(D) {
  try {
    const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows, v = D.volumes, n = c.length;
    if (n < 40) return null;
    let atr = 0; for (let k = n - 14; k < n; k++) atr += Math.max(h[k] - l[k], Math.abs(h[k] - c[k - 1]), Math.abs(l[k] - c[k - 1])); atr /= 14;
    const atrPct = atr / c[n - 1] * 100;
    const drop3 = (c[n - 4] - c[n - 1]) / c[n - 4] * 100;
    /* v109修：原本只比相對門檻(2.5×ATR)，當ATR≈0（停牌復牌、極低波動、資料異常）時
       0 < 0 為 false 不會 return，導致完全沒跌的股票被判為「急跌進行0.0%」——
       顯示明顯錯誤的資訊。加①ATR有效性檢查②絕對跌幅下限3%（短線的「急跌」
       至少要有實質跌幅，否則低波動股的小跌也會誤觸發）。 */
    if (!atr || atr <= 0 || !isFinite(atrPct) || atrPct <= 0) return null;
    if (drop3 < atrPct * 2.5 || drop3 < 3) return null;   // 未達急跌標準（相對＋絕對雙門檻）
    // 承接棒：最近2日內有沒有高潮量收高
    const avg20 = v.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20;
    let absorb = false;
    for (let k = n - 2; k < n; k++) {
      const range = h[k] - l[k];
      if (range > atr * 1.8 && avg20 > 0 && v[k] > avg20 * 2 && (c[k] - l[k]) / range >= 0.6) { absorb = true; break; }
    }
    return absorb
      ? { phase: '急跌末端', note: `3日急跌${drop3.toFixed(1)}%後出現承接棒（高潮量、長下影收高）——有人在接貨。此處追空=撿人家出完的；已有空單=獲利保護優先` }
      : { phase: '急跌進行', note: `3日急跌${drop3.toFixed(1)}%（>2.5×ATR）且未見承接——空單順風段（魚身），用移動停利鎖住利潤，出現爆量長下影即離場` };
  } catch (e) { return null; }
}

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
      /* v138：19年實測順勢/逆勢/盤整的期望值無差異，只保留有數據支持的高波動禁令
         （高波動時放空每筆−1.4~−1.8%，t≈−4.5；做多較不差但仍為負且不顯著） */
      if (regime.regime === '高波動危險') fail.push(dir === -1 ? '高波動危險態：19年實測此時放空每筆約虧1.4~1.8%，禁止進場' : '高波動危險態：保本金優先，此狀態禁止進場');
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
    if (dir === 1 && fusion >= 40) warn.push(`FUSION極強區（+${fusion}）：19年116,759樣本驗證，極端強勢後5日上漲率反低於基準（α-2.5）——動能極端≠續漲，不給多單加分，防追高`);
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
    // Amihud流動性聯動（v105）：稀薄=急跌/跳空放大器（風險車道，不分方向）
    try {
      const am = (typeof computeAmihud === 'function') ? computeAmihud(D) : null;
      if (am && am.level === '稀薄') warn.push(`Amihud非流動性第${Math.round(am.pct)}百分位（自身120日）——${am.note}`);
    } catch (e) {}
    // 急跌階段聯動（v103）：空方專屬風控
    try {
      const cp = computeCrashPhase(D);
      if (cp && dir === -1) {
        if (cp.phase === '急跌末端') warn.push(`⛔ ${cp.note}（19年實證：FUSION≤-40跌深處後5日反彈率51.6%）`);
        else pass.push(`✓ ${cp.note}`);
      }
    } catch (e) {}
    // R6 方向限定風險
    // 突破統計聯動：追突破前先看此股歷史成功率（False Breakout Database）
    try {
      if (dir === 1 && typeof computeBreakoutStats === 'function' && typeof computeSetupQuality === 'function') {
        const sqG = computeSetupQuality(D), bsG = computeBreakoutStats(D);
        if (sqG && sqG.breakout && bsG) {
          if (!bsG.isTW) {
            // 非台股：台股38.4%基準不外推（跨市場錯誤外推），僅用此股自身統計
            if (bsG.tier === 'high' && bsG.all.rate >= 48) pass.push(`此股歷史突破成功率 ${bsG.all.rate.toFixed(0)}%（${bsG.all.n}次樣本）——突破品質佳，但仍需設好停損`);
            else warn.push(`此股突破成功率 ${bsG.all.rate.toFixed(0)}%（${bsG.all.n}次樣本${bsG.tier !== 'high' ? '，樣本偏少參考價值有限' : ''}）——追突破普遍假突破率偏高，建議等回測前高${fmt(sqG.breakout.level)}不破再進`);
          } else if (bsG.tier !== 'high') {
            warn.push(`追突破警示：台股19年3,934次突破，成功率僅38.4%（假突破率61.6%）——追突破本質期望值為負。此股樣本僅${bsG.all.n}次不足採信，以台股基準為準；帶量進場較佳（帶量41% vs 無量35%），或等回測前高${fmt(sqG.breakout.level)}不破再進`);
          } else if (bsG.all.rate < 38) {
            warn.push(`此股歷史突破成功率僅 ${bsG.all.rate.toFixed(0)}%（假突破率${bsG.fakeRate.toFixed(0)}%，${bsG.all.n}次），低於台股基準38.4%——追突破期望值明顯為負，建議等回測前高${fmt(sqG.breakout.level)}不破再進`);
          } else if (bsG.all.rate >= 48) {
            pass.push(`此股歷史突破成功率 ${bsG.all.rate.toFixed(0)}%（${bsG.all.n}次），優於台股基準38.4%——但仍未過半，務必設好停損`);
          } else {
            warn.push(`此股突破成功率 ${bsG.all.rate.toFixed(0)}%（${bsG.all.n}次），與台股基準38.4%相當——追突破本質期望值為負，帶量進場較佳（19年：帶量41% vs 無量35%）`);
          }
        }
      }
    } catch (e) {}
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
          if (it && it.verdict === '洗盤' && it.confidence >= 50) warn.push(`意圖研判「洗盤」結構(信心${it.confidence})：量價顯示有承接痕跡。19年5,111事件驗證此判定無方向預測力(α≈0，籌碼/環境分層亦無分化)，但結構上做空需防被掃後軋，停損放寬`);
          else if (it && it.verdict === '出貨' && it.confidence >= 50) warn.push(`意圖研判「出貨」結構(信心${it.confidence})：⚠️ 19年1,509事件驗證，此判定後5日僅47%真的下跌(反指標傾向，法人同步賣超時更易反彈)——不可作為做空依據，僅代表量價結構弱`);
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

/* ══ 【區塊 D】出手紀律門（渲染層＋執行計畫）═══════════════════════════
   ⚠️ ATR一律用 app.js 的 calcATR + 原始價序列（v93修：此處曾有獨立的
      _gateATR，與執行計畫算出不同數值，導致停損/部位前後矛盾）
   ⚠️ 部位/停損/停利/停損線位重疊警告 皆在此區塊，改動任一項須確認
      與 mainforce.js 的 renderPlaybook（劇本卡）數值一致
   ════════════════════════════════════════════════════════════════════ */
/* ══ 【區塊 C3】實際可達目標（MFE分析，v124）═══════════════════════════
   問題：原本停利用固定 R 倍數（R=停損距離），2R/3R 對短線根本達不到——
   實測2313的2R目標是28.5%，但歷史上持有5日達成率 0.0%、10日僅 1.0%。
   使用者總是「還沒到目標就先出場或被停損」，因為目標本身就不切實際。

   專業做法（機構常用的 MFE / Maximum Favorable Excursion 分析）：
   統計此股歷史上「進場後 N 日內最大有利偏移」的分布，用實際分位數當目標，
   而不是用公式推算。中位數＝一半機率能達到，75分位＝約1/4機率。
   同時檢查風報比：若「中位可達幅度 < 停損距離」，這筆交易的結構就是不利的，
   無論方向看得多準都難獲利——這是短線最常見卻最少人算的致命點。
   ⚠️ 逐日重演僅用當日之後的實際走勢，不含任何未來資訊以外的推測。
   ════════════════════════════════════════════════════════════════════ */
function computeRealisticTargets(D, dir, stopDistPct) {
  try {
    const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows;
    const n = c.length;
    if (n < 120) return null;
    const price = D.price || c[n - 1];
    const horizons = [1, 2, 5, 10];
    const out = [];
    for (const H of horizons) {
      const mfes = [];
      for (let i = 60; i < n - H; i++) {
        const entry = c[i];
        if (!entry) continue;
        let ext = entry;
        for (let k = i + 1; k <= i + H; k++) {
          ext = dir === -1 ? Math.min(ext, l[k]) : Math.max(ext, h[k]);
        }
        const mfe = dir === -1 ? (entry - ext) / entry * 100 : (ext - entry) / entry * 100;
        if (isFinite(mfe) && mfe >= 0) mfes.push(mfe);
      }
      if (mfes.length < 50) continue;
      mfes.sort((a, b) => a - b);
      const q = (p) => mfes[Math.floor(mfes.length * p)];
      const med = q(0.5), p75 = q(0.75);
      const rr = stopDistPct > 0 ? med / stopDistPct : null;   // 風報比＝中位可達 ÷ 停損距離
      out.push({
        days: H, n: mfes.length,
        medPct: med, p75Pct: p75,
        medPrice: dir === -1 ? price * (1 - med / 100) : price * (1 + med / 100),
        p75Price: dir === -1 ? price * (1 - p75 / 100) : price * (1 + p75 / 100),
        rr,
      });
    }
    if (!out.length) return null;
    // 現行R倍數目標的歷史達成率（用來揭穿不切實際的目標）
    const rTargets = [2, 3].map(mult => {
      const tgtPct = stopDistPct * mult;
      const res = horizons.map(H => {
        const mfes = [];
        for (let i = 60; i < n - H; i++) {
          const entry = c[i]; if (!entry) continue;
          let ext = entry;
          for (let k = i + 1; k <= i + H; k++) ext = dir === -1 ? Math.min(ext, l[k]) : Math.max(ext, h[k]);
          const mfe = dir === -1 ? (entry - ext) / entry * 100 : (ext - entry) / entry * 100;
          if (isFinite(mfe)) mfes.push(mfe);
        }
        const hit = mfes.length ? mfes.filter(x => x >= tgtPct).length / mfes.length * 100 : null;
        return { days: H, hit };
      });
      return { mult, tgtPct, res };
    });
    return { rows: out, rTargets, price, stopDistPct, dir };
  } catch (e) { return null; }
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
      // ATR統一用app.js的calcATR（Wilder平滑，業界標準）+原始市價序列（下單價位鐵律）
      // v93修：原本此處有獨立的_gateATR（簡單平均+還原價），與執行計畫/劇本的calcATR
      // 算出不同數值（實測2313差14.7%、2330差7.8%），導致停損價與部位大小前後不一致
      const atr = calcATR(D.rawHighs || D.highs, D.rawLows || D.lows, D.rawCloses || D.closes, 14);
      let smart = null;
      try { if (typeof computeSmartStop === 'function') smart = computeSmartStop(D, atr); } catch (e) {}
      const entry = D.rawCloses ? D.rawCloses[D.rawCloses.length - 1] : D.price;
      const stop = smart ? smart[planSide].stop : (planSide === 'long' ? entry - 2 * atr : entry + 2 * atr);
      // 聯動：停損若恰落在圖形線位上=全市場停損聚集區，最易被掃——提示外移
      let stopLineWarn = '';
      try {
        if (typeof computeChartPatterns === 'function') {
          const cp2 = computeChartPatterns(D);
          if (cp2) {
            const hitL = cp2.patterns.find(p => Math.abs(stop - p.level) / p.level * 100 < cp2.tol || (p.level2 && Math.abs(stop - p.level2) / p.level2 * 100 < cp2.tol));
            if (hitL) stopLineWarn = `<div style="font-size:10px;color:var(--warn);line-height:1.5;margin-top:4px">📐 注意：停損價恰與「${hitL.kind}」線位重疊——這是全市場停損聚集區，最易被插針掃損後反轉。建議往結構外再讓 0.5~1 倍ATR。</div>`;
          }
        }
      } catch (e) {}
      const dist = Math.abs(entry - stop);
      const sgn = planSide === 'long' ? 1 : -1;
      const tp1 = entry + sgn * 2 * dist;   // v107：只保留2R單一目標（第二目標改為文字規則，見下方執行卡）
      const cur = D.currency === 'TWD' ? '' : '$';
      const pc = planSide === 'long' ? 'var(--buy)' : 'var(--sell)';
      /* ── v107 倉位管理兩條鐵律 + 數字整合 ──────────────────────────────
         ① 2%原則：單筆風險超過2%即視為違規，強制以2%計算並警示
         ② 6%原則：本月淨虧損達6%→本月停止開新倉（食人魚咬死帳戶的防線）
         ③ 數字整合：原本部位/進場/停損/停利2R/3R 共5個數字，短線實戰
            只需要「進場→停損→目標」三個，依執行順序排成一行；第二目標
            改為文字規則不再給第二個價位（多一個價位=多一次猶豫）
         ⚠️ 系統只回報預算狀態，不自動改任何參數（決策仍在人手上）
         ──────────────────────────────────────────────────────────── */
      const rb = window._riskBudget || null;
      const rule2Violate = riskPct > 2;
      const effRiskPct = Math.min(riskPct, 2);          // 2%原則硬上限
      let riskAmt2 = capital * effRiskPct / 100;
      if (half) riskAmt2 = riskAmt2 / 2;
      const lots2 = (D.currency === 'TWD') ? (dist > 0 ? Math.floor(riskAmt2 / (dist * 1000)) : 0) : (dist > 0 ? Math.floor(riskAmt2 / dist) : 0);
      /* v107修：不足1張時原本只說「不足1張」，但台股2020年起有盤中零股交易——
         高價股在2%風險下算出0張是正常的（2330約74股），直接給零股數才可執行。
         這是「符合現實」而非「數學上不足」：不給零股數等於逼使用者自己心算或超額下單。 */
      const shr2 = dist > 0 ? Math.floor(riskAmt2 / dist) : 0;
      const sizeTxt2 = D.currency === 'TWD'
        ? (lots2 >= 1 ? lots2 + ' 張' + (shr2 - lots2 * 1000 >= 1 ? `（＋${shr2 - lots2 * 1000} 零股）` : '')
                      : (shr2 >= 1 ? shr2 + ' 股（零股，2%風險下不足1張屬正常）' : '風險額不足最小單位——此股停損距離過大，跳過'))
        : (shr2 >= 1 ? shr2 + ' 股' : '不足1股');

      if (rb && rb.blocked) {
        // 6%原則熔斷：本月已虧6%，停止開新倉
        html += `<div style="border:2px solid var(--sell);border-radius:12px;padding:12px;margin-bottom:10px;background:var(--sell)12">
          <div style="font-size:14px;font-weight:800;color:var(--sell);margin-bottom:6px">🛑 6%原則熔斷 — 本月停止開新倉</div>
          <div style="font-size:11px;color:var(--muted);line-height:1.7">本月（${rb.ym}）真實單淨虧損已達 <b style="color:var(--sell)">${rb.usedPct}%</b>（${rb.trades}筆），觸及6%上限。<br>
          Elder鐵律：連續小虧（食人魚）滅絕的帳戶遠多於單次大虧。此時最該做的不是找下一筆翻本，是<b>停手到月底、檢討這${rb.trades}筆的共通點</b>。<br>
          既有部位照原計畫管理（停損不動、該停利就停利），但<b>不開新倉</b>。</div>
        </div>`;
      } else {
        html += `<div style="border:2px solid ${pc};border-radius:12px;padding:12px;margin-bottom:10px;background:${pc}0a">
        <div style="font-size:13px;font-weight:800;color:${pc};margin-bottom:8px">🎯 執行計畫 — ${planSide==='long'?'做多':'做空'}${half?'（黃燈半量試單）':''}</div>
        <div style="background:var(--bg);border:1px solid ${pc}40;border-radius:10px;padding:10px;margin-bottom:8px">
          <div style="font-size:9px;color:var(--muted2);margin-bottom:6px">這筆交易只需要記住三個數字（依執行順序）</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;font-family:var(--mono)">
            <div style="text-align:center;flex:1"><div style="font-size:9px;color:var(--muted2)">進場</div><div style="font-size:15px;font-weight:800;color:var(--fg)">${cur}${fmt(entry)}</div></div>
            <div style="color:var(--muted2);font-size:11px">→</div>
            <div style="text-align:center;flex:1"><div style="font-size:9px;color:var(--muted2)">🛑 停損</div><div style="font-size:15px;font-weight:800;color:var(--sell)">${cur}${fmt(stop)}</div></div>
            <div style="color:var(--muted2);font-size:11px">→</div>
            <div style="text-align:center;flex:1"><div style="font-size:9px;color:var(--muted2)">✅ 目標</div><div style="font-size:15px;font-weight:800;color:var(--buy)">${cur}${fmt(tp1)}</div></div>
          </div>
          <div style="text-align:center;margin-top:8px;padding-top:8px;border-top:1px dashed var(--bd)">
            <span style="font-size:9px;color:var(--muted2)">部位</span> <b style="font-size:14px;font-family:var(--mono);color:${pc}">${sizeTxt2}</b>
            <span style="font-size:9px;color:var(--muted2)">（風險${effRiskPct}%${half?'÷2':''}＝${cur}${Math.round(riskAmt2).toLocaleString()}）</span>
          </div>
        </div>
        <div style="font-size:10px;color:var(--muted);line-height:1.7">
          ${(() => {
            /* v124：把「目標為2R」改成此股歷史實際可達的目標。
               原本的R倍數目標對短線不切實際（實測2313的2R=28.5%，5日達成率0.0%），
               使用者永遠「還沒到目標就先出場或被停損」。改用MFE分位數＋風報比檢查。 */
            try {
              const stopPct = dist / entry * 100;
              const rt = computeRealisticTargets(D, planSide === 'long' ? 1 : -1, stopPct);
              if (!rt) return `📏 <b>目標為2R</b>（賺賠比1:2）：到價出50%、停損移至成本、剩餘用移動停利<br>`;
              const pick = rt.rows.find(r => r.days === 5) || rt.rows[rt.rows.length - 1];
              const r2 = (rt.rTargets.find(x => x.mult === 2) || {}).res || [];
              const hit5 = (r2.find(x => x.days === 5) || {}).hit;
              const rr = pick.rr;
              const rrCol = rr >= 1.5 ? 'var(--buy)' : rr >= 1 ? 'var(--warn)' : 'var(--sell)';
              return `${(() => {
                /* v137 參數掃描＋樣本外複驗（8檔153筆挑選 → 另10檔270筆驗證，含0.287%做空成本）：
                   規律「停損越寬越差」樣本外重現（排名相關0.89）；唯一正值 0.5×/1× 的+0.020% 在樣本外為-0.232%；
                   保守執行假設（隔日開盤進場、同K先算停損、跳空開盤成交、進出各1檔）下20組全為負。 */
                return `<div style="margin:6px 0;padding:7px 9px;background:var(--warn)0d;border:1px dashed var(--warn);border-radius:7px;font-size:10px;line-height:1.6">
                  ⚖️ <b>停損寬窄的實測取捨</b>（20組參數，8檔挑選＋另10檔樣本外複驗，含成本）：<b>停損越寬越差</b>的規律在樣本外重現，可信；
                  但原本唯一為正的「0.5×ATR停損＋1×ATR目標」(+0.020%) 在另10檔為 -0.232%，改用保守執行假設（隔日開盤進場、跳空以開盤成交、進出各滑1檔）後20組全為負。
                  下方建議停損為結構位計算值（較寬、不易被掃）；改用近停損可以少虧，但<b>目前沒有任何參數能證明扣成本後賺錢</b>。
                </div>`;
              })()}
              📏 <b>此股歷史實際可達</b>（非公式推算，逐日重演${pick.n}個樣本）：
                ${rt.rows.map(r => `${r.days}日 ${r.medPct.toFixed(1)}%→${cur}${fmt(r.medPrice)}`).join('｜')}<br>
                <span style="color:${rrCol}">${rr >= 1.5 ? '✓' : '⚠️'} <b>風報比 ${rr.toFixed(2)}</b>（5日中位可達${pick.medPct.toFixed(1)}% ÷ 停損${stopPct.toFixed(1)}%）${rr < 1 ? '——結構不利：即使方向做對，賺的也少於做錯時賠的。建議跳過此檔，或縮短為當沖/隔日沖並改用更近停損（但留意易被雜訊掃損）' : rr < 1.5 ? '——勉強可做，務必嚴守停損與時間停損' : '——結構有利'}</span><br>
                ${(() => {
                  /* v137 執行摩擦：升降單位（原始價）＋隔夜跳空越過停損頻率（還原價比率，開收同基準） */
                  if (D.currency !== 'TWD') return '';
                  const tk = twTick(entry), tkPct = tk / entry * 100, nT = dist / tk;
                  const o = D.opens, c = D.closes; let gN = 0, gT = 0;
                  if (o && o.length === c.length) for (let i = 1; i < c.length; i++) { if (!o[i] || !c[i - 1]) continue; gT++; if ((planSide === 'long' ? c[i - 1] - o[i] : o[i] - c[i - 1]) / c[i - 1] * 100 >= stopPct) gN++; }
                  const gp = gT ? gN / gT * 100 : null;
                  const bad = nT < 5 || tkPct >= 0.4;
                  return `<span style="color:${bad ? 'var(--warn)' : 'var(--muted2)'}">🧾 執行摩擦：此價位1檔＝${tk}元（${tkPct.toFixed(2)}%），停損距離約 ${nT.toFixed(0)} 檔；停損多以市價觸發，實際虧損≈停損＋1檔${gp != null ? `｜隔夜跳空≥停損距離的歷史頻率 ${gp.toFixed(1)}%（跳空時以開盤價成交，虧損大於計畫）` : ''}${bad ? '——每檔成本占比偏高，短線近停損不利' : ''}</span><br>`;
                })()}
                ${hit5 != null && hit5 < 10 ? `<span style="color:var(--muted2)">（參考：傳統2R目標${(stopPct * 2).toFixed(1)}%在此股5日內的歷史達成率僅 ${hit5.toFixed(1)}%，故不採用）</span><br>` : ''}
                到價出50%、停損移至成本、剩餘用移動停利跟到走完<br>`;
            } catch (e) { return `📏 目標：到價出50%、停損移至成本、剩餘移動停利<br>`; }
          })()}
          ${rule2Violate ? `<span style="color:var(--sell)">⚠️ 你設定的風險 ${riskPct}% 超過2%原則上限，已強制以2%計算。單筆風險>2%＝一次重傷就打亂全年節奏</span><br>` : `✓ 2%原則：單筆風險 ${effRiskPct}%（上限2%）`}<span onclick="showHelp('riskrules')" style="cursor:pointer;color:var(--muted2);margin-left:4px">ⓘ</span>
          ${rb ? `<br>${rb.warn ? '⚠️' : '✓'} <b>6%原則</b>：本月已用 <b style="color:${rb.warn ? 'var(--warn)' : 'var(--muted)'}">${rb.usedPct}%</b> / 6%（尚餘${rb.remainPct}%、${rb.trades}筆真實單）${rb.warn ? '——逼近熔斷，此時應降低頻率與部位，而非加碼翻本' : ''}` : ''}
        </div>${stopLineWarn}
        <div style="font-size:10px;color:var(--muted);margin-top:8px">⏱️ 時間停損：3~5日未朝預期發展即全撤，不等價格停損。${(function(){
          try{
            const cc=D.closes,nn=cc.length;if(nn<40)return '';
            const rets=[];
            for(let i=nn-40;i<nn;i++){rets.push((cc[i]-cc[i-1])/cc[i-1]);}
            const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
            const sd=Math.sqrt(rets.reduce((a,x)=>a+(x-mean)**2,0)/rets.length);
            const posVal=D.currency==='TWD'?lots2*1000*entry:lots2*entry;
            if(!posVal)return '';
            const varAmt=Math.round(1.65*sd*posVal);
            return ' 此部位單日95%VaR≈'+(D.currency==='TWD'?'':'$')+varAmt.toLocaleString()+'（正常日95%機率虧損不超過此數，超過=異常日快跑）';
          }catch(e){return '';}
        })()}</div>
      </div>`;
      }
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
/* ══ 【區塊 E】行為推理鏈 ═══════════════════════════════════════════════
   指標 → 行為 → 走向 三層推理。每個 behaviors.push() 是一票。
   ⚠️ 新增行為時必填 group（若與既有證據共用底層指標），否則同一份證據
      會重複投票（v60共線折減機制依賴此欄位）
   ⚠️ dir=0 表示「不投方向票」（如個股性格、行情階段），這是刻意設計，
      因為它們是時機/統計描述而非方向證據
   ⚠️ 主力意圖的方向票受逐股α閘控（v75）：貝氏收縮後α<2則自動停票
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
    // 依據：19年24檔7,908事件驗證，意圖判定的方向α全體接近0（籌碼/環境條件分層亦無分化）且逐股異質性大（-13~+20），
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
  if (deep && deep.dealer && Math.abs(deep.dealer.selfNet) >= 200) {   // 自行淨額≥200張才有意義
    behaviors.push({
      name: `自營商自行：${deep.dealer.selfNet > 0 ? '買超' : '賣超'}`, actor: '法人',
      dir: deep.dealer.selfNet > 0 ? 1 : -1, strength: 50,
      basis: ['自營商自行買賣超（已剝離權證避險對沖）'],
      read: `近${deep.dealer.days}日自行淨${deep.dealer.selfNet > 0 ? '買' : '賣'} ${Math.abs(deep.dealer.selfNet)} 張——這是自營商真實方向意圖（避險部位不計）`,
    });
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
    behaviors.push({
      name: `環境：${regime.regime}`, actor: '市場',
      dir: 0, strength: regime.regime === '高波動危險' ? 30 : 55,   // v138：順逆勢期望值無差異，不投方向票
      basis: ['ADX趨勢強度', '均線排列', '波動率'],
      read: regime.regime === '高波動危險' ? '此環境所有訊號可靠度大降，部位減半' :
            '背景資訊：19年實測順勢、逆勢的期望值沒有差異，不作方向依據',
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
