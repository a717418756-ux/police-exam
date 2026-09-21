// ══ data.js — 題目管理 + 法條資料庫 ═══════════════════════
// 依賴：db.js, utils.js, quiz.js(startQWithPool), stats.js, countdown.js
//
// v2.8.3 重構（保守第一階段）：
// - IIFE 包裝：頂層變數不再污染全域；邏輯與 v2.8.2 逐字相同
// - 刻意「不」加 'use strict'：圖片檢視器等處有沿用既有的隱式全域
//   （dragging/scale/tx/ty…），strict 會直接拋錯，留待第二階段逐一宣告
// - 公開 API 白名單見檔尾：含其他模組/index.html 引用 +
//   本檔動態 HTML onclick 依賴 + _debouncedRenderList/_debouncedRenderDB

(function(){

let _listSelMode = false;
const _listSelected = new Set();
let _dbSelMode = false;
const _dbSelected = new Set();
let _lvReadMode = false;
const _lawSortState = { key:'name', dir:1 };
// debounced 搜尋（需在頂部，HTML oninput 直接呼叫）
const _debouncedRenderList = debounce(()=>renderList(), 220);
const _debouncedRenderDB   = debounce(()=>renderDB(),   220);

const LEVEL_STYLE = {
  part: { color:'#1f6feb', border:'#1f6feb', bg:'rgba(31,111,235,0.18)', size:'14px', fw:'800', pt:'10px', pb:'4px', mt:'16px', ml:'0', br:'0 8px 8px 0', bw:'4px', label:'編' },
  chapter: { color:'#58a6ff', border:'#58a6ff', bg:'rgba(88,166,255,0.13)', size:'13px', fw:'700', pt:'7px', pb:'3px', mt:'10px', ml:'0', br:'0 6px 6px 0', bw:'3px', label:'章' },
  section: { color:'#a5d6ff', border:'#a5d6ff', bg:'rgba(165,214,255,0.08)', size:'12px', fw:'600', pt:'4px', pb:'2px', mt:'5px', ml:'18px', br:'0 4px 4px 0', bw:'2px', label:'節' },
};

// ══ questions.js — 題目管理 ════════════════════════════════
// 依賴：db.js, utils.js

let _dupResolve=null;

// ════════════════════════════════════════════════════════════
// 【首頁渲染與分區統計】
// ════════════════════════════════════════════════════════════
async function renderHome(){  try{
  const [qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const now=Date.now();
  const todayStr=today();

  // 統計數據（合併數據橫條）
  const ws=getWrong(qs,ats);
  const totalAts_=ats.length;
  const correctAts_=ats.filter(a=>a.correct).length;
  const todayAts_=ats.filter(a=>a.date===todayStr).length;
  const _set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  _set('hdb-rate', totalAts_?Math.round(correctAts_/totalAts_*100)+'%':'—');
  _set('hdb-q',    qs.length);

  // 今日任務
  const reviewDue=qs.filter(q=>(q.nextReview||0)<=now&&q.reviewLevel!==undefined).length;
  const newQ=qs.filter(q=>q.reviewLevel===undefined||q.reviewLevel===null).length;
  const dangerQ=qs.filter(q=>getDangerLevel(q,ats)==='🔴').length;
  const avgTime=ats.length?Math.round(ats.reduce((s,a)=>s+(a.responseTime||0),0)/ats.length/1000):0;
  const estMin=Math.ceil((reviewDue*avgTime||reviewDue*45)/60);

  document.getElementById('h-date').textContent=new Date().toLocaleDateString('zh-TW',{weekday:'long',month:'long',day:'numeric'});
  // 勉勵語：從 IndexedDB 讀取
  const mottoEl=document.getElementById('h-motto');
  if(mottoEl){
    const saved=await getSetting('examMotto','');
    if(saved) mottoEl.textContent=saved;
  }
  // 今日任務 badges（精緻橫排，可點擊直接開始對應練習）
  const planEl=document.getElementById('h-plan-badges');
  if(planEl){
    const badges=[];
    if(reviewDue>0) badges.push(`<span class="plan-badge review" role="button" tabindex="0" onclick="startQ('review')" title="開始複習">待複習 ${reviewDue}</span>`);
    if(dangerQ>0)   badges.push(`<span class="plan-badge danger" role="button" tabindex="0" onclick="startQ('all')" title="從危險題開始">危險 ${dangerQ}</span>`);
    const nq=Math.min(newQ,10);
    if(nq>0)        badges.push(`<span class="plan-badge newq" role="button" tabindex="0" onclick="startQ('new')" title="練習新題">新題 ${nq}</span>`);
    if(estMin>0)    badges.push(`<span class="plan-badge time">約 ${estMin} 分鐘</span>`);
    if(!badges.length) badges.push(`<span class="plan-badge time">今日進度良好 ✓</span>`);
    planEl.innerHTML=badges.join('');
  }
  // 數據橫條（危險題、待複習）
  _set('hdb-danger',  dangerQ);
  _set('hdb-review',  reviewDue);

  // 熱力圖
  renderHeatmap();
  renderDtask().catch(()=>{});
  if(typeof renderMilestones==='function') renderMilestones().catch(()=>{});
  if(typeof renderPlan==='function' && typeof _plannerTab!=='undefined' && _plannerTab==='plan') renderPlan().catch(()=>{});

  // 考試倒數
  renderCountdown();

  // datalist 科目
  const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))];
  ['bi-subs','f-subs'].forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.innerHTML=subs.map(s=>`<option value="${esc(s)}">`).join('');
  });

  // ── 三大區即時資料（儀表板化）─────────────────────────────
  // 混合風格：考試看進度、休閒看最近閱讀、學習看今日時間
  renderZoneStats(qs, ats, reviewDue, todayAts_, todayStr).catch(()=>{});
  }catch(e){ logError('renderHome',e); }}

// ── 三大區 zone-desc 即時資料 ──────────────────────────────
async function renderZoneStats(qs, ats, reviewDue, todayAts, todayStr){
  const setDesc=(zoneId, text)=>{
    const el=document.querySelector(`#${zoneId} .zone-desc`);
    if(el) el.textContent=text;
  };
  try{
    // 考試區：看進度（待複習優先，否則今日答題，再否則題庫量）
    if(reviewDue>0)      setDesc('zone-exam', `待複習 ${reviewDue}・今日 ${todayAts} 題`);
    else if(todayAts>0)  setDesc('zone-exam', `今日已答 ${todayAts} 題 ✓`);
    else                 setDesc('zone-exam', `題庫 ${qs.length} 題待挑戰`);

    // 休閒區：看最近閱讀（取 ebooks 中 lastRead 最新者）
    const ebooks=await da('ebooks').catch(()=>[]);
    if(ebooks.length){
      const recent=ebooks
        .filter(b=>b.lastRead)
        .sort((a,b)=>(b.lastRead||0)-(a.lastRead||0))[0];
      if(recent){
        const title=recent.title||'未命名';
        setDesc('zone-leisure', `最近讀・${title.length>10?title.slice(0,10)+'…':title}`);
      } else {
        setDesc('zone-leisure', `藏書 ${ebooks.length} 本`);
      }
    } else {
      setDesc('zone-leisure', '放鬆・閱讀・電子書');
    }

    // 學習區：看今日時間（usageLogs 今日 study 秒數）
    const dayLogs=await getDayUsage(todayStr).catch(()=>[]);
    const studySec=dayLogs.filter(l=>l.zone==='study').reduce((s,l)=>s+(l.seconds||0),0);
    if(studySec>=60){
      setDesc('zone-study', `今日學習 ${Math.round(studySec/60)} 分鐘`);
    } else {
      const [rb,lm,em]=await Promise.all([
        da('refbooks').catch(()=>[]),
        da('learnmedia').catch(()=>[]),
        da('englishMaterials').catch(()=>[]),
      ]);
      const total=rb.length+lm.length+em.length;
      setDesc('zone-study', total>0?`教材 ${total} 份待學習`:'課程・音訊・碎片・複習');
    }
  }catch(e){ logError('renderZoneStats',e); }
}

// ── 熱力圖渲染 ───────────────────────────────────────────────
const _HM_COLS = 35;  // 顯示35天

// ════════════════════════════════════════════════════════════
// 【成長軌跡熱力圖】
// ════════════════════════════════════════════════════════════
async function renderHeatmap(){
  const grid = document.getElementById('heatmap-grid');
  if(!grid) return;

  const logs = await getUsageLogs(_HM_COLS);

  // 建立日期→秒數 map
  const dayMap = {};
  logs.forEach(l => {
    dayMap[l.date] = (dayMap[l.date] || 0) + (l.seconds || 0);
  });

  // 每日任務完成度（供綜合評分）
  let taskHist = {};
  try{
    if(typeof _getDtaskHistory === 'function') taskHist = await _getDtaskHistory();
  }catch(e){}

  // 絕對門檻：學習時間以 60 分鐘為達標基準（差→優反映實際努力，非相對比較）
  const TARGET_SEC = 60 * 60;

  const today_ = today();
  const cells = [];
  for(let i = _HM_COLS - 1; i >= 0; i--){
    const d = new Date(Date.now() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const sec = dayMap[dateStr] || 0;
    // 時間分（0~1，60分鐘封頂）+ 任務分（0~1，當日完成比例）
    const timeScore = Math.min(1, sec / TARGET_SEC);
    const taskRec = taskHist[dateStr];
    const taskScore = taskRec ? (taskRec.r || 0) : 0;
    // 綜合：時間佔 6 成、任務佔 4 成
    const combined = timeScore * 0.6 + taskScore * 0.4;
    // 0 分=level0；其餘依綜合分映射 1~4 級
    const level = combined <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(combined * 4)));
    const isToday = dateStr === today_;
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd_ = String(d.getDate()).padStart(2,'0');
    cells.push({ dateStr, sec, level, isToday, label: `${mm}/${dd_}` });
  }

  grid.innerHTML = cells.map(c =>
    `<div class="hm-cell${c.isToday?' hm-today':''}"
      style="background:var(--hm${c.level})"
      title="${c.label}"
      onclick="openHeatmapOv('${c.dateStr}','${escJs(c.label)}')"></div>`
  ).join('');
}

// 開啟熱力圖日期視窗
// ════════════════════════════════════════════════════════════
// 【成長詳情彈窗（含運動數據）】
// ════════════════════════════════════════════════════════════
async function openHeatmapOv(dateStr, label){
  const ov  = document.getElementById('heatmap-ov');
  const ttl = document.getElementById('heatmap-ov-date');
  const body= document.getElementById('heatmap-ov-body');
  if(!ov||!ttl||!body) return;

  ttl.textContent = label + ' 成長詳情';
  body.innerHTML = '<div style="text-align:center;padding:16px;color:var(--t2);font-size:12px">載入中…</div>';
  ov.classList.add('on');

  const logs = await getDayUsage(dateStr);
  const ZONE_CFG = {
    exam:    { label:'考試區', color:'#6ea8fe' },
    leisure: { label:'休閒區', color:'#ffb340' },
    study:   { label:'成長區', color:'#4caf7d' },
  };

  if(!logs.length){
    body.innerHTML = '<div class="hm-ov-empty">📭 這天沒有記錄</div>';
    return;
  }

  const total = logs.reduce((s,l) => s + (l.seconds||0), 0);
  const fmt = s => s >= 3600
    ? `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`
    : `${Math.floor(s/60)}m ${s%60}s`;

  // 計算圓餅（SVG）
  const R = 52, CX = 64, CY = 64;
  let startAngle = -Math.PI / 2;
  const slices = logs.map(l => ({
    ...l, ...ZONE_CFG[l.zone],
    pct: (l.seconds||0) / total
  }));

  function polarToXY(angle){
    return [CX + R * Math.cos(angle), CY + R * Math.sin(angle)];
  }

  let svgPaths = '';
  slices.forEach(s => {
    const angle = s.pct * Math.PI * 2;
    const [x1,y1] = polarToXY(startAngle);
    const [x2,y2] = polarToXY(startAngle + angle);
    const large = angle > Math.PI ? 1 : 0;
    svgPaths += `<path d="M${CX},${CY} L${x1},${y1} A${R},${R} 0 ${large},1 ${x2},${y2} Z"
      fill="${s.color}" opacity="0.9"/>`;
    startAngle += angle;
  });

  const legendHTML = slices.map(s =>
    `<div class="hm-pie-item">
      <div class="hm-pie-dot" style="background:${s.color}"></div>
      <div class="hm-pie-label">${s.label}</div>
      <div class="hm-pie-val">${fmt(s.seconds||0)} (${Math.round(s.pct*100)}%)</div>
    </div>`
  ).join('');

  body.innerHTML = `
    <div class="hm-ov-total">總計 ${fmt(total)}</div>
    <div class="hm-pie-wrap">
      <svg width="128" height="128" viewBox="0 0 128 128">
        ${svgPaths}
        <circle cx="${CX}" cy="${CY}" r="28" fill="var(--bg0)"/>
        <text x="${CX}" y="${CY}" text-anchor="middle" dominant-baseline="central"
          style="font-size:11px;fill:var(--t1);font-weight:700">${fmt(total)}</text>
      </svg>
      <div class="hm-pie-legend">${legendHTML}</div>
    </div>`;

  // 整合運動數據（當天運動時長 + 熱量結餘）
  try{
    if(typeof _getFitData === 'function'){
      const fit = await _getFitData(dateStr);
      const bal = (fit.intake||0) - (fit.burned||0);
      const balColor = bal > 0 ? '#e0a020' : '#4caf7d';
      const balSign = bal > 0 ? '+' : '';
      body.innerHTML += `
        <div class="hm-fit-section">
          <div class="hm-fit-title">運動健康</div>
          <div class="hm-fit-grid">
            <div class="hm-fit-item">
              <span class="hm-fit-val">${fit.activeMin||0}<small>分</small></span>
              <span class="hm-fit-lab">🏃 運動時長</span>
            </div>
            <div class="hm-fit-item">
              <span class="hm-fit-val" style="color:${balColor}">${balSign}${bal}<small>kcal</small></span>
              <span class="hm-fit-lab">⚖️ 熱量結餘</span>
            </div>
          </div>
        </div>`;
    }
  }catch(e){ /* 無運動數據不影響主視窗 */ }

  // 整合每日任務達成狀況（當天）
  try{
    if(typeof _getDtaskHistory === 'function' && typeof _dtaskAchieveIcon === 'function'){
      const hist = await _getDtaskHistory();
      const rec = hist[dateStr];
      if(rec && rec.tasks && rec.tasks.length){
        const doneN = rec.tasks.filter(t=>t.done).length;
        const tasksHtml = rec.tasks.map(t=>`
          <div class="hm-dt-task ${t.done?'done':'undone'}">
            <span class="hm-dt-tick">${t.done
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>'}</span>
            <span class="hm-dt-text">${esc(t.text)}</span>
          </div>`).join('');
        body.innerHTML += `
          <div class="hm-dt-section">
            <div class="hm-dt-title">
              <span class="hm-dt-ic">${_dtaskAchieveIcon(rec.r)}</span>
              每日任務
              <span class="hm-dt-cnt">${doneN}/${rec.tasks.length}</span>
            </div>
            <div class="hm-dt-list">${tasksHtml}</div>
          </div>`;
      }
    }
  }catch(e){ /* 無任務資料不影響主視窗 */ }
}

function closeHeatmapOv(){
  const ov = document.getElementById('heatmap-ov');
  if(ov) ov.classList.remove('on');
}

function setF(el, f){
  document.querySelectorAll('#fchips .chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');
  S.filter = f;
  S.subF = 'all';  // 切換類型篩選時重置科目篩選
  renderList();
}


// ════════════════════════════════════════════════════════════
// 【題庫列表】
// ════════════════════════════════════════════════════════════
// ── 搜尋說明彈窗 ──────────────────────────────────────────
function showSearchHelp(){
  const ov = document.createElement('div');
  ov.className = 'ov on';
  ov.id = 'search-help-ov';
  ov.onclick = (e)=>{ if(e.target===ov) ov.remove(); };
  ov.innerHTML = `
    <div class="sh" onclick="event.stopPropagation()" style="max-width:480px">
      <div class="shdl"></div>
      <div class="sht"><span>搜尋說明</span>
        <button class="shx" onclick="document.getElementById('search-help-ov').remove()">✕</button></div>
      <div style="padding:4px 18px 24px">
        <p class="shelp-intro">直接輸入文字即可搜尋，會同時比對下列欄位（不分大小寫）：</p>
        <div class="shelp-list">
          <div class="shelp-row"><span class="shelp-tag">題幹內容</span><span class="shelp-ex">例：刑法 → 含「刑法」的題目</span></div>
          <div class="shelp-row"><span class="shelp-tag">科目</span><span class="shelp-ex">例：行政法 → 該科目所有題</span></div>
          <div class="shelp-row"><span class="shelp-tag">考試別</span><span class="shelp-ex">例：升官等 → 該考試別的題</span></div>
          <div class="shelp-row"><span class="shelp-tag">年度</span><span class="shelp-ex">例：112 → 112 年的題目</span></div>
          <div class="shelp-row"><span class="shelp-tag">題號</span><span class="shelp-ex">例：15 → 第 15 題</span></div>
          <div class="shelp-row"><span class="shelp-tag">關鍵字</span><span class="shelp-ex">例：正當防衛 → 標註此關鍵字的題</span></div>
        </div>
        <p class="shelp-tip">💡 多個詞用空白分開可組合，例如「<b>行政法 112</b>」會找 112 年的行政法題目。</p>
      </div>
    </div>`;
  document.body.appendChild(ov);
}

// 分組卡片的掌握度視覺化：以「錯題佔比」呈現，一眼看出哪個年度／科目最弱。
//   綠=穩、黃=待加強、紅=弱項；無作答紀錄則不顯示（避免把「還沒做」誤判成「很穩」）
function _mkMasteryBar(total, danger, answered){
  if(!answered) return '<div class="mst-none">尚未作答</div>';
  // 分子是 getWrong 判定的「危險題」（最近3次全錯，或錯誤率>50%），
  // 不是單純的答錯次數 —— 因此標示為「危險題佔比」而非「錯誤率」，
  // 避免把「答錯過但已練熟」的題目也算進去而誤導判讀。
  const pct = Math.round(danger / answered * 100);
  const lv  = pct >= 40 ? 'bad' : pct >= 15 ? 'mid' : 'good';
  const txt = pct === 0 ? '已掌握' : '危險題 ' + pct + '%';
  return '<div class="mst"><div class="mst-bar"><div class="mst-fill ' + lv + '" style="width:'
       + Math.max(pct, 3) + '%"></div></div>'
       + '<span class="mst-txt ' + lv + '">' + txt
       + '<span class="mst-sub">（' + answered + '/' + total + ' 題已練）</span></span></div>';
}

