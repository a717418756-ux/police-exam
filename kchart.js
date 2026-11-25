/* ═══════════════════════════════════════════════════════════════════
   kchart.js — 互動 K 線（v227，T-030）
   ───────────────────────────────────────────────────────────────────
   用 TradingView Lightweight Charts（Apache 2.0，免費；圖上保留 TradingView 標示＝授權要求的署名）。
   函式庫從 jsDelivr 非同步載入（index.html，鎖版本 4.2.3）；載不到（離線、被擋）時這張圖整個不顯示，
   決策頁原本的 SVG 計畫圖（bingfa.js planChart）照常，不影響任何計算。

   價格基準（本專案鐵律）：圖上一律畫「原始市價」——開盤價由還原開盤 × 原始收盤 ÷ 還原收盤換回，
   與 planChart、停損／進場價同一套；均線也用原始收盤，才能跟計畫價位畫在同一把尺上。
   計畫價位（進場／停損／目標）由 bingfa.js renderTradeGate 呼叫 kchartPlan 帶進來，不在這裡另算。
   ═══════════════════════════════════════════════════════════════════ */
try { (window.SR_FV = window.SR_FV || {})['kchart.js'] = 227; } catch (e) {}

const KC = { chart: null, candle: null, vol: null, ma: [], code: null, n: 0, range: 126, lines: [], D: null, ro: null, bars: null };
const KC_RANGES = [['3月', 63], ['6月', 126], ['1年', 250], ['全部', 0]];

/* 純資料轉換（selftest 直接測這個）：回傳 [{time, open, high, low, close, volume}]，原始市價 */
function kcBars(D) {
  const C = D.rawCloses || D.closes, H = D.rawHighs || D.highs, L = D.rawLows || D.lows, A = D.closes, n = C.length, out = [];
  const ds = D.dates || [];
  for (let k = 0; k < n; k++) {
    const d = String(ds[k] || '');
    if (!/^\d{8}$/.test(d) || !(C[k] > 0)) continue;
    const o = D.opens && D.opens[k] > 0 && A[k] > 0 ? D.opens[k] * C[k] / A[k] : (C[k - 1] || C[k]);
    const h = Math.max(H[k] || C[k], o, C[k]), l = Math.min(L[k] || C[k], o, C[k]);
    const t = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
    if (out.length && out[out.length - 1].time >= t) continue;   // 日期要嚴格遞增，否則函式庫會丟錯
    out.push({ time: t, open: o, high: h, low: l, close: C[k], volume: D.volumes ? D.volumes[k] || 0 : 0 });
  }
  return out;
}
function kcSMA(bars, p) {
  const out = []; let s = 0;
  for (let i = 0; i < bars.length; i++) { s += bars[i].close; if (i >= p) s -= bars[i - p].close; if (i >= p - 1) out.push({ time: bars[i].time, value: s / p }); }
  return out;
}

function kcColors() {
  const cs = getComputedStyle(document.documentElement), v = (n, f) => (cs.getPropertyValue(n) || '').trim() || f;
  return { bg: v('--surf', '#111827'), txt: v('--muted', '#5A7090'), grid: v('--bd', '#1E2D45'), up: v('--buy', '#00D4A0'), dn: v('--sell', '#FF4D6D'),
    ma20: v('--warn', '#F0B429'), ma60: v('--purple', '#A855F7'), fg: v('--txt', '#E8EDF5') };
}

