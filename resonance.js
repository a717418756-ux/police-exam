/* ══════════════════════════════════════════════════════════════════════
   resonance.js — 多維度共振確認系統
   ──────────────────────────────────────────────────────────────────
   核心概念：單一強訊號不可靠，多個「獨立維度」同時指向同方向才高勝率
   收集六大獨立維度的方向，算共識度（避免同類指標假確認）
   維度：①趨勢 ②動能 ③籌碼 ④結構(VWAP/BOS) ⑤情緒(反指標) ⑥相對強弱
   依賴：各模組的計算結果（在主流程組裝後傳入）
   ══════════════════════════════════════════════════════════════════════ */

/* ══ 個股動能/反轉持續性檢定（Lag-1 自相關係數）═══════════════════════
   統計基礎：日報酬率序列的一階自相關 r₁ = Corr(R_t, R_{t-1})
   r₁ > 0 顯著 = 該股有動能延續性（趨勢訊號更可信）
   r₁ < 0 顯著 = 該股有短線反轉傾向（超買超賣/PSY反指標訊號更可信）
   顯著性判斷用 Bartlett 公式：白噪音下標準誤 ≈ 1/√n，取 2 倍標準誤（約95%信心）
   為門檻，避免在資料不足或訊號等同雜訊時誤套權重（防止小樣本雜訊被誤判為統計規律）
   用途：這是「個股自身統計性格」，跟 Regime（大盤環境）是正交維度，
   同一支股票在同樣的大盤環境下，動能延續與否本身也有個股差異，兩者疊加才是完整資訊。
   ⚠️ 特別排除 Ornstein-Uhlenbeck 半衰期模型：查證文獻後，該模型在日線级實單測試中
   多次證實失效（t值顯著為負），且學界對半衰期指標本身的可解釋性有爭議，故不採用。
   Lag-1自相關屬更穩健、更少假設、業界公認的基礎統計檢定，故選用此法。
   ════════════════════════════════════════════════════════════════════ */
function computeAutocorrelation(closes, lookback = 60) {
  const c = closes;
  const n = c.length;
  if (n < lookback + 2) return null;
  const rets = [];
  for (let i = n - lookback; i < n; i++) rets.push((c[i] - c[i-1]) / c[i-1]);
  const m = rets.length;
  const mean = rets.reduce((a,b)=>a+b,0) / m;
  let num = 0, den = 0;
  for (let i = 1; i < m; i++) num += (rets[i]-mean) * (rets[i-1]-mean);
  for (let i = 0; i < m; i++) den += (rets[i]-mean) ** 2;
  const r1 = den ? num / den : 0;
  const seThreshold = 2 / Math.sqrt(m);  // Bartlett：白噪音下的顯著性門檻（約95%信心水準）
  const significant = Math.abs(r1) > seThreshold;
  return { r1, significant, threshold: seThreshold, n: m,
    character: !significant ? '接近隨機游走' : r1 > 0 ? '動能延續型' : '短線反轉型' };
}