async function renderList(){  try{
  const [qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const kw=(document.getElementById('si')?.value||'').toLowerCase().trim();
  const f=S.filter||'all';
  const sf=S.subF||'all';
  const ws=getWrong(qs,ats);
  let fl=qs.filter(q=>{
    if(f==='mc'&&q.type!=='mc')return false;
    if(f==='es'&&q.type!=='es')return false;
    if(f==='wrong'&&!ws.has(q.id))return false;
    if(f==='star'&&!q.starred)return false;
    if(sf!=='all'&&q.subject!==sf)return false;
    if(kw){
      const h=(q.searchBlob||((q.stem||'')+' '+(q.groupStem||'')+' '+(q.subject||'')+' '+
        (q.year||'')+' '+(q.exam||'')+' '+(q.num||'')+' '+(q.keywords||[]).join(' '))).toLowerCase();
      // 多關鍵字 AND：空格分隔的每個詞都要出現（可跨欄位，順序不限）
      const terms=kw.split(/\s+/).filter(Boolean);
      if(!terms.every(t=>h.includes(t))) return false;
    }
    return true;
  }).sort((a,b)=>(b.year||'').localeCompare(a.year||'') || (a.subject||'').localeCompare(b.subject||''));

  const lcEl=document.getElementById('lc');
  if(lcEl) lcEl.textContent='共 '+fl.length+' 題';

  // ── 各篩選標籤顯示題數；0 題者反灰並停用 ──────────────────
  //   題數以「目前科目 + 關鍵字」為前提計算，切換類型才有實際意義。
  const matchKw=(q)=>{
    if(!kw) return true;
    const h=(q.searchBlob||((q.stem||'')+' '+(q.groupStem||'')+' '+(q.subject||'')+' '+
        (q.year||'')+' '+(q.exam||'')+' '+(q.num||'')+' '+(q.keywords||[]).join(' '))).toLowerCase();
    return kw.split(/\s+/).filter(Boolean).every(t=>h.includes(t));
  };
  const baseForType=qs.filter(q=>(sf==='all'||q.subject===sf)&&matchKw(q));
  const typeCount={
    all:   baseForType.length,
    mc:    baseForType.filter(q=>q.type==='mc').length,
    es:    baseForType.filter(q=>q.type==='es').length,
    wrong: baseForType.filter(q=>ws.has(q.id)).length,
    star:  baseForType.filter(q=>q.starred).length,
  };
  document.querySelectorAll('#fchips .chip').forEach(btn=>{
    const m=(btn.getAttribute('onclick')||'').match(/setF\(this,'(\w+)'\)/);
    if(!m) return;
    const key=m[1], n=typeCount[key]||0;
    // 標籤文字只設一次，之後只更新數字（避免重複附加）
    // 標籤只顯示名稱，不加題數（題數在下方分組列表呈現即可）
    if(!btn.dataset.label) btn.dataset.label=btn.textContent.trim();
    btn.textContent=btn.dataset.label;
    // 0 題 → 停用（目前選中的類型即使為 0 也保持可按，否則會卡住無法切回）
    const off = n===0 && key!==f;
    btn.classList.toggle('chip-off', off);
    btn.disabled = off;
  });

  // 更新科目 chip
  // 科目 chip 只顯示目前篩選結果內的科目（不含關鍵字搜尋，以保留切換科目的意義）
  const subsBase=f==='all'&&!kw ? qs : fl;
  const subs=[...new Set(subsBase.map(q=>q.subject).filter(Boolean))].sort();
  const schips=document.getElementById('schips');
  if(schips){
    schips.innerHTML='';
    // 科目題數以「目前類型 + 關鍵字」為前提
    const baseForSub=qs.filter(q=>{
      if(f==='mc'&&q.type!=='mc')return false;
      if(f==='es'&&q.type!=='es')return false;
      if(f==='wrong'&&!ws.has(q.id))return false;
      if(f==='star'&&!q.starred)return false;
      return matchKw(q);
    });
    ['all',...subs].forEach(name=>{
      const n = name==='all' ? baseForSub.length
                             : baseForSub.filter(q=>q.subject===name).length;
      const b=document.createElement('button');
      const off = n===0 && !((name==='all'&&sf==='all')||(name!=='all'&&sf===name));
      b.className='chip'+(((name==='all'&&sf==='all')||(name!=='all'&&sf===name))?' on':'')+(off?' chip-off':'');
      b.textContent=(name==='all'?'全部科目':name);
      b.disabled=off;
      if(!off) b.onclick=()=>{ S.subF=name; renderList(); };
      schips.appendChild(b);
    });
  }

  const el=document.getElementById('qlist');
  if(!el) return;
  if(window._vlScroll){ window.removeEventListener('scroll',window._vlScroll); window._vlScroll=null; }
  el.innerHTML='';

  if(!fl.length){
    el.innerHTML='<div class="empty"><span class="ic">📭</span><span>尚無題目</span></div>';
    return;
  }

  // 有搜尋關鍵字時：直接顯示題目列表（不分組）
  if(kw){
    const PAGE=50; let page=0;
    const _mkQCard=(q)=>{
      const danger=getDangerLevel(q,ats);
      const div=document.createElement('div');
      div.className='qc'+(ws.has(q.id)?' wrong':'')+(q.starred?' star':'');
      div.innerHTML=
        '<div class="qch">'+
          '<span class="badge '+(q.type==='mc'?'bmc':'bes')+'">'+(q.type==='mc'?'選擇':'申論')+'</span>'+
          (q.year?'<span class="tag">'+esc(q.year)+'</span>':'')+
          (q.exam?'<span class="tag">'+esc(q.exam)+'</span>':'')+
          '<span class="tag">'+esc(q.subject||'未分類')+'</span>'+
          '<span style="font-size:13px;margin-left:auto">'+danger+'</span>'+
          '<span style="font-size:15px;margin-left:4px">'+(q.starred?'★':'☆')+'</span>'+
        '</div>'+
        '<div class="qst">'+esc((q.stem||'').slice(0,100))+'</div>'+
        '<div class="qa">'+
          '<button class="qabn" onclick="editQ('+q.id+')">✏ 編輯</button>'+
          '<button class="qabn" data-qid="'+q.id+'" onclick="startSingleQ(this)">▶ 練習</button>'+
          '<button class="qabn" onclick="toggleStar('+q.id+')">'+(q.starred?'★':'☆')+'</button>'+
          +
        '</div>';
      div.dataset.qid = q.id;
      div.dataset.selkey = 'qid:'+q.id;
      return div;
    };
    const loadMore=()=>{
      const batch=fl.slice(page*PAGE,(page+1)*PAGE);
      if(!batch.length) return;
      batch.forEach(q=>el.appendChild(_mkQCard(q)));
      page++;
    };
    loadMore();
    if(fl.length>PAGE){
      window._vlScroll=()=>{ if(window.scrollY+window.innerHeight>=document.body.offsetHeight-200) loadMore(); };
      window.addEventListener('scroll',window._vlScroll);
    }
    return;
  }

  // 無搜尋：依年度分組（第一層），點進去才顯示科目
  const byYear={};
  fl.forEach(q=>{
    const yr = q.year||'未知年度';
    if(!byYear[yr]) byYear[yr]=[];
    byYear[yr].push(q);
  });

  Object.entries(byYear).sort((a,b)=>b[0].localeCompare(a[0])).forEach(([yr, qs])=>{
    const wrong = qs.filter(q=>ws.has(q.id)).length;
    // 計算科目數
    const subjects = [...new Set(qs.map(q=>q.subject||'未分類'))];
    const div=document.createElement('div');
    div.className='qc';
    div.style.cursor='pointer';
    div.innerHTML=
      '<div class="qch">'+
        '<span class="tag" style="font-size:13px;font-weight:700">'+esc(yr)+'</span>'+
        '<span style="font-size:11px;color:var(--t2);margin-left:6px">'+subjects.length+' 科</span>'+
        '<span style="margin-left:auto;font-size:12px;color:var(--t2)">'+qs.length+' 題'+(wrong?' · <span style="color:var(--red)">'+wrong+' 錯</span>':'')+'</span>'+
        '<span style="color:var(--t2);margin-left:6px">›</span>'+
      '</div>'+
      '<div style="font-size:11px;color:var(--t2);margin-top:4px">'+subjects.slice(0,4).map(s=>esc(s)).join('・')+(subjects.length>4?'…':'')+'</div>'+
      _mkMasteryBar(qs.length, wrong, qs.filter(q=>(q.reviewLevel||0)>0||q.wrongCount).length);
    div.dataset.selkey = 'yr:'+yr;
    div.onclick=()=>{ if(_listSelMode) return; openYearGroup(yr); };
    el.appendChild(div);
  });
}catch(e){ logError('renderList',e); }}

// ── 年度選擇頁（第二層）─────────────────────────────────────────
// ════════════════════════════════════════════════════════════
// 【題庫三層導覽（年度/科目）】
// ════════════════════════════════════════════════════════════
async function openYearGroup(year){  try{
  const [qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const ws=getWrong(qs,ats);
  const f=S.filter||'all';
  const sf=S.subF||'all';
  const fl=qs.filter(q=>{
    if((q.year||'未知年度')!==year) return false;
    if(f==='mc'&&q.type!=='mc') return false;
    if(f==='es'&&q.type!=='es') return false;
    if(f==='wrong'&&!ws.has(q.id)) return false;
    if(f==='star'&&!q.starred) return false;
    if(sf!=='all'&&q.subject!==sf) return false;
    return true;
  });
  const el=document.getElementById('qlist');
  if(!el) return;
  if(window._vlScroll){ window.removeEventListener('scroll',window._vlScroll); window._vlScroll=null; }
  el.innerHTML='';

  // 返回按鈕
  const backDiv=document.createElement('div');
  backDiv.className='list-back-row';
  const backBtn=document.createElement('button');
  backBtn.className='btn bg list-back-btn';
  backBtn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg> 返回列表';
  backBtn.onclick=()=>{ _qGroupYear=''; _qGroupSubject=''; renderList(); };
  backDiv.appendChild(backBtn);
  el.appendChild(backDiv);

  // 科目分組
  const bySubject={};
  fl.forEach(q=>{
    const sub=q.subject||'未分類';
    if(!bySubject[sub]) bySubject[sub]=[];
    bySubject[sub].push(q);
  });
  const lcEl=document.getElementById('lc');
  if(lcEl) lcEl.textContent=year+' · '+Object.keys(bySubject).length+' 科 · '+fl.length+' 題';

  Object.entries(bySubject).sort((a,b)=>a[0].localeCompare(b[0],'zh-TW')).forEach(([sub,sqs])=>{
    const wrong=sqs.filter(q=>ws.has(q.id)).length;
    const div=document.createElement('div');
    div.className='qc';
    div.style.cursor='pointer';
    div.innerHTML=
      '<div class="qch">'+
        '<span class="tag">'+esc(sub)+'</span>'+
        '<span style="margin-left:auto;font-size:12px;color:var(--t2)">'+sqs.length+' 題'+(wrong?' · <span style="color:var(--red)">'+wrong+' 錯</span>':'')+'</span>'+
        '<span style="color:var(--t2);margin-left:6px">›</span>'+
      '</div>'+
      _mkMasteryBar(sqs.length, wrong, sqs.filter(q=>(q.reviewLevel||0)>0||q.wrongCount).length);
    div.dataset.selkey = 'sub:'+year+':'+sub;
    div.onclick=()=>{
      if(_listSelMode){ return; }
      openExamGroup(year, sub);
    };
    el.appendChild(div);
  });
  if(_listSelMode) _applyListSelUI();
}catch(e){ logError('openYearGroup',e); }}

// ── 題目群組詳細頁 ────────────────────────────────────────────
let _qGroupYear='', _qGroupSubject='', _qGroupExam='';
// ── 考試別分組頁（第三層：年度→考科→考試別）─────────────────
const _EXAM_TYPES_ALL = ['警佐班','升官等','警大二技','三等考試','其他'];
let _examGroupYear='', _examGroupSubject='';
async function openExamGroup(year, subject){  try{
  _examGroupYear=year; _examGroupSubject=subject;
  const [qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const ws=getWrong(qs,ats);

  // 該年度+考科下的題目
  // ★ 必須與上一層（openYearGroup）套用相同的類型篩選，否則選了「申論題」，
  //   考試別的題數仍會把選擇題算進去，數字與實際點進去看到的不符。
  const f = S.filter || 'all';
  const scoped = qs.filter(q=>{
    if((q.year||'未知年度')!==year) return false;
    if((q.subject||'未分類')!==subject) return false;
    if(f==='mc'    && q.type!=='mc')   return false;
    if(f==='es'    && q.type!=='es')   return false;
    if(f==='wrong' && !ws.has(q.id))   return false;
    if(f==='star'  && !q.starred)      return false;
    return true;
  });

  // 依考試別分組
  const byExam={};
  scoped.forEach(q=>{
    const ex = q.exam || '未分類';
    if(!byExam[ex]) byExam[ex]=[];
    byExam[ex].push(q);
  });

  const el=document.getElementById('qlist');
  if(!el) return;
  if(window._vlScroll){ window.removeEventListener('scroll',window._vlScroll); window._vlScroll=null; }

  const lcEl=document.getElementById('lc');
  if(lcEl) lcEl.textContent=year+' · '+subject+' · '+scoped.length+' 題';

  el.innerHTML='';
  // 返回按鈕
  const backDiv=document.createElement('div');
  backDiv.className='list-back-row';
  const backBtn=document.createElement('button');
  backBtn.className='btn bg list-back-btn';
  backBtn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg> 返回考科';
  backBtn.onclick=()=>openYearGroup(year);
  backDiv.appendChild(backBtn);
  el.appendChild(backDiv);

  // 已知考試別（有題的）+ 標準考試別（未建題標示）合併顯示
  const examOrder = [..._EXAM_TYPES_ALL];
  Object.keys(byExam).forEach(e=>{ if(!examOrder.includes(e)) examOrder.push(e); });

  examOrder.forEach(ex=>{
    const eqs = byExam[ex] || [];
    const has = eqs.length>0;
    const wrong = eqs.filter(q=>ws.has(q.id)).length;
    const div=document.createElement('div');
    div.className='qc'+(has?'':' exam-empty');
    if(has) div.style.cursor='pointer';
    div.innerHTML=
      '<div class="qch">'+
        '<span class="tag">'+esc(ex)+'</span>'+
        '<span style="margin-left:auto;font-size:12px;color:var(--t2)">'+
          (has ? eqs.length+' 題'+(wrong?' · <span style="color:var(--red)">'+wrong+' 錯</span>':'') : '0 題')+
        '</span>'+
        (has?'<span style="color:var(--t2);margin-left:6px">›</span>':'')+
      '</div>'+
      (has ? _mkMasteryBar(eqs.length, wrong, eqs.filter(q=>(q.reviewLevel||0)>0||q.wrongCount).length) : '');
    if(has){
      div.onclick=()=>openQGroup(year, subject, ex);
    }
    el.appendChild(div);
  });
}catch(e){ logError('openExamGroup',e); }}

async function openQGroup(year, subject, examType){  try{
  _qGroupYear=year; _qGroupSubject=subject; _qGroupExam=examType||'';
  const [qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const ws=getWrong(qs,ats);
  const f=S.filter||'all';
  const fl=qs.filter(q=>{
    if((q.year||'未知年度')!==year) return false;
    if((q.subject||'未分類')!==subject) return false;
    if(examType && (q.exam||'未分類')!==examType) return false;
    if(f==='mc'&&q.type!=='mc') return false;
    if(f==='es'&&q.type!=='es') return false;
    if(f==='wrong'&&!ws.has(q.id)) return false;
    if(f==='star'&&!q.starred) return false;
    return true;
  }).sort((a,b)=>(a.id||0)-(b.id||0));

  const el=document.getElementById('qlist');
  if(!el) return;
  if(window._vlScroll){ window.removeEventListener('scroll',window._vlScroll); window._vlScroll=null; }

  // header：返回按鈕
  const lcEl=document.getElementById('lc');
  if(lcEl) lcEl.textContent=year+' · '+subject+(examType?' · '+examType:'')+' · '+fl.length+' 題';

  el.innerHTML='';
  // 返回按鈕區
  const backDiv=document.createElement('div');
  backDiv.className='list-back-row';
  const backBtn=document.createElement('button');
  backBtn.className='btn bg list-back-btn';
  backBtn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg> 返回考試別';
  backBtn.onclick=()=>openExamGroup(year, subject);
  backDiv.appendChild(backBtn);
  el.appendChild(backDiv);

  const _mkQCard=(q)=>{
    const danger=getDangerLevel(q,ats);
    const div=document.createElement('div');
    div.className='qc'+(ws.has(q.id)?' wrong':'')+(q.starred?' star':'');
    div.dataset.selkey='qid:'+q.id;  // 勾選模式可選取（修正最底層無法勾選刪除）
    div.innerHTML=
      '<div class="qch">'+
        '<span class="badge '+(q.type==='mc'?'bmc':'bes')+'">'+(q.type==='mc'?'選擇':'申論')+'</span>'+
        (q.year?'<span class="tag">'+esc(q.year)+'</span>':'')+
        (q.exam?'<span class="tag">'+esc(q.exam)+'</span>':'')+
        '<span class="tag">'+esc(q.subject||'未分類')+'</span>'+
        '<span style="font-size:13px;margin-left:auto">'+danger+'</span>'+
        '<span style="font-size:15px;margin-left:4px">'+(q.starred?'★':'☆')+'</span>'+
      '</div>'+
      '<div class="qst">'+esc((q.stem||'').slice(0,100))+'</div>'+
      '<div class="qa">'+
        '<button class="qabn" onclick="editQ('+q.id+')">✏ 編輯</button>'+
        '<button class="qabn" data-qid="'+q.id+'" onclick="startSingleQ(this)">▶ 練習</button>'+
        '<button class="qabn" onclick="toggleStar('+q.id+')">'+(q.starred?'★':'☆')+'</button>'+
      '</div>';
    return div;
  };

  fl.forEach(q=>el.appendChild(_mkQCard(q)));
  if(_listSelMode) _applyListSelUI();
}catch(e){ logError('openQGroup',e); }}



// ── 題目新增/編輯表單控制 ───────────────────────────────────
function closeAdd(){
  document.getElementById('add-ov').classList.remove('on');
  S.editId = null;
  S.qType = 'mc';
}

// ════════════════════════════════════════════════════════════
// 【新增/編輯題目表單】
// ════════════════════════════════════════════════════════════
function showAdd(q){
  S.editId = q?.id || null;
  S.qType = q?.type || 'mc';
  // 初始化答案為 Set（支援多選）
  // ★ 不可預設成 'A'：原本寫 `: new Set(['A'])`，只要題目的 answer 是空的
  //   （例如題庫本來就沒填答案、或還原後欄位遺失），開啟編輯畫面就會被當成
  //   選了 A，一按儲存就把 'A' 寫死進資料庫 —— 正確答案被無聲覆蓋。
  //   改為留空，讓使用者自己選；未選就存檔時另有提示。
  S.correct = q?.answer ? new Set([...q.answer]) : new Set();
  const title = document.getElementById('add-title');
  if(title) title.textContent = q?.id ? '編輯題目' : '新增題目';
  // 編輯模式隱藏「連續新增」按鈕
  const contBtn = document.getElementById('btn-save-cont');
  if(contBtn) contBtn.style.display = q?.id ? 'none' : '';
  // 填入欄位
  const set = (id, v) => { const el=document.getElementById(id); if(el) el.value = v||''; };
  set('f-sub',  q?.subject||'');
  set('f-yr',   q?.year||'');
  set('f-num',  q?.num||'');
  set('f-stem', q?.stem||'');
  set('f-es',   q?.answerEs||'');
  set('f-kw',   (q?.keywords||[]).join('，'));
  set('f-must-kw', (q?.mustKeywords||[]).join('，'));
  set('f-note', q?.note||'');
  _setMarkRow('f-mark-row', q?.hlColor||'');
  set('f-laws', (q?.relatedLaws||[]).map(l=>l.ref).join('，'));
  const exEl = document.getElementById('f-ex');
  if(exEl) exEl.value = q?.exam||'';
  const isNum = document.getElementById('f-is-number');
  if(isNum) isNum.checked = q?.isNumberQ||false;
  // 題組
  const isGroup = document.getElementById('f-is-group');
  const groupWrap = document.getElementById('f-group-wrap');
  if(isGroup) isGroup.checked = !!(q?.groupStem);
  if(groupWrap) groupWrap.classList.toggle('hide', !q?.groupStem);
  set('f-group-stem', q?.groupStem||'');
  set('f-group-id',   q?.groupId||'');
  set('f-group-order', q?.groupOrder||'');
  setQT(S.qType, q?.options);
  // 更新科目 datalist
  da('questions').then(qs=>{
    const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))];
    const dl=document.getElementById('f-subs');
    if(dl){ dl.innerHTML=subs.map(s=>`<option value="${esc(s)}">`).join(''); }
  }).catch(()=>{});
  document.getElementById('add-ov').classList.add('on');
}

function setQT(type, opts){
  S.qType = type;
  // 只確保型別正確，不補預設答案（補 'A' 會覆蓋掉原本未填答案的狀態）
  if(!(S.correct instanceof Set)) S.correct = new Set(S.correct ? [...S.correct] : []);
  const mc = document.getElementById('tmc');
  const es = document.getElementById('tes');
  const mcArea = document.getElementById('mc-opts');
  const esArea = document.getElementById('es-area');
  if(mc) mc.className = type==='mc' ? 'btn bp' : 'btn bg';
  if(es) es.className = type==='es' ? 'btn bp' : 'btn bg';
  if(mcArea) mcArea.style.display = type==='mc' ? '' : 'none';
  if(esArea) esArea.className = type==='es' ? 'fg' : 'fg hide';
  // 建立選項輸入框
  if(type==='mc'){
    const c = document.getElementById('opts-c');
    if(c){
      c.innerHTML = ['A','B','C','D','E'].map(k=>`
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <button class="btn ${(S.correct instanceof Set?S.correct.has(k):S.correct===k)?'bp':'bg'}" style="width:32px;flex-shrink:0;padding:6px"
            onclick="setAns('${k}')">${k}</button>
          <input id="opt-${k}" class="inp" style="flex:1" placeholder="選項 ${k}"
            value="${esc(opts?.[k]||'')}">
        </div>`).join('');
    }
  }
}

function setAns(k){
  // 多選 toggle：S.correct 改為 Set
  if(!(S.correct instanceof Set)) S.correct = new Set(S.correct ? [...S.correct] : []);
  if(S.correct.has(k)) S.correct.delete(k); else S.correct.add(k);
  // 全部取消時保持空白（原本自動補 'A'，會讓使用者以為答案是 A）
  ['A','B','C','D','E'].forEach(l=>{
    const btn = document.getElementById('opt-'+l)?.previousElementSibling;
    if(btn) btn.className = 'btn '+(S.correct.has(l)?'bp':'bg');
  });
}
function _getAnswerStr(){
  // ★ 不可 fallback 成 'A'：未選答案時應如實回傳空字串。
  //   原本寫 `return S.correct||'A'`，S.correct 為空/未初始化時會憑空產生
  //   一個 'A' 存進資料庫，把原本正確或空白的答案覆蓋掉。
  if(S.correct instanceof Set) return [...S.correct].sort().join('');
  return S.correct || '';
}

function toggleGroupStem(){
  const checked = document.getElementById('f-is-group')?.checked;
  const wrap = document.getElementById('f-group-wrap');
  if(wrap) wrap.classList.toggle('hide', !checked);
}

// 年度輸入正規化（onblur）：全形數字→半形、移除「年/民國」字樣與空白
// 例：「１１３年」→「113」、「民國113」→「113」
function formatYearInput(el){
  if(!el) return;
  let v=(el.value||'').trim();
  if(!v) return;
  // 全形數字轉半形
  v=v.replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));
  // 移除「民國」「年」與所有空白
  v=v.replace(/民國|年/g,'').replace(/\s+/g,'');
  el.value=v;
}

