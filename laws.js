// ══ laws.js — 資料庫（法條）管理 ══════════════════════════
// 依賴：db.js, utils.js, parser.js

async function renderDB(){
  const ls=await da('laws');
  const kw=(document.getElementById('lsi')?.value||'').toLowerCase().trim();
  let fl=ls.filter(l=>{
    if(S.lawCat!=='all'&&l.category!==S.lawCat)return false;
    if(kw){const h=((l.lawName||'')+(l.article||'')+(l.content||'')+(l.keywords||[]).join(' ')).toLowerCase();if(!h.includes(kw))return false;}
    return true;
  });

  // 按法規名稱分組，只顯示法規名稱（摺疊）
  const byName={};
  fl.forEach(l=>{const n=l.lawName||'未分類';if(!byName[n])byName[n]=[];byName[n].push(l);});

  const el=document.getElementById('llist');
  if(!fl.length){el.innerHTML='<div class="empty"><span class="ic">🗄</span><span>尚無資料，點右上角新增</span></div>';return;}

  el.innerHTML=Object.entries(byName).map(([name,laws])=>{
    const cat=laws[0].category||'statute';
    const catLabel={'statute':'法律條文','sop':'SOP','supplement':'補充資料','interpretation':'函釋','law':'法律','rule':'細則','regulation':'規範'}[cat]||cat;
    const favCount=laws.filter(l=>l.favorite).length;
    return `<div class="card" style="cursor:pointer;margin-bottom:6px" onclick="openLawGroup('${esc(name)}')">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:20px">${cat==='sop'?'📋':cat==='supplement'?'📄':'⚖'}</span>
        <div style="flex:1">
          <div style="font-size:15px;font-weight:700;color:var(--t0)">${esc(name)}</div>
          <div style="font-size:11px;color:var(--t2);margin-top:2px">${catLabel} · ${laws.length} 條${favCount?` · ⭐${favCount}`:''}</div>
        </div>
        <span style="color:var(--t2);font-size:18px">›</span>
      </div>
    </div>`;
  }).join('');
}

async function renderLaws(){ return renderDB(); }

function setLC(el,v){document.querySelectorAll('#lchips .chip').forEach(c=>c.classList.remove('on'));el.classList.add('on');S.lawCat=v;renderLaws();}

async function openLawGroup(lawName){
  const allLaws=await da('laws');
  const laws=allLaws.filter(l=>l.lawName===lawName)
    .sort((a,b)=>(a.articleNumber||0)-(b.articleNumber||0));
  if(!laws.length)return;
  const allNames=[...new Set(allLaws.map(l=>l.lawName).filter(Boolean))];
  const others=allNames.filter(n=>n!==lawName).slice(0,8);
  const cat=laws[0].category||'statute';
  const icon=cat==='sop'?'📋':cat==='supplement'?'📄':'⚖';
  document.getElementById('lv-name').textContent=icon+' '+lawName;
  const sb=document.getElementById('lv-star');
  const favN=laws.filter(l=>l.favorite).length;
  sb.textContent=favN?'★':'☆';
  sb.style.color=favN?'var(--org)':'var(--t2)';
  sb.onclick=async()=>{
    const nf=laws.filter(l=>l.favorite).length>0;
    for(const l of laws){l.favorite=!nf;await dp('laws',l);}
    openLawGroup(lawName);
  };
  // 跳轉 chips
  const jumpHtml=others.map(n=>`<button class="chip" style="flex-shrink:0;font-size:11px" onclick="openLawGroup('${esc(n)}')">${esc(n)}</button>`).join('');
  // 條文列表
  const arts=laws.map(l=>`
    <div style="margin-bottom:12px;padding:12px;background:var(--bg2);border-radius:8px;border-left:3px solid var(--pur2)">
      <div style="font-size:14px;font-weight:700;color:var(--pur);margin-bottom:6px;display:flex;align-items:center;justify-content:space-between">
        <span>${esc(l.article||'')}${l.title?' — '+esc(l.title):''}</span>
        <button onclick="editLawInView(${l.id})" style="background:none;border:none;color:var(--t2);font-size:12px;cursor:pointer">✏</button>
      </div>
      <div style="font-size:14px;line-height:1.85;color:var(--t1)">${br(l.content||'')}</div>
      ${(l.keywords||[]).length?'<div style="margin-top:8px">'+l.keywords.map(k=>`<span class="tag">${esc(k)}</span>`).join('')+'</div>':''}
      ${(l.relatedLaws||[]).length?
        '<div style="margin-top:9px;font-size:11px;color:var(--t2)">🔗 關聯法條：</div>'+
        l.relatedLaws.map(r=>`<button class="chip" style="font-size:11px;margin:2px" onclick="showLawPop('${esc(r.ref||r.lawName||'')}')">⚖ ${esc(r.ref||r.lawName||'')}</button>`).join('')
        :''}
    </div>`).join('');
  document.getElementById('lbody').innerHTML=
    `<div style="padding:4px 0 10px">
      ${others.length?'<div class="sec" style="padding:0 0 4px;font-size:11px">快速跳轉其他法規</div><div style="overflow-x:auto;display:flex;gap:6px;padding:6px 0">'+jumpHtml+'</div>':''}
      <div class="sec" style="padding:8px 0 6px;font-size:11px">${esc(lawName)} · ${laws.length} 條</div>
      ${arts}
    </div>`;
  document.getElementById('lv').style.display='flex';
}