function computeResonance(ctx) {
  // ctx 包含各維度已算好的結果
  // { trend, formulas, chip, vwap, structure, overheat, rsRating, marketScore, shi }
  const dims = [];

  // ① 趨勢維度（均線排列 + ADX）
  if (ctx.shi) {
    const ts = ctx.shi.breakdown.trend;
    dims.push({ name: '趨勢', dir: ts >= 65 ? 1 : ts <= 35 ? -1 : 0, score: ts,
      note: ts >= 65 ? '均線多頭排列' : ts <= 35 ? '均線空頭排列' : '趨勢不明' });
  }

  // ② 動能維度（FUSION 自創公式）
  if (ctx.formulas && ctx.formulas.fusion) {
    const fz = ctx.formulas.fusion.value;
    dims.push({ name: '動能', dir: fz >= 20 ? 1 : fz <= -20 ? -1 : 0, score: 50 + fz/2,
      note: fz >= 20 ? 'FUSION 多方動能' : fz <= -20 ? 'FUSION 空方動能' : '動能中性' });
  }

  // ③ 籌碼維度（法人 + 量能）
  if (ctx.chip && typeof computeChipHealth === 'function') {
    const ch = computeChipHealth(ctx.chip, ctx.D);
    dims.push({ name: '籌碼', dir: ch.score >= 60 ? 1 : ch.score <= 40 ? -1 : 0, score: ch.score,
      note: ch.verdict.slice(0, 12) });
  }

  // ④ 結構維度（VWAP + BOS/CHoCH）
  if (ctx.vwap && ctx.structure) {
    let sd = 0, sNote = '';
    const vwapUp = ctx.vwap.signal === 'buy';
    const structUp = ctx.structure.trend === 'up';
    const structDown = ctx.structure.trend === 'down';
    if (vwapUp && structUp) { sd = 1; sNote = 'VWAP上+上升結構'; }
    else if (!vwapUp && structDown) { sd = -1; sNote = 'VWAP下+下降結構'; }
    else { sd = 0; sNote = '結構與VWAP分歧'; }
    dims.push({ name: '結構', dir: sd, score: sd === 1 ? 75 : sd === -1 ? 25 : 50, note: sNote });
  }

  // ⑤ 情緒維度（過熱反指標 — 反向）
  if (ctx.overheat) {
    // 過熱=反向偏空（dir=-1），恐慌=反向偏多
    let ed = 0, eNote = ctx.overheat.advice.slice(0, 14);
    if (ctx.overheat.level === 'high') { ed = -1; } // 過熱反指標偏空
    dims.push({ name: '情緒', dir: ed, score: 100 - ctx.overheat.heat,
      note: ed === -1 ? '過熱(反指標偏空)' : '情緒正常' });
  }

  // ⑦ 多時間框架維度（週線月線定方向）
  if (ctx.mtf) {
    dims.push({ name: '週期MTF', dir: ctx.mtf.dir, score: ctx.mtf.total,
      note: ctx.mtf.dir === 1 ? '大週期偏多' : ctx.mtf.dir === -1 ? '大週期偏空' : '框架衝突' });
  }

  // ⑥ 相對強弱維度（RS）
  if (ctx.rsRating != null) {
    dims.push({ name: '相對強弱', dir: ctx.rsRating >= 70 ? 1 : ctx.rsRating <= 40 ? -1 : 0,
      score: ctx.rsRating, note: `RS ${ctx.rsRating}（強過${ctx.rsRating}%）` });
  }

  // 統計共振
  const bullDims = dims.filter(d => d.dir === 1);
  const bearDims = dims.filter(d => d.dir === -1);
  const neutralDims = dims.filter(d => d.dir === 0);
  const total = dims.length;

  // 共振分數：多方維度比例 - 空方維度比例
  const netDir = bullDims.length - bearDims.length;

  // ── Regime 動態權重（不同市場狀態，該信的維度不同）──
  // 趨勢態：趨勢/動能/週期加權、情緒反指標降權（強勢股一直超買）
  // 盤整態：情緒/結構加權、趨勢/週期降權（盤整追突破易被巴）
  // 高波動危險：全面降權（此狀態所有訊號可靠度大降）
  const regimeName = ctx.regime ? ctx.regime.regime : null;
  const W = { 趨勢: 1, 動能: 1, 籌碼: 1, 結構: 1, 情緒: 1, 相對強弱: 1, 週期MTF: 1 };
  if (regimeName === '多頭趨勢' || regimeName === '空頭趨勢') {
    W.趨勢 = 1.3; W.動能 = 1.2; W.週期MTF = 1.3; W.情緒 = 0.7;
  } else if (regimeName === '盤整') {
    W.趨勢 = 0.6; W.週期MTF = 0.7; W.動能 = 0.8; W.情緒 = 1.3; W.結構 = 1.2;
  } else if (regimeName === '高波動危險') {
    for (const k in W) W[k] = 0.5;
  }

  // ── 個股自相關修正（正交於Regime：個股自身統計性格，與大盤環境疊加）──
  // 只在統計顯著時套用，避免對雜訊做出反應（過擬合防護）
  let autocorr = null;
  try {
    if (ctx.D && ctx.D.closes) {
      autocorr = computeAutocorrelation(ctx.D.closes, 60);
      if (autocorr && autocorr.significant) {
        if (autocorr.r1 > 0) { W.趨勢 *= 1.15; W.動能 *= 1.15; W.情緒 *= 0.85; }       // 動能延續型：加碼趨勢、降情緒反指標
        else { W.情緒 *= 1.2; W.結構 *= 1.1; W.趨勢 *= 0.9; }                          // 短線反轉型：加碼情緒反指標與結構
      }
    }
  } catch (e) { /* 略過，不影響主流程 */ }
  let wSum = 0, wNet = 0;
  dims.forEach(d => { const w = W[d.name] != null ? W[d.name] : 1; wSum += w; wNet += d.dir * w; });
  const consensus = wSum > 0 ? Math.round(wNet / wSum * 100) : 0;

  // 結論
  let verdict, vClass, strength;
  const agreeCount = Math.max(bullDims.length, bearDims.length);
  if (bullDims.length >= 4 && bearDims.length === 0) {
    verdict = `🟢 強烈多方共振（${bullDims.length}/${total}維度看多，零反對）`; vClass = 'buy'; strength = 'strong';
  } else if (bearDims.length >= 4 && bullDims.length === 0) {
    verdict = `🔴 強烈空方共振（${bearDims.length}/${total}維度看空，零反對）`; vClass = 'sell'; strength = 'strong';
  } else if (netDir >= 2) {
    verdict = `🟢 偏多共振（${bullDims.length}多 vs ${bearDims.length}空）`; vClass = 'buy'; strength = 'medium';
  } else if (netDir <= -2) {
    verdict = `🔴 偏空共振（${bearDims.length}空 vs ${bullDims.length}多）`; vClass = 'sell'; strength = 'medium';
  } else {
    verdict = `⚪ 維度分歧，無共振（${bullDims.length}多/${bearDims.length}空/${neutralDims.length}中）`; vClass = 'warn'; strength = 'weak';
  }

  return { dims, bullCount: bullDims.length, bearCount: bearDims.length, neutralCount: neutralDims.length,
    total, consensus, verdict, vClass, strength, regimeName, weights: W, autocorr };
}

