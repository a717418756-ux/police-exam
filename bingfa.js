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
   依賴：app.js(sma/calcDMI/calcRSI/$/fmt)、advanced.js(RS)
   ──────────────────────────────────────────────────────────────────
   函式清單（依出現順序）：
     computeShiPower                  — 勢能分數（趨勢/籌碼/量/產業）
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
/* v163 檔案版本宣告：讓前端能查出「站上哪個檔案沒更新到」。
   改這個檔時一併把數字改成當版；config.js 的 FILE_VERS 必須同步（自我檢查會擋）。 */
try { (window.SR_FV = window.SR_FV || {})['bingfa.js'] = 193; } catch (e) {}

/* v159：marginChg5 名為「5日變化」，但後端資料不足 6 筆時是拿現有最舊那筆當基準，
   實際可能只跨 2~3 天。2 天漲 4% 與 5 天漲 4% 意義完全不同，直接套同一個門檻
   會讓紀律門誤擋。chg5N 是後端回報的實際跨距；舊後端沒有此欄位時放行（不改行為）。 */
function marginSpanOK(m) { return !!m && (m.chg5N == null || m.chg5N >= 4); }

/* v183 融資的判讀全站同一套（審查發現）：
   • 原本紀律門／橫幅／行為鏈的「融資增＋價跌」是「5日前任何一點點跌」，融資卡要跌超過 1%——
     同一份資料，紀律門說「禁止做多（散戶接刀）」、融資卡卻說「融資平穩」
   • 券資比門檻 18／20／25 散在五處：19% 時兩張卡說擁擠，紀律門卻給空單「非擁擠」通過
   • 資料落後或最新幾天沒抓到（融資卡已標紅）的融資，照樣在紀律門擋單
   門檻以融資卡為準（融資變化 ±4%、股價 ±1%；券資比 18% 偏高、30% 軋空警報）。 */
const SHORT_RATIO_HOT = 18, SHORT_RATIO_SQUEEZE = 30;
function marginFresh(m) {
  if (!m || m.headMiss > 0) return false;
  const fr = m.dataDate && typeof checkDataFreshness === 'function' ? checkDataFreshness(m.dataDate, 0) : null;
  return !(fr && fr.stale);
}
function marginUsable(m) { return marginFresh(m) && marginSpanOK(m) && m.marginChg5 != null; }
function marginQuadrant(m, D) {   // → 'knife' 散戶接刀｜'chase' 散戶追價｜'healthy' 主力行情｜'flush' 籌碼清洗｜'flat'｜null 不可判讀
  if (!marginUsable(m) || D.closes.length < 6) return null;
  const c = D.closes, n = c.length, chg5 = (barPx(D) - c[n - 6]) / c[n - 6] * 100, mc = m.marginChg5;   // v184 融資是昨天的，股價也看到昨天
  return mc > 4 && chg5 < -1 ? 'knife' : mc > 4 && chg5 > 1 ? 'chase' : mc < -4 && chg5 > 1 ? 'healthy' : mc < -4 && chg5 < -1 ? 'flush' : 'flat';
}

/* ── 勢能分數（觀勢）────────────────────────────────────────────────
   趨勢40% + 籌碼30% + 成交量20% + 產業10%(用RS近似)
   各子項標準化到 0~100，加權合計
   ──────────────────────────────────────────────────────────────── */
/* ══ 【區塊 A】勢能與評分 ═══════════════════════════════════════════════
   computeShiPower / renderBingfa
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
    const priceUp = barPx(D) > barPrev(D);   // v184 量是最後一根K棒的，漲跌也要同一根
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
    // v182：沒資料時以中性 50 計，但畫面要講明，不能看起來像量到的 50
    breakdown: { trend: trendScore, chip: chipScore, vol: volScore, industry: industryScore, chipNA: !chipUsable(D.chip), industryNA: rsRating == null },
    ma: { ma20, ma60, ma120 },
    maAligned: price > ma20 && ma20 > ma60 && ma60 > ma120
  };
}

/* ── 渲染兵法系統卡片 ──────────────────────────────────────────── */
function renderBingfa(D, shi) {
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
    bar('籌碼（觀勢）' + (shi.breakdown.chipNA ? '・無可用資料，以中性50計' : ''), shi.breakdown.chip, '30%', '#0EA5E9') +
    bar('成交量', shi.breakdown.vol, '20%', '#8B5CF6') +
    bar('產業強弱（RS近似）' + (shi.breakdown.industryNA ? '・無大盤基準，以中性50計' : ''), shi.breakdown.industry, '10%', '#F59E0B');

  // MA 排列狀態（順勢而為）
  const maOk = shi.maAligned;
  document.getElementById('bf-ma').innerHTML =
    `<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:${maOk?'var(--buy-d)':'var(--warn-d)'};border-radius:8px">
      <span style="font-size:16px">${maOk?'✅':'⚠️'}</span>
      <span style="font-size:12px;color:${maOk?'var(--buy)':'var(--warn)'}">${maOk?'MA20 > MA60 > MA120 完美多頭排列，順勢可為':'均線未完美多頭排列，順勢條件未滿足'}</span>
    </div>`;

  /* v188 拿掉「交易評分」（與勢能相關 0.96，只多一個沒驗證過的 FUSION 動能）與「+20%/+40% 固定停利」
     （不管波動大小都一樣，10 日內到 +20% 只有 11.8%；停利改看紀律門執行計畫的「此股 5 日中位可達」） */
}

/* ── 綜合決策橫幅（整合兵法分級+健康度+崩跌風險，一句話結論）──────── */
/* ══ 【區塊 B】決策橫幅 ═══════════════════════════════════════════════
   全系統警示的唯一彙整出口。8參數缺一不可（D/regime/mtf為v78新增）。
   ⚠️ 新增警示時：加在 warns 陣列並設優先序 pri，勿另開顯示區塊
   ⚠️ 突破警示門檻(48%)須與區塊D紀律門保持一致，否則同股會被同時
      pass又warn（v90修過此衝突）
   ════════════════════════════════════════════════════════════════════ */
