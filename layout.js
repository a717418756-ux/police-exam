/* ══════════════════════════════════════════════════════════════════════
   layout.js — 介面整合（分頁式）
   頂部一排可橫向滑動的分頁按鈕，點選切換顯示，免一直下滑
   做法：分析完成後用 JS 把卡片搬進對應分頁（不改原 HTML，零誤傷）
   ──────────────────────────────────────────────────────────────────
   ⚠️ 已知地雷／注意事項：
     - 新增卡片時，此檔的分頁清單(cards陣列)須與index.html的卡片id、
       app.js的重置清單三處同步，缺一即為「幽靈卡」（顯示邏輯正確但
       分頁切換時卡片不會跟著移動或消失）——三處同步是本專案交付前
       19項檢查清單的固定項目
     - v70曾短暫加入卡片折疊(card-collapsed)與墨水屏模式，後者已於
       同版本內使用者要求下完整撤除（該功能誤用了其他專案的裝置背景，
       教訓：功能只該回應當下專案實際需求，不套用記憶中其他專案的習慣）
   ══════════════════════════════════════════════════════════════════════ */

// 分頁定義（順序即按鈕順序）。cards 含該頁所有卡片 id
const TABS = [
  { id:'t-decision', icon:'🎯', name:'決策',
    cards:['gate-card','behavior-chain-card','movestage-card','bingfa-card','resonance-card','health-card','formula-card','prob-card','playbook-card'] },
  { id:'t-score', icon:'📊', name:'分數',
    cards:['quant-card','oos-card'] },
  { id:'t-market', icon:'🌐', name:'大盤',
    cards:['mktscore-card','market-card','regime-card'] },
  { id:'t-chip', icon:'💰', name:'籌碼',
    cards:['mainforce-card','margin-card','deepchip-card','chip-card','fundamental-card','rs-card','beta-card'] },
  { id:'t-trend', icon:'📈', name:'趨勢',
    cards:['mtf-card','trend-banner','risk-card','riskmetric-card'] },
  { id:'t-signal', icon:'🔍', name:'訊號',
    cards:['smc-card','sr-card','vpradar-card','multiperiod-card','cat-row','ind-grid'] },
  { id:'t-mind', icon:'🧠', name:'心理AI',
    cards:['crowd-card','psych-card','ai-card'] },
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
  if (id !== _activeTab) { try { navigator.vibrate && navigator.vibrate(8); } catch (e) {} }  // 輕觸回饋（iOS 會忽略）
  _activeTab = id;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.id === 'btn-' + id));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + id));
  // 切換後捲到內容頂端（v150：分頁列在手機已移到底部，不能再拿它當捲動目標，
  // 否則會捲到頁尾；改用分頁容器，偏移量由 CSS 的 scroll-margin-top 處理）
  const panes = document.getElementById('tab-panes');
  if (panes) panes.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  try { initSwipe(); } catch (e) {}
  try { onAnalysed(window._lastD); } catch (e) {}
}

/* ══════════════════════════════════════════════════════════════════════
   v151 操作手感（純顯示層，不碰任何分析邏輯）
   ① 標題列縮合：捲動後把代碼／股價帶到頂部，長頁面也知道在看哪一檔
   ② 左右滑動切分頁：配合底部導覽列，手指不必回到底部
   ③ 最近查過的代碼：取代只會固定顯示台積電的範例鈕
   ⚠️ 地雷：滑動事件掛在 #tab-panes，起點若落在輸入框或可橫捲的元素
      （分類膠囊列）必須放行，否則會搶掉那些元件自己的手勢
   ══════════════════════════════════════════════════════════════════════ */
