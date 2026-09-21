// ══ app.js — 導覽、區域系統、主題、初始化、SW 更新 ══════════
// 依賴：全部模組
//
// v2.8.2 重構：
// - IIFE 模組化，僅輸出公開 API（App.* 與相容別名）
// - FAB 項目、更新橫幅改事件委派（不再產生 inline onclick 字串）
// - _activeZone 改為模組私有變數
// - 功能與 v2.8.1 完全相同

(function(){
'use strict';

// ── 首頁小工具顯示控制 ─────────────────────────────────────
// ════════════════════════════════════════════════════════════
// 【首頁總覽元件顯示控制】
// ════════════════════════════════════════════════════════════
function _setHomeWidgets(show, zone){
  const dataBar = document.getElementById('h-data-bar');
  const heatmap = document.getElementById('heatmap-wrap');
  const dtask   = document.getElementById('dtask-wrap');
  const plan    = document.getElementById('plan-wrap');
  if(!dataBar || !heatmap) return;
  if(show){
    dataBar.style.display = 'none';
    heatmap.style.display = '';
    if(dtask) dtask.style.display = '';
    if(plan) plan.style.display = '';
  } else {
    heatmap.style.display = 'none';
    if(dtask) dtask.style.display = 'none';
    if(plan) plan.style.display = 'none';
    dataBar.style.display = (zone === 'exam') ? '' : 'none';
  }
}

// ── 區域計時：記錄每個區域的使用時間 ──────────────────────
let _zoneTimer = null;
let _zoneTick  = 0;
let _zoneQuizOpen = false;
let _activeZone = null;

// ════════════════════════════════════════════════════════════
// 【區域使用計時】
// ════════════════════════════════════════════════════════════
function _startZoneTimer(zone){
  _stopZoneTimer();
  _zoneTick = Date.now();
  _zoneTimer = setInterval(()=>{
    // 每60秒寫入一次，避免過於頻繁寫 DB
    const elapsed = Math.round((Date.now() - _zoneTick) / 1000);
    if(elapsed >= 60){
      logZoneUsage(zone, elapsed).catch(()=>{});
      _zoneTick = Date.now();
    }
  }, 10000); // 每10秒檢查一次
}

function _stopZoneTimer(){
  if(_zoneTimer){ clearInterval(_zoneTimer); _zoneTimer=null; }
  if(_zoneTick > 0 && _activeZone){
    const elapsed = Math.round((Date.now() - _zoneTick) / 1000);
    if(elapsed >= 3) logZoneUsage(_activeZone, elapsed).catch(()=>{});
    _zoneTick = 0;
  }
}

// ════════════════════════════════════════════════════════════
// 【三大區塊展開/收合】
// ════════════════════════════════════════════════════════════
function toggleZone(zone){
  const zones  = ['exam','leisure','study'];
  const cards  = zones.map(z=>document.getElementById('zone-'+z));
  const panels = zones.map(z=>document.getElementById('panel-'+z));

  if(_activeZone === zone){
    // 同區再點 → 全部收合，停止計時
    _stopZoneTimer();
    _activeZone = null;
    cards.forEach(c=>c.classList.remove('zone-active','zone-shrink'));
    panels.forEach(p=>p.classList.remove('open'));
    if(zone==='exam') _closeZoneQuiz();
    // 收合：顯示數據橫條 + 熱力圖
    _setHomeWidgets(true);
  } else {
    // 切換到新區：停止舊區計時，開始新區計時
    _stopZoneTimer();
    _activeZone = zone;
    _startZoneTimer(zone);
    const idx = zones.indexOf(zone);
    cards.forEach((c,i)=>{
      c.classList.remove('zone-active','zone-shrink');
      if(i===idx) c.classList.add('zone-active');
      else        c.classList.add('zone-shrink');
    });
    panels.forEach((p,i)=>{
      if(i===idx) p.classList.add('open');
      else        p.classList.remove('open');
    });
    if(zone!=='exam') _closeZoneQuiz();
    // 展開：隱藏數據橫條 + 熱力圖（考試區顯示考試數據橫條）
    _setHomeWidgets(false, zone);
  }
}

function toggleZoneQuiz(){
  _zoneQuizOpen = !_zoneQuizOpen;
  const menu  = document.getElementById('zone-quiz-menu');
  const arrow = document.getElementById('zone-quiz-arrow');
  if(menu)  menu.classList.toggle('open', _zoneQuizOpen);
  if(arrow) arrow.classList.toggle('open', _zoneQuizOpen);
}

function _closeZoneQuiz(){
  _zoneQuizOpen = false;
  const menu  = document.getElementById('zone-quiz-menu');
  const arrow = document.getElementById('zone-quiz-arrow');
  if(menu)  menu.classList.remove('open');
  if(arrow) arrow.classList.remove('open');
}

// ── 加號下拉選單（題目管理）──────────────────────────────────
// ════════════════════════════════════════════════════════════
// 【新增選單（題目/法規）】
// ════════════════════════════════════════════════════════════
function toggleAddQMenu(){
  const m = document.getElementById('add-q-menu');
  const open = m.style.display==='none';
  m.style.display = open ? 'block' : 'none';
  if(open) setTimeout(()=>document.addEventListener('click', _closeAddQOutside, {once:true}), 0);
}
function closeAddQMenu(){ document.getElementById('add-q-menu').style.display='none'; }
function _closeAddQOutside(e){
  const wrap = document.getElementById('add-q-wrap');
  if(wrap && !wrap.contains(e.target)) closeAddQMenu();
}

// ── 加號下拉選單（資料庫）────────────────────────────────────
function toggleAddLawMenu(){
  const m = document.getElementById('add-law-menu');
  const open = m.style.display==='none';
  m.style.display = open ? 'block' : 'none';
  if(open) setTimeout(()=>document.addEventListener('click', _closeAddLawOutside, {once:true}), 0);
}
function closeAddLawMenu(){ document.getElementById('add-law-menu').style.display='none'; }
function _closeAddLawOutside(e){
  const wrap = document.getElementById('add-law-wrap');
  if(wrap && !wrap.contains(e.target)) closeAddLawMenu();
}

// ── FAB 導覽 ─────────────────────────────────────────────────
let _fabOpen = false;

const _F_HOME  = {pg:'home',  icon:'🏠', label:'首頁'};
const _F_SET   = {pg:'set',   icon:'⚙️', label:'設定'};

// FAB 規則：題庫/資料庫已移至主選單，FAB 只保留導航和設定
// ════════════════════════════════════════════════════════════
// 【浮動按鈕（FAB）】
// ════════════════════════════════════════════════════════════
function _fabItemsForPage(pg){
  switch(pg){
    case 'home':   return [_F_SET];
    case 'set':    return [_F_HOME];
    default:       return [_F_HOME,_F_SET];
  }
}

function _buildFabItems(curPg){
  const container = document.getElementById('fab-items');
  if(!container) return;
  const items = _fabItemsForPage(curPg);
  container.innerHTML = items.map((it,i)=>`
    <div class="fab-item" style="transition-delay:${i*35}ms">
      <span class="fab-label">${it.label}</span>
      <button class="fab-btn" data-pg="${it.pg}">${it.icon}</button>
    </div>`).join('');
}

// FAB 項目點擊：事件委派（容器只綁一次）
function _initFabDelegation(){
  const container = document.getElementById('fab-items');
  if(!container || container._fabBound) return;
  container._fabBound = true;
  container.addEventListener('click', e=>{
    const btn = e.target.closest('.fab-btn');
    if(btn && btn.dataset.pg) fabGo(btn.dataset.pg);
  });
}

function toggleFab(){
  _fabOpen = !_fabOpen;
  const main    = document.getElementById('fab-main');
  const overlay = document.getElementById('fab-overlay');
  main.classList.toggle('open', _fabOpen);
  overlay.classList.toggle('open', _fabOpen);
  if(_fabOpen){
    _buildFabItems(S.page||'home');
    requestAnimationFrame(()=>{
      document.querySelectorAll('#fab-items .fab-item').forEach((el,i)=>{
        setTimeout(()=>el.classList.add('vis'), i*35);
      });
    });
  } else {
    _clearFabItems();
  }
}

function closeFab(){
  if(!_fabOpen) return;
  _fabOpen = false;
  document.getElementById('fab-main').classList.remove('open');
  document.getElementById('fab-overlay').classList.remove('open');
  _clearFabItems();
}

function _clearFabItems(){
  const container = document.getElementById('fab-items');
  if(!container) return;
  document.querySelectorAll('#fab-items .fab-item').forEach(el=>el.classList.remove('vis'));
  // 動畫結束後清空，避免佔空間（電子紙模式直接清）
  const isEink = document.documentElement.getAttribute('data-theme')==='eink';
  setTimeout(()=>{ if(container) container.innerHTML=''; }, isEink ? 0 : 260);
}

function fabGo(pg){
  closeFab();
  goPage(pg, null);
}

// ════════════════════════════════════════════════════════════
// 【頁面切換主控】
// ════════════════════════════════════════════════════════════
function goPage(pg, btn, fromBack){
  // bulk 是 overlay，不跳頁，直接開啟後返回
  if(pg==='bulk'){ openBulkQ(); return; }
  document.querySelectorAll('.page').forEach(p=>p.classList.add('hide'));
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('on'));
  const el = document.getElementById('pg-'+pg); if(el) el.classList.remove('hide');
  if(btn) btn.classList.add('on');
  S.page = pg;
  // 應用層頁面堆疊：記錄「真正訪問過的頁面順序」，讓返回鍵能逐層回上一頁，
  // 而不是不管訪問了幾層都直接跳回首頁。
  //   fromBack=true 代表這次呼叫本身就是返回鍵觸發的回退，不可再往堆疊推入，
  //   否則會把剛彈出的頁面又推回去，堆疊永遠清不空。
  if(!fromBack && pg !== _pageStack[_pageStack.length-1]){
    _pageStack.push(pg);
    if(_pageStack.length > 30) _pageStack.splice(0, _pageStack.length - 30);  // 防止極端情況無限增長
  }
  ({
    home:()=>{
      // 回首頁：完整收合所有展開區塊，恢復三區未展開狀態
      ['exam','leisure','study'].forEach(z=>{
        document.getElementById('zone-'+z)?.classList.remove('zone-active','zone-shrink');
        document.getElementById('panel-'+z)?.classList.remove('open');
      });
      _stopZoneTimer();
      _activeZone = null;
      _closeZoneQuiz();
      _setHomeWidgets(true);
      renderHome();
    },
    list:renderList,
    laws:renderDB,
    db:renderDB,
    stats:renderStats,
    set:renderSet,
    books:renderBooks,
    media:renderMedia,
    english:renderEnglish,
    fitness:renderFitness,
  })[pg]?.();
}

// 頁面背景/關閉時停止計時
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden) _stopZoneTimer();
  else if(_activeZone) _startZoneTimer(_activeZone);
});

