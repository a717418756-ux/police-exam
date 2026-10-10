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
   ──────────────────────────────────────────────────────────────────
   後續新增區塊（v64起，函式較長建議用函式名搜尋定位）：
     computeRegime                    — Market Regime市場狀態辨識
                                         （趨勢/盤整/高波動），驅動共振
                                         動態權重+紀律門R1+橫幅警示
     computeMoveStage / renderMoveStage — 行情溫度計（波段成熟度百分位，
                                         ZigZag/ATR自適應），renderMoveStage
                                         尾端掛computeSetupQuality顯示
     computeSetupQuality               — 突破/拉回結構檢查清單(X/4非機率)
     computeBreakoutStats              — 逐股突破成功率統計(False Breakout
                                         Database)，有記憶化_bsMemo
     computeIntradayProfile            — 日內型態（跳空方向→歷史條件頻率）
   ──────────────────────────────────────────────────────────────────
   近期版本異動：
     v64  行情溫度計（逐股ZigZag波段百分位）首次加入
     v82  突破/拉回結構檢查清單（誠實版：清單非機率），修過1次假突破情境雷
          （price>hi20×0.995在平盤時恆真，已改為需真正站上/觸及前高）
     v85  日內型態引擎（機率=該股自身歷史頻率，非模型預測）
     v87  突破統計引擎首次加入；18檔2年小樣本曾誤判「帶量無鑑別力」
     v88  19年3,934次驗證推翻v87結論：帶量確有鑑別力(+6.4pp)，已撤回修正
          （本檔案第4次小樣本教訓，含此次共4例，詳見reader.md）
     v89  computeBreakoutStats加isTW欄位，非台股不套用台股38.4%基準
     v90  computeBreakoutStats加記憶化_bsMemo（4處呼叫共用同一結果）
   ⚠️ 已知地雷／注意事項：
     - computeBreakoutStats的_bsMemo為全域記憶化，測試環境需注入
       global._bsMemo={k:null,v:null}才能eval測試，否則ReferenceError
     - 任何「此股突破成功率」文字修改，須同步檢查banner/gate/temperature
       card/support-resistance四處是否已對齊（v90前曾4處各講一次造成
       訊息轟炸，現規則：溫度計卡=詳細版，其餘=一句話+門檻對齊48%）
     - 小樣本教訓：本檔任何新統計結論在<100樣本時都應視為假說而非結論，
       必須用backtest_standalone.js在19年24檔全量驗證後才能寫死進系統文字
   ══════════════════════════════════════════════════════════════════════ */
/* v163 檔案版本宣告：讓前端能查出「站上哪個檔案沒更新到」。
   改這個檔時一併把數字改成當版；config.js 的 FILE_VERS 必須同步（自我檢查會擋）。 */
try { (window.SR_FV = window.SR_FV || {})['enhance.js'] = 198; } catch (e) {}

/* ══ 區塊 H：ADX 市場狀態過濾器 ════════════════════════════════════════
   機構73%使用：ADX 不告訴方向，而是告訴你「該用哪種策略」
   ADX>25 趨勢明確→用趨勢指標；ADX<20 盤整→用震盪指標或觀望
   ════════════════════════════════════════════════════════════════════ */
/* ══ 【新增區塊 H】Market Regime 市場狀態辨識 ═══════════════════════════
   趨勢盤/盤整盤/高波動 → 驅動：共振動態權重、紀律門R1、決策橫幅警示
   ⚠️ 這不只是顯示用的分類，改動判定門檻會連動改變共振的指標權重分配
   ════════════════════════════════════════════════════════════════════ */
