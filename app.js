// ══════════════════════════════════════════════════════════════════════
// 短線雷達 Pro — 風險優先分層決策系統
// ══════════════════════════════════════════════════════════════════════

// ⚠️ 部署 Code.gs 後，把「網頁應用程式 URL」貼在這裡
const GAS_URL='請貼上你的_GAS_網頁應用程式_URL';

// ── DOM helpers ───────────────────────────────────────────────────────
const $=id=>document.getElementById(id);
const fmt=(n,d=2)=>n==null||isNaN(n)?'—':Number(n).toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtV=v=>v==null?'—':v>=1e8?(v/1e8).toFixed(2)+'億':v>=1e4?(v/1e4).toFixed(1)+'萬':Number(v).toLocaleString();

function showErr(m){$('err-box').style.display='block';$('err-box').innerHTML=`<p style="color:var(--sell);font-weight:600;margin-bottom:6px">❌ ${m}</p><p style="color:var(--muted);font-size:12px">台股輸入4位數字（如 2330），美股輸入英文代碼（如 AAPL）。若確認正確仍失敗，可能為後端限流，稍後再試。</p>`;}
function hideErr(){$('err-box').style.display='none';}

// ── 抓資料（透過 GAS） ─────────────────────────────────────────────────
async function fetchStock(code){
  if(GAS_URL.indexOf('http')!==0) throw new Error('尚未設定 GAS 網址，請先部署 Code.gs 並把 URL 填入 app.js 的 GAS_URL');
  let r;
  try{ r=await fetch(`${GAS_URL}?code=${encodeURIComponent(code)}`); }
  catch(e){ throw new Error('無法連線到 GAS 後端，請確認網址與部署權限（須設為「所有人」）'); }
  if(!r.ok) throw new Error(`後端回應錯誤（${r.status}）`);
  const j=await r.json();
  if(!j.ok) throw new Error(j.error||'後端無法取得資料');
  if(!j.closes||j.closes.length<10) throw new Error(`${code} 歷史資料不足`);
  return j;
}

// ── 抓大盤環境（第⓪層） ────────────────────────────────────────────────
async function fetchMarket(){
  if(GAS_URL.indexOf('http')!==0) return null;
  try{
    const r=await fetch(`${GAS_URL}?action=market`);
    if(!r.ok) return null;
    const j=await r.json();
    return j.ok?j:null;
  }catch(e){ return null; }
}

function renderMarket(m){
  if(!m){ $('market-card').style.display='none'; return; }
  $('market-card').style.display='block';
  const boxes=[];
  const t=m.taifex||{}, us=m.us||{};

  // 外資台指期未平倉
  if(t.foreignNet!=null){
    const long=t.foreignNet>0;
    boxes.push({cls:long?'good':'',label:'🏦 外資台指期淨未平倉',
      value:`${t.foreignNet>0?'+':''}${fmtV(t.foreignNet)} 口`,valCls:long?'buy':'sell',
      sub:`${long?'淨多單，外資偏多佈局':'淨空單，外資偏空避險'}${t.date?'｜'+t.date:''}`});
  }
  // 三大法人合計
  if(t.institutionNet!=null){
    const long=t.institutionNet>0;
    boxes.push({cls:long?'good':'',label:'🏛️ 三大法人台指期淨額',
      value:`${t.institutionNet>0?'+':''}${fmtV(t.institutionNet)} 口`,valCls:long?'buy':'sell',
      sub:`${long?'法人整體偏多':'法人整體偏空'}（僅供環境參考）`});
  }
  // PCR
  if(t.pcrOI!=null && t.pcrOI>0){
    // PCR > 1 通常代表避險賣權多→偏空情緒；但過高反為反指標
    const pcr=t.pcrOI;
    let tone='warn', desc;
    if(pcr>120){tone='good';desc=`PCR ${pcr.toFixed(0)}% 偏高，賣權避險濃，散戶恐慌，常為反指標（物極必反偏多）`;}
    else if(pcr<80){tone='';desc=`PCR ${pcr.toFixed(0)}% 偏低，市場樂觀，留意過熱`;}
    else{desc=`PCR ${pcr.toFixed(0)}%，選擇權多空情緒中性`;}
    boxes.push({cls:tone,label:'⚖️ PCR 賣權買權比(未平倉)',value:`${pcr.toFixed(0)}%`,valCls:tone==='good'?'buy':'warn',sub:desc});
  }
  // 美股隔夜
  const usItem=(label,icon,d,note)=>{
    if(!d)return;
    const up=d.changePct>=0;
    boxes.push({cls:up?'good':'',label:`${icon} ${label}（隔夜）`,
      value:`${up?'+':''}${d.changePct.toFixed(2)}%`,valCls:up?'buy':'sell',
      sub:`收 ${fmt(d.price)}｜${note}`});
  };
  usItem('費城半導體 SOX','🔌',us.sox,'對台積電/聯發科等連動高');
  usItem('那斯達克','💻',us.nasdaq,'對台股科技股連動');
  usItem('標普 500','📊',us.sp500,'美股大盤氣氛');

  if(boxes.length===0){ $('market-card').style.display='none'; return; }
  $('market-grid').innerHTML=boxes.map(x=>`<div class="risk-box ${x.cls}"><div class="rb-label">${x.label}</div><div class="rb-value ${x.valCls}">${x.value}</div><div class="rb-sub">${x.sub}</div></div>`).join('');
}
function sma(a,n){return a.map((_,i)=>i<n-1?null:a.slice(i-n+1,i+1).reduce((s,v)=>s+v,0)/n);}
function ema(a,n){const k=2/(n+1);let e=null;return a.map(v=>{e=e===null?v:v*k+e*(1-k);return e;});}
function stddev(a){const m=a.reduce((s,v)=>s+v,0)/a.length;return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length);}
function lastNonNull(a){for(let i=a.length-1;i>=0;i--)if(a[i]!=null)return a[i];return null;}

