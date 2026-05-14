// ══ bulk.js — 大量貼題 ════════════════════════════════
// 依賴：db.js, utils.js, parser.js

function parseBulk(){
  try{
    console.log('[parseBulk] 開始執行');
    const biEl=document.getElementById('bi-text');
    if(!biEl){toast('找不到輸入框');return;}
    const text=biEl.value||'';
    if(!text.trim()){toast('請先在下方文字框貼入題目文字');return;}
    const parsed=parseBulkText(text);
    S.bulkParsed=parsed;
    // 套用答案列
    const ansStr=(document.getElementById('bi-ans')||{}).value||'';
    const ansMap=parseAnswerStr(ansStr);
    parsed.forEach((q,i)=>{
      const n=parseInt(q.num)||i+1;
      if(ansMap[n])q.answer=ansMap[n];
    });
    const mc=parsed.filter(q=>q.type==='mc').length;
    const es=parsed.filter(q=>q.type==='es').length;
    const noAns=parsed.filter(q=>q.type==='mc'&&!q.answer).length;
    // 顯示統計
    const statsEl=document.getElementById('bulk-stats');
    if(statsEl) statsEl.innerHTML=
      '<span class="tag" style="background:var(--acc2);color:#fff">'+parsed.length+' 題</span>'+
      '<span class="tag" style="background:#1f3a5f;color:var(--acc)">選擇 '+mc+'</span>'+
      '<span class="tag" style="background:var(--red2);color:var(--red)">申論 '+es+'</span>'+
      (noAns?'<span class="tag" style="background:var(--org2);color:var(--org)">⚠ '+noAns+' 題未填答案</span>':'');
    // 顯示預覽
    const prevEl=document.getElementById('prev-list');
    if(prevEl) prevEl.innerHTML=parsed.map(function(q){
      const typeLabel=q.type==='mc'?'選擇題':'申論題';
      const ansLabel=q.answer?' · 答案:'+q.answer:'';
      const optLabel=q.type==='mc'?'<div class="pi-o">選項：'+Object.keys(q.options).join(' ')+'</div>':'';
      const cls=q.answer||q.type==='es'?'ok':'warn';
      return '<div class="pi '+cls+'">'+
        '<div class="pi-n">第'+q.num+'題 · '+typeLabel+ansLabel+'</div>'+
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
  const items=S.bulkParsed.map(q=>({...q,subject:sub||q.subject||'',year:yr||q.year||'',exam:ex||q.exam||''}));
  try{
    await bulkPut('questions',items);
    toast('已匯入 '+items.length+' 題 ✓');
    S.bulkParsed=[];
    document.getElementById('bulk-result').classList.add('hide');
    renderHome();
  }catch(err){
    toast('匯入失敗：'+err.message);
  }
}

function clearBulk(){
  document.getElementById('bi-text').value='';
  document.getElementById('bi-ans').value='';
  document.getElementById('bulk-result').classList.add('hide');
  S.bulkParsed=[];
}

