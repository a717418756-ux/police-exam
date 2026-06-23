/* ══════════════════════════════════════════════════════════════════════
   formula.js — 自創量化公式引擎（市面無，原創組合）
   ────────────────────────────────────────────────────────────────────
   STI  訊號張力指數    統計學：Z分數 + tanh 壓縮
   MFD  動量流變導數    微積分：一階(速度) + 二階(加速度)導數
   ECO  熵能轉折指標    資訊論：夏農熵
   CRASH 崩跌預警        三者對下跌方向的共振 + 量價背離
   FUSION 融合總分      四者加權合一
   依賴：app.js 的數學工具於本檔內自帶輕量版，獨立不污染
   ══════════════════════════════════════════════════════════════════════ */

/* ── 共用輕量工具 ─────────────────────────────────────────────────── */
function _f_mean(a){return a.reduce((x,y)=>x+y,0)/a.length;}
function _f_std(a){const m=_f_mean(a);return Math.sqrt(_f_mean(a.map(v=>(v-m)**2)));}
function _f_sma(a,n){if(a.length<n)return _f_mean(a);return _f_mean(a.slice(-n));}

/* ══════════════════════════════════════════════════════════════════════
   公式一：STI 訊號張力指數（Signal Tension Index）
   數學：STI = Σ[ wᵢ · tanh(zᵢ) ] / Σwᵢ × 100
        zᵢ = (xᵢ − μᵢ) / σᵢ   （Z分數標準化）
   原理：把 RSI/KD/乖離/動能等不同量綱的指標，用Z分數拉到同一尺度，
        tanh 壓縮極端值避免單一指標暴衝，加權平均成 -100~+100 張力。
        正=多方張力，負=空方張力。
   ══════════════════════════════════════════════════════════════════════ */
function calcSTI(D){
  const c=D.closes, h=D.highs, l=D.lows;
  const N=Math.min(60,c.length);
  const win=c.slice(-N);

  // 收集多個「可標準化」的子訊號（取近N期歷史算 μ,σ）
  const comps=[];

  // 1. 報酬率序列的最新Z（價格動能偏離）
  const rets=[];for(let i=1;i<win.length;i++)rets.push((win[i]-win[i-1])/win[i-1]);
  if(rets.length>5){
    const z=(rets[rets.length-1]-_f_mean(rets))/(_f_std(rets)||1);
    comps.push({w:1.2,z}); // 報酬動能權重高
  }

  // 2. 乖離率Z（價格 vs MA20）
  const ma20=_f_sma(c,20);
  const biasArr=win.map(p=>(p-ma20)/ma20);
  const biasZ=(biasArr[biasArr.length-1]-_f_mean(biasArr))/(_f_std(biasArr)||1);
  comps.push({w:1.0,z:biasZ});

  // 3. 量能Z（成交量偏離）
  if(D.volumes&&D.volumes.length>=N){
    const vwin=D.volumes.slice(-N);
    const vz=(vwin[vwin.length-1]-_f_mean(vwin))/(_f_std(vwin)||1);
    // 量能本身無方向，配合當日漲跌給方向
    const dir=c[c.length-1]>=c[c.length-2]?1:-1;
    comps.push({w:0.8,z:vz*dir});
  }

  // 4. 真實波幅Z（波動擴張，常伴隨方向）
  const trArr=[];
  for(let i=1;i<win.length;i++){
    trArr.push(Math.max(h[h.length-N+i]-l[l.length-N+i],
      Math.abs(h[h.length-N+i]-win[i-1]),Math.abs(l[l.length-N+i]-win[i-1])));
  }
  if(trArr.length>5){
    const trz=(trArr[trArr.length-1]-_f_mean(trArr))/(_f_std(trArr)||1);
    const dir=c[c.length-1]>=c[c.length-2]?1:-1;
    comps.push({w:0.6,z:trz*dir});
  }

  // 加權 tanh 合成
  let num=0,den=0;
  for(const cp of comps){ num+=cp.w*Math.tanh(cp.z); den+=cp.w; }
  const sti=den>0?num/den*100:0;

  return{
    value:sti,
    signal:sti>35?'buy':sti<-35?'sell':'hold',
    strength:Math.abs(sti),
    formula:'STI = Σ[wᵢ·tanh(zᵢ)] / Σwᵢ × 100',
    detail:`綜合 ${comps.length} 個標準化子訊號的多空張力`
  };
}

