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

  // ── 影線形態（以前收近似開盤，近似法）──
  let lowerShadowDays = 0;
  for (let i = Math.max(1, n - 10); i < n; i++) {
    const openApprox = c[i-1];
    const bodyLow = Math.min(openApprox, c[i]);
    const range = h[i] - l[i] || 1;
    if ((bodyLow - l[i]) / range > 0.45) lowerShadowDays++;
  }
  if (lowerShadowDays >= 3 && pSlope <= 0.03) add('吸籌', 15, `近10日 ${lowerShadowDays} 根長下影（低檔有承接手）`);

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
      desc: '目前量價籌碼未出現典型的主力行為特徵，屬正常交易狀態', obvSlope: oSlope, mfi };
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
    desc: descMap[topName], obvSlope: oSlope, mfi };
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
  </div>
  <div style="font-size:10px;color:var(--muted2);margin-top:10px;line-height:1.5">💡 主力行為屬「推估」而非事實，需與籌碼/共振交叉驗證。影線分析以前收近似開盤。</div>`;

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
}

/* ══ D. 智慧停損（防「停損完就反向走」）══════════════════════════════
   停損不放整數ATR位（主力最愛掃的位置），改放「結構位之外+緩衝」，
   並統計該股歷史「假跌破後收回率」——收回率越高，越要把停損放遠離結構位
   ════════════════════════════════════════════════════════════════════ */
function computeSmartStop(D, atr) {
  const c = D.closes, h = D.highs, l = D.lows, n = c.length;
  const price = D.price;
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