// ── ATR（Average True Range）────────────────────────────────────────────
function calcATR(h,l,c,n=14){
  const tr=[];
  for(let i=1;i<c.length;i++){
    tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  }
  if(tr.length<n)return tr.reduce((a,b)=>a+b,0)/tr.length||0;
  // Wilder 平滑
  let atr=tr.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<tr.length;i++) atr=(atr*(n-1)+tr[i])/n;
  return atr;
}

// ── RSI ────────────────────────────────────────────────────────────────
function calcRSISeries(c,n=14){
  const g=[],l=[];
  for(let i=1;i<c.length;i++){const d=c[i]-c[i-1];g.push(d>0?d:0);l.push(d<0?-d:0);}
  let ag=g.slice(0,n).reduce((a,b)=>a+b,0)/n,al=l.slice(0,n).reduce((a,b)=>a+b,0)/n;
  const out=[...Array(n+1).fill(null)];
  out[n]=al===0?100:100-100/(1+ag/al);
  for(let i=n;i<g.length;i++){ag=(ag*(n-1)+g[i])/n;al=(al*(n-1)+l[i])/n;out.push(al===0?100:100-100/(1+ag/al));}
  return out;
}
const calcRSI=(c,n=14)=>lastNonNull(calcRSISeries(c,n));

// ── MACD ───────────────────────────────────────────────────────────────
function calcMACD(c){
  const e12=ema(c,12),e26=ema(c,26);
  const diff=e12.map((v,i)=>v-e26[i]);
  const sig=ema(diff.slice(25),9);
  const d=diff[diff.length-1],s=sig[sig.length-1];
  // 前一根柱狀體（判斷放大/縮小）
  const prevD=diff[diff.length-2],prevS=sig[sig.length-2];
  return{diff:d,sig:s,hist:d-s,prevHist:(prevD-prevS)};
}

// ── KD ─────────────────────────────────────────────────────────────────
function calcKD(h,l,c,n=9){
  const rsv=c.map((_,i)=>{if(i<n-1)return 50;const hi=Math.max(...h.slice(i-n+1,i+1)),lo=Math.min(...l.slice(i-n+1,i+1));return hi===lo?50:(c[i]-lo)/(hi-lo)*100;});
  let k=50,d=50;for(const r of rsv){k=k*2/3+r/3;d=d*2/3+k/3;}
  return{k,d,j:3*k-2*d};
}
// ── 其他 ───────────────────────────────────────────────────────────────
function calcBB(c,n=20,m=2){const s=sma(c,n),last=s[s.length-1];const std=stddev(c.slice(-n));return{upper:last+m*std,mid:last,lower:last-m*std,std};}
function calcWR(h,l,c,n=14){const i=c.length-1;const hi=Math.max(...h.slice(Math.max(0,i-n+1),i+1)),lo=Math.min(...l.slice(Math.max(0,i-n+1),i+1));return hi===lo?-50:(hi-c[i])/(hi-lo)*-100;}
function calcCCI(h,l,c,n=20){const tp=c.map((_,i)=>(h[i]+l[i]+c[i])/3);const sl=tp.slice(-n),mean=sl.reduce((a,b)=>a+b,0)/n;const mad=sl.reduce((a,v)=>a+Math.abs(v-mean),0)/n;return mad===0?0:(tp[tp.length-1]-mean)/(0.015*mad);}
function calcDMI(h,l,c,n=14){let pdm=0,ndm=0,tr=0;for(let i=Math.max(1,c.length-n);i<c.length;i++){const up=h[i]-h[i-1],dn=l[i-1]-l[i];pdm+=up>dn&&up>0?up:0;ndm+=dn>up&&dn>0?dn:0;tr+=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));}if(tr===0)return{adx:0,pdi:0,ndi:0};const pdi=pdm/tr*100,ndi=ndm/tr*100;return{adx:Math.abs(pdi-ndi)/(pdi+ndi)*100||0,pdi,ndi};}
function calcROC(c,n=12){const p=c[c.length-1-n];return p?(c[c.length-1]-p)/p*100:0;}
function calcPSY(c,n=12){let up=0;for(let i=c.length-n;i<c.length;i++)if(c[i]>c[i-1])up++;return up/n*100;}

// ── RSI 背離偵測（價創新高/低，但RSI未跟上）─────────────────────────────
function detectRSIDivergence(c,rsiSeries){
  const N=Math.min(20,c.length);
  const recentC=c.slice(-N), recentR=rsiSeries.slice(-N).map(v=>v==null?50:v);
  // 找近期兩個價格高點與低點
  const priceHigh=Math.max(...recentC), priceHighIdx=recentC.lastIndexOf(priceHigh);
  const priceLow=Math.min(...recentC), priceLowIdx=recentC.lastIndexOf(priceLow);
  const curIdx=recentC.length-1;
  const curPrice=recentC[curIdx], curRSI=recentR[curIdx];
  // 頂背離：價接近新高，但RSI明顯低於高點時的RSI
  let bearDiv=false,bullDiv=false;
  // 簡化：比較前半段與後半段的價格與RSI斜率
  const mid=Math.floor(N/2);
  const p1=recentC.slice(0,mid),p2=recentC.slice(mid);
  const r1=recentR.slice(0,mid),r2=recentR.slice(mid);
  const pHigh1=Math.max(...p1),pHigh2=Math.max(...p2);
  const pLow1=Math.min(...p1),pLow2=Math.min(...p2);
  const rAtHigh1=r1[p1.indexOf(pHigh1)],rAtHigh2=r2[p2.indexOf(pHigh2)];
  const rAtLow1=r1[p1.indexOf(pLow1)],rAtLow2=r2[p2.indexOf(pLow2)];
  // 頂背離：後段價更高，RSI更低
  if(pHigh2>pHigh1 && rAtHigh2<rAtHigh1-2 && curRSI>55) bearDiv=true;
  // 底背離：後段價更低，RSI更高
  if(pLow2<pLow1 && rAtLow2>rAtLow1+2 && curRSI<45) bullDiv=true;
  return{bearDiv,bullDiv};
}