async function openLaw(id){
  const l=await dg('laws',id);if(!l)return;S.curLaw=l;
  document.getElementById('lv-name').textContent=(l.lawName||'')+(l.article?' '+l.article:'');
  const starBtn=document.getElementById('lv-star');
  starBtn.textContent=l.favorite?'★':'☆';
  starBtn.style.color=l.favorite?'var(--org)':'var(--t2)';
  starBtn.style.background=l.favorite?'var(--org2)':'var(--bg2)';
  starBtn.style.borderColor=l.favorite?'var(--org)':'var(--bd)';
  const qs=await da('questions');
  const related=qs.filter(q=>(q.relatedLaws||[]).some(rl=>rl.lawId===id));
  document.getElementById('lbody').innerHTML=
    `<div class="labt">${esc(l.article||'')}${l.title?' — '+esc(l.title):''}</div>`+
    `<div class="lcntb">${br(l.content)}</div>`+
    ((l.keywords||[]).length?'<div style="margin-top:11px">'+l.keywords.map(k=>`<span class="tag">${esc(k)}</span>`).join('')+'</div>':'')+
    (l.source?`<div style="margin-top:7px;font-size:11px;color:var(--t2)">來源：${esc(l.source)}</div>`:'')+
    (related.length?`<div class="sec" style="padding:14px 0 7px">相關考題（${related.length}題）</div>`+
      related.map(q=>`<div class="qc" onclick="editQ(${q.id});exitLaw()"><div class="qst">${esc(q.stem||'')}</div><div style="font-size:11px;color:var(--t2);margin-top:3px">${esc(q.subject||'')} ${esc(q.year||'')}</div></div>`).join(''):'');
  document.getElementById('lv').style.display='flex';
}

function exitLaw(){document.getElementById('lv').style.display='none';}

async function toggleLawStar(){
  if(!S.curLaw)return;S.curLaw.favorite=!S.curLaw.favorite;await dp('laws',S.curLaw);
  const starBtn=document.getElementById('lv-star');
  starBtn.textContent=S.curLaw.favorite?'★':'☆';
  starBtn.style.color=S.curLaw.favorite?'var(--org)':'var(--t2)';
  starBtn.style.background=S.curLaw.favorite?'var(--org2)':'var(--bg2)';
  starBtn.style.borderColor=S.curLaw.favorite?'var(--org)':'var(--bd)';
  toast(S.curLaw.favorite?'已收藏':'已取消收藏');
}

async function toggleLawFav(id){
  const l=await dg('laws',id);if(!l)return;l.favorite=!l.favorite;await dp('laws',l);renderLaws();toast(l.favorite?'已收藏':'已取消收藏');}

