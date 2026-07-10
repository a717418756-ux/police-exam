/* ══════════════════════════════════════════════════════════════════════
   mainforce.js — 主力行為推估 + 融資融券散戶心理 + 智慧停損
   ──────────────────────────────────────────────────────────────────
   A. OBV 能量潮 / MFI 資金流量（累積型量能，抓「偷跑」）
   B. 主力行為推估引擎：吸籌/洗盤/出貨/誘多/誘空/恐慌 分類 + 證據 + 信心
   C. 融資融券判讀（散戶槓桿 vs 主力）+ 券資比軋空偵測
   D. 智慧停損：結構位停損 + 歷史假跌破收回率（防被洗掉後反向走）
   依賴：smc.js(computeStructure)、enhance.js、app.js($/fmt/fmtV)
   注意：無逐根開盤價，影線分析以前收盤近似開盤（常用近似法，已標註）
   ══════════════════════════════════════════════════════════════════════ */

/* ══ A. OBV 能量潮 ════════════════════════════════════════════════════
   收漲日加量、收跌日減量的累積線。價與 OBV 背離 = 主力偷跑：
   價平/跌 + OBV 升 → 偷偷吸貨；價漲 + OBV 降 → 偷偷出貨
   ════════════════════════════════════════════════════════════════════ */
function computeOBV(D) {
  const c = D.closes, v = D.volumes, n = c.length;
  const obv = [0];
  for (let i = 1; i < n; i++) {
    obv.push(obv[i-1] + (c[i] > c[i-1] ? v[i] : c[i] < c[i-1] ? -v[i] : 0));
  }
  const N = Math.min(20, n - 1);
  // 價格斜率（20日報酬）
  const pSlope = (c[n-1] - c[n-N]) / c[n-N];
  // OBV 斜率（以20日OBV振幅正規化到約 -1~1）
  const oSlice = obv.slice(-N);
  const oRange = Math.max(...oSlice) - Math.min(...oSlice) || 1;
  const oSlope = (oSlice[oSlice.length-1] - oSlice[0]) / oRange;
  return { obv, pSlope, oSlope };
}

/* ══ MFI 資金流量指標（帶量的RSI）════════════════════════════════════ */
function computeMFI(D, n = 14) {
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes;
  let pos = 0, neg = 0;
  for (let i = Math.max(1, c.length - n); i < c.length; i++) {
    const tp = (h[i] + l[i] + c[i]) / 3;
    const tpPrev = (h[i-1] + l[i-1] + c[i-1]) / 3;
    const mf = tp * v[i];
    if (tp > tpPrev) pos += mf; else if (tp < tpPrev) neg += mf;
  }
  if (pos + neg === 0) return 50;
  return 100 * pos / (pos + neg);
}

/* ══ B. 主力行為推估引擎 ══════════════════════════════════════════════
   多證據加分制：每個行為累積分數，取最高者，信心=與第二名的差距
   ════════════════════════════════════════════════════════════════════ */
function computeMainForce(D, formulas) {
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes, n = c.length;
  const price = D.price;
  const scores = { 吸籌: 0, 洗盤: 0, 出貨: 0, 誘多: 0, 誘空: 0, 恐慌殺盤: 0 };
  const evidence = { 吸籌: [], 洗盤: [], 出貨: [], 誘多: [], 誘空: [], 恐慌殺盤: [] };
  const add = (k, s, e) => { scores[k] += s; evidence[k].push(e); };

  // ── OBV 偷跑偵測（最強證據）──
  const { pSlope, oSlope } = computeOBV(D);
  if (pSlope <= 0.02 && oSlope > 0.3) add('吸籌', 30, `價平/跌但OBV上升（主力偷跑吸貨，量能潮先行）`);
  if (pSlope >= 0.02 && oSlope < -0.3) add('出貨', 30, `價漲但OBV下降（主力偷跑出貨，邊拉邊倒）`);

  // ── MFI 資金流極端 ──
  const mfi = computeMFI(D);
  if (mfi <= 20 && pSlope < 0) add('吸籌', 10, `MFI ${mfi.toFixed(0)} 資金流超賣區（低檔有資金默默流入的環境）`);
  if (mfi >= 80) add('出貨', 10, `MFI ${mfi.toFixed(0)} 資金流過熱（高檔資金流出風險）`);

  // ── 籌碼與價格背離 ──
  const chip = D.chip;
  const chg5 = n >= 6 ? (price - c[n-6]) / c[n-6] * 100 : 0;
  if (chip) {
    const instBuy = chip.foreign5 + chip.trust5;
    if (instBuy > 0 && chg5 < -1) add('吸籌', 20, `法人5日買超但股價下跌（法人低接吸籌）`);
    if (instBuy < 0 && chg5 > 1) { add('出貨', 20, `法人5日賣超但股價上漲（散戶推升、法人趁機出）`); add('誘多', 10, `價漲籌碼卻轉弱`); }
  }

  // ── 量價異常 ──
  const vr = n >= 6 ? v[n-1] / (v.slice(-6, -1).reduce((a, b) => a + b, 0) / 5) : 1;
  const chg1 = (price - D.prevClose) / D.prevClose * 100;
  let downStreak = 0;
  for (let i = n - 1; i > 0; i--) { if (c[i] < c[i-1]) downStreak++; else break; }
  if (vr > 1.8 && chg1 < -2) {
    if (downStreak >= 3 && formulas && formulas.psy && formulas.psy.value <= 25) {
      add('恐慌殺盤', 30, `連跌${downStreak}天+爆量長黑+PSY恐慌（散戶不計價殺出）`);
    } else {
      add('出貨', 15, `爆量下跌（${vr.toFixed(1)}倍量，主力調節）`);
    }
  }

  // ── 結構陷阱偵測（假突破=誘多、假跌破=洗盤/誘空）──
  const st = (typeof computeStructure === 'function') ? computeStructure(D) : null;
  if (st) {
    const look = Math.min(7, n - 1);
    if (st.lastLow) {
      // 近7日曾跌破前波低點，但收盤收回其上 → 掃停損洗盤
      for (let i = n - look; i < n; i++) {
        if (l[i] < st.lastLow * 0.995 && c[Math.min(i + 1, n - 1)] > st.lastLow) {
          add('洗盤', 30, `跌破前波低 ${fmt(st.lastLow)} 後快速收回（掃停損式洗盤）`);
          add('誘空', 15, `假跌破誘空`);
          break;
        }
      }
    }
    if (st.lastHigh) {
      // 近7日曾突破前波高，但收盤收回其下且量縮 → 誘多
      for (let i = n - look; i < n; i++) {
        if (h[i] > st.lastHigh * 1.005 && c[Math.min(i + 1, n - 1)] < st.lastHigh && vr < 1.1) {
          add('誘多', 30, `突破前波高 ${fmt(st.lastHigh)} 量縮收回（假突破誘多）`);
          break;
        }
      }
    }
  }

  // ── 影線形態（優先用真實開盤價；後端未更新時以前收近似）──
  const op = D.opens && D.opens.length === n ? D.opens : null;
  let lowerShadowDays = 0;
  for (let i = Math.max(1, n - 10); i < n; i++) {
    const openV = op ? op[i] : c[i-1];
    const bodyLow = Math.min(openV, c[i]);
    const range = h[i] - l[i] || 1;
    if ((bodyLow - l[i]) / range > 0.45) lowerShadowDays++;
  }
  if (lowerShadowDays >= 3 && pSlope <= 0.03) add('吸籌', 15, `近10日 ${lowerShadowDays} 根長下影（低檔有承接手）`);

  // ── KBAR 淨強度（機構級特徵，Qlib Alpha158 KBAR 系）──
  // (收-開)/(高-低) 的20日均：持續為負=收盤常弱於開盤（拉高出貨痕跡）
  let kbar = null;
  if (op) {
    let s = 0, m = 0;
    for (let i = n - Math.min(20, n); i < n; i++) {
      const r = h[i] - l[i];
      if (r > 0) { s += (c[i] - op[i]) / r; m++; }
    }
    if (m >= 10) {
      kbar = s / m;
      if (kbar <= -0.15 && pSlope >= 0.02) add('出貨', 15, `KBAR淨強度 ${kbar.toFixed(2)}：價漲但收盤持續弱於開盤（開高走低，拉高出貨痕跡）`);
      if (kbar >= 0.15 && pSlope <= 0.02) add('吸籌', 15, `KBAR淨強度 +${kbar.toFixed(2)}：價平但收盤持續強於開盤（尾盤有人默默買）`);
    }
  }

  // ── PSY 情緒環境 ──
  if (formulas && formulas.psy) {
    const psyV = formulas.psy.value;
    if (psyV >= 80) add('出貨', 10, `PSY ${psyV} 群眾過度貪婪（FOMO環境，主力常趁勢出貨）`);
    if (psyV <= 20 && scores.恐慌殺盤 === 0) add('吸籌', 8, `PSY ${psyV} 群眾恐慌（恐慌是主力的買點環境）`);
  }

  // ── 結算 ──
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topName, topScore] = sorted[0];
  const secondScore = sorted[1][1];
  if (topScore < 25) {
    return { behavior: '無明顯主力行為', confidence: 0, evidence: [], all: scores,
      desc: '目前量價籌碼未出現典型的主力行為特徵，屬正常交易狀態', obvSlope: oSlope, mfi, kbar };
  }
  // 信心：領先幅度 + 絕對強度
  const confidence = Math.min(95, Math.round(topScore * 0.7 + (topScore - secondScore) * 0.8));
  const descMap = {
    吸籌: '主力疑似默默收集籌碼。特徵：價未動但量能潮/法人先行。後續若放量突破可跟進',
    洗盤: '疑似掃停損洗盤——跌破關鍵位嚇出散戶後收回。若籌碼未鬆動，洗完反而健康',
    出貨: '主力疑似高檔調節出貨。價還在撐但內部量能/籌碼已轉弱，追高極危險',
    誘多: '假突破誘多——引誘散戶追高後反殺。突破未帶量都要懷疑',
    誘空: '假跌破誘空——引誘散戶追空/停損後拉回。空單此時進場易被軋',
    恐慌殺盤: '散戶恐慌不計價殺出。極端恐慌常離底不遠，但不要接刀，等止穩訊號'
  };
  return { behavior: topName, confidence, evidence: evidence[topName], all: scores,
    desc: descMap[topName], obvSlope: oSlope, mfi, kbar };
}