// ══════════════════════════════════════════════════════════════════════
// 第①層：趨勢過濾
// ══════════════════════════════════════════════════════════════════════
function analyzeTrend(D){
  const c=D.closes, price=D.price;
  const ma200v=c.length>=200?sma(c,200).slice(-1)[0]:sma(c,Math.min(c.length-1,c.length)).slice(-1)[0];
  const ma50v=c.length>=50?sma(c,50).slice(-1)[0]:null;
  const ma200=c.length>=120?(c.length>=200?sma(c,200).slice(-1)[0]:sma(c,Math.floor(c.length*0.9)).slice(-1)[0]):null;
  const has200=c.length>=200;
  const has50=c.length>=50;

  const aboveMA200=ma200!=null && price>ma200;
  const aboveMA50 =ma50v!=null && price>ma50v;
  // 金叉死叉
  let cross='—';
  if(has50 && ma200!=null){
    cross=ma50v>ma200?'golden':'death';
  }

  let verdict,icon,cls,gate,detail;
  if(aboveMA200 && (cross==='golden'||!has200)){
    verdict='多頭趨勢';icon='🟢';cls='bull';
    gate='✅ 趨勢過濾通過 → 可考慮做多，往下看風險管理與進場訊號';
    detail=`股價 ${fmt(price)} 站上 ${has200?'200日均線':'長期均線'}(${fmt(ma200)})${has50?`，50日線(${fmt(ma50v)}) ${cross==='golden'?'位於200線之上（黃金交叉，長多）':'位於200線之下'}`:''}。機構視為偏多結構。`;
  } else if(!aboveMA200 && cross==='death'){
    verdict='空頭趨勢';icon='🔴';cls='bear';
    gate='⛔ 趨勢過濾未通過 → 順勢者不宜做多，逆勢搶反彈風險高';
    detail=`股價 ${fmt(price)} 跌破 ${has200?'200日均線':'長期均線'}(${fmt(ma200)})${has50?`，50日線(${fmt(ma50v)}) 死亡交叉於200線下方`:''}。長期偏空，做多需格外謹慎。`;
  } else {
    verdict='趨勢不明';icon='🟡';cls='neutral';
    gate='⚠️ 趨勢過渡帶 → 多空拉鋸，建議減碼或觀望，等待方向明確';
    detail=`股價 ${fmt(price)} 與均線糾結${has200?`（200線 ${fmt(ma200)}）`:''}${has50?`（50線 ${fmt(ma50v)}）`:''}。趨勢尚未確立。`;
  }
  return{verdict,icon,cls,gate,detail,aboveMA200,aboveMA50,cross,ma200,ma50v,has200};
}

// ══════════════════════════════════════════════════════════════════════
// 第②層：風險管理
// ══════════════════════════════════════════════════════════════════════
function analyzeRisk(D,atr){
  const price=D.price;
  const capital=parseFloat($('in-capital').value)||1000000;
  const riskPct=parseFloat($('in-risk').value)||1;
  const winRate=Math.min(95,Math.max(5,parseFloat($('in-winrate').value)||50))/100;

  // ATR 停損（2倍）
  const atrMult=2;
  const stopLoss=price-atr*atrMult;
  const stopDist=price-stopLoss;
  const stopPct=stopDist/price*100;

  // Chandelier Exit（最高價 - ATR×3）移動停利
  const recentHigh=Math.max(...D.highs.slice(-22));
  const chandelier=recentHigh-atr*3;

  // 風報比 1:2 與 1:3 對應的停利價
  const tp2=price+stopDist*2;
  const tp3=price+stopDist*3;

  // 固定風險法部位大小
  const riskAmount=capital*riskPct/100;
  const shares=stopDist>0?Math.floor(riskAmount/stopDist):0;
  const positionValue=shares*price;
  const positionPct=positionValue/capital*100;

  // 凱利公式：f = (bp - q)/b，b=盈虧比(這裡用1:2→b=2)
  const b=2; // 以風報比1:2為基準
  const q=1-winRate;
  const kellyFull=(b*winRate-q)/b;
  const kellyHalf=kellyFull/2;
  const kellyQuarter=kellyFull/4;

  return{capital,riskPct,winRate,atr,stopLoss,stopPct,stopDist,chandelier,tp2,tp3,
    riskAmount,shares,positionValue,positionPct,
    kellyFull:Math.max(0,kellyFull),kellyHalf:Math.max(0,kellyHalf),kellyQuarter:Math.max(0,kellyQuarter),
    currency:D.currency};
}

