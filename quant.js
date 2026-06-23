// ══════════════════════════════════════════════════════════════════════
// quant.js — 專屬量化系統
//   1. 回測動態權重：每個指標在「這檔股票」的歷史命中率
//   2. 專屬分數：大漲分數 / 大跌分數（加權合計）
//   3. 韭菜反指標：散戶情緒極端時反向加分
// ══════════════════════════════════════════════════════════════════════

// ── 回測設定 ──────────────────────────────────────────────────────────
const BT_HORIZON=5;      // 訊號後看幾天
const BT_BIG_MOVE=0.03;  // 「大漲/大跌」門檻：5天內漲跌超過 3%
const BT_MIN_SAMPLES=3;  // 低於此樣本數標記信心不足（資料少時放寬到3）
const BT_DEFAULT_RATE=0.5; // 樣本不足時的預設命中率（中性，不假裝很準）

// 在歷史每一天重算指標訊號，需要可回溯的輕量指標函式
// 為效率，回測只用「最具預測力」的核心指標子集

// 取得某索引位置 i 的「精簡指標訊號集」（buy/sell/hold）
function signalsAtIndex(closes,highs,lows,volumes,i){
  // 至少需要 60 根才算
  if(i<60) return null;
  const c=closes.slice(0,i+1), h=highs.slice(0,i+1), l=lows.slice(0,i+1), v=volumes.slice(0,i+1);
  const price=c[c.length-1], open=c[c.length-2]; // 近似當日開盤（無開盤資料時用前一收盤）
  const out={};

  // RSI14
  const rsi=_btRSI(c,14);
  out.RSI=rsi<30?'buy':rsi>70?'sell':'hold';

  // KD
  const kd=_btKD(h,l,c,9);
  out.KD=(kd.k<20&&kd.k>kd.d)?'buy':(kd.k>80&&kd.k<kd.d)?'sell':'hold';

  // MACD 柱狀體
  const m=_btMACD(c);
  out.MACD=(m.hist>0&&Math.abs(m.hist)>Math.abs(m.prev))?'buy':(m.hist<0&&Math.abs(m.hist)>Math.abs(m.prev))?'sell':'hold';

  // 均線排列
  const ma5=_btSMA(c,5),ma10=_btSMA(c,10),ma20=_btSMA(c,20);
  out.MA=(price>ma5&&ma5>ma10&&ma10>ma20)?'buy':(price<ma5&&ma5<ma10&&ma10<ma20)?'sell':'hold';

  // 200MA
  if(c.length>=200){const ma200=_btSMA(c,200);out.MA200=price>ma200?'buy':'sell';}

  // 布林位置
  const bb=_btBB(c,20,2);
  out.BB=price<=bb.lower?'buy':price>=bb.upper?'sell':'hold';

  // 量能
  const vr=v.length>=6?v[v.length-1]/(_avg(v.slice(-6,-1))):1;
  out.VOL=(price>open&&vr>1.5)?'buy':(price<open&&vr>1.5)?'sell':'hold';

  // ROC 動能
  const roc=c.length>13?(c[c.length-1]-c[c.length-13])/c[c.length-13]*100:0;
  out.ROC=roc>4?'buy':roc<-4?'sell':'hold';

  // 威廉
  const wr=_btWR(h,l,c,14);
  out.WR=wr<-80?'buy':wr>-20?'sell':'hold';

  return out;
}