function renderVerdictBanner(shi, D, regime, mtf) {
  const banner = document.getElementById('verdict-banner');
  const inner = document.getElementById('vb-inner');
  if (!banner || !inner) return;
  banner.style.display = 'block';

  const grade = shi.grade;

  // ══ 全系統避險警示彙整（v78 大整合：把 v59-v77 所有已驗證的風險偵測收攏到一處）══
  // 優先序：環境級 > 時機級 > 結構衝突 > 擁擠/槓桿 > 提示級
  const warns = [];
  const addW = (pri, icon, text) => warns.push({ pri, icon, text });
  let syn = null, ms = null, crowd = null;
  try { if (typeof computeMoveStage === 'function') ms = computeMoveStage(D); } catch (e) {}
  try { if (typeof computeBehaviorSynthesis === 'function') syn = computeBehaviorSynthesis({ D, regime, mtf }); } catch (e) {}
  try { if (typeof computeCrowding === 'function') crowd = computeCrowding(D); } catch (e) {}

  try { if (D && D._intraday) addW(1, '⏱', '盤中：今日K棒尚未收完，本頁所有判斷一律以「前一交易日收盤」計算，當天之內不會因為盤中跳動而改變；上方現價仍為即時價，供下單參考。收盤後資料定案，判斷才會更新'); } catch (e) {}
  // v184 用全站同一個「籌碼可用」標準（原本漏了欄位對不上 fieldMiss：籌碼分已改中性，橫幅卻不警告）
  try { const cp = D && D.chip; if (cp && !chipUsable(cp)) addW(1, '📉', `籌碼資料不完整${cp.fieldMiss ? '（證交所欄位對不上）' : ''}${cp.missDates && cp.missDates.length ? `（缺 ${cp.missDates.map(x => String(x).slice(4, 6) + '/' + String(x).slice(6, 8)).join('、')}）` : ''}：籌碼分已改中性、不參與方向判斷——請重新查詢一次，抓齊再看籌碼結論`); } catch (e) {}
  try { if (regime && regime.regime === '高波動危險') addW(1, '🌪', '環境「高波動危險」：19年實測此時放空每筆虧1.42%（禁止放空）；做多不比平常差，但波動大，部位減半'); } catch (e) {}
  try { const ve = volEvent(D); if (ve) addW(2, '📊', `${D._intraday ? '昨日' : '今日'}${VOL_EV[ve]}`); } catch (e) {}
  try { const gc = gapChase(D); if (gc != null) addW(2, '🚀', `開盤跳空 +${gc.toFixed(1)}% 且已爆量：全市場19年實測，這種時候開盤追進每筆−1.79%、勝率19%——不追`); } catch (e) {}
  try { if (ms && ms.stage === '尾端') addW(2, '🌡', `行情「${ms.dirTxt}·尾端」（成熟度${ms.maturity}）：本段已走完此股歷史${ms.magPctl}%波段——順向追單風報比差，等回檔/反彈找位`); } catch (e) {}
  try { if (syn && syn.conflict && syn.conflict.length) addW(3, '⚡', `行為衝突：${syn.conflict[0]}`); } catch (e) {}
  try { if (crowd && crowd.crowding >= 70) addW(4, '👥', `散戶擁擠度 ${crowd.crowding}/100：教科書訊號人人可見，停損密集區易被掃——與主力反向時是陷阱`); } catch (e) {}
  try {
    const mg = (typeof _marginCache !== 'undefined' && _marginCache[D.code]) ? _marginCache[D.code].d : null;
    if (marginQuadrant(mg, D) === 'knife') addW(4, '💳', '融資增+價跌：散戶逆勢接刀象限（歷史最危險），下跌常未完，做多再等');
  } catch (e) {}
  try {
    const dp = (typeof _deepCache !== 'undefined' && _deepCache[D.code]) ? _deepCache[D.code].d : null;
    if (dp && dp.dayTrading && (dp.dayTrading.cur >= 30 || (dp.dayTrading.avg20 > 0 && dp.dayTrading.cur > dp.dayTrading.avg20 * 1.5))) addW(5, '⚡', `當沖比重 ${dp.dayTrading.cur}%：投機盤主導，波動放大且日內訊號雜訊高`);
  } catch (e) {}
  try {
    if (typeof computeChartPatterns === 'function') {
      const cp = computeChartPatterns(D);
      if (cp) {
        /* v188 只認「經過確認的線」且「最後一根K棒真的碰到」——原本只要現價在容差內就算，這條警示 57% 的時間都在亮 */
        const hi = (D.rawHighs || D.highs).slice(-1)[0], lo = (D.rawLows || D.lows).slice(-1)[0];
        const onLine = cp.patterns.find(p => p.confirmed !== false && lo <= p.level && p.level <= hi);
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
  let ew = null;
  try { ew = (typeof checkEarningsWindow === 'function') ? checkEarningsWindow() : null; if (ew) addW(5, '📊', ew.text); } catch (e) {}
  if (!ew) try {   // v187 財報／營收窗口已經提示過就不再重複一條（原本 3～10 日兩條幾乎一樣，佔掉 3 個警示位裡的 2 個）
    // v104 營收公布窗口：台股上市櫃每月10日前須公布月營收——2-10日波段常跨到公布日，
    // 營收意外=跳空，技術停損擋不住跳空。這是基本面對「短線」唯一的直接殺傷路徑
    const d4 = new Date(), dom = d4.getDate();
    if (dom >= 1 && dom <= 10) addW(5, '📊', `月營收公布窗口（每月10日前）：持單跨公布日有跳空風險，技術停損擋不住跳空——重倉單建議在公布前減碼或確認本月已公布（尤其空單遇營收意外年增=軋空跳空）`);
  } catch (e) {}
  try { const etf = (typeof checkETFRebalanceWindow === 'function') ? checkETFRebalanceWindow() : null; if (etf) addW(6, '📅', etf.text + '——留意搶跑效應（概估窗口）'); } catch (e) {}
  warns.sort((a, b) => a.pri - b.pri);

  // ══ 主結論（v78 修復：D 改由參數傳入——先前引用未定義變數導致空方分支靜默失效）══
  let color, bg, title, summary;
  if (grade === 'A' || grade === 'B') {
    color = grade === 'A' ? 'var(--buy)' : '#10B981'; bg = 'var(--buy-d)';
    title = `🟢 ${grade}級標的，多方條件${grade === 'A' ? '完整' : '良好'}`;
    /* v183：橫幅原本只看勢能等級與自己的警示清單——MTF 反向、共振反向、大戶倒貨等紀律門的禁止條件都不在裡面，
       會出現「橫幅：🟢結構乾淨，依紀律門進場」、紀律門：「🔴禁止出手」。紀律門禁止時以紀律門為準 */
    let gL = null; try { const g = computeTradeGate({ D, regime, mtf, shi }); gL = g && g.long; } catch (e) {}
    if (gL && gL.fail.length) { color = 'var(--warn)'; bg = 'var(--warn-d)'; title = `🟡 ${grade}級多方勢能，但紀律門禁止做多`; }
    summary = `勢能 ${shi.shi}分${syn && syn.decisive ? `、行為結構 ${syn.score >= 0 ? '+' : ''}${syn.score}` : ''}。${gL && gL.fail.length ? `出手紀律門禁止做多：${gL.fail[0]}——不進場` : warns.length ? '但有警示需先處理（見下方）' : '結構乾淨，依出手紀律門的執行計畫進場，嚴設停損分批停利'}`;
  } else if (grade === 'C') {
    color = 'var(--warn)'; bg = 'var(--warn-d)';
    title = '🟡 C級標的，勢能普通，謹慎';
    summary = `勢能 ${shi.shi}分。條件中等，不急進場，等更明確訊號或更好價位`;
  } else if (shi.shortGrade === 'A' || shi.shortGrade === 'B') {
    const c = D.closes, n = c.length, rsiV = calcRSI(c, 14);   // v188 PSY（與 RSI 相關 0.88）併入 RSI
    const ma20v = n >= 20 ? c.slice(-20).reduce((a, b) => a + b, 0) / 20 : c[n - 1];
    const biasPct = (D.price - ma20v) / ma20v * 100;
    const drop5 = n >= 6 ? (c[n - 1] - c[n - 6]) / c[n - 6] * 100 : 0;
    const bounceRisk = rsiV <= 30 || biasPct <= -8 || drop5 <= -8;
    if (bounceRisk) {
      color = 'var(--warn)'; bg = 'var(--warn-d)';
      title = '⚠️ 空方勢能強，但此刻「不宜追空」';
      const reasons = [];
      if (rsiV <= 30) reasons.push(`RSI ${rsiV.toFixed(0)} 已入超賣區`);
      if (biasPct <= -8) reasons.push(`負乖離 ${biasPct.toFixed(1)}%（超跌）`);
      if (drop5 <= -8) reasons.push(`近5日急跌 ${drop5.toFixed(1)}%`);
      summary = `雖然空方勢能 ${shi.shortShi} 分，但 ${reasons.join('、')}——這是「跌深隨時技術性反彈」的位置，此刻進空最容易被軋。空單要嘛等反彈到壓力區再進、要嘛放棄。切勿追空殺低。`;
    } else {
      color = 'var(--sell)'; bg = 'var(--sell-d)';
      title = `🔻 空方${shi.shortGrade}級標的，弱勢明確`;
      summary = `空方勢能 ${shi.shortShi}分（趨勢/籌碼/量能同弱），且非跌深超賣區${ms && ms.stage === '尾端' && ms.dir === -1 ? '，但行情已尾端——等反彈找位而非市價追' : '，偏空可依紀律門評估'}。做空嚴守停損`;
      // v187 與多方同一個規則：紀律門禁止做空時以紀律門為準（原本只有多方有這道檢查——橫幅說「空方B級可依紀律門評估」、紀律門卻 🔴）
      let gS = null; try { const g = computeTradeGate({ D, regime, mtf, shi }); gS = g && g.short; } catch (e) {}
      if (gS && gS.fail.length) { color = 'var(--warn)'; bg = 'var(--warn-d)'; title = `🟡 空方${shi.shortGrade}級勢能，但紀律門禁止做空`; summary = `空方勢能 ${shi.shortShi}分。出手紀律門禁止做空：${gS.fail[0]}`; }
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
  document.getElementById('vb-metrics').innerHTML =
    chip('勢能', shi.shi, color) +
    (syn ? chip('行為結構', syn.decisive ? (syn.score >= 0 ? '+' : '') + syn.score : `不足3票`, syn.decisive && syn.score >= 20 ? 'var(--buy)' : syn.decisive && syn.score <= -20 ? 'var(--sell)' : 'var(--muted)') : '') +
    (ms ? chip('行情階段', ms.stage, ms.cls === 'buy' ? 'var(--buy)' : ms.cls === 'sell' ? 'var(--sell)' : 'var(--warn)') : '') +
    '';

  /* ══ v133 綜合研判：依證據等級加權，把散落判斷收斂成一句明確結論 ═════
     原本的「信心指數」只算各維度的共識度，把「已證偽的指標」與「通過
     19年驗證的指標」當等值票在算，信心因此失真。
     改為：只有 EVIDENCE 登記為 A/B 級的項目才計入，X 級（已除權）完全
     不參與；並依 w 加權。同時明確報告「用了幾項證據、缺哪些、衝突幾項」，
     讓使用者知道這個結論建立在什麼之上——而不是一個來路不明的分數。 */
  const judgeEl = document.getElementById('vb-judgement');
  if (judgeEl) {
    try {
      /* v188 拿掉「綜合研判：○○條件較集中（信心 N）」：能投方向票的只剩行為結構（權重 0.5／總權重≥2.9），
         |傾向| 最多 0.17，永遠低於門檻 0.25——實測 100% 都是「證據分散」，是一行不會變的字 */
      judgeEl.innerHTML = '';
      /* v192 🧭 分析方向：把有回測證據的兩件事整合成一句——中期方向（四因子合成，以月計）＋短線風險（紀律門）。
         勢能等級、行為鏈等未經回測的不進這一句 */
      const mid0 = midFactors(D), md = midDirection(mid0);
      if (mid0 && !mid0.why) {
        const gt = computeTradeGate({ D, regime, mtf, shi }), side = x => x.fail.length ? `🔴禁止（${x.fail[0].split('：')[0]}）` : `🟡未禁止${x.warn.length ? `，提醒 ${x.warn.length} 項` : ''}`;
        const sg = x => `${x > 0 ? '+' : ''}${x}%`;
        const act = !md ? '等情報面的月營收資料，才能算出中期方向（目前只有 52 週高點一項）。'
          : md.q === 4 ? '中期有利：可列入持有／分批佈局名單，以「月」為單位評估；短線進場價位與停損照下方執行計畫。'
          : md.q === 0 ? `中期不利：持有者考慮減碼、不宜新買；放空另看紀律門${gt.short.fail.length ? '（目前禁止放空）' : ''}與券源。`
          : `中期沒有明顯優勢（中間三組之後 3 個月平均 ${sg(MID_EV.comp.ex[1])}～${sg(MID_EV.comp.ex[3])}）：不以中期理由進出，短線只做風控。`;
        const col = !md ? 'var(--muted)' : md.q >= 3 ? 'var(--buy)' : md.q <= 1 ? 'var(--sell)' : 'var(--muted)';
        judgeEl.innerHTML += `<div style="margin-top:8px;padding:9px 11px;background:var(--bg);border:1px solid ${col};border-radius:9px;font-size:11px;color:var(--muted);line-height:1.8">
          <div style="font-size:13px;font-weight:800;color:${col}">🧭 分析方向：中期${md ? md.label : '待定'}</div>
          ${md ? `中期（約 3 個月）：四因子合成第 ${md.q + 1}／5 組，歷史上這組之後 3 個月平均超額 <b>${sg(md.ex)}</b><br>` : ''}短線風險：做多 ${side(gt.long)}｜做空 ${side(gt.short)}<br><b>怎麼用：</b>${act}</div>`;
      }
      const cev = computeCondEV(D);
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
          <br><span style="color:var(--muted2)">出場固定為 1×ATR 停損／1.5×ATR 目標／最多10日。</span></div>`;
      }
      const mid = midFactors(D);
      if (mid) {
        const sg = x => `${x > 0 ? '+' : ''}${x}%`, row = (lbl, val, k) => { const q = midQ(val[0], MID_EV[k].cut);
          return `${lbl} ${val[1]}｜約全市場第 ${Math.round(midPct(val[0], MID_EV[k].cut) * 100)} 百分位（第 ${q + 1}／5 組）→ 該組之後3個月平均超額 <b>${sg(MID_EV[k].ex[q])}</b>`; };
        const pctS = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
        let body;
        if (mid.why) body = `不計算：${mid.why}`;
        else {
          const lines = [row('距52週高點', [mid.hi52, pctS(mid.hi52 - 1)], 'hi52')];
          if (mid.sur != null) lines.push(row(`${mid.ym % 100}月營收驚奇`, [mid.sur, `${mid.sur >= 0 ? '+' : ''}${mid.sur.toFixed(1)}`], 'sur'));
          if (mid.rev3 != null) lines.push(row('近3月營收年增', [mid.rev3, pctS(mid.rev3)], 'rev3'));
          if (mid.qual != null) lines.push(row(`盈餘品質（近四季現金流−淨利，至${mid.qq}）`, [mid.qual, `${pctS(mid.qual)}／總資產`], 'qual'));
          if (mid.sur == null) lines.push('月營收、財報：等情報面載入（或此股沒有可比的資料）——合成分數要有營收驚奇才算');
          else { const q = midQ(mid.comp, MID_EV.comp.cut); lines.push(`<b>四者等權合成：第 ${q + 1}／5 組 → 該組之後3個月平均超額 ${sg(MID_EV.comp.ex[q])}</b>（最高組減最低組 +4.7%，2007~14、2015~19、2020~ 三段都成立${mid.qual == null ? '；此股沒有可用的四季財報，盈餘品質以中間值計' : ''}）`); }
          body = lines.join('<br>');
        }
        judgeEl.innerHTML += `<div style="margin-top:8px;padding:9px 11px;background:var(--bg);border:1px solid var(--bd);border-radius:9px;font-size:10px;color:var(--muted);line-height:1.7">
          <div style="font-size:12px;font-weight:700;color:var(--txt);margin-bottom:4px">📊 中期因子（之後 3 個月，全市場 2,125 檔 19 年回測）</div>${body}
          <br><span style="color:var(--muted2)">持有期以月計，與上方短線期望值是不同尺度；位置用歷史分組門檻換算，是大約值；只含現存股票，實際效果可能略小。</span></div>`;
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
      // ① 環境
      if (regime) seg.push({ k: '環境', v: regime.regime === '高波動危險' ? '高波動危險——19年實測此時放空每筆虧1.42%，不放空；做多不比平常差但部位減半' : `${regime.regime}——僅作背景：19年實測順勢、逆勢的期望值沒有差異` });
      // ② 走到哪（溫度計＋持續天數）
      if (ms && ms.maturity != null) {
        seg.push({ k: '進程', v: `${ms.dirTxt}波段已走 ${ms.maturity.toFixed(0)}%${ms.stage === '尾端' ? '——已進尾端，此時追單是接最後一棒' : ms.stage === '初期' ? '——仍在初期，空間相對完整' : '——中段，續走與反轉機率相當'}` });
      }
      // ③ 誰在動（行為結構）
      if (syn) seg.push({ k: '參與者', v: !syn.decisive ? `只有 ${syn.voteCount} 個有方向的行為，不足以判斷走向` : `行為結構 ${syn.score >= 0 ? '+' : ''}${syn.score}${syn.conflict && syn.conflict.length ? `，但有 ${syn.conflict.length} 項證據互相衝突——分歧時勿重倉` : syn.score >= 20 ? '，多方證據集中' : syn.score <= -20 ? '，空方證據集中' : '，證據分散無主導方' }` });
      // ④ 結構是否支持（風報比＝能不能賺）
      try {
        const atrN = calcATR(D.rawHighs || D.highs, D.rawLows || D.lows, D.rawCloses || D.closes, 14);
        const stopPctN = atrN * 2 / (D.price || 1) * 100;
        /* v183：原本用「環境」（X級、已除權）決定算哪一邊，盤整／空頭時對多單也秀空方的風報比、而且沒寫是哪一邊。兩邊都列 */
        const rr5 = d => { const rt = typeof computeRealisticTargets === 'function' ? computeRealisticTargets(D, d, stopPctN) : null; const r = rt && rt.rows ? rt.rows.find(x => x.days === 5) : null; return r ? r.rr : null; };
        const rL = rr5(1), rS = rr5(-1), f = x => x == null ? '—' : '1:' + x.toFixed(2);
        if (rL != null || rS != null) seg.push({ k: '結構', v: `以2×ATR停損計，風報比 做多 ${f(rL)}｜做空 ${f(rS)}${Math.max(rL || 0, rS || 0) < 1 ? '——兩邊都小於1：即使方向做對也難獲利，需等回測關鍵位讓停損變近（見風險卡「出路」）' : ''}` });
      } catch (e) {}
      // ⑤ 翻盤條件（最關鍵：事先寫下我錯了的證據）
      const inval = [];
      if (ms && ms.maturity != null && ms.stage !== '尾端') inval.push('波段進入尾端（溫度計轉「尾端」）');
      if (syn && syn.decisive) inval.push(`行為結構分數翻過 ${syn.score >= 0 ? '-20' : '+20'}`);
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
/* v188 盤中追跳空：全市場 2,136 檔 2006~2026，開盤跳空 7%~9.5%、當日量 ≥50 日均量 3 倍時開盤買進，每筆 −1.79%（271 筆，t −3.6，勝率 19%）。
   只在台股盤中判斷（回測就是在跳空當天開盤進場）；盤中的量還沒收完，已經達到 3 倍才算（只會少報，不會多報） */
/* v190 中期因子（全市場 2,125 檔 2007~2026 每月回測，research_factors.js --composite；之後 3 個月超額、每月五等分）：
   近52週高點（高減低 +3.4%，t 3.1）、月營收驚奇（+4.0%，t 8.6）、近3月營收年增（+2.0%，t 3.2），三者等權合成 +4.4%（t 5.4），
   2007~14／2015~19／2020~ 三段都成立。cut＝各月分組界線的中位數（平台一次只看一檔，用它內插出大約的全市場位置）；
   ex＝五組由低到高的平均 3 個月超額（%）。殖利率只算股價時 t 0.1（原本是股息補法造成的假象），不採用。
   v191 加入盈餘品質（research_finance.js --composite）：扣掉前三者後仍 +2.8%（t 3.8）；四者等權合成高減低 +4.7%（t 5.9），
   三段 +3.4%／+4.5%／+6.4%（財報 2014 年起才有，之前以中間值計，與平台缺值處理相同） */
const MID_EV = {
  hi52: { cut: [0.717, 0.807, 0.869, 0.934], ex: [-1.57, -0.87, -0.04, 0.62, 1.86] },
  sur: { cut: [-1.01, -0.39, 0.25, 1.12], ex: [-2.06, -0.74, -0.10, 0.99, 1.93] },
  rev3: { cut: [-0.076, 0.031, 0.129, 0.311], ex: [-1.57, -0.24, 0.36, 1.04, 0.41] },
  qual: { cut: [-0.0193, 0.0130, 0.0386, 0.0717], ex: [-0.83, -0.48, -0.01, 0.41, 1.00] },
  comp: { cut: [-0.146, -0.042, 0.048, 0.145], ex: [-2.23, -1.07, -0.10, 0.94, 2.44] },
};
function midPct(v, cut) {   // 0~1：分界點對應 20/40/60/80 百分位，之間線性內插，兩端外推到 0／1 為止
  if (v <= cut[0]) return Math.max(0, 0.2 - (cut[0] - v) / (cut[1] - cut[0]) * 0.2);
  if (v >= cut[3]) return Math.min(1, 0.8 + (v - cut[3]) / (cut[3] - cut[2]) * 0.2);
  for (let k = 0; k < 3; k++) if (v < cut[k + 1]) return 0.2 * (k + 1) + (v - cut[k]) / (cut[k + 1] - cut[k]) * 0.2;
}
const midQ = (v, cut) => cut.filter(c => v >= c).length;   // 第幾組（0＝最低 20%，4＝最高 20%）
/* 與回測同樣的排除：只有台股、日均成交值 ≥2,000 萬、近一年沒有單日漲跌 >11%（減資、分割讓原始價失真）。
   營收兩項與盈餘品質來自情報面（FinMind）；只能經由這個函式讀，新聞／AI 方向不准進分數 */
function midFactors(D) {
  if (!D || D.currency !== 'TWD') return null;
  const c = D.rawCloses || D.closes, v = D.volumes, n = c.length;
  if (n < 253) return { why: '資料不足一年' };
  let val = 0; for (let k = n - 20; k < n; k++) val += c[k] * (v[k] || 0);
  if (val / 20 < 2e7) return { why: '日均成交值不到 2,000 萬，回測沒有涵蓋' };
  for (let k = n - 252; k < n; k++) if (Math.abs(c[k] / c[k - 1] - 1) > 0.11) return { why: '近一年有單日漲跌超過 11%（減資、分割等，原始價失真）' };
  const hi52 = c[n - 1] / Math.max(...c.slice(n - 252));
  const ic = typeof _intelCache !== 'undefined' && pcLive(_intelCache[D.code]) && _intelCache[D.code], rv = ic && ic.d && ic.d.revenue, ql = ic && ic.d && ic.d.quality;   // 過期的情報面不用
  const sur = rv && rv.sur != null ? rv.sur : null, rev3 = rv && rv.rev3 != null ? rv.rev3 : null, qual = ql ? ql.acc : null;
  const r = (x, k) => x == null ? 0 : midPct(x, MID_EV[k].cut) - 0.5;   // 回測：缺值＝中間
  return { hi52, sur, rev3, qual, qq: ql ? ql.q : null, ym: rv ? rv.ym : null,
    comp: sur == null ? null : (r(hi52, 'hi52') + r(sur, 'sur') + r(rev3, 'rev3') + r(qual, 'qual')) / 4 };   // 回測：合成需要 52週高點與營收驚奇
}
/* v192 把中期因子合成翻成一句方向（五組的歷史 3 個月超額見 MID_EV.comp.ex）；沒有營收驚奇就沒有合成，回 null */
const MID_DIR = ['偏空', '略偏空', '中性', '略偏多', '偏多'];
function midDirection(mid) {
  if (!mid || mid.why || mid.comp == null) return null;
  const q = midQ(mid.comp, MID_EV.comp.cut);
  return { q, label: MID_DIR[q], ex: MID_EV.comp.ex[q], side: q === 4 ? 'long' : q === 0 ? 'short' : null };
}
/* v193 量價事件（research_volume.js，全市場 2,123 檔 2006~2026，隔日開盤進場、減全市場平均、同日事件先平均）：
   B1 盤整後爆量大漲（前20日高低差≤15%、漲≥5%、量≥3倍）13,161 次：之後 5／20／60 日 −0.63／−0.78／−1.14%，t −8.5／−5.8／−4.5，三段都為負
   A1 爆量大跌（跌≥5%、量≥3倍）7,439 次：之後 1~5 日 −0.26～−0.50%（t −3.5～−5.9），10 日後不顯著；之後量能仍高於平常（不是縮量）
   A2 A1 之後 2~20 日內第一次帶量反彈（漲≥3%、量≥2倍）3,545 次：之後 1／3 日 −0.46／−0.41%，5 日後不顯著
   對照：同樣漲跌但沒爆量的，隔日進場 20 日後都不顯著——「量」才是關鍵。法人／融資拆分都沒有 |t|≥3 的差距，不另外提示。
   只看最近一根完整 K 棒（回測就是事件隔日開盤進場）；排除與回測相同（台股、日均成交值≥2000萬、近60日無單日>11%） */
const VOL_EV = {
  B1: '盤整後爆量大漲：全市場19年13,161次，隔日開盤追進之後20日平均落後0.78%、60日落後1.14%（三段時間都為負）——追價不利',
  A1: '爆量大跌：全市場19年7,439次，隔日進場之後1~5日平均再落後0.3~0.5%（10日後不顯著）——短線先別接刀',
  A2: '爆量大跌後的第一根帶量反彈：全市場19年3,545次，隔日追進之後1~3日平均落後0.4~0.5%——反彈多半只到這裡',
};
function volEvent(D) {
  if (!D || D.currency !== 'TWD') return null;
  const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows, v = D.volumes, n = c.length, i = n - 1;
  if (n < 62) return null;
  let val = 0; for (let k = i - 19; k <= i; k++) val += c[k] * (v[k] || 0);
  if (val / 20 < 2e7) return null;
  for (let k = i - 59; k <= i; k++) if (Math.abs(c[k] / c[k - 1] - 1) > 0.11) return null;
  const base = j => { let s = 0; for (let k = j - 20; k < j; k++) s += v[k] || 0; return s / 20; }, r = j => c[j] / c[j - 1] - 1;
  const crash = j => r(j) <= -0.05 && v[j] >= 3 * base(j);
  let hi = -1, lo = Infinity; for (let k = i - 20; k < i; k++) { hi = Math.max(hi, h[k]); lo = Math.min(lo, l[k]); }
  if ((hi - lo) / lo <= 0.15 && r(i) >= 0.05 && v[i] >= 3 * base(i)) return 'B1';
  if (crash(i)) return 'A1';
  for (let j = i - 2; j >= i - 20; j--) if (crash(j)) {   // 最近一次爆量大跌之後的第一根帶量反彈，剛好是最後一根
    const b = base(j); for (let k = j + 2; k <= i; k++) if (r(k) >= 0.03 && v[k] >= 2 * b) return k === i ? 'A2' : null;
    return null;
  }
  return null;
}
function gapChase(D) {
  if (!D || !D._intraday || D.currency !== 'TWD' || !(D.open > 0) || !(D.volume > 0)) return null;
  const c = D.closes, v = D.volumes, n = c.length; if (n < 50) return null;
  const gap = (D.open / c[n - 1] - 1) * 100, avg50 = v.slice(-50).reduce((a, b) => a + b, 0) / 50;
  return gap >= 7 && gap <= 9.5 && D.volume >= 3 * avg50 ? gap : null;
}
function computeCondEV(D) {
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
    const rgNow = computeRegime(D);   // v188 表已用標準 ADX 重跑，與畫面上的市場狀態同一分類
    const rg = ({ 多頭趨勢: '多頭', 空頭趨勢: '空頭', 盤整: '盤整', 過渡帶: '過渡', 高波動危險: '高波動' })[rgNow && rgNow.regime] || '全部';
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

/* v187 執行計畫的價位基準（紀律門判風報比與下方計畫共用，原本只有計畫在算）：
   ATR 用原始市價（下單價位鐵律）、停損用智慧停損、目標用此股 5 日 MFE 中位可達 */
function planBasis(D, side) {
  const atr = calcATR(D.rawHighs || D.highs, D.rawLows || D.lows, D.rawCloses || D.closes, 14);
  let smart = null;
  try { if (typeof computeSmartStop === 'function') smart = computeSmartStop(D, atr); } catch (e) {}
  const entry = D.rawCloses ? D.rawCloses[D.rawCloses.length - 1] : D.price;
  const stop = smart ? smart[side].stop : (side === 'long' ? entry - 2 * atr : entry + 2 * atr);
  const dist = Math.abs(entry - stop);
  const rtT = computeRealisticTargets(D, side === 'long' ? 1 : -1, dist / entry * 100);
  const pickT = rtT ? (rtT.rows.find(r => r.days === 5) || rtT.rows[rtT.rows.length - 1]) : null;
  return { atr, smart, entry, stop, dist, rtT, pickT, rr: pickT ? pickT.rr : null };
}
function computeTradeGate(ctx) {
  // ctx: { D, regime, mtf, shi }
  const { D, regime, mtf } = ctx;
  const rsi = calcRSI(D.closes, 14);   // v188 PSY（與 RSI 相關 0.88）併入 RSI
  const margin = (typeof _marginCache !== 'undefined' && _marginCache[D.code]) ? _marginCache[D.code].d : null;
  let crowd = null;
  try { if (typeof computeCrowding === 'function') crowd = computeCrowding(D); } catch (e) {}
  let mf = null;
  try { if (typeof computeMainForce === 'function') mf = computeMainForce(D); } catch (e) {}

  const judge = (dir) => { // dir: 1=多, -1=空
    const pass = [], fail = [], warn = [];
    // R1 市場環境（總開關）
    if (regime) {
      /* v138：19年實測順勢/逆勢/盤整的期望值無差異，只保留有數據支持的高波動禁令
         （高波動時放空每筆−1.4~−1.8%，t≈−4.5；做多較不差但仍為負且不顯著） */
      /* v188 只禁止放空：19 年實測高波動時任意日放空每筆 −1.42%（t −6.6）；做多 −0.40% 反而是各盤勢最不差的（平常 −0.83%），
         原本連做多一起禁止沒有數據支持，改為提醒減量 */
      if (regime.regime === '高波動危險') (dir === -1 ? fail : warn).push(dir === -1 ? '高波動危險態：19年實測此時放空每筆虧1.42%（798筆，t−6.6），禁止放空' : '高波動危險態：19年實測此時做多每筆−0.40%，不比平常差（平常−0.83%），但單日波動大——部位減半');
    }
    /* R2 大週期 MTF——v188 由「禁止」改「提醒」：順勢／逆勢 19 年實測期望值無差異（regime 已列 X 級），
       說明頁也寫「紀律門不再因逆勢亮紅燈」，原本這條卻擋掉 43% 的空單。
       v188 拿掉 R3 多維共振（各維度是 MTF／勢能／FUSION 的複本，又用 X 級環境加權）與 R4 FUSION（已刪除） */
    if (mtf) {
      if (mtf.dir === dir) pass.push('週期MTF同向（大週期順風）');
      else if (mtf.dir === -dir) warn.push('週期MTF反向：逆大週期多半只是搶反彈（順逆勢的期望值差異未經驗證，僅提醒）');
      else warn.push('MTF框架衝突：大小週期不一致，勝率打折');
    }
    // R5 反明牌（別站人多的一邊）
    if (crowd) {
      /* v188 陷阱、極度擁擠由「禁止」改「提醒」：真實法人＋融資資料回放（18檔、2025-07~2026-07）兩者後續超額報酬
         雖偏向警示方向（−1.9%、−2.7%），t 只有 −0.4、−0.6，不足以擋單 */
      if (crowd.trap && ((crowd.trap.type === 'bull' && dir === 1) || (crowd.trap.type === 'bear' && dir === -1))) warn.push('明牌陷阱：教科書訊號與你同向但主力反向，你正要跟散戶擠同一邊（未經驗證，僅提醒）');
      else if (crowd.crowdDir === dir && crowd.crowding >= 70) warn.push(`明牌極度擁擠（${crowd.crowding}）：這個結論所有AI散戶都看到了（未經驗證，僅提醒）`);
      else if (crowd.crowdDir === dir && crowd.crowding >= 50) warn.push(`明牌偏擁擠（${crowd.crowding}）：預期先掃停損再走，進場點要選在掃盪後`);
      // v188 拿掉「非擁擠」的預設綠燈：沒有融資／當沖資料時擁擠度最高只到 60，這條 95% 以上都在亮，是預設值不是證據
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
          } else {
            /* v188 全市場實測取代逐股成功率（逐股門檻 38%／48% 從未驗證）：2,136 檔 2006~2026，同一套出場下
               突破 20 日高進場每筆 −1.54%、隨便哪天進場 −0.87%，21 年中 19 年突破較差 */
            warn.push(`追突破：全市場2,136檔19年實測，突破20日高進場每筆−1.54%，比隨便哪天進場（−0.87%）還差，21年中19年較差｜此股過去${bsG.all.n}次突破成功率${bsG.all.rate.toFixed(0)}%——要做就等回測前高${fmt(sqG.breakout.level)}不破再進`);
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
      if (marginFresh(margin) && margin.shortRatio >= SHORT_RATIO_SQUEEZE) warn.push(`券資比 ${margin.shortRatio.toFixed(0)}%：空單擁擠，軋空風險高（未經驗證，僅提醒）`);
      else if (marginFresh(margin) && margin.shortRatio >= SHORT_RATIO_HOT) warn.push(`券資比 ${margin.shortRatio.toFixed(0)}% 偏高，空單控制部位`);
      if (rsi <= 30) warn.push(`RSI ${rsi.toFixed(0)} 超賣區：空單防技術性反彈（你 2313 的教訓）`);
      // 意圖研判：洗盤≠出貨。若研判為洗盤（洗散戶將漲），做空是站到主力對面，禁止
      if (typeof computeIntentAnalysis === 'function') {
        try {
          const it = computeIntentAnalysis(D, mf);
          if (it && it.verdict === '洗盤' && it.confidence >= 50) warn.push(`意圖研判「洗盤」結構(信心${it.confidence})：量價顯示有承接痕跡。19年5,111事件驗證此判定無方向預測力(α≈0，籌碼/環境分層亦無分化)，但結構上做空需防被掃後軋，停損放寬`);
          else if (it && it.verdict === '出貨' && it.confidence >= 50) warn.push(`意圖研判「出貨」結構(信心${it.confidence})：⚠️ 19年1,509事件驗證，此判定後5日僅47%真的下跌(反指標傾向，法人同步賣超時更易反彈)——不可作為做空依據，僅代表量價結構弱`);
        } catch (e) {}
      }
    } else {
      // v188 由「禁止」改「提醒」：真實融資資料回放，此象限後 10 日超額 +0.2%（不比其他時候差），原本擋掉 10.5% 的做多
      const ve = volEvent(D);
      if (ve) warn.push(VOL_EV[ve]);
      const gc = gapChase(D);
      if (gc != null) warn.push(`開盤跳空 +${gc.toFixed(1)}% 且已爆量：全市場19年，跳空7~9.5%帶量時開盤追進每筆−1.79%（271筆，勝率19%）——不追`);
      if (marginQuadrant(margin, D) === 'knife') warn.push('融資增+價跌（散戶接刀象限）：別跟散戶一起接（實測後續不比平常差，僅提醒）');
      if (rsi >= 70) warn.push(`RSI ${rsi.toFixed(0)} 超買區：多單防均值回歸`);
    }

    // R7 大戶與法人（配合聰明錢，絕不對作——資料未載入時自動略過）
    if (mf && mf.confidence >= 50) {
      /* v188 由「禁止」改「提醒」：主力行為推估沒有經過驗證，同一組量價證據的意圖研判 19 年實測 α≈0（出貨甚至是反指標）——
         不可單憑它擋單；有真實資料的千張大戶、借券仍是禁止條件 */
      if (dir === 1 && (mf.behavior === '出貨' || mf.behavior === '誘多')) warn.push(`主力行為推估=${mf.behavior}（信心${mf.confidence}）：量價結構偏弱，做多留意（推估未經驗證，僅提醒）`);
      if (dir === -1 && mf.behavior === '吸籌') warn.push(`主力行為推估=吸籌（信心${mf.confidence}）：量價結構有承接，做空留意（推估未經驗證，僅提醒）`);
      if (dir === -1 && (mf.behavior === '誘空' || mf.behavior === '洗盤')) warn.push(`${mf.behavior}型態進行中：空單易被掃後軋`);
      if (dir === 1 && mf.behavior === '吸籌') pass.push(`主力吸籌同向（信心${mf.confidence}）`);
      if (dir === -1 && mf.behavior === '出貨') warn.push(`主力行為呈出貨結構（信心${mf.confidence}）：注意此結構經19年大樣本驗證無方向優勢，不構成空單加分，僅供結構參考`);
    }
    const deep = (typeof _deepCache !== 'undefined' && _deepCache[D.code]) ? _deepCache[D.code].d : null;
    if (deep && deep.big) {
      const b = deep.big;
      // v188 由「禁止」改「提醒」：千張大戶資料是真的，但「大戶增＝會漲」從未回測（FinMind 此資料集需付費等級，無法取得歷史驗證）
      if (dir === -1 && b.bigChg > 0.3 && b.smallChg < -0.2) warn.push(`千張大戶吸籌中（+${b.bigChg}%）：逆大戶結構做空（未經驗證，僅提醒）`);
      if (dir === 1 && b.bigChg < -0.3 && b.smallChg > 0.2) warn.push(`大戶倒貨給散戶（${b.bigChg}%）：別當接貨的散戶（未經驗證，僅提醒）`);
      if (dir === -1 && b.bigChg < -0.3 && b.smallChg > 0.2) pass.push(`大戶倒貨結構（空單結構順風）`);
      if (dir === 1 && b.bigChg > 0.3 && b.smallChg < -0.2) pass.push(`籌碼流向大戶（多單結構順風）`);
    }
    if (deep && deep.lend) {
      if (dir === -1 && marginSpanOK(deep.lend) && deep.lend.chg5 >= 8) pass.push(`法人借券空單增 +${deep.lend.chg5}%（機構隊友）`);
      if (dir === -1 && marginSpanOK(deep.lend) && deep.lend.chg5 <= -8) warn.push(`法人借券回補中（${deep.lend.chg5}%）：空方主力撤退，別戀戰`);
    }
    const mid = midFactors(D);   // v190 中期因子合成：最高／最低 20% 才列（中間三組超額接近 0）
    if (mid && mid.comp != null) { const q = midQ(mid.comp, MID_EV.comp.cut), ex = MID_EV.comp.ex[q];
      if (q === 4 || q === 0) ((q === 4 ? 1 : -1) === dir ? pass : warn).push(`中期因子${q === 4 ? '最強' : '最弱'} 20%（52週高點＋營收＋盈餘品質）：全市場19年，之後3個月平均超額 ${ex > 0 ? '+' : ''}${ex}%——此方向${(q === 4 ? 1 : -1) === dir ? '順風' : '逆風'}（中期，非短線）`); }
    // 風報比：與執行計畫同一套算法（此股 5 日中位可達 ÷ 停損距離）
    try { const pb = planBasis(D, dir === 1 ? 'long' : 'short');
      if (pb.rr != null && pb.rr < 1) warn.push(`風報比 ${pb.rr.toFixed(2)} < 1：此股5日中位可達 ${pb.pickT.medPct.toFixed(1)}% 小於停損距離 ${(pb.dist / pb.entry * 100).toFixed(1)}%，方向做對也賺得比停損少`); } catch (e) {}

    /* v188 裁決只剩兩級：有回測證據的條件（目前只有高波動）才「禁止」，其餘一律列為提醒。
       原本的「可出手」需要 3 個綠燈：只有股價資料 896 個時點、加真實籌碼 2175 個時點都是 0 次，
       而且綠燈越多後續報酬並沒有越好——是到不了、也沒有證據的一級，已移除 */
    const verdict = fail.length ? '禁止出手' : warn.length ? `未觸禁止｜提醒 ${warn.length} 項` : '未觸禁止條件';
    const vClass = fail.length ? 'no' : 'ok';
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

  const colMap = { ok: 'var(--warn)', no: 'var(--sell)' };
  const iconMap = { ok: '🟡', no: '🔴' };
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
    /* v192 做哪一邊：先看有回測證據的中期因子（最強／最弱 20%），沒有中期訊號時才退回勢能等級（A/B 做多、空A/空B 做空，未經回測）。
       該邊被禁止就不給；計畫一律是試單：風險預算減半 */
    const sh = ctx.shi, md = midDirection(midFactors(D));
    const want = md && md.side ? md.side : !sh ? null : (sh.grade === 'A' || sh.grade === 'B') ? 'long' : (sh.shortGrade === 'A' || sh.shortGrade === 'B') ? 'short' : null;
    const planSide = want && g[want].vClass !== 'no' ? want : null;
    const basis = md && md.side ? `方向依據：中期因子${md.side === 'long' ? '最強' : '最弱'} 20%（回測 3 個月 ${md.ex > 0 ? '+' : ''}${md.ex}%）` : '方向依據：勢能等級（未經回測，僅供參考）';

    if (!planSide) {
      html += `<div style="padding:12px;text-align:center;background:var(--bg);border:1px dashed var(--bd);border-radius:10px;margin-bottom:10px;font-size:13px;font-weight:700;color:var(--muted)">⛔ 今日此標的無戰事<div style="font-size:11px;font-weight:400;color:var(--muted2);margin-top:3px">不出手，就是最精準的打擊</div></div>`;
    } else {
      const capital = parseFloat(document.getElementById('in-capital')?.value) || 1000000;
      const riskPct = parseFloat(document.getElementById('in-risk')?.value) || 1;
      // ATR統一用app.js的calcATR（Wilder平滑，業界標準）+原始市價序列（下單價位鐵律）
      // v93修：原本此處有獨立的_gateATR（簡單平均+還原價），與執行計畫/劇本的calcATR
      // 算出不同數值（實測2313差14.7%、2330差7.8%），導致停損價與部位大小前後不一致
      const { entry, stop, dist, rtT, pickT } = planBasis(D, planSide);
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
      const sgn = planSide === 'long' ? 1 : -1;
      /* v140：目標改為此股5日MFE中位可達價（原本卡片仍顯示2R，與下方「2R不採用」的說明矛盾）；資料不足才退回2R */
      const tp1 = pickT ? pickT.medPrice : entry + sgn * 2 * dist;
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
      riskAmt2 = riskAmt2 / 2;   // 試單：見上方 planSide 說明
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
        html += `<div style="border:2px solid var(--sell);border-radius:12px;padding:12px;margin-bottom:10px;background:var(--sell-d)">
          <div style="font-size:14px;font-weight:800;color:var(--sell);margin-bottom:6px">🛑 6%原則熔斷 — 本月停止開新倉</div>
          <div style="font-size:11px;color:var(--muted);line-height:1.7">本月（${rb.ym}）真實單淨虧損已達 <b style="color:var(--sell)">${rb.usedPct}%</b>（${rb.trades}筆${rb.noAmt ? `，另有${rb.noAmt}筆沒填股數未計入` : ''}），觸及6%上限。<br>
          Elder鐵律：連續小虧（食人魚）滅絕的帳戶遠多於單次大虧。此時最該做的不是找下一筆翻本，是<b>停手到月底、檢討這${rb.trades}筆的共通點</b>。<br>
          既有部位照原計畫管理（停損不動、該停利就停利），但<b>不開新倉</b>。</div>
        </div>`;
      } else {
        html += `<div style="border:2px solid ${pc};border-radius:12px;padding:12px;margin-bottom:10px;background:${pc}0a">
        <div style="font-size:13px;font-weight:800;color:${pc};margin-bottom:8px">🎯 執行計畫 — ${planSide==='long'?'做多':'做空'}（試單，風險減半）<div style="font-size:10px;font-weight:400;color:var(--muted)">${basis}</div></div>
        <div style="background:var(--bg);border:1px solid ${pc}40;border-radius:10px;padding:10px;margin-bottom:8px">
          <div style="font-size:9px;color:var(--muted2);margin-bottom:6px">這筆交易只需要記住三個數字（依執行順序）${D._intraday ? '｜盤中：以下價位以前一交易日收盤為基準，實際下單請用現價與結構位微調' : ''}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;font-family:var(--mono)">
            <div style="text-align:center;flex:1"><div style="font-size:9px;color:var(--muted2)">進場</div><div style="font-size:15px;font-weight:800;color:var(--fg)">${cur}${fmt(entry)}</div></div>
            <div style="color:var(--muted2);font-size:11px">→</div>
            <div style="text-align:center;flex:1"><div style="font-size:9px;color:var(--muted2)">🛑 停損</div><div style="font-size:15px;font-weight:800;color:var(--sell)">${cur}${fmt(stop)}</div></div>
            <div style="color:var(--muted2);font-size:11px">→</div>
            <div style="text-align:center;flex:1"><div style="font-size:9px;color:var(--muted2)">✅ 目標${pickT ? `（${pickT.days}日中位）` : '（2R）'}</div><div style="font-size:15px;font-weight:800;color:var(--buy)">${cur}${fmt(tp1)}</div></div>
          </div>
          <div style="text-align:center;margin-top:8px;padding-top:8px;border-top:1px dashed var(--bd)">
            <span style="font-size:9px;color:var(--muted2)">部位</span> <b style="font-size:14px;font-family:var(--mono);color:${pc}">${sizeTxt2}</b>
            <span style="font-size:9px;color:var(--muted2)">（風險${effRiskPct}%÷2＝${cur}${Math.round(riskAmt2).toLocaleString()}）</span>
          </div>
        </div>
        ${(() => {
          const ce = computeCondEV(D); if (!ce) return '';
          const s = planSide === 'long' ? ce.long : ce.short, v = s.setups.length ? s.setups[0].v : s.base;
          return `<div style="font-size:10px;margin-bottom:6px;color:${v[0] < 0 ? 'var(--warn)' : 'var(--buy)'}">💰 此情境19年實測期望值 <b>${v[0] >= 0 ? '+' : ''}${v[0].toFixed(2)}%/筆</b>（${s.setups.length ? '型態「' + s.setups[0].name + '」' : '無已回測型態，用同盤勢任意日'}，${v[1].toLocaleString()}筆，已含成本滑價）${v[0] < 0 ? '——紀律門放行只代表沒有明顯禁忌，不代表期望值為正' : ''}</div>`;
        })()}
        <div style="font-size:10px;color:var(--muted);line-height:1.7">
          ${(() => {
            /* v124：把「目標為2R」改成此股歷史實際可達的目標。
               原本的R倍數目標對短線不切實際（實測2313的2R=28.5%，5日達成率0.0%），
               使用者永遠「還沒到目標就先出場或被停損」。改用MFE分位數＋風報比檢查。 */
            try {
              const stopPct = dist / entry * 100;
              const rt = rtT;
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
                return `<div style="margin:6px 0;padding:7px 9px;background:var(--warn-d);border:1px dashed var(--warn);border-radius:7px;font-size:10px;line-height:1.6">
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
          ${rb ? `<br>${rb.warn ? '⚠️' : '✓'} <b>6%原則</b>：本月已用 <b style="color:${rb.warn ? 'var(--warn)' : 'var(--muted)'}">${rb.usedPct}%</b> / 6%（尚餘${rb.remainPct}%、${rb.trades}筆真實單${rb.noAmt ? `；<span style="color:var(--warn)">其中${rb.noAmt}筆沒填股數、金額未計入——實際可能已用更多</span>` : ''}）${rb.warn ? '——逼近熔斷，此時應降低頻率與部位，而非加碼翻本' : ''}` : ''}
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
    四、沒有必勝法：19年實測常見短線型態扣成本後皆為負，贏在「不出手的紀律」+「壓低成本」+「停損放在掃不到的地方」
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
  const { D, regime, mtf } = ctx;
  const behaviors = [];   // { name, actor, dir(-1/0/1), strength(0~100), basis[], read }

  // ── 行為① 主力意圖（洗盤/出貨/進貨）──
  let mf = null, intent = null;
  try { if (typeof computeMainForce === 'function') mf = computeMainForce(D); } catch (e) {}
  try { if (typeof computeIntentAnalysis === 'function' && mf) intent = computeIntentAnalysis(D, mf); } catch (e) {}
  if (intent && intent.confidence > 0) {
    // ── 逐股α閘控（v75核心）：此判定在「這支股票」的歷史α決定它有沒有方向投票權 ──
    // 依據：19年24檔7,908事件驗證，意圖判定的方向α全體接近0（籌碼/環境條件分層亦無分化）且逐股異質性大（-13~+20），
    // 全域方向投票已無正當性；改為逐股實證——α經貝氏收縮（James-Stein，Efron & Morris 1975）
    // 防小樣本誤判：shrunkα = α × n/(n+20)，樣本越少越往0收縮。shrunkα≥2 才保留方向票。
    let intentDir = intent.dir === 'up' ? 1 : intent.dir === 'down' ? -1 : intent.dir === 'bounce' ? 1 : 0;
    let alphaNote = '';
    try {
      const bt = typeof computeIntentBacktest === 'function' ? computeIntentBacktest(D) : null;
      // v187 回測只統計信心≥50 的判定；信心不到 50 的這一次不在被驗證過的範圍內，不給方向票
      if (intent.confidence < 50) { intentDir = 0; alphaNote = `（信心 ${intent.confidence} 未達回測驗證的門檻 50，方向票停用）`; }
      else if (bt && bt.stats[intent.verdict] && bt.stats[intent.verdict].n >= 5) {
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
  try { if (typeof computeCrowding === 'function') crowd = computeCrowding(D); } catch (e) {}
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
  if (marginFresh(margin)) {
    const q = marginQuadrant(margin, D);
    // 券資比已經算進上面的「散戶擁擠（空方）」票時不再重投（同一份證據不計兩次）
    const crowdUsedShort = crowd && crowd.crowdDir === -1 && crowd.crowding >= 70 && margin.shortRatio >= SHORT_RATIO_HOT;
    let mDir = 0, mRead = '融資融券無明顯異常';
    if (q === 'knife') { mDir = -1; mRead = '融資增+價跌＝散戶逆勢接刀（歷史上最危險的象限），下跌常未完'; }
    else if (q === 'healthy') { mDir = 1; mRead = '融資減+價漲＝籌碼從散戶流向主力（最健康的上漲）'; }
    // v184：券資比門檻與融資卡「軋空警報」同一條線（原本寫死 25）
    else if (margin.shortRatio >= SHORT_RATIO_SQUEEZE && !crowdUsedShort) { mDir = 1; mRead = `券資比${margin.shortRatio.toFixed(0)}%＝散戶空單擁擠，軋空燃料充足`; }
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
  if (deep && deep.lend && marginSpanOK(deep.lend) && Math.abs(deep.lend.chg5) >= 8) {
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

  // v188 拿掉「個股統計性格（自相關）」：顯著的比例 5.9%，與 95% 檢定本身 5% 的誤報率相同＝雜訊

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

  /* v187 decisive：有方向的行為不足 3 個時，分數只是一兩票的比例（1 票就是 ±100）——行為鏈卡寫「走向不明」，
     橫幅、綜合研判、敘事原本卻照樣拿 ±100 當方向證據。其他地方一律先看這個旗標 */
  return { behaviors, score, direction, dirClass, conflict, voteCount: votes.length, decisive: votes.length >= 3 };
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
    <div style="font-size:11px;color:var(--muted);margin-top:3px">${syn.decisive ? `綜合分數 ${syn.score >= 0 ? '+' : ''}${syn.score}（-100全空 ~ +100全多）｜由 ${syn.voteCount} 個有方向的行為加權合成` : `只有 ${syn.voteCount} 個有方向的行為（需 3 個），不計分——一兩票的比例（1 票就是 ±100）沒有意義`}</div>
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