// ══════════════════════════════════════════════════════════════════════
// 第③層：心理偏誤檢查
// ══════════════════════════════════════════════════════════════════════
function analyzePsychology(D){
  const c=D.closes, price=D.price;
  const alerts=[];

  // 1. FOMO / 連漲偵測
  let upStreak=0;
  for(let i=c.length-1;i>0;i--){if(c[i]>c[i-1])upStreak++;else break;}
  let downStreak=0;
  for(let i=c.length-1;i>0;i--){if(c[i]<c[i-1])downStreak++;else break;}
  if(upStreak>=5){
    alerts.push({type:'fire',icon:'🔥',title:`FOMO 警示：已連漲 ${upStreak} 根`,
      desc:`股價連續上漲 ${upStreak} 天，此時追高是典型的「錯失恐懼(FOMO)」心理。統計上連漲後追價，短線回檔風險顯著升高。若要進場，務必縮小部位並設緊停損。`});
  } else if(downStreak>=5){
    alerts.push({type:'fire',icon:'🩸',title:`恐慌警示：已連跌 ${downStreak} 根`,
      desc:`連續下跌 ${downStreak} 天，市場恐慌中。摸底接刀風險高，但若其他層級轉強，可能是反轉訊號，需嚴設停損。`});
  } else {
    alerts.push({type:'ok',icon:'✅',title:'無連續漲跌過熱',
      desc:`近期無連續5根以上的單向走勢，價格情緒相對理性，不易陷入追高殺低。`});
  }

  // 2. 乖離過大 → 損失厭惡提醒
  const ma20=sma(c,20).slice(-1)[0];
  const bias20=(price-ma20)/ma20*100;
  if(bias20>10){
    alerts.push({type:'fire',icon:'📛',title:`正乖離過大 +${bias20.toFixed(1)}%`,
      desc:`股價偏離20日均線 +${bias20.toFixed(1)}%，過度延伸。人性傾向「賺了還想賺」而不願獲利了結，最終常常回吐。建議分批停利，別讓貪婪主導。`});
  } else if(bias20<-10){
    alerts.push({type:'fire',icon:'⚠️',title:`負乖離過大 ${bias20.toFixed(1)}%`,
      desc:`股價偏離20日均線 ${bias20.toFixed(1)}%，深度超跌。「損失厭惡」會讓人小賠不砍、凹單到大賠。若手中套牢，請用紀律停損，而非僥倖硬抱。`});
  }

  // 3. 損失厭惡核心提醒（恆顯示）
  alerts.push({type:'ok',icon:'🧠',title:'損失厭惡校正',
    desc:`心理學研究：虧損的痛苦約為等量獲利快樂的 2 倍。這導致多數人「小賺就跑、大賠硬抱」——正好和賺錢法則相反。請永遠先看好你的停損（第②層），讓獲利奔跑。`});

  // 4. 確認偏誤提醒
  alerts.push({type:'ok',icon:'🔍',title:'確認偏誤校正',
    desc:`別只找支持你想法的訊號。本系統第④層同時列出買進與賣出指標——請把反方訊號也讀完，再做決定。`});

  return alerts;
}

