/* ══════════════════════════════════════════════════════════════════════
   layout.js — 介面整合（分頁式）
   頂部一排可橫向滑動的分頁按鈕，點選切換顯示，免一直下滑
   做法：分析完成後用 JS 把卡片搬進對應分頁（不改原 HTML，零誤傷）
   ══════════════════════════════════════════════════════════════════════ */

// 分頁定義（順序即按鈕順序）。cards 含該頁所有卡片 id
const TABS = [
  { id:'t-decision', icon:'🎯', name:'決策',
    cards:['bingfa-card','resonance-card','health-card','formula-card','prob-card','playbook-card'] },
  { id:'t-score', icon:'📊', name:'分數',
    cards:['quant-card'] },
  { id:'t-market', icon:'🌐', name:'大盤',
    cards:['mktscore-card','market-card','regime-card'] },
  { id:'t-chip', icon:'💰', name:'籌碼',
    cards:['mainforce-card','margin-card','chip-card','rs-card','beta-card'] },
  { id:'t-trend', icon:'📈', name:'趨勢',
    cards:['trend-banner','risk-card','riskmetric-card'] },
  { id:'t-signal', icon:'🔍', name:'訊號',
    cards:['smc-card','sr-card','vpradar-card','multiperiod-card','cat-row','ind-grid'] },
  { id:'t-mind', icon:'🧠', name:'心理AI',
    cards:['psych-card','ai-card'] },
];

let _layoutBuilt = false;
let _activeTab = 't-decision';

function buildLayout() {
  const main = document.querySelector('main');
  if (!main) return;
  const stockBar = document.getElementById('stock-bar');

  if (!_layoutBuilt) {
    // 1. 建立分頁按鈕列（吸頂、可橫向滑動）
    const tabBar = document.createElement('div');
    tabBar.id = 'tab-bar';
    tabBar.className = 'tab-bar';
    tabBar.innerHTML = TABS.map(t =>
      `<button class="tab-btn${t.id===_activeTab?' active':''}" id="btn-${t.id}" onclick="switchTab('${t.id}')"><span class="tab-emoji">${t.icon}</span><span>${t.name}</span></button>`
    ).join('');

    // 2. 建立各分頁容器
    const panes = document.createElement('div');
    panes.id = 'tab-panes';
    panes.innerHTML = TABS.map(t =>
      `<div class="tab-pane${t.id===_activeTab?' active':''}" id="pane-${t.id}"></div>`
    ).join('');

    // 插入到 stock-bar 之後
    // 插入點：verdict-banner 之後（若有），否則 stock-bar 之後
    const vb = document.getElementById('verdict-banner');
    const anchor = (vb && vb.parentElement === main) ? vb : stockBar;
    main.insertBefore(panes, anchor.nextSibling);
    main.insertBefore(tabBar, anchor.nextSibling);
    _layoutBuilt = true;
  }

  // 3. 把卡片搬進對應分頁（含緊鄰的 layer-title）
  for (const t of TABS) {
    const pane = document.getElementById('pane-' + t.id);
    if (!pane) continue;
    for (const cardId of t.cards) {
      const card = document.getElementById(cardId);
      if (!card || card.parentElement === pane) continue;
      const prev = card.previousElementSibling;
      if (prev && prev.classList && prev.classList.contains('layer-title')) {
        pane.appendChild(prev);
      }
      pane.appendChild(card);
    }
  }

  // 4. 更新各分頁是否有內容的提示（沒資料的卡片會 display:none）
  updateTabBadges();
}

function switchTab(id) {
  _activeTab = id;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.id === 'btn-' + id));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + id));
  // 切換後捲到分頁列頂端，體驗更順
  const bar = document.getElementById('tab-bar');
  if (bar) bar.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 分頁按鈕顯示該頁有幾張「有資料」的卡片（小圓點提示）
function updateTabBadges() {
  for (const t of TABS) {
    const btn = document.getElementById('btn-' + t.id);
    if (!btn) continue;
    let hasContent = false;
    for (const cardId of t.cards) {
      const card = document.getElementById(cardId);
      if (card && card.style.display !== 'none' && card.id !== 'cat-row') { hasContent = true; break; }
    }
    btn.classList.toggle('has-data', hasContent);
  }
}

function applyLayout() {
  try { buildLayout(); } catch (e) { console.warn('layout 失敗', e); }
}