function kchartRender(D) {
  const wrap = document.getElementById('kc-wrap'), box = document.getElementById('kc-box');
  if (!wrap || !box || !D) return;
  KC.D = D;
  if (typeof LightweightCharts === 'undefined') { wrap.style.display = 'none'; return; }   // 函式庫還沒到／載不到：載到時 index.html 會再呼叫一次
  const bars = kcBars(D);
  if (bars.length < 20) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  if (KC.chart) { try { KC.chart.remove(); } catch (e) {} KC.chart = null; }
  if (KC.ro) { try { KC.ro.disconnect(); } catch (e) {} KC.ro = null; }
  KC.lines = [];
  const c = kcColors(), LW = LightweightCharts;
  const chart = LW.createChart(box, {
    width: box.clientWidth || 340, height: box.clientHeight || 300,
    layout: { background: { type: 'solid', color: c.bg }, textColor: c.txt, fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.grid, scaleMargins: { top: 0.06, bottom: 0.24 } },
    timeScale: { borderColor: c.grid, rightOffset: 3, minBarSpacing: 1.5 },
    crosshair: { mode: LW.CrosshairMode ? LW.CrosshairMode.Normal : 0 },
    localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' },
  });
  const candle = chart.addCandlestickSeries({ upColor: c.up, downColor: c.dn, borderUpColor: c.up, borderDownColor: c.dn, wickUpColor: c.up, wickDownColor: c.dn,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
  candle.setData(bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  vol.setData(bars.map(b => ({ time: b.time, value: b.volume, color: (b.close >= b.open ? c.up : c.dn) + '66' })));
  KC.ma = [[20, c.ma20], [60, c.ma60]].map(([p, col]) => {
    const s = chart.addLineSeries({ color: col, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    s.setData(kcSMA(bars, p)); return s;
  });
  Object.assign(KC, { chart, candle, vol, code: D.code, n: bars.length, bars });
  kcSetRange(KC.range);
  // 十字線圖例：開高低收、量、漲跌（沒有游標時顯示最後一根）
  const leg = document.getElementById('kc-legend'), cur = D.currency === 'TWD' ? '' : '$';
  const legend = b => {
    if (!leg || !b) return;
    const i = bars.findIndex(x => x.time === b.time), prev = i > 0 ? bars[i - 1].close : null, ch = prev ? (b.close - prev) / prev * 100 : null;
    const col = ch == null ? c.fg : ch >= 0 ? c.up : c.dn;
    leg.innerHTML = `<span>${b.time.replace(/-/g, '/')}</span> 開<b>${cur}${fmt(b.open)}</b> 高<b>${cur}${fmt(b.high)}</b> 低<b>${cur}${fmt(b.low)}</b> 收<b style="color:${col}">${cur}${fmt(b.close)}${ch == null ? '' : `（${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%）`}</b> 量<b>${fmtV(D.currency === 'TWD' ? Math.round(b.volume / 1000) : b.volume)}${D.currency === 'TWD' ? '張' : ''}</b>`
      + ` <span style="color:${c.ma20}">MA20</span> <span style="color:${c.ma60}">MA60</span>`;
  };
  legend(bars[bars.length - 1]);
  chart.subscribeCrosshairMove(p => { const t = p && p.time, ts = !t ? '' : typeof t === 'string' ? t : t.year ? `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}` : '';
    const b = ts ? bars.find(x => x.time === ts) : null; legend(b || bars[bars.length - 1]); });
  if (typeof ResizeObserver !== 'undefined') {
    KC.ro = new ResizeObserver(() => { try { chart.applyOptions({ width: box.clientWidth }); } catch (e) {} });
    KC.ro.observe(box);
  }
  kcButtons();
  if (KC.plan && KC.plan.code === D.code) kchartPlan(D, KC.plan.pb, KC.plan.side);
}

function kcSetRange(r) {
  KC.range = r;
  if (!KC.chart) return;
  const ts = KC.chart.timeScale();
  if (!r || r >= KC.n) ts.fitContent(); else ts.setVisibleLogicalRange({ from: KC.n - r, to: KC.n + 2 });
  kcButtons();
}
function kcButtons() {
  const el = document.getElementById('kc-tools');
  if (!el) return;
  el.innerHTML = KC_RANGES.map(([t, r]) => `<button type="button" class="kc-btn${KC.range === r ? ' on' : ''}" onclick="kcSetRange(${r})">${t}</button>`).join('');
}

/* 執行計畫的價位畫成水平線；side 為 null（今天沒計畫）就清掉 */
function kchartPlan(D, pb, side) {
  if (!D) return;
  KC.plan = { code: D.code, pb, side };   // 函式庫晚到時，kchartRender 畫完再補上
  if (!KC.candle || KC.code !== D.code) return;
  for (const l of KC.lines) { try { KC.candle.removePriceLine(l); } catch (e) {} }
  KC.lines = [];
  if (!pb || !side) return;
  const c = kcColors(), tgt = pb.pickT ? pb.pickT.medPrice : null;
  for (const [v, col, t] of [[pb.entry, c.fg, side === 'long' ? '進場（多）' : '進場（空）'], [pb.stop, c.dn, '停損'], [tgt, c.up, '目標']]) {
    if (v > 0) KC.lines.push(KC.candle.createPriceLine({ price: v, color: col, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: t }));
  }
}
