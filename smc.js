/* ══════════════════════════════════════════════════════════════════════
   smc.js — VWAP + 市場結構(BOS/CHoCH) + 過熱反指標
   ──────────────────────────────────────────────────────────────────
   A. VWAP 移動成交量加權均價（機構成本線）
   B. BOS 結構突破 / CHoCH 性格轉變（聰明錢結構，純數學）
   C. 過熱反指標（用硬數據抓「新聞狂熱」效果，比抓新聞可靠）
   依賴：app.js($/fmt)、formula.js
   ══════════════════════════════════════════════════════════════════════ */

/* ══ A. VWAP 移動成交量加權均價 ════════════════════════════════════════
   VWAP = Σ(典型價×量) / Σ量，典型價=(高+低+收)/3
   價在 VWAP 上=多方掌控(機構成本之上)、下=空方掌控
   ════════════════════════════════════════════════════════════════════ */
function computeVWAP(D, period) {
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes;
  const n = c.length;
  const N = Math.min(period || 20, n);
  let sumPV = 0, sumV = 0;
  for (let i = n - N; i < n; i++) {
    const typical = (h[i] + l[i] + c[i]) / 3;
    sumPV += typical * v[i];
    sumV += v[i];
  }
  const vwap = sumV > 0 ? sumPV / sumV : c[n-1];
  const price = D.price;
  const dist = (price - vwap) / vwap * 100;
  let signal, desc;
  if (dist > 2) { signal = 'buy'; desc = `價在 VWAP 上方 ${dist.toFixed(1)}%，多方掌控（站穩機構成本之上）`; }
  else if (dist < -2) { signal = 'sell'; desc = `價在 VWAP 下方 ${Math.abs(dist).toFixed(1)}%，空方掌控（跌破機構成本）`; }
  else { signal = 'hold'; desc = `價貼近 VWAP（${dist>=0?'+':''}${dist.toFixed(1)}%），多空均衡，機構成本附近`; }
  return { vwap, dist, signal, desc, period: N };
}

/* ══ B. BOS / CHoCH 市場結構 ══════════════════════════════════════════
   找近期 swing high/low，判斷：
   BOS(Break of Structure)：順勢突破前高/前低 → 趨勢延續
   CHoCH(Change of Character)：逆勢突破 → 趨勢可能反轉
   ════════════════════════════════════════════════════════════════════ */
function computeStructure(D) {
  const h = D.highs, l = D.lows, c = D.closes;
  const n = c.length;
  const N = Math.min(60, n);
  const hs = h.slice(-N), ls = l.slice(-N), cs = c.slice(-N);

  // 找 swing 點（前後2根都低/高）
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < N - 2; i++) {
    if (hs[i] > hs[i-1] && hs[i] > hs[i-2] && hs[i] > hs[i+1] && hs[i] > hs[i+2]) swingHighs.push({ i, price: hs[i] });
    if (ls[i] < ls[i-1] && ls[i] < ls[i-2] && ls[i] < ls[i+1] && ls[i] < ls[i+2]) swingLows.push({ i, price: ls[i] });
  }
  const price = D.price;
  const lastHigh = swingHighs.length ? swingHighs[swingHighs.length-1] : null;
  const lastLow = swingLows.length ? swingLows[swingLows.length-1] : null;

  // 判斷整體趨勢（用近期 swing 高低點走向）
  let trend = 'range';
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hUp = swingHighs[swingHighs.length-1].price > swingHighs[swingHighs.length-2].price;
    const lUp = swingLows[swingLows.length-1].price > swingLows[swingLows.length-2].price;
    if (hUp && lUp) trend = 'up';       // 高點低點都墊高=上升結構
    else if (!hUp && !lUp) trend = 'down';
  }

  // 判斷突破事件
  let event = null, eventType = '', eventDesc = '';
  if (lastHigh && price > lastHigh.price) {
    if (trend === 'up' || trend === 'range') {
      event = 'BOS_up'; eventType = '🟢 BOS 向上突破';
      eventDesc = `突破前波高點 ${fmt(lastHigh.price)}，上升結構延續，機構續買訊號`;
    } else {
      event = 'CHoCH_up'; eventType = '🔄 CHoCH 轉多';
      eventDesc = `下降結構中突破前高 ${fmt(lastHigh.price)}，性格轉變，可能由空轉多`;
    }
  } else if (lastLow && price < lastLow.price) {
    if (trend === 'down' || trend === 'range') {
      event = 'BOS_down'; eventType = '🔴 BOS 向下跌破';
      eventDesc = `跌破前波低點 ${fmt(lastLow.price)}，下降結構延續，機構續賣訊號`;
    } else {
      event = 'CHoCH_down'; eventType = '🔄 CHoCH 轉空';
      eventDesc = `上升結構中跌破前低 ${fmt(lastLow.price)}，性格轉變，可能由多轉空`;
    }
  }

  const trendMap = { up: '上升結構（高低點墊高）', down: '下降結構（高低點壓低）', range: '盤整結構（無明確方向）' };
  return {
    trend, trendDesc: trendMap[trend],
    lastHigh: lastHigh ? lastHigh.price : null,
    lastLow: lastLow ? lastLow.price : null,
    event, eventType, eventDesc
  };
}

