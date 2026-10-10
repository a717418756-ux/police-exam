/* ══════════════════════════════════════════════════════════════════════
   smc.js — VWAP + 市場結構(BOS/CHoCH)
   ──────────────────────────────────────────────────────────────────
   A. VWAP 移動成交量加權均價（機構成本線）
   B. BOS 結構突破 / CHoCH 性格轉變（聰明錢結構，純數學）
   依賴：app.js($/fmt)
   ──────────────────────────────────────────────────────────────────
   函式清單：
     computeVWAP          — 移動成交量加權均價
     computeStructure      — BOS結構突破/CHoCH性格轉變（供意圖引擎Wyckoff測試引用）
     renderSMC              — 卡片渲染
   ⚠️ 已知地雷／注意事項：
     - computeStructure的BOS/CHoCH判定被mainforce.js意圖引擎引用作為
       Wyckoff測試證據之一，修改突破/跌破的判定邏輯會連動影響主力
       行為分類，建議改動後重跑意圖引擎的合成情境測試
   ══════════════════════════════════════════════════════════════════════ */
/* v163 檔案版本宣告：讓前端能查出「站上哪個檔案沒更新到」。
   改這個檔時一併把數字改成當版；config.js 的 FILE_VERS 必須同步（自我檢查會擋）。 */
try { (window.SR_FV = window.SR_FV || {})['smc.js'] = 198; } catch (e) {}

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
  const price = barPx(D);   // v197 與 VWAP 同一套（還原價、完整K棒），原本拿原始即時價比還原 VWAP
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
  // BOS/CHoCH是「散戶與主力都在看的心理關卡」，用未還原市價（fallback還原價，向下相容）
  const h = D.rawHighs || D.highs, l = D.rawLows || D.lows, c = D.rawCloses || D.closes;
  const n = c.length;
  const N = Math.min(60, n);
  const hs = h.slice(-N), ls = l.slice(-N);

  // 找 swing 點（前後2根都低/高）
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < N - 2; i++) {
    if (hs[i] > hs[i-1] && hs[i] > hs[i-2] && hs[i] > hs[i+1] && hs[i] > hs[i+2]) swingHighs.push({ i, price: hs[i] });
    if (ls[i] < ls[i-1] && ls[i] < ls[i-2] && ls[i] < ls[i+1] && ls[i] < ls[i+2]) swingLows.push({ i, price: ls[i] });
  }
  const price = D.rawCloses ? D.rawCloses[D.rawCloses.length - 1] : D.price;
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

/* v188 拿掉「流動性池 EQH/EQL」（60～75% 的時候就落在支撐壓力卡已列的價位 1% 內，重複）
   與「過熱反指標」（連漲／乖離與心理卡重複，PSY 已併入 RSI，PCR 未經驗證不計分）。 */

/* ── 渲染 ──────────────────────────────────────────────────────────── */
function renderSMC(D) {
  const card = document.getElementById('smc-card');
  if (!card) return;
  card.style.display = 'block';

  const vwap = computeVWAP(D, 20);
  const struct = computeStructure(D);

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

  document.getElementById('smc-content').innerHTML = html;
}