const _splashStart = Date.now();

/* ══════════════════════════════════════════════════════════════
   主題系統（兩模式：dark / eink）
   儲存於 IndexedDB settings store，key: 'displayTheme'
   ══════════════════════════════════════════════════════════════ */

// ════════════════════════════════════════════════════════════
// 【主題系統（深色/電子紙）】
// ════════════════════════════════════════════════════════════
async function initTheme(){
  const saved = await getSetting('displayTheme', 'dark');
  _applyTheme(saved);
}

async function setTheme(theme){
  _applyTheme(theme);
  await setSetting('displayTheme', theme);
}

function _applyTheme(theme){
  const t = (theme === 'eink') ? 'eink' : 'dark';
  document.documentElement.setAttribute('data-theme', t === 'dark' ? '' : t);
  try{ localStorage.setItem('_themeCache', t); }catch(e){}
  ['dark','eink'].forEach(th => {
    const btn = document.getElementById(`theme-btn-${th}`);
    if(btn) btn.classList.toggle('active', th === t);
  });
}

/* ── 初始化 ── */
// ════════════════════════════════════════════════════════════
// 【App 啟動初始化】
// ════════════════════════════════════════════════════════════
/* ══════════════════════════════════════════════════════════════
   返回鍵處理（讓 PWA 的返回行為接近原生 App）
   原本按返回會直接離開回桌面；改為由上而下逐層關閉：
     彈窗 → 閱讀器/播放器 → 法條檢視 → 答題 → 非首頁回首頁
   已在首頁且無任何層級可關時，才讓返回鍵離開 App。
   作法：啟動時在歷史堆疊墊一筆「緩衝」，返回時攔截 popstate 自行處理，
        處理完再補一筆緩衝，維持可持續攔截。
   ══════════════════════════════════════════════════════════════ */