/* ══ B2. 主力意圖研判引擎（洗盤 vs 出貨 vs 進貨的關鍵分岔）════════════
   解決「下跌到底是洗散戶、還是真出貨」的核心問題。
   多維證據交叉，輸出方向傾向 + 白話劇本，不再只給「弱勢」這種無用結論。
   ════════════════════════════════════════════════════════════════════ */
function computeIntentAnalysis(D, formulas, mainForce) {
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes, n = c.length;
  if (n < 25) return null;
  const price = D.price;

  // 基礎量價
  const ma20 = c.slice(-20).reduce((a,b)=>a+b,0)/20;
  const biasPct = (price - ma20) / ma20 * 100;           // 乖離
  const drop5 = n>=6 ? (c[n-1]-c[n-6])/c[n-6]*100 : 0;    // 近5日漲跌
  const vol5 = v.slice(-5).reduce((a,b)=>a+b,0)/5;
  const vol20 = v.slice(-20).reduce((a,b)=>a+b,0)/20;
  const volRatio = vol20 ? vol5/vol20 : 1;                // 近5日相對20日量比
  const psyV = (formulas && formulas.psy) ? formulas.psy.value : 50;
  const obvSlope = mainForce ? mainForce.obvSlope : 0;
  const kbar = mainForce ? mainForce.kbar : null;
  const instNet = D.chip ? ((D.chip.foreign5||0)+(D.chip.trust5||0)) : null;

  // 下影線/實體收位（近5日）：跌時有沒有人接
  let lowerShadow = 0, closeStrong = 0;
  for (let i=n-5; i<n; i++) {
    if (i<1) continue;
    const range = h[i]-l[i] || 1;
    const body = Math.min(c[i], c[i-1]);
    if ((body - l[i])/range > 0.4) lowerShadow++;         // 長下影=低檔有承接
    if ((c[i]-l[i])/range > 0.6) closeStrong++;           // 收在當日高檔
  }

  // ── Wyckoff Test：破前低後，後續量能是否遞減（賣壓是否真枯竭）──
  // 依據：Wyckoff Spring/Shakeout 理論——破底本身不算數，破底後的「測試」才是關鍵訊號。
  // 測試量 < 破底量 = 賣壓枯竭（洗盤/吸籌信號更可信）；測試量 ≥ 破底量 = 賣壓未消，不可輕信洗盤
  let wyckoffTest = null;
  {
    const lookback = Math.min(20, n - 6);
    let breakIdx = -1, breakVol = 0, breakLow = Infinity;
    for (let i = n - lookback; i < n - 2; i++) {
      const priorLow = Math.min(...l.slice(Math.max(0, i - 10), i));
      if (l[i] < priorLow && v[i] > vol20 * 1.2) {          // 帶量破前低 = 疑似 Shakeout/Spring 或真跌破
        if (v[i] > breakVol) { breakIdx = i; breakVol = v[i]; breakLow = l[i]; }
      }
    }
    if (breakIdx >= 0) {
      const afterVols = v.slice(breakIdx + 1, n);
      const avgAfterVol = afterVols.length ? afterVols.reduce((a,b)=>a+b,0)/afterVols.length : 0;
      const retested = afterVols.some((_, k) => l[breakIdx + 1 + k] <= breakLow * 1.02); // 有無回測破底區
      const testPassed = avgAfterVol < breakVol * 0.7;       // 測試量明顯低於破底量
      wyckoffTest = { breakIdx, testPassed, retested, daysSince: n - 1 - breakIdx };
    }
  }

  // ── VSA Effort vs Result：爆量但價格幾乎不動 = 吸收（有大戶在承接/出貨但不讓價格反映）──
  // 依據：Tom Williams VSA「Law of Effort vs Result」——高努力(量)、低結果(價變動) = 專業資金在對作
  let absorption = null;
  {
    const last5vols = v.slice(-5), last5ranges = [];
    for (let i = n - 5; i < n; i++) last5ranges.push(Math.abs(c[i] - c[i-1]) / c[i-1] * 100);
    const avgVol10 = v.slice(-15, -5).reduce((a,b)=>a+b,0) / 10 || 1;
    const avgRange10 = [];
    for (let i = n - 15; i < n - 5; i++) if (i>=1) avgRange10.push(Math.abs(c[i]-c[i-1])/c[i-1]*100);
    const avgRangeBase = avgRange10.length ? avgRange10.reduce((a,b)=>a+b,0)/avgRange10.length : 1;
    let absorbDays = 0;
    for (let k = 0; k < 5; k++) {
      const highEffort = last5vols[k] > avgVol10 * 1.4;
      const lowResult = last5ranges[k] < avgRangeBase * 0.6;
      if (highEffort && lowResult) absorbDays++;
    }
    if (absorbDays >= 1) absorption = { days: absorbDays };
  }

  // ── VSA No Supply：下跌段量縮到明顯低於前兩根，且波幅窄（賣壓枯竭的乾淨訊號）──
  // 依據：VSA No-Supply Bar——窄幅下跌 + 量低於前兩根均量，代表賣方失去興趣
  let noSupplyDays = 0;
  for (let i = n - 5; i < n; i++) {
    if (i < 2) continue;
    const prevAvgVol = (v[i-1] + v[i-2]) / 2;
    const range = h[i] - l[i];
    const avgRangeRecent = (h.slice(i-5, i).reduce((a,idx,k2)=>a+(h[i-5+k2]-l[i-5+k2]),0)) / 5 || range;
    if (c[i] < c[i-1] && v[i] < prevAvgVol * 0.7 && range < avgRangeRecent * 0.7) noSupplyDays++;
  }

  // ── 三方證據計分 ──
  let washScore = 0, distScore = 0, accScore = 0;         // 洗盤 / 出貨 / 進貨
  const ev = { wash: [], dist: [], acc: [] };

  // 是否處於下跌情境（意圖研判主要針對跌勢，這是使用者最易誤判做空的區）
  // 注意：Shakeout本質是「跌深後快速反彈」，若只看近5日報酬，反彈會自己抵銷掉判斷資格，
  // 導致最該辨識「這是洗盤」的那一刻反而跳出下跌情境。故額外用 wyckoffTest 是否存在來補判。
  const isFalling = drop5 < -2 || biasPct < -3 || (wyckoffTest && wyckoffTest.daysSince <= 10);

  if (isFalling) {
    // 洗盤證據：跌但有承接痕跡、OBV沒同步破、量縮跌（不是大量出逃）
    if (lowerShadow >= 2) { washScore += 25; ev.wash.push(`近5日 ${lowerShadow} 根長下影（殺低有人承接）`); }
    if (obvSlope > -0.15 && drop5 < -3) { washScore += 25; ev.wash.push('價跌但OBV未同步破底（籌碼沒真的離開＝洗籌痕跡）'); }
    if (volRatio < 0.9 && drop5 < -3) { washScore += 20; ev.wash.push(`量縮下跌（${volRatio.toFixed(2)}倍量，殺盤無量＝非主力出逃）`); }
    if (psyV <= 25) { washScore += 15; ev.wash.push(`PSY ${psyV} 散戶恐慌交出籌碼（洗盤最愛的情緒）`); }
    if (instNet != null && instNet > 0) { washScore += 20; ev.wash.push('法人5日仍淨買（跌勢中法人沒跑）'); }
    if (closeStrong >= 2) { washScore += 10; ev.wash.push('多日收在當日高檔（盤中殺低尾盤拉回）'); }
    // Wyckoff Test 確認：破底後量能遞減，賣壓真枯竭（比單看下影線更可信的兩段式驗證）
    if (wyckoffTest && wyckoffTest.testPassed) { washScore += 30; ev.wash.push(`Wyckoff測試通過：${wyckoffTest.daysSince}日前帶量破前低後，近日量能明顯遞減（賣壓真枯竭，非僅單根下影）`); }
    if (absorption) { washScore += 15; ev.wash.push(`近5日${absorption.days}天爆量卻價格幾乎不動（Effort/Result背離＝有人在低檔吸收籌碼）`); }
    if (noSupplyDays >= 2) { washScore += 15; ev.wash.push(`近5日${noSupplyDays}天窄幅量縮下跌（VSA無賣壓訊號，賣方失去興趣）`); }

    // 出貨證據：帶量跌、OBV破底、法人跑、開高走低
    if (volRatio > 1.3 && drop5 < -3) { distScore += 30; ev.dist.push(`爆量下跌（${volRatio.toFixed(2)}倍量＝主力調節/出逃）`); }
    if (obvSlope < -0.3) { distScore += 25; ev.dist.push('OBV同步破底（籌碼真的在離開）'); }
    if (instNet != null && instNet < 0) { distScore += 25; ev.dist.push('法人5日淨賣（機構站賣方）'); }
    if (kbar != null && kbar <= -0.15) { distScore += 15; ev.dist.push(`KBAR ${kbar.toFixed(2)}（持續開高走低，拉高出貨痕跡）`); }
    if (lowerShadow === 0 && drop5 < -4) { distScore += 15; ev.dist.push('連續實體黑K無下影（殺盤無人接＝弱）'); }
    // Wyckoff Test 未通過：破底後量能未遞減甚至更大，賣壓未消，不可輕信洗盤
    if (wyckoffTest && !wyckoffTest.testPassed && wyckoffTest.retested) { distScore += 25; ev.dist.push(`Wyckoff測試未通過：${wyckoffTest.daysSince}日前破前低後，回測時量能未遞減（賣壓未消，恐是真跌破非洗盤）`); }
  }

  // 進貨證據（低檔盤整＋量價背離，不限跌勢）
  if (biasPct < 5 && obvSlope > 0.3 && Math.abs(drop5) < 4) { accScore += 30; ev.acc.push('價平量增OBV上升（低檔主力默默進貨）'); }
  if (kbar != null && kbar >= 0.15 && Math.abs(drop5) < 3) { accScore += 20; ev.acc.push(`KBAR +${kbar.toFixed(2)}（尾盤持續有人買）`); }
  if (instNet != null && instNet > 0 && biasPct < 0) { accScore += 20; ev.acc.push('法人低於均線區仍淨買（逢低布局）'); }
  if (absorption && !isFalling) { accScore += 15; ev.acc.push(`近5日${absorption.days}天爆量價格不動（低檔吸收訊號）`); }

  // ── 綜合研判 ──
  const scores = [
    { name: '洗盤', dir: 'bounce', score: washScore, ev: ev.wash },
    { name: '出貨', dir: 'down', score: distScore, ev: ev.dist },
    { name: '進貨', dir: 'up', score: accScore, ev: ev.acc },
  ].sort((a,b)=>b.score-a.score);

  const top = scores[0];
  if (top.score < 30) {
    return { verdict: '訊號不足', dir: 'neutral', confidence: 0,
      desc: '目前量價籌碼未出現明顯的主力意圖特徵，方向不明，觀望或等更清楚的訊號。',
      scores, evidence: [] };
  }
  // 信心 = 假說分離度 × 證據絕對強度。合成回測發現：舊公式只看分離度，
  // 純隨機遊走上單邊拿30分（1條證據）就給95信心，誤報率57%。加入強度折減
  // （score/70 封頂1）後，隨機雜訊信心降到41（跌破紀律門50門檻），真洗盤(65分)
  // 維持91、真出貨(95分)維持95——結構性修正而非調參，不犧牲真訊號。
  const separation = top.score / (top.score + (scores[1].score || 0) + 1);
  const evidenceStrength = Math.min(1, top.score / 70);
  const confidence = Math.min(95, Math.round(separation * evidenceStrength * 100));

  const scriptMap = {
    '洗盤': {
      title: '🌊 疑似洗盤（洗散戶，非真跌）',
      script: '主力用殺低嚇出散戶籌碼，籌碼沒真的離開。劇本：洗完常見急拉，但反彈需要數日發酵（真實資料回測：4檔台股洗盤判定後5日近乎持平、10日才顯著轉正）——不是隔天就漲，別因短期不動而棄守。操作：不宜追空（易被軋），做多者可等止跌訊號（帶量紅K收回均線）分批進；已持有可續抱但守好停損。',
    },
    '出貨': {
      title: '📉 疑似出貨（真跌，籌碼在離開）',
      script: '主力邊拉邊倒或帶量出逃，籌碼真的在流失。劇本：續跌動能集中在前5日（真實資料回測：出貨判定後5日命中67-80%，10日部分個股已反彈）——空單時效短，拖過一週未跌要警覺。操作：做多者反彈減碼，做空者反彈到壓力可布局（非殺低追空），嚴設停損防軋。',
    },
    '進貨': {
      title: '📈 疑似進貨（低檔布局）',
      script: '主力在低檔量價背離默默吸貨，準備未來拉抬。劇本：打底完成後易啟動。操作：可分批布多，跌破近期低點且OBV同步走弱則證偽出場。',
    },
  };
  const s = scriptMap[top.name];
  return {
    verdict: top.name, dir: top.dir, confidence,
    title: s.title, desc: s.script,
    scores, evidence: top.ev,
    metrics: { biasPct, drop5, volRatio, psyV, obvSlope, lowerShadow },
  };
}