// ══════════════════════════════════════════════════════════════════════
// 第④層：進場訊號（技術指標群）
// ══════════════════════════════════════════════════════════════════════
function analyzeSignals(D,atr,trend){
  const{closes:c,highs:h,lows:l,volumes:v,price,open}=D;
  const sigs=[];
  const add=(name,group,val,raw,min,max,s,desc)=>sigs.push({name,group,val,raw,min,max,s,desc});

  // RSI背離（最有價值，放第一個）
  const rsiSeries=calcRSISeries(c,14);
  const rsi14=lastNonNull(rsiSeries);
  const div=detectRSIDivergence(c,rsiSeries);
  add('RSI 背離偵測 ⭐','核心',
    div.bearDiv?'頂背離':div.bullDiv?'底背離':'無背離',null,null,null,
    div.bullDiv?'buy':div.bearDiv?'sell':'hold',
    div.bearDiv?`價格創高但RSI走弱 → 頂背離，多頭動能衰竭，留意反轉下跌（比看RSI數值更有價值）`:
    div.bullDiv?`價格創低但RSI走強 → 底背離，空頭動能衰竭，留意反轉上漲`:
    `價格與RSI同步，無明顯背離`);

  // RSI 數值
  add('RSI 14日','震盪',rsi14?.toFixed(1)??'—',rsi14,0,100,
    rsi14<30?'buy':rsi14>70?'sell':'hold',
    rsi14<30?`RSI ${rsi14?.toFixed(1)} < 30 超賣`:rsi14>70?`RSI ${rsi14?.toFixed(1)} > 70 超買`:`RSI ${rsi14?.toFixed(1)} 中性`);

  // 成交量異常（核心）
  const vr=v.length>=6?v[v.length-1]/(v.slice(-6,-1).reduce((a,b)=>a+b,0)/5):1;
  const vUp=price>open&&vr>1.5,vDn=price<open&&vr>1.5;
  add('成交量異常放大 ⭐','核心',`${vr.toFixed(2)}x`,vr,0,3,
    vUp?'buy':vDn?'sell':'hold',
    vUp?`放量收紅 ${vr.toFixed(1)}x，資金流入，動能確認`:vDn?`放量收黑 ${vr.toFixed(1)}x，資金流出`:vr>2?`爆量${vr.toFixed(1)}x但方向未定`:`量能 ${vr.toFixed(1)}x 正常`);

  // MACD 柱狀體（重點是放大不是交叉）
  const mc=calcMACD(c);
  const histGrow=Math.abs(mc.hist)>Math.abs(mc.prevHist);
  add('MACD 柱狀體動能','趨勢',`柱:${mc.hist?.toFixed(2)} ${histGrow?'放大↑':'縮小↓'}`,mc.hist,-Math.abs(mc.hist||1)*2.5,Math.abs(mc.hist||1)*2.5,
    mc.hist>0&&histGrow?'buy':mc.hist<0&&histGrow?'sell':'hold',
    mc.hist>0&&histGrow?`紅柱放大，多頭動能增強（重點看放大，非黃金交叉）`:
    mc.hist<0&&histGrow?`綠柱放大，空頭動能增強`:
    `柱狀體${histGrow?'放大':'縮小'}中，動能${mc.hist>0?'偏多':'偏空'}但需確認`);

  // KD
  const{k,d,j}=calcKD(h,l,c);
  add('KD 隨機指標','震盪',`K:${k.toFixed(1)} D:${d.toFixed(1)}`,k,0,100,
    k<20&&k>d?'buy':k>80&&k<d?'sell':'hold',
    k<20&&k>d?`K${k.toFixed(0)} 低檔黃金交叉`:k>80&&k<d?`K${k.toFixed(0)} 高檔死亡交叉`:`K ${k.toFixed(0)} 中性`);

  // 布林 Squeeze（核心：通道收窄→大波動）
  const bb=calcBB(c);
  const bw=(bb.upper-bb.lower)/bb.mid*100;
  const bbP=(price-bb.lower)/(bb.upper-bb.lower)*100;
  add('布林 Squeeze ⭐','核心',`頻寬 ${bw.toFixed(1)}%`,bw,0,20,
    bw<3?'buy':'hold',
    bw<3?`通道極度收窄 ${bw.toFixed(1)}%！量化系統最愛訊號：即將出現大波動，留意突破方向`:
    bw>12?`通道偏寬 ${bw.toFixed(1)}%，波動擴大期`:`頻寬 ${bw.toFixed(1)}%，位於通道 ${bbP.toFixed(0)}%`);

  // DMI 趨勢強度
  const dmi=calcDMI(h,l,c);
  add('DMI 趨勢強度','趨勢',`ADX:${dmi.adx.toFixed(1)} +DI:${dmi.pdi.toFixed(0)} -DI:${dmi.ndi.toFixed(0)}`,dmi.adx,0,60,
    dmi.pdi>dmi.ndi&&dmi.adx>20?'buy':dmi.ndi>dmi.pdi&&dmi.adx>20?'sell':'hold',
    dmi.adx<20?`ADX ${dmi.adx.toFixed(0)} < 20，無明顯趨勢（盤整，不利順勢單）`:
    dmi.pdi>dmi.ndi?`ADX ${dmi.adx.toFixed(0)} 趨勢明確，+DI領先 → 多方掌控`:`ADX ${dmi.adx.toFixed(0)} 趨勢明確，-DI領先 → 空方掌控`);

  // W%R
  const wr=calcWR(h,l,c);
  add('W%R 威廉','震盪',wr.toFixed(1),-wr,0,100,wr<-80?'buy':wr>-20?'sell':'hold',
    wr<-80?`W%R ${wr.toFixed(0)} 超賣`:wr>-20?`W%R ${wr.toFixed(0)} 超買`:`W%R ${wr.toFixed(0)} 中性`);

  // CCI
  const cci=calcCCI(h,l,c);
  add('CCI 商品通道','震盪',cci.toFixed(1),cci,-250,250,cci<-100?'buy':cci>100?'sell':'hold',
    cci<-100?`CCI ${cci.toFixed(0)} 超賣`:cci>100?`CCI ${cci.toFixed(0)} 超買`:`CCI ${cci.toFixed(0)} 正常`);

  // ROC 動能
  const roc=calcROC(c,12);
  add('ROC 變動率','動能',`${roc>=0?'+':''}${roc.toFixed(1)}%`,roc,-15,15,roc>4?'buy':roc<-4?'sell':'hold',
    roc>4?`12日 +${roc.toFixed(1)}% 動能強`:roc<-4?`12日 ${roc.toFixed(1)}% 弱`:`動能 ${roc.toFixed(1)}% 平淡`);

  // PSY 心理線
  const psy=calcPSY(c,12);
  add('PSY 心理線','心理',`${psy.toFixed(0)}%`,psy,0,100,psy<25?'buy':psy>75?'sell':'hold',
    psy<25?`PSY ${psy.toFixed(0)}% 過度悲觀 → 逆勢買`:psy>75?`PSY ${psy.toFixed(0)}% 過度樂觀 → 逆勢賣`:`PSY ${psy.toFixed(0)}% 中性`);

  // 200MA 趨勢（機構最愛）
  if(trend.ma200!=null){
    add('200MA 長期趨勢','趨勢',`${trend.aboveMA200?'站上':'跌破'} ${fmt(trend.ma200)}`,null,null,null,
      trend.aboveMA200?'buy':'sell',
      trend.aboveMA200?`股價在200日線之上，長期偏多（機構最常用的多空分界）`:`股價在200日線之下，長期偏空`);
  }

  return sigs;
}

// ══════════════════════════════════════════════════════════════════════
// 渲染
// ══════════════════════════════════════════════════════════════════════
let allSigs=[], activeCat='全部';

function renderTrend(t){
  const b=$('trend-banner');b.style.display='block';b.className=t.cls;
  $('tb-icon').textContent=t.icon;
  const tv=$('tb-verdict');tv.textContent=t.verdict;tv.className='tb-verdict '+t.cls;
  $('tb-detail').textContent=t.detail;
  $('tb-gate').textContent=t.gate;
}