// 確保歷史堆疊上有一筆「緩衝」可供攔截返回鍵；已有就不重複推入
// 應用層頁面堆疊：紀錄真正訪問過的頁面順序（見 goPage 內的管理邏輯）
let _pageStack = ['home'];

// 返回鍵緩衝改用「預先推入大量筆數」，不再「動態重新推入」。
//   舊做法：每關閉一層就用 setTimeout 延後補回一筆緩衝。
//   問題：這個延遲會產生空窗期——如果系統判斷「沒有更多歷史紀錄」的時機
//         剛好落在這個空窗期內（尤其是原生 Android WebView 對 PWA 的返回鍵
//         處理，會在 popstate 事件之外自行判斷是否要直接關閉 Activity），
//         系統可能繞過我們的 JS 邏輯，直接把整個 App 關掉——不管我們的邏輯
//         想不想關。這正是「有時候連首頁都沒到就直接退出」的成因：不是判斷
//         錯誤，是系統搶先關閉，JS 根本沒機會處理。
// 新做法：一次性預先推入 GUARD_COUNT 筆緩衝。之後每次返回鍵消耗掉的紀錄，
//         全部由瀏覽器原生處理（同步、即時、不需要我們的 JS 介入補回），
//         我們只需要同步判斷「這一層該做什麼」。徹底消除時序風險。
const GUARD_COUNT = 60;   // 正常使用不可能疊這麼多層，足夠用一整個 session

