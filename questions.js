// ══ questions.js — 題目管理 ════════════════════════════
// 依賴：db.js, utils.js

let _dupResolve=null;

async function renderHome(){
  const[qs,ls,ats]=await Promise.all([da('questions'),da('laws'),da('attempts')]);
  const now=new Date();
  document.getElementById('h-date').textContent=now.toLocaleDateString('zh-TW',{month:'long',day:'numeric',weekday:'short'});
  const td=today(),tAts=ats.filter(a=>a.date?.startsWith(td));
  const wids=getWrong(qs,ats);
  document.getElementById('hs-q').textContent=qs.length;
  document.getElementById('hs-l').textContent=ls.length;
  document.getElementById('hs-t').textContent=tAts.length;
  document.getElementById('hs-w').textContent=wids.size;
  const plan=document.getElementById('h-plan');
  if(!qs.length)plan.textContent='尚未新增題目，點「大量貼題」開始！';
  else if(wids.size>0)plan.textContent=`有 ${wids.size} 題錯題待複習`;
  else plan.textContent=`題庫 ${qs.length} 題 · 法條 ${ls.length} 條`;
  const recent=[...qs].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,4);
  document.getElementById('h-recent').innerHTML=recent.length?
    recent.map(q=>`<div class="qc" onclick="editQ(${q.id})"><div class="qch"><span class="badge ${q.type==='mc'?'bmc':'bes'}">${q.type==='mc'?'選擇':'申論'}</span><span class="tag">${esc(q.subject||'未分類')}</span>${q.starred?'<span style="color:var(--org)">⭐</span>':''}</div><div class="qst">${esc(q.stem||'')}</div></div>`).join(''):
    '<div class="empty"><span class="ic">📝</span><span>尚無題目</span></div>';
  // Update datalists
  const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))];
  ['f-subs','bi-subs'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=subs.map(s=>`<option value="${esc(s)}">`).join('');});
}

async function renderList(){
  const[qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))].sort();
  const sc=document.getElementById('schips');
  if(sc)sc.innerHTML='<button class="chip'+(S.subF==='all'?' on':'')+'" onclick="setSF(this,\'all\')">全部科目</button>'+subs.map(s=>`<button class="chip${S.subF===s?' on':''}" onclick="setSF(this,'${esc(s)}')">${esc(s)}</button>`).join('');
  const kw=(document.getElementById('si')?.value||'').toLowerCase().trim();
  const wids=getWrong(qs,ats);
  let fl=qs.filter(q=>{
    if(S.subF!=='all'&&q.subject!==S.subF)return false;
    if(S.filter==='mc'&&q.type!=='mc')return false;
    if(S.filter==='es'&&q.type!=='es')return false;
    if(S.filter==='wrong'&&!wids.has(q.id))return false;
    if(S.filter==='star'&&!q.starred)return false;
    if(kw){const h=((q.stem||'')+(q.subject||'')+(q.keywords||[]).join(' ')+(q.tags||'')).toLowerCase();if(!h.includes(kw))return false;}
    return true;
  }).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  document.getElementById('lc').textContent=`共 ${fl.length} 題`;
  const el=document.getElementById('qlist');
  if(!fl.length){el.innerHTML='<div class="empty"><span class="ic">🔍</span><span>沒有符合的題目</span></div>';return;}
  el.innerHTML=fl.map(q=>{
    const qa=ats.filter(a=>a.qid===q.id&&a.correct!==null);
    const acc=qa.length>0?Math.round(qa.filter(a=>a.correct).length/qa.length*100):null;
    const iw=wids.has(q.id);
    const kws=(q.keywords||[]).slice(0,3).map(k=>`<span class="tag">${esc(k)}</span>`).join('');
    return `<div class="qc ${iw?'wrong':''} ${q.starred?'star':''}"><div class="qch">
      <span class="badge ${q.type==='mc'?'bmc':'bes'}">${q.type==='mc'?'選擇':'申論'}</span>
      <span class="tag">${esc(q.subject||'未分類')}</span>
      ${q.year?`<span class="tag">${esc(q.year)}</span>`:''}
      ${q.starred?'<span style="color:var(--org)">⭐</span>':''}
      ${acc!==null?`<span class="tag" style="color:${acc>=60?'var(--grn)':'var(--red)'}">${acc}%</span>`:''}
      ${kws}</div>
      <div class="qst">${esc(q.stem||'')}</div>
      <div class="qa">
        <button class="qabn" onclick="editQ(${q.id})">✏ 編輯</button>
        <button class="qabn" onclick="toggleStar(${q.id})">${q.starred?'★ 取消':'☆ 收藏'}</button>
        ${(q.relatedLaws||[]).length?`<button class="qabn" style="color:var(--pur)" onclick="showQLaws(${q.id})">⚖ 法條</button>`:''}
        <button class="qabn" style="color:var(--red)" onclick="delQ(${q.id})">🗑</button>
      </div></div>`;
  }).join('');
}