function renderRisk(r){
  $('risk-card').style.display='block';
  const cur=r.currency==='TWD'?'NT$':'$';
  const boxes=[
    {cls:'',label:'🛑 ATR 停損價 (2×ATR)',value:cur+fmt(r.stopLoss),valCls:'sell',sub:`停損距離 ${fmt(r.stopDist)}（${r.stopPct.toFixed(1)}%），比固定%停損更貼合波動`},
    {cls:'good',label:'🎯 停利價 1:2 風報比',value:cur+fmt(r.tp2),valCls:'buy',sub:`風報比 1:2，即使勝率40%長期仍可能獲利`},
    {cls:'good',label:'🎯 停利價 1:3 風報比',value:cur+fmt(r.tp3),valCls:'buy',sub:`理想風報比，讓獲利奔跑`},
    {cls:'warn',label:'🪜 移動停利 (Chandelier)',value:cur+fmt(r.chandelier),valCls:'warn',sub:`最高價-3×ATR，股價創高就上移，保護獲利`},
    {cls:'',label:'📦 建議部位（固定風險法）',value:`${fmt(r.shares,0)} ${r.currency==='TWD'?'股':'股'}`,valCls:'',sub:`單筆風險 ${cur}${fmtV(Math.round(r.riskAmount))}（資金${r.riskPct}%），佔總資金 ${r.positionPct.toFixed(1)}%`},
    {cls:'warn',label:'🎲 凱利建議比例',value:`${(r.kellyHalf*100).toFixed(1)}%`,valCls:'warn',sub:`半凱利（保守）。全凱利 ${(r.kellyFull*100).toFixed(1)}%／四分之一凱利 ${(r.kellyQuarter*100).toFixed(1)}%。基於你填的勝率 ${(r.winRate*100).toFixed(0)}%、風報比1:2`},
  ];
  $('risk-grid').innerHTML=boxes.map(x=>`<div class="risk-box ${x.cls}"><div class="rb-label">${x.label}</div><div class="rb-value ${x.valCls}">${x.value}</div><div class="rb-sub">${x.sub}</div></div>`).join('');
}

function renderPsych(alerts){
  $('psych-card').style.display='block';
  $('psych-list').innerHTML=alerts.map(a=>`<div class="psych-alert ${a.type}"><span class="pa-icon">${a.icon}</span><div class="pa-body"><div class="pa-title ${a.type}">${a.title}</div><div class="pa-desc">${a.desc}</div></div></div>`).join('');
}

function renderTabs(sigs){
  const cats=['全部',...new Set(sigs.map(s=>s.group))];
  $('cat-tabs').innerHTML='';
  cats.forEach(c=>{
    const t=document.createElement('div');
    t.className='cat-tab'+(c===activeCat?' active':'');
    const n=c==='全部'?sigs.length:sigs.filter(s=>s.group===c).length;
    t.textContent=`${c} (${n})`;
    t.onclick=()=>{activeCat=c;renderTabs(allSigs);renderGrid(allSigs);};
    $('cat-tabs').appendChild(t);
  });
  $('cat-row').style.display='block';
}

function renderGrid(sigs){
  const f=activeCat==='全部'?sigs:sigs.filter(s=>s.group===activeCat);
  const g=$('ind-grid');g.innerHTML='';g.style.display='grid';
  for(const s of f){
    const bc=s.s==='buy'?'bb':s.s==='sell'?'bs':'bh';
    const bl=s.s==='buy'?'▲ 買進':s.s==='sell'?'▼ 賣出':'◆ 中立';
    let range='';
    if(s.raw!==null&&s.min!==null){const pct=Math.min(100,Math.max(0,(s.raw-s.min)/(s.max-s.min)*100));range=`<div class="ic-range"><span class="rmin">${s.min}</span><div class="rbar"><div class="rdot" style="left:${pct}%"></div></div><span class="rmax">${s.max}</span></div>`;}
    const el=document.createElement('div');el.className=`ic ${s.s}`;
    el.innerHTML=`<div class="ic-top"><span class="ic-name">${s.name}</span><span class="ic-badge ${bc}">${bl}</span></div><div class="ic-group">${s.group}</div><div class="ic-val">${s.val}</div><div class="ic-desc">${s.desc}</div>${range}`;
    g.appendChild(el);
  }
}

// ══ AI 分析 ════════════════════════════════════════════════════════════
async function aiAnalysis(D,trend,risk,sigs){
  $('ai-card').style.display='block';
  $('ai-body').innerHTML='<div class="loading-row"><span class="spin"></span> AI 綜合研判中...</div>';
  const cur=D.currency==='TWD'?'NT$':'$';
  const sigSum=sigs.map(s=>`${s.name}:${s.s.toUpperCase()}`).join('、');
  try{
    const res=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,
        system:`你是頂尖短線交易員，奉行「風險優先、順勢操作、讓獲利奔跑」。請用繁體中文250字內，依分層邏輯給建議，不要廢話：
1.🚦趨勢結論：能不能做（趨勢過濾優先）
2.🎯關鍵訊號：最重要2~3個（背離、量能、Squeeze優先於一般指標）
3.🛡️風險紀律：根據ATR停損與風報比，提醒部位與停損
4.🧠心理提醒：點出當下最該避免的人性陷阱
語氣專業直接。`,
        messages:[{role:'user',content:`股票:${D.code}|現價:${cur}${D.price}|趨勢:${trend.verdict}|ATR停損:${cur}${fmt(risk.stopLoss)}|停利1:2:${cur}${fmt(risk.tp2)}|指標:${sigSum}`}]})
    });
    const d=await res.json();
    const txt=d.content?.[0]?.text||'無法取得分析';
    $('ai-body').innerHTML=txt.split('\n').filter(l=>l.trim()).map(l=>`<p>${l}</p>`).join('');
  }catch(e){ $('ai-body').innerHTML='<p style="color:var(--muted)">AI 分析暫時不可用，請依上方分層結果研判。</p>'; }
}

// ══ 主流程 ═════════════════════════════════════════════════════════════
function qs(t){$('ticker-input').value=t;go();}