function renderResonance(res) {
  const card = document.getElementById('resonance-card');
  if (!card) return;
  card.style.display = 'block';

  const colMap = { buy: 'var(--buy)', sell: 'var(--sell)', warn: 'var(--warn)' };
  const col = colMap[res.vClass];

  // 共識度大字 + 結論
  let html = `<div style="text-align:center;margin-bottom:14px">
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">維度共識度</div>
    <div style="font-family:var(--mono);font-size:36px;font-weight:800;color:${col};line-height:1">${res.consensus>0?'+':''}${res.consensus}</div>
    <div style="font-size:14px;font-weight:700;color:${col};margin-top:6px">${res.verdict}</div>
  </div>`;

  // 各維度方向條
  html += '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">各維度方向</div>';
  res.dims.forEach(d => {
    const dCol = d.dir === 1 ? 'var(--buy)' : d.dir === -1 ? 'var(--sell)' : 'var(--muted)';
    const dIcon = d.dir === 1 ? '▲' : d.dir === -1 ? '▼' : '◆';
    const dTxt = d.dir === 1 ? '看多' : d.dir === -1 ? '看空' : '中性';
    html += `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--bd)">
      <span style="font-size:12px;width:60px;color:var(--muted)">${d.name}</span>
      <span style="color:${dCol};font-size:13px;width:50px">${dIcon} ${dTxt}</span>
      <span style="flex:1;font-size:11px;color:var(--muted2)">${d.note}</span>
    </div>`;
  });

  // 共振提示
  html += `<div style="margin-top:12px;padding:10px 12px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;font-size:11px;color:var(--muted);line-height:1.6">
    💡 多個獨立維度同方向 = 高勝率訊號。${res.strength==='strong'?'目前多維度強共振，是難得的明確訊號。':res.strength==='medium'?'目前有共振傾向，可參考。':'目前維度分歧，建議觀望等待共振。'}單一維度強不代表可靠，共振才是關鍵。${res.regimeName?`目前為「${res.regimeName}」態，共識度已依狀態動態加權（非固定權重）。`:''}${res.autocorr && res.autocorr.significant?`此股統計性格：<b>${res.autocorr.character}</b>（日報酬自相關 ${res.autocorr.r1>=0?'+':''}${res.autocorr.r1.toFixed(2)}，達統計顯著），已據此微調趨勢/情緒維度權重。`:res.autocorr?'此股日報酬自相關未達統計顯著（接近隨機游走），此層權重不調整，避免對雜訊反應。':''}
  </div>`;

  document.getElementById('resonance-content').innerHTML = html;
}