// ════════════════════════════════════════════════════════════
// 【題目儲存】
// ════════════════════════════════════════════════════════════
async function saveQ(){
  try{
  const stem=cleanSpaces(document.getElementById('f-stem').value.trim());
  if(!stem){toast('請填寫題目內容');return;}
  const type=S.qType;
  const options={};
  if(type==='mc'){
    ['A','B','C','D','E'].forEach(k=>{
      const v=cleanSpaces(document.getElementById('opt-'+k)?.value.trim()||'');
      if(v)options[k]=v;
    });
    if(Object.keys(options).length<2){toast('選擇題至少需要2個選項');return;}
    // 未選正確答案時提示（仍允許存檔，方便先建題目之後再補）。
    // 這種題目答題時不計入複習進度與統計，不會污染錯題分析。
    if(!_getAnswerStr()) toast('提醒：尚未選擇正確答案，此題不會計入複習進度');
  }
  const relStr=document.getElementById('f-laws')?.value.trim()||'';
  const relatedLaws=relStr?relStr.split(/[,，]/).map(s=>({ref:s.trim()})).filter(r=>r.ref):[];
  const mustStr=document.getElementById('f-must-kw')?.value.trim()||'';
  const mustKeywords=mustStr?mustStr.split(/[,，]/).map(s=>s.trim()).filter(Boolean):autoKeywords(stem);

  const data={
    type,stem,options,
    answer:type==='mc'?_getAnswerStr():'',
    answerEs:document.getElementById('f-es')?.value.trim()||'',
    subject:document.getElementById('f-sub').value.trim(),
    year:document.getElementById('f-yr').value.trim(),
    exam:document.getElementById('f-ex').value,
    num:document.getElementById('f-num').value.trim(),
    keywords:kwArr(document.getElementById('f-kw').value),
    mustKeywords,
    tags:[],
    note:document.getElementById('f-note').value.trim(),
    hlColor:document.querySelector('#f-mark-row .note-mark-dot.sel')?.dataset.color||'',
    isNumberQ:document.getElementById('f-is-number')?.checked||false,
    groupStem:(document.getElementById('f-is-group')?.checked && document.getElementById('f-group-stem')?.value.trim()) || '',
    groupId:(document.getElementById('f-is-group')?.checked && document.getElementById('f-group-id')?.value.trim()) || '',
    groupOrder:parseInt(document.getElementById('f-group-order')?.value)||0,
    relatedLaws,
    starred:false,createdAt:Date.now(),
    reviewLevel:0,nextReview:Date.now(),lastReview:null,
    wrongCount:0,correctStreak:0,difficultyScore:5
  };

  if(!S.editId){
    const dup=await checkDuplicate(data);
    if(dup){
      const action=await showDupDialog(data,dup);
      if(action==='skip'){closeAdd();return;}
      if(action==='replace'){data.id=dup.id;data.starred=dup.starred;data.createdAt=dup.createdAt;data.reviewLevel=dup.reviewLevel||0;}
    }
  } else {
    const ex=await dg('questions',S.editId);
    data.id=S.editId;
    data.starred=ex?.starred||false;
    data.createdAt=ex?.createdAt||Date.now();
    data.reviewLevel=ex?.reviewLevel||0;
    data.nextReview=ex?.nextReview||Date.now();
    data.wrongCount=ex?.wrongCount||0;
    // 編輯時若未勾選題組，保留原 groupId 讓使用者決定（不自動清空）
    data.correctStreak=ex?.correctStreak||0;
    data.difficultyScore=ex?.difficultyScore||5;
  }
  try{
    // 建立搜尋索引（加速搜尋）
    data.searchBlob=((data.stem||'')+' '+(data.groupStem||'')+' '+(data.subject||'')+' '+(data.year||'')+' '+(data.exam||'')+' '+(data.num||'')+' '+(data.keywords||[]).join(' ')).toLowerCase();
    await dp('questions',data);
    closeAdd();toast(S.editId?'題目已更新 ✓':'題目已儲存 ✓');
  }catch(e){
    logError('saveQ',e);
    toast('儲存失敗，請重試');
  }
  if(S.page==='list'){
    // 編輯後回到編輯前所在的層（第三層 → 回科目群組；否則回第一層）
    if(_qGroupYear && _qGroupSubject) openQGroup(_qGroupYear, _qGroupSubject, _qGroupExam);
    else renderList();
  } else renderHome();
  }catch(e){logError('saveQ',e);}}

async function editQ(id){  try{const q=await dg('questions',id);if(q)showAdd(q);  }catch(e){ logError('editQ',e); }}

// 儲存並連續新增：保留共用欄位，只清空題目內容與選項
async function saveQAndContinue(){  try{
  const stem=cleanSpaces(document.getElementById('f-stem').value.trim());
  if(!stem){toast('請填寫題目內容');return;}
  const type=S.qType;
  const options={};
  if(type==='mc'){
    ['A','B','C','D','E'].forEach(k=>{
      const v=cleanSpaces(document.getElementById('opt-'+k)?.value.trim()||'');
      if(v)options[k]=v;
    });
    if(Object.keys(options).length<2){toast('選擇題至少需要2個選項');return;}
    // 未選正確答案時提示（仍允許存檔，方便先建題目之後再補）。
    // 這種題目答題時不計入複習進度與統計，不會污染錯題分析。
    if(!_getAnswerStr()) toast('提醒：尚未選擇正確答案，此題不會計入複習進度');
  }
  const relStr=document.getElementById('f-laws')?.value.trim()||'';
  const relatedLaws=relStr?relStr.split(/[,，]/).map(s=>({ref:s.trim()})).filter(r=>r.ref):[];
  const mustStr=document.getElementById('f-must-kw')?.value.trim()||'';
  const mustKeywords=mustStr?mustStr.split(/[,，]/).map(s=>s.trim()).filter(Boolean):autoKeywords(stem);
  const isGroupChecked=document.getElementById('f-is-group')?.checked;
  const data={
    type,stem,options,
    answer:type==='mc'?_getAnswerStr():'',
    answerEs:document.getElementById('f-es')?.value.trim()||'',
    subject:document.getElementById('f-sub').value.trim(),
    year:document.getElementById('f-yr').value.trim(),
    exam:document.getElementById('f-ex').value,
    num:document.getElementById('f-num').value.trim(),
    note:document.getElementById('f-note').value.trim(),
    hlColor:document.querySelector('#f-mark-row .note-mark-dot.sel')?.dataset.color||'',
    isNumberQ:document.getElementById('f-is-number')?.checked||false,
    groupStem:(isGroupChecked&&document.getElementById('f-group-stem')?.value.trim())||'',
    groupId:(isGroupChecked&&document.getElementById('f-group-id')?.value.trim())||'',
    groupOrder:parseInt(document.getElementById('f-group-order')?.value)||0,
    relatedLaws,starred:false,createdAt:Date.now(),
    reviewLevel:0,nextReview:Date.now(),lastReview:null,
    wrongCount:0,correctStreak:0,difficultyScore:5
  };
  data.searchBlob=((data.stem||'')+' '+(data.groupStem||'')+' '+(data.subject||'')+' '+(data.year||'')+' '+(data.exam||'')+' '+(data.num||'')+' '+(data.keywords||[]).join(' ')).toLowerCase();
  await dp('questions',data);
  toast('已儲存 ✓ 繼續新增下一題');

  // 清空：題目內容、選項、正確答案、題號（題幹/題組/科目/年度等保留）
  const clr=(id)=>{ const el=document.getElementById(id); if(el) el.value=''; };
  clr('f-stem'); clr('f-es'); clr('f-num'); clr('f-note');
  ['A','B','C','D','E'].forEach(k=>clr('opt-'+k));
  S.correct=new Set(); S.editId=null;   // 不預設 A，避免誤以為已選答案
  // 更新選項 UI 選中狀態（全部取消選取）
  ['A','B','C','D','E'].forEach(l=>{
    const btn=document.getElementById('opt-'+l)?.previousElementSibling;
    if(btn) btn.className='btn '+(l==='A'?'bp':'bg');
  });
  // 題組序號自動遞增
  const orderEl=document.getElementById('f-group-order');
  if(orderEl && orderEl.value) orderEl.value=String((parseInt(orderEl.value)||0)+1);
  // 捲回頂部方便看到題幹
  document.getElementById('add-ov')?.querySelector('.sht')?.scrollIntoView({behavior:'smooth'});
}catch(e){logError('saveQAndContinue',e);toast('儲存失敗，請重試');}}
async function toggleStar(id){  try{
  const q=await dg('questions',id);if(!q)return;
  q.starred=!q.starred;await dp('questions',q);
  toast(q.starred?'已收藏 ⭐':'取消收藏');renderList();
  }catch(e){ logError('toggleStar',e); }}

// ── 題目選擇刪除模式 ──────────────────────────────────────────

// ════════════════════════════════════════════════════════════
// 【題庫批量勾選刪除】
// ════════════════════════════════════════════════════════════
function toggleListSelectMode(){
  _listSelMode = !_listSelMode;
  _listSelected.clear();
  const btn = document.getElementById('list-sel-btn');
  const bar = document.getElementById('list-sel-bar');
  if(btn){
    btn.style.background  = _listSelMode ? 'rgba(207,71,71,0.18)' : '';
    btn.style.borderColor = _listSelMode ? 'rgba(207,71,71,0.3)'  : '';
    btn.style.color       = _listSelMode ? '#e05c5c' : '';
  }
  if(bar) bar.style.display = _listSelMode ? 'flex' : 'none';
  _updateListSelCount();
  // 對當前畫面所有可勾選卡片套用/移除選擇模式 UI
  _applyListSelUI();
}

// 對畫面上所有 .qc[data-selkey] 卡片套用勾選 UI
function _applyListSelUI(){
  document.querySelectorAll('.qc[data-selkey]').forEach(card=>{
    const key = card.dataset.selkey; // 格式："yr:2024" 或 "sub:2024:刑法" 或 "qid:123"
    if(_listSelMode){
      if(!card.querySelector('.list-sel-chk')){
        const chk = document.createElement('span');
        chk.className='list-sel-chk';
        chk.textContent='☐';
        card.querySelector('.qch')?.prepend(chk);
      }
      card.style.cursor='pointer';
      card._origOnclick = card.onclick;
      card.onclick = e=>{
        if(e.target.closest('.qabn')) return;
        _toggleSelCard(key, card);
      };
    } else {
      card.querySelector('.list-sel-chk')?.remove();
      card.style.outline=''; card.style.background=''; card.style.cursor='';
      card.onclick = card._origOnclick||null;
      delete card._origOnclick;
    }
  });
}

// 切換一張卡片的勾選狀態（支援年度/科目/題目三種 key）
async function _toggleSelCard(key, card){
  // 解析 key 取得對應的題目 id 集合
  const getIds = async ()=>{
    const qs = await da('questions');
    if(key.startsWith('yr:')){
      const yr = key.slice(3);
      return qs.filter(q=>(q.year||'未知年度')===yr).map(q=>q.id);
    } else if(key.startsWith('sub:')){
      const [,yr,sub] = key.split(':');
      return qs.filter(q=>(q.year||'未知年度')===yr&&(q.subject||'未分類')===sub).map(q=>q.id);
    } else {
      return [+key.slice(4)]; // qid:123
    }
  };
  const ids = await getIds();
  const allSel = ids.every(id=>_listSelected.has(id));
  if(allSel){ ids.forEach(id=>_listSelected.delete(id)); }
  else       { ids.forEach(id=>_listSelected.add(id)); }
  // 更新這張卡片的外觀
  const nowSel = ids.every(id=>_listSelected.has(id));
  card.style.outline    = nowSel ? '2px solid var(--acc)' : '';
  card.style.background = nowSel ? 'rgba(88,166,255,0.08)' : '';
  const chk = card.querySelector('.list-sel-chk');
  if(chk) chk.textContent = nowSel ? '\u2611' : '\u2610';
  _updateListSelCount();
}

function _updateListSelCount(){
  const el = document.getElementById('list-sel-count');
  if(el) el.textContent = `已選 ${_listSelected.size} 題`;
}

// ── 批次修改（科目／年度／考試別）─────────────────────────
//   匯入後常需要整批修正分類，原本只能一題一題編輯。
//   只填想改的欄位，留空的欄位不動；searchBlob 會一併重建。
function openBatchEdit(){  try{
  if(!_listSelected.size){ toast('請先選取題目'); return; }
  const n = _listSelected.size;
  const ov = document.createElement('div');
  ov.className = 'ov on';
  ov.id = 'batch-edit-ov';
  ov.innerHTML =
    '<div class="sh" onclick="event.stopPropagation()" style="max-width:420px">'
    + '<div class="shdl"></div>'
    + '<div class="sht"><span>批次修改 ' + n + ' 題</span>'
    +   '<button class="hd-btn bg" onclick="document.getElementById(\'batch-edit-ov\').remove()">✕</button></div>'
    + '<div style="padding:4px 18px 20px">'
    +   '<div style="font-size:12px;color:var(--t2);line-height:1.7;margin-bottom:12px">'
    +     '只填要修改的欄位，<b>留空的欄位不會變動</b>。</div>'
    +   '<div class="fg"><label class="fl">科目</label>'
    +     '<input id="be-sub" list="be-subs" placeholder="不修改"><datalist id="be-subs"></datalist></div>'
    +   '<div class="fg"><label class="fl">年度</label>'
    +     '<input id="be-yr" placeholder="不修改（例：113）"></div>'
    +   '<div class="fg"><label class="fl">考試別</label>'
    +     '<select id="be-ex"><option value="">不修改</option>'
    +     ['警佐班','升官等','警大二技','三等考試','其他'].map(e=>'<option>'+e+'</option>').join('')
    +     '</select></div>'
    +   '<button class="btn bp bw" style="width:100%;padding:11px;font-size:14px;font-weight:600;margin-top:6px"'
    +     ' onclick="applyBatchEdit()">套用修改</button>'
    + '</div></div>';
  document.body.appendChild(ov);
  // 科目候選清單（沿用題庫既有科目，避免打錯字產生新分類）
  da('questions').then(qs=>{
    const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))].sort();
    const dl=document.getElementById('be-subs');
    if(dl) dl.innerHTML=subs.map(x=>'<option value="'+esc(x)+'">').join('');
  }).catch(()=>{});
  }catch(e){ logError('openBatchEdit', e); }}

async function applyBatchEdit(){  try{
  const sub = document.getElementById('be-sub')?.value.trim() || '';
  const yr  = document.getElementById('be-yr')?.value.trim()  || '';
  const ex  = document.getElementById('be-ex')?.value || '';
  if(!sub && !yr && !ex){ toast('請至少填寫一個要修改的欄位'); return; }

  const ids=[..._listSelected];
  let done=0;
  for(const id of ids){
    const q = await dg('questions', id);
    if(!q) continue;
    if(sub) q.subject = sub;
    if(yr)  q.year    = yr;
    if(ex)  q.exam    = ex;
    // 分類欄位是 searchBlob 的來源，改了就必須重建，否則搜尋結果會對不上
    q.searchBlob = ((q.stem||'')+' '+(q.groupStem||'')+' '+(q.subject||'')+' '+
                    (q.year||'')+' '+(q.exam||'')+' '+(q.num||'')+' '+
                    (q.keywords||[]).join(' ')).toLowerCase();
    await dp('questions', q);
    done++;
  }
  document.getElementById('batch-edit-ov')?.remove();
  toast('已修改 ' + done + ' 題');
  _listSelMode=false; _listSelected.clear();
  const bar=document.getElementById('list-sel-bar');
  if(bar) bar.style.display='none';
  renderList();
  }catch(e){ logError('applyBatchEdit', e); toast('修改失敗：'+e.message); }}

async function confirmListSelDel(){
  if(!_listSelected.size){ toast('請先選取題目'); return; }
  if(!confirm(`確定刪除選取的 ${_listSelected.size} 題？`)) return;
  const ids=[..._listSelected];
  for(const id of ids) await dd('questions',id);
  toast(`已刪除 ${ids.length} 題`);
  _listSelMode=false; _listSelected.clear();
  const btn=document.getElementById('list-sel-btn');
  const bar=document.getElementById('list-sel-bar');
  if(btn){btn.style.background='';btn.style.borderColor='';btn.style.color='';}
  if(bar) bar.style.display='none';
  renderList();
}

async function openBulkDelQ(){  try{
  const qs=await da('questions');
  if(!qs.length){toast('目前無題目');return;}
  const years=[...new Set(qs.map(q=>q.year||'').filter(Boolean))].sort().reverse();
  const exams=[...new Set(qs.map(q=>q.exam||'').filter(Boolean))].sort();
  const subs=[...new Set(qs.map(q=>q.subject||'').filter(Boolean))].sort();
  const modal=document.createElement('div');
  modal.id='bulk-del-q-modal';
  modal.className='bulk-sel-ov';
  modal.innerHTML=`<div class="bulk-sel-panel"><div class="bulk-sel-handle"></div><div class="bulk-sel-title">☑ 依條件選取題目</div><div class="bulk-sel-desc">依條件自動勾選，套用後可在列表再調整，最後按「刪除選取」。</div><div class="bulk-sel-fields"><div><label class="fl">年度</label><input id="bdq-year" list="bdq-yl" placeholder="例：113（留空不限）"><datalist id="bdq-yl">${years.map(y=>`<option value="${y}">`).join('')}</datalist></div><div><label class="fl">考試別</label><input id="bdq-exam" list="bdq-el" placeholder="例：升官等（留空不限）"><datalist id="bdq-el">${exams.map(e=>`<option value="${e}">`).join('')}</datalist></div><div><label class="fl">科目</label><input id="bdq-sub" list="bdq-sl" placeholder="例：警察法規（留空不限）"><datalist id="bdq-sl">${subs.map(s=>`<option value="${s}">`).join('')}</datalist></div><div><label class="fl">指定題號（逗號分隔，留空選取所有符合條件）</label><input id="bdq-nums" placeholder="例：1,2,5,10"></div></div><div id="bdq-preview" class="bulk-sel-preview"></div><div class="bulk-sel-acts"><button class="btn bg" onclick="document.getElementById('bulk-del-q-modal').remove()">取消</button><button class="btn bg dim" onclick="previewBulkDelQ()">預覽</button><button class="btn bp" onclick="applyBulkSelectQ()">套用選取</button></div></div>`;
  document.body.appendChild(modal);
  }catch(e){ logError('openBulkDelQ',e); }}

async function previewBulkDelQ(){  try{
  const targets=_filterBulkDelQ(await da('questions'));
  const el=document.getElementById('bdq-preview');
  if(el) el.innerHTML='<span style="color:var(--acc)">符合條件：<b>'+targets.length+'</b> 題將被勾選</span>';
  }catch(e){ logError('previewBulkDelQ',e); }}

// 依條件自動勾選：把符合的題目加入選取集合，進入勾選模式供檢視後刪除
async function applyBulkSelectQ(){  try{
  const targets=_filterBulkDelQ(await da('questions'));
  if(!targets.length){toast('無符合條件的題目');return;}
  // 確保處於勾選模式
  if(!_listSelMode) toggleListSelectMode();
  targets.forEach(q=>_listSelected.add(q.id));
  const m=document.getElementById('bulk-del-q-modal');if(m)m.remove();
  _updateListSelCount();
  _applyListSelUI();
  toast('已勾選 '+targets.length+' 題，確認後按「刪除選取」');
  }catch(e){ logError('applyBulkSelectQ',e); }}

