/* ══════════════════════════════════════════════════════════════════════
   layout.js — 介面整合：把 18 個卡片動態分組為「決策摘要 + 6 摺疊組」
   做法：分析完成後，用 JS 把現有卡片搬進分組容器（不改原 HTML，零誤傷）
   ══════════════════════════════════════════════════════════════════════ */

// 分組定義：每組包含哪些卡片 id（順序即顯示順序）
const LAYOUT_GROUPS = [
  { id:'g-decision', icon:'🎯', title:'決策摘要', sub:'一眼看完做決定', open:true,
    cards:['bingfa-card','health-card','formula-card','prob-card','playbook-card'] },
  { id:'g-score', icon:'📊', title:'核心分數', sub:'量化評分與自創公式', open:false,
    cards:['quant-card'] },
  { id:'g-market', icon:'🌐', title:'市場環境', sub:'大盤/狀態/情緒', open:false,
    cards:['mktscore-card','market-card','regime-card'] },
  { id:'g-chip', icon:'💰', title:'籌碼強弱', sub:'法人/相對強弱/Beta', open:false,
    cards:['chip-card','rs-card','beta-card'] },
  { id:'g-trend', icon:'📈', title:'趨勢與風險', sub:'趨勢/停損/回撤', open:false,
    cards:['trend-banner','risk-card','riskmetric-card'] },
  { id:'g-signal', icon:'🔍', title:'進階訊號', sub:'支撐壓力/量價/多週期/指標', open:false,
    cards:['sr-card','vpradar-card','multiperiod-card','ind-grid'] },
  { id:'g-mind', icon:'🧠', title:'心理與 AI', sub:'反人性提醒/AI研判', open:false,
    cards:['psych-card','ai-card'] },
];

let _layoutBuilt = false;

function buildLayout() {
  const main = document.querySelector('main');
  if (!main) return;

  // 找到插入點：stock-bar 之後
  const stockBar = document.getElementById('stock-bar');

  // 建立分組容器（只建一次）
  if (!_layoutBuilt) {
    for (const g of LAYOUT_GROUPS) {
      const wrap = document.createElement('div');
      if (g.id === 'g-decision') {
        wrap.className = 'decision-zone';
        wrap.id = g.id;
        wrap.innerHTML = `<div style="padding:6px 10px;font-size:11px;color:var(--acc);font-weight:700;letter-spacing:.5px">🎯 決策摘要</div><div class="group-body" style="display:block;padding:0 6px 6px" id="${g.id}-body"></div>`;
      } else {
        wrap.className = 'group' + (g.open ? ' open' : '');
        wrap.id = g.id;
        wrap.innerHTML = `
          <div class="group-head" onclick="toggleGroup('${g.id}')">
            <span class="group-icon">${g.icon}</span>
            <div style="flex:1"><div class="group-title">${g.title}</div><div class="group-sub">${g.sub}</div></div>
            <span class="group-arrow">▶</span>
          </div>
          <div class="group-body" id="${g.id}-body"></div>`;
      }
      main.insertBefore(wrap, stockBar.nextSibling);
    }
    // 反序插入修正：因為 insertBefore 同一位置會反序，重新依序排列
    const frag = document.createDocumentFragment();
    for (const g of LAYOUT_GROUPS) {
      const el = document.getElementById(g.id);
      if (el) frag.appendChild(el);
    }
    main.insertBefore(frag, stockBar.nextSibling);
    _layoutBuilt = true;
  }

  // 把卡片搬進對應分組（每次分析後執行，因卡片是 display 控制）
  for (const g of LAYOUT_GROUPS) {
    const body = document.getElementById(g.id + '-body');
    if (!body) continue;
    for (const cardId of g.cards) {
      const card = document.getElementById(cardId);
      if (!card || card.parentElement === body) continue;
      // 若卡片前面緊鄰一個獨立的 layer-title，一起搬移
      const prev = card.previousElementSibling;
      if (prev && prev.classList && prev.classList.contains('layer-title')) {
        body.appendChild(prev);
      }
      body.appendChild(card);
    }
  }
}

function toggleGroup(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

// 對外：分析完成後呼叫
function applyLayout() {
  try { buildLayout(); } catch (e) { console.warn('layout 失敗', e); }
}
