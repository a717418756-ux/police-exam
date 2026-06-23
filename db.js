// ══════════════════════════════════════════════════════════════════════
// db.js — 本地 IndexedDB 儲存 + GAS 雲端雙向同步
// 版本：改 schema 時把 DB_VERSION 往上加
// ══════════════════════════════════════════════════════════════════════
const DB_NAME='stockRadarDB';
const DB_VERSION=1;
let _db=null;

// store: settings(資金/風險/勝率)、trades(交易紀錄)
function openDB(){
  return new Promise((resolve,reject)=>{
    if(_db)return resolve(_db);
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings',{keyPath:'key'});
      if(!db.objectStoreNames.contains('trades'))   db.createObjectStore('trades',{keyPath:'id'});
    };
    req.onsuccess=e=>{_db=e.target.result;resolve(_db);};
    req.onerror=e=>reject(e.target.error);
  });
}

// ── settings ──────────────────────────────────────────────────────────
async function dbSetSetting(key,value){
  const db=await openDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction('settings','readwrite');
    tx.objectStore('settings').put({key,value});
    tx.oncomplete=()=>res(true);tx.onerror=()=>rej(tx.error);
  });
}
async function dbGetSetting(key){
  const db=await openDB();
  return new Promise((res,rej)=>{
    const r=db.transaction('settings','readonly').objectStore('settings').get(key);
    r.onsuccess=()=>res(r.result?r.result.value:null);r.onerror=()=>rej(r.error);
  });
}

// ── trades ────────────────────────────────────────────────────────────
// trade: {id,date,code,direction('long'/'short'),result('win'/'loss'),pnl(數字),note}
async function dbAddTrade(trade){
  const db=await openDB();
  if(!trade.id) trade.id='t_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
  return new Promise((res,rej)=>{
    const tx=db.transaction('trades','readwrite');
    tx.objectStore('trades').put(trade);
    tx.oncomplete=()=>res(trade);tx.onerror=()=>rej(tx.error);
  });
}
async function dbDeleteTrade(id){
  const db=await openDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction('trades','readwrite');
    tx.objectStore('trades').delete(id);
    tx.oncomplete=()=>res(true);tx.onerror=()=>rej(tx.error);
  });
}
async function dbGetAllTrades(){
  const db=await openDB();
  return new Promise((res,rej)=>{
    const r=db.transaction('trades','readonly').objectStore('trades').getAll();
    r.onsuccess=()=>res((r.result||[]).sort((a,b)=>(a.date<b.date?1:-1)));r.onerror=()=>rej(r.error);
  });
}

// ── 由交易紀錄計算真實統計 ────────────────────────────────────────────
function computeStats(trades){
  if(!trades.length) return{count:0,wins:0,losses:0,winRate:0,avgWin:0,avgLoss:0,payoff:0,expectancy:0,totalPnl:0};
  const wins=trades.filter(t=>t.result==='win');
  const losses=trades.filter(t=>t.result==='loss');
  const sumWin=wins.reduce((a,t)=>a+Math.abs(t.pnl||0),0);
  const sumLoss=losses.reduce((a,t)=>a+Math.abs(t.pnl||0),0);
  const avgWin=wins.length?sumWin/wins.length:0;
  const avgLoss=losses.length?sumLoss/losses.length:0;
  const winRate=trades.length?wins.length/trades.length:0;
  const payoff=avgLoss>0?avgWin/avgLoss:0;        // 盈虧比
  // 期望值 = 勝率×平均獲利 − 敗率×平均虧損
  const expectancy=winRate*avgWin-(1-winRate)*avgLoss;
  return{
    count:trades.length,wins:wins.length,losses:losses.length,
    winRate,avgWin,avgLoss,payoff,expectancy,
    totalPnl:trades.reduce((a,t)=>a+(t.pnl||0),0)
  };
}

// ══════════════════════════════════════════════════════════════════════
// GAS 雲端雙向同步
// 後端需有 action=sync_get / action=sync_save（已加入 Code.gs）
// ══════════════════════════════════════════════════════════════════════
async function cloudSave(){
  if(typeof GAS_URL==='undefined'||GAS_URL.indexOf('http')!==0) throw new Error('未設定 GAS 網址');
  const trades=await dbGetAllTrades();
  const settings={
    capital:await dbGetSetting('capital'),
    risk:await dbGetSetting('risk'),
    winrate:await dbGetSetting('winrate')
  };
  const payload={trades,settings,updated:Date.now()};
  // 用 text/plain 避免 CORS preflight（與你 GAS 慣例一致）
  const r=await fetch(`${GAS_URL}?action=sync_save`,{
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body:JSON.stringify(payload)
  });
  const j=await r.json();
  if(!j.ok) throw new Error(j.error||'雲端儲存失敗');
  return j;
}

async function cloudLoad(){
  if(typeof GAS_URL==='undefined'||GAS_URL.indexOf('http')!==0) throw new Error('未設定 GAS 網址');
  const r=await fetch(`${GAS_URL}?action=sync_get`);
  const j=await r.json();
  if(!j.ok) throw new Error(j.error||'雲端讀取失敗');
  const data=j.data||{};
  // 寫回本地
  if(data.settings){
    if(data.settings.capital!=null) await dbSetSetting('capital',data.settings.capital);
    if(data.settings.risk!=null)    await dbSetSetting('risk',data.settings.risk);
    if(data.settings.winrate!=null) await dbSetSetting('winrate',data.settings.winrate);
  }
  if(Array.isArray(data.trades)){
    for(const t of data.trades) await dbAddTrade(t);
  }
  return data;
}