function _filterBulkDelQ(qs){
  const yr =(document.getElementById('bdq-year')||{}).value?.trim()||'';
  const ex =(document.getElementById('bdq-exam')||{}).value?.trim()||'';
  const sub=(document.getElementById('bdq-sub') ||{}).value?.trim()||'';
  const nums=(document.getElementById('bdq-nums')||{}).value?.trim()||'';
  const numSet=nums?new Set(nums.split(/[,，、\s]+/).map(n=>n.trim()).filter(Boolean)):null;
  return qs.filter(q=>{
    if(yr  &&(q.year   ||'')!==yr ) return false;
    if(ex  &&(q.exam   ||'')!==ex ) return false;
    if(sub &&(q.subject||'')!==sub) return false;
    if(numSet&&!numSet.has(String(q.num||''))) return false;
    return true;
  });
}

async function openBulkDelLaw(){  try{
  const laws=await da('laws');
  if(!laws.length){toast('目前無法條');return;}
  const names=[...new Set(laws.map(l=>l.lawName||'').filter(Boolean))].sort();
  const modal=document.createElement('div');
  modal.id='bulk-del-law-modal';
  modal.className='bulk-sel-ov';
  modal.innerHTML=`<div class="bulk-sel-panel"><div class="bulk-sel-handle"></div><div class="bulk-sel-title">☑ 依條件選取法規</div><div class="bulk-sel-desc">選擇法律名稱自動勾選整部法規，套用後可再調整，最後按「刪除選取」。</div><div class="bulk-sel-fields"><div><label class="fl">法律名稱</label><input id="bdl-name" list="bdl-nl" placeholder="例：警察職權行使法"><datalist id="bdl-nl">${names.map(n=>`<option value="${n}">`).join('')}</datalist></div></div><div id="bdl-preview" class="bulk-sel-preview"></div><div class="bulk-sel-acts"><button class="btn bg" onclick="document.getElementById('bulk-del-law-modal').remove()">取消</button><button class="btn bg dim" onclick="previewBulkDelLaw()">預覽</button><button class="btn bp" onclick="applyBulkSelectLaw()">套用選取</button></div></div>`;
  document.body.appendChild(modal);
  }catch(e){ logError('openBulkDelLaw',e); }}

async function previewBulkDelLaw(){  try{
  const name=(document.getElementById('bdl-name')||{}).value?.trim()||'';
  const laws=await da('laws');
  const matched=name?laws.filter(l=>(l.lawName||'')===name):laws;
  const lawNames=[...new Set(matched.map(l=>l.lawName||'').filter(Boolean))];
  const el=document.getElementById('bdl-preview');
  if(el) el.innerHTML='<span style="color:var(--acc)">符合：<b>'+lawNames.length+'</b> 部法規（共 '+matched.length+' 條）將被勾選</span>';
  }catch(e){ logError('previewBulkDelLaw',e); }}

// 依法律名稱自動勾選整部法規，進入勾選模式供檢視後刪除
async function applyBulkSelectLaw(){  try{
  const name=(document.getElementById('bdl-name')||{}).value?.trim()||'';
  const laws=await da('laws');
  const lawNames=name
    ? [...new Set(laws.filter(l=>(l.lawName||'')===name).map(l=>l.lawName))]
    : [...new Set(laws.map(l=>l.lawName||'').filter(Boolean))];
  if(!lawNames.length){toast('無符合條件的法規');return;}
  // 確保處於勾選模式
  if(!_dbSelMode) toggleDbSelectMode();
  lawNames.forEach(n=>_dbSelected.add(n));
  const m=document.getElementById('bulk-del-law-modal');if(m)m.remove();
  _updateDbSelCount();
  renderDB();  // 重繪卡片以顯示勾選狀態
  toast('已勾選 '+lawNames.length+' 部法規，確認後按「刪除選取」');
  }catch(e){ logError('applyBulkSelectLaw',e); }}

async function checkDuplicate(data){  try{
  const qs=await da('questions');
  const stem30=(data.stem||'').slice(0,30);
  return qs.find(q=>
    q.id!==data.id&&(
      (q.subject===data.subject&&q.year===data.year&&q.num&&data.num&&q.num===data.num)||
      ((q.stem||'').slice(0,30)===stem30&&stem30.length>5)
    )
  )||null;
  }catch(e){ logError('checkDuplicate',e); }}

function showDupDialog(newData,existing){
  return new Promise(res=>{
    _dupResolve=res;
    const diff='【現有題目】\n'+( existing.stem||'').slice(0,60)+'…\n\n【新題目】\n'+(newData.stem||'').slice(0,60)+'…';
    document.getElementById('dup-diff').textContent=diff;
    document.getElementById('dup-ov').style.display='flex';
  });
}
function dupAction(action){
  document.getElementById('dup-ov').style.display='none';
  if(_dupResolve){_dupResolve(action);_dupResolve=null;}
}

async function startSingleQ(el){  try{
  const qid=parseInt(el.dataset.qid);
  const q=await dg('questions',qid);
  if(!q){toast('找不到題目');return;}
  startQWithPool([q],'single');
  }catch(e){ logError('startSingleQ',e); }}


// ══ laws.js — 資料庫（法條）管理 ══════════════════════════════
// 依賴：db.js, utils.js, parser.js

// 法規排序狀態（key → 'name'|'amend'|'count'，dir → 1 升/-1 降）


function openLawSortMenu(btn){
  const menu = document.getElementById('law-sort-menu');
  const popup = document.getElementById('law-sort-popup');
  if(!menu||!popup) return;
  // 定位在按鈕正下方
  const r = btn.getBoundingClientRect();
  popup.style.top  = (r.bottom + 6) + 'px';
  popup.style.right = (window.innerWidth - r.right) + 'px';
  popup.style.left  = 'auto';
  menu.style.display = 'block';
  popup.style.display = 'block';
}
function closeLawSortMenu(){
  document.getElementById('law-sort-menu').style.display='none';
  document.getElementById('law-sort-popup').style.display='none';
}
function pickLawSort(key){
  if(_lawSortState.key === key){
    // 同一個 → 切換方向
    _lawSortState.dir *= -1;
  } else {
    _lawSortState.key = key;
    _lawSortState.dir = 1;
  }
  // 更新選單視覺
  ['name','amend','count'].forEach(k=>{
    const el = document.getElementById('lsp-'+k);
    if(!el) return;
    const isOn = k === _lawSortState.key;
    el.classList.toggle('lsp-on', isOn);
    el.querySelector('.lsp-arrow').textContent = isOn ? '✓' : '';
  });
  // 更新排序按鈕標籤
  const label = {name:'名稱',amend:'修正日期',count:'條數'}[_lawSortState.key];
  const sortBtn = document.getElementById('law-sort-btn');
  if(sortBtn) sortBtn.textContent = label;
  closeLawSortMenu();
  // 同步舊的 S.lawSort 讓 renderDB 可用
  S.lawSort = _lawSortState.key;
  renderDB();
}
// 保留舊 toggleLawSort 防外部殘留呼叫
function toggleLawSort(){ openLawSortMenu(document.getElementById('law-sort-btn')); }

// ── 資料庫選擇刪除模式 ──────────────────────────────────────

function toggleDbSelectMode(){
  _dbSelMode = !_dbSelMode;
  _dbSelected.clear();
  const btn    = document.getElementById('db-sel-btn');
  const bar    = document.getElementById('db-sel-bar');
  const addBtn = document.getElementById('add-law-btn');
  const sortBtn= document.getElementById('law-sort-btn');
  if(btn){
    btn.style.background = _dbSelMode ? 'var(--red2)' : '';
    btn.style.borderColor= _dbSelMode ? 'var(--red)' : '';
  }
  if(bar)  bar.style.display = _dbSelMode ? 'flex' : 'none';
  const addWrap = document.getElementById('add-law-wrap');
  if(addWrap) addWrap.style.display = _dbSelMode ? 'none' : '';
  if(sortBtn) sortBtn.style.display = _dbSelMode ? 'none' : '';
  _updateDbSelCount();
  renderDB();
}

function _updateDbSelCount(){
  const el = document.getElementById('db-sel-count');
  if(el) el.textContent = `已選 ${_dbSelected.size} 筆法規`;
}

function _toggleDbCard(lawName){
  if(_dbSelected.has(lawName)) _dbSelected.delete(lawName);
  else _dbSelected.add(lawName);
  _updateDbSelCount();
  // 更新卡片的選取外觀
  document.querySelectorAll('.lw-card[data-lawname]').forEach(c=>{
    if(c.dataset.lawname === lawName){
      c.style.outline = _dbSelected.has(lawName) ? '2px solid var(--acc)' : '';
      c.style.background = _dbSelected.has(lawName) ? 'rgba(88,166,255,0.08)' : '';
      const chk = c.querySelector('.db-sel-chk');
      if(chk) chk.textContent = _dbSelected.has(lawName) ? '☑' : '☐';
    }
  });
}

async function confirmDbSelDel(){
  if(!_dbSelected.size){ toast('請先選取法規'); return; }
  if(!confirm(`確定刪除選取的 ${_dbSelected.size} 筆法規（含所有條文）？`)) return;
  const all = await da('laws');
  const toDelete = all.filter(l => _dbSelected.has(l.lawName));
  for(const l of toDelete){ await dd('laws', l.id); }
  toast(`已刪除 ${_dbSelected.size} 筆法規`);
  toggleDbSelectMode();
  renderDB();
}

function setLC(el, cat){
  document.querySelectorAll('#lchips .chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');
  S.lawCat = cat;
  renderDB();
}


// ── 搜尋範圍（由搜尋框旁的下拉選單決定）───────────────────
//   預設比對全欄位，資料一多就太雜；選定範圍後只比對該欄位。
function _fieldValue(l, f){
  if(f === 'keywords') return (l.keywords||[]).join(' ');
  if(f === 'content')  return (l.content||'').startsWith('data:') ? '' : (l.content||'');
  return l[f] || '';
}

// 法規層級資訊（制定機關、修正日期）存在每一條條文上。
// 取該法規「第一個有值」的條文，而不是固定取第 0 條：
// 舊資料可能有部分條文是空的（先前編輯單條會把這兩欄清空），固定取第 0 條就會顯示不出來。
function _lawInfo(laws){
  const pick = f => ((laws||[]).find(l => l && l[f]) || {})[f] || '';
  return { org: pick('org'), amendDate: pick('amendDate') };
}

async function renderDB(){  try{
  const ls=await da('laws');
  _setLawNames(ls);   // 供 _autoCites 比對用（列表頁也要顯示自動連結）
  const kw=(document.getElementById('lsi')?.value||'').toLowerCase().trim();
  const kwField=document.getElementById('lsf')?.value||'all';   // 搜尋範圍
  let kwLaw='', kwArtNum=0, kwText=kw;
  // 「法規名§條號」精準搜尋（規則見 parseSecSearch，與 openLawGroup 共用同一套）
  const _sec = parseSecSearch(kw);
  if(_sec){ kwLaw = _sec.lawName; kwArtNum = _sec.artNum; kwText = ''; }

  let fl=ls.filter(l=>{
    if(S.lawCat!=='all'&&l.category!==S.lawCat)return false;
    if(!kw) return true;
    if(kwArtNum){
      const nameMatch = !kwLaw || (l.lawName||'').toLowerCase().includes(kwLaw);
      const artMatch  = (l.articleNumber || art2n(l.article||'')) === kwArtNum;
      return nameMatch && artMatch;
    }
    // 選定範圍 → 只比對該欄位；選「全部」→ 維持原本全欄位比對
    if(kwField !== 'all') return _fieldValue(l, kwField).toLowerCase().includes(kwText);
    // searchBlob 優先（純文字），沒有才 fallback（排除 base64 避免拖慢）
    const _c = (l.content||'').startsWith('data:') ? '' : (l.content||'');
    const h = (l.searchBlob || ((l.lawName||'')+(l.article||'')+(l.title||'')+(l.keywords||[]).join(' ')+_c)).toLowerCase();
    return h.includes(kwText);
  });

  const el=document.getElementById('llist');
  if(!fl.length){el.innerHTML='<div class="empty"><span class="ic">🗄</span><span>尚無資料</span></div>';return;}

  // 有關鍵字：直接顯示匹配的條文（不分組）
  if(kw){
    el.innerHTML='';
    fl.forEach(l=>{
      const isImg = (l.content||'').startsWith('data:');
      const preview = isImg ? '🖼 圖片內容' : esc((l.content||'').slice(0,80));
      const div=document.createElement('div');
      div.className='card law-search-card';
      div.innerHTML=
        '<div class="law-search-lawname">'+esc(l.lawName||'')+'</div>'+
        '<div class="law-search-article">'+esc(l.article||'')+(l.title?' <span class="law-search-title">'+esc(l.title)+'</span>':'')+' </div>'+
        '<div class="law-search-preview">'+preview+'</div>';
      div.onclick=()=>openLawGroup(l.lawName);
      el.appendChild(div);
    });
    return;
  }

  // 無關鍵字：依法規名稱分組顯示
  const byName={};
  fl.forEach(l=>{const n=l.lawName||'未分類';if(!byName[n])byName[n]=[];byName[n].push(l);});

  const sortedEntries=Object.entries(byName).sort((a,b)=>{
    const sortBy=S.lawSort||'name';
    const dir=_lawSortState.dir||1;
    if(sortBy==='amend'){
      const toDate=s=>{
        if(!s)return '';
        const rocM=s.match(/民國(\d+)年(\d+)月(\d+)日/);
        if(rocM)return String(parseInt(rocM[1])+1911)+'-'+rocM[2].padStart(2,'0')+'-'+rocM[3].padStart(2,'0');
        return s;
      };
      const _da=toDate(_lawInfo(a[1]).amendDate)||'0000';
      const _db=toDate(_lawInfo(b[1]).amendDate)||'0000';
      return dir * _db.localeCompare(_da);
    }
    if(sortBy==='count') return dir * (b[1].length-a[1].length);
    return dir * a[0].localeCompare(b[0],'zh-TW');
  });

  // ── Infinite Scroll 分頁（每批 50 個法律群組）──────────────
  const PAGE = 50;
  let page = 0;
  el.innerHTML = '';

  const _mkCard = ([name, laws]) => {
    const cat=laws[0].category||'statute';
    const catLabel={'statute':'法規條文','sop':'SOP','supplement':'補充資料','interpretation':'函釋'}[cat]||cat;
    const favCount=laws.filter(l=>l.favorite).length;
    const icon=cat==='sop'?'📋':cat==='supplement'?'📄':'⚖';
    const _li=_lawInfo(laws);
    const orgLine=(_li.org||_li.amendDate)
      ?('<div style="font-size:10px;color:var(--t2);margin-top:1px">'
        +(_li.org?'🏛 '+esc(_li.org):'')
        +(_li.org&&_li.amendDate?' · ':'')
        +(_li.amendDate?'📅 '+esc(_li.amendDate):'')
        +'</div>')
      :'';
    const div = document.createElement('div');
    div.className='lw-card card';
    div.dataset.lawname=name;
    div.style.marginBottom='6px';
    div.innerHTML=
      '<div style="display:flex;align-items:center;gap:8px">'
        +(_dbSelMode?'<span class="db-sel-chk" style="font-size:18px;color:var(--acc)">'+(_dbSelected.has(name)?'\u2611':'\u2610')+'</span>':'')
        +'<span style="font-size:20px">'+icon+'</span>'
        +'<div style="flex:1">'
          +'<div style="font-size:15px;font-weight:700;color:var(--t0)">'+esc(name)+'</div>'
          +'<div style="font-size:11px;color:var(--t2);margin-top:2px">'+catLabel+' · '+laws.length+' 條'+(favCount?' · ⭐'+favCount:'')+'</div>'
          +orgLine
          // 官網鈕放左側資訊區，與右側刪除鈕拉開距離，避免誤觸不可逆的刪除
          +'<button class="lw-gov" data-lawname="'+esc(name)+'" title="查全國法規資料庫原文">'
            +'🏛 官網原文</button>'
        +'</div>'
        +'<span style="color:var(--t2);font-size:18px;margin-left:2px">›</span>'
        +'<button class="lw-del" data-lawname="'+esc(name)+'" style="background:var(--red2);color:var(--red);border:1px solid var(--red);border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer;flex-shrink:0">🗑</button>'
      +'</div>';
    div.addEventListener('click',function(e){
      // 卡片內的功能鈕各自處理，不要一併觸發「進入法規」
      if(e.target.closest('.lw-del, .lw-gov')) return;
      if(_dbSelMode){ e.stopPropagation(); _toggleDbCard(this.dataset.lawname); return; }
      openLawGroup(this.dataset.lawname);
    });
    div.querySelector('.lw-del').addEventListener('click',function(e){
      e.stopPropagation();
      delLawGroup(this.dataset.lawname);
    });
    // 查官網：整部法規（第一層不需要條號），阻止冒泡避免同時進入法規
    div.querySelector('.lw-gov')?.addEventListener('click',function(e){
      e.stopPropagation();
      openOfficialLaw(this.dataset.lawname, '');
    });
    return div;
  };

  const loadMore = () => {
    const batch = sortedEntries.slice(page*PAGE, (page+1)*PAGE);
    if(!batch.length) return;
    batch.forEach(entry => el.appendChild(_mkCard(entry)));
    page++;
    // 顯示計數
    const total = sortedEntries.length;
    const shown = Math.min(page*PAGE, total);
    const lc = document.getElementById('db-lc');
    if(lc) lc.textContent = shown < total ? `顯示 ${shown} / ${total} 筆，繼續滑動載入` : `共 ${total} 筆`;
  };

  loadMore();

  // 移除舊 scroll 監聽
  const pg = document.getElementById('pg-db');
  const scroller = pg?.querySelector('.page') || pg;
  if(scroller){
    const old = scroller._dbScroll;
    if(old) scroller.removeEventListener('scroll', old);
    const onScroll = () => {
      if(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 150){
        loadMore();
      }
    };
    scroller._dbScroll = onScroll;
    scroller.addEventListener('scroll', onScroll, {passive:true});
  }

  }catch(e){ logError('renderDB',e); }}



// LEVEL_STYLE 移至頂部宣告

// ── 一鍵連到全國法規資料庫 ─────────────────────────────────
//   官方網址格式：
//     單條 https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=XXX&flno=N
//     全部 https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=XXX
//   pcode 是每部法規的固定代碼，只收「已查證」的，避免猜錯代碼跳到別部法。
//   表內沒有的法規一律走站內搜尋，寧可多一步也不要跳錯。
const _LAW_PCODE = {
  // 憲法・行政法
  '中華民國憲法':'A0000001', '憲法':'A0000001', '中華民國憲法增修條文':'A0000002', '憲法增修條文':'A0000002',
  '行政程序法':'A0030055', '行政罰法':'A0030210', '行政執行法':'A0030023',
  '訴願法':'A0030020', '行政訴訟法':'A0030154', '國家賠償法':'I0020004',
  '公務員服務法':'S0020038', '公務員懲戒法':'A0030155', '個人資料保護法':'I0050021',
  // 警察法規
  '警察職權行使法':'D0080145', '警察法':'D0080001', '警察法施行細則':'D0080002',
  '警察勤務條例':'D0080026', '警械使用條例':'D0080042', '警察人員人事條例':'S0020005',
  '警察遴選第三人蒐集資料辦法':'D0080146', '警察勤務區訪查辦法':'D0080161',
  '社會秩序維護法':'D0080067', '集會遊行法':'D0080058', '特種勤務條例':'A0030246',
  '入出國及移民法':'D0080132', '道路交通管理處罰條例':'K0040012',
  '家庭暴力防治法':'D0050071', '性騷擾防治法':'D0050074', '跟蹤騷擾防制法':'D0080211',
  '兒童及少年福利與權益保障法':'D0050001',
  // 刑事法
  '中華民國刑法':'C0000001', '刑法':'C0000001', '中華民國刑法施行法':'C0000002', '刑法施行法':'C0000002',
  '刑事訴訟法':'C0010001', '少年事件處理法':'C0010011', '毒品危害防制條例':'C0000008',
  '槍砲彈藥刀械管制條例':'D0080047', '組織犯罪防制條例':'C0000013', '通訊保障及監察法':'K0060044',
  // 民事
  '民法':'B0000001', '民事訴訟法':'B0010001',
};
// 使用者自備代碼：法規的「來源」或「備註」欄若貼了官網網址（含 pcode=），
// 就以它為準。表內沒有的法規，貼一次網址之後就能直接開到原文。
let _lawPcodeFromData = {};
function _collectLawPcodes(allLaws){
  const map = {};
  for(const l of (allLaws||[])){
    // 與 _officialLawUrl 相同的正規化（全形轉半形、去空白），否則名稱含空白時查不到
    const name = String(l.lawName||'').normalize('NFKC').replace(/\s+/g,'');
    if(!name || map[name]) continue;
    const m = ((l.source||'') + ' ' + (l.note||'')).match(/pcode=([A-Za-z]\d{7})/i);
    if(m) map[name] = m[1].toUpperCase();
  }
  _lawPcodeFromData = map;
}
function _officialLawUrl(lawName, article){
  const name = String(lawName||'').normalize('NFKC').replace(/\s+/g,'');
  if(!name) return '';
  const pcode = _lawPcodeFromData[name] || _LAW_PCODE[name];
  if(!pcode){
    // 查不到代碼 → 走官網自己的搜尋結果頁（不經 Google）
    return 'https://law.moj.gov.tw/Law/LawSearchResult.aspx?ty=LAW&kw=' +
           encodeURIComponent(name);
  }
  // 官網單條網址 flno 可用「7-1」表示第7條之1
  const n = art2n(article||'');
  const flno = n ? Math.floor(n/1000) + (n%1000 ? '-' + (n%1000) : '') : '';
  return flno
    ? 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=' + pcode + '&flno=' + flno
    : 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=' + pcode;
}
function openOfficialLaw(lawName, article){
  const url = _officialLawUrl(lawName, article);
  if(!url){ toast('無法組出官網網址'); return; }
  window.open(url, '_blank', 'noopener');
}