function renderMainForce(D, formulas) {
  const card = document.getElementById('mainforce-card');
  if (!card) return;
  card.style.display = 'block';
  const mf = computeMainForce(D, formulas);

  const colMap = { 吸籌: 'var(--buy)', 洗盤: 'var(--warn)', 出貨: 'var(--sell)', 誘多: 'var(--sell)', 誘空: 'var(--warn)', 恐慌殺盤: 'var(--sell)', 無明顯主力行為: 'var(--muted)' };
  const col = colMap[mf.behavior] || 'var(--muted)';

  let html = `<div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
    <div style="text-align:center;min-width:86px">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">推估行為</div>
      <div style="font-size:22px;font-weight:800;color:${col};line-height:1.3">${mf.behavior}</div>
      ${mf.confidence ? `<div style="font-family:var(--mono);font-size:11px;color:var(--muted)">信心 ${mf.confidence}</div>` : ''}
    </div>
    <div style="flex:1;font-size:12px;color:var(--muted);line-height:1.6">${mf.desc}</div>
  </div>`;

  // ── 主力意圖研判（洗盤/出貨/進貨的關鍵分岔）──
  const intent = computeIntentAnalysis(D, formulas, mf);
  if (intent && intent.confidence > 0) {
    const iCol = intent.dir === 'up' ? 'var(--buy)' : intent.dir === 'down' ? 'var(--sell)' : intent.dir === 'bounce' ? 'var(--warn)' : 'var(--muted)';
    html += `<div style="margin:4px 0 14px;padding:12px;background:${iCol}12;border:1.5px solid ${iCol}60;border-radius:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:14px;font-weight:800;color:${iCol}">${intent.title}</span>
        <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">信心 ${intent.confidence}</span>
      </div>
      <div style="font-size:11px;color:var(--txt);line-height:1.65;margin-bottom:8px">${intent.desc}</div>
      ${intent.verdict === '洗盤' ? (() => {
        const rh = D.rawHighs || D.highs;
        const trig = Math.max(...rh.slice(-5));
        return `<div style="padding:7px 10px;background:var(--buy)10;border:1px dashed var(--buy);border-radius:7px;margin-bottom:8px;font-size:11px;color:var(--muted);line-height:1.6">🎯 <b style="color:var(--buy)">吸籌確認觸發</b>：帶量（>1.2倍20日均量）站回近5日高點 <b style="font-family:var(--mono);color:var(--buy)">${fmt(trig)}</b> ＝洗盤結束訊號（Wyckoff Sign of Strength），可分批進場；未觸發前只觀察不搶進。</div>`;
      })() : ''}`;
    if (intent.evidence.length) {
      intent.evidence.forEach(e => {
        html += `<div style="display:flex;gap:8px;padding:3px 0"><span style="color:${iCol};font-size:11px">✓</span><span style="font-size:10px;color:var(--muted);line-height:1.5">${e}</span></div>`;
      });
    }
    // 三方分數對照（讓你看到分岔的拉鋸）
    html += `<div style="display:flex;gap:6px;margin-top:8px">`;
    intent.scores.forEach(sc => {
      const sCol = sc.dir==='up'?'var(--buy)':sc.dir==='down'?'var(--sell)':sc.dir==='bounce'?'var(--warn)':'var(--muted)';
      html += `<div style="flex:1;text-align:center;background:var(--bg);border-radius:6px;padding:4px"><div style="font-size:9px;color:var(--muted)">${sc.name}</div><div style="font-family:var(--mono);font-size:13px;font-weight:700;color:${sc.score>0?sCol:'var(--muted2)'}">${sc.score}</div></div>`;
    });
    // 真實資料回測：此股2年歷史逐日重演，驗證意圖引擎在「這支股票」上準不準
    try {
      const bt = computeIntentBacktest(D);
      if (bt) {
        html += `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--bd)">
          <div style="font-size:10px;color:var(--muted);margin-bottom:4px">📜 此股真實歷史驗證（2年逐日重演，共${bt.total}次判定事件）</div>`;
        [['洗盤','漲'],['出貨','跌'],['進貨','漲']].forEach(([k, exp]) => {
          const s = bt.stats[k];
          if (!s.n) return;
          const a5 = s.sum5 / s.n, a10 = s.sum10 / s.n;
          const ok5 = (k === '出貨') ? a5 < 0 : a5 > 0, ok10 = (k === '出貨') ? a10 < 0 : a10 > 0;
          html += `<div style="display:flex;flex-wrap:wrap;gap:6px;font-size:10px;padding:2px 0;color:var(--muted)"><span style="width:34px">${k}</span><span>${s.n}次</span><span style="font-family:var(--mono);color:${ok5?'var(--buy)':'var(--sell)'}">5日均${a5>=0?'+':''}${a5.toFixed(1)}%(中${Math.round(s.win5/s.n*100)}%)</span><span style="font-family:var(--mono);color:${ok10?'var(--buy)':'var(--sell)'}">10日均${a10>=0?'+':''}${a10.toFixed(1)}%(中${Math.round(s.win10/s.n*100)}%)</span><span style="color:var(--muted2)">期望${exp}</span></div>`;
        });
        html += `<div style="font-size:9px;color:var(--muted2);margin-top:3px">歷史PSY以中性值近似（避免前視偏誤）；此為「這支股票」的專屬驗證——若某類判定在此股歷史命中率低，該判定在此股別重壓；樣本少時參考價值有限</div></div>`;
      }
    } catch (e) {}
    html += `<div style="font-size:9px;color:var(--muted2);margin-top:6px;line-height:1.4">研判依據參考 Wyckoff Method（測試/Test）與 VSA 量價分析法（Effort vs Result、No Supply），機構沿用近百年框架，非本系統原創</div></div>`;
  }

  if (mf.evidence.length) {
    html += '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">判斷依據</div>';
    mf.evidence.forEach(e => {
      html += `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--bd)"><span style="color:${col}">▸</span><span style="font-size:11px;color:var(--muted);line-height:1.5">${e}</span></div>`;
    });
  }

  // OBV/MFI 小標
  const obvTxt = mf.obvSlope > 0.3 ? '量能潮上升' : mf.obvSlope < -0.3 ? '量能潮下降' : '量能潮平緩';
  html += `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
    <div style="background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:5px 10px;font-size:11px"><span style="color:var(--muted)">OBV</span> <span style="font-family:var(--mono);font-weight:700;color:${mf.obvSlope>0.3?'var(--buy)':mf.obvSlope<-0.3?'var(--sell)':'var(--muted)'}">${obvTxt}</span></div>
    <div style="background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:5px 10px;font-size:11px"><span style="color:var(--muted)">MFI資金流</span> <span style="font-family:var(--mono);font-weight:700;color:${mf.mfi>=80?'var(--sell)':mf.mfi<=20?'var(--buy)':'var(--txt)'}">${mf.mfi.toFixed(0)}</span></div>
    ${mf.kbar!=null?`<div style="background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:5px 10px;font-size:11px"><span style="color:var(--muted)">KBAR強度</span> <span style="font-family:var(--mono);font-weight:700;color:${mf.kbar>=0.1?'var(--buy)':mf.kbar<=-0.1?'var(--sell)':'var(--txt)'}">${mf.kbar>=0?'+':''}${mf.kbar.toFixed(2)}</span></div>`:''}
  </div>
  <div style="font-size:10px;color:var(--muted2);margin-top:10px;line-height:1.5">💡 主力行為屬「推估」而非事實，需與籌碼/共振交叉驗證。影線以真實開盤價計算（後端未更新時以前收近似）。KBAR淨強度為機構級特徵（Qlib Alpha158系）。</div>`;

  document.getElementById('mainforce-content').innerHTML = html;
}

