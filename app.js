// ══════════════════════════════════════════════════════════════════════
// 短線雷達 Pro — 風險優先分層決策系統
// ══════════════════════════════════════════════════════════════════════
// app.js — 主流程控制器（go()為核心入口，串接所有分析模組並渲染）
// ──────────────────────────────────────────────────────────────────
// 全域狀態（僅go()主流程賦值，其他函式只讀不寫，防async競爭）：
//   window._activeCode   — 目前查詢中的股票代碼（補繪前必查此值防閃現舊股）
//   window._lastD        — 最近一次完整D物件（含opens/rawCloses等）
//   window._lastFormulas — 最近一次formulas物件
//   window._gateCtx      — 紀律門上下文（供margin/deep到達後補繪renderTradeGate）
//   window._bannerArgs   — 決策橫幅參數（v81起，供margin/deep到達後補繪橫幅警示）
// ──────────────────────────────────────────────────────────────────
// 近期版本異動：
//   v78  renderVerdictBanner呼叫處補傳D/regimeResult/mtfResult（8參數）
//   v81  新增window._bannerArgs登記，margin/deep補繪3處掛勾橫幅刷新，
//        全部加window._activeCode權威校驗（防遲到的舊股票回應閃現）
// ⚠️ 已知地雷／注意事項：
//   - v95修「同時段查同一檔結果不同」：根因是四個快取各自寫死不同TTL
//     （股價5分/融資5分/大盤10分/主力縱深10分），導致重查時各層過期時機
//     不同步，出現「股價已更新但大盤還是舊的」的混搭狀態，指標自然算出
//     不同結果。已統一為 config.js 的 CACHE_TTL 單一常數。
//     ★ 任何新增的資料快取一律使用 CACHE_TTL，不可另寫時間數字
//   - 任何新增的非同步補繪邏輯，必須比對 window._activeCode === D.code
//     才能渲染，否則使用者換股查詢時可能短暫看到上一檔的資料
//   - 卡片重置清單（約464行的陣列）與layout.js分頁清單、index.html卡片id
//     三處須同步；新增卡片時三處缺一即為「幽靈卡」（不會在正確時機顯示/隱藏）
// ══════════════════════════════════════════════════════════════════════

// ⚠️ 部署 Code.gs 後，把「網頁應用程式 URL」貼在這裡
// GAS_URL 由 config.js 宣告、啟動時從 IndexedDB 載入

// ── DOM helpers ───────────────────────────────────────────────────────
const $=id=>document.getElementById(id);
const fmt=(n,d=2)=>n==null||isNaN(n)?'—':Number(n).toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtV=v=>v==null?'—':v>=1e8?(v/1e8).toFixed(2)+'億':v>=1e4?(v/1e4).toFixed(1)+'萬':Number(v).toLocaleString();

function showErr(m){$('err-box').style.display='block';$('err-box').innerHTML=`<p style="color:var(--sell);font-weight:600;margin-bottom:6px">❌ ${m}</p><p style="color:var(--muted);font-size:12px">台股輸入4位數字（如 2330），美股輸入英文代碼（如 AAPL）。若確認正確仍失敗，可能為後端限流，稍後再試。</p>`;}
function hideErr(){$('err-box').style.display='none';}

// ── 抓資料（透過 GAS） ─────────────────────────────────────────────────
const _stockCache = {};  // 個股資料快取（5分鐘，重查同股秒回）
async function fetchStock(code){
  if(GAS_URL.indexOf('http')!==0) throw new Error('尚未設定 GAS 網址，請先部署 Code.gs 並把 URL 填入設定');
  // 快取命中（5分鐘內）
  const cached=_stockCache[code];
  if(cached && (Date.now()-cached.time < CACHE_TTL)){
    window._dataFetchedAt = cached.time;   // v95：記錄資料實際抓取時刻（非查詢時刻），供UI透明顯示
    window._dataFromCache = true;
    return cached.data;
  }
  let r;
  try{ r=await fetchT(`${GAS_URL}?code=${encodeURIComponent(code)}`); }
  catch(e){ if(typeof ErrorLog!=='undefined')ErrorLog.push('fetchStock連線',e); throw new Error('無法連線到 GAS 後端。請到右下 📒 → 設定，確認已填入 GAS 網址並按「測試連線」'); }
  if(!r.ok) throw new Error(`後端回應錯誤（${r.status}）`);
  const j=await r.json();
  if(!j.ok) throw new Error(j.error||'後端無法取得資料');
  if(!j.closes||j.closes.length<10) throw new Error(`${code} 歷史資料不足`);
  _stockCache[code]={data:j,time:Date.now()};
  window._dataFetchedAt = Date.now();
  window._dataFromCache = false;
  return j;
}

/* v141 盤中資料未定案處理 ─────────────────────────────────────────────
   使用者回報：同一檔早上查是「多、C級」，半小時後變「空、D級」。
   原因之一是盤中 Yahoo 會回傳「今天這根還沒收的K棒」，收盤價＝當下成交價，
   於是均線、ADX、突破、溫度計全部跟著跳動，判斷自然一直翻。
   修法：盤中（台北 09:00~14:00 且最後一根K就是今天）把今天這根未完成的K
   從序列中移除，所有判斷改以「最後一根已完成的K棒」計算，當天之內穩定；
   現價仍照常顯示與更新，供下單參考。收盤後資料定案，判斷才更新。 */
