// ══ settings.js — 設定與匯出 ══════════════════════════
// 依賴：db.js, utils.js

async function renderSet(){
  const[qs,ats,ls]=await Promise.all([da('questions'),da('attempts'),da('laws')]);
  document.getElementById('exp-info').textContent=`${qs.length} 題 · ${ls.length} 條法條 · ${ats.length} 筆作答`;
  const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))];
  document.getElementById('db-info').innerHTML=`總題數：${qs.length}<br>法條數：${ls.length}<br>作答記錄：${ats.length}<br>科目：${subs.join('、')||'無'}<br>題型：選擇 ${qs.filter(q=>q.type==='mc').length} / 申論 ${qs.filter(q=>q.type==='es').length}`;
}

async function expJSON(){
  const[qs,ats,ls]=await Promise.all([da('questions'),da('attempts'),da('laws')]);
  dl(JSON.stringify({version:2,exportedAt:new Date().toISOString(),questions:qs,laws:ls,attempts:ats},null,2),'警察考題庫_'+today()+'.json','application/json');
  toast('已匯出 JSON');
}

async function impJSON(e){
  const file=e.target.files[0];if(!file)return;
  try{const data=JSON.parse(await file.text());let n=0;
    const qs=data.questions||data;for(const q of qs){const{id,...r}=q;await dp('questions',r);n++;}
    if(data.laws)for(const l of data.laws){const{id,...r}=l;await dp('laws',r);}
    if(data.attempts)for(const a of data.attempts){const{id,...r}=a;await dp('attempts',r);}
    toast(`已匯入 ${n} 題`);e.target.value='';renderSet();
  }catch(err){toast('匯入失敗：'+err.message);}
}

async function expWrong(){
  const[qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const wids=getWrong(qs,ats);const wqs=qs.filter(q=>wids.has(q.id));
  if(!wqs.length){toast('目前沒有錯題');return;}
  dl(buildHTML(wqs,'錯題整理'),'警察考題_錯題_'+today()+'.html','text/html');toast(`匯出 ${wqs.length} 題`);
}

async function expAll(){
  const qs=await da('questions');if(!qs.length){toast('題庫是空的');return;}
  dl(buildHTML(qs,'警察考題庫'),'警察考題庫_'+today()+'.html','text/html');toast(`匯出 ${qs.length} 題`);
}

function buildHTML(qs,title){
  const grp={};qs.forEach(q=>{const s=q.subject||'未分類';if(!grp[s])grp[s]=[];grp[s].push(q);});
  const d=new Date().toLocaleDateString('zh-TW');
  let out='<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><title>'+title+'</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:24px;line-height:1.8;color:#111}h1{font-size:22px;border-bottom:2px solid #333;padding-bottom:7px}h2{font-size:17px;color:#1f6feb;margin-top:28px}.q{margin:14px 0;padding:14px;border:1px solid #ddd;border-radius:8px}.qn{font-size:11px;color:#666}.qs{font-size:14px;font-weight:600;margin-bottom:8px}.opt{font-size:13px;margin:3px 0}.ans{margin-top:8px;font-size:12px;color:#1f6feb;font-weight:600}.note{font-size:11px;color:#666}</style></head><body><h1>'+title+' — '+d+'</h1>';
  Object.entries(grp).forEach(([sub,sqs])=>{
    out+='<h2>'+sub+'</h2>';
    sqs.forEach((q,i)=>{
      const meta=[q.year,q.exam,q.num?'第'+q.num+'題':''].filter(Boolean).join(' · ');
      out+='<div class="q"><div class="qn">'+meta+' · '+(q.type==='mc'?'選擇題':'申論題')+'</div><div class="qs">'+(i+1)+'. '+(q.stem||'')+'</div>';
      if(q.type==='mc')Object.entries(q.options||{}).forEach(([k,v])=>{out+='<div class="opt">('+k+') '+v+'</div>';});
      if(q.answer)out+='<div class="ans">答案：'+q.answer+'</div>';
      if(q.answerEs)out+='<div class="note">解析：'+q.answerEs+'</div>';
      if(q.note)out+='<div class="note">備註：'+q.note+'</div>';
      out+='</div>';
    });
  });
  return out+'</body></html>';
}


async function clearAts(){
  await dc('attempts');
  toast('作答記錄已清除');
  renderSet();
}

async function delAll(){
  await dc('questions');
  await dc('attempts');
  await dc('laws');
  toast('已全部刪除');
  renderSet();
}