/* ══ C. 融資融券 · 散戶心理 + 軋空偵測 ═══════════════════════════════
   融資 = 散戶槓桿代理。融資與價格的組合直接反映「散戶 vs 主力」：
   融資增+價跌 = 散戶接刀（最危險）／融資減+價漲 = 主力行情（最健康）
   券資比 = 融券/融資，過高 = 軋空風險（空單必看）
   ════════════════════════════════════════════════════════════════════ */
const _marginCache = {};
async function fetchMarginData(code) {
  const hit = _marginCache[code];
  if (hit && Date.now() - hit.t < 300000) return hit.d;
  if (!GAS_URL || GAS_URL.indexOf('http') !== 0) return null;
  try {
    const r = await fetch(`${GAS_URL}?action=margin&code=${encodeURIComponent(code)}`);
    const j = await r.json();
    if (j.ok) { _marginCache[code] = { d: j, t: Date.now() }; return j; }
  } catch (e) { if (typeof ErrorLog !== 'undefined') ErrorLog.push('融資融券', e); }
  return null;
}

async function loadMarginCard(D) {
  const card = document.getElementById('margin-card');
  if (!card) return;
  const m = await fetchMarginData(D.code);
  if (window._activeCode && window._activeCode !== D.code) return;  // 已換股，丟棄這次遲到的結果
  if (!m) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const c = D.closes, n = c.length;
  const chg5 = n >= 6 ? (D.price - c[n-6]) / c[n-6] * 100 : 0;
  const mc = m.marginChg5 || 0;

  // 散戶 vs 主力 四象限判讀
  let verdict, vCol, vDesc;
  if (mc > 4 && chg5 < -1) {
    verdict = '🚨 散戶接刀'; vCol = 'var(--sell)';
    vDesc = `融資5日+${mc.toFixed(1)}%但股價跌${chg5.toFixed(1)}%——散戶用槓桿逢低接、大戶倒貨給散戶。這是「散戶賠大戶賺」最典型的型態，極危險`;
  } else if (mc > 4 && chg5 > 1) {
    verdict = '⚠️ 散戶追價'; vCol = 'var(--warn)';
    vDesc = `融資+${mc.toFixed(1)}%且價漲——散戶槓桿追多。若在高檔，這批融資就是主力未來的出貨對象與助跌燃料`;
  } else if (mc < -4 && chg5 > 1) {
    verdict = '💪 主力行情'; vCol = 'var(--buy)';
    vDesc = `融資-${Math.abs(mc).toFixed(1)}%但價漲——散戶下車、主力推升，籌碼乾淨。這是最健康的上漲結構`;
  } else if (mc < -4 && chg5 < -1) {
    verdict = '🧹 籌碼清洗'; vCol = 'var(--warn)';
    vDesc = `融資-${Math.abs(mc).toFixed(1)}%且價跌——散戶停損斷頭中。浮額洗清是打底的必經過程，但別急著接，等止穩`;
  } else {
    verdict = '➖ 融資平穩'; vCol = 'var(--muted)';
    vDesc = `融資5日變化 ${mc >= 0 ? '+' : ''}${mc.toFixed(1)}%，散戶槓桿無明顯異動`;
  }

  let html = `<div style="padding:12px;background:${vCol}12;border:1px solid ${vCol}50;border-radius:10px;margin-bottom:12px">
    <div style="font-size:14px;font-weight:800;color:${vCol};margin-bottom:4px">${verdict}</div>
    <div style="font-size:11px;color:var(--muted);line-height:1.6">${vDesc}</div>
  </div>
  <div class="risk-grid">
    <div class="risk-box"><div class="rb-label">💳 融資餘額</div><div class="rb-value">${fmtV(Math.round(m.marginBal))} 張</div><div class="rb-sub">5日變化 ${mc>=0?'+':''}${mc.toFixed(1)}%（散戶槓桿指標）</div></div>
    <div class="risk-box"><div class="rb-label">📉 融券餘額</div><div class="rb-value">${fmtV(Math.round(m.shortBal))} 張</div><div class="rb-sub">券資比 ${m.shortRatio.toFixed(1)}%</div></div>
  </div>`;

  // 軋空偵測（對空方交易者最重要）
  if (m.shortRatio >= 30) {
    html += `<div style="margin-top:10px;padding:10px 12px;background:var(--sell-d);border:1px solid var(--sell);border-radius:8px">
      <div style="font-size:12px;font-weight:700;color:var(--sell)">⚡ 軋空警報：券資比 ${m.shortRatio.toFixed(0)}%</div>
      <div style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:2px">融券佔融資比例過高，空單擁擠。任何利多或強拉都可能觸發空單回補潮（軋空），<b>持有空單者務必嚴設停損</b>；已有空單且開始逆勢上漲時，優先減碼</div>
    </div>`;
  } else if (m.shortRatio >= 18) {
    html += `<div style="margin-top:10px;font-size:11px;color:var(--warn)">⚠️ 券資比 ${m.shortRatio.toFixed(0)}% 偏高，空單留意軋空風險</div>`;
  }
  document.getElementById('margin-content').innerHTML = html;
  // 補繪前校驗：確認使用者還在看同一檔（防快速換股的 async 競爭導致張冠李戴）
  if (window._activeCode === D.code) {
    try { if (typeof renderCrowding === 'function' && window._lastD && window._lastD.code === D.code) renderCrowding(window._lastD, window._lastFormulas); } catch (e) {}
    try { if (typeof renderTradeGate === 'function' && window._gateCtx && window._gateCtx.D && window._gateCtx.D.code === D.code) renderTradeGate(window._gateCtx); } catch (e) {}
  }
}

