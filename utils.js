// ══ utils.js — 工具函式 ═════════════════════════════════════
// 全域狀態
const S = {
  page:'home', filter:'all', subF:'all', lawCat:'all',
  editId:null, editLawId:null,
  qType:'mc', correct:'A',
  quiz:{q:[],idx:0,ans:false,res:[],mode:''},
  curLaw:null, bulkParsed:[], aiMd:'', aiJson:''
};

function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function br(s){ return esc(s||'').split('\n').join('<br>').split('\r').join(''); }
function toast(m,d=2200){ const e=document.getElementById('toast');if(!e)return;e.textContent=m;e.classList.add('on');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('on'),d); }
function today(){ return new Date().toISOString().slice(0,10); }
function dl(c,fn,t='text/plain'){ const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([c],{type:t}));a.download=fn;a.click(); }
function norm(s){ if(!s)return'';s=s.replace(/[Ａ-Ｚａ-ｚ０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));s=s.replace(/\r\n/g,'\n').replace(/\r/g,'\n');s=s.replace(/\u3000/g,' ');s=s.replace(/[ \t]{2,}/g,' ');s=s.replace(/[ \t]+$/gm,'');return s.trim(); }
function kwArr(s){ return (s||'').split(/[,，、\s]+/).map(k=>k.trim()).filter(Boolean); }

// 關鍵字自動提取
const KW_POOL = ['比例原則','正當法律程序','臨檢','身分查證','即時強制','行政裁量',
  '警械使用','強制力','合理懷疑','現行犯','通知到場','管束','扣留',
  '警察職權','公共秩序','社會安全','行政救濟','陳述意見','書面告知',
  '告知義務','蒐集資料','偵查','搜索','扣押','逮捕','拘提',
  '通訊監察','秘密蒐證','釣魚偵查','控制下交付','陷害教唆',
  '法律保留','裁量怠惰','裁量濫用','警察補充性','緊急危難','正當防衛',
  '緊急避難','正當理由','警察勤務','勤區查察','巡邏','臨檢','守望',
  '值班','備勤','社維法','集遊法','警職法','警察法','警勤條例','警械條例'];
function autoKeywords(text){ return KW_POOL.filter(kw=>(text||'').includes(kw)); }

// 條號轉數字
const ZHN = {'零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'百':100,'千':1000};
function zh2n(s){ let n=0,c=0;for(const ch of s){const v=ZHN[ch];if(v===undefined)continue;if(v>=10){if(c===0)c=1;n+=c*v;c=0;}else c=v;}return n+c; }
function art2n(art){ const m=art.match(/第([一二三四五六七八九十百千\d]+)條/);if(!m)return 0;const s=m[1];return /^\d+$/.test(s)?parseInt(s):zh2n(s); }

// 錯題演算法
function getWrong(qs,ats){
  const s=new Set();
  for(const q of qs){
    const qa=ats.filter(a=>a.qid===q.id&&a.correct!==null).sort((a,b)=>b.date>a.date?1:-1);
    if(!qa.length)continue;
    const r=qa.slice(0,3);
    if(r.every(a=>!a.correct)||(qa.filter(a=>!a.correct).length/qa.length>0.5&&qa.length>=2))s.add(q.id);
  }
  return s;
}

// Confirm dialog
let _cfmCb=null;
function cfm(t,s,cb){
  _cfmCb=cb;
  document.getElementById('cfm-t').textContent=t;
  document.getElementById('cfm-s').textContent=s;
  document.getElementById('cfm-ok').onclick=()=>{closeCfm();_cfmCb?.();};
  document.getElementById('cfm-ov').classList.add('on');
}
function closeCfm(){ document.getElementById('cfm-ov').classList.remove('on'); }
