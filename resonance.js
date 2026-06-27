/* ══════════════════════════════════════════════════════════════════════
   resonance.js — 多維度共振確認系統
   ──────────────────────────────────────────────────────────────────
   核心概念：單一強訊號不可靠，多個「獨立維度」同時指向同方向才高勝率
   收集六大獨立維度的方向，算共識度（避免同類指標假確認）
   維度：①趨勢 ②動能 ③籌碼 ④結構(VWAP/BOS) ⑤情緒(反指標) ⑥相對強弱
   依賴：各模組的計算結果（在主流程組裝後傳入）
   ══════════════════════════════════════════════════════════════════════ */

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
  const consensus = total > 0 ? Math.round((bullDims.length - bearDims.length) / total * 100) : 0;

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
    total, consensus, verdict, vClass, strength };
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
    💡 多個獨立維度同方向 = 高勝率訊號。${res.strength==='strong'?'目前多維度強共振，是難得的明確訊號。':res.strength==='medium'?'目前有共振傾向，可參考。':'目前維度分歧，建議觀望等待共振。'}單一維度強不代表可靠，共振才是關鍵。
  </div>`;

  document.getElementById('resonance-content').innerHTML = html;
}