// ── 從條文內文自動擷取引用（零輸入）───────────────────────
//   法條原文本就寫明引用關係，例如
//   「本辦法依警察職權行使法第十二條第四項規定訂定之」。
//   ★做法：不用正則猜法規名的邊界，而是拿「資料庫裡實際存在的法規名」
//     去比對「第X條」前面的文字。這樣完全不必處理「及／或／、」——
//     「兒童及少年福利與權益保障法」本身就是一個已知名稱，不會被切斷。
//     另一個好處：只會連到你真的有的法規，點了必定有東西看。
const _ART_RE = /第([一二三四五六七八九十百千\d]+)條(?:之([一二三四五六七八九十\d]+))?/g;
let _lawNameCache = null;        // 依長度排序的法規名（長名優先，避免短名先命中）
function _setLawNames(allLaws){
  _collectLawPcodes(allLaws);
  _lawNameCache = [...new Set((allLaws||[]).map(l=>(l.lawName||'').trim()).filter(Boolean))]
                    .sort((a,b)=>b.length-a.length);
}
function _autoCites(text){
  if(!text || text.startsWith('data:') || !_lawNameCache) return [];
  const out = [];
  for(const m of String(text).matchAll(_ART_RE)){
    // 法規名與「第X條」之間常夾括號註解，例如
    //   「本辦法依警察職權行使法（以下簡稱本法）第十二條第四項…」
    // 先把結尾的括號註解剝掉，否則 endsWith 永遠比不到法規名。
    let before = text.slice(Math.max(0, m.index - 40), m.index);
    let prevB;
    do{ prevB = before;
        before = before.replace(/[（(][^）)]*[）)]\s*$/, '');
    }while(before !== prevB);
    for(const name of _lawNameCache){
      if(before.endsWith(name)){
        out.push(name + '第' + m[1] + '條' + (m[2] ? '之' + m[2] : ''));
        break;                    // 長名優先，命中即停
      }
    }
  }
  return [...new Set(out)];
}

// ── 反向連結（被哪些法條引用）───────────────────────────────
//   設計取捨：不另外儲存反向關係，而是顯示時即時推導。
//   理由：①不用重複輸入（在 A 填了關聯 B，B 自動看得到 A）
//         ②不會有「改了一邊忘了另一邊」的同步問題
//         ③既有資料立刻生效，不需要重跑轉檔
//   比對規則與 showLawPop 一致：先用 art2n 比對條號，
//   沒有條號時才退回法規名稱比對，避免「§12」誤匹配到「§120」。
function _findBacklinks(target, allLaws){
  const tName = (target.lawName||'').trim();
  const tNum  = target.articleNumber || art2n(target.article||'');
  if(!tName) return [];
  const out = [];
  for(const l of allLaws){
    if(l.id === target.id) continue;
    // 手動填的關聯 ＋ 從內文自動擷取的引用，兩者都算
    const refs = [...(l.relatedLaws||[]).map(r=>r.ref||r.lawName||''),
                  ..._autoCites(l.content||'')];
    for(const raw of refs){
      let ref = (raw||'').trim();
      if(!ref) continue;
      // §簡寫正規化後再比對（與 showLawPop 同一套規則）
      ref = ref.replace(_SEC_RE, (_, m2, sub)=>_secToArticle(m2, sub));
      if(!ref.includes(tName)) continue;
      const rNum = art2n(ref);
      // 引用有指定條號 → 必須條號相符
      if(rNum && tNum && rNum !== tNum) continue;
      // ★ 沒指定條號（指向整部法規）時，只掛在該法的「第1條」。
      //   法制邏輯：母法只會有一條授權「由某機關定之」，子法也只會在第1條
      //   載明授權依據；若每一條都顯示同一個關聯，既不合邏輯也是雜訊。
      if(!rNum && tNum && tNum >= 2000) continue;
      out.push({ law: l, whole: !rNum });
      break;
    }
  }
  return out.sort((a,b)=>
    (a.law.lawName||'').localeCompare(b.law.lawName||'','zh-TW') ||
    ((a.law.articleNumber||0) - (b.law.articleNumber||0)));
}