function trimIntradayBar(j) {
  try {
    if (!j || j._trimmed || !Array.isArray(j.closes) || j.closes.length < 60) return j;
    const d = new Date(Date.now() + 8 * 3600000);
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const during = d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && mins >= 9 * 60 && mins < 14 * 60;
    if (!during || String(j.lastDate || '') !== ymd) return j;
    ['closes', 'highs', 'lows', 'volumes', 'opens', 'rawCloses', 'rawHighs', 'rawLows']
      .forEach(k => { if (Array.isArray(j[k]) && j[k].length > 1) j[k] = j[k].slice(0, -1); });
    j._trimmed = true;
    j._intraday = ymd;     // 供橫幅與時間標籤顯示「盤中未定案」
  } catch (e) {}
  return j;
}

// ── 抓大盤環境（第⓪層） ────────────────────────────────────────────────

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
  out[n]=al===0?(ag===0?50:100):100-100/(1+ag/al);
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
function calcDMI(h,l,c,n=14){
  // 標準 Wilder ADX：+DI/-DI 先各自做 n 期 Wilder 平滑，再算 DX 序列，
  // 最後對 DX 序列再做一次 n 期 Wilder 平滑才是 ADX（單日DX雜訊很大，這層平滑才是「>25=趨勢明確」門檻站得住的原因）
  const len = c.length;
  if (len < n * 2 + 1) {
    // 資料不足以做完整雙重平滑，退回單期估計但不冒充標準ADX刻度（供極短資料的向下相容）
    let pdm=0,ndm=0,tr=0;
    for(let i=Math.max(1,len-n);i<len;i++){
      const up=h[i]-h[i-1],dn=l[i-1]-l[i];
      pdm+=up>dn&&up>0?up:0; ndm+=dn>up&&dn>0?dn:0;
      tr+=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
    }
    if(tr===0)return{adx:0,pdi:0,ndi:0};
    const pdi=pdm/tr*100,ndi=ndm/tr*100;
    return{adx:Math.abs(pdi-ndi)/(pdi+ndi)*100||0,pdi,ndi};
  }

  // 逐日算 +DM/-DM/TR，Wilder 平滑後得到逐日 +DI/-DI，再逐日算 DX
  const dxSeries = [];
  let smPDM=0, smNDM=0, smTR=0, pdiLast=0, ndiLast=0;
  const start = len - (n * 2 + 1);
  for (let i = start + 1; i < len; i++) {
    const up=h[i]-h[i-1], dn=l[i-1]-l[i];
    const pdm = up>dn&&up>0?up:0, ndm = dn>up&&dn>0?dn:0;
    const tr = Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
    const idxInWindow = i - start;
    if (idxInWindow <= n) {
      // 前n期：累加，第n期時轉換成初始平滑值
      smPDM += pdm; smNDM += ndm; smTR += tr;
      if (idxInWindow === n) {
        pdiLast = smTR ? smPDM/smTR*100 : 0;
        ndiLast = smTR ? smNDM/smTR*100 : 0;
        const dx = (pdiLast+ndiLast) ? Math.abs(pdiLast-ndiLast)/(pdiLast+ndiLast)*100 : 0;
        dxSeries.push(dx);
      }
    } else {
      // Wilder 平滑遞迴：新值 = 舊值 - 舊值/n + 當期值
      smPDM = smPDM - smPDM/n + pdm;
      smNDM = smNDM - smNDM/n + ndm;
      smTR  = smTR  - smTR/n  + tr;
      pdiLast = smTR ? smPDM/smTR*100 : 0;
      ndiLast = smTR ? smNDM/smTR*100 : 0;
      const dx = (pdiLast+ndiLast) ? Math.abs(pdiLast-ndiLast)/(pdiLast+ndiLast)*100 : 0;
      dxSeries.push(dx);
    }
  }
  if (!dxSeries.length) return { adx: 0, pdi: pdiLast, ndi: ndiLast };

  // 對 DX 序列做第二層 Wilder 平滑 → 這才是真正的 ADX
  let adx = dxSeries.slice(0, Math.min(n, dxSeries.length)).reduce((a,b)=>a+b,0) / Math.min(n, dxSeries.length);
  for (let i = n; i < dxSeries.length; i++) {
    adx = (adx * (n-1) + dxSeries[i]) / n;
  }
  return { adx, pdi: pdiLast, ndi: ndiLast };
}
function calcROC(c,n=12){const p=c[c.length-1-n];return p?(c[c.length-1]-p)/p*100:0;}

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
  // 停損/停利/部位是實際下單參考價，用未還原市價（與智慧停損/劇本/紀律門執行計畫基準一致）
  const price=D.rawCloses?D.rawCloses[D.rawCloses.length-1]:D.price;
  const rawH=D.rawHighs||D.highs;
  const capital=parseFloat($('in-capital').value)||1000000;
  const riskPct=parseFloat($('in-risk').value)||1;
  const winRate=Math.min(95,Math.max(5,parseFloat($('in-winrate').value)||50))/100;

  // ATR 停損（2倍）
  const atrMult=2;
  let stopLoss=price-atr*atrMult;
  // ── v80聯動：停損防掃調整 ──
  // 原理：停損若恰好放在「人人看得到的線位（趨勢線/箱底/頸線）或整數關卡」內側緊貼處，
  // 正好落在全市場停損聚集區，最容易被掃損後反轉。偵測到即下移到該價位外側0.8%。
  let stopNote=null;
  try{
    const levels=[];
    if(typeof computeChartPatterns==='function'){
      const cp=computeChartPatterns(D);
      if(cp) cp.patterns.forEach(p=>{ if(p.level<price)levels.push({v:p.level,name:p.kind}); if(p.level2&&p.level2<price)levels.push({v:p.level2,name:p.kind+'下緣'}); });
    }
    if(typeof computeAnchoring==='function'){
      const an=computeAnchoring(D);
      if(an&&an.nearRound&&an.nearestRound<price) levels.push({v:an.nearestRound,name:'整數關卡'});
    }
    for(const L of levels){
      // 停損在線位上方且距離<0.6%價格 = 貼在掃損區內側
      if(stopLoss>L.v && (stopLoss-L.v)/price<0.006){
        stopLoss=L.v*0.992;
        stopNote=`已避開掃損區：原停損貼近「${L.name} ${L.v.toFixed(2)}」內側（全市場停損聚集處），下移至其外側0.8%`;
        break;
      }
    }
  }catch(e){}
  const stopDist=price-stopLoss;
  const stopPct=stopDist/price*100;

  // Chandelier Exit（最高價 - ATR×3）移動停利
  const recentHigh=Math.max(...rawH.slice(-22));
  const chandelier=recentHigh-atr*3;

  // 風報比 1:2 與 1:3 對應的停利價
  const tp2=price+stopDist*2;
  const tp3=price+stopDist*3;

  // 固定風險法部位大小
  const riskAmount=capital*riskPct/100;
  const shares=stopDist>0?Math.floor(riskAmount/stopDist):0;
  const positionValue=shares*price;
  const positionPct=positionValue/capital*100;

  /* 凱利公式：f = (bp - q)/b，b=盈虧比
     v128修：原本固定 b=2（假設風報比1:2），但 v124 的 MFE 實證顯示這個假設
     對短線嚴重失真——2313 的停損14.3% vs 5日中位可達3.1%，真實 b 僅 0.21。
     用虛高的 b 會把凱利比例算得過大，直接導致部位過重。
     改為：若能取得此股的實際 MFE 風報比就用實際值，取不到才退回保守的 b=1。
     （b=1 比原本的 b=2 保守，符合「寧可低估也不高估部位」的風控原則） */
  let b = 1;   // 保守預設（原為2，已證實過度樂觀）
  let bSource = '保守預設1:1（未取得此股實測風報比）';
  try {
    if (typeof computeRealisticTargets === 'function' && stopPct > 0) {
      const rt = computeRealisticTargets(D, -1, stopPct);
      const row5 = rt && rt.rows ? rt.rows.find(r => r.days === 5) : null;
      if (row5 && row5.rr > 0) { b = row5.rr; bSource = `此股實測（5日中位可達 ${row5.medPct.toFixed(1)}% ÷ 停損 ${stopPct.toFixed(1)}%）`; }
    }
  } catch (e) {}
  const q=1-winRate;
  const kellyFull=Math.max(0,(b*winRate-q)/b);   // 負值代表此結構不該下注，夾為0
  const kellyHalf=kellyFull/2;
  const kellyQuarter=kellyFull/4;
  /* v129：只顯示「凱利=0」使用者會困惑，補上可行動的資訊——
     損益兩平勝率 = 1/(1+b)：以此股風報比，勝率要超過這個值才值得下注。
     這是專業交易的核心概念：風報比越差，需要的勝率越高。
     例：b=0.36（2330實測）→ 需勝率>73.5%；b=2 → 只需>33.3%。
     短線做空最常見的死因就是「風報比0.2卻用50%勝率的心態下注」。 */
  const breakevenWR = 1 / (1 + b);
  /* v129：只說「需82%勝率」還是死路，要給出路。
     實測所有標的的損益兩平勝率都落在70~82%（因為2×ATR停損對短線太寬），
     代表問題不在選股而在「進場位置」——停損寬窄由「進場價距離關鍵位多遠」決定。
     這裡反推：若要把門檻降到合理的55%勝率，停損必須縮到多少。
     這正是「等回測支撐/壓力再進場」的真正價值：不是為了方向更準，
     而是為了讓停損能放得夠近，把數學結構從負期望值扭轉為正。 */
  let fixSuggestion = null;
  try {
    if (typeof computeRealisticTargets === 'function' && stopPct > 0) {
      const rt2 = computeRealisticTargets(D, -1, stopPct);
      const r5 = rt2 && rt2.rows ? rt2.rows.find(r => r.days === 5) : null;
      if (r5 && breakevenWR > 0.6) {
        const bNeed = (1 - 0.55) / 0.55;              // 目標：55%勝率即可獲利
        const stopNeed = r5.medPct / bNeed;           // 反推所需停損距離%
        if (stopNeed > 0 && stopNeed < stopPct) {
          fixSuggestion = { stopNeedPct: stopNeed, curStopPct: stopPct, medPct: r5.medPct,
            shrink: (1 - stopNeed / stopPct) * 100 };
        }
      }
    }
  } catch (e) {}

  return{capital,riskPct,winRate,atr,stopLoss,stopPct,stopDist,chandelier,tp2,tp3,stopNote,b,bSource,breakevenWR,fixSuggestion,
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
  const bbP=(price-bb.lower)/((bb.upper-bb.lower)||1)*100;
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

  // ROC 動能（與 MACD 算法不同，保留為輔助）
  const roc=calcROC(c,12);
  add('ROC 變動率','動能',`${roc>=0?'+':''}${roc.toFixed(1)}%`,roc,-15,15,roc>4?'buy':roc<-4?'sell':'hold',
    roc>4?`12日 +${roc.toFixed(1)}% 動能強`:roc<-4?`12日 ${roc.toFixed(1)}% 弱`:`動能 ${roc.toFixed(1)}% 平淡`);

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
    {cls:'',label:'🛑 ATR 停損價 (2×ATR)',value:cur+fmt(r.stopLoss),valCls:'sell',sub:`停損距離 ${fmt(r.stopDist)}（${r.stopPct.toFixed(1)}%）${r.stopNote?'。📐 '+r.stopNote:'，比固定%停損更貼合波動'}`},
    {cls:'good',label:'🎯 停利價 1:2 風報比',value:cur+fmt(r.tp2),valCls:'buy',sub:`風報比 1:2，即使勝率40%長期仍可能獲利`},
    {cls:'good',label:'🎯 停利價 1:3 風報比',value:cur+fmt(r.tp3),valCls:'buy',sub:`理想風報比，讓獲利奔跑`},
    {cls:'warn',label:'🪜 移動停利 (Chandelier)',value:cur+fmt(r.chandelier),valCls:'warn',sub:`最高價-3×ATR，股價創高就上移，保護獲利`},
    {cls:'',label:'📦 建議部位（固定風險法）',value:`${fmt(r.shares,0)} ${r.currency==='TWD'?'股':'股'}`,valCls:'',sub:`單筆風險 ${cur}${fmtV(Math.round(r.riskAmount))}（資金${r.riskPct}%），佔總資金 ${r.positionPct.toFixed(1)}%`},
    {cls:'warn',label:'🎲 凱利建議比例',value:`${(r.kellyHalf*100).toFixed(1)}%`,valCls:'warn',sub:`半凱利（保守）。全凱利 ${(r.kellyFull*100).toFixed(1)}%／四分之一凱利 ${(r.kellyQuarter*100).toFixed(1)}%。風報比 1:${r.b.toFixed(2)}（${r.bSource}）｜<b>損益兩平勝率 ${(r.breakevenWR*100).toFixed(0)}%</b>——你的勝率需高於此才值得下注，目前填 ${(r.winRate*100).toFixed(0)}%${r.kellyFull<=0?`。<span style="color:var(--sell)">⚠️ 凱利=0：以此風報比，${(r.winRate*100).toFixed(0)}%勝率是負期望值，這筆不該做</span>`:''}${r.fixSuggestion?`<br><span style="color:var(--warn)">🔧 <b>出路</b>：問題在進場位置不在選股。若停損能從 ${r.fixSuggestion.curStopPct.toFixed(1)}% 縮到 <b>${r.fixSuggestion.stopNeedPct.toFixed(1)}%</b>（縮 ${r.fixSuggestion.shrink.toFixed(0)}%），損益兩平勝率就降到55%。做法：等價格回測到關鍵壓力/支撐附近再進場，把停損貼在該結構外緣——這才是「等回測」的真正價值，不是方向更準，而是讓數學結構由負轉正。</span>`:''}`},
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
    const res=await fetchT('https://api.anthropic.com/v1/messages',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,
        system:`你是頂尖短線交易員，奉行「風險優先、成本優先、不做負期望值的交易」。請用繁體中文250字內，依分層邏輯給建議，不要廢話：
1.🚦能不能做：以紀律門、期望值與停損距離為準，趨勢只作背景
2.🎯關鍵訊號：最重要2~3個（背離、量能、Squeeze優先於一般指標）
3.🛡️風險紀律：根據ATR停損與風報比，提醒部位與停損
4.🧠心理提醒：點出當下最該避免的人性陷阱
語氣專業直接。`,
        messages:[{role:'user',content:`股票:${D.code}|現價:${cur}${fmt(D.rawCloses?D.rawCloses[D.rawCloses.length-1]:D.price)}|趨勢:${trend.verdict}|ATR停損:${cur}${fmt(risk.stopLoss)}|停利1:2:${cur}${fmt(risk.tp2)}|指標:${sigSum}`}]})
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
  ['stock-bar','trend-banner','risk-card','psych-card','ai-card','market-card','quant-card','formula-card','mktscore-card','chip-card','playbook-card','riskmetric-card','multiperiod-card','health-card','regime-card','rs-card','beta-card','prob-card','sr-card','vpradar-card','bingfa-card','verdict-banner','smc-card','resonance-card','mainforce-card','margin-card','mtf-card','crowd-card','gate-card','behavior-chain-card','movestage-card','oos-card','fundamental-card','deepchip-card'].forEach(id=>$(id).style.display='none');
  $('ind-grid').style.display='none';$('ind-grid').innerHTML='';
  $('cat-row').style.display='none';$('cat-tabs').innerHTML='';
  activeCat='全部';

  try{
    const queryCode=raw.toUpperCase();
    window._activeCode=queryCode;  // 立即登記，任何比這更早查詢的舊請求回來時會被丟棄（防async競爭張冠李戴）
    const D=trimIntradayBar(await fetchStock(queryCode));
    // ATR 用未還原市價序列算（下游停損/劇本/紀律門都用原始價，ATR基準需一致，
    // 否則「還原ATR」套用在「原始價±N×ATR」公式上會算出錯誤的停損距離）
    const atr=calcATR(D.rawHighs||D.highs, D.rawLows||D.lows, D.rawCloses||D.closes, 14);

    // stock bar
    const chg=D.price-D.prevClose,chgP=D.prevClose?chg/D.prevClose*100:0;
    const cur=D.currency==='TWD'?'':'$';
    $('sb-name').textContent=D.name;$('sb-code').textContent=D.code;
    $('sb-price').textContent=cur+fmt(D.price);
    const sc=$('sb-chg');sc.textContent=`${chg>=0?'+':''}${fmt(chg)} (${chgP>=0?'+':''}${chgP.toFixed(2)}%)`;sc.className='sb-chg '+(chg>=0?'up':'dn');
    $('m-open').textContent=cur+fmt(D.open);$('m-high').textContent=cur+fmt(D.high);
    $('m-low').textContent=cur+fmt(D.low);$('m-prev').textContent=cur+fmt(D.prevClose);
    $('m-atr').textContent=fmt(atr);
    $('m-vol').textContent=(D.currency==='TWD'?fmtV(Math.round(D.volume/1000))+' 張':fmtV(D.volume)+' 股');
    $('stock-bar').style.display='block';
    // v95：顯示「資料實際抓取時刻」而非查詢時刻，並標示是否來自快取——
    // 使用者反映「同時段查同一檔結果不同」，根因是各層快取TTL不一（已統一），
    // 此處讓資料新鮮度透明可見，若看到「快取」字樣即知數字未變是正常的
    const ft = window._dataFetchedAt ? new Date(window._dataFetchedAt) : new Date();
    const tp=$('time-pill');
    const ageSec = Math.round((Date.now() - (window._dataFetchedAt || Date.now())) / 1000);
    const lastK = D.lastDate ? String(D.lastDate) : '';   // v141：改用本次查詢的D（_lastD此時還是上一檔，會顯示錯日期）
    const kTxt = D._intraday ? '盤中·判斷用前一交易日K｜' : (lastK.length>=8 ? `K線至${lastK.slice(4,6)}/${lastK.slice(6,8)}｜` : '');
    tp.textContent=`v${APP_VERSION}｜${kTxt}${String(ft.getHours()).padStart(2,'0')}:${String(ft.getMinutes()).padStart(2,'0')}抓取${window._dataFromCache ? `（快取${ageSec}s）` : '（即時）'}`;
    tp.style.display='block';
    tp.title = window._dataFromCache ? `此結果使用 ${ageSec} 秒前抓取的資料（5分鐘內重查會沿用，確保結果可重現）。想強制更新請等快取過期或重新載入頁面。` : '此結果為剛抓取的即時資料';
    /* v108 裝置診斷：同一檔在手機/電腦顯示不同數字，原因幾乎都是這四項之一——
       ①版本不同（PWA快取住舊版）②資金設定不同 ③風險%設定不同 ④交易日誌未同步
       （6%預算算本地日誌）。這些都存在各裝置本地，無法自動一致，但點一下就能比對。 */
    tp.style.cursor = 'pointer';
    tp.onclick = async () => {
      const cap = document.getElementById('in-capital')?.value || '?';
      const rsk = document.getElementById('in-risk')?.value || '?';
      let jn = '?';
      try { const ts = await dbGetAllTrades(); jn = `${ts.length}筆（真實${ts.filter(t => !t.sim).length}）`; } catch (e) {}
      const rb = window._riskBudget;
      const ftTxt = window._dataFetchedAt ? new Date(window._dataFetchedAt).toLocaleString('zh-TW') : '—';
      alert(`【裝置診斷】兩台裝置數字不同時，逐項比對這裡\n\n` +
        `版本：v${APP_VERSION}\n` +
        `資金設定：${cap}\n` +
        `單筆風險：${rsk}%\n` +
        `交易日誌：${jn}\n` +
        `本月風險預算：${rb ? rb.usedPct + '% 已用／剩 ' + rb.remainPct + '%' : '—'}\n` +
        `K線最後日：${lastK ? lastK.slice(0,4)+'/'+lastK.slice(4,6)+'/'+lastK.slice(6,8) : '—'}\n` +
        `資料抓取：${ftTxt}${window._dataFromCache ? '（快取）' : '（即時）'}\n\n` +
        `※版本不同 → 手機請關閉PWA重開或清除站台資料\n` +
        `※資金/風險/日誌不同 → 部位、停損金額、6%預算必然不同（設定與日誌存各裝置本地，需手動在設定頁同步）`);
    };

    // 分層分析
    const trend=analyzeTrend(D);
    const risk=analyzeRisk(D,atr);
    const psych=analyzePsychology(D);
    allSigs=analyzeSignals(D,atr,trend);

    renderTrend(trend);
    // ADX 市場狀態（該用趨勢還是震盪策略）
    let regimeResult=null;
    try{ regimeResult=computeRegime(D); renderRegime(regimeResult); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('市場狀態',err); }
    renderRisk(risk);
    renderPsych(psych);
    renderTabs(allSigs);
    renderGrid(allSigs);

    // 大盤環境（第⓪層）+ 市場總分 + 專屬量化分數
    const market=await fetchMarket();
    renderMarket(market);

    // 市場環境總分（含 VIX）
    let marketScore=null;
    try{ marketScore=computeMarketScore(market); renderMarketScore(marketScore); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('市場總分',err); }

    // 籌碼面（外資/投信，台股才有）
    try{ renderChip(D.chip, D); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('籌碼面',err); }

    // 進出場劇本
    try{ renderMoveStage(D); }catch(e){}
    try{ renderPlaybook(D,atr); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('進出場劇本',err); }

    // 風險強化（回撤+波動率）
    let riskMetrics=null;
    try{ riskMetrics=computeRiskMetrics(D); renderRiskMetrics(riskMetrics); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('風險強化',err); }

    // 多週期回測
    try{ renderMultiPeriod(multiPeriodBacktest(D)); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('多週期回測',err); }

    // ── 進階分析（法人等級）──
    // 支撐壓力、量價雷達、機率預測（不需大盤資料，先做）
    try{ renderSupportResistance(computeSupportResistance(D), D); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('支撐壓力',err); }
    try{ renderVolPriceRadar(computeVolPriceRadar(D)); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('量價雷達',err); }
    try{ renderProbability(computeProbability(D)); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('機率預測',err); }

    // 回測動態權重 → 專屬分數 → 韭菜反指標
    let formulas=null;
    try{
      const weights=backtestWeights(D);
      const score=computeProprietaryScore(D,weights);
      const contra=contrarianSignal(D,market);
      renderQuant(score,contra);
    }catch(err){ console.warn('量化分數計算失敗',err); if(typeof ErrorLog!=='undefined')ErrorLog.push('量化分數',err); }

    // 自創公式（STI / MFD / ECO / 崩跌預警 / 融合總分）
    try{
      formulas=computeFormulas(D);
      renderFormulas(formulas);
      // 記錄「當下這檔的公式分數」，供交易日誌帶入（讓匯出能改公式）
      if(formulas){
        window._lastAnalysis={
          code:D.code, price:D.price, date:new Date().toISOString().slice(0,10),
          sti:Math.round(formulas.sti.value*10)/10,
          mfd:Math.round(formulas.mfd.value*100)/100,
          eco:Math.round(formulas.eco.value),
          fusion:formulas.fusion.value,
          crash:formulas.crash.score
        };
      }
    }catch(err){ console.warn('自創公式計算失敗',err); if(typeof ErrorLog!=='undefined')ErrorLog.push('自創公式',err); }

    // 個股健康度體檢（彙整各層級）
    try{
      renderHealthReport({trend,formulas,riskMetrics:riskMetrics||{maxDD:0,annualVol:30},chip:D.chip,marketScore,signals:allSigs});
    }catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('健康度',err); }

    // 機構足跡：VWAP + 結構 + 過熱反指標
    try{ if(typeof renderSMC==='function') renderSMC(D, formulas, market); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('機構足跡',err); }

    // 多時間框架共振（月/週/日）
    let mtfResult=null;
    try{ if(typeof computeMTF==='function'){ mtfResult=computeMTF(D); renderMTF(D); } }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('MTF',err); }

    // 貝氏機率整合（真機率，非燈號）
    try{ if(typeof renderBayes==='function') renderBayes(D); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('貝氏機率',err); }

    // 主力行為推估（OBV偷跑/洗盤/出貨/誘多誘空）
    try{ if(typeof renderMainForce==='function') renderMainForce(D, formulas); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('主力行為',err); }

    // 樣本外驗證（誠實準確率：前70%訓練、後30%測試）
    try{ if(typeof renderOOS==='function') renderOOS(D); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('樣本外驗證',err); }

    // 基本面體檢（台股，非同步不擋主流程）
    try{ if(typeof loadFundamentalCard==='function') loadFundamentalCard(D); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('基本面',err); }

    // 主力縱深（FinMind，token 選填，非同步不擋主流程）
    try{ if(typeof loadDeepChipCard==='function') loadDeepChipCard(D); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('主力縱深',err); }

    window._lastD=D; window._lastFormulas=formulas;  // 供補繪反明牌/紀律門/主力縱深/基本面（_activeCode 已於函式開頭登記）
    // 散戶擁擠度反指標（反AI散戶引擎）
    try{ if(typeof renderCrowding==='function') renderCrowding(D, formulas); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('擁擠度',err); }

    // 融資融券散戶心理（台股限定，非同步不擋主流程）
    try{ if(D.currency==='TWD' && typeof loadMarginCard==='function') loadMarginCard(D); }
    catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('融資融券',err); }

    // RS Rating / Beta / Alpha / 兵法系統（需大盤基準，此時 formulas 已就緒）
    fetchBenchmark(D.currency==='TWD').then(bench=>{
      if(window._activeCode && window._activeCode!==D.code) return;  // 已換股，丟棄遲到基準，避免用舊D重畫決策層
      let rsRating=null;
      try{
        const benchRet = bench && bench.length>252 ? (bench[bench.length-1]-bench[bench.length-253])/bench[bench.length-253] : null;
        const rs=computeRSRating(D, benchRet);
        rsRating=rs.rating;
        renderRSRating(rs);
      }catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('RS評級',err); }
      try{ renderBetaAlpha(computeBetaAlpha(D, bench)); }
      catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('BetaAlpha',err); }

      // ── 中國兵法交易系統（formulas/riskMetrics 此時保證已算完）──
      try{
        const shi=computeShiPower(D, rsRating);
        const tradeScore=computeTradeScore(D, shi, formulas, riskMetrics, rsRating);
        const exit=computeBingfaExit(D.rawCloses ? D.rawCloses[D.rawCloses.length-1] : D.price);
        renderBingfa(D, shi, tradeScore, exit);
        checkBingfaWarning();

        // 多維度共振先算 → 信心指數餵給決策橫幅（指標衝突時自動降信心）
        let res=null;
        try{
          const vwap=(typeof computeVWAP==='function')?computeVWAP(D,20):null;
          const structure=(typeof computeStructure==='function')?computeStructure(D):null;
          const overheat=(typeof computeOverheat==='function')?computeOverheat(D,formulas,market):null;
          res=computeResonance({D,trend,formulas,chip:D.chip,vwap,structure,overheat,rsRating,marketScore,shi,mtf:mtfResult,regime:regimeResult});
          renderResonance(res);
        }catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('共振確認',err); }
        renderVerdictBanner(shi, tradeScore, formulas, marketScore, res, D, regimeResult, mtfResult);
        window._bannerArgs = { shi, tradeScore, formulas, marketScore, res, D, regime: regimeResult, mtf: mtfResult };   // 供margin/deep非同步到達後補繪橫幅警示

        // 出手紀律門（濃縮全站分析為出手/禁止裁決）
        try{
          const gateCtx={D, regime:(typeof computeRegime==='function'?computeRegime(D):null), mtf:mtfResult, res, formulas, shi};
          window._gateCtx=gateCtx;  // 供融資載入後補繪
          renderTradeGate(gateCtx);
        }catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('紀律門',err); }
      }catch(err){ if(typeof ErrorLog!=='undefined')ErrorLog.push('兵法系統',err); }

      // 大盤資料回來後重整版面（確保 RS/兵法卡歸位）
      if(typeof applyLayout==='function') applyLayout();
    });

    await aiAnalysis(D,trend,risk,allSigs);

    // 介面整合：把所有卡片分組為分頁
    if(typeof applyLayout==='function') applyLayout();
  }catch(e){ showErr(e.message); }
  finally{ btn.disabled=false;btn.innerHTML='⚡ 分析'; }
}