function computeRegime(D) {
  const dmi = calcDMI(D.highs, D.lows, D.closes, 14);
  const c = D.closes, n = c.length;
  // 波動百分位（近10日日均振幅 vs 近120日分布）
  const rangePct = (i) => (D.highs[i] - D.lows[i]) / c[i] * 100;
  let recent = 0; for (let i = n - 10; i < n; i++) recent += rangePct(i);
  recent /= 10;
  const hist = [];
  for (let i = Math.max(20, n - 120); i < n - 10; i++) hist.push(rangePct(i));
  const volPct = hist.length ? Math.round(hist.filter(x => x <= recent).length / hist.length * 100) : 50;
  // 近20日回撤
  const peak20 = Math.max(...c.slice(-20));
  const dd20 = (c[n-1] - peak20) / peak20 * 100;

  let regime, advice, cls, icon;
  if (volPct >= 88 && dd20 < -6) {
    regime = '高波動危險'; icon = '🌪️'; cls = 'bear';
    advice = `波動位於近半年前 ${100-volPct}% 極端區且20日回撤 ${dd20.toFixed(1)}% → 恐慌/劇烈換手狀態。19年實測：此時放空每筆虧1.42%（禁止放空）；做多每筆−0.40%，反而比平常（−0.83%）不差——但單日波動大，部位減半。`;
  } else if (dmi.adx >= 25 && dmi.pdi > dmi.ndi) {
    regime = '多頭趨勢'; icon = '📈'; cls = 'bull';
    advice = `ADX ${dmi.adx.toFixed(0)} 多方主導 → 趨勢明確，RSI超買會鈍化（強勢股一直超買）。註：19年實測順勢、逆勢的期望值沒有差異，本狀態只作背景，不作方向依據。`;
  } else if (dmi.adx >= 25 && dmi.ndi >= dmi.pdi) {
    regime = '空頭趨勢'; icon = '📉'; cls = 'bear';
    advice = `ADX ${dmi.adx.toFixed(0)} 空方主導 → 趨勢明確，RSI超賣會鈍化（弱勢股一直超賣）。註：19年實測順勢、逆勢的期望值沒有差異，本狀態只作背景，不作方向依據。`;
  } else if (dmi.adx < 20) {
    regime = '盤整'; icon = '🔄'; cls = 'neutral';
    advice = `ADX ${dmi.adx.toFixed(0)} 無趨勢 → 信「震盪工具」：RSI/KD高賣低買、支撐壓力區間操作。追突破易被巴。搭配下方壓縮指數：極度壓縮時準備迎接變盤。`;
  } else {
    regime = '過渡帶'; icon = '⚖️'; cls = 'neutral';
    advice = `ADX ${dmi.adx.toFixed(0)} 趨勢醞釀中，減少部位等方向確認。`;
  }
  // 壓縮指數（大變盤前兆）
  let compression = null;
  try { if (typeof computeCompression === 'function') compression = computeCompression(D); } catch(e) {}
  if (compression && compression.level !== 'normal') advice += `｜🔋 ${compression.desc}`;
  return { adx: dmi.adx, pdi: dmi.pdi, ndi: dmi.ndi, regime, advice, cls, icon, volPct, compression };
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

/* v182 籌碼可不可用（全站同一個標準）：最新幾天沒抓到、資料落後、或 T86 欄名配不到——
   都不可投票或計分。原本只有籌碼卡與共振維度檢查，主力行為、明牌陷阱、健康度、情報判讀直接讀原始數字 */
function chipUsable(chip) {
  return !!chip && !(chip.headMiss > 0) && !chip.fieldMiss && !(chip.expected && String(chip.dataDate || '') < String(chip.expected));
}
function computeChipHealth(chip, D) {
  let score = 50;
  const signals = [], warnings = [];

  // v100防呆：顯示法人資料日期（T86為T+1盤後公布；日期若非最近交易日=資料延遲，一眼可辨）
  if (chip.dataDate) {
    const dd = String(chip.dataDate);
    let freshTxt = `📅 法人資料日期：${dd.slice(4,6)}/${dd.slice(6,8)}（每交易日盤後更新）`;
    try {
      // v121：先看是不是「抓取失敗」造成的假舊資料（headMiss>0＝最近幾天沒抓到）
      if (chip.missDates && chip.missDates.length) {
        warnings.push(`⚠️ 籌碼抓取不完整：${chip.missDates.map(d => String(d).slice(4, 6) + '/' + String(d).slice(6, 8)).join('、')} 這幾天沒取到（TWSE 限流或逾時）——本卡籌碼分已改為中性50、不參與任何方向判斷，請重新查詢一次`);
      } else if (chip.gapMiss > 0 && !chip.headMiss) {
        signals.push(`ℹ️ 較舊的 ${chip.gapMiss} 天沒取到（TWSE 限流）：最新5日完整，20日累計改以實際取得的 ${chip.n20 || chip.days} 天計算`);
      }
      /* v159：不論原因，只要 20 日累計其實不足 20 天就必須明講。
         以前這個數字照樣叫「20日累計」，使用者無從得知它只用了幾天。 */
      if (chip.n20 != null && chip.n20 < 20) {
        warnings.push(`⚠️ 「20日累計」實際只用了 ${chip.n20} 個交易日的資料（抓取期間逢連假、或部分日子沒抓到）——請把它當成 ${chip.n20} 日累計讀，別跟完整20日的門檻直接比較`);
      }
      if (chip.n5 != null && chip.n5 < 5) {
        warnings.push(`⚠️ 「5日累計」實際只用了 ${chip.n5} 個交易日——樣本不足，本卡的法人方向判斷請降權看待`);
      }
      if (chip.headMiss > 0 && !(chip.missDates && chip.missDates.length)) {
        warnings.push(`⚠️ 籌碼抓取不完整：最近6個交易日有 ${chip.headMiss} 天沒取到（TWSE 限流或逾時）——目前顯示的 ${String(chip.dataDate).slice(4,6)}/${String(chip.dataDate).slice(6,8)} 可能不是真正的最新日。請重新查詢一次；若反覆如此，代表 TWSE 該時段連線不穩`);
      }
      const fr = (typeof checkDataFreshness === 'function') ? checkDataFreshness(chip.dataDate, 0) : null;
      if (fr && fr.stale) {
        warnings.push(`⚠️ 法人資料落後：目前顯示 ${dd.slice(4,6)}/${dd.slice(6,8)}，預期應有 ${fr.expected.slice(4,6)}/${fr.expected.slice(6,8)} 的資料（約差${fr.gapDays}個交易日）——可能是TWSE尚未公布、後端快取未更新，或非交易時段查詢。此處籌碼判斷請暫緩採信，建議稍後重查`);
      }
    } catch (e2) {}
    signals.push(freshTxt);
  }
  // v103 法人轉向日偵測：法人進出是分多天走的，等5日合計翻負已慢3-4天——
  // 「連買陣中第一根大賣」（或連賣陣中第一根大買）就是轉向日，第一天最值錢
  try {
    // v159：原本一律除以 5，但 foreign5 在資料不足時其實只累加了 2~4 天，
    // 平均值被低估 → 「法人轉向日」的門檻跟著變鬆，會多報。改用實際天數。
    const f5avg = Math.abs(chip.foreign5) / Math.max(1, chip.n5 || 5);
    if (chip.foreign5 > 0 && chip.foreign1 < -Math.max(f5avg * 1.5, 500)) warnings.push(`⚡ 法人轉向日：外資5日累計買超但「今日」轉大賣${Math.abs(chip.foreign1)}張——法人出貨分多天走，第一天轉向最值錢，別等5日合計翻負才反應`);
    else if (chip.foreign5 < 0 && chip.foreign1 > Math.max(f5avg * 1.5, 500)) signals.push(`⚡ 法人轉向日：外資5日累計賣超但「今日」轉大買${chip.foreign1}張——若隔日續買=空單的離場鬧鐘`);
  } catch (e) {}
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

  // v182：除以實際天數（n5/n20）。原本固定除 5、除 20——只抓到 8 天時 20 日均被低估一半多，假性「5日>20日＝吸籌」
  const avg5 = (chip.foreign5 + chip.trust5) / Math.max(1, chip.n5 != null ? chip.n5 : 5);
  const avg20 = (chip.foreign20 + chip.trust20) / Math.max(1, chip.n20 != null ? chip.n20 : 20);
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
    const priceUp = barPx(D) > barPrev(D);   // v184 量與價同一根K棒
    if (priceUp && vr > 1.5) { score += 6; signals.push(`量增價漲（${vr.toFixed(1)}倍量），資金進場推升，量價齊揚`); volNote='healthy'; }
    else if (!priceUp && vr > 1.5) { score -= 8; warnings.push(`量增價跌（${vr.toFixed(1)}倍量），疑似主力出貨換手`); volNote='distribution'; }
    else if (vr < 0.5) { warnings.push('窒息量，成交極度萎縮，多空觀望，留意變盤'); volNote='dead'; }
    else if (priceUp && vr < 0.8) { warnings.push('量縮價漲，買盤接手意願低，動能不足'); volNote='weak'; }
  }

  /* v141：資料不完整或落後時，籌碼分一律回中性50——
     否則「抓到哪幾天」會讓勢能分數、共振、紀律門在同一天之內忽多忽空，
     使用者看到的是決策跳動，而不是市場真的變了。 */
  const unreliable = !chipUsable(chip);
  if (chip.fieldMiss) warnings.push(`⚠️ 證交所法人資料的欄名變了，程式配不到外資／投信欄（實際欄名：${String(chip.fieldMiss).slice(0, 60)}…）——這幾天的籌碼不可用，請回報以便更新`);
  if (unreliable) {
    score = 50;
    if (!chip.missDates || !chip.missDates.length) warnings.push('⚠️ 籌碼資料不是最新，本卡籌碼分已改為中性50、不參與方向判斷，請重新查詢一次');
  }
  score = Math.max(0, Math.min(100, score));
  let verdict, vClass;
  if (score >= 75) { verdict = '籌碼集中、法人站買方（未經報酬回測）'; vClass = 'buy'; }
  else if (score >= 60) { verdict = '籌碼偏多，法人站買方，可留意'; vClass = 'buy'; }
  else if (score >= 45) { verdict = '籌碼中性，法人態度不明，觀望'; vClass = 'warn'; }
  else if (score >= 30) { verdict = '籌碼偏空，法人站賣方，謹慎'; vClass = 'sell'; }
  else { verdict = '籌碼鬆散、主力撤離，易跌難漲，避開'; vClass = 'sell'; }
  return { score, verdict, vClass, signals, warnings, concentration, volNote, unreliable };
}