function _pushBackGuard(){
  for(let i = 0; i < GUARD_COUNT; i++){
    try{ history.pushState({ ycGuard: true }, ''); }catch(e){ break; }
  }
}

//   
function _callIf(name){
  const fn = window[name];
  if(typeof fn === 'function'){ fn(); return true; }
  return false;
}
//   
//   position:fixed fixed   offsetParent  null
//   offsetParent  
function _isShown(el){
  if(!el || !el.isConnected) return false;
  const s = getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}
//   true
function _handleBackLayer(){
  // 1) 
  const cfmOv = document.getElementById('cfm-ov');
  if(cfmOv && cfmOv.classList.contains('on')){ _callIf('closeCfm'); return true; }

  // 2) FAB 
  const fabOv = document.getElementById('fab-overlay');
  if(fabOv && fabOv.classList.contains('open')){ _callIf('closeFab'); return true; }

  // 3)  
  for(const [id, fn] of [['add-q-menu','closeAddQMenu'], ['add-law-menu','closeAddLawMenu']]){
    const m = document.getElementById(id);
    if(m && m.style.display !== 'none' && m.style.display !== ''){ _callIf(fn); return true; }
  }

  // 4)  / PDF 
  if(document.documentElement.classList.contains('reader-active')){
    if(_callIf('closeBookReader')) return true;
  }

  // 5)  
  //      remove() 
  for(const [id, fn] of [
    ['vinyl-player-ov','closeVinylPlayer'],
    ['video-player-ov','closeVideoPlayer'],
    ['media-detail-ov', null],            //  App 
  ]){
    const el = document.getElementById(id);
    if(_isShown(el)){
      if(!(fn && _callIf(fn))) el.remove();
      return true;
    }
  }

  // 6) 
  //     .cov cfm  .ov
  //    
  const ovMap = {
    'heatmap-ov':'closeHeatmapOv', 'bulk-ov':'closeBulkQ',
    'add-ov':'closeAdd', 'law-ov':'closeLawSh', 'blaw-ov':'closeBulkLaw',
    'subj-ov':'closeSubjPick', 'qnote-ov':'closeQNote',
  };
  const opened = [...document.querySelectorAll('.ov.on, .cov.on')];
  if(opened.length){
    const top = opened[opened.length - 1];
    if(!_callIf(ovMap[top.id])) top.classList.remove('on');   // 
    return true;
  }

  // 7)   display:flex  exitLaw
  const lv = document.getElementById('lv');
  if(lv && lv.style.display === 'flex'){
    if(!_callIf('exitLaw')) lv.style.display = 'none';
    return true;
  }

  // 8) 英語閱讀器（成長區教材，以 display:flex 顯示的覆蓋層）
  //    先前未納入攔截，導致朗讀教材時按返回沒有任何反應。
  const engReader = document.getElementById('eng-reader');
  if(engReader && engReader.style.display === 'flex'){
    if(!_callIf('closeMaterial')) engReader.style.display = 'none';
    return true;
  }

  // 9) 
  const qink = document.getElementById('qink');
  if(qink && qink.classList.contains('on')){
    _callIf('toggleInk');   // toggleInk 
    return true;
  }

  // 10)    #qv  page
  const qv = document.getElementById('qv');
  if(qv && qv.style.display !== 'none' && qv.style.display !== ''){
    if(!_callIf('exitQ')) qv.style.display = 'none';
    return true;
  }

  // 11)   
  //       'home'  App
  //     S.page   
  if(_pageStack.length > 1 || S.page !== 'home'){
    if(_pageStack.length > 1) _pageStack.pop();
    else _pageStack = ['home'];   // 
    const prevPg = _pageStack[_pageStack.length - 1];
    const btn = document.querySelector(`.nb[onclick*="'${prevPg}'"]`);
    goPage(prevPg, btn, true);   // fromBack=true
    return true;
  }
  return false;   //   
}