async function openLawGroup(lawName){  try{
  if(!document.getElementById('lv')){ return; }  // 防衛：lv 元素不存在時不執行
  const allLaws=await da('laws');
  _setLawNames(allLaws);   // 供 _autoCites 比對用
  const _kw=(document.getElementById('lsi')?.value||'').toLowerCase().trim();
  // §N 精確搜尋
  // §搜尋：與 renderDB 共用 parseSecSearch，確保兩邊規則永遠一致
  let _kwLaw2='',_kwArtNum2=0,_kwText2=_kw;
  const _sec2 = parseSecSearch(_kw);
  if(_sec2){ _kwLaw2 = _sec2.lawName; _kwArtNum2 = _sec2.artNum; _kwText2 = ''; }
  // ── 排序：純依條號遞增（法律的本質順序）──
  // 法律條文本就是第1條、第2條…依序排列，編章節只是標記，不影響條文順序。
  // 章節標題的「不重複」由渲染層的已渲染集合(_shownC 等)保證，
  // 因此這裡只需單純依條號排序，即免疫於 part/章標記不一致的舊資料。
  // 無條號者（SOP）以 id 維持輸入順序。
  const laws=allLaws.filter(l=>{
    if(l.lawName!==lawName) return false;
    if(!_kw) return true;
    if(_kwArtNum2){
      return (l.articleNumber || art2n(l.article||'')) === _kwArtNum2;
    }
    // ★ 必須與 renderDB 的搜尋採同一套比對來源（searchBlob 優先）。
    //   原本只比對 article+title+content，但圖片類法條（SOP／補充資料／函釋）
    //   的 content 是 base64，searchBlob 刻意排除它而改收 lawName/keywords；
    //   於是「搜尋找得到、點進去卻篩成 0 筆」→ 下方 if(!laws.length) return
    //   直接返回，畫面完全沒反應。
    const _c = (l.content||'').startsWith('data:') ? '' : (l.content||'');
    const h = (l.searchBlob ||
               ((l.lawName||'')+(l.article||'')+(l.title||'')+
                (l.keywords||[]).join(' ')+_c)).toLowerCase();
    return h.includes(_kwText2);
  }).sort((a,b)=>{
    const na=(a.articleNumber||art2n(a.article||''))||0;
    const nb=(b.articleNumber||art2n(b.article||''))||0;
    if(na!==nb) return na-nb;
    return (a.id||0)-(b.id||0); // 同條號(或都無條號)：依輸入順序
  });
  if(!laws.length){
    // 保底：關鍵字在此法規內篩不到任何條文時，改為顯示整部法規，
    // 而不是無聲返回讓使用者以為當掉（這是先前圖片類法條點不進去的表徵）。
    const all = allLaws.filter(l=>l.lawName===lawName)
                       .sort((a,b)=>((a.articleNumber||art2n(a.article||''))||0)
                                   -((b.articleNumber||art2n(b.article||''))||0)
                                   || (a.id||0)-(b.id||0));
    if(!all.length){ toast('查無「'+lawName+'」的條文'); return; }
    laws.push(...all);
  }
  const others=[...new Set(allLaws.map(l=>l.lawName).filter(Boolean))].filter(n=>n!==lawName).slice(0,8);
  const cat=laws[0].category||'statute';
  const icon=cat==='sop'?'📋':cat==='supplement'?'📄':'⚖';
  const lvName=document.getElementById('lv-name'); if(lvName) lvName.textContent=icon+' '+lawName;
  // 顯示法規機關/日期資訊
  const lvInfo=document.getElementById('lv-info');
  if(lvInfo){
    const s=_lawInfo(laws);
    lvInfo.textContent=(s.org?'🏛 '+s.org:'')+(s.org&&s.amendDate?' · ':'')+(s.amendDate?'📅 '+s.amendDate:'');
    lvInfo.style.display=(s.org||s.amendDate)?'block':'none';
  }
  // 收藏狀態同步到 ⋮ 選單的收藏按鈕
  const favN=laws.filter(l=>l.favorite).length;
  const starItem=document.getElementById('lv-star-item');
  if(starItem) starItem.textContent=favN?'★ 已收藏':'☆ 收藏';
  const jumpHtml=others.map(n=>'<button class="chip" style="flex-shrink:0;font-size:11px" onclick="openLawGroup(\''+esc(n)+'\')">'+esc(n)+'</button>').join('');

  // ── 三層分組（編 > 章 > 節）────────────────────────────────
  const parts    = [...new Set(laws.map(l=>l.part   ||''))];
  const chapters = [...new Set(laws.map(l=>l.chapter||''))];
  const sections = [...new Set(laws.map(l=>l.section||''))];

  const renderArtCard = (l) => {
    const isImg=l.content&&l.content.startsWith('data:image');
    // 關鍵字反白（搜尋時高亮）
    const _hlKw=(document.getElementById('lsi')?.value||'').trim();
    const _hlRe=_hlKw&&!_hlKw.includes('§')?new RegExp('('+_hlKw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'):null;
    // _hl：esc → 插 mark → 換行（三合一，避免二次轉義）
    const _hl=(text)=>{
      const escaped=esc(text||'');
      if(!_hlRe) return escaped.replace(/\n/g,'<br>');
      return escaped
        .replace(_hlRe,(m)=>'<mark style="background:#d4a438;color:#121212;border-radius:2px;padding:0 2px">'+m+'</mark>')
        .replace(/\n/g,'<br>');
    };
    const contentHtml=isImg?'<img src="'+l.content+'" style="max-width:100%;border-radius:8px;cursor:zoom-in" onclick="openImgViewer(this.src)" title="點擊放大">':_hl(l.content||'');
    const kwHtml=(l.keywords||[]).length?'<div style="margin-top:8px">'+l.keywords.map(k=>'<span class="tag">'+esc(k)+'</span>').join('')+'</div>':'';
    // 正向關聯 = 手動填的 ＋ 從本條內文自動擷取的（去重）
    // 關聯法條 = 手動填的 ＋ 本條內文引用到的 ＋ 引用到本條的（三者合一，不分方向）。
    //   使用者在意的是「這條跟哪些法規有關」，誰引用誰是法制作業的事，
    //   讀法條時反而多一個區塊要看。反推來源以「法規名稱」呈現並去重，
    //   避免同一部子法有多條引用時擠出一堆重複標籤。
    const manualRefs = (l.relatedLaws||[]).map(r=>r.ref||r.lawName||'').filter(Boolean);
    const autoRefs   = _autoCites(l.content||'');
    // 反推來源（只取法規名稱並去重）。若正向已經有更精確的「○○法第X條」，
    // 就不要再重複列出同一部法規的名稱，否則同一條會出現兩個指向同處的標籤。
    const backRefs = [...new Set(_findBacklinks(l, allLaws).map(b=>b.law.lawName||''))]
      .filter(n => n && ![...manualRefs, ...autoRefs].some(r => r.startsWith(n)));
    const seen = new Set();
    const allRefs = [...manualRefs, ...autoRefs, ...backRefs].filter(r=>{
      if(!r || seen.has(r)) return false;
      seen.add(r); return true;
    });
    const relHtml=allRefs.length
      ?'<div class="law-art-rel-title">🔗 關聯法條：</div>'
        +allRefs.map(ref=>'<button class="chip law-rel-chip'+(manualRefs.includes(ref)?'':' auto')
          +'" onclick="showLawPop(\''+esc(ref)+'\')">⚖ '+esc(ref)+'</button>').join('')
      :'';
    // 劃線/筆記顯示（顏色標記 hlColor + 備註 note，整合進編輯表單）
    const hlColors={yellow:'#d4a438',green:'#4caf7d',red:'#e05c57'};
    const hlC=l.hlColor&&hlColors[l.hlColor]?hlColors[l.hlColor]:'';
    // 動態顏色（隨資料變）只能 inline；固定樣式已抽到 .law-art-card class
    const dynStyle=hlC?` style="background:linear-gradient(to right, ${hlC}14, var(--bg2) 60%);border-left-color:${hlC}"`:'';
    const noteHtml=l.note?'<div class="law-note-box">📝 '+esc(l.note)+'</div>':'';
    return '<div data-law-id="'+l.id+'" class="law-art-card"'+dynStyle+'>'
      +'<div class="law-art-head">'
        +'<span>'+_hl(l.article||'')+(l.title?' — '+_hl(l.title):'')+'</span>'
        +'<div class="law-art-acts">'
          +'<button onclick="editLawInView('+l.id+')" class="law-edit-btn">✏</button>'
          +'<button onclick="delLaw('+l.id+')" class="law-del-btn">🗑</button>'
        +'</div>'
      +'</div>'
      +'<div class="law-art-body">'+contentHtml+'</div>'
      +noteHtml+kwHtml+relHtml

    +'</div>';
  };

  // 編=橙(--org) 章=紫(--pur) 節=藍(--acc) 由外而內

  const renderHeading = (type, text) => {
    if(!text) return '';
    const s = LEVEL_STYLE[type]||LEVEL_STYLE.chapter;
    const id = 'ch-'+encodeURIComponent(type+'-'+text);
    return '<div id="'+id+'" style="'
      +'font-size:'+s.size+';font-weight:'+s.fw+';color:'+s.color+';'
      +'padding:'+s.pt+' 14px '+s.pb+';margin-top:'+s.mt+';'
      +'margin-left:'+s.ml+';'
      +'border-left:'+s.bw+' solid '+s.border+';'
      +'background:'+s.bg+';border-radius:'+s.br+';'
      +'display:flex;align-items:center;gap:6px;'
      +'letter-spacing:.4px;line-height:1.4'
      +'">'
      +'<span style="opacity:.7;font-size:10px;font-weight:400;'
        +'border:1px solid '+s.border+';border-radius:3px;'
        +'padding:0 4px;margin-right:2px">'+s.label+'</span>'
      +esc(text)
    +'</div>';
  };

  let arts='';
  const hasPart    = parts.some(p=>p);
  const hasChapter = chapters.some(c=>c);
  const hasSection = sections.some(s=>s);

  // ── 完整三層樹狀分組渲染：編 → 章 → 節 → 條文 ──
  // 以「編」為最外層分組（同名編的所有章聚在一起），「章」為中層，
  // 「節」為內層。每層標題只渲染一次，且同層級依各自最小條號排序。
  // 徹底免疫於 part/章標記不一致：不論條文順序如何，同名編/章絕不分裂。
  const _artNum=l=>(l.articleNumber||art2n(l.article||''))||0;
  const _minOf=arr=>arr.reduce((m,l)=>Math.min(m,_artNum(l)),Infinity);

  // 第一層：以編(part)分組
  const partMap=new Map(); // part -> items[]
  laws.forEach(l=>{
    const p=l.part||'';
    if(!partMap.has(p)) partMap.set(p,[]);
    partMap.get(p).push(l);
  });
  const partEntries=[...partMap.entries()].sort((a,b)=>_minOf(a[1])-_minOf(b[1]));

  const renderGroup=()=>{
    partEntries.forEach(([part, partItems])=>{
      if(hasPart && part) arts+=renderHeading('part', part);
      // 第二層：該編內以章分組
      const chapMap=new Map();
      partItems.forEach(l=>{
        const ch=l.chapter||'';
        if(!chapMap.has(ch)) chapMap.set(ch,[]);
        chapMap.get(ch).push(l);
      });
      const chapEntries=[...chapMap.entries()].sort((a,b)=>_minOf(a[1])-_minOf(b[1]));
      chapEntries.forEach(([ch, chapItems])=>{
        if(hasChapter && ch) arts+=renderHeading('chapter', ch);
        // 第三層：該章內以節分組
        if(hasSection){
          const sectMap=new Map();
          chapItems.forEach(l=>{
            const sec=l.section||'';
            if(!sectMap.has(sec)) sectMap.set(sec,[]);
            sectMap.get(sec).push(l);
          });
          const sectEntries=[...sectMap.entries()].sort((a,b)=>_minOf(a[1])-_minOf(b[1]));
          sectEntries.forEach(([sec,items])=>{
            if(sec) arts+=renderHeading('section', sec);
            items.sort((a,b)=>_artNum(a)-_artNum(b)||((a.id||0)-(b.id||0)));
            items.forEach(l=>{ arts+=renderArtCard(l); });
          });
        } else {
          chapItems.sort((a,b)=>_artNum(a)-_artNum(b)||((a.id||0)-(b.id||0)));
          chapItems.forEach(l=>{ arts+=renderArtCard(l); });
        }
      });
    });
  };
  renderGroup();
  // 章節列表（快速跳轉用，含編/章/節）
  const chapterList=[...new Set([
    ...parts.filter(Boolean),
    ...chapters.filter(Boolean),
    ...sections.filter(Boolean),
  ])];
    // 章節管理按鈕
  const chMgrBtn='<button onclick="openChapterMgr(window.currentLawName)" style="background:none;border:1px solid var(--bd);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;color:var(--t2);margin-left:4px">⚙ 管理章節</button>';
  const chMgrBtnNew='<div style="margin-bottom:6px"><button onclick="openChapterMgr(window.currentLawName)" style="background:none;border:1px solid var(--bd);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;color:var(--t2)">⚙ 新增章節分類</button></div>';
    // ── 章節導覽：依層級縱向列出，點擊跳轉（對齊法律人網站風格）──
  const _buildChNav = () => {
    if(!chapterList.length) return '';
    const seen = new Set();
    const items = [];
    laws.forEach(l=>{
      ['part','chapter','section'].forEach(type=>{
        const val = l[type];
        if(val && !seen.has(type+':'+val)){
          seen.add(type+':'+val);
          items.push({ type, val });
        }
      });
    });
    return items.map(({type,val})=>{
      const s = LEVEL_STYLE[type];
      const label = s.label||type;
      const btnStyle = 'flex-shrink:0;background:'+s.bg+';border:1px solid '+s.border
        +';color:'+s.color+';border-radius:20px;padding:3px 10px;font-size:11px;'
        +'cursor:pointer;white-space:nowrap;font-weight:600';
      const tagStyle = 'opacity:.65;margin-right:4px;font-size:9px;background:'+s.border
        +';border-radius:3px;padding:0 3px;color:#0d1117';
      return '<button onclick="scrollToChapter(this,\''+encodeURIComponent(val)+'\',\''+type+'\')"'
        +' style="'+btnStyle+'">'
        +'<span style="'+tagStyle+'">'+esc(label)+'</span>'
        +esc(val)+'</button>';
    }).join('');
  };
  const chNavHtml = _buildChNav();
  const chapterMgmtHtml = chNavHtml
    ? '<div style="overflow-x:auto;display:flex;align-items:center;gap:6px;'
      +'padding:6px 12px 8px;border-bottom:1px solid var(--bd);scrollbar-width:none">'
      +chNavHtml
      +(chMgrBtn ? '<span style="flex-shrink:0;margin-left:6px">'+chMgrBtn+'</span>' : '')
      +'</div>'
    : chMgrBtnNew

  // 法條數量寫入 header
  const countEl = document.getElementById('lv-count');
  if(countEl) countEl.textContent = laws.length + ' 條';
  // 章節 chip 寫入 sticky 列
  const chBarEl = document.getElementById('lv-chapter-bar');
  if(chBarEl){
    const chHtml = _buildChNav();
    chBarEl.innerHTML = chHtml;
    chBarEl.style.display = chHtml ? 'flex' : 'none';
  }
  // lbody：只有法條卡片（章節標題已由 renderHeading 內嵌在 arts 裡）
  document.getElementById('lbody').innerHTML=
    '<div style="padding:4px 0 10px">'
    +(others.length?'<div class="sec" style="padding:0 0 4px;font-size:11px">快速跳轉</div><div style="overflow-x:auto;display:flex;gap:6px;padding:6px 0">'+jumpHtml+'</div>':'')
    +arts
    +'</div>';
  window.currentLawName=lawName;window.currentLawContent=laws.map(l=>(l.article+(l.title?' '+l.title:'')+(l.content?' '+l.content:'')).trim()).filter(Boolean).join('\n');
  S.curLawName=lawName; // 供編輯按鈕使用
  document.getElementById('lv').style.display='flex';
  }catch(e){ logError('openLawGroup',e); }}

function exitLaw(){
  document.getElementById('lv').style.display='none';
  const cb = document.getElementById('lv-chapter-bar');
  if(cb){ cb.innerHTML=''; cb.style.display='none'; }
  const ct = document.getElementById('lv-count');
  if(ct) ct.textContent='';
  // 重置為編輯模式
  _lvReadMode = false;
  _applyLvMode();
}

// ── lv 更多選單 ────────────────────────────────────────────
async function toggleLvFav(){
  const name = S.curLawName || window.currentLawName;
  if(!name) return;
  const all = await da('laws');
  const laws = all.filter(l => l.lawName === name);
  if(!laws.length){ toast('找不到「'+name+'」的條文，無法收藏'); return; }
  const nf = laws.some(l => l.favorite);
  for(const l of laws){ l.favorite = !nf; await dp('laws', l); }
  toast(nf ? '已取消收藏' : '已收藏');
  // 更新收藏按鈕文字
  const btn = document.getElementById('lv-star-item');
  if(btn) btn.textContent = nf ? '☆ 收藏' : '★ 已收藏';
}
function toggleLvMenu(btn){
  const menu = document.getElementById('lv-menu');
  if(!menu) return;
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
  if(!isOpen){
    // 點外部關閉
    setTimeout(()=> document.addEventListener('click', closeLvMenu, { once:true }), 0);
  }
}
function closeLvMenu(){
  const menu = document.getElementById('lv-menu');
  if(menu) menu.style.display = 'none';
}

// ── lv 閱讀/編輯模式切換 ────────────────────────────────────
function toggleLvMode(){
  _lvReadMode = !_lvReadMode;
  _applyLvMode();
}
function _applyLvMode(){
  const addBtn = document.getElementById('lv-add-btn');
  const lbody  = document.getElementById('lbody');

  // Toggle switch 外觀
  const track   = document.getElementById('lv-mode-track');
  const thumb   = document.getElementById('lv-mode-thumb');
  const iconL   = document.getElementById('lv-mode-icon-l');  // 筆（編輯）
  const iconR   = document.getElementById('lv-mode-icon-r');  // 眼（閱讀）
  if(track) track.style.background = _lvReadMode ? 'rgba(88,166,255,0.3)' : 'var(--bg3)';
  if(thumb) thumb.style.left = _lvReadMode ? '21px' : '3px';
  if(iconL) iconL.style.opacity = _lvReadMode ? '0.35' : '1';
  if(iconR) iconR.style.opacity = _lvReadMode ? '1' : '0.35';

  // 閱讀模式：隱藏新增條文按鈕、隱藏每條的編輯/刪除按鈕
  if(addBtn) addBtn.style.display = _lvReadMode ? 'none' : '';
  if(lbody){
    lbody.querySelectorAll('.law-edit-btn,.law-del-btn').forEach(el=>{
      el.style.display = _lvReadMode ? 'none' : '';
    });
  }
}

async function addLawInGroup(){
  try{
    const lawName=S.curLawName||window.currentLawName;
    if(!lawName){toast('請先開啟一個法規');return;}
    showAddLaw({lawName, article:'', category:'statute',
      content:'', keywords:[], relatedLaws:[], title:''});
  }catch(e){logError('addLawInGroup',e);}
}

async function editLawGroupInfo(){  try{
  const lawName=(S.curLawName||window.currentLawName||'').trim();
  if(!lawName){toast('請先開啟法規');return;}
  const allLaws=await da('laws');
  const sample=allLaws.find(l=>l.lawName===lawName)||{};
  const newOrg=prompt('制定機關（如：行政院、內政部）：',sample.org||'');
  if(newOrg===null)return;
  const rawAmend=prompt('發布／修正日期（格式：YYYMMDD，如 1130509 = 民國113年05月09日）：',sample.amendDate||'');
  if(rawAmend===null)return;
  // 解析 YYYMMDD 格式
  const parsedAmend=parseMinguoDate(rawAmend.trim());
  const targets=allLaws.filter(l=>l.lawName===lawName);
  for(const l of targets){
    l.org=newOrg.trim();
    l.amendDate=parsedAmend;
    await dp('laws',l);
  }
  toast('法規資訊已更新（共'+targets.length+'條）✓');
  openLawGroup(lawName);
  }catch(e){ logError('editLawGroupInfo',e); }}

// 解析民國日期：1130509 → 民國113年05月09日
function parseMinguoDate(s){
  if(!s)return '';
  // 已是完整格式
  if(/民國\d+年/.test(s))return s;
  // YYYMMDD 格式（7位）
  const m7=s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if(m7)return '民國'+m7[1]+'年'+m7[2]+'月'+m7[3]+'日';
  // YYYYMMDD 西元（8位）
  const m8=s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if(m8)return '民國'+(parseInt(m8[1])-1911)+'年'+m8[2]+'月'+m8[3]+'日';
  // 分隔符號：113.5.9／113-05-09／2024/5/9（西元自動換算）
  const mSep=s.match(/^(\d{2,4})\s*[./\-]\s*(\d{1,2})\s*[./\-]\s*(\d{1,2})$/);
  if(mSep){
    const y=parseInt(mSep[1]); const roc=y>1911?y-1911:y;
    return '民國'+roc+'年'+mSep[2].padStart(2,'0')+'月'+mSep[3].padStart(2,'0')+'日';
  }
  // 其他格式原樣儲存
  return s;
}

// ── 備註顏色標記列共用 helper（法條/題目編輯表單共用）──────
// 設定某個 mark-row 的選中顏色，並（首次）綁定點擊切換
function _setMarkRow(rowId, color){
  const row=document.getElementById(rowId);
  if(!row) return;
  row.querySelectorAll('.note-mark-dot').forEach(dot=>{
    dot.classList.toggle('sel', (dot.dataset.color||'')===(color||''));
    // 綁定一次點擊（用 dataset 旗標避免重複綁定）
    if(!row.dataset.bound){
      dot.onclick=()=>{
        row.querySelectorAll('.note-mark-dot').forEach(d=>d.classList.remove('sel'));
        dot.classList.add('sel');
      };
    }
  });
  row.dataset.bound='1';
}

async function editLawInView(id){  try{ const l=await dg('laws',id);if(l)showAddLaw(l);   }catch(e){ logError('editLawInView',e); }}


// ── 重建條號索引：用最新 art2n 重算所有法條 articleNumber ──────
// 修正：①舊資料 articleNumber 缺值/存錯 ②「第N條之M」子條號排序
//      ③編章節標記不一致（多數決統一，清除孤立錯標）
async function rebuildLawIndex(){  try{
  const laws=await da('laws');
  if(!laws.length){ toast('沒有法條資料'); return; }
  let changed=0, fixed=0;

  // 步驟1：重算條號
  for(const l of laws){
    const newNum=art2n(l.article||'')||0;
    if(l.articleNumber!==newNum){ l.articleNumber=newNum; changed++; }
  }

  // 步驟2：編章節一致性修復（多數決）
  // 同一法規同一「章」的所有條文，其 part(編) 應該一致；
  // 同一法規同一「節」的所有條文，其 chapter(章) 也應該一致。
  // 作法：統計群組內各值的票數，取最多者統一，藉此清除孤立錯標。
  //   （原本只做了「章→編」，「節→章」漏未實作，導致節層級的錯標無法被修正）
  const _majorityFix = (groupKeyFn, field, requireKeyPart) => {
    const groups = new Map();
    laws.forEach(l => {
      const k = groupKeyFn(l);
      if(!requireKeyPart(l)) return;   // 該層級為空者不參與
      if(!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    });
    groups.forEach(items => {
      const votes = new Map();
      items.forEach(l => { const v = l[field]||''; votes.set(v, (votes.get(v)||0)+1); });
      // 取票數最高者（平手時非空優先，避免被空值蓋掉正確的標記）
      let best='', bestN=-1;
      votes.forEach((n, v) => {
        if(n > bestN || (n === bestN && v && !best)){ best = v; bestN = n; }
      });
      items.forEach(l => {
        if((l[field]||'') !== best){ l[field] = best; fixed++; }
      });
    });
  };
  // 順序：先統一「編」，再由節統一「章」，最後再跑一次「編」。
  //   第三次不是多餘——節層級修好章之後，原本因章別錯標而落單的條文
  //   會重新歸入正確的章，此時才能取得該章多數的編。少了這一步，
  //   那些條文的編會停留在空值或舊的錯誤值。
  _majorityFix(l => (l.lawName||'')+'|'+(l.chapter||''), 'part',    l => !!(l.chapter||''));
  _majorityFix(l => (l.lawName||'')+'|'+(l.section||''), 'chapter', l => !!(l.section||''));
  _majorityFix(l => (l.lawName||'')+'|'+(l.chapter||''), 'part',    l => !!(l.chapter||''));

  // 步驟3：重建搜尋索引並寫回
  for(const l of laws){
    const _cnt=(l.content||'').startsWith('data:')?'':(l.content||'');
    l.searchBlob=[l.lawName,l.article,String(l.articleNumber||''),l.title,(l.keywords||[]).join(' '),_cnt]
      .filter(Boolean).join(' ').toLowerCase();
  }
  await bulkPut('laws', laws);

  // ── 同步重建題目搜尋索引（補入 year/exam/num）──
  const allQs = await da('questions');
  let qFixed = 0;
  for(const q of allQs){
    const newBlob=((q.stem||'')+' '+(q.groupStem||'')+' '+(q.subject||'')+' '+
      (q.year||'')+' '+(q.exam||'')+' '+(q.num||'')+' '+
      (q.keywords||[]).join(' ')).toLowerCase();
    if(q.searchBlob!==newBlob){ q.searchBlob=newBlob; qFixed++; }
  }
  if(qFixed>0) await bulkPut('questions', allQs);

  toast(`重建完成：法條 ${laws.length} 條（排序 ${changed}、章節 ${fixed}）· 題目索引 ${qFixed} 筆更新 ✓`);
  // 若正在檢視某法規，刷新；否則刷新清單
  if(document.getElementById('lv')?.style.display==='flex' && S.curLawName){
    openLawGroup(S.curLawName);
  } else {
    renderDB();
  }
  }catch(e){ logError('rebuildLawIndex',e); toast('重建失敗：'+e.message); }}

async function quizFromLaw(){  try{
  const lawName=(S.curLawName||window.currentLawName||'').trim();
  if(!lawName){toast('請先開啟一個法規');return;}
  const qs=await da('questions');
  if(!qs.length){toast('題庫尚無題目');return;}

  // 精確比對：refName 必須完全等於 lawName（去掉條號後）
  const pool=qs.filter(q=>{
    const rels=q.relatedLaws||[];
    if(!rels.length) return false;
    return rels.some(r=>{
      const ref=(r.ref||r.lawName||'').trim();
      if(!ref) return false;
      // 取 ref 的法規名稱部分（去掉條號 §X 或 第X條）
      const refName=ref.replace(/§.*/,'').replace(/第?\d+條.*/,'').trim();
      // 只有完全相等才算匹配，避免「警察法」誤匹配「警察法施行細則」
      return refName===lawName;
    });
  });

  if(!pool.length){
    toast('無關聯題目。請在題目「關聯法條」欄填入「'+lawName+'」後重試');
    return;
  }
  exitLaw();
  setTimeout(()=>startQWithPool(pool,'📚 '+lawName), 50);
  }catch(e){ logError('quizFromLaw',e); }}

async function delLawGroup(lawName){  try{
  lawName = lawName || S.curLawName || window.currentLawName || '';
  if(!lawName){toast('請先開啟一個法規');return;}
  const all=await da('laws');
  const targets=all.filter(l=>l.lawName===lawName);
  if(!targets.length){toast('找不到對應法條');return;}
  if(!confirm('確定刪除「'+lawName+'」全部 '+targets.length+' 條？無法復原。'))return;
  for(const l of targets) await dd('laws',l.id);
  toast('已刪除「'+lawName+'」共 '+targets.length+' 條');
  // 若正在檢視這部法規，關閉檢視
  if((S.curLawName||window.currentLawName)===lawName){ exitLaw&&exitLaw(); }
  renderDB();
  }catch(e){ logError('delLawGroup',e); }}

async function delLaw(id){  try{
  if(!confirm('確定刪除此條文？'))return;
  await dd('laws',id);
  toast('已刪除');
  renderDB();
  }catch(e){ logError('delLaw',e); }}

async function showAddLaw(l){
  try{
  S.editLawId=l?.id||null;
  document.getElementById('law-sh-t').textContent=l?'編輯資料':'新增資料';
  document.getElementById('l-name').value=l?.lawName||'';
  document.getElementById('l-art').value=l?.article||'';
  const partEl=document.getElementById('l-part');
  if(partEl)partEl.value=l?.part||'';
  const chEl=document.getElementById('l-chapter');
  if(chEl)chEl.value=l?.chapter||'';
  const secEl=document.getElementById('l-section');
  if(secEl)secEl.value=l?.section||'';
  if(document.getElementById('l-note'))document.getElementById('l-note').value=l?.note||'';
  _setMarkRow('l-mark-row', l?.hlColor||'');
  const tiEl=document.getElementById('l-title');
  if(tiEl)tiEl.value=l?.title||'';
  document.getElementById('l-cat').value=l?.category||'statute';
  document.getElementById('l-content').value=(l?.content&&!l.content.startsWith('data:image'))?l.content:'';
  document.getElementById('l-kw').value=(l?.keywords||[]).join(',');
  const relEl=document.getElementById('l-related');
  if(relEl)relEl.value=(l?.relatedLaws||[]).map(r=>r.ref||'').filter(Boolean).join(',');
  const srcEl=document.getElementById('l-src');
  if(srcEl)srcEl.value=l?.source||'';
  window._sopImgData=(l?.content?.startsWith('data:image'))?l.content:null;
  const prev=document.getElementById('l-img-prev');
  if(prev)prev.innerHTML=window._sopImgData?'<img src="'+window._sopImgData+'" style="max-width:100%;border-radius:8px">':'';
  toggleSOPMode();
  // 載入同法規既有的編/章/節（下拉選擇用）
  da('laws').then(all=>{
    // 同法規範圍內的編/章/節選項
    const curName=l?.lawName||document.getElementById('l-name').value.trim();
    const sameLaw=curName?all.filter(x=>x.lawName===curName):all;
    const fillDL=(id,vals)=>{
      const el=document.getElementById(id);
      if(el)el.innerHTML=[...new Set(vals.filter(Boolean))].map(v=>'<option value="'+esc(v)+'">').join('');
    };
    fillDL('l-part-list',    sameLaw.map(x=>x.part));
    fillDL('l-chapter-list', sameLaw.map(x=>x.chapter));
    fillDL('l-section-list', sameLaw.map(x=>x.section));
  });
  document.getElementById('law-ov').classList.add('on');
  }catch(e){logError('showAddLaw',e);}
}

function closeLawSh(){ document.getElementById('law-ov').classList.remove('on');S.editLawId=null; }


function openImgViewer(src){
  const old=document.getElementById('img-viewer');
  if(old){old.remove();return;}

  // ── 全螢幕遮罩 ──
  const ov=document.createElement('div');
  ov.id='img-viewer';
  ov.className='img-viewer-ov';

  // ── 頂部工具列 ──
  const bar=document.createElement('div');
  bar.className='img-viewer-bar';
  const closeBtn=document.createElement('button');
  closeBtn.textContent='✕';
  closeBtn.className='img-viewer-close';
  closeBtn.onclick=()=>ov.remove();
  bar.appendChild(closeBtn);

  // ── 圖片容器 ──
  const wrap=document.createElement('div');
  wrap.className='img-viewer-wrap';

  const img=document.createElement('img');
  img.src=src;
  img.className='img-viewer-img';
  img.draggable=false;

  // ── 狀態 ──
  let scale=1, tx=0, ty=0;
  let lastDist=0, lastMid={x:0,y:0};
  let dragging=false, lastPos={x:0,y:0};

  const applyTransform=()=>{
    img.style.transform='translate('+tx+'px,'+ty+'px) scale('+scale+')';
  };

  const clampTx=(s,x)=>{
    const imgW=wrap.clientWidth*s;
    const maxX=0;
    const minX=wrap.clientWidth-imgW;
    return Math.min(maxX,Math.max(minX<0?minX:0,x));
  };
  const clampTy=(s,y)=>{
    const imgH=img.naturalHeight*(wrap.clientWidth/img.naturalWidth)*s;
    const maxY=0;
    const minY=wrap.clientHeight-imgH;
    return Math.min(maxY,Math.max(minY<0?minY:0,y));
  };

  const dist=(t)=>Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);
  const mid=(t)=>({x:(t[0].clientX+t[1].clientX)/2,y:(t[0].clientY+t[1].clientY)/2});

  wrap.addEventListener('touchstart',e=>{
    e.preventDefault();
    if(e.touches.length===2){
      lastDist=dist(e.touches);
      lastMid=mid(e.touches);
      dragging=false;
    } else if(e.touches.length===1){
      dragging=true;
      lastPos={x:e.touches[0].clientX,y:e.touches[0].clientY};
    }
  },{passive:false});

  wrap.addEventListener('touchmove',e=>{
    e.preventDefault();
    if(e.touches.length===2){
      // 雙指縮放
      const d=dist(e.touches);
      const m=mid(e.touches);
      const ds=d/lastDist;
      const newScale=Math.min(Math.max(scale*ds,0.5),8);
      // 以兩指中心為基準縮放
      const rect=wrap.getBoundingClientRect();
      const cx=m.x-rect.left;
      const cy=m.y-rect.top;
      tx=cx-(cx-tx)*(newScale/scale)+(m.x-lastMid.x);
      ty=cy-(cy-ty)*(newScale/scale)+(m.y-lastMid.y);
      scale=newScale;
      tx=clampTx(scale,tx);
      ty=clampTy(scale,ty);
      lastDist=d;
      lastMid=m;
      applyTransform();
    } else if(e.touches.length===1&&dragging){
      // 單指移動（只在放大時有效）
      const dx=e.touches[0].clientX-lastPos.x;
      const dy=e.touches[0].clientY-lastPos.y;
      if(scale>1){
        tx=clampTx(scale,tx+dx);
        ty=clampTy(scale,ty+dy);
        applyTransform();
      }
      lastPos={x:e.touches[0].clientX,y:e.touches[0].clientY};
    }
  },{passive:false});

  wrap.addEventListener('touchend',e=>{
    if(e.touches.length<2) lastDist=0;
    if(e.touches.length===0) dragging=false;
  });

  // 圖片載入後置中
  img.onload=()=>{
    // 預設填滿寬度
    tx=0; ty=0; scale=1;
    applyTransform();
  };

  wrap.appendChild(img);
  ov.appendChild(bar);
  ov.appendChild(wrap);
  document.body.appendChild(ov);
}


function switchLawMode(mode){
  const cw=document.getElementById('l-content-wrap');
  const iw=document.getElementById('l-img-wrap');
  if(mode==='img'){
    if(cw)cw.classList.add('hide');
    if(iw)iw.classList.remove('hide');
  } else {
    if(cw)cw.classList.remove('hide');
    if(iw)iw.classList.add('hide');
  }
}

function toggleSOPMode(){
  const cat=document.getElementById('l-cat')?.value;
  const cw=document.getElementById('l-content-wrap');
  const iw=document.getElementById('l-img-wrap');
  const tw=document.getElementById('l-img-toggle-wrap');
  const hasImg=window._sopImgData!=null;

  if(cat==='sop'){
    // SOP：預設圖片模式
    if(cw)cw.classList.add('hide');
    if(iw)iw.classList.remove('hide');
    if(tw)tw.style.display='none';
  } else if(cat==='supplement'||cat==='interpretation'){
    // 補充資料/函釋：可選文字或圖片，預設文字（有圖片資料則預設圖片）
    if(tw)tw.style.display='block';
    if(hasImg){
      if(cw)cw.classList.add('hide');
      if(iw)iw.classList.remove('hide');
    } else {
      if(cw)cw.classList.remove('hide');
      if(iw)iw.classList.add('hide');
    }
  } else {
    // 法規條文：只有文字
    if(cw)cw.classList.remove('hide');
    if(iw)iw.classList.add('hide');
    if(tw)tw.style.display='none';
  }
}

// 切換圖片/文字模式（補充資料/函釋用）
function onLawImgSelect(e){ loadSOPImg(e); }
function loadSOPImg(e){
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=ev=>{
    window._sopImgData=ev.target.result;
    const prev=document.getElementById('l-img-prev');
    if(prev)prev.innerHTML='<img src="'+ev.target.result+'" style="max-width:100%;border-radius:8px;margin-top:4px">';
  };
  reader.readAsDataURL(file);
}

async function saveLaw(){  try{
  const cat_=document.getElementById('l-cat').value;
  let content='';
  // sop / supplement / interpretation 都可選擇圖片或文字
  const canUseImg=(cat_==='sop'||cat_==='supplement'||cat_==='interpretation');
  if(canUseImg && window._sopImgData){
    // 有上傳圖片，直接用圖片
    content=window._sopImgData;
  } else {
    content=document.getElementById('l-content').value.trim();
    if(!content){toast('請填寫內容，或上傳圖片');return;}
  }
  const article=document.getElementById('l-art').value.trim();
  const part=document.getElementById('l-part')?.value.trim()||'';
  const chapter=document.getElementById('l-chapter')?.value.trim()||'';
  const section=document.getElementById('l-section')?.value.trim()||'';
  const relStr=(document.getElementById('l-related')?.value||'').trim();
  const relatedLaws=relStr?relStr.split(/[,，]/).map(s=>({ref:s.trim()})).filter(r=>r.ref):[];
  const articleNumber=art2n(article)||0;
  const data={
    lawName:document.getElementById('l-name').value.trim(),
    article,part,chapter,section,articleNumber,
    category:cat_,
    title:document.getElementById('l-title')?.value.trim()||'',
    content,
    keywords:kwArr(document.getElementById('l-kw').value),
    relatedLaws,
    source:document.getElementById('l-src')?.value.trim()||'',
    note:document.getElementById('l-note')?.value.trim()||'',
    hlColor:document.querySelector('#l-mark-row .note-mark-dot.sel')?.dataset.color||'',
    favorite:false,createdAt:Date.now()
  };
  if(!data.lawName){toast('請填寫法律名稱');return;}
  // ★ 制定機關、修正日期由「⚙ 編輯法規資訊」統一設定，編輯表單沒有這兩欄。
  //   原本從不存在的欄位讀值，每次編輯單條就把這兩欄清成空白。改為沿用同法規既有的值。
  Object.assign(data, _lawInfo((await da('laws')).filter(l=>l.lawName===data.lawName)));
  if(S.editLawId){
    const ex=await dg('laws',S.editLawId);
    data.id=S.editLawId;
    data.favorite=ex?.favorite||false;
    data.createdAt=ex?.createdAt||Date.now();
  }
  try{
    // 建立純文字搜尋索引（排除 base64 圖片 content，加速搜尋）
    const _cnt = (data.content||'').startsWith('data:') ? '' : (data.content||'');
    data.searchBlob = [
      data.lawName, data.article, String(data.articleNumber||''),
      data.title, (data.keywords||[]).join(' '), _cnt
    ].filter(Boolean).join(' ').toLowerCase();
    await dp('laws',data);
    closeLawSh();
    toast(S.editLawId?'法條已更新 ✓':'法條已儲存 ✓');
    // 儲存後刷新畫面
    if(document.getElementById('lv')?.style.display==='flex' && S.curLawName){
      openLawGroup(S.curLawName);
    } else {
      renderDB();
    }
  }catch(e){
    logError('saveLaw',e);
    toast('儲存失敗，請重試');
  }
}catch(e){ logError('saveLaw',e); }
}

function openBulkQ(){
  // 填入科目 datalist（與逐一新增共用來源）
  da('questions').then(qs=>{
    const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))];
    const dl=document.getElementById('bi-subs');
    if(dl) dl.innerHTML=subs.map(s=>`<option value="${s}">`).join('');
  }).catch(()=>{});
  document.getElementById('bulk-ov').classList.add('on');
  // overlay 動畫完成後 focus textarea（延遲確保 IME 正確初始化）
  setTimeout(()=>{
    const ta = document.getElementById('bi-text');
    if(!ta) return;
    ta.focus();
    // 手動觸發 input 事件，讓 Android WebView 正確初始化中文 IME
    ta.dispatchEvent(new Event('input', {bubbles:true}));
  }, 400);
}
function closeBulkQ(){ document.getElementById('bulk-ov').classList.remove('on'); }