function editCurLaw(){if(S.curLaw)showAddLaw(S.curLaw);}

async function quizFromLaw(){
  if(!S.curLaw)return;exitLaw();
  const qs=await da('questions');
  const id=S.curLaw.id;
  const pool=qs.filter(q=>(q.relatedLaws||[]).some(rl=>rl.lawId===id));
  if(!pool.length){toast('此法條尚無關聯題目');return;}
  startQWithPool(pool,'law');
}

async function editLawInView(id){
  const l = await dg('laws',id);
  if(l) showAddLaw(l);
}

async function showAddLaw(l, editId){
  if(editId&&!l){l=await dg('laws',editId);}
  S.editLawId=l?l.id:null;
  document.getElementById('law-sh-t').textContent=l?'編輯法條':'新增法條';
  document.getElementById('l-name').value=l?.lawName||'';
  document.getElementById('l-art').value=l?.article||'';
  document.getElementById('l-cat').value=l?.category||'law';
  document.getElementById('l-title').value=l?.title||'';
  document.getElementById('l-content').value=l?.content||'';
  document.getElementById('l-kw').value=(l?.keywords||[]).join(',');
  document.getElementById('l-src').value=l?.source||'';
  if(document.getElementById('l-related'))
    document.getElementById('l-related').value=(l?.relatedLaws||[]).map(r=>r.ref||'').filter(Boolean).join(',');
  if(document.getElementById('l-related'))document.getElementById('l-related').value=(l?.relatedLawRefs||[]).map(r=>(r.dir==='parent'?'↑':r.dir==='child'?'↓':r.dir==='auth'?'⇌':'→')+r.ref).join(',');
  document.getElementById('law-ov').classList.add('on');
}

function closeLawSh(){document.getElementById('law-ov').classList.remove('on');S.editLawId=null;}

async function saveLaw(){
  const content=document.getElementById('l-content').value.trim();
  if(!content){toast('請填寫法條內容');return;}
  const article=document.getElementById('l-art').value.trim();
  const relStr=(document.getElementById('l-related')?.value||'').trim();
  const relatedLaws=relStr?relStr.split(/[,，]/).map(s=>({ref:s.trim()})).filter(r=>r.ref):[];
  const lawName=document.getElementById('l-name').value.trim();
  // 自動偵測母子法連結
  const autoLinks=autoDetectLawLinks(content,lawName);
  // 合併手動輸入的連結
  const manualLinksStr=document.getElementById('l-links')?.value||'';
  const manualLinks=manualLinksStr.split(/[,，]/).map(s=>s.trim()).filter(Boolean)
    .map(s=>({ref:s,type:'related'}));
  const relatedLawLinks=[...autoLinks,...manualLinks];

  const data={lawName,article,articleNumber:art2n(article),
    category:document.getElementById('l-cat').value,
    title:document.getElementById('l-title').value.trim(),
    content,keywords:kwArr(document.getElementById('l-kw').value),
    tags:[],notes:'',highlights:[],relatedQuestions:[],
    source:document.getElementById('l-src').value.trim(),
    relatedLawLinks,
    favorite:false,createdAt:Date.now(),updatedAt:Date.now()};
  if(S.editLawId){
    const ex=await dg('laws',S.editLawId);
    data.id=S.editLawId;data.favorite=ex?.favorite||false;data.createdAt=ex?.createdAt||Date.now();
  }
  await dp('laws',data);
  closeLawSh();toast(S.editLawId?'法條已更新':'法條已儲存');
  renderLaws();if(S.curLaw?.id===S.editLawId)openLaw(S.editLawId);
}

async function delLaw(id){cfm('刪除法條','確定要刪除這條法條嗎？',async()=>{await dd('laws',id);toast('已刪除');renderLaws();});}

function showBulkLaw(){document.getElementById('blaw-ov').classList.add('on');}

function closeBulkLaw(){document.getElementById('blaw-ov').classList.remove('on');}