const esc = s => String(s == null ? '' : s).replace(/[<>"'&]/g, '');

function onAnalysed(D) {
  if (!D || !D.code) return;
  // ① 標題列摘要
  const logo = document.querySelector('header .logo');
  if (logo) {
    let el = document.getElementById('hdr-sum');
    if (!el) { el = document.createElement('div'); el.id = 'hdr-sum'; logo.appendChild(el); }
    const chg = D.price - D.prevClose, p = D.prevClose ? chg / D.prevClose * 100 : 0;
    el.innerHTML = `<span class="hs-code">${esc(D.code)}</span>`
      + `<span class="hs-price">${Number(D.price).toFixed(2)}</span>`
      + `<span class="hs-chg ${chg >= 0 ? 'up' : 'dn'}">${chg >= 0 ? '+' : ''}${p.toFixed(2)}%</span>`;
  }
  // ③ 最近清單
  let a = [];
  try { a = JSON.parse(localStorage.getItem('sr_recent') || '[]'); } catch (e) {}
  if (!a.length || a[0].c !== D.code) {
    a = a.filter(x => x && x.c !== D.code);
    a.unshift({ c: D.code, n: String(D.name || '').slice(0, 6) });
    a = a.slice(0, 6);
    try { localStorage.setItem('sr_recent', JSON.stringify(a)); } catch (e) {}
  }
  renderRecent(a);
}

function renderRecent(a) {
  if (!a) { try { a = JSON.parse(localStorage.getItem('sr_recent') || '[]'); } catch (e) { a = []; } }
  const chips = document.querySelector('main .chips');
  if (!a.length || !chips) return;
  let box = document.getElementById('recent-chips');
  if (!box) { box = document.createElement('div'); box.id = 'recent-chips'; box.className = 'chips'; chips.parentElement.insertBefore(box, chips); }
  box.innerHTML = '<span class="chips-lbl">最近</span>'
    + a.map(x => `<span class="chip chip-recent" onclick="qs('${esc(x.c)}')">${x.n ? esc(x.n) + ' ' : ''}${esc(x.c)}</span>`).join('');
}

function initSwipe() {
  const panes = document.getElementById('tab-panes');
  if (!panes || panes._swipe) return;
  panes._swipe = 1;
  let x0 = 0, y0 = 0, t0 = 0, live = false;
  panes.addEventListener('touchstart', e => {
    const t = e.touches[0];
    live = !e.target.closest('input,textarea,select,.cat-tabs,.tab-bar,details');
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
  }, { passive: true });
  panes.addEventListener('touchend', e => {
    if (!live) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Date.now() - t0 > 600 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const i = TABS.findIndex(z => z.id === _activeTab), j = i + (dx < 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= TABS.length) return;
    switchTab(TABS[j].id);
  }, { passive: true });
}

/* 手機瀏覽器開了「電腦版網站」時，版面視窗被鎖成 980px、viewport meta 失效，
   字會被縮到看不清楚。純 CSS 無法還原，只能明確告訴使用者關哪個開關。
   判定：觸控裝置 ＋ 視窗寬 900~1100（桌機模式固定 980）＋ 像素比偏低。 */
function checkDesktopMode() {
  try {
    if (!matchMedia('(pointer:coarse)').matches) return;
    if (innerWidth < 900 || innerWidth > 1100 || devicePixelRatio >= 1.6) return;
    if (localStorage.getItem('sr_dm_hide') === '1') return;
    const d = document.createElement('div');
    d.id = 'dm-warn';
    d.innerHTML = '<div>⚠️ 偵測到瀏覽器的 <b>「電腦版網站」</b> 模式（版面被鎖成 980px），'
      + '所以字會縮得很小。關法：瀏覽器選單 ⋮ → 取消勾選「電腦版網站」；'
      + '若是桌面上的 App 圖示，需先移除圖示，關掉這個設定後再重新安裝一次。</div>'
      + '<button onclick="this.parentElement.remove();try{localStorage.setItem(\'sr_dm_hide\',\'1\')}catch(e){}">知道了</button>';
    document.getElementById('app').insertBefore(d, document.querySelector('main'));
  } catch (e) {}
}

/* ══ UX 強化：墨水屏模式 / 卡片折疊 / 回頂（純顯示層，不碰邏輯）══ */
(function initUX(){
  const run = () => {
    // 卡片折疊：點標題收合（help鈕除外），偏好記憶
    try {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('sr_collapsed') || '{}'); } catch (e) {}
      document.querySelectorAll('.layer-title').forEach(t => {
        const wrap = t.parentElement;
        if (!wrap || !wrap.id) return;
        if (saved[wrap.id]) wrap.classList.add('card-collapsed');
        t.addEventListener('click', (ev) => {
          if (ev.target.closest('.help-btn')) return;   // 說明鈕不觸發折疊
          const c = wrap.classList.toggle('card-collapsed');
          saved[wrap.id] = c ? 1 : 0;
          try { localStorage.setItem('sr_collapsed', JSON.stringify(saved)); } catch (e) {}
        });
      });
    } catch (e) {}

    try { checkDesktopMode(); } catch (e) {}
    try { renderRecent(); } catch (e) {}

    // 標題列縮合（有查過股票才有摘要可顯示）
    try {
      const hd = document.querySelector('header');
      window.addEventListener('scroll', () => {
        hd.classList.toggle('compact', window.scrollY > 150 && !!document.getElementById('hdr-sum'));
      }, { passive: true });
    } catch (e) {}

    // 回頂按鈕
    try {
      if (!document.getElementById('back-top')) {
        const bt = document.createElement('div');
        bt.id = 'back-top'; bt.textContent = '↑';
        bt.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
        document.body.appendChild(bt);
        window.addEventListener('scroll', () => {
          bt.style.display = window.scrollY > 500 ? 'flex' : 'none';
        }, { passive: true });
      }
    } catch (e) {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