/* ══ D. 智慧停損（防「停損完就反向走」）══════════════════════════════
   停損不放整數ATR位（主力最愛掃的位置），改放「結構位之外+緩衝」，
   並統計該股歷史「假跌破後收回率」——收回率越高，越要把停損放遠離結構位
   ════════════════════════════════════════════════════════════════════ */
function computeSmartStop(D, atr) {
  // 停損是實際下單價位，全部改用未還原市價，避免與 computeStructure 的原始價結構混用基準
  const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows, n = c.length;
  const price = D.rawCloses ? D.rawCloses[D.rawCloses.length - 1] : D.price;
  const st = (typeof computeStructure === 'function') ? computeStructure(D) : null;

  // 歷史假跌破/假突破收回率（近120日，20日滾動支撐/壓力）
  let piercesL = 0, recoversL = 0, piercesS = 0, recoversS = 0;
  const start = Math.max(30, n - 120);
  for (let i = start; i < n - 2; i++) {
    const sup = Math.min(...l.slice(i - 20, i));
    const res = Math.max(...h.slice(i - 20, i));
    if (l[i] < sup) { piercesL++; if (c[i+1] > sup || c[i+2] > sup) recoversL++; }
    if (h[i] > res) { piercesS++; if (c[i+1] < res || c[i+2] < res) recoversS++; }
  }
  const sweepRateL = piercesL >= 3 ? recoversL / piercesL : null; // 假跌破收回率
  const sweepRateS = piercesS >= 3 ? recoversS / piercesS : null; // 假突破收回率

  // 緩衝：收回率越高（越愛洗），緩衝越大（0.5~1×ATR）
  const bufL = 0.5 + (sweepRateL != null ? sweepRateL * 0.5 : 0.25);
  const bufS = 0.5 + (sweepRateS != null ? sweepRateS * 0.5 : 0.25);

  // 做多：結構停損 = 前波低 − 緩衝×ATR；與 2×ATR 取較遠者，上限 3×ATR
  const atrStopL = price - 2 * atr;
  let stopL = atrStopL, methodL = '2×ATR';
  if (st && st.lastLow && st.lastLow < price) {
    const structStop = st.lastLow - bufL * atr;
    if (structStop < atrStopL) { stopL = structStop; methodL = `前波低−${bufL.toFixed(1)}×ATR緩衝`; }
    else { stopL = structStop > price - atr ? atrStopL : structStop; methodL = structStop > price - atr ? '2×ATR（結構太近）' : `前波低−${bufL.toFixed(1)}×ATR`; }
  }
  if (price - stopL > 3 * atr) { stopL = price - 3 * atr; methodL += '（上限3×ATR）'; }

  // 做空：結構停損 = 前波高 + 緩衝×ATR
  const atrStopS = price + 2 * atr;
  let stopS = atrStopS, methodS = '2×ATR';
  if (st && st.lastHigh && st.lastHigh > price) {
    const structStop = st.lastHigh + bufS * atr;
    if (structStop > atrStopS) { stopS = structStop; methodS = `前波高+${bufS.toFixed(1)}×ATR緩衝`; }
    else { stopS = structStop < price + atr ? atrStopS : structStop; methodS = structStop < price + atr ? '2×ATR（結構太近）' : `前波高+${bufS.toFixed(1)}×ATR`; }
  }
  if (stopS - price > 3 * atr) { stopS = price + 3 * atr; methodS += '（上限3×ATR）'; }

  return {
    long: { stop: stopL, method: methodL, sweepRate: sweepRateL },
    short: { stop: stopS, method: methodS, sweepRate: sweepRateS }
  };
}

