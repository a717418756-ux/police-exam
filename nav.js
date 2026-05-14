// ══ nav.js — 導覽與初始化 ══════════════════════════════
// 依賴：全部模組

function goPage(pg,btn){
  document.querySelectorAll('.page').forEach(p=>p.classList.add('hide'));
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('on'));
  const el=document.getElementById('pg-'+pg);if(el)el.classList.remove('hide');
  if(btn)btn.classList.add('on');
  else{const b=document.querySelector(`.nb[onclick*="'${pg}'"]`);if(b)b.classList.add('on');}
  S.page=pg;
  ({home:renderHome,list:renderList,laws:renderDB,db:renderDB,stats:renderStats,set:renderSet,bulk:()=>{}})[pg]?.();
}

async function init(){
  await initDB();
  buildOpts({});
  goPage('home',document.querySelector('.nb'));
}
init();