// ── 回測主函式：算出每個指標的看漲/看跌命中率 ──────────────────────────
function backtestWeights(D){
  const{closes:c,highs:h,lows:l,volumes:v}=D;
  const n=c.length;
  // 統計容器：{指標:{buyHit,buyTotal,sellHit,sellTotal}}
  const stat={};
  const ind=(name)=>{if(!stat[name])stat[name]={buyHit:0,buyTotal:0,sellHit:0,sellTotal:0};return stat[name];};

  // 從第60根到「倒數第BT_HORIZON根」逐日回測
  for(let i=60;i<n-BT_HORIZON;i++){
    const sig=signalsAtIndex(c,h,l,v,i);
    if(!sig)continue;
    const future=(c[i+BT_HORIZON]-c[i])/c[i]; // 未來N天報酬
    const bigUp=future>=BT_BIG_MOVE;
    const bigDown=future<=-BT_BIG_MOVE;

    for(const name in sig){
      const s=sig[name];
      if(s==='buy'){
        const o=ind(name);o.buyTotal++;
        if(bigUp)o.buyHit++;        // 買進訊號後真的大漲 = 命中
      } else if(s==='sell'){
        const o=ind(name);o.sellTotal++;
        if(bigDown)o.sellHit++;     // 賣出訊號後真的大跌 = 命中
      }
    }
  }

  // 換算命中率與權重
  const weights={};
  for(const name in stat){
    const o=stat[name];
    const buyConfident=o.buyTotal>=BT_MIN_SAMPLES;
    const sellConfident=o.sellTotal>=BT_MIN_SAMPLES;
    // 樣本足夠用實際命中率；不足則用預設中性值（仍會顯示，標信心低）
    const buyRate=buyConfident?o.buyHit/o.buyTotal:(o.buyTotal>0?BT_DEFAULT_RATE:null);
    const sellRate=sellConfident?o.sellHit/o.sellTotal:(o.sellTotal>0?BT_DEFAULT_RATE:null);
    weights[name]={
      buyRate,sellRate,
      buyTotal:o.buyTotal,sellTotal:o.sellTotal,
      buyConfident,sellConfident
    };
  }
  return weights;
}

// ── 用回測權重 + 當前訊號，算專屬分數 ──────────────────────────────────
// curSignals: signalsAtIndex 對最後一天的結果
function computeProprietaryScore(D,weights){
  const{closes:c,highs:h,lows:l,volumes:v}=D;
  const cur=signalsAtIndex(c,h,l,v,c.length-1);
  if(!cur) return null;

  let upScore=0,upMax=0,downScore=0,downMax=0;
  const contrib=[]; // 每個指標的貢獻明細

  for(const name in cur){
    const w=weights[name];
    if(!w)continue;
    const s=cur[name];
    // 看漲：buy訊號 × buyRate
    if(s==='buy' && w.buyRate!=null){
      upScore+=w.buyRate; upMax+=1;
      contrib.push({name,dir:'漲',signal:'buy',rate:w.buyRate,samples:w.buyTotal,confident:w.buyConfident});
    }
    // 看跌：sell訊號 × sellRate
    if(s==='sell' && w.sellRate!=null){
      downScore+=w.sellRate; downMax+=1;
      contrib.push({name,dir:'跌',signal:'sell',rate:w.sellRate,samples:w.sellTotal,confident:w.sellConfident});
    }
  }

  // 正規化成 0~100
  const upPct=upMax>0?Math.round(upScore/upMax*100):0;
  const downPct=downMax>0?Math.round(downScore/downMax*100):0;

  contrib.sort((a,b)=>b.rate-a.rate);
  // 診斷：當前各指標訊號分布（讓使用者知道為何空白）
  const curSignals=Object.values(cur);
  const buyCount=curSignals.filter(s=>s==='buy').length;
  const sellCount=curSignals.filter(s=>s==='sell').length;
  const holdCount=curSignals.filter(s=>s==='hold').length;
  return{upPct,downPct,upMax,downMax,contrib,
    dataLen:c.length,buyCount,sellCount,holdCount};
}