/* ══ E. 反明牌雷達（散戶擁擠度偵測）══════════════════════════════════
   量化「這個訊號有多教科書」——AI散戶工具都吐同樣結論（RSI超賣買、
   MACD金叉買、突破追、跌破殺）。明牌訊號越擁擠，越可能是主力的獵場：
   擁擠 + 主力反向（OBV/法人）= 明牌陷阱；擁擠 = 停損聚集 = 先被掃
   ════════════════════════════════════════════════════════════════════ */
/* ══ ETF 換股窗口警示 ═══════════════════════════════════════════════
   依據：0050/006208等市值型ETF每季（3/6/9/12月）審核，公告後10-20天生效；
   0056/00878/00919等高股息ETF每半年審核，換股幅度通常更大（如00919曾18進18出）。
   公告到生效的空窗期是市場最敏感階段（搶跑效應：法人/自營商提前買賣即將納入/剔除的股票）。
   本功能僅做「日期窗口」提醒，不臆測個股是否為成分股（無可靠免費即時資料源可查證個股名單）。
   ════════════════════════════════════════════════════════════════════ */
function checkETFRebalanceWindow() {
  const today = new Date();
  const y = today.getFullYear();
  // 市值型ETF：3/6/9/12月，公告約在該月上旬，生效在該月第三個週五後
  const capMonths = [3, 6, 9, 12];
  // 高股息ETF：通常在6月與12月前後審核（半年制，實際日期各投信略有差異，此為概估窗口）
  const divMonths = [6, 12];
  // 用「所在年」與「前一年」各自算12月目標日取最小距離，修正跨年邊界（1月上旬時，
  // 去年12月的窗口若只用當年12月當基準會變成11個月後的未來，永遠判斷不到）
  const inWindow = (month, daysBefore, daysAfter) => {
    const candidates = [new Date(y, month - 1, 15), new Date(y - 1, month - 1, 15), new Date(y + 1, month - 1, 15)];
    return candidates.some(target => {
      const diffDays = (today - target) / 86400000;
      return diffDays >= -daysBefore && diffDays <= daysAfter;
    });
  };
  const capActive = capMonths.some(m => inWindow(m, 5, 20));
  const divActive = divMonths.some(m => inWindow(m, 10, 25));
  if (!capActive && !divActive) return null;
  return {
    capActive, divActive,
    text: capActive && divActive
      ? '市值型（0050/006208）與高股息型（0056/00878/00919）ETF換股窗口重疊期'
      : capActive ? '市值型ETF（0050/006208）季度換股窗口期' : '高股息ETF（0056/00878/00919）半年換股窗口期',
  };
}

function computeCrowding(D, formulas) {
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes, n = c.length;
  const price = D.price;
  let buyVotes = 0, sellVotes = 0;
  const seen = [];

  // 教科書訊號盤點（每個AI散戶工具都會報的那幾條）
  const rsi = _btRSI(c, 14);
  if (rsi <= 32) { buyVotes++; seen.push(`RSI ${rsi.toFixed(0)} 超賣（AI教科書：買）`); }
  else if (rsi >= 68) { sellVotes++; seen.push(`RSI ${rsi.toFixed(0)} 超買（AI教科書：賣）`); }

  const kd = _btKD(h, l, c, 9);
  if (kd.k <= 22) { buyVotes++; seen.push(`KD ${kd.k.toFixed(0)} 低檔（教科書：買）`); }
  else if (kd.k >= 78) { sellVotes++; seen.push(`KD ${kd.k.toFixed(0)} 高檔（教科書：賣）`); }

  const macd = _btMACD(c);
  if (macd.hist > 0) { buyVotes++; seen.push('MACD 柱體翻紅（教科書：買）'); }
  else if (macd.hist < 0) { sellVotes++; seen.push('MACD 柱體翻綠（教科書：賣）'); }

  const ma20 = _btSMA(c, 20), ma60 = _btSMA(c, 60);
  if (price > ma20 && ma20 > ma60) { buyVotes++; seen.push('均線多頭排列（教科書：買）'); }
  else if (price < ma20 && ma20 < ma60) { sellVotes++; seen.push('均線空頭排列（教科書：賣）'); }

  // 追突破/殺跌破（散戶最愛）
  const high20 = Math.max(...h.slice(-21, -1)), low20 = Math.min(...l.slice(-21, -1));
  if (price > high20) { buyVotes++; seen.push('突破20日高（散戶追突破點）'); }
  else if (price < low20) { sellVotes++; seen.push('跌破20日低（散戶恐慌停損點）'); }

  // 連漲連跌（追價/殺跌情緒）
  let streak = 0;
  for (let i = n - 1; i > 0; i--) { if (c[i] > c[i-1]) { if (streak >= 0) streak++; else break; } else if (c[i] < c[i-1]) { if (streak <= 0) streak--; else break; } else break; }
  if (streak >= 3) { buyVotes++; seen.push(`連漲${streak}天（FOMO追價環境）`); }
  else if (streak <= -3) { sellVotes++; seen.push(`連跌${Math.abs(streak)}天（恐慌殺跌環境）`); }

  // 擁擠方向與擁擠度
  const crowdDir = buyVotes - sellVotes >= 2 ? 1 : sellVotes - buyVotes >= 2 ? -1 : 0;
  const maxV = Math.max(buyVotes, sellVotes);
  let crowding = Math.round(maxV / 6 * 60);
  // 乖離放大擁擠（追到離均線很遠=晚進場的散戶多）
  const bias = (price - ma20) / ma20 * 100;
  if (Math.abs(bias) > 8) crowding += 20;
  else if (Math.abs(bias) > 5) crowding += 10;
  // 融資同向加成（散戶真金白銀進場的證據，若已載入）
  let marginNote = null;
  const mc = _marginCache[D.code];
  if (mc && mc.d) {
    if (crowdDir === 1 && mc.d.marginChg5 > 4) { crowding += 20; marginNote = `融資5日+${mc.d.marginChg5.toFixed(1)}%——散戶不只看到明牌，還真的用槓桿進場了`; }
    if (crowdDir === -1 && mc.d.shortRatio >= 20) { crowding += 15; marginNote = `券資比 ${mc.d.shortRatio.toFixed(0)}%——散戶空單也擁擠，殺跌明牌+軋空燃料並存`; }
  }
  crowding = Math.min(100, crowding);

  // 主力是否站在明牌反面（陷阱偵測）
  let trap = null;
  try {
    const { oSlope } = computeOBV(D);
    const instNet = D.chip ? (D.chip.foreign5 + D.chip.trust5) : null;
    if (crowdDir === 1 && crowding >= 55 && (oSlope < -0.25 || (instNet != null && instNet < 0))) {
      trap = { type: 'bull', text: `明牌多頭陷阱風險：教科書訊號全亮多（${buyVotes}條）、散戶看得到也追得進，但${oSlope < -0.25 ? 'OBV量能潮下降（主力邊拉邊出）' : '法人站賣方'}——散戶照AI教科書買，主力照單全收` };
    } else if (crowdDir === -1 && crowding >= 55 && (oSlope > 0.25 || (instNet != null && instNet > 0))) {
      trap = { type: 'bear', text: `明牌空頭陷阱風險（誘空）：教科書訊號全亮空（${sellVotes}條）、殺跌明牌人盡皆知，但${oSlope > 0.25 ? 'OBV量能潮上升（主力默默吃貨）' : '法人站買方'}——此時進空單=跟散戶擠同一邊，小心被軋` };
    }
  } catch (e) { /* OBV 失敗略過 */ }

  return { crowdDir, crowding, buyVotes, sellVotes, seen, trap, bias, marginNote };
}