function showBulkLaw(){ document.getElementById('blaw-ov').classList.add('on'); }
function closeBulkLaw(){ document.getElementById('blaw-ov').classList.remove('on'); }

function parseLawText(rawText, lawName, category, source){
  if(!rawText||!rawText.trim()) return [];

  const lines = rawText.split('\n').map(l=>l.trim()).filter(Boolean);
  const items = [];

  // ── 三層結構狀態 ──────────────────────────────────────────
  let curPart    = '';  // 編（最上層）：第一編 總則
  let curChapter = '';  // 章（中層）：第一章 總則
  let curSection = '';  // 節（最下層）：第一節 一般規定
  let curArtNum  = null;
  let curArtSub  = null;   // 之N（子條號）
  let curTitle   = '';
  let contentLines = [];

  // 正規表達式：只認「章節編節」行，條號只認阿拉伯數字
  // 數字部分：支援阿拉伯數字、中文數字、及中文數字間有空格（如「十 三」）
  // 支援「編」（最上層結構）
  const _numPart = '((?:[一二三四五六七八九十百千\\d]+\\s*)+?)';
  const partRe    = new RegExp('^第\\s*'+_numPart+'\\s*[篇編]\\s*(.+)?');
  const chapterRe = new RegExp('^第\\s*'+_numPart+'\\s*章\\s*(.+)?');
  const sectionRe = new RegExp('^第\\s*'+_numPart+'\\s*節\\s*(.+)?');
  // 條號：支援阿拉伯數字（第1條、第 1 條）和中文數字（第一條）
  const _artNumPart = '(?:([一二三四五六七八九十百千\\d]+)|([\\d]+))';
  // 條號：「第7條」「第7條之1」「第七條之一」，以及官網複製下來的「第 7-1 條」
  const articleRe = /^第\s*((?:[一二三四五六七八九十百千]+|\d+))\s*(?:[-－]\s*((?:[一二三四五六七八九十]+|\d+))\s*)?條(?:之\s*((?:[一二三四五六七八九十]+|\d+)))?\s*(?:[（(]([^）)]+)[）)])?(.*)$/;

  // 中文數字→阿拉伯數字
  const zh2num = (s) => {
    const map={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,
               '十':10,'百':100,'千':1000};
    if(/^\d+$/.test(s)) return parseInt(s);
    let result=0, temp=0;
    for(const ch of s){
      const v=map[ch]; if(!v) continue;
      if(v>=10){result+=(temp||1)*v;temp=0;}else temp=v;
    }
    return result+temp;
  };

  // 格式化層級名稱（「第N編/章/節 名稱」→ 標準格式）
  const fmtLevel = (type, num, name) => {
    // 去除中文數字間的空格再轉換（如「十 三」→「十三」→13）
    const cleanNum = typeof num==='string' ? num.replace(/\s+/g,'') : num;
    const n = zh2num(cleanNum);
    const s = name ? name.trim() : '';
    return '第'+n+type+(s?' '+s:'');
  };

  // 儲存目前條文
  const saveArticle = () => {
    if(curArtNum===null) return;
    const content = contentLines.join('\n').trim();
    if(!content && !curTitle) return;
    // 支援中文數字條號
    const _zh2n = (s)=>{
      if(/^\d+$/.test(String(s))) return parseInt(s,10);
      const map={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'百':100,'千':1000};
      let r=0,t=0; for(const c of String(s)){const v=map[c];if(!v)continue;if(v>=10){r+=(t||1)*v;t=0;}else t=v;} return r+t||parseInt(s,10)||0;
    };
    const artNum = _zh2n(curArtNum);
    const artSub = curArtSub ? _zh2n(curArtSub) : 0;
    items.push({
      lawName:       lawName||'',
      // ★ 原本丟掉「之N」：第7條之1 被存成第7條（與第7條重複），排序鍵也只存主號。
      //   排序鍵改與 art2n 同一套：主號×1000＋子號（第7條之1 → 7001）
      article:       '第 '+artNum+' 條'+(artSub?'之'+artSub:''),
      articleNumber: artNum*1000+Math.min(artSub,999),
      title:         curTitle||'',
      content:       content||curTitle||'',
      category:      category||'statute',
      part:          curPart||'',          // 編
      chapter:       curChapter||'',       // 章
      section:       curSection||'',       // 節
      source:        source||'',
      keywords:      [],
      relatedLaws:   [],
      favorite:      false,
      createdAt:     Date.now(),
    });
    curArtNum=null; curArtSub=null; curTitle=''; contentLines=[];
  };

  for(const line of lines){
    // ── 編（最優先）──────────────────────────────────────
    const pM = line.match(partRe);
    if(pM){ saveArticle(); curPart=fmtLevel('編',pM[1],pM[2]); curChapter=''; curSection=''; continue; }

    // ── 章 ───────────────────────────────────────────────
    const chM = line.match(chapterRe);
    if(chM){ saveArticle(); curChapter=fmtLevel('章',chM[1],chM[2]); curSection=''; continue; }

    // ── 節 ───────────────────────────────────────────────
    const secM = line.match(sectionRe);
    if(secM){ saveArticle(); curSection=fmtLevel('節',secM[1],secM[2]); continue; }

    // ── 條號（只認阿拉伯數字）────────────────────────────
    const artM = line.match(articleRe);
    if(artM){
      saveArticle();
      curArtNum = artM[1];              // 條號（中文或阿拉伯）
      curArtSub = artM[2] || artM[3] || null;   // 「7-1」或「之1」
      // artM[4] = 標題，artM[5] = 條文尾
      curTitle  = (artM[4]||'').trim();
      const tail = (artM[5]||'').trim();
      if(tail) contentLines.push(tail);
      continue;
    }

    // ── 條文內容（追加）──────────────────────────────────
    if(curArtNum!==null) contentLines.push(line);
  }
  saveArticle();
  return items;
}

function prevBulkLaw(){
  try{
  const text=document.getElementById('bl-text').value;
  const name=document.getElementById('bl-name').value.trim()||'未命名';
  const cat=document.getElementById('bl-cat').value;
  const src=document.getElementById('bl-src').value.trim();
  const items=parseLawText(text,name,cat,src);
  const prevEl=document.getElementById('bl-prev');
  if(!items.length){prevEl.innerHTML='<span style="color:var(--red)">無法解析，請確認格式（需有「第X條」）</span>';return;}

  // 三層結構統計
  const parts   =[...new Set(items.map(i=>i.part   ||'').filter(Boolean))];
  const chapters=[...new Set(items.map(i=>i.chapter||'').filter(Boolean))];
  const sections=[...new Set(items.map(i=>i.section||'').filter(Boolean))];

  // 顏色標籤
  const mkTag=(text,col,bg)=>'<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600;color:'+col+';background:'+bg+';margin:2px 3px">'+esc(text)+'</span>';
  let html='<div style="font-size:12px;color:var(--t2);padding:6px 0">';
  html+='<span style="color:var(--t1);font-weight:600">共 '+items.length+' 條</span>　';

  if(parts.length){
    html+='<br><span style="color:var(--org);font-size:11px">📙 編：</span>';
    parts.forEach(p=>{ html+=mkTag(p,'var(--org)','var(--org2)'); });
  }
  if(chapters.length){
    html+='<br><span style="color:var(--pur);font-size:11px">📗 章：</span>';
    chapters.forEach(c=>{ html+=mkTag(c,'var(--pur)','var(--pur2)'); });
  }
  if(sections.length){
    html+='<br><span style="color:var(--acc);font-size:11px">📘 節：</span>';
    sections.forEach(s=>{ html+=mkTag(s,'var(--acc)','rgba(31,111,235,0.15)'); });
  }

  // 前5條預覽
  html+='<br style="margin:3px 0"><span style="font-size:11px">前5條：</span>';
  items.slice(0,5).forEach(i=>{
    const hier=[i.part,i.chapter,i.section].filter(Boolean).pop()||'';
    html+='<span style="color:var(--t1);font-size:11px;margin-right:8px">'+esc(i.article)+(i.title?'（'+esc(i.title)+'）':'')+'</span>';
  });
  if(items.length>5) html+='<span style="color:var(--t2);font-size:11px">…</span>';
  html+='</div>';
  prevEl.innerHTML=html;
  }catch(e){logError('prevBulkLaw',e);}
}

async function importBulkLaw(){  try{
  const text=document.getElementById('bl-text').value;
  if(!text.trim()){toast('請貼入法條文字');return;}
  const name=document.getElementById('bl-name').value.trim()||'未命名';
  const cat=document.getElementById('bl-cat').value;
  const src=document.getElementById('bl-src').value.trim();
  const items=parseLawText(text,name,cat,src);
  if(!items.length){toast('解析結果為0條，請確認格式（需有「第X條」）');return;}
  // ── 防重複：以法律名稱+類別 判斷是否已存在 ──────────────────
  const existing=await da('laws');
  // 機關、修正日期是法規層級資訊，覆蓋重匯時沿用，不隨舊條文一起刪掉
  const keepInfo=_lawInfo(existing.filter(l=>l.lawName===name));
  items.forEach(l=>Object.assign(l, keepInfo));
  const sameGroup=existing.filter(l=>l.lawName===name&&l.category===cat);
  if(sameGroup.length>0){
    const go=confirm('「'+name+'」（'+cat+'）已有 '+sameGroup.length+' 條資料。\n\n確定 → 覆蓋（刪除舊資料再匯入）\n取消 → 取消匯入');
    if(!go) return;
    // 刪除舊資料
    for(const l of sameGroup) await dd('laws',l.id);
  }
  // 批量匯入同步建立 searchBlob
  items.forEach(l => {
    l.searchBlob = [
      l.lawName, l.article, String(l.articleNumber||''),
      l.title, (l.keywords||[]).join(' ')
    , (l.content||'').startsWith('data:') ? '' : (l.content||'')].filter(Boolean).join(' ').toLowerCase();
  });
  await bulkPut('laws',items);
  toast('已匯入 '+items.length+' 條法條 ✓');
  closeBulkLaw();
  renderDB();
  }catch(e){ logError('importBulkLaw',e); }}

// 以彈窗列出某部法規的條文清單（供「只給法規名稱、沒有條號」的連結使用）
//   點清單中的任一條 → 直接在同一個彈窗顯示該條內容（不離開目前畫面）
//   底部保留「在資料庫開啟」，需要完整瀏覽時才跳頁
function _showLawListPop(lawName, laws, notFound){
  const el = document.getElementById('lawpop-ov');
  if(!el) return;
  const titleEl = document.getElementById('lawpop-title');
  const bodyEl  = document.getElementById('lawpop-body');
  const relEl   = document.getElementById('lawpop-related');
  if(titleEl) titleEl.textContent = lawName;

  if(notFound){
    if(bodyEl) bodyEl.innerHTML = '<span style="color:var(--t2)">查無「'+esc(lawName)+'」，請先在資料庫新增。</span>';
    if(relEl)  relEl.innerHTML = '';
    el.style.display = 'flex';
    return;
  }

  // 取出該法規全部條文，依 articleNumber 排序（與資料庫頁一致的排序邏輯）
  const arts = laws
    .filter(l => (l.lawName||'') === lawName)
    .sort((a,b) => (a.articleNumber || art2n(a.article||'')) - (b.articleNumber || art2n(b.article||'')));

  if(!arts.length){
    if(bodyEl) bodyEl.innerHTML = '<span style="color:var(--t2)">「'+esc(lawName)+'」目前沒有條文內容。</span>';
    if(relEl)  relEl.innerHTML = '';
    el.style.display = 'flex';
    return;
  }

  const items = arts.map(a => {
    const label = (a.article||'').trim() || (a.title||'') || '（未標條號）';
    const hint  = (a.title||'').trim();
    // 用 article 全文當參數，讓點擊後走既有的 showLawPop 精確定位邏輯
    const ref   = esc(lawName + (a.article||''));
    return '<button class="chip" style="display:block;width:100%;text-align:left;font-size:12px;margin-bottom:4px"'
         + ' onclick="showLawPop(\''+ref+'\')">'
         + '<b>'+esc(label)+'</b>'
         + (hint ? '<span style="color:var(--t2);margin-left:6px">'+esc(hint)+'</span>' : '')
         + '</button>';
  }).join('');

  if(bodyEl){
    bodyEl.innerHTML =
      '<div style="font-size:12px;color:var(--t2);margin-bottom:6px">共 '+arts.length+' 條，點選查看內容：</div>'
      + '<div style="max-height:52vh;overflow:auto">'+items+'</div>';
  }
  if(relEl){
    relEl.innerHTML =
      '<div style="margin-top:8px;display:flex;justify-content:flex-end">'
      + '<button class="chip" style="font-size:11px" onclick="closeLawPop();openLawGroup(\''+esc(lawName)+'\')">在資料庫開啟 ›</button>'
      + '</div>';
  }
  el.style.display = 'flex';
}

// ── §條號寫法的共用解析（renderDB / openLawGroup / showLawPop 共用）──
//   法律引用常把「第X條」簡寫成「§X」，子條號寫成「§X-Y」或「§X之Y」。
//   這裡集中定義格式規則，避免同一套正則散落多處：先前就發生過只修了
//   renderDB、卻漏掉 openLawGroup 的情況（同樣的 bug 修了兩次）。
const _SEC_RE = /§\s*(\d+)(?:[-－之](\d+))?/;

// 把 §簡寫轉成 art2n() 認得的標準寫法：§2 → 第2條、§2-1 → 第2條之1
//   注意子號要接在「條」之後（art2n 的子條號規則是 /條之(N)/，
//   寫成「第2之1條」它解析不出來）。
function _secToArticle(main, sub){
  return '第' + main + '條' + (sub ? '之' + sub : '');
}

// 解析「法規名§條號」→ { lawName, artNum }；不符格式回傳 null。
//   artNum 已用 art2n() 換算成與資料庫 articleNumber 相同的編碼（主號*1000+子號），
//   可直接比對，不需再做字串處理。
function parseSecSearch(kw){
  const m = String(kw||'').match(new RegExp('^(.*)' + _SEC_RE.source + '\\s*$'));
  if(!m) return null;
  return {
    lawName: (m[1]||'').trim().toLowerCase(),
    artNum:  art2n(_secToArticle(m[2], m[3])),
  };
}

async function showLawPop(ref){  try{
  if(!ref)return;
  const laws=await da('laws');
  // 「§」是常見的條號簡寫（§2＝第2條、§2-1＝第2條之1），但 art2n() 與下面的
  // 「第X條」定位正則都只認得標準寫法，遇到§會完全解析不出條號，導致 artNum
  // 變成 null、namePart 也切不出法規名稱（整串被當成名稱），結果直接跳整部
  // 法規、定位不到指定條文。這裡先把§簡寫正規化成標準格式，其餘邏輯不用動，
  // 沒有§的原格式（如「第11條」「第100條之1」）完全不受影響。
  ref = ref.replace(_SEC_RE, (_, main, sub) => _secToArticle(main, sub));
  // 條號解析改用 art2n()（與資料庫 articleNumber 完全同一套公式：主號*1000+子號），
  // 原本自己另寫的正則只抓純數字（如92），但資料庫存的是92000/92004這種格式，
  // 兩者永遠對不上，導致任何帶明確條號的法條連結都找不到資料。
  const artNum = art2n(ref) || null;   // art2n 找不到「第X條」模式時回傳0，這裡轉為null表示無條號
  // namePart 改用「定位切割」而非到處刪數字的 .replace()：
  // 找到「第X條」出現的位置，取其之前的文字當作法規名稱。
  // 若整個 ref 裡根本沒有「第X條」模式（例如「釋字第748號解釋」這類名稱本身含數字、
  // 用「號」而非「條」的資料），視為沒有條號，把完整 ref 當名稱查，
  // 而不是像舊邏輯把名稱中的數字誤判為條號、切爛整個名稱。
  const artPosM = ref.match(/第[一二三四五六七八九十百千\d]+條/);
  const namePart = artPosM ? ref.slice(0, artPosM.index).trim() : ref.trim();

  // 只有法規名稱、沒有條號 → 一樣用彈窗呈現（列出該法規的條文清單），
  // 不再整頁跳走。原本 openLawGroup() 會離開目前畫面（例如答題中），
  // 與「點條號跳彈窗」的體驗不一致且會中斷作答，改為就地開窗。
  if(artNum===null&&namePart){
    // 找資料庫裡最接近的法規名稱
    const allNames=[...new Set(laws.map(l=>l.lawName).filter(Boolean))];
    const exact=allNames.find(n=>n===namePart||namePart===n);
    const partial=allNames.find(n=>n.includes(namePart)||namePart.includes(n));
    const fuzzy=allNames.find(n=>{
      const cs=namePart.replace(/[法條例規則]/g,'').split('');
      return cs.length>=2&&cs.every(c=>n.includes(c));
    });
    const target=exact||partial||fuzzy;
    _showLawListPop(target||namePart, laws, !target);
    return;
  }
  let matched=laws.filter(l=>{
    const ln=l.lawName||'';
    let nm=!namePart||ln.includes(namePart)||namePart.includes(ln);
    if(!nm){
      const cs=namePart.replace(/[法條例規則]/g,'').split('');
      if(cs.length>=2)nm=cs.every(c=>ln.includes(c));
    }
    if(!nm)return false;
    // 與 renderDB／openLawGroup 一致：articleNumber 尚未建立時（例如剛匯入、
    // 還沒按過「重建條號索引」的資料）改用 art2n(l.article) 即時換算，
    // 否則這些條文的法條連結會查無資料。
    return artNum===null||(l.articleNumber||art2n(l.article||''))===artNum;
  });
  if(matched.length>1){const ex=matched.filter(l=>(l.lawName||'').includes(namePart));if(ex.length)matched=ex;}
  const el=document.getElementById('lawpop-ov');if(!el)return;
  if(!matched.length){
    document.getElementById('lawpop-title').textContent=ref;
    document.getElementById('lawpop-body').innerHTML='<span style="color:var(--t2)">查無「'+esc(ref)+'」，請先在資料庫新增。</span>';
    document.getElementById('lawpop-related').innerHTML='';
    el.style.display='flex';return;
  }
  const l=matched[0];
  const isImg=l.content&&l.content.startsWith('data:image');
  document.getElementById('lawpop-title').textContent=(l.lawName||'')+' '+(l.article||'');
  document.getElementById('lawpop-body').innerHTML=isImg?'<img src="'+l.content+'" style="max-width:100%;border-radius:8px">':br(l.content||'');
  const rl=(l.relatedLaws||[]).map(r=>'<button class="chip" style="font-size:11px" onclick="showLawPop(\''+esc(r.ref||r.lawName||'')+'\')" >⚖ '+esc(r.ref||r.lawName||'')+'</button>').join('');
  document.getElementById('lawpop-related').innerHTML=rl?'<div style="margin-top:8px;font-size:12px;color:var(--t2)">關聯法條：</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px">'+rl+'</div>':'';
  el.style.display='flex';
  }catch(e){ logError('showLawPop',e); }}