function _initBackHandler(){
  _pushBackGuard();   // 一次性推入 60 筆緩衝，之後不再需要動態補回

  window.addEventListener('popstate', ()=>{
    try{
      // 有可關閉的層級：交給瀏覽器原生消耗掉這筆歷史紀錄即可，
      // 不需要我們的 JS 補回任何東西——這是徹底避免時序問題的關鍵。
      if(_handleBackLayer()) return;

      // 已在首頁且沒有更多層級 → 真正離開 App。
      // 同步呼叫（不用 setTimeout）：這是延續同一次使用者操作的自然導覽，
      // 不是「新增歷史紀錄」，不受 popstate 處理中呼叫 pushState 會被
      // 吞掉的限制（那個限制只針對 pushState，不影響 back/go）。
      try{ history.back(); }catch(e){}
    }catch(e){
      // 任何例外都不做額外處理：緩衝一次推入 60 筆，單次例外不影響整體攔截能力
    }
  });

  // 從背景/bfcache 回來時，若緩衝所剩不多（正常使用不會發生，這裡當保險），
  // 補滿一輪；用「剩餘量檢查」避免每次都無謂地推入。
  const _healIfLow = ()=>{
    try{
      if(!history.state || !history.state.ycGuard) _pushBackGuard();
    }catch(e){}
  };
  window.addEventListener('pageshow', _healIfLow);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) _healIfLow(); });
}