function renderCrowding(D, formulas) {
  const card = document.getElementById('crowd-card');
  if (!card) return;
  card.style.display = 'block';
  const cw = computeCrowding(D, formulas);

  const dirTxt = cw.crowdDir === 1 ? '散戶擁擠在「多方」' : cw.crowdDir === -1 ? '散戶擁擠在「空方」' : '無明顯擁擠方向';
  const col = cw.crowding >= 70 ? 'var(--sell)' : cw.crowding >= 45 ? 'var(--warn)' : 'var(--buy)';

  let html = `<div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
    <div style="text-align:center;min-width:78px">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">明牌擁擠度</div>
      <div style="font-family:var(--mono);font-size:34px;font-weight:800;color:${col};line-height:1">${cw.crowding}</div>
    </div>
    <div style="flex:1">
      <div style="font-size:13px;font-weight:700;color:${col}">${dirTxt}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px;line-height:1.5">${cw.crowding >= 70 ? '極度擁擠——這個結論每個用AI的散戶都看得到，明牌的預期報酬已被稀釋，且停損位高度聚集' : cw.crowding >= 45 ? '中度擁擠——教科書訊號偏一致，留意先掃停損再走的劇本' : '不擁擠——目前不是人盡皆知的明牌，訊號含金量相對高'}</div>
    </div>
  </div>`;

  if (cw.trap) {
    html += `<div style="padding:11px 13px;background:var(--sell-d);border:1px solid var(--sell);border-radius:9px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:700;color:var(--sell);margin-bottom:3px">🪤 ${cw.trap.type === 'bull' ? '多頭明牌陷阱' : '空頭明牌陷阱（誘空）'}</div>
      <div style="font-size:11px;color:var(--muted);line-height:1.6">${cw.trap.text}</div>
    </div>`;
  }
  if (cw.marginNote) {
    html += `<div style="font-size:11px;color:var(--warn);margin-bottom:10px;line-height:1.5">💳 ${cw.marginNote}</div>`;
  }
  // ETF換股窗口警示（日期運算，不臆測個股是否為成分股）
  try {
    const etfW = typeof checkETFRebalanceWindow === 'function' ? checkETFRebalanceWindow() : null;
    if (etfW) {
      html += `<div style="padding:9px 12px;background:var(--warn-d);border:1px solid var(--warn);border-radius:8px;margin-bottom:10px;font-size:11px;color:var(--muted);line-height:1.6">📅 <b style="color:var(--warn)">${etfW.text}</b>——公告到生效的空窗期常見「搶跑效應」：法人/自營商提前買賣即將納入/剔除的成分股，中小型股尤其明顯。若持股接近0050/006208/0056/00878/00919市值門檻或殖利率門檻，留意換股名單公告（臺灣指數公司/富時羅素官網）。</div>`;
    }
  } catch (e) {}
  if (cw.seen.length) {
    html += '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">目前亮著的教科書訊號（AI散戶都看得到的）</div>';
    cw.seen.forEach(s => {
      html += `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--bd)"><span style="color:var(--muted2)">▸</span><span style="font-size:11px;color:var(--muted)">${s}</span></div>`;
    });
  }
  html += `<div style="font-size:10px;color:var(--muted2);margin-top:10px;line-height:1.6">💡 反明牌邏輯：擁擠度高≠必反轉，但「擁擠+主力反向（OBV/法人）」= 高風險陷阱。停損位在擁擠訊號下常先被掃——本系統智慧停損已放結構外緩衝區。學術研究（Aghbabali, Chung & Huh, 2025）發現ChatGPT普及後，散戶交易方向的一致性明顯提高——這代表AI讓「所有人看到同一訊號」的風險比以前更高，本雷達正是為此設計：真正的優勢不在看到訊號，在知道多少人跟你看到同一個。</div>`;
  document.getElementById('crowd-content').innerHTML = html;
}

/* ══ F. 主力縱深（FinMind：千張大戶 / 法人借券空單 / 分點）═══════════
   免費API拿不到的深層籌碼。核心判讀：
   ①剪刀差：大戶增+散戶減=籌碼流向大戶；反向=大戶倒貨
   ②部位背離（統計優勢）：法人借券(聰明錢空單) vs 散戶融券(笨錢空單)
     背離時站聰明錢那邊——這是誠實版的「套利」
   ════════════════════════════════════════════════════════════════════ */
