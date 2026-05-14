// ══ quiz.js — 刷題模式 ══════════════════════════════════
// 依賴：db.js, utils.js

async function startQ(mode){
  const[qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const wids=getWrong(qs,ats);
  let pool=mode==='all'?[...qs]:mode==='wrong'?qs.filter(q=>wids.has(q.id)):mode==='star'?qs.filter(q=>q.starred):[...qs].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,30);
  if(!pool.length){toast(mode==='wrong'?'沒有錯題！先去刷題吧':'沒有題目可練習');return;}
  startQWithPool(pool,mode);
}

function startQWithPool(pool,mode){
  pool=pool.sort(()=>Math.random()-.5);
  S.quiz={q:pool,idx:0,ans:false,res:[],mode};
  document.getElementById('qv').style.display='flex';
  renderQCard();
}

function renderQCard(){
  const{q,idx}=S.quiz;
  if(idx>=q.length){showQDone();return;}
  const cur=q[idx];
  S.quiz.ans=false;
  document.getElementById('qpb').style.width=(idx/q.length*100)+'%';
  document.getElementById('qct').textContent=(idx+1)+'/'+q.length;
  document.getElementById('qbadge').textContent=cur.type==='mc'?'選擇題':'申論題';
  document.getElementById('qbadge').className='badge '+(cur.type==='mc'?'bmc':'bes');
  document.getElementById('qmeta').textContent=[cur.subject,cur.year,cur.exam,cur.num?'第'+cur.num+'題':''].filter(Boolean).join(' · ');
  document.getElementById('qstem').textContent=cur.stem||'';
  const qstar=document.getElementById('qstar');
  qstar.textContent=cur.starred?'★':'☆';
  qstar.className='qfb qstar'+(cur.starred?' on':'');
  document.getElementById('qres').className='qres';document.getElementById('qres').innerHTML='';
  document.getElementById('qnote').style.display='none';
  document.getElementById('qnxt').classList.add('hide');
  document.getElementById('qfoot').style.display='flex';
  // Related laws
  const rl=cur.relatedLaws||[];
  if(rl.length){document.getElementById('qlaw').style.display='block';document.getElementById('qlaw-list').innerHTML=rl.map(l=>`<span class="tag" style="color:var(--pur);cursor:pointer">⚖ ${esc(l.ref||l.lawName||'')}</span>`).join('');}
  else document.getElementById('qlaw').style.display='none';
  if(cur.type==='mc'){
    document.getElementById('qes').style.display='none';
    document.getElementById('qopts').innerHTML=Object.entries(cur.options||{}).map(([k,v])=>`<div class="qopt" id="qo-${k}" onclick="ansQ('${k}')"><div class="qok">${k}</div><div class="qov">${esc(v)}</div></div>`).join('');
  } else {
    document.getElementById('qopts').innerHTML='';
    document.getElementById('qes').style.display='block';
    document.getElementById('qrevbtn').style.display='block';
  }
}

function ansQ(key){
  if(S.quiz.ans)return;S.quiz.ans=true;
  const cur=S.quiz.q[S.quiz.idx];
  const correct=key===cur.answer;
  recAttempt(cur.id,correct);S.quiz.res.push({qid:cur.id,correct});
  Object.keys(cur.options||{}).forEach(k=>{
    const el=document.getElementById('qo-'+k);if(!el)return;
    if(k===cur.answer)el.classList.add('correct');
    else if(k===key&&!correct)el.classList.add('wrong');
    else el.classList.add('dim');
  });
  const res=document.getElementById('qres');
  res.className='qres on '+(correct?'c':'w');
  res.innerHTML=`<div style="font-size:15px;font-weight:700;color:${correct?'var(--grn)':'var(--red)'}">${correct?'✓ 答對了！':'✗ 答錯了，正確答案是 '+cur.answer}</div>`;
  if(cur.note||cur.answerEs){const n=document.getElementById('qnote');n.style.display='block';n.innerHTML=(cur.note?'📝 '+esc(cur.note)+'<br>':'')+(cur.answerEs?'💡 '+esc(cur.answerEs):'');}
  document.getElementById('qnxt').classList.remove('hide');
}

function revealES(){
  if(S.quiz.ans)return;S.quiz.ans=true;
  const cur=S.quiz.q[S.quiz.idx];
  recAttempt(cur.id,null);
  document.getElementById('qrevbtn').style.display='none';
  const res=document.getElementById('qres');
  res.className='qres on r';
  res.innerHTML=`<div style="font-size:14px;font-weight:700;margin-bottom:7px">📖 參考解析</div><div style="font-size:14px;line-height:1.8">${esc(cur.answerEs||'（無參考解析）')}</div>${cur.note?`<div style="margin-top:7px;font-size:12px;color:var(--t2)">📝 ${esc(cur.note)}</div>`:''}`;
  document.getElementById('qnxt').classList.remove('hide');
}

function nextQ(){S.quiz.idx++;renderQCard();}

function exitQ(){document.getElementById('qv').style.display='none';}

async function toggleQStar(){
  const cur=S.quiz.q[S.quiz.idx];if(!cur)return;
  cur.starred=!cur.starred;await dp('questions',cur);
  const btn=document.getElementById('qstar');
  btn.textContent=cur.starred?'★':'☆';
  btn.className='qfb qstar'+(cur.starred?' on':'');
  toast(cur.starred?'已收藏 ⭐':'已取消收藏');
}

function showQDone(){
  const{res}=S.quiz;
  const total=res.length,correct=res.filter(r=>r.correct===true).length,wrong=res.filter(r=>r.correct===false).length;
  const pct=total>0?Math.round(correct/(correct+wrong||1)*100):0;
  const col=pct>=80?'var(--grn)':pct>=60?'var(--org)':'var(--red)';
  document.getElementById('qbody').innerHTML=`<div class="qdone"><div style="font-size:52px">🎉</div><div style="font-size:21px;font-weight:700">練習完成！</div><div style="font-size:56px;font-weight:700;color:${col}">${pct}%</div><div style="color:var(--t2);font-size:13px">正確率</div><div style="display:flex;gap:20px;margin-top:4px"><div style="text-align:center"><div style="font-size:26px;font-weight:700;color:var(--grn)">${correct}</div><div style="font-size:11px;color:var(--t2)">答對</div></div><div style="text-align:center"><div style="font-size:26px;font-weight:700;color:var(--red)">${wrong}</div><div style="font-size:11px;color:var(--t2)">答錯</div></div><div style="text-align:center"><div style="font-size:26px;font-weight:700;color:var(--t2)">${total}</div><div style="font-size:11px;color:var(--t2)">共答</div></div></div><button class="btn bp bw" style="padding:15px;font-size:15px" onclick="exitQ()">返回首頁</button>${wrong>0?`<button class="btn bg bw" style="padding:13px;font-size:13px" onclick="startQ('wrong')">再練錯題 ${wrong} 題</button>`:''}</div>`;
  document.getElementById('qfoot').style.display='none';
  document.getElementById('qpb').style.width='100%';
}

async function recAttempt(qid,correct){await dp('attempts',{qid,correct,date:new Date().toISOString()});}