async function init(){  try{
  await initDB();
  await initTheme();
  healLawNums().catch(e=>logError('healLawNums', e));
  _initFabDelegation();
  goPage('home', document.querySelector('.nb'));
  _initBackHandler();
  }catch(e){
    logError('init', e);
    // 顯示錯誤提示但不讓畫面全黑，仍顯示 FAB
    const errDiv = document.createElement('div');
    errDiv.className = 'app-err-banner';
    errDiv.innerHTML = '⚠ 資料庫初始化失敗<br><span style="font-size:11px;color:#888">'+esc(String(e.message||e))+'</span><br><button id="init-reload-btn" style="margin-top:8px;padding:6px 14px;background:#3a1212;border:1px solid #e05c57;color:#e05c57;border-radius:6px;cursor:pointer;font-size:12px">重新載入</button>';
    document.body.appendChild(errDiv);
    document.getElementById('init-reload-btn')?.addEventListener('click', ()=>location.reload());
    // 仍嘗試顯示首頁框架
    try{ _initFabDelegation(); goPage('home', null); _initBackHandler(); }catch(_){}
    // 即使出錯也要關閉 splash
    if(typeof window._splashDismiss==='function') window._splashDismiss();
  }
}
init().then(()=>{
  // 填入版本號（雙版本）
  const verEl = document.getElementById('app-ver');
  if(verEl){
    const av = typeof APP_VERSION  !== 'undefined' ? APP_VERSION  : '';
    const dv = typeof DATA_VERSION !== 'undefined' ? DATA_VERSION : '';
    verEl.innerHTML = `v${av} <span style="color:var(--t2);font-size:10px">題庫 ${dv}</span>`;
  }
  // 關閉載入畫面（至少顯示 2.6 秒讓動畫完整播完）
  const elapsed = Date.now() - _splashStart;
  const wait = Math.max(0, 2600 - elapsed);
  setTimeout(()=>{ if(typeof window._splashDismiss==='function') window._splashDismiss(); }, wait);
});

/* ── Service Worker 更新偵測 ── */
if('serviceWorker' in navigator){
  navigator.serviceWorker.ready.then(reg => {
    // 頁面載入時若已有新版在等待（上次點了「稍後」或關閉期間部署過）
    if(reg.waiting && navigator.serviceWorker.controller){
      _showUpdateBanner(reg);
    }
    // 定期檢查更新（每 30 分鐘）
    setInterval(()=> reg.update(), 30 * 60 * 1000);
    // App 回到前景時也檢查（手機 PWA 最常見的更新時機）
    document.addEventListener('visibilitychange', ()=>{
      if(document.visibilityState === 'visible') reg.update().catch(()=>{});
    });
    // 偵測到新 SW 進入 waiting
    reg.addEventListener('updatefound', ()=>{
      const newWorker = reg.installing;
      if(!newWorker) return;
      newWorker.addEventListener('statechange', ()=>{
        if(newWorker.state === 'installed' && navigator.serviceWorker.controller){
          _showUpdateBanner(reg);
        }
      });
    });
  });
  // 新 SW 接管後自動 reload
  let _swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(!_swRefreshing){ _swRefreshing = true; location.reload(); }
  });
}

// ════════════════════════════════════════════════════════════
// 【版本更新橫幅】
// ════════════════════════════════════════════════════════════
function _showUpdateBanner(reg){
  if(document.getElementById('sw-update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'sw-update-banner';
  banner.innerHTML = `
    <div style="position:fixed;bottom:70px;left:50%;transform:translateX(-50%);
      z-index:8000;background:var(--bg1);border:1px solid var(--acc);
      border-radius:14px;padding:14px 18px;min-width:260px;max-width:90vw;
      box-shadow:0 4px 24px rgba(0,0,0,.5);text-align:center">
      <div style="font-size:13px;font-weight:700;color:var(--acc);margin-bottom:4px">🔄 發現新版本</div>
      <div style="font-size:11px;color:var(--t2);margin-bottom:12px">點擊更新載入最新版，題庫資料完全保留</div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button data-sw="later"
          style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--t2);
          background:transparent;color:var(--t2);font-size:12px;cursor:pointer">稍後</button>
        <button data-sw="update"
          style="flex:1;padding:8px;border-radius:8px;border:none;
          background:var(--acc);color:#fff;font-size:12px;font-weight:700;cursor:pointer">立即更新</button>
      </div>
    </div>`;
  banner.addEventListener('click', e=>{
    const btn = e.target.closest('[data-sw]');
    if(!btn) return;
    if(btn.dataset.sw === 'update' && reg.waiting){
      reg.waiting.postMessage({ type:'SKIP_WAITING' });
    }
    banner.remove();
  });
  document.body.appendChild(banner);
}

// ════════ 公開 API ════════
const App = {
  toggleZone, toggleZoneQuiz,
  toggleAddQMenu, closeAddQMenu, toggleAddLawMenu, closeAddLawMenu,
  toggleFab, closeFab, fabGo, goPage, setTheme
};
window.App = App;
Object.assign(window, App);

})();
