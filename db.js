/* ══════════════════════════════════════════════════════════════════════
   db.js — 本地 IndexedDB 儲存 + GAS 雲端雙向同步
   依賴：config.js（APP_VERSION）
   schema 改變時，DB_VERSION 會跟著 APP_VERSION 自動升（無需手改）
   ══════════════════════════════════════════════════════════════════════ */

const DB_NAME = 'stockRadarDB';
// DB schema 版本獨立管理（schema 沒變就不用動；這裡固定 1）
const DB_SCHEMA_VERSION = 1;
let _db = null;

/* ── 開啟資料庫 ──────────────────────────────────────────────────────── */
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_SCHEMA_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('trades'))   db.createObjectStore('trades',   { keyPath: 'id' });
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

/* ── settings（鍵值對：capital/risk/winrate/gasUrl/errorLog）─────────── */
async function dbSetSetting(key, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}
async function dbGetSetting(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('settings', 'readonly').objectStore('settings').get(key);
    r.onsuccess = () => res(r.result ? r.result.value : null);
    r.onerror = () => rej(r.error);
  });
}

/* ── trades（交易紀錄）────────────────────────────────────────────────
   trade = {id,date,code,direction:'long'|'short',result:'win'|'loss',pnl:number,note}
   ──────────────────────────────────────────────────────────────────── */
async function dbAddTrade(trade) {
  const db = await openDB();
  if (!trade.id) trade.id = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  return new Promise((res, rej) => {
    const tx = db.transaction('trades', 'readwrite');
    tx.objectStore('trades').put(trade);
    tx.oncomplete = () => res(trade);
    tx.onerror = () => rej(tx.error);
  });
}
async function dbDeleteTrade(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('trades', 'readwrite');
    tx.objectStore('trades').delete(id);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}
async function dbGetAllTrades() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('trades', 'readonly').objectStore('trades').getAll();
    r.onsuccess = () => res((r.result || []).sort((a, b) => (a.date < b.date ? 1 : -1)));
    r.onerror = () => rej(r.error);
  });
}
async function dbClearTrades() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('trades', 'readwrite');
    tx.objectStore('trades').clear();
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

/* ── 由交易紀錄計算真實統計 ──────────────────────────────────────────── */
function computeStats(trades) {
  if (!trades.length) return { count:0,wins:0,losses:0,winRate:0,avgWin:0,avgLoss:0,payoff:0,expectancy:0,totalPnl:0 };
  const wins   = trades.filter(t => t.result === 'win');
  const losses = trades.filter(t => t.result === 'loss');
  const sumWin  = wins.reduce((a, t) => a + Math.abs(t.pnl || 0), 0);
  const sumLoss = losses.reduce((a, t) => a + Math.abs(t.pnl || 0), 0);
  const avgWin  = wins.length ? sumWin / wins.length : 0;
  const avgLoss = losses.length ? sumLoss / losses.length : 0;
  const winRate = trades.length ? wins.length / trades.length : 0;
  const payoff  = avgLoss > 0 ? avgWin / avgLoss : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
  return { count: trades.length, wins: wins.length, losses: losses.length, winRate, avgWin, avgLoss, payoff, expectancy, totalPnl: trades.reduce((a, t) => a + (t.pnl || 0), 0) };
}

/* ══════════════════════════════════════════════════════════════════════
   本地匯出 / 匯入（避免刪網頁後紀錄無法復原）
   ══════════════════════════════════════════════════════════════════════ */
async function exportBackup() {
  const trades = await dbGetAllTrades();
  const settings = {
    capital:  await dbGetSetting('capital'),
    risk:     await dbGetSetting('risk'),
    winrate:  await dbGetSetting('winrate')
  };
  return {
    app: 'StockRadarPro',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    trades,
    settings
  };
}

async function importBackup(obj) {
  if (!obj || obj.app !== 'StockRadarPro') throw new Error('檔案格式不符，非本程式備份檔');
  if (obj.settings) {
    if (obj.settings.capital != null) await dbSetSetting('capital', obj.settings.capital);
    if (obj.settings.risk    != null) await dbSetSetting('risk',    obj.settings.risk);
    if (obj.settings.winrate != null) await dbSetSetting('winrate', obj.settings.winrate);
  }
  if (Array.isArray(obj.trades)) {
    for (const t of obj.trades) await dbAddTrade(t);
  }
  return obj.trades ? obj.trades.length : 0;
}

/* ══════════════════════════════════════════════════════════════════════
   GAS 雲端雙向同步（URL 由設定頁填入，存於 IndexedDB）
   後端端點：?action=sync_get（GET）/ ?action=sync_save（POST）
   ══════════════════════════════════════════════════════════════════════ */
async function cloudSave() {
  if (!GAS_URL || GAS_URL.indexOf('http') !== 0) throw new Error('尚未在設定頁填入 GAS 網址');
  const backup = await exportBackup();   // 完整備份內容（含 trades + settings + 版本 + 時間）
  const r = await fetch(`${GAS_URL}?action=sync_save`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 避免 CORS preflight
    body: JSON.stringify(backup)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '雲端儲存失敗');
  return j;
}

async function cloudLoad() {
  if (!GAS_URL || GAS_URL.indexOf('http') !== 0) throw new Error('尚未在設定頁填入 GAS 網址');
  const r = await fetch(`${GAS_URL}?action=sync_get`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '雲端讀取失敗');
  const data = j.data || {};
  if (data && data.app === 'StockRadarPro') {
    await importBackup(data);
  } else if (data.trades || data.settings) {
    // 相容舊格式
    await importBackup({ app: 'StockRadarPro', trades: data.trades || [], settings: data.settings || {} });
  }
  return data;
}