document.getElementById('ticker-input').addEventListener('keydown',e=>{if(e.key==='Enter')go();});
/* v143 修「改版後網頁一直是舊的、開無痕才是新版」──
   舊寫法 register('./sw.js')：sw.js 的內容每版都一樣（版本號是從 config.js 帶入的），
   瀏覽器比對 sw.js 位元組沒變 → 判定「沒有新版 SW」→ 不重裝 → 繼續用舊快取的
   config.js/app.js，於是版本號永遠停在舊版；無痕視窗沒有 SW 才會拿到新檔。
   修法：①註冊網址帶版本（?v=APP_VERSION），版本一變網址就變，瀏覽器必定視為新SW
        ②updateViaCache:'none'：sw.js 本身與其 importScripts 不吃瀏覽器HTTP快取
        ③新SW接手後自動重新載入一次（僅限本來就有舊SW的情況，首次安裝不重載） */
/* v145 載入完整性檢查：部署漏檔或某個 .js 沒載到時，症狀是「按某個按鈕才發現功能不存在」
   （使用者實例：匯入備份時出現 importBackup is not defined ＝ db.js 沒載進來）。
   這裡在啟動時直接點名缺哪個檔，並在畫面頂端紅字提示，不必等踩到才知道。 */
const FILE_CHECK = {
  'config.js': ['twMarketPhase'], 'help.js': ['showHelp'], 'db.js': ['dbAddTrade', 'importBackup', 'exportBackup'],
  'market.js': ['fetchMarket'], 'quant.js': ['computeProprietaryScore', 'backtestWeights'], 'formula.js': ['calcSTI'],
  'enhance.js': ['computeRegime', 'computeChipHealth'], 'advanced.js': ['computeProbLogLoss'], 'smc.js': ['computeVWAP'],
  'mainforce.js': ['computeMainForce', 'computeSmartStop'], 'mtf.js': ['computeMTF'], 'resonance.js': ['computeResonance'],
  'bingfa.js': ['renderTradeGate', 'renderVerdictBanner'], 'layout.js': ['switchTab'], 'journal.js': ['refreshJournal', 'importLocalFile'],
  'scan.js': ['runScanAuto'],
};
function checkFilesLoaded() {
  const missing = [];
  for (const [file, fns] of Object.entries(FILE_CHECK))
    if (fns.some(fn => typeof window[fn] !== 'function')) missing.push(file);
  if (!missing.length) return true;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#7F1D1D;color:#fff;padding:10px 12px;font-size:12px;line-height:1.6';
  bar.innerHTML = `⚠️ 程式檔未完整載入：<b>${missing.join('、')}</b>（部分功能會失效）<br>請到 📒 → ⚙️ 設定 → 「🔄 清除快取並重新載入」；若仍相同，代表主機上缺少這些檔案，請重新部署。`;
  document.body.appendChild(bar);
  try { ErrorLog.push('checkFilesLoaded', new Error('缺少：' + missing.join(','))); } catch (e) {}
  return false;
}
window.addEventListener('load', () => { try { checkFilesLoaded(); } catch (e) {} });