// ── 韭菜反指標 ────────────────────────────────────────────────────────
// 散戶情緒極端時，給反向加分。market 為第⓪層大盤資料（可為 null）
function contrarianSignal(D,market){
  const c=D.closes, price=D.price;
  const alerts=[]; let upAdj=0,downAdj=0;

  // 1. 連續大漲後（散戶FOMO追高）→ 反向看跌
  let upStreak=0;
  for(let i=c.length-1;i>0;i--){if(c[i]>c[i-1])upStreak++;else break;}
  if(upStreak>=6){
    downAdj+=15;
    alerts.push({icon:'🐑',title:`散戶FOMO警訊：連漲${upStreak}根`,desc:`連續大漲常吸引散戶追高，統計上隨後回檔機率升高。反指標：偏空看待，+15 大跌分`});
  }
  // 2. 連續大跌後（散戶恐慌殺低）→ 反向看漲
  let downStreak=0;
  for(let i=c.length-1;i>0;i--){if(c[i]<c[i-1])downStreak++;else break;}
  if(downStreak>=6){
    upAdj+=15;
    alerts.push({icon:'🩸',title:`散戶恐慌警訊：連跌${downStreak}根`,desc:`連續大跌散戶恐慌殺出，常見超跌反彈。反指標：偏多看待，+15 大漲分`});
  }
  // 3. 乖離過大（追漲殺跌情緒）
  const ma20=_btSMA(c,20);
  const bias=(price-ma20)/ma20*100;
  if(bias>12){downAdj+=10;alerts.push({icon:'📛',title:`正乖離過大 +${bias.toFixed(0)}%`,desc:`股價遠離均線，散戶貪婪追價，反轉風險高。+10 大跌分`});}
  if(bias<-12){upAdj+=10;alerts.push({icon:'🔧',title:`負乖離過大 ${bias.toFixed(0)}%`,desc:`超跌深，散戶絕望拋售，反彈機率高。+10 大漲分`});}

  // 4. PCR 極端（來自大盤層）
  if(market&&market.taifex&&market.taifex.pcrOI){
    const pcr=market.taifex.pcrOI;
    if(pcr>130){upAdj+=10;alerts.push({icon:'⚖️',title:`PCR極高 ${pcr.toFixed(0)}%`,desc:`賣權避險爆量，散戶極度恐慌，物極必反。反指標偏多，+10 大漲分`});}
    if(pcr<70){downAdj+=10;alerts.push({icon:'⚖️',title:`PCR極低 ${pcr.toFixed(0)}%`,desc:`市場過度樂觀，散戶貪婪，留意反轉。反指標偏空，+10 大跌分`});}
  }

  return{upAdj,downAdj,alerts};
}

// ══ 回測專用輕量指標（獨立，避免污染主檔）══════════════════════════════
function _avg(a){return a.reduce((x,y)=>x+y,0)/a.length;}
function _btSMA(a,n){if(a.length<n)return a[a.length-1];return _avg(a.slice(-n));}
function _btEMAseries(a,n){const k=2/(n+1);let e=null;return a.map(v=>{e=e===null?v:v*k+e*(1-k);return e;});}
function _btRSI(c,n){
  if(c.length<n+1)return 50;
  let ag=0,al=0;
  for(let i=c.length-n;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)ag+=d;else al-=d;}
  ag/=n;al/=n;return al===0?100:100-100/(1+ag/al);
}
function _btKD(h,l,c,n){
  const len=c.length;const start=Math.max(n,len-30);
  let k=50,d=50;
  for(let i=start;i<len;i++){
    const hi=Math.max(...h.slice(i-n+1,i+1)),lo=Math.min(...l.slice(i-n+1,i+1));
    const rsv=hi===lo?50:(c[i]-lo)/(hi-lo)*100;
    k=k*2/3+rsv/3;d=d*2/3+k/3;
  }
  return{k,d};
}
function _btMACD(c){
  const e12=_btEMAseries(c,12),e26=_btEMAseries(c,26);
  const diff=e12.map((v,i)=>v-e26[i]);
  if(diff.length<35)return{hist:0,prev:0};
  const sig=_btEMAseries(diff.slice(25),9);
  const d=diff[diff.length-1],s=sig[sig.length-1];
  const pd=diff[diff.length-2],ps=sig[sig.length-2];
  return{hist:d-s,prev:pd-ps};
}
function _btBB(c,n,m){const mid=_btSMA(c,n);const sl=c.slice(-n);const mean=_avg(sl);const std=Math.sqrt(_avg(sl.map(v=>(v-mean)**2)));return{upper:mid+m*std,lower:mid-m*std,mid};}
function _btWR(h,l,c,n){const hi=Math.max(...h.slice(-n)),lo=Math.min(...l.slice(-n));return hi===lo?-50:(hi-c[c.length-1])/(hi-lo)*-100;}