async function go(){
  const raw=$('ticker-input').value.trim();
  if(!raw)return;
  const btn=$('go-btn');btn.disabled=true;btn.innerHTML='<span class="spin"></span>';
  hideErr();
  ['stock-bar','trend-banner','risk-card','psych-card','ai-card','market-card','quant-card'].forEach(id=>$(id).style.display='none');
  $('ind-grid').style.display='none';$('ind-grid').innerHTML='';
  $('cat-row').style.display='none';$('cat-tabs').innerHTML='';
  activeCat='全部';

  try{
    const D=await fetchStock(raw.toUpperCase());
    const atr=calcATR(D.highs,D.lows,D.closes,14);

    // stock bar
    const chg=D.price-D.prevClose,chgP=D.prevClose?chg/D.prevClose*100:0;
    const cur=D.currency==='TWD'?'':'$';
    $('sb-name').textContent=D.name;$('sb-code').textContent=D.code;
    $('sb-price').textContent=cur+fmt(D.price);
    const sc=$('sb-chg');sc.textContent=`${chg>=0?'+':''}${fmt(chg)} (${chgP>=0?'+':''}${chgP.toFixed(2)}%)`;sc.className='sb-chg '+(chg>=0?'up':'dn');
    $('m-open').textContent=cur+fmt(D.open);$('m-high').textContent=cur+fmt(D.high);
    $('m-low').textContent=cur+fmt(D.low);$('m-prev').textContent=cur+fmt(D.prevClose);
    $('m-atr').textContent=fmt(atr);
    $('m-vol').textContent=fmtV(D.volume)+(D.currency==='TWD'?' 張':' 股');
    $('stock-bar').style.display='block';
    const now=new Date();const tp=$('time-pill');tp.textContent=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} 更新`;tp.style.display='block';

    // 分層分析
    const trend=analyzeTrend(D);
    const risk=analyzeRisk(D,atr);
    const psych=analyzePsychology(D);
    allSigs=analyzeSignals(D,atr,trend);

    renderTrend(trend);
    renderRisk(risk);
    renderPsych(psych);
    renderTabs(allSigs);
    renderGrid(allSigs);

    // 大盤環境（第⓪層）+ 專屬量化分數
    const market=await fetchMarket();
    renderMarket(market);

    // 回測動態權重 → 專屬分數 → 韭菜反指標
    try{
      const weights=backtestWeights(D);
      const score=computeProprietaryScore(D,weights);
      const contra=contrarianSignal(D,market);
      renderQuant(score,contra);
    }catch(err){ console.warn('量化分數計算失敗',err); }

    await aiAnalysis(D,trend,risk,allSigs);
  }catch(e){ showErr(e.message); }
  finally{ btn.disabled=false;btn.innerHTML='⚡ 分析'; }
}

document.getElementById('ticker-input').addEventListener('keydown',e=>{if(e.key==='Enter')go();});
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});

// ══════════════════════════════════════════════════════════════════════
// 專屬量化分數渲染
// ══════════════════════════════════════════════════════════════════════
function renderQuant(score,contra){
  if(!score){ $('quant-card').style.display='none'; return; }
  $('quant-card').style.display='block';

  // 套用反指標調整
  const upFinal=Math.min(100,score.upPct+(contra?contra.upAdj:0));
  const downFinal=Math.min(100,score.downPct+(contra?contra.downAdj:0));

  $('q-up').textContent=upFinal;
  $('q-down').textContent=downFinal;
  $('q-up-conf').textContent=`${score.upMax} 個看漲訊號參與`+(contra&&contra.upAdj?`（含反指標+${contra.upAdj}）`:'');
  $('q-down-conf').textContent=`${score.downMax} 個看跌訊號參與`+(contra&&contra.downAdj?`（含反指標+${contra.downAdj}）`:'');

  // 綜合判斷
  const v=$('q-verdict');
  const diff=upFinal-downFinal;
  if(upFinal>=65&&diff>=20){v.textContent='🟢 強烈偏漲訊號（多項高命中指標共振）';v.style.background='var(--buy-d)';v.style.color='var(--buy)';}
  else if(downFinal>=65&&diff<=-20){v.textContent='🔴 強烈偏跌訊號（多項高命中指標共振）';v.style.background='var(--sell-d)';v.style.color='var(--sell)';}
  else if(Math.abs(diff)<15){v.textContent='⚪ 多空分數接近，方向不明確，觀望';v.style.background='var(--warn-d)';v.style.color='var(--warn)';}
  else if(diff>0){v.textContent='🟡 偏漲，但訊號強度中等';v.style.background='var(--warn-d)';v.style.color='var(--warn)';}
  else{v.textContent='🟡 偏跌，但訊號強度中等';v.style.background='var(--warn-d)';v.style.color='var(--warn)';}

  // 權重明細
  if(score.contrib.length===0){
    $('q-contrib').innerHTML='<div style="font-size:12px;color:var(--muted)">目前無足夠樣本的指標訊號（需累積更多歷史資料）</div>';
  }else{
    $('q-contrib').innerHTML=score.contrib.map(c=>{
      const col=c.dir==='漲'?'var(--buy)':'var(--sell)';
      const pct=Math.round(c.rate*100);
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:11px;width:60px;color:var(--muted)">${c.name}</span>
        <span style="font-size:10px;color:${col};width:30px">${c.dir}</span>
        <div style="flex:1;height:6px;background:var(--bd);border-radius:99px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${col}"></div></div>
        <span style="font-family:var(--mono);font-size:11px;color:${col};width:40px;text-align:right">${pct}%</span>
        <span style="font-size:9px;color:var(--muted);width:54px;text-align:right">${c.confident?c.samples+'樣本':'⚠️信心低'}</span>
      </div>`;
    }).join('');
  }

  // 韭菜反指標
  if(contra&&contra.alerts.length){
    $('q-contrarian').innerHTML='<div style="font-size:11px;color:var(--purple);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">🐑 韭菜反指標</div>'+
      contra.alerts.map(a=>`<div style="background:#A855F70a;border:1px solid #A855F730;border-radius:8px;padding:10px 12px;margin-bottom:6px;display:flex;gap:8px"><span style="font-size:16px">${a.icon}</span><div><div style="font-size:12px;font-weight:700;color:var(--purple);margin-bottom:2px">${a.title}</div><div style="font-size:11px;color:var(--muted);line-height:1.5">${a.desc}</div></div></div>`).join('');
  }else{
    $('q-contrarian').innerHTML='';
  }
}