function renderChip(chip, D) {
  const card = document.getElementById('chip-card');
  if (!chip) {   // v197 台股抓不到法人資料要明講（原本整張卡無聲消失）
    card.style.display = D && D.chipErr ? 'block' : 'none';
    if (D && D.chipErr) document.getElementById('chip-grid').innerHTML = `<div style="grid-column:1/-1;font-size:12px;color:var(--sell);line-height:1.6">⚠️ ${escI(D.chipErr)}——籌碼分以中性計，請稍後按 ⟳ 重抓</div>`;
    return;
  }
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

/* v188 拿掉區塊 C「市場環境總分」（未驗證的兩項不計分後只剩 28～67 分，「偏多 ≥70」永遠到不了；VIX 原值改顯示在大盤卡）
   與區塊 D「多週期回測」（同一組 9 訊號投票，同家族的專屬分數 α=-4.4、機率卡 LogLoss 劣於基準） */

/* ══ 區塊 E：進出場劇本 ═══════════════════════════════════════════════ */
function renderPlaybook(D, atr) {
  const card = document.getElementById('playbook-card');
  card.style.display = 'block';
  const price = D.rawCloses ? D.rawCloses[D.rawCloses.length - 1] : D.price;
  const cur = D.currency === 'TWD' ? '' : '$';
  // 智慧停損：結構位之外+動態緩衝（防主力掃停損後反向走）
  let smart = null;
  try { if (typeof computeSmartStop === 'function') smart = computeSmartStop(D, atr); } catch(e) {}
  const longStop = smart ? smart.long.stop : price - atr * 2;
  const shortStop = smart ? smart.short.stop : price + atr * 2;
  const distL = price - longStop, distS = shortStop - price;
  /* v188 停利改用此股 5／10 日中位可達價（與紀律門執行計畫同一套 MFE 統計）。原本 2R/3R：實測 10 日內到 2R 只有 10.5%、
     3R 3.9%——幾乎永遠「還沒到目標就先出場」。資料不足 120 日時明講算不出，不拿 R 倍數硬湊 */
  const tgt = (dir, dist) => { const rt = computeRealisticTargets(D, dir, dist / price * 100), r = d => rt && rt.rows ? rt.rows.find(x => x.days === d) || null : null; return [r(5), r(10)]; };
  const [longTp1, longTp2] = tgt(1, distL), [shortTp1, shortTp2] = tgt(-1, distS);
  const stopPct = ((smart ? distL : atr*2) / price * 100).toFixed(1);
  const tpBox = (lbl, t) => `<div class="risk-box"><div class="rb-label">✅ ${lbl}</div><div class="rb-value" style="color:var(--buy)">${t ? cur + fmt(t.medPrice) : '—'}</div><div class="rb-sub">${t ? `${t.days}日中位可達 ${t.medPct.toFixed(1)}%${t.rr != null ? `｜風報比 1:${t.rr.toFixed(2)}` : ''}` : '資料不足 120 日，算不出此股實際可達幅度'}</div></div>`;

  const scenario = (title, color, entry, stop, tp1, tp2, stopNote) => `
    <div style="border:1px solid var(--bd);border-radius:12px;padding:12px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:800;color:${color};margin-bottom:10px">${title}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="risk-box"><div class="rb-label">🎯 參考進場</div><div class="rb-value">${cur}${fmt(entry)}</div><div class="rb-sub">${D._intraday ? '昨日收盤（盤中以完整K棒計）' : '最近收盤'}</div></div>
        <div class="risk-box"><div class="rb-label">🛑 智慧停損</div><div class="rb-value" style="color:var(--sell)">${cur}${fmt(stop)}</div><div class="rb-sub">${stopNote}</div></div>
        ${tpBox('停利一（出50%）', tp1)}
        ${tpBox('停利二（出25%）', tp2)}
      </div>
    </div>`;

  const noteL = smart ? `${smart.long.method}${smart.long.sweepRate!=null?`｜此股「跌破支撐後又收回」比率 ${(smart.long.sweepRate*100).toFixed(0)}%（掃損特性，決定停損緩衝大小）`:''}` : `2×ATR 下方 ${stopPct}%`;
  const noteS = smart ? `${smart.short.method}${smart.short.sweepRate!=null?`｜此股「突破壓力後又收回」比率 ${(smart.short.sweepRate*100).toFixed(0)}%（掃損特性，決定停損緩衝大小）`:''}` : `2×ATR 上方 ${stopPct}%`;
  document.getElementById('pb-rows').innerHTML =
    scenario('📈 做多劇本', 'var(--buy)', price, longStop, longTp1, longTp2, noteL) +
    scenario('📉 做空劇本', 'var(--sell)', price, shortStop, shortTp1, shortTp2, noteS) +
    `<div style="font-size:10px;color:var(--muted);line-height:1.6;padding:8px 4px">💡 分批停利：到停利一（此股5日中位可達）出50%、停利二（10日中位）出25%、剩25%用移動停利。風報比 &lt;1＝方向做對也賺得比停損少，這筆不划算。做空風險較高（虧損理論無上限），務必嚴守停損。<br>⏱️ 時間停損：進場 3~5 日未朝預期方向發展即離場——短線單不快贏通常不會贏，做空尤甚（拖著的空單還在付借券與除息成本）。<br>🛡️ 智慧停損原理：主力最愛掃「整數ATR位/結構位正下方」的停損，故本系統把停損放在<b>結構位之外＋動態緩衝</b>（該股越愛假跌破，緩衝越大），降低「剛停損就反向走」的機率。</div>`;

  // ── 日內型態（此股歷史條件頻率，非模型預測）──
  try {
    const ip = typeof computeIntradayProfile === 'function' ? computeIntradayProfile(D) : null;
    if (ip) {
      let hint = '';
      if (ip.bucket === '開高' && ip.dist.find(x => x.k === '走低' && x.shift > 3)) hint = '此股開高後沖高回落的傾向高於平常——不追開盤價，等回測支撐再說';
      else if (ip.bucket === '開低' && ip.dist.find(x => x.k === '走高' && x.shift > 3)) hint = '此股開低後收復的傾向高於平常——開盤恐慌殺低常是日內低點，空單別追殺';
      else if (ip.bucket === '開平' && ip.dist.find(x => x.k === '盤整' && x.shift > 3)) hint = '無跳空日此股偏向區間整理——日內突破需量能確認';   // v188 原本無條件顯示（38% 的時間都在講），改為統計真的偏向盤整才說
      const rows = ip.dist.map(x => `<span style="margin-right:10px">${x.k} <b style="font-family:var(--mono);color:${x.shift>3?'var(--warn)':'var(--txt)'}">${x.p.toFixed(0)}%</b><span style="color:var(--muted2);font-size:9px">(基準${x.base.toFixed(0)}${x.shift>=0?'+':''}${x.shift.toFixed(1)})</span></span>`).join('');
      document.getElementById('pb-rows').innerHTML += `<div style="margin-top:8px;padding:8px 10px;background:var(--bg);border:1px solid var(--bd);border-radius:8px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px">🕐 日內型態｜今日${ip.bucket}（跳空${ip.todayGap>=0?'+':''}${ip.todayGap.toFixed(1)}%）→ 此股${ip.n}個同型開局日的收盤走向：</div>
        <div style="font-size:11px">${rows}</div>
        ${hint ? `<div style="font-size:10px;color:var(--warn);line-height:1.5;margin-top:4px">💡 ${hint}</div>` : ''}
        <div style="font-size:9px;color:var(--muted2);margin-top:4px">機率＝此股自身歷史頻率（±${ip.wilson.toFixed(0)}%信賴半寬），非預測模型；位移(±)為相對此股無條件基準的變化，位移才是資訊。盤中查詢時「今日走向」尚未定案。</div>
      </div>`;
    }
  } catch (e) {}
}

/* ══ 區塊 F：風險強化（最大回撤 + 波動率排名）════════════════════════ */
function computeRiskMetrics(D) {
  const c = D.closes;
  // 最大回撤（過去一年＝最近 252 根；v183：原本用了全部約兩年的K棒，卻標「近一年」，回撤被放大、健康分被壓低）
  const c1 = c.slice(-252);
  let peak = c1[0], maxDD = 0;
  for (const p of c1) { peak = Math.max(peak, p); maxDD = Math.min(maxDD, (p - peak) / peak); }
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

/* v188 拿掉區塊 G「健康度體檢」：把趨勢橫幅、風險指標、籌碼卡、市場總分重新打一次分數，沒有新資訊 */

/* ══ 行情溫度計：波段成熟度（初期/中期/尾端）═══════════════════════════
   解決「方向判對但進場在訊號尾端」的問題（2885追高/2313追空的真實教訓）。
   方法：ZigZag切出該股2年所有歷史波段（轉折門檻=ATR自適應），
   把「當前進行中波段」的幅度與天數，放進該股自己的歷史分布看百分位——
   幅度已超過歷史80%波段＝行情尾端，別追、持有者分批停利。
   全部用該股自身統計，無跨股魔術數字，天生逐股校準。
   ════════════════════════════════════════════════════════════════════ */
/* ══ 【新增區塊 I】行情溫度計（波段成熟度）═══════════════════════════════
   ZigZag切波段 → 當前波段幅度/天數在該股歷史的百分位 → 初期/中期/尾端
   ⚠️ 百分位基準用「該股自身歷史」，勿改成跨股統一門檻（逐股校準是設計核心）
   ⚠️ 尾端判定會觸發：紀律門warn、決策橫幅警示、行為鏈時機條目(dir=0)
   ════════════════════════════════════════════════════════════════════ */
function computeMoveStage(D) {
  const c = D.closes, n = c.length;
  if (n < 120) return null;
  // ATR自適應轉折門檻（%）：波動大的股票需要更大的反向幅度才算波段結束
  let trSum = 0;
  for (let i = n - 20; i < n; i++) trSum += Math.abs(c[i] - c[i - 1]) / c[i - 1];
  const thr = Math.max(0.03, (trSum / 20) * 3);   // 至少3%，或3倍日均變動

  // ZigZag：切出所有波段 {dir, days, magPct}
  const runs = [];
  let pivotI = 0, pivotP = c[0], dir = 0, extI = 0, extP = c[0];
  for (let i = 1; i < n; i++) {
    if (dir >= 0 && c[i] > extP) { extP = c[i]; extI = i; }
    if (dir <= 0 && c[i] < extP) { extP = c[i]; extI = i; }
    if (dir === 0) { dir = c[i] > pivotP ? 1 : -1; extP = c[i]; extI = i; continue; }
    const retr = dir === 1 ? (extP - c[i]) / extP : (c[i] - extP) / extP;
    if (retr >= thr) {
      runs.push({ dir, days: extI - pivotI, magPct: Math.abs(extP - pivotP) / pivotP * 100 });
      pivotI = extI; pivotP = extP; dir = -dir; extP = c[i]; extI = i;
    }
  }
  // 當前進行中波段（未被反轉確認）
  const cur = { dir, days: n - 1 - pivotI, magPct: Math.abs(c[n - 1] - pivotP) / pivotP * 100 };
  const hist = runs.filter(r => r.dir === cur.dir);
  if (hist.length < 8) return null;   // 同向歷史波段太少，百分位無意義

  const pct = (arr, x) => Math.round(arr.filter(v => v <= x).length / arr.length * 100);
  const magPctl = pct(hist.map(r => r.magPct), cur.magPct);
  const dayPctl = pct(hist.map(r => r.days), cur.days);

  // 量能衰竭：波段後半量能是否低於前半（動能遞減佐證）
  let volFade = false;
  if (cur.days >= 6) {
    const seg = D.volumes.slice(pivotI, n);
    const half = Math.floor(seg.length / 2);
    const v1 = seg.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const v2 = seg.slice(half).reduce((a, b) => a + b, 0) / (seg.length - half);
    volFade = v2 < v1 * 0.75;
  }

  const maturity = Math.round(magPctl * 0.55 + dayPctl * 0.3 + (volFade ? 15 : 0));
  let stage, advice, cls;
  const dirTxt = cur.dir === 1 ? '上漲' : '下跌';
  if (maturity >= 70) {
    stage = '尾端'; cls = 'sell';
    advice = cur.dir === 1
      ? `本段上漲幅度已超過此股歷史${magPctl}%的上漲波段——持有者分批停利、未進場者別追高（2885教訓：追在連漲末端）`
      : `本段下跌幅度已超過此股歷史${magPctl}%的下跌波段——空單分批回補、未進場者別追空殺低（2313教訓：追在跌勢末端）`;
  } else if (maturity >= 40) {
    stage = '中期'; cls = 'warn';
    advice = `${dirTxt}波段進行中，幅度位於此股歷史第${magPctl}百分位——已持有可續抱，新進場需拉回/反彈找位，不宜市價追`;
  } else {
    stage = '初期'; cls = 'buy';
    advice = `${dirTxt}波段尚屬初期（幅度僅第${magPctl}百分位）——離此股歷史波段的尾端還遠（溫度計未經報酬回測，方向以中期因子為準）`;
  }
  return { stage, cls, maturity, dir: cur.dir, dirTxt, curDays: cur.days, curMag: cur.magPct,
    magPctl, dayPctl, volFade, histCount: hist.length, advice };
}

function renderMoveStage(D) {
  const card = document.getElementById('movestage-card');
  if (!card) return;
  let ms = null;
  try { ms = computeMoveStage(D); } catch (e) {}
  if (!ms) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const col = ms.cls === 'buy' ? 'var(--buy)' : ms.cls === 'sell' ? 'var(--sell)' : 'var(--warn)';
  document.getElementById('movestage-content').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <div style="font-size:22px;font-weight:800;color:${col}">${ms.dirTxt}·${ms.stage}</div>
      <div style="flex:1">
        <div style="height:8px;background:var(--bg);border-radius:4px;overflow:hidden"><div style="width:${Math.min(100, ms.maturity)}%;height:100%;background:linear-gradient(90deg,var(--buy),var(--warn),var(--sell))"></div></div>
        <div style="font-size:9px;color:var(--muted2);margin-top:2px">成熟度 ${ms.maturity}/100（初期→尾端）</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--txt);line-height:1.65;padding:9px 11px;background:${col}10;border:1px solid ${col}50;border-radius:8px">${ms.advice}</div>
    <div style="display:flex;gap:6px;margin-top:8px">
      <div style="flex:1;text-align:center;background:var(--bg);border-radius:6px;padding:5px"><div style="font-size:9px;color:var(--muted)">本段幅度</div><div style="font-family:var(--mono);font-size:12px;font-weight:700">${ms.curMag.toFixed(1)}%</div><div style="font-size:9px;color:var(--muted2)">第${ms.magPctl}百分位</div></div>
      <div style="flex:1;text-align:center;background:var(--bg);border-radius:6px;padding:5px"><div style="font-size:9px;color:var(--muted)">持續天數</div><div style="font-family:var(--mono);font-size:12px;font-weight:700">${ms.curDays}日</div><div style="font-size:9px;color:var(--muted2)">第${ms.dayPctl}百分位</div></div>
      <div style="flex:1;text-align:center;background:var(--bg);border-radius:6px;padding:5px"><div style="font-size:9px;color:var(--muted)">量能</div><div style="font-family:var(--mono);font-size:12px;font-weight:700;color:${ms.volFade ? 'var(--sell)' : 'var(--buy)'}">${ms.volFade ? '衰竭' : '正常'}</div><div style="font-size:9px;color:var(--muted2)">後半vs前半</div></div>
    </div>
    <div style="font-size:10px;color:var(--muted2);margin-top:8px;line-height:1.6">💡 百分位基準＝此股自己2年的 ${ms.histCount} 段同向歷史波段（ZigZag/ATR自適應切分），非跨股通用門檻。尾端≠必反轉，是「風報比變差」——解決「方向判對但進場在訊號尾端」的問題。</div>`;

  // 聯動：突破/拉回結構品質檢查（切入時機的具體化）
  try {
    const sq = typeof computeSetupQuality === 'function' ? computeSetupQuality(D) : null;
    if (sq) {
      let qh = '';
      const block = (title, obj, extra) => {
        let s = `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--bd)">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:11px;font-weight:700">${title}</span><span style="font-family:var(--mono);font-size:12px;font-weight:700;color:${obj.passed >= 3 ? 'var(--buy)' : obj.passed === 2 ? 'var(--warn)' : 'var(--sell)'}">${obj.passed}/4 項通過</span></div>`;
        obj.checks.forEach(ck => { s += `<div style="font-size:10px;color:${ck.ok ? 'var(--muted)' : 'var(--muted2)'};padding:1px 0">${ck.ok ? '✓' : '✗'} ${ck.txt}</div>`; });
        if (extra) s += extra;
        return s + `</div>`;
      };
      if (sq.breakout) {
        let bkNote = '';
        try {
          const bs = typeof computeBreakoutStats === 'function' ? computeBreakoutStats(D) : null;
          if (bs) {
            const col = bs.all.rate >= 55 ? 'var(--buy)' : bs.all.rate <= 45 ? 'var(--sell)' : 'var(--warn)';
            bkNote = `<div style="margin-top:5px;padding:6px 8px;background:${col}10;border:1px dashed ${col};border-radius:6px;font-size:10px;color:var(--muted);line-height:1.55">
              📊 <b>此股歷史突破統計</b>：過去 ${bs.all.n} 次站上前高，<b style="color:${col}">成功率 ${bs.all.rate.toFixed(0)}%</b>（±${bs.all.ci.toFixed(0)}%）→ <b>假突破率 ${bs.fakeRate.toFixed(0)}%</b>
              ${bs.vol && bs.novol ? `<br>帶量突破 ${bs.vol.rate.toFixed(0)}%(${bs.vol.n}次) vs 無量 ${bs.novol.rate.toFixed(0)}%(${bs.novol.n}次)` : ''}
              ${bs.tier !== 'high' ? `<br><span style="color:var(--warn)">⚠️ 樣本僅${bs.all.n}次（${bs.tier === 'low' ? '過少，此股數字參考價值低' : '可信度中等'}）${bs.isTW ? '，請以台股基準為主要依據' : '，請謹慎參考'}</span>` : ''}${bs.isTW ? `<br>台股基準：19年24檔3,934次突破平均成功率僅 38.4%（假突破率61.6%）${bs.tier === 'high' ? (bs.all.rate < 38 ? '<br>⚠️ 此股低於台股平均——追突破期望值明顯為負，寧可等回測前高不破再進' : bs.all.rate >= 48 ? '<br>✓ 此股突破品質優於台股平均' : '') : ''}` : '<br><span style="color:var(--muted2)">（38.4%為台股實證基準，不套用於非台股市場；此處僅呈現本股自身統計）</span>'}</div>`;
          }
        } catch (e2) {}
        qh += block(`📈 突破結構檢查（前高 ${fmt(sq.breakout.level)}）`, sq.breakout,
          `<div style="font-size:9px;color:var(--muted2);margin-top:3px">清單為可驗證的量價事實；成功率請以下方「此股歷史統計」為準（機率＝該股自身頻率，非模型預測）</div>` + bkNote);
      }
      if (sq.pullback) qh += block(`🌀 拉回結構檢查（回檔 ${sq.pullback.retr.toFixed(0)}%）`, sq.pullback,
        `<div style="font-size:9px;color:var(--muted2);margin-top:3px">3項以上＝健康拉回；切入觸發：帶量站回近5日高 <b style="font-family:var(--mono);color:var(--buy)">${fmt(sq.pullback.trigger)}</b>（未觸發前只等不搶）</div>`);
      if (qh) document.getElementById('movestage-content').innerHTML += `<div style="font-size:9px;color:var(--muted2);margin-top:6px"></div>` + qh + `<div style="font-size:9px;color:var(--muted2);margin-top:4px">檢查清單＝可驗證的量價事實，非機率預測（未經校準的「可信度%」是假精確，本系統不產出）。</div>`;
    }
  } catch (e) {}
  // v117：多日素質演變（掛在溫度計卡末尾——同屬「時機」類，對照今日快照看條件強弱變化）
  try {
    const qt = (typeof renderQualityTrend === 'function') ? renderQualityTrend(D) : '';
    if (qt) document.getElementById('movestage-content').innerHTML += qt;
  } catch (e) {}
}

/* ══ 突破/拉回 結構品質檢查（誠實版：清單非機率）═══════════════════════
   定位：回答「這次突破/這次拉回的『結構』乾不乾淨」——每項都是可驗證的
   量價事實，合計 X/4 項通過。刻意不輸出「可信度%」：未經歷史校準的機率
   數字＝假精確（本系統19年驗證教訓）。價位一律原始市價。
   ════════════════════════════════════════════════════════════════════ */
/* ══ 【新增區塊 J】突破/拉回 結構檢查清單 ════════════════════════════════
   輸出 X/4 項可驗證的量價事實，刻意「不」輸出可信度%（未校準機率=假精確）
   ⚠️ 突破情境判定需真正站上/觸及前高（v82修：曾用 price>hi20*0.995，
      平盤時恆真，對沒突破的股票顯示假情境）
   ⚠️ 量能項門檻1.5×有19年實證支撐（帶量40.9% vs 無量34.5%），勿隨意移除
   ════════════════════════════════════════════════════════════════════ */
function computeSetupQuality(D) {
  const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows;
  const cc = D.closes, v = D.volumes, n = c.length;
  if (n < 65) return null;
  const price = c[n - 1];
  const vol20 = v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  let atr = 0; for (let i = n - 14; i < n; i++) atr += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  atr /= 14;

  // ── 突破檢查：真的站上近20日前高（不含今日），或今日盤中確實觸及前高之上 ──
  //    修：原用 price > hi20*0.995 會在平盤/貼前高時恆真，對「根本沒突破」的股票顯示假情境
  let breakout = null;
  {
    const hi20 = Math.max(...h.slice(n - 21, n - 1));
    const brokeOut = c[n - 1] > hi20;                    // 收盤站上前高
    const touched = h[n - 1] > hi20 && c[n - 1] > hi20 * 0.98;   // 盤中觸及且收盤未大幅回落＝挑戰中
    if (brokeOut || touched) {
      const checks = [];
      /* v187：拿掉 v101 的「盤中推估全日量」——v141 起盤中已去掉今天未完成的K棒，最後一根是昨天的完整量，
         再除以已開盤比例會把它放大好幾倍（10:00 放大 4.5 倍），盤中幾乎每次突破都誤判成「帶量」 */
      const volEff = v[n - 1];
      checks.push({ ok: volEff > vol20 * 1.5, txt: `量能 ${volEff > 0 ? (volEff / vol20).toFixed(1) : 0}×20日均量（需>1.5×；19年3,934次驗證：帶量40.9% vs 無量34.5%）` });
      const range = h[n - 1] - l[n - 1] || 1;
      checks.push({ ok: (c[n - 1] - l[n - 1]) / range > 0.6, txt: '收在當日振幅上緣60%以上（收高=買方守住戰果，非只是勉強過半）' });
      checks.push({ ok: price - hi20 > atr * 0.5, txt: `突破幅度 ${(price - hi20).toFixed(2)}（需>0.5×ATR，貼著前高=易假突破）` });
      // 站穩：突破後所有收盤未跌回前高之下（若今天才突破則此項=今日收盤過前高）
      let firstBreak = n - 1;
      for (let i = n - 2; i >= n - 6 && i >= 0; i--) { if (c[i] > hi20) firstBreak = i; else break; }
      const held = c.slice(firstBreak).every(x => x > hi20);
      checks.push({ ok: held && price > hi20, txt: firstBreak < n - 1 ? `突破後 ${n - 1 - firstBreak} 日站穩前高之上` : '今日突破（站穩需後續確認）' });
      breakout = { level: hi20, passed: checks.filter(x => x.ok).length, checks };
    }
  }

  // ── 拉回檢查：20日內創過60日高、現在回檔中（未創新高且高於前段起點）──
  let pullback = null;
  {
    const hi60idx = h.slice(n - 60).reduce((best, x, i) => x > h[n - 60 + best] ? i : best, 0);
    const peakI = n - 60 + hi60idx, peak = h[peakI];
    if (peakI >= n - 20 && peakI < n - 2 && price < peak) {   // 近20日創高後回檔至少2天
      // 前段起點：peak往前找最近的顯著低點
      let baseI = peakI; for (let i = peakI - 1; i >= Math.max(0, peakI - 40); i--) { if (l[i] < l[baseI]) baseI = i; }
      const legUp = peak - l[baseI];
      if (legUp > 0) {
        const retr = (peak - price) / legUp * 100;   // 回檔佔前段漲幅比例
        const checks = [];
        checks.push({ ok: retr < 50, txt: `回檔僅前段漲幅的 ${retr.toFixed(0)}%（<50%＝淺回，強勢特徵）` });
        const upVol = v.slice(baseI, peakI + 1).reduce((a, b) => a + b, 0) / (peakI - baseI + 1);
        const dnVol = v.slice(peakI + 1).reduce((a, b) => a + b, 0) / (n - peakI - 1);
        checks.push({ ok: dnVol < upVol * 0.75, txt: `回檔量縮至上漲段的 ${(dnVol / upVol * 100).toFixed(0)}%（<75%＝賣壓輕）` });
        const ma20 = cc.slice(-20).reduce((a, b) => a + b, 0) / 20;
        checks.push({ ok: barPx(D) > ma20, txt: '守住20日均線（趨勢結構未破壞）' });
        const recentRange = (h[n - 1] - l[n - 1] + h[n - 2] - l[n - 2]) / 2;
        const peakRange = (h[peakI] - l[peakI] + h[peakI - 1] - l[peakI - 1]) / 2;
        checks.push({ ok: recentRange < peakRange, txt: 'K棒振幅收斂（波動冷卻，非恐慌出逃）' });
        const trig = Math.max(...h.slice(-5));
        pullback = { retr, passed: checks.filter(x => x.ok).length, checks, trigger: trig };
      }
    }
  }
  if (!breakout && !pullback) return null;
  return { breakout, pullback };
}

/* ══ 日內型態引擎（Intraday Profile — 誠實版）════════════════════════════
   定位：不是「AI預測開高走低72%」那種未校準機率（假精確）。這裡的機率＝
   「此股自己的歷史條件頻率」：今天開盤方向已知後，查此股過去所有同型開局
   的日子，實際收盤走向的分布，並與無條件基準對照（位移才是資訊）。
   實證前提已用18檔8,811交易日驗證：開高→走低位移+4.1、開低→走高+4.7
   （跳空回補效應，方向與文獻一致）；台股整體「走低>走高」為隔夜漲日內跌
   的結構現象。gap用還原價比率（除息跨日有微小失真，一年僅數日）。
   ════════════════════════════════════════════════════════════════════ */
/* ══ 【新增區塊 K】日內型態（Intraday Profile）════════════════════════════
   今日開盤方向 → 此股歷史同型開局日的收盤走向頻率分布（含vs基準的位移）
   ⚠️ 機率＝該股自身歷史條件頻率，非預測模型。勿改成「AI預測開高走低X%」
      的形式（未經校準的機率是假精確，本專案已4次教訓）
   ⚠️ 需要 D.opens（開盤價序列），後端主路徑有提供，缺少時安全退化為null
   ════════════════════════════════════════════════════════════════════ */
function computeIntradayProfile(D) {
  const o = D.opens, c = D.closes;
  if (!o || !c || c.length < 200 || o.length !== c.length) return null;   // 新股/次新股（<200日）型態未定，不報
  const n = c.length;
  const gapOf = (i) => (o[i] - c[i - 1]) / c[i - 1] * 100;
  const dayOf = (i) => (c[i] - o[i]) / o[i] * 100;
  const gb = (g) => g > 0.5 ? '開高' : g < -0.5 ? '開低' : '開平';
  const db = (d) => d > 0.5 ? '走高' : d < -0.5 ? '走低' : '盤整';

  /* v187 盤中已去掉今天未完成的K棒，最後一根是昨天——原本把昨天的開盤缺口標成「今日」。
     盤中改用今天的開盤（D.open）對最後一根收盤，走向用現價；歷史統計就可以含最後一根 */
  const live = !!D._intraday && D.open != null && D.price != null;
  const todayGap = live ? (D.open - c[n - 1]) / c[n - 1] * 100 : gapOf(n - 1);
  const bucket = gb(todayGap);

  // 此股歷史：同開局分布 vs 無條件基準（排除今日）
  const condN = { 走高: 0, 走低: 0, 盤整: 0 }; let cn = 0;
  const baseN = { 走高: 0, 走低: 0, 盤整: 0 }; let bn = 0;
  for (let i = 1; i < (live ? n : n - 1); i++) {
    const dk = db(dayOf(i));
    baseN[dk]++; bn++;
    if (gb(gapOf(i)) === bucket) { condN[dk]++; cn++; }
  }
  if (cn < 30) return null;   // 同型開局樣本太少，頻率無意義
  const dist = ['走高', '走低', '盤整'].map(k => ({
    k, p: condN[k] / cn * 100, base: baseN[k] / bn * 100,
  })).map(x => ({ ...x, shift: x.p - x.base })).sort((a, b) => b.p - a.p);
  const wilson = 1.96 * Math.sqrt(0.25 / cn) * 100;   // 半寬（保守p=0.5）
  return { todayGap, bucket, dist, n: cn, wilson };
}

/* ══ 逐股突破統計引擎（False Breakout Database 的正面表述）═══════════════
   回答：「這支股票的突破，歷史上有多少比例真的走出去？」
   機率＝該股自身歷史頻率（同 smartStop 假跌破率、日內型態的方法論），
   非模型預測，附樣本數與信賴半寬。定義（避免主觀）：
     突破事件＝收盤站上「前20日最高」（前一日尚未站上，取首次）
     成功＝突破後5日內，收盤未跌回突破日的前高之下，且最高價曾再漲>1×ATR
     失敗（假突破）＝5日內收盤跌破前高
   同時分「帶量(>1.5倍20日均量)」與「無量」兩組。19年24檔3,934次突破實證：
   整體成功率僅38.4%（假突破率61.6%——追突破期望值為負）；帶量40.9% vs 無量
   34.5%（+6.4個百分點，量能確有鑑別力，樣本2395/1539）。全部使用原始市價。
   ════════════════════════════════════════════════════════════════════ */
const _bsMemo = { k: null, v: null };   // 突破統計記憶化：溫度計/橫幅/紀律門/線位共用同一結果，避免重複全歷史掃描
function computeBreakoutStats(D) {
  const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows;
  const v = D.volumes, n = c.length;
  if (n < 150) return null;
  // key含最後一根K棒指紋（理由同 mainforce.js 的 _ibMemo，v95修）
  const _k = (D.code || '') + ':' + n + ':' + c[n - 1] + ':' + (v ? v[n - 1] : 0);
  if (_bsMemo.k === _k) return _bsMemo.v;
  const H = 5;
  const grp = { all: { n: 0, win: 0 }, vol: { n: 0, win: 0 }, novol: { n: 0, win: 0 } };
  let lastEvent = -99;
  for (let i = 25; i < n - H; i++) {
    const hi20 = Math.max(...h.slice(i - 20, i));
    if (c[i] <= hi20) continue;               // 今日未站上前高
    if (c[i - 1] > hi20) continue;            // 昨日已站上＝非首次突破
    if (i - lastEvent < 5) continue;          // 同一波突破去重
    lastEvent = i;
    // ATR（事件當時）
    let atr = 0;
    for (let k = i - 13; k <= i; k++) atr += Math.max(h[k] - l[k], Math.abs(h[k] - c[k - 1]), Math.abs(l[k] - c[k - 1]));
    atr /= 14;
    // 成功判定：5日內未收破前高，且曾再漲>1×ATR
    let held = true, extended = false;
    for (let k = i + 1; k <= i + H && k < n; k++) {
      if (c[k] < hi20) { held = false; break; }
      if (h[k] > c[i] + atr) extended = true;
    }
    const win = (held && extended) ? 1 : 0;
    const vol20 = v.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
    const heavy = vol20 > 0 && v[i] > vol20 * 1.5;
    grp.all.n++; grp.all.win += win;
    const g = heavy ? grp.vol : grp.novol;
    g.n++; g.win += win;
  }
  // 通用性：2年資料下低波動/冷門股突破事件本就少，硬性隱藏會讓多數股票看不到此卡。
  // 改為「分級誠實標註」：樣本足→以此股為準；樣本少→標明可信度低並以台股19年基準為主。
  if (grp.all.n < 3) { _bsMemo.k = _k; _bsMemo.v = null; return null; }   // 少於3次連參考價值都沒有
  const rate = (g) => g.n ? g.win / g.n * 100 : null;
  const ci = (g) => g.n ? 1.96 * Math.sqrt(0.25 / g.n) * 100 : null;
  const tier = grp.all.n >= 15 ? 'high' : grp.all.n >= 8 ? 'mid' : 'low';
  const _res = {
    all: { n: grp.all.n, rate: rate(grp.all), ci: ci(grp.all) },
    vol: grp.vol.n >= 5 ? { n: grp.vol.n, rate: rate(grp.vol), ci: ci(grp.vol) } : null,
    novol: grp.novol.n >= 5 ? { n: grp.novol.n, rate: rate(grp.novol), ci: ci(grp.novol) } : null,
    fakeRate: 100 - rate(grp.all),
    tier,          // high=樣本≥15堪用｜mid=8~14參考｜low=3~7樣本過少
    isTW: D.currency === 'TWD',   // 台股基準僅適用台股；美股/他市場不套用（跨市場套用＝錯誤外推）
  };
  _bsMemo.k = _k; _bsMemo.v = _res;
  return _res;
}


/* ══ 【新增區塊 L】Amihud 非流動性比率（v105）═════════════════════════════
   學術經典（Amihud 2002, J. Financial Markets；量化因子庫標配）：
   ILLIQ = |日報酬%| / 當日成交金額 —— 每單位資金能推動多少價格。
   值越高=流動性越稀薄=同樣賣壓造成更大跌幅=急跌與跳空的「放大器」。
   逐股自我校準：取20日均值在自身120日歷史的百分位（同溫度計哲學）。
   ⚠️ 風險指標非方向訊號（與ATR同車道），dir=0、不投任何票。
   ════════════════════════════════════════════════════════════════════ */
function computeAmihud(D) {
  try {
    // v187 報酬用還原價（除權息日的價差不是真的漲跌，原本會在 20 日窗內一路拉高「不流動」）；成交金額用原始價
    const c = D.closes, raw = D.rawCloses || D.closes, v = D.volumes, n = c.length;
    if (n < 150) return null;
    const illiq = [];
    for (let i = 1; i < n; i++) {
      const dollar = raw[i] * v[i];
      if (dollar <= 0) { illiq.push(null); continue; }
      illiq.push(Math.abs((c[i] - c[i - 1]) / c[i - 1] * 100) / (dollar / 1e8));   // 每億元成交推動的%
    }
    const valid = illiq.filter(x => x != null);
    if (valid.length < 140) return null;
    const ma20 = (arr, end) => { const s = arr.slice(end - 20, end).filter(x => x != null); return s.length >= 10 ? s.reduce((a, b) => a + b, 0) / s.length : null; };
    const cur = ma20(illiq, illiq.length);
    if (cur == null) return null;
    const hist = [];
    for (let e2 = illiq.length - 120; e2 <= illiq.length; e2++) { const m = ma20(illiq, e2); if (m != null) hist.push(m); }
    const pct = hist.filter(x => x <= cur).length / hist.length * 100;
    return { cur, pct,
      level: pct >= 75 ? '稀薄' : pct <= 25 ? '充沛' : '正常',
      note: pct >= 75 ? `流動性稀薄（自身120日第${Math.round(pct)}百分位）——同樣賣壓會造成更大跌幅，滑價與跳空的放大器：部位縮小、只用限價單、停損預期會有滑價` :
            pct <= 25 ? `流動性充沛（第${Math.round(pct)}百分位）——市場吸收量能良好，進出滑價小` : null };
  } catch (e) { return null; }
}
/* ══ 【新增區塊 M】多日素質演變（v117）═══════════════════════════════════
   解決「所有卡片都是今日快照，看不出條件在改善還是惡化」的缺口。
   對最近5個交易日逐日重算關鍵指標——每日只用「截至該日」的資料
   （slice 截斷，嚴守防前視偏誤，與意圖回測同一原則）。
   顯示的是「條件的方向」而非預測：勢能在升或降、FUSION在修復或惡化、
   環境是否翻轉。短線最需要的判斷是「我進場的理由今天比昨天更強還是更弱」。
   ⚠️ 這仍不是方向預測（19年已證不可測），是條件變化的事實紀錄。
   ⚠️ 成本：5日回算約60ms（手機約240ms），已實測可接受。
   ════════════════════════════════════════════════════════════════════ */
function computeQualityTrend(D, days = 5) {
  try {
    const n0 = D.closes.length;
    if (n0 < 130) return null;
    const rows = [];
    for (let back = days - 1; back >= 0; back--) {
      const n = n0 - back;
      const sub = {
        code: D.code, currency: D.currency,
        closes: D.closes.slice(0, n), highs: D.highs.slice(0, n), lows: D.lows.slice(0, n),
        volumes: D.volumes.slice(0, n), opens: D.opens ? D.opens.slice(0, n) : undefined,
        rawCloses: (D.rawCloses || D.closes).slice(0, n),
        rawHighs: (D.rawHighs || D.highs).slice(0, n),
        rawLows: (D.rawLows || D.lows).slice(0, n),
        prevClose: D.closes[n - 2],   // v187 勢能的量價分要用（原本沒給→「價漲」永遠不成立，上漲爆量被算成出貨）
        price: D.closes[n - 1],
      };
      let shi = null, rg = null;   // v188 FUSION 欄位隨公式引擎移除
      try { shi = computeShiPower(sub, 50); } catch (e) {}
      try { rg = computeRegime(sub); } catch (e) {}
      rows.push({
        offset: back, close: D.closes[n - 1],
        chgPct: n >= 2 ? (D.closes[n - 1] - D.closes[n - 2]) / D.closes[n - 2] * 100 : 0,
        longShi: shi ? shi.shi : null, shortShi: shi ? shi.shortShi : null,
        regime: rg ? rg.regime : null,
      });
    }
    // 變化摘要（首日 vs 末日）
    const a = rows[0], b = rows[rows.length - 1];
    const d = (x, y) => (x == null || y == null) ? null : y - x;
    return { rows, days,
      dShort: d(a.shortShi, b.shortShi), dLong: d(a.longShi, b.longShi),
      regimeFlip: a.regime && b.regime && a.regime !== b.regime ? `${a.regime} → ${b.regime}` : null };
  } catch (e) { return null; }
}

function renderQualityTrend(D) {
  try {
    const q = computeQualityTrend(D, 5);
    if (!q) return '';
    const arrow = (v) => v == null ? '' : v > 2 ? `<span style="color:var(--buy)">▲${v.toFixed(0)}</span>` : v < -2 ? `<span style="color:var(--sell)">▼${Math.abs(v).toFixed(0)}</span>` : `<span style="color:var(--muted2)">→</span>`;
    const cell = (v, col) => v == null ? '—' : `<span style="color:${col || 'var(--fg)'}">${typeof v === 'number' ? v.toFixed(0) : v}</span>`;
    let h = `<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
      <div style="font-size:11px;font-weight:700;margin-bottom:6px">📊 近${q.days}日素質演變（每日只用當日以前資料重算，防前視偏誤；勢能只含價量、相對強弱以 50 計，與上方勢能卡不同）</div>
      <table style="width:100%;font-size:10px;font-family:var(--mono);border-collapse:collapse">
        <tr style="color:var(--muted2)"><td>日</td><td style="text-align:right">收盤</td><td style="text-align:right">漲跌%</td><td style="text-align:right">多勢能</td><td style="text-align:right">空勢能</td><td style="text-align:right">環境</td></tr>`;
    for (const r of q.rows) {
      const lbl = r.offset === 0 ? (D._intraday ? '昨日' : '最近') : `T-${r.offset}`;
      const chgCol = r.chgPct >= 0 ? 'var(--buy)' : 'var(--sell)';
      h += `<tr style="border-top:1px solid var(--bd)">
        <td style="color:${r.offset === 0 ? 'var(--accent)' : 'var(--muted)'};font-weight:${r.offset === 0 ? 700 : 400}">${lbl}</td>
        <td style="text-align:right">${fmt(r.close)}</td>
        <td style="text-align:right;color:${chgCol}">${r.chgPct >= 0 ? '+' : ''}${r.chgPct.toFixed(1)}</td>
        <td style="text-align:right">${cell(r.longShi)}</td>
        <td style="text-align:right">${cell(r.shortShi)}</td>
        <td style="text-align:right;font-size:9px;color:var(--muted)">${r.regime || '—'}</td></tr>`;
    }
    h += `</table>
      <div style="font-size:10px;color:var(--muted);margin-top:6px;line-height:1.6">
        ${q.days}日變化：多勢能 ${arrow(q.dLong)}｜空勢能 ${arrow(q.dShort)}
        ${q.regimeFlip ? `<br><b style="color:var(--warn)">⚠️ 環境已翻轉：${q.regimeFlip}</b>——原本的進場理由可能已不成立` : ''}
      </div>
      <div style="font-size:9px;color:var(--muted2);margin-top:4px">用途：判斷「進場理由今天比幾天前更強還是更弱」。這是條件變化的事實，非漲跌預測。</div>
    </div>`;
    return h;
  } catch (e) { return ''; }
}