/* ══════════════════════════════════════════════════════════════════════
   公式二：MFD 動量流變導數（Momentum Flux Derivative）
   數學：MFD = α·(dP/dt) + β·(d²P/dt²)
        dP/dt ≈ 一階差分（速度，趨勢方向）
        d²P/dt² ≈ 二階差分（加速度，趨勢加強or衰竭）
   原理：價格對時間的微分。一階看方向，二階是關鍵——
        「還在漲但二階轉負」= 動能衰竭，常為轉折前兆（抓頂/抓底用）。
   大跌警示：價漲(一階>0)但二階明顯<0 → 上漲乏力，發出衰竭警告。
   ══════════════════════════════════════════════════════════════════════ */
function calcMFD(D){
  const c=D.closes;
  if(c.length<8)return{value:0,signal:'hold',formula:'MFD',detail:'資料不足'};

  // 先平滑（3日EMA近似）降噪，再求導
  const sm=[];let e=c[0];const k=2/(3+1);
  for(const v of c){e=v*k+e*(1-k);sm.push(e);}

  // 一階導數（速度）：近5日斜率（用線性差分平均）
  const n=sm.length;
  const v1=(sm[n-1]-sm[n-4])/3;          // 近3期平均速度
  const v0=(sm[n-4]-sm[n-7])/3;          // 前3期平均速度
  // 二階導數（加速度）：速度的變化
  const accel=v1-v0;

  // 正規化成相對價格%
  const price=c[c.length-1];
  const velPct=v1/price*100;
  const accPct=accel/price*100;

  // 合成（α重方向，β重加速度，加速度放大以捕捉轉折）
  const alpha=1.0, beta=3.0;
  const mfd=alpha*velPct+beta*accPct;

  // 訊號判斷（含衰竭警示）
  let signal='hold', warn='';
  if(velPct>0&&accPct<-0.15){ signal='sell'; warn='⚠️上漲動能衰竭（價漲但加速度轉負）'; }
  else if(velPct<0&&accPct>0.15){ signal='buy'; warn='✅下跌動能趨緩（價跌但加速度轉正，可能落底）'; }
  else if(mfd>0.3) signal='buy';
  else if(mfd<-0.3) signal='sell';

  return{
    value:mfd, velocity:velPct, accel:accPct,
    signal,warn,
    formula:'MFD = α·(dP/dt) + β·(d²P/dt²)',
    detail:`速度 ${velPct.toFixed(2)}%／加速度 ${accPct.toFixed(2)}%`+(warn?'｜'+warn:'')
  };
}

/* ══════════════════════════════════════════════════════════════════════
   公式三：ECO 熵能轉折指標（Entropy Compression Oscillator）
   數學：H = -Σ pᵢ·log₂(pᵢ)        （夏農熵）
        ECO = (1 − H/Hmax) × 100
   原理：把近期漲跌幅分桶成機率分布，算夏農熵。
        盤整=分布均勻=熵高=ECO低；趨勢明確=分布偏斜=熵低=ECO高。
        ECO 由低轉高 = 混沌收斂、趨勢即將成形（突破前兆）。
   ══════════════════════════════════════════════════════════════════════ */
function calcECO(D){
  const c=D.closes;
  const N=Math.min(20,c.length-1);
  if(N<8)return{value:0,signal:'hold',formula:'ECO',detail:'資料不足'};

  const rets=[];
  for(let i=c.length-N;i<c.length;i++)rets.push((c[i]-c[i-1])/c[i-1]);

  // 分5桶（強跌/弱跌/平/弱漲/強漲）
  const bins=[0,0,0,0,0];
  const sd=_f_std(rets)||0.001;
  for(const r of rets){
    if(r<-sd)bins[0]++;
    else if(r<-sd*0.3)bins[1]++;
    else if(r<=sd*0.3)bins[2]++;
    else if(r<=sd)bins[3]++;
    else bins[4]++;
  }
  const total=rets.length;
  let H=0;
  for(const b of bins){if(b>0){const p=b/total;H-=p*Math.log2(p);}}
  const Hmax=Math.log2(5);           // 5桶最大熵
  const eco=(1-H/Hmax)*100;          // 收斂度

  // 方向：看偏斜往哪邊
  const upMass=bins[3]+bins[4], downMass=bins[0]+bins[1];
  const dir=upMass>downMass?1:upMass<downMass?-1:0;

  let signal='hold';
  if(eco>40&&dir>0)signal='buy';
  else if(eco>40&&dir<0)signal='sell';

  return{
    value:eco, direction:dir,
    signal,
    formula:'ECO = (1 − H/Hmax)×100,  H=−Σpᵢlog₂pᵢ',
    detail:`趨勢收斂度 ${eco.toFixed(0)}%${eco>40?(dir>0?'，偏多成形':dir<0?'，偏空成形':''):'，仍混沌盤整'}`
  };
}