function prevBulkLaw(){
  const text=document.getElementById('bl-text').value;
  const name=document.getElementById('bl-name').value||'未命名';
  const parsed=parseLawText(text,name);
  document.getElementById('bl-prev').textContent=`預計匯入 ${parsed.length} 條`;
}

async function importBulkLaw(){
  const text=document.getElementById('bl-text').value;
  if(!text.trim()){toast('請貼入法條文字');return;}
  const name=document.getElementById('bl-name').value.trim()||'未命名';
  const cat=document.getElementById('bl-cat').value;
  const src=document.getElementById('bl-src').value.trim();
  const items=parseLawText(text,name,cat,src);
  if(!items.length){toast('解析結果為0條，請確認格式（需有「第X條」）');return;}
  await bulkPut('laws',items);
  toast(`已匯入 ${items.length} 條法條`);
  closeBulkLaw();
  renderLaws();
}

async function showLawPop(ref){
  if(!ref)return;
  const laws=await da('laws');
  const artM=ref.match(/§?第?(\d+)條?/);
  const artNum=artM?parseInt(artM[1]):null;
  const namePart=ref.replace(/§?第?\d+條?/,'').replace(/§\d+/,'').trim();
  let matched=laws.filter(l=>{
    const ln=l.lawName||'';
    let nm=!namePart||ln.includes(namePart)||namePart.includes(ln);
    if(!nm){const cs=namePart.replace(/[法條例規則]/g,'').split('');if(cs.length>=2)nm=cs.every(c=>ln.includes(c));}
    if(!nm)return false;
    return artNum===null||l.articleNumber===artNum;
  });
  if(matched.length>1){const ex=matched.filter(l=>(l.lawName||'').includes(namePart));if(ex.length)matched=ex;}
  const el=document.getElementById('lawpop-ov');if(!el)return;
  if(!matched.length){
    document.getElementById('lawpop-title').textContent=ref;
    document.getElementById('lawpop-body').innerHTML=`<span style="color:var(--t2)">查無「${esc(ref)}」，請先在資料庫新增。</span>`;
    document.getElementById('lawpop-related').innerHTML='';
    el.style.display='flex';return;
  }
  const l=matched[0];
  document.getElementById('lawpop-title').textContent=`${l.lawName||''} ${l.article||''}`;
  document.getElementById('lawpop-body').innerHTML=br(l.content||'');
  const rl=(l.relatedLaws||[]).map(r=>`<button class="chip" style="font-size:11px" onclick="showLawPop('${esc(r.ref||r.lawName||'')}')">⚖ ${esc(r.ref||r.lawName||'')}</button>`).join('');
  document.getElementById('lawpop-related').innerHTML=rl?`<div style="margin-top:8px;font-size:12px;color:var(--t2)">關聯法條：</div><div style="flex-wrap:wrap;display:flex;gap:4px;margin-top:3px">${rl}</div>`:'';
  el.style.display='flex';
}

function closeLawPop(){document.getElementById('lawpop-ov').style.display='none';}

function autoDetectLawLinks(content, lawName){
  const links=[];
  // 偵測「依XXX第X條」「根據XXX」等授權來源
  const authRE=/依(?:據)?[《【]?([^，。；\n《》【】]{2,15})[》】]?第([一二三四五六七八九十百千\d]+)條/g;
  let m;
  while((m=authRE.exec(content))!==null){
    const ref=m[1]+'第'+m[2]+'條';
    if(!links.find(l=>l.ref===ref)) links.push({ref,type:'auth'});
  }
  // 偵測「施行細則」「子法」關鍵字
  if(/施行細則/.test(content)) links.push({ref:lawName+'施行細則',type:'child'});
  if(/辦法/.test(content)&&/另定/.test(content)) links.push({ref:'（相關辦法）',type:'child'});
  return links;
}


// ── Shims（相容舊版 onclick）──────────────────────────────
function openLawPopupByRef(ref){ showLawPop(ref); }
function showQLaws(qid){ toast('請在編輯題目中查看關聯法條'); }