/* v144 強制更新：手機上舊 Service Worker 會一直餵舊檔，使用者只清「快取」沒用
   （Service Worker 與 Cache Storage 屬「網站資料」）。此按鈕直接註銷＋清快取＋重載。 */
async function forceUpdateApp() {
  try {
    if ('serviceWorker' in navigator) {
      const rs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(rs.map(r => r.unregister()));
    }
    if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); }
  } catch (e) {}
  location.replace(location.pathname + '?fresh=' + Date.now());   // 換網址繞開任何殘留快取
}

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js?v=' + APP_VERSION, { updateViaCache: 'none' })
    .then(r => { r.update(); }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;   // 首次安裝不重載，避免一進站就閃一下
    reloaded = true; location.reload();
  });
}

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

  /* v126：移除方向宣稱——樣本外實測揭穿了這張卡
     ・大漲分數≥40：315次、命中53.7% vs 基準58.0% → α = -4.4（負值＝反指標）
     ・大跌分數≥40：8檔全部從未觸發 → 對做空者是死功能
     原本卻輸出「🟢強烈偏漲訊號／🔴強烈偏跌訊號」，是全系統最不誠實的一處。
     改為純描述「指標一致度」：只陳述有幾項指標同向，不宣稱方向會如何。
     指標貢獻明細保留（有描述價值：知道當下哪些指標處於什麼狀態）。 */
  const v=$('q-verdict');
  const diff=upFinal-downFinal;
  const agree=Math.max(score.upMax||0,score.downMax||0);
  v.textContent=`📊 指標一致度：${agree} 項同向（偏多${score.upMax||0}／偏空${score.downMax||0}）——僅為當下指標狀態描述，非方向預測`;
  v.style.background='var(--bg2)'; v.style.color='var(--muted)';
  const note=$('q-evidence');
  if(note){
    note.innerHTML=`⚠️ <b>實證結果</b>：本卡分數經樣本外檢驗（8檔×後40%資料）——「大漲分數≥40」共315次，命中53.7% 對比該股基準58.0%，<b>α = -4.4（負值，即略帶反指標性質）</b>；「大跌分數≥40」則從未觸發。<br>故此處<b>不再輸出方向結論</b>，僅保留指標狀態描述。方向判斷請改用出手紀律門、風報比、突破統計等有實證支撐的維度。`;
  }

  // 權重明細
  if(score.contrib.length===0){
    $('q-contrib').innerHTML=`<div style="font-size:12px;color:var(--muted);line-height:1.7">目前 14 項指標中，當下沒有發出買進/賣出訊號的（多為中性 hold）。<br>資料筆數：${score.dataLen} 根　訊號分布：買 ${score.buyCount}／賣 ${score.sellCount}／中性 ${score.holdCount}<br>${score.dataLen<70?'⚠️ 資料偏少，回測樣本不足，請重新部署 Code.gs（已改抓1年資料）':'此為正常現象——多數時間指標處於中性，等待明確訊號出現時這裡才會列出。'}</div>`;
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
// 自創公式渲染
// ══════════════════════════════════════════════════════════════════════
function renderFormulas(f){
  if(!f){ document.getElementById('formula-card').style.display='none'; return; }
  document.getElementById('formula-card').style.display='block';

  // 融合總分
  const fv=f.fusion.value;
  document.getElementById('fusion-val').textContent=(fv>0?'+':'')+fv;
  const fbox=document.getElementById('fusion-box');
  const flabel=document.getElementById('fusion-label');
  flabel.textContent=f.fusion.label;
  if(f.fusion.signal==='buy'){fbox.style.borderColor='var(--buy)';fbox.style.background='var(--buy-d)';document.getElementById('fusion-val').style.color='var(--buy)';flabel.style.color='var(--buy)';}
  else if(f.fusion.signal==='sell'){fbox.style.borderColor='var(--sell)';fbox.style.background='var(--sell-d)';document.getElementById('fusion-val').style.color='var(--sell)';flabel.style.color='var(--sell)';}
  else{fbox.style.borderColor='var(--warn)';fbox.style.background='var(--warn-d)';document.getElementById('fusion-val').style.color='var(--warn)';flabel.style.color='var(--warn)';}

  // 崩跌預警
  const cb=document.getElementById('crash-box');
  if(f.crash.level==='low'){
    cb.style.display='none';
  }else{
    cb.style.display='block';
    const isHigh=f.crash.level==='high';
    cb.style.border='2px solid '+(isHigh?'var(--sell)':'var(--warn)');
    cb.style.background=isHigh?'var(--sell-d)':'var(--warn-d)';
    cb.innerHTML=`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <span style="font-size:26px">${isHigh?'🚨':'⚠️'}</span>
        <div><div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">崩跌預警分數</div>
        <div style="font-family:var(--mono);font-size:24px;font-weight:800;color:${isHigh?'var(--sell)':'var(--warn)'}">${f.crash.score} / 100　${isHigh?'高風險':'中度風險'}</div></div></div>
      <div style="font-size:11px;color:var(--muted);line-height:1.6">觸發因子：${f.crash.reasons.join('、')}</div>`;
  }

  // 三公式卡
  const sig2cls=s=>s==='buy'?'buy':s==='sell'?'sell':'hold';
  const sig2txt=s=>s==='buy'?'▲ 偏漲':s==='sell'?'▼ 偏跌':'◆ 中性';
  const fmtCard=(tag,name,val,unit,obj)=>{
    const cls=sig2cls(obj.signal);
    const col=cls==='buy'?'var(--buy)':cls==='sell'?'var(--sell)':'var(--warn)';
    return `<div class="ic ${cls}"><div class="ic-top"><span class="ic-name">${tag} ${name}</span><span class="ic-badge ${cls==='buy'?'bb':cls==='sell'?'bs':'bh'}">${sig2txt(obj.signal)}</span></div>
      <div class="ic-val" style="color:${col}">${val}${unit}</div>
      <div class="ic-desc">${obj.detail}</div>
      <div style="font-family:var(--mono);font-size:9px;color:var(--muted2);margin-top:6px;word-break:break-all">${obj.formula}</div></div>`;
  };
  document.getElementById('formula-list').innerHTML=
    fmtCard('STI','訊號張力',f.sti.value.toFixed(1),'',f.sti)+
    fmtCard('MFD','動量流變導數',f.mfd.value.toFixed(2),'',f.mfd)+
    fmtCard('ECO','熵能轉折',f.eco.value.toFixed(0),'%',f.eco)+
    (f.psy?fmtCard('PSY','心理偏離',f.psy.value.toFixed(0),'',f.psy):'');
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
// 啟動初始化：載入 GAS 網址 + 個人設定
// ══════════════════════════════════════════════════════════════════════
async function init(){
  try{
    // 從 IndexedDB 載入使用者填的查詢網址與備份網址
    const url=await dbGetSetting('gasUrl');
    if(url) GAS_URL=url;
    const surl=await dbGetSetting('syncUrl');
    if(surl) SYNC_URL=surl;
    const ftk=await dbGetSetting('finmindToken');
    if(ftk) FINMIND_TOKEN=ftk;
  }catch(e){ console.warn('載入網址失敗',e); }
  await loadSettings();
  try { if (typeof refreshRiskBudget === 'function') await refreshRiskBudget(); } catch (e) {}   // v107：載入時算好本月風險預算（2%/6%原則）
}
init();