function setF(el,v){document.querySelectorAll('#fchips .chip').forEach(c=>c.classList.remove('on'));el.classList.add('on');S.filter=v;renderList();}

function setSF(el,v){document.querySelectorAll('#schips .chip').forEach(c=>c.classList.remove('on'));el.classList.add('on');S.subF=v;renderList();}

function showAdd(q){
  S.editId=q?q.id:null;
  document.getElementById('add-title').textContent=q?'編輯題目':'新增題目';
  document.getElementById('f-sub').value=q?.subject||'';
  document.getElementById('f-yr').value=q?.year||'';
  document.getElementById('f-ex').value=q?.exam||'';
  document.getElementById('f-num').value=q?.num||'';
  document.getElementById('f-stem').value=q?.stem||'';
  document.getElementById('f-es').value=q?.answerEs||'';
  document.getElementById('f-kw').value=(q?.keywords||[]).join(',');
  document.getElementById('f-tags').value=q?.tags||'';
  document.getElementById('f-note').value=q?.note||'';
  document.getElementById('f-laws').value=(q?.relatedLaws||[]).map(l=>l.ref||l.lawName+(l.article?' '+l.article:'')).join(',');
  S.correct=q?.answer||'A';
  setQT(q?.type||'mc');
  buildOpts(q?.options);
  document.getElementById('add-ov').classList.add('on');
  setTimeout(()=>document.getElementById('f-stem').focus(),300);
}

function closeAdd(){document.getElementById('add-ov').classList.remove('on');S.editId=null;}

function setQT(t){
  S.qType=t;
  document.getElementById('tmc').className='btn '+(t==='mc'?'bp':'bg');
  document.getElementById('tes').className='btn '+(t==='es'?'bp':'bg');
  document.getElementById('tmc').style.flex='1';document.getElementById('tmc').style.padding='10px';
  document.getElementById('tes').style.flex='1';document.getElementById('tes').style.padding='10px';
  document.getElementById('mc-opts').classList.toggle('hide',t!=='mc');
  document.getElementById('es-area').classList.toggle('hide',t!=='es');
}

function buildOpts(opts){
  const v=opts||{A:'',B:'',C:'',D:''};
  document.getElementById('opts-c').innerHTML=['A','B','C','D','E'].map(k=>`
    <div class="oi"><div class="ok0">${k}</div>
      <input type="text" id="opt-${k}" value="${esc(v[k]||'')}" placeholder="選項 ${k}">
      <button class="cb ${S.correct===k?'sel':''}" onclick="setCorr('${k}')" type="button">✓</button>
    </div>`).join('');
}

function setCorr(k){S.correct=k;document.querySelectorAll('.cb').forEach((b,i)=>{b.classList.toggle('sel',['A','B','C','D','E'][i]===k);});}

