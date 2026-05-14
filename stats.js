// ══ stats.js — 統計與 AI 匯出 ═════════════════════════
// 依賴：db.js, utils.js

let _dchart=null;

async function renderStats(){
  const[qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const mcAts=ats.filter(a=>a.correct!==null);
  const total=qs.length,tAts=mcAts.length,correctAts=mcAts.filter(a=>a.correct).length;
  const acc=tAts>0?Math.round(correctAts/tAts*100):null;
  document.getElementById('st-q').textContent=total;
  document.getElementById('st-a').textContent=tAts;
  document.getElementById('st-r').textContent=acc!==null?acc+'%':'—';
  // Subject bars
  const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))];
  document.getElementById('subj-bars').innerHTML=!subs.length?'<div style="color:var(--t2);font-size:13px">尚無資料</div>':
    subs.map(sub=>{
      const qids=new Set(qs.filter(q=>q.subject===sub).map(q=>q.id));
      const sa=mcAts.filter(a=>qids.has(a.qid));
      const a=sa.length>0?Math.round(sa.filter(a=>a.correct).length/sa.length*100):null;
      const col=a===null?'var(--acc)':a>=70?'var(--grn)':a>=50?'var(--org)':'var(--red)';
      return `<div class="sr"><div class="sn">${esc(sub)}</div><div class="sbw"><div class="sbar" style="width:${a||0}%;background:${col}"></div></div><div class="sp">${a!==null?a+'%':'—'}</div></div>`;
    }).join('');
  // Daily chart
  const days=[];
  for(let i=6;i>=0;i--){const d=new Date(Date.now()-i*86400000);const s=d.toISOString().slice(0,10);const cnt=ats.filter(a=>a.date&&a.date.startsWith(s)).length;days.push({label:(d.getMonth()+1)+'/'+(d.getDate()),cnt});}
  const canvas=document.getElementById('dchart');
  if(_dc){_dc.destroy();_dc=null;}
  _dc=new Chart(canvas,{type:'bar',data:{labels:days.map(d=>d.label),datasets:[{data:days.map(d=>d.cnt),backgroundColor:'rgba(88,166,255,.45)',borderColor:'#58a6ff',borderWidth:1,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:true,plugins:{legend:{display:false}},scales:{x:{grid:{color:'#30363d'},ticks:{color:'#8b949e'}},y:{grid:{color:'#30363d'},ticks:{color:'#8b949e',precision:0},beginAtZero:true}}}});
  // Wrong subjects
  const wc={};mcAts.filter(a=>!a.correct).forEach(a=>{const q=qs.find(q=>q.id===a.qid);if(q?.subject)wc[q.subject]=(wc[q.subject]||0)+1;});
  const ws=Object.entries(wc).sort((a,b)=>b[1]-a[1]).slice(0,5);
  document.getElementById('wrong-subs').innerHTML=ws.length?ws.map(([sub,cnt])=>`<div class="sr"><div class="sn">${esc(sub)}</div><div class="sbw"><div class="sbar" style="width:${Math.min(cnt*8,100)}%;background:var(--red)"></div></div><div class="sp">${cnt}次</div></div>`).join(''):'<div style="color:var(--t2);font-size:13px">尚無錯題記錄</div>';
  // Keyword cloud
  const kwCount={};
  qs.forEach(q=>(q.keywords||[]).forEach(k=>{kwCount[k]=(kwCount[k]||0)+1;}));
  const topKws=Object.entries(kwCount).sort((a,b)=>b[1]-a[1]).slice(0,20);
  document.getElementById('kw-cloud').innerHTML=topKws.map(([kw,cnt])=>`<span class="tag" style="font-size:${Math.min(10+cnt,16)}px;background:${cnt>=5?'var(--acc2)':'var(--bg3)'};color:${cnt>=5?'#fff':'var(--t2)'}">${esc(kw)} ${cnt}</span>`).join('');
}

async function buildAI(){
  const[qs,ats,ls]=await Promise.all([da('questions'),da('attempts'),da('laws')]);
  const mcAts=ats.filter(a=>a.correct!==null);
  const wids=getWrong(qs,ats);
  // Per-subject accuracy
  const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))];
  const subStats=subs.map(sub=>{
    const qids=new Set(qs.filter(q=>q.subject===sub).map(q=>q.id));
    const sa=mcAts.filter(a=>qids.has(a.qid));
    const acc=sa.length>0?Math.round(sa.filter(a=>a.correct).length/sa.length*100):null;
    return{subject:sub,total:qids.size,attempts:sa.length,accuracy:acc};
  }).sort((a,b)=>(a.accuracy||100)-(b.accuracy||100));
  // Wrong keywords
  const wkw={};
  [...wids].forEach(id=>{const q=qs.find(q=>q.id===id);(q?.keywords||[]).forEach(k=>{wkw[k]=(wkw[k]||0)+1;});});
  const topWKw=Object.entries(wkw).sort((a,b)=>b[1]-a[1]).slice(0,10);
  // High freq laws
  const lawCount={};
  qs.forEach(q=>(q.relatedLaws||[]).forEach(l=>{const k=l.ref||l.lawName;if(k)lawCount[k]=(lawCount[k]||0)+1;}));
  const topLaws=Object.entries(lawCount).sort((a,b)=>b[1]-a[1]).slice(0,10);
  // Recent 20 attempts
  const recent20=ats.slice(-20);
  const recentAcc=recent20.filter(a=>a.correct===true).length;
  const totalAcc=mcAts.length>0?Math.round(mcAts.filter(a=>a.correct).length/mcAts.length*100):null;
  // Build Markdown
  const md=`# 警察考試複習分析報告
生成時間：${new Date().toLocaleString('zh-TW')}

## 📊 整體概況
- 題庫總題數：${qs.length} 題
- 法條總數：${ls.length} 條
- 總作答次數：${mcAts.length} 次
- 整體正確率：${totalAcc!==null?totalAcc+'%':'尚無記錄'}
- 待複習錯題：${wids.size} 題

## 🔴 各科正確率（由低至高）
${subStats.map(s=>`- ${s.subject}：${s.accuracy!==null?s.accuracy+'%':'尚無記錄'}（答了 ${s.attempts} 次 / 共 ${s.total} 題）`).join('\n')||'尚無資料'}

## ⚠️ 最弱科目
${subStats.filter(s=>s.accuracy!==null&&s.accuracy<60).map(s=>`- ${s.subject}（${s.accuracy}%）`).join('\n')||'目前沒有正確率低於60%的科目'}

## 🏷️ 常錯關鍵字
${topWKw.map(([kw,cnt])=>`- ${kw}（錯了 ${cnt} 次）`).join('\n')||'尚無資料'}

## ⚖️ 高頻出現法條
${topLaws.map(([law,cnt])=>`- ${law}（關聯 ${cnt} 題）`).join('\n')||'尚無關聯法條資料'}

## 📈 最近20題表現
- 正確：${recentAcc} 題
- 錯誤：${recent20.length-recentAcc} 題
- 正確率：${recent20.length>0?Math.round(recentAcc/recent20.length*100)+'%':'尚無'}

## 💡 建議複習重點
${subStats.filter(s=>s.accuracy!==null&&s.accuracy<70).slice(0,3).map(s=>`- 加強「${s.subject}」，正確率僅 ${s.accuracy}%`).join('\n')||'- 繼續保持，各科表現均衡！'}`;

  const jsonData={generatedAt:new Date().toISOString(),overview:{totalQuestions:qs.length,totalLaws:ls.length,totalAttempts:mcAts.length,overallAccuracy:totalAcc,wrongCount:wids.size},subjectStats,wrongKeywords:topWKw.map(([kw,cnt])=>({keyword:kw,wrongCount:cnt})),highFreqLaws:topLaws.map(([law,cnt])=>({law,questionCount:cnt})),recentPerformance:{attempts:recent20.length,correct:recentAcc,accuracy:recent20.length>0?Math.round(recentAcc/recent20.length*100):null}};

  S.aiMd=md;S.aiJson=JSON.stringify(jsonData,null,2);
  document.getElementById('ai-md').textContent=md;
  document.getElementById('ai-json').textContent=S.aiJson;
  document.getElementById('ai-out').classList.remove('hide');
  document.getElementById('ai-out').scrollIntoView({behavior:'smooth'});
  toast('AI分析完成！');
}

function copyAI(type){
  const text=type==='md'?S.aiMd:S.aiJson;
  if(!text){toast('請先點「AI匯出」');return;}
  navigator.clipboard.writeText(text).then(()=>toast('已複製到剪貼簿！')).catch(()=>{const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);toast('已複製！');});
}

function dlAI(type){
  if(type==='md'){if(!S.aiMd){toast('請先點「AI匯出」');return;}dl(S.aiMd,'警察考試分析_'+today()+'.md','text/markdown');}
  else{if(!S.aiJson){toast('請先點「AI匯出」');return;}dl(S.aiJson,'警察考試分析_'+today()+'.json','application/json');}
}