/* ══════════════════════════════════════════════════════════════════════
   崩跌預警（CRASH Alert）— 你最在意的大跌前警示
   邏輯：多重空方因子共振才觸發（降低假警報）
     ① MFD 上漲衰竭 或 加速度大幅轉負
     ② ECO 偏空成形
     ③ 量價背離（價漲量縮 / 價創高但RSI走弱）
     ④ STI 由正轉負且跌破0
   分數越高，短線崩跌風險越高。
   ══════════════════════════════════════════════════════════════════════ */
function calcCrashAlert(D,sti,mfd,eco){
  const c=D.closes, v=D.volumes;
  let score=0; const reasons=[];

  // ① 動能衰竭（二階導數轉負）
  if(mfd.accel!=null&&mfd.accel<-0.15){ score+=30; reasons.push('動能加速度轉負（MFD衰竭）'); }
  else if(mfd.accel!=null&&mfd.accel<-0.05){ score+=15; reasons.push('加速度走弱'); }

  // ② 熵偏空成形
  if(eco.value>40&&eco.direction<0){ score+=25; reasons.push('熵收斂偏空（ECO趨勢成形向下）'); }

  // ③ 量價背離
  if(v&&v.length>=6){
    const priceUp=c[c.length-1]>c[c.length-4];
    const vr=v[v.length-1]/(_f_mean(v.slice(-6,-1))||1);
    if(priceUp&&vr<0.7){ score+=20; reasons.push('價漲量縮背離（買盤虛弱）'); }
  }

  // ④ STI 轉空
  if(sti.value<-10){ score+=15; reasons.push('STI張力轉空'); }

  // ⑤ 急漲後（過熱回落風險）
  let upStreak=0;for(let i=c.length-1;i>0;i--){if(c[i]>c[i-1])upStreak++;else break;}
  if(upStreak>=6){ score+=10; reasons.push(`連漲${upStreak}根過熱`); }

  score=Math.min(100,score);
  let level='low';
  if(score>=60)level='high';
  else if(score>=35)level='mid';

  return{ score, level, reasons };
}

/* ══════════════════════════════════════════════════════════════════════
   FUSION 融合總分 — 三公式 + 崩跌權重合一
   多空淨值 = STI標準化 + MFD標準化 + ECO方向 − 崩跌風險懲罰
   ══════════════════════════════════════════════════════════════════════ */
function calcFusion(sti,mfd,eco,crash){
  // 各自正規化到 -1~1
  const s1=Math.tanh(sti.value/50);
  const s2=Math.tanh(mfd.value/1.5);
  const s3=eco.value>40?(eco.direction*eco.value/100):0;
  // 崩跌風險作為向下懲罰
  const penalty=crash.score/100;

  // 加權（MFD加速度對轉折最敏感，給最高權重）
  let raw=0.3*s1+0.4*s2+0.3*s3;
  raw-=penalty*0.5; // 崩跌風險拉低總分

  const fusion=Math.round(raw*100); // -100~+100

  let signal='hold',label;
  if(crash.level==='high'){signal='sell';label='🔴 崩跌預警優先 — 強烈避險';}
  else if(fusion>=40){signal='buy';label='🟢 多方共振，偏漲';}
  else if(fusion<=-40){signal='sell';label='🔴 空方共振，偏跌';}
  else if(fusion>15){signal='hold';label='🟡 偏多但力道中等';}
  else if(fusion<-15){signal='hold';label='🟡 偏空但力道中等';}
  else label='⚪ 多空均衡，方向不明';

  return{ value:fusion, signal, label };
}

/* ── 對外主入口：一次算完全部 ────────────────────────────────────────── */
function computeFormulas(D){
  if(!D||!D.closes||D.closes.length<20)return null;
  const sti=calcSTI(D);
  const mfd=calcMFD(D);
  const eco=calcECO(D);
  const crash=calcCrashAlert(D,sti,mfd,eco);
  const fusion=calcFusion(sti,mfd,eco,crash);
  return{ sti, mfd, eco, crash, fusion };
}