async function saveQ(){
  const stem=document.getElementById('f-stem').value.trim();
  if(!stem){toast('請填寫題目內容');return;}
  const opts={};
  if(S.qType==='mc'){
    ['A','B','C','D','E'].forEach(k=>{
      const v=document.getElementById('opt-'+k)?.value.trim();
      if(v)opts[k]=v;
    });
    if(Object.keys(opts).length<2){toast('選擇題至少需要2個選項');return;}
  }
  const lawsStr=document.getElementById('f-laws').value.trim();
  const relatedLaws=lawsStr?lawsStr.split(/[,，]/).map(s=>({ref:s.trim()})).filter(r=>r.ref):[];
  const data={
    type:S.qType,
    subject:document.getElementById('f-sub').value.trim(),
    year:document.getElementById('f-yr').value.trim(),
    exam:document.getElementById('f-ex').value,
    num:document.getElementById('f-num').value.trim(),
    stem,options:opts,
    answer:S.qType==='mc'?S.correct:'',
    answerEs:document.getElementById('f-es').value.trim(),
    keywords:kwArr(document.getElementById('f-kw').value),
    tags:document.getElementById('f-tags').value.trim(),
    note:document.getElementById('f-note').value.trim(),
    relatedLaws,starred:false,createdAt:Date.now()
  };

  // 重複防呆（只在新增時檢查）
  if(!S.editId){
    const allQs=await da('questions');
    const dup=allQs.find(q=>{
      const sameKey=q.subject===data.subject&&q.year===data.year&&q.num&&q.num===data.num;
      const sameStem=(q.stem||'').slice(0,30)===(data.stem||'').slice(0,30)&&(data.stem||'').length>5;
      return sameKey||sameStem;
    });
    if(dup){
      const action=await showDupDialog(data,dup);
      if(action==='skip'){closeAdd();return;}
      if(action==='replace'){
        data.id=dup.id;
        data.starred=dup.starred||false;
        data.createdAt=dup.createdAt||Date.now();
      }
      // 'keep' 直接新增
    }
  } else {
    const ex=await dg('questions',S.editId);
    data.id=S.editId;
    data.starred=ex?.starred||false;
    data.createdAt=ex?.createdAt||Date.now();
  }

  await dp('questions',data);
  closeAdd();
  toast(S.editId?'題目已更新 ✓':'題目已儲存 ✓');
  if(S.page==='list')renderList();else renderHome();
}

async function editQ(id){const q=await dg('questions',id);if(q)showAdd(q);}

async function toggleStar(id){const q=await dg('questions',id);if(!q)return;q.starred=!q.starred;await dp('questions',q);toast(q.starred?'已收藏':'已取消收藏');renderList();}

function delQ(id){cfm('刪除題目','確定要刪除這道題目嗎？',async()=>{await dd('questions',id);const ats=await da('attempts','qid',id);for(const a of ats)await dd('attempts',a.id);toast('已刪除');renderList();});}

async function checkDuplicate(data){
  const qs=await da('questions');
  const stem30=(data.stem||'').slice(0,30);
  return qs.find(q=>
    q.id!==data.id&&(
      (q.subject===data.subject&&q.year===data.year&&q.num&&data.num&&q.num===data.num)||
      ((q.stem||'').slice(0,30)===stem30&&stem30.length>5)
    )
  )||null;
}

function showDupDialog(newData,existing){
  return new Promise(res=>{
    _dupResolve=res;
    const diff='【現有題目】\n科目：'+(existing.subject||'—')+' 年度：'+(existing.year||'—')+
      '\n題幹：'+(existing.stem||'').slice(0,80)+'…\n\n【新題目】\n科目：'+(newData.subject||'—')+
      ' 年度：'+(newData.year||'—')+'\n題幹：'+(newData.stem||'').slice(0,80)+'…';
    document.getElementById('dup-diff').textContent=diff;
    document.getElementById('dup-ov').style.display='flex';
  });
}

function dupAction(action){
  document.getElementById('dup-ov').style.display='none';
  if(_dupResolve){_dupResolve(action);_dupResolve=null;}
}