// ══════════════════════════════════════════════════════════════════════
// 設定載入 / 儲存（IndexedDB）
// ══════════════════════════════════════════════════════════════════════
async function loadSettings(){
  try{
    const cap=await dbGetSetting('capital');
    const risk=await dbGetSetting('risk');
    const wr=await dbGetSetting('winrate');
    if(cap!=null)$('in-capital').value=cap;
    if(risk!=null)$('in-risk').value=risk;
    if(wr!=null)$('in-winrate').value=wr;
  }catch(e){ console.warn('載入設定失敗',e); }
}
async function saveSettings(){
  try{
    await dbSetSetting('capital',$('in-capital').value);
    await dbSetSetting('risk',$('in-risk').value);
    await dbSetSetting('winrate',$('in-winrate').value);
  }catch(e){}
}
// 輸入時自動存
['in-capital','in-risk','in-winrate'].forEach(id=>{
  const el=$(id);
  if(el) el.addEventListener('change',saveSettings);
});

// ══════════════════════════════════════════════════════════════════════
// 交易日誌
// ══════════════════════════════════════════════════════════════════════
function openJournal(){ $('journal-overlay').style.display='block'; refreshJournal(); 
  if(!$('tr-date').value) $('tr-date').value=new Date().toISOString().slice(0,10);
}
function closeJournal(){ $('journal-overlay').style.display='none'; }

async function addTradeFromForm(){
  const date=$('tr-date').value;
  const code=$('tr-code').value.trim().toUpperCase();
  const dir=$('tr-dir').value;
  const pnl=parseFloat($('tr-pnl').value);
  if(!date||isNaN(pnl)){ alert('請填日期與盈虧金額'); return; }
  const result=pnl>=0?'win':'loss';
  await dbAddTrade({date,code,direction:dir,result,pnl});
  $('tr-pnl').value='';$('tr-code').value='';
  await refreshJournal();
  await syncWinRateToMain();
}

async function refreshJournal(){
  const trades=await dbGetAllTrades();
  const s=computeStats(trades);
  // 統計卡
  const box=(label,val,col)=>`<div style="background:var(--bg);border:1px solid var(--bd);border-radius:10px;padding:10px;text-align:center"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:4px">${label}</div><div style="font-family:var(--mono);font-size:18px;font-weight:700;color:${col||'var(--txt)'}">${val}</div></div>`;
  $('journal-stats').innerHTML=
    box('交易筆數',s.count)+
    box('勝率',(s.winRate*100).toFixed(0)+'%','var(--buy)')+
    box('盈虧比',s.payoff.toFixed(2),'var(--acc)')+
    box('總盈虧',(s.totalPnl>=0?'+':'')+fmtV(Math.round(s.totalPnl)),s.totalPnl>=0?'var(--buy)':'var(--sell)')+
    box('平均獲利',fmtV(Math.round(s.avgWin)),'var(--buy)')+
    box('期望值/筆',(s.expectancy>=0?'+':'')+fmtV(Math.round(s.expectancy)),s.expectancy>=0?'var(--buy)':'var(--sell)');

  // 列表
  if(trades.length===0){ $('journal-list').innerHTML='<div style="font-size:12px;color:var(--muted);text-align:center;padding:16px">尚無交易紀錄，新增後自動計算真實勝率</div>'; return; }
  $('journal-list').innerHTML=trades.map(t=>{
    const win=t.result==='win';
    return `<div style="display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:8px 12px;margin-bottom:6px">
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted);width:78px">${t.date}</span>
      <span style="font-family:var(--mono);font-size:12px;width:48px">${t.code||'—'}</span>
      <span style="font-size:10px;color:var(--muted);width:32px">${t.direction==='long'?'多':'空'}</span>
      <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:${win?'var(--buy)':'var(--sell)'};flex:1;text-align:right">${t.pnl>=0?'+':''}${fmtV(t.pnl)}</span>
      <button onclick="delTrade('${t.id}')" style="background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:14px">🗑️</button>
    </div>`;
  }).join('');
}

async function delTrade(id){
  await dbDeleteTrade(id);
  await refreshJournal();
  await syncWinRateToMain();
}

// 把算出的真實勝率自動帶回主頁勝率欄
async function syncWinRateToMain(){
  const trades=await dbGetAllTrades();
  const s=computeStats(trades);
  if(s.count>=5){ // 至少5筆才有參考價值
    const wr=Math.round(s.winRate*100);
    $('in-winrate').value=wr;
    await dbSetSetting('winrate',wr);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 雲端同步按鈕
// ══════════════════════════════════════════════════════════════════════
async function doCloudSave(){
  const msg=$('sync-msg');msg.textContent='儲存中...';msg.style.color='var(--muted)';
  try{ await saveSettings(); await cloudSave(); msg.textContent='✅ 已存到雲端';msg.style.color='var(--buy)'; }
  catch(e){ msg.textContent='❌ '+e.message;msg.style.color='var(--sell)'; }
}
async function doCloudLoad(){
  const msg=$('sync-msg');msg.textContent='載入中...';msg.style.color='var(--muted)';
  try{ await cloudLoad(); await loadSettings(); await refreshJournal(); await syncWinRateToMain(); msg.textContent='✅ 已從雲端載入';msg.style.color='var(--buy)'; }
  catch(e){ msg.textContent='❌ '+e.message;msg.style.color='var(--sell)'; }
}

// 啟動時載入本地設定
loadSettings();