/* ══ C. 過熱反指標（用硬數據抓「新聞狂熱」效果）════════════════════════
   新聞狂熱必反映在數據：爆量+連漲+乖離大+融資暴增+PCR極端
   用這些抓「群眾過熱」，比抓不可靠的新聞情緒準
   ════════════════════════════════════════════════════════════════════ */
function computeOverheat(D, formulas, market) {
  const c = D.closes, v = D.volumes;
  const price = D.price;
  let heat = 0; const reasons = [];

  // 連漲天數
  let upStreak = 0;
  for (let i = c.length-1; i > 0; i--) { if (c[i] > c[i-1]) upStreak++; else break; }
  if (upStreak >= 6) { heat += 25; reasons.push(`連漲 ${upStreak} 天（散戶FOMO追高）`); }
  else if (upStreak >= 4) { heat += 12; reasons.push(`連漲 ${upStreak} 天`); }

  // 乖離過大
  const ma20 = c.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, c.length);
  const bias = (price - ma20) / ma20 * 100;
  if (bias > 12) { heat += 25; reasons.push(`正乖離 +${bias.toFixed(0)}%（離均線過遠，過熱）`); }
  else if (bias > 8) { heat += 12; reasons.push(`正乖離 +${bias.toFixed(0)}%`); }

  // 爆量
  if (v.length >= 6) {
    const vr = v[v.length-1] / (v.slice(-6,-1).reduce((a,b)=>a+b,0)/5);
    if (vr > 2.5) { heat += 20; reasons.push(`爆量 ${vr.toFixed(1)} 倍（情緒亢奮）`); }
  }

  // PSY 心理偏離（若有）
  if (formulas && formulas.psy && formulas.psy.value >= 75) {
    heat += 20; reasons.push(`心理偏離指數 ${formulas.psy.value}（過度貪婪）`);
  }

  // PCR 極端（大盤）
  if (market && market.taifex && market.taifex.pcrOI) {
    const pcr = market.taifex.pcrOI;
    if (pcr < 70) { heat += 15; reasons.push(`大盤 PCR ${pcr.toFixed(0)}%（市場過度樂觀）`); }
  }

  heat = Math.min(100, heat);
  let level, advice;
  if (heat >= 60) { level = 'high'; advice = '🔥 市場過熱（等同新聞狂熱），反指標偏空：追高風險大，宜減碼或等回檔，勿在亢奮時進場'; }
  else if (heat >= 35) { level = 'mid'; advice = '⚠️ 情緒偏熱：留意追高風險，可分批不要重壓'; }
  else { level = 'low'; advice = '情緒正常，無過熱跡象'; }

  return { heat, level, advice, reasons };
}

/* ── 渲染 ──────────────────────────────────────────────────────────── */
function renderSMC(D, formulas, market) {
  const card = document.getElementById('smc-card');
  if (!card) return;
  card.style.display = 'block';

  const vwap = computeVWAP(D, 20);
  const struct = computeStructure(D);
  const overheat = computeOverheat(D, formulas, market);

  const cur = D.currency === 'TWD' ? '' : '$';
  const sigCol = s => s === 'buy' ? 'var(--buy)' : s === 'sell' ? 'var(--sell)' : 'var(--warn)';

  // VWAP
  let html = `<div class="risk-box ${vwap.signal==='buy'?'good':''}" style="margin-bottom:10px">
    <div class="rb-label">📊 VWAP 機構成本線（${vwap.period}日）</div>
    <div class="rb-value" style="color:${sigCol(vwap.signal)}">${cur}${fmt(vwap.vwap)}</div>
    <div class="rb-sub">${vwap.desc}</div>
  </div>`;

  // 市場結構
  html += `<div style="padding:12px;background:var(--bg);border:1px solid var(--bd);border-radius:10px;margin-bottom:10px">
    <div style="font-size:12px;font-weight:700;margin-bottom:6px">🏗️ 市場結構：${struct.trendDesc}</div>`;
  if (struct.event) {
    html += `<div style="font-size:12px;font-weight:700;color:${struct.event.includes('up')?'var(--buy)':struct.event.includes('down')?'var(--sell)':'var(--warn)'};margin-bottom:4px">${struct.eventType}</div>
      <div style="font-size:11px;color:var(--muted);line-height:1.5">${struct.eventDesc}</div>`;
  } else {
    html += `<div style="font-size:11px;color:var(--muted)">前高 ${struct.lastHigh?cur+fmt(struct.lastHigh):'—'}　前低 ${struct.lastLow?cur+fmt(struct.lastLow):'—'}　目前在區間內</div>`;
  }
  html += `</div>`;

  // 過熱反指標
  const ohCol = overheat.level==='high'?'var(--sell)':overheat.level==='mid'?'var(--warn)':'var(--muted)';
  html += `<div style="padding:12px;background:${overheat.level==='high'?'var(--sell-d)':'var(--bg)'};border:1px solid ${overheat.level==='high'?'var(--sell)':'var(--bd)'};border-radius:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:12px;font-weight:700;color:${ohCol}">🌡️ 過熱反指標</span>
      <span style="font-family:var(--mono);font-size:18px;font-weight:800;color:${ohCol}">${overheat.heat}</span>
    </div>
    <div style="font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:${overheat.reasons.length?'6px':'0'}">${overheat.advice}</div>
    ${overheat.reasons.length?`<div style="font-size:10px;color:var(--muted2);line-height:1.6">觸發：${overheat.reasons.join('、')}</div>`:''}
  </div>`;

  document.getElementById('smc-content').innerHTML = html;
}