function closeLawPop(){ document.getElementById('lawpop-ov').style.display='none'; }

// ── Shims ──


function scrollToChapter(tagEl, encodedCh, typeHint){
  // 先用 typeHint 找，再依序嘗試，最後用舊格式
  const order = typeHint ? [typeHint,'part','chapter','section'] : ['part','chapter','section'];
  let el = null;
  for(const t of [...new Set(order)]){
    el = document.getElementById('ch-'+t+'-'+encodedCh);
    if(el) break;
  }
  if(!el) el = document.getElementById('ch-'+encodedCh);
  if(el){
    el.scrollIntoView({behavior:'smooth',block:'start'});
    const orig=el.style.background;
    el.style.transition='background .2s';
    el.style.background='var(--bg3)';
    setTimeout(()=>{ el.style.background=orig||''; },900);
  }
}

async function openChapterMgr(lawName){  try{
  // 無參數呼叫（選單按鈕）時回退用目前開啟的法規
  lawName = lawName || S.curLawName || window.currentLawName || '';
  if(!lawName){ toast('請先開啟一個法規'); return; }
  const allLaws=await da('laws');
  const targets=allLaws.filter(l=>l.lawName===lawName)
    .sort((a,b)=>(a.articleNumber||0)-(b.articleNumber||0));
  if(!targets.length){toast('找不到法規');return;}

  // 現有結構
  const curParts    =[...new Set(targets.map(l=>l.part   ||'').filter(Boolean))];
  const curChapters =[...new Set(targets.map(l=>l.chapter||'').filter(Boolean))];
  const curSections =[...new Set(targets.map(l=>l.section||'').filter(Boolean))];
  const structInfo  =
    (curParts.length   ?'📙 編：'+curParts.join('、')+'\n':'')+
    (curChapters.length?'📗 章：'+curChapters.join('、')+'\n':'')+
    (curSections.length?'📘 節：'+curSections.join('、'):'');

  // 步驟1：選擇層級
  const levelInput=prompt(
    '【分層管理】目前結構：\n'+(structInfo||'（尚無分類）')+'\n\n'+
    '請選擇要設定的層級：\n'+
    '1 = 📙 編（最上層）→ 選哪些章屬於此編\n'+
    '2 = 📗 章（中層）→ 選哪些節屬於此章\n'+
    '3 = 📘 節（最下層）→ 設定條號範圍\n'+
    '輸入 1、2 或 3：'
  );
  if(!levelInput||!['1','2','3'].includes(levelInput.trim()))return;
  const lvIdx=parseInt(levelInput.trim())-1;
  const level    =['part','chapter','section'][lvIdx];
  const levelName=['編','章','節'][lvIdx];
  const childLevel    =['chapter','section',null][lvIdx];   // 編的子級=章，章的子級=節
  const childLevelName=['章','節',null][lvIdx];

  // 步驟2：輸入名稱
  const nameInput=prompt('請輸入'+levelName+'別名稱（如「第一'+levelName+' 總則」），留空取消：');
  if(!nameInput||!nameInput.trim())return;
  const newVal=nameInput.trim();

  let count=0;

  if(lvIdx===2||!childLevel){
    // 節：直接設定條號範圍
    const rangeInput=prompt(
      '套用範圍（格式：1-5 代表第1到5條）\n'+
      '留空則套用到所有未設節別的條文：'
    );
    let startArt=0,endArt=99999;
    if(rangeInput&&rangeInput.trim()){
      const rm=rangeInput.match(/(\d+)\s*[-~]\s*(\d+)/);
      if(rm){startArt=parseInt(rm[1]);endArt=parseInt(rm[2]);}
      else{const n=parseInt(rangeInput);if(!isNaN(n)){startArt=n;endArt=n;}}
    }
    for(const l of targets){
      const artN=Math.floor((l.articleNumber||art2n(l.article||''))/1000);   // 使用者輸入的是主條號
      const apply=rangeInput&&rangeInput.trim()?(artN>=startArt&&artN<=endArt):(!l[level]);
      if(apply){l[level]=newVal;await dp('laws',l);count++;}
    }
  } else {
    // 編/章：顯示現有子層級清單，讓使用者選哪些歸入
    const childList=lvIdx===0?curChapters:curSections; // 編選章，章選節
    if(!childList.length){
      // 子層級不存在，改用條號範圍
      const rangeInput=prompt(
        '目前尚無'+childLevelName+'別。\n'+
        '改用條號範圍（格式：1-5 代表第1到5條）\n'+
        '留空套用到所有未設'+levelName+'別的條文：'
      );
      let startArt=0,endArt=99999;
      if(rangeInput&&rangeInput.trim()){
        const rm=rangeInput.match(/(\d+)\s*[-~]\s*(\d+)/);
        if(rm){startArt=parseInt(rm[1]);endArt=parseInt(rm[2]);}
        else{const n=parseInt(rangeInput);if(!isNaN(n)){startArt=n;endArt=n;}}
      }
      for(const l of targets){
        const artN=Math.floor((l.articleNumber||art2n(l.article||''))/1000);   // 使用者輸入的是主條號
        const apply=rangeInput&&rangeInput.trim()?(artN>=startArt&&artN<=endArt):(!l[level]);
        if(apply){l[level]=newVal;await dp('laws',l);count++;}
      }
    } else {
      // 顯示子層級讓使用者選
      const listStr=childList.map((c,i)=>(i+1)+'. '+c).join('\n');
      const selInput=prompt(
        '請選擇要歸入「'+newVal+'」的'+childLevelName+'別：\n'+listStr+'\n\n'+
        '輸入序號（可多選，用逗號分隔，如「1,3」）\n'+
        '或直接輸入條號範圍（如「1-20」）：'
      );
      if(!selInput||!selInput.trim())return;
      const sel=selInput.trim();
      if(/^\d+[-~]\d+$/.test(sel)){
        // 條號範圍
        const rm=sel.match(/(\d+)\s*[-~]\s*(\d+)/);
        const startArt=parseInt(rm[1]),endArt=parseInt(rm[2]);
        for(const l of targets){
          const artN=Math.floor((l.articleNumber||art2n(l.article||''))/1000);   // 使用者輸入的是主條號
          if(artN>=startArt&&artN<=endArt){l[level]=newVal;await dp('laws',l);count++;}
        }
      } else {
        // 序號選擇
        const idxList=sel.split(/[,，]/).map(s=>parseInt(s.trim())-1).filter(i=>!isNaN(i)&&i>=0&&i<childList.length);
        const selected=idxList.map(i=>childList[i]);
        if(!selected.length){toast('未選擇任何項目');return;}
        for(const l of targets){
          if(selected.includes(l[childLevel]||'')){l[level]=newVal;await dp('laws',l);count++;}
        }
      }
    }
  }

  toast('已套用「'+newVal+'」('+levelName+'）到 '+count+' 條');
  openLawGroup(lawName);
  }catch(e){ logError('openChapterMgr',e); }}


// ══ bulk.js — 大量貼題 ════════════════════════════════
async function startNumberMode(){  try{
  const qs=await da('questions');
  const pool=(qs||[]).filter(q=>q.type==='mc'&&q.isNumberQ);
  if(!pool.length){toast('請先在題目編輯中勾選「數字魔鬼」題目');return;}
  toast('數字魔鬼：共 '+pool.length+' 題');
  startQWithPool(pool,'number');
  }catch(e){ logError('startNumberMode',e); }}

// ══ bulk.js — 大量貼題 ════════════════════════════════
// 依賴：db.js, utils.js, parser.js

// ── 標記語法說明彈窗 ──────────────────────────────────────
function showMarkupHelp(){
  const ov = document.createElement('div');
  ov.className = 'ov on';
  ov.id = 'markup-help-ov';
  ov.onclick = (e)=>{ if(e.target===ov) ov.remove(); };
  ov.innerHTML = `
    <div class="sh" onclick="event.stopPropagation()" style="max-width:480px">
      <div class="shdl"></div>
      <div class="sht"><span>標記語法說明</span>
        <button class="shx" onclick="document.getElementById('markup-help-ov').remove()">✕</button></div>
      <div style="padding:4px 18px 24px">
        <p class="mkhelp-intro">在題幹或選項中使用以下標記，答題時會自動呈現對應樣式：</p>
        <div class="mkhelp-list">
          <div class="mkhelp-row">
            <code class="mkhelp-code">___</code>
            <span class="mkhelp-arrow">→</span>
            <span class="mkhelp-demo">填空底線（3 個以上底線）</span>
          </div>
          <div class="mkhelp-row">
            <code class="mkhelp-code">[[提示]]</code>
            <span class="mkhelp-arrow">→</span>
            <span class="mkhelp-demo">填空（含淡色提示字）</span>
          </div>
          <div class="mkhelp-row">
            <code class="mkhelp-code">**文字**</code>
            <span class="mkhelp-arrow">→</span>
            <span class="mkhelp-demo"><span style="text-decoration:underline;text-underline-offset:3px;font-weight:600">畫線強調</span></span>
          </div>
          <div class="mkhelp-row">
            <code class="mkhelp-code">//文字//</code>
            <span class="mkhelp-arrow">→</span>
            <span class="mkhelp-demo"><strong style="font-weight:800">粗體</strong></span>
          </div>
          <div class="mkhelp-row">
            <code class="mkhelp-code">&gt;&gt; 文字</code>
            <span class="mkhelp-arrow">→</span>
            <span class="mkhelp-demo">段落首行縮排兩格（放行首）</span>
          </div>
        </div>
        <div class="mkhelp-eg">
          <div class="mkhelp-eg-title">範例</div>
          <div class="mkhelp-eg-in">&gt;&gt; 國父姓 **孫**，______ 是他的字，//三民主義// 為其思想。</div>
          <div class="mkhelp-eg-out"><span style="display:inline">　　</span>國父姓 <span style="text-decoration:underline;text-underline-offset:3px;font-weight:600">孫</span>，<span style="display:inline-block;min-width:54px;border-bottom:2px solid currentColor;margin:0 3px"></span> 是他的字，<strong style="font-weight:800">三民主義</strong> 為其思想。</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
}

function parseBulk(){
  try{
    const biEl=document.getElementById('bi-text');
    if(!biEl){toast('找不到輸入框');return;}
    const text=biEl.value||'';
    if(!text.trim()){toast('請先在下方文字框貼入題目文字');return;}
    const parsed=parseBulkText(text);
    S.bulkParsed=parsed;
    // 套用答案列
    const ansStr=(document.getElementById('bi-ans')||{}).value||'';
    const ansMap=parseAnswerStr(ansStr);
    // 讀取編/章/節（批次套用到所有題目）
    const biPart   =(document.getElementById('bi-part'   )||{}).value||'';
    const biChapter=(document.getElementById('bi-chapter')||{}).value||'';
    const biSection=(document.getElementById('bi-section')||{}).value||'';
    parsed.forEach((q,i)=>{
      const n=parseInt(q.num)||i+1;
      if(ansMap[n]) q.answer=ansMap[n];
      if(biPart)    q.part   =biPart.trim();
      if(biChapter) q.chapter=biChapter.trim();
      if(biSection) q.section=biSection.trim();
    });
    const mc=parsed.filter(q=>q.type==='mc').length;
    const es=parsed.filter(q=>q.type==='es').length;
    const noAns=parsed.filter(q=>q.type==='mc'&&!q.answer).length;
    // 編/章/節標籤
    const hierTags=
      (biPart   ?'<span class="tag" style="background:var(--org2);color:var(--org);font-weight:700">📙'+biPart   +'</span>':'')+
      (biChapter?'<span class="tag" style="background:var(--pur2);color:var(--pur);font-weight:700">📗'+biChapter+'</span>':'')+
      (biSection?'<span class="tag" style="background:rgba(31,111,235,0.15);color:var(--acc);font-weight:700">📘'+biSection+'</span>':'');
    // 顯示統計
    const statsEl=document.getElementById('bulk-stats');
    if(statsEl) statsEl.innerHTML=
      '<span class="tag" style="background:var(--acc2);color:#fff">'+parsed.length+' 題</span>'+
      '<span class="tag" style="background:#1f3a5f;color:var(--acc)">選擇 '+mc+'</span>'+
      '<span class="tag" style="background:var(--red2);color:var(--red)">申論 '+es+'</span>'+
      (noAns?'<span class="tag" style="background:var(--org2);color:var(--org)">⚠ '+noAns+' 題未填答案</span>':'')+
      (hierTags?'<div style="margin-top:4px">'+hierTags+'</div>':'');
    // 顯示預覽（含編/章/節標籤）
    const prevEl=document.getElementById('prev-list');
    if(prevEl) prevEl.innerHTML=parsed.map(function(q){
      const typeLabel=q.type==='mc'?'選擇題':'申論題';
      const ansLabel=q.answer?' · 答案:'+q.answer:'';
      const optLabel=q.type==='mc'?'<div class="pi-o">選項：'+Object.keys(q.options).join(' ')+'</div>':'';
      const cls=q.answer||q.type==='es'?'ok':'warn';
      const hierLabel=
        (q.part   ?'<span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--org2);color:var(--org)">📙'+esc(q.part)+'</span> ':'')+
        (q.chapter?'<span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--pur2);color:var(--pur)">📗'+esc(q.chapter)+'</span> ':'')+
        (q.section?'<span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:rgba(31,111,235,0.15);color:var(--acc)">📘'+esc(q.section)+'</span> ':'');
      return '<div class="pi '+cls+'">'+
        '<div class="pi-n">第'+q.num+'題 · '+typeLabel+ansLabel+'</div>'+
        (hierLabel?'<div style="margin-top:2px">'+hierLabel+'</div>':'')+
        '<div class="pi-s">'+esc(q.stem||'')+'</div>'+
        optLabel+'</div>';
    }).join('');
    // 顯示結果區
    const resEl=document.getElementById('bulk-result');
    if(resEl) resEl.classList.remove('hide');
    if(!parsed.length) toast('解析結果為0題，請確認格式');
    else toast('解析完成：'+parsed.length+' 題 ✓');
  }catch(err){
    toast('解析錯誤：'+err.message);
    console.error('parseBulk error:',err);
  }
}

async function importBulk(){
  if(!S.bulkParsed.length){toast('請先解析題目');return;}
  const sub=(document.getElementById('bi-sub')||{}).value||'';
  const yr=(document.getElementById('bi-yr')||{}).value||'';
  const ex=(document.getElementById('bi-ex')||{}).value||'';
  const items=S.bulkParsed.map(q=>({
    ...q,
    subject: sub||q.subject||'',
    year:    yr||q.year||'',
    exam:    ex||q.exam||'',
    searchBlob: ((q.stem||'')+' '+(q.groupStem||'')+' '+(sub||q.subject||'')+' '+
      (yr||q.year||'')+' '+(ex||q.exam||'')+' '+(q.num||'')+' '+
      (q.keywords||[]).join(' ')).toLowerCase(),
  }));
  try{
    // ── 防重複：以年度+考試別+科目+題號 判斷 ──────────────────
    const existing=await da('questions');
    const dupKey=q=>(q.year||'')+'|'+(q.exam||'')+'|'+(q.subject||'')+'|'+(q.num||'');
    const existSet=new Set(existing.map(dupKey));
    const dupItems=items.filter(q=>existSet.has(dupKey(q)));
    if(dupItems.length>0){
      const go=confirm('發現 '+dupItems.length+' 題已存在（相同年度+考試別+科目+題號）。\n\n確定 → 全部匯入（保留原有）\n取消 → 略過重複，只匯入 '+(items.length-dupItems.length)+' 題');
      if(!go){
        const newItems=items.filter(q=>!existSet.has(dupKey(q)));
        if(!newItems.length){toast('無新題目可匯入');return;}
        await bulkPut('questions',newItems);
        toast('已匯入 '+newItems.length+' 題（略過 '+dupItems.length+' 筆重複）✓');
        S.bulkParsed=[];
        document.getElementById('bulk-result').classList.add('hide');
        renderHome(); return;
      }
    }
    await bulkPut('questions',items);
    toast('已匯入 '+items.length+' 題 ✓');
    S.bulkParsed=[];
    document.getElementById('bulk-result').classList.add('hide');
    renderHome();
  }catch(err){ toast('匯入失敗：'+err.message); }
}

function clearBulk(){
  document.getElementById('bi-text').value='';
  document.getElementById('bi-ans').value='';
  const biPart=document.getElementById('bi-part'); if(biPart) biPart.value='';
  const biCh=document.getElementById('bi-chapter'); if(biCh) biCh.value='';
  const biSec=document.getElementById('bi-section'); if(biSec) biSec.value='';
  document.getElementById('bulk-result').classList.add('hide');
  S.bulkParsed=[];
}

// ════════ 公開 API ════════
// 新程式碼請使用 DataMod.xxx；window 別名供 index.html 與動態 onclick 相容
const DataMod = {
  renderHome,
  closeHeatmapOv,
  setF,
  renderList,
  closeAdd,
  showAdd,
  setQT,
  toggleGroupStem,
  saveQ,
  saveQAndContinue,
  toggleListSelectMode,
  confirmListSelDel, openBatchEdit, applyBatchEdit, openOfficialLaw,
  dupAction,
  openLawSortMenu,
  closeLawSortMenu,
  pickLawSort,
  toggleDbSelectMode,
  confirmDbSelDel,
  setLC,
  renderDB,
  openLawGroup,
  exitLaw,
  toggleLvFav,
  toggleLvMenu,
  closeLvMenu,
  toggleLvMode,
  addLawInGroup,
  editLawGroupInfo,
  quizFromLaw,
  showAddLaw,
  closeLawSh,
  switchLawMode,
  toggleSOPMode,
  onLawImgSelect,
  saveLaw,
  openBulkQ,
  closeBulkQ,
  showBulkLaw,
  closeBulkLaw,
  prevBulkLaw,
  importBulkLaw,
  showLawPop,
  closeLawPop,
  openChapterMgr,
  startNumberMode,
  parseBulk,
  importBulk,
  clearBulk,
  applyBulkSelectLaw,
  openBulkDelLaw,
  applyBulkSelectQ,
  delLawGroup,
  delLaw,
  editLawInView,
  openHeatmapOv,
  openImgViewer,
  previewBulkDelLaw,
  previewBulkDelQ,
  openBulkDelQ,
  scrollToChapter,
  setAns,
  startSingleQ,
  toggleStar,
  toggleLawSort,
  rebuildLawIndex,
  formatYearInput,
  editQ,
  showSearchHelp,
  openYearGroup,
  openExamGroup,
  openQGroup,
  showMarkupHelp,
};
window.DataMod = DataMod;
Object.assign(window, DataMod);
// index.html 的搜尋框 oninput 直接引用：
window._debouncedRenderList = _debouncedRenderList;
window._debouncedRenderDB   = _debouncedRenderDB;

})();