const _deepCache = {};
async function loadDeepChipCard(D) {
  const card = document.getElementById('deepchip-card');
  if (!card) return;
  if (D.currency !== 'TWD' || typeof FINMIND_TOKEN === 'undefined' || !FINMIND_TOKEN) { card.style.display = 'none'; return; }
  let dc = null;
  const hit = _deepCache[D.code];
  if (hit && Date.now() - hit.t < 600000) dc = hit.d;
  else {
    try {
      const r = await fetch(`${GAS_URL}?action=deepchip&code=${encodeURIComponent(D.code)}&token=${encodeURIComponent(FINMIND_TOKEN)}`);
      const j = await r.json();
      if (j.ok) { dc = j; _deepCache[D.code] = { d: j, t: Date.now() }; }
    } catch (e) { if (typeof ErrorLog !== 'undefined') ErrorLog.push('主力縱深', e); }
  }
  if (window._activeCode && window._activeCode !== D.code) return;  // 已換股，丟棄遲到結果
  if (!dc) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  let html = '';

  // ── ① 千張大戶剪刀差 ──
  if (dc.big) {
    const b = dc.big;
    let verdict, vCol;
    if (b.bigChg > 0.3 && b.smallChg < -0.2) { verdict = '💪 籌碼流向大戶（大戶吸、散戶吐）——結構偏多，空單逆結構要快進快出'; vCol = 'var(--buy)'; }
    else if (b.bigChg < -0.3 && b.smallChg > 0.2) { verdict = '🚨 大戶倒貨給散戶（大戶減、散戶接）——空單的結構順風，這是「散戶賠大戶賺」的原型'; vCol = 'var(--sell)'; }
    else { verdict = '➖ 大戶散戶結構無明顯變化'; vCol = 'var(--muted)'; }
    html += `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🐘 千張大戶剪刀差（近${b.weeks}週）</div>
    <div class="risk-grid" style="margin-bottom:8px">
      <div class="risk-box"><div class="rb-label">千張以上持股</div><div class="rb-value">${b.bigPct}%</div><div class="rb-sub" style="color:${b.bigChg>=0?'var(--buy)':'var(--sell)'}">${b.bigChg>=0?'+':''}${b.bigChg}%（期間變化）</div></div>
      <div class="risk-box"><div class="rb-label">50張以下散戶</div><div class="rb-value">${b.smallPct}%</div><div class="rb-sub" style="color:${b.smallChg<=0?'var(--buy)':'var(--sell)'}">${b.smallChg>=0?'+':''}${b.smallChg}%（期間變化）</div></div>
    </div>
    <div style="padding:9px 12px;background:${vCol}10;border:1px solid ${vCol}50;border-radius:8px;font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:12px">${verdict}</div>`;
  }

  // ── ② 部位背離：法人借券 vs 散戶融券 ──
  if (dc.lend) {
    const L = dc.lend;
    const m = _marginCache[D.code] ? _marginCache[D.code].d : null;
    let verdict, vCol;
    const instShortUp = L.chg5 >= 8, instShortDown = L.chg5 <= -8;
    const retailShortUp = m && m.shortRatio >= 15;
    if (instShortUp && !retailShortUp) { verdict = '🎯 法人借券空單增、散戶未跟——聰明錢在放空且不擁擠，你的空單有機構隊友（部位優勢站你這邊）'; vCol = 'var(--sell)'; }
    else if (!instShortUp && retailShortUp) { verdict = '⚡ 散戶融券擁擠但法人借券不增——笨錢獨自看空=軋空燃料。此時進空單=跟散戶擠同邊，站到聰明錢對面了'; vCol = 'var(--warn)'; }
    else if (instShortUp && retailShortUp) { verdict = '⚠️ 法人散戶同步看空——方向或許對，但空單全面擁擠，任何利多都可能連環軋空，部位務必縮小'; vCol = 'var(--warn)'; }
    else if (instShortDown) { verdict = '📈 法人借券空單回補中——機構空方撤退，空單失去隊友，考慮跟著獲利了結'; vCol = 'var(--buy)'; }
    else { verdict = '➖ 法人空單無明顯異動'; vCol = 'var(--muted)'; }
    html += `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">⚔️ 部位背離（聰明錢 vs 笨錢空單）</div>
    <div class="risk-box" style="margin-bottom:8px"><div class="rb-label">法人借券賣出餘額</div><div class="rb-value">${fmtV(L.bal)} 張</div><div class="rb-sub" style="color:${L.chg5>=0?'var(--sell)':'var(--buy)'}">5日 ${L.chg5>=0?'+':''}${L.chg5}%（外資放空主要管道）</div></div>
    <div style="padding:9px 12px;background:${vCol}10;border:1px solid ${vCol}50;border-radius:8px;font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:12px">${verdict}</div>`;
  }

  // ── ③ 分點主力動向 ──
  if (dc.brokers && dc.brokers.length) {
    const dir3 = dc.brokers.map(b => b.mainNet > 0 ? 1 : b.mainNet < 0 ? -1 : 0);
    const allBuy = dir3.every(d => d === 1), allSell = dir3.every(d => d === -1);
    html += `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">📍 分點主力動向（前15大分點淨額）</div>`;
    dc.brokers.forEach(b => {
      const c2 = b.mainNet > 0 ? 'var(--buy)' : b.mainNet < 0 ? 'var(--sell)' : 'var(--muted)';
      html += `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--bd)">
        <span style="font-size:11px;color:var(--muted);width:80px">${b.date.slice(5)}</span>
        <span style="font-family:var(--mono);font-size:12px;font-weight:700;color:${c2};flex:1">${b.mainNet>0?'+':''}${fmtV(b.mainNet)} 張</span>
        <span style="font-size:10px;color:var(--muted2)">集中度 ${b.conc}%</span>
      </div>`;
    });
    if (allBuy || allSell) {
      const c3 = allBuy ? 'var(--buy)' : 'var(--sell)';
      html += `<div style="margin-top:8px;font-size:11px;color:${c3};font-weight:600">${allBuy ? '📈 主力分點連續3日淨買——有人持續收貨' : '📉 主力分點連續3日淨賣——有人持續出貨'}</div>`;
    }
  }

  html += `<div style="font-size:10px;color:var(--muted2);margin-top:10px;line-height:1.6">💡 部位背離是「統計優勢」不是無風險套利（零售層級不存在套利）。持股分級為週資料。資料來源：FinMind。</div>`;
  document.getElementById('deepchip-content').innerHTML = html;
  // 補繪前校驗代碼一致（防 async 競爭）
  if (window._activeCode === D.code) {
    try { if (typeof renderTradeGate === 'function' && window._gateCtx && window._gateCtx.D && window._gateCtx.D.code === D.code) renderTradeGate(window._gateCtx); } catch (e) {}
  }
}

/* ══ 意圖引擎真實資料回測 ═══════════════════════════════════════════════
   在該股「真實2年日K」上逐日重演：每天只給引擎當天以前的資料，記錄判定，
   再對照之後5日真實走勢。洗盤/進貨期望後市漲、出貨期望後市跌。
   事件化計數：同一判定連續出現只計首次（間隔≥10日才重計），避免同一事件灌水。
   PSY用中性值50固定（歷史PSY未逐日重算，寧可少一項證據也不引入前視偏誤）。
   ════════════════════════════════════════════════════════════════════ */
function computeIntentBacktest(D) {
  const n = D.closes.length;
  if (n < 130) return null;
  const H2 = 10;   // 同時統計5日與10日：洗盤機制上需等測試完成才反彈，單一視窗有盲點，雙視窗不挑好看的報
  const stats = { '洗盤': { n: 0, sum5: 0, win5: 0, sum10: 0, win10: 0 }, '出貨': { n: 0, sum5: 0, win5: 0, sum10: 0, win10: 0 }, '進貨': { n: 0, sum5: 0, win5: 0, sum10: 0, win10: 0 } };
  const neutralF = { psy: { value: 50 } };
  const lastCount = { '洗盤': -99, '出貨': -99, '進貨': -99 };   // 各類判定獨立去重（信心短暫跌破50不會讓同一事件被重複計數）
  for (let i = 70; i < n - H2; i++) {
    const Ds = { closes: D.closes.slice(0, i + 1), highs: D.highs.slice(0, i + 1), lows: D.lows.slice(0, i + 1),
                 volumes: D.volumes.slice(0, i + 1), price: D.closes[i], chip: null };
    let it = null;
    try { const mfs = computeMainForce(Ds, neutralF); it = computeIntentAnalysis(Ds, neutralF, mfs); } catch (e) { continue; }
    if (!it || it.verdict === '訊號不足' || it.confidence < 50) continue;
    if (i - lastCount[it.verdict] < 10) continue;   // 同事件去重
    lastCount[it.verdict] = i;
    const s = stats[it.verdict]; if (!s) continue;
    const f5 = (D.closes[i + 5] - D.closes[i]) / D.closes[i] * 100;
    const f10 = (D.closes[i + H2] - D.closes[i]) / D.closes[i] * 100;
    s.n++; s.sum5 += f5; s.sum10 += f10;
    const expectUp = it.verdict !== '出貨';
    if ((expectUp && f5 > 0) || (!expectUp && f5 < 0)) s.win5++;
    if ((expectUp && f10 > 0) || (!expectUp && f10 < 0)) s.win10++;
  }
  const total = stats['洗盤'].n + stats['出貨'].n + stats['進貨'].n;
  if (total < 3) return null;   // 事件太少不顯示，避免無意義統計
  return { stats, total };
}
