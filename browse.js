// ══ browse.js — 題目閱覽 ══════════════════════════════
// 依賴：db.js, utils.js

let _browseQs=[];

async function openBrowse(){
  _browseQs=await da('questions');
  const subs=[...new Set(_browseQs.map(q=>q.subject).filter(Boolean))].sort();
  const chEl=document.getElementById('br-chips');
  if(chEl)chEl.innerHTML='<button class="chip on" onclick="setBrFilter(this,\'all\')">全部科目</button>'+
    subs.map(s=>`<button class="chip" onclick="setBrFilter(this,'${esc(s)}')">${esc(s)}</button>`).join('');
  const years=[...new Set(_browseQs.map(q=>q.year).filter(Boolean))].sort().reverse();
  const yrEl=document.getElementById('br-year-chips');
  if(yrEl)yrEl.innerHTML='<button class="chip on" onclick="setBrYear(this,\'\')">全部年度</button>'+
    years.map(y=>`<button class="chip" onclick="setBrYear(this,'${esc(y)}')">${esc(y)}</button>`).join('');
  window._brFilter='all';window._brYear='';
  const kwEl=document.getElementById('br-search');if(kwEl)kwEl.value='';
  browseSearch();
  document.getElementById('browse-ov').style.display='flex';
}

function closeBrowse(){document.getElementById('browse-ov').style.display='none';}

function browseSearch(){
  const kw=(document.getElementById('br-search')?.value||'').toLowerCase().trim();
  const f=window._brFilter||'all',yr=window._brYear||'';
  let fl=_browseQs.filter(q=>{
    if(f!=='all'&&q.subject!==f)return false;
    if(yr&&q.year!==yr)return false;
    if(kw){const h=((q.stem||'')+(q.subject||'')+(q.year||'')+(q.exam||'')+(q.keywords||[]).join(' ')).toLowerCase();if(!h.includes(kw))return false;}
    return true;
  }).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const el=document.getElementById('br-list');if(!el)return;
  if(!fl.length){el.innerHTML='<div class="empty"><span class="ic">🔍</span><span>沒有符合的題目</span></div>';return;}
  el.innerHTML=fl.map(q=>{
    const rl=(q.relatedLaws||[]).map(l=>`<span class="tag" style="color:var(--pur);cursor:pointer" onclick="showLawPop('${esc(l.ref||l.lawName||'')}')">⚖ ${esc(l.ref||l.lawName||'')}</span>`).join('');
    return `<div class="card" style="margin:5px 12px">
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:6px;flex-wrap:wrap">
        <span class="badge ${q.type==='mc'?'bmc':'bes'}">${q.type==='mc'?'選擇':'申論'}</span>
        <span class="tag">${esc(q.subject||'未分類')}</span>
        ${q.year?`<span class="tag">${esc(q.year)}</span>`:''}
        ${q.exam?`<span class="tag">${esc(q.exam)}</span>`:''}
        ${q.num?`<span class="tag">第${esc(q.num)}題</span>`:''}
        ${q.starred?'<span style="color:var(--org)">⭐</span>':''}
      </div>
      <div style="font-size:14px;line-height:1.65;color:var(--t1);margin-bottom:6px;word-break:break-all">${esc(q.stem||'')}</div>
      ${q.type==='mc'?Object.entries(q.options||{}).map(([k,v])=>`<div style="font-size:12px;color:var(--t2);padding:1px 0">(${k}) ${esc(v)}</div>`).join(''):''}
      ${q.answer?`<div style="font-size:12px;color:var(--grn);margin-top:4px;font-weight:600">答案：${esc(q.answer)}</div>`:''}
      ${q.answerEs?`<div style="font-size:12px;color:var(--t2);margin-top:3px">解析：${esc(q.answerEs).slice(0,80)}…</div>`:''}
      ${rl?`<div style="margin-top:6px">${rl}</div>`:''}
    </div>`;
  }).join('');
}

function setBrFilter(el,v){
  document.querySelectorAll('#br-chips .chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');window._brFilter=v;browseSearch();
}

function setBrYear(el,yr){
  document.querySelectorAll('#br-year-chips .chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');
  S._brYear=yr;
  browseSearch();
}

function renderBrowse(){
  const el=document.getElementById('browse-list');
  if(!el)return;
  if(!_browseFiltered.length){
    el.innerHTML='<div class="empty"><span class="ic">🔍</span><span>沒有符合的題目</span></div>';return;
  }
  el.innerHTML=_browseFiltered.map(q=>{
    const laws=(q.relatedLaws||[]).map(l=>
      `<span style="color:var(--pur);cursor:pointer;font-size:11px;text-decoration:underline"
        onclick="openLawPopupByRef('${esc(l.ref||l.lawName||'')}')">⚖ ${esc(l.ref||l.lawName||'')}</span>`
    ).join(' ');
    return `<div style="background:var(--bg1);border:1px solid var(--bd);border-radius:var(--r);padding:12px;margin-bottom:7px">
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px;align-items:center">
        <span class="badge ${q.type==='mc'?'bmc':'bes'}">${q.type==='mc'?'選擇':'申論'}</span>
        <span class="tag">${esc(q.subject||'未分類')}</span>
        ${q.year?`<span class="tag">${esc(q.year)}</span>`:''}
        ${q.exam?`<span class="tag">${esc(q.exam)}</span>`:''}
        ${q.num?`<span class="tag">第${esc(q.num)}題</span>`:''}
        ${q.starred?'<span style="color:var(--org)">⭐</span>':''}
      </div>
      <div style="font-size:14px;line-height:1.7;color:var(--t1);margin-bottom:8px">${esc(q.stem||'')}</div>
      ${q.type==='mc'?`<div style="font-size:12px;color:var(--t2)">${Object.entries(q.options||{}).map(([k,v])=>`<div>(${k}) ${esc(v)}</div>`).join('')}</div>`:''}
      ${q.answer?`<div style="margin-top:6px;font-size:12px;font-weight:700;color:var(--grn)">答案：${esc(q.answer)}</div>`:''}
      ${q.answerEs?`<div style="margin-top:6px;font-size:12px;color:var(--t2);line-height:1.6">💡 ${esc(q.answerEs)}</div>`:''}
      ${(q.relatedLaws||[]).length?`<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${laws}</div>`:''}
      ${(q.keywords||[]).length?`<div style="margin-top:6px">${q.keywords.map(k=>`<span class="tag">${esc(k)}</span>`).join('')}</div>`:''}
    </div>`;
  }).join('');
}

