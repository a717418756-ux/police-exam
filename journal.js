/* ══════════════════════════════════════════════════════════════════════
   journal.js — 交易日誌 + 設定/備份（兩個獨立分頁）
   依賴：config.js、db.js、app.js($/fmt/fmtV/loadSettings/saveSettings)
   ══════════════════════════════════════════════════════════════════════ */

/* ── 開啟 / 關閉面板 ─────────────────────────────────────────────────── */
function openJournal() {
  $('journal-overlay').style.display = 'block';
  switchModalTab('journal');
  if (!$('tr-date').value) $('tr-date').value = new Date().toISOString().slice(0, 10);
  refreshJournal();
}
function closeJournal() { $('journal-overlay').style.display = 'none'; }

/* ── 分頁切換：交易日誌 / 設定備份 ───────────────────────────────────── */
function switchModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.modal-pane').forEach(el => el.classList.toggle('active', el.dataset.pane === tab));
  if (tab === 'settings') { loadGasUrlField(); refreshErrorLog(); }
}

/* ══════════════════════════════════════════════════════════════════════
   分頁一：交易日誌
   ══════════════════════════════════════════════════════════════════════ */
async function addTradeFromForm() {
  const date = $('tr-date').value;
  const code = $('tr-code').value.trim().toUpperCase();
  const dir  = $('tr-dir').value;
  const pnl  = parseFloat($('tr-pnl').value);
  if (!date || isNaN(pnl)) { alert('請填日期與盈虧金額'); return; }
  const result = pnl >= 0 ? 'win' : 'loss';
  await dbAddTrade({ date, code, direction: dir, result, pnl });
  $('tr-pnl').value = ''; $('tr-code').value = '';
  await refreshJournal();
  await syncWinRateToMain();
}

async function refreshJournal() {
  const trades = await dbGetAllTrades();
  const s = computeStats(trades);
  const box = (label, val, col) =>
    `<div style="background:var(--bg);border:1px solid var(--bd);border-radius:10px;padding:10px;text-align:center"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:4px">${label}</div><div style="font-family:var(--mono);font-size:18px;font-weight:700;color:${col || 'var(--txt)'}">${val}</div></div>`;
  $('journal-stats').innerHTML =
    box('交易筆數', s.count) +
    box('勝率', (s.winRate * 100).toFixed(0) + '%', 'var(--buy)') +
    box('盈虧比', s.payoff.toFixed(2), 'var(--acc)') +
    box('總盈虧', (s.totalPnl >= 0 ? '+' : '') + fmtV(Math.round(s.totalPnl)), s.totalPnl >= 0 ? 'var(--buy)' : 'var(--sell)') +
    box('平均獲利', fmtV(Math.round(s.avgWin)), 'var(--buy)') +
    box('期望值/筆', (s.expectancy >= 0 ? '+' : '') + fmtV(Math.round(s.expectancy)), s.expectancy >= 0 ? 'var(--buy)' : 'var(--sell)');

  if (trades.length === 0) {
    $('journal-list').innerHTML = '<div style="font-size:12px;color:var(--muted);text-align:center;padding:16px">尚無交易紀錄，新增後自動計算真實勝率</div>';
    return;
  }
  $('journal-list').innerHTML = trades.map(t => {
    const win = t.result === 'win';
    return `<div style="display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:8px 12px;margin-bottom:6px">
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted);width:78px">${t.date}</span>
      <span style="font-family:var(--mono);font-size:12px;width:48px">${t.code || '—'}</span>
      <span style="font-size:10px;color:var(--muted);width:32px">${t.direction === 'long' ? '多' : '空'}</span>
      <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:${win ? 'var(--buy)' : 'var(--sell)'};flex:1;text-align:right">${t.pnl >= 0 ? '+' : ''}${fmtV(t.pnl)}</span>
      <button onclick="delTrade('${t.id}')" style="background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:14px">🗑️</button>
    </div>`;
  }).join('');
}

async function delTrade(id) {
  await dbDeleteTrade(id);
  await refreshJournal();
  await syncWinRateToMain();
}

// 真實勝率（≥5筆）自動帶回主頁凱利欄
async function syncWinRateToMain() {
  const trades = await dbGetAllTrades();
  const s = computeStats(trades);
  if (s.count >= 5) {
    const wr = Math.round(s.winRate * 100);
    $('in-winrate').value = wr;
    await dbSetSetting('winrate', wr);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   分頁二：設定 / 備份
   ══════════════════════════════════════════════════════════════════════ */

// ── GAS 網址：網頁填寫，存 IndexedDB ──────────────────────────────────
async function loadGasUrlField() {
  const url = await dbGetSetting('gasUrl');
  if (url) $('set-gas-url').value = url;
}
async function saveGasUrl() {
  const url = $('set-gas-url').value.trim();
  const msg = $('settings-msg');
  if (url && url.indexOf('http') !== 0) { msg.textContent = '❌ 網址需以 https:// 開頭'; msg.style.color = 'var(--sell)'; return; }
  await dbSetSetting('gasUrl', url);
  GAS_URL = url;                       // 立即生效
  msg.textContent = '✅ GAS 網址已儲存，立即生效';
  msg.style.color = 'var(--buy)';
}

// ── 測試 GAS 連線 ─────────────────────────────────────────────────────
async function testGasConnection() {
  const msg = $('settings-msg');
  if (!GAS_URL || GAS_URL.indexOf('http') !== 0) { msg.textContent = '❌ 請先填入並儲存 GAS 網址'; msg.style.color = 'var(--sell)'; return; }
  msg.textContent = '測試連線中...'; msg.style.color = 'var(--muted)';
  try {
    const r = await fetch(`${GAS_URL}?code=2330`);
    const j = await r.json();
    if (j.ok) { msg.textContent = `✅ 連線成功！抓到 ${j.name || '2330'}，現價 ${j.price}`; msg.style.color = 'var(--buy)'; }
    else { msg.textContent = `⚠️ 連線成功但回傳：${j.error}`; msg.style.color = 'var(--warn)'; }
  } catch (e) {
    msg.textContent = `❌ 連線失敗：${e.message}（請確認 GAS 部署權限設為「所有人」）`;
    msg.style.color = 'var(--sell)';
    await ErrorLog.push('testGasConnection', e);
  }
}

// ── 本地匯出（下載 JSON 檔）───────────────────────────────────────────
async function exportLocalFile() {
  const msg = $('settings-msg');
  try {
    const backup = await exportBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `StockRadar備份_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    msg.textContent = '✅ 已匯出備份檔到下載資料夾'; msg.style.color = 'var(--buy)';
  } catch (e) {
    msg.textContent = '❌ 匯出失敗：' + e.message; msg.style.color = 'var(--sell)';
    await ErrorLog.push('exportLocalFile', e);
  }
}

// ── 本地匯入（讀 JSON 檔）─────────────────────────────────────────────
function triggerImport() { $('import-file').click(); }
async function importLocalFile(input) {
  const msg = $('settings-msg');
  const file = input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    const n = await importBackup(obj);
    msg.textContent = `✅ 已匯入 ${n} 筆交易紀錄`; msg.style.color = 'var(--buy)';
    await loadSettings(); await refreshJournal(); await syncWinRateToMain();
  } catch (e) {
    msg.textContent = '❌ 匯入失敗：' + e.message; msg.style.color = 'var(--sell)';
    await ErrorLog.push('importLocalFile', e);
  }
  input.value = '';
}

// ── 雲端備份 ──────────────────────────────────────────────────────────
async function doCloudSave() {
  const msg = $('settings-msg'); msg.textContent = '雲端儲存中...'; msg.style.color = 'var(--muted)';
  try { await saveSettings(); await cloudSave(); msg.textContent = '✅ 已存到雲端'; msg.style.color = 'var(--buy)'; }
  catch (e) { msg.textContent = '❌ ' + e.message; msg.style.color = 'var(--sell)'; await ErrorLog.push('cloudSave', e); }
}
async function doCloudLoad() {
  const msg = $('settings-msg'); msg.textContent = '雲端載入中...'; msg.style.color = 'var(--muted)';
  try { await cloudLoad(); await loadSettings(); await refreshJournal(); await syncWinRateToMain(); msg.textContent = '✅ 已從雲端載入'; msg.style.color = 'var(--buy)'; }
  catch (e) { msg.textContent = '❌ ' + e.message; msg.style.color = 'var(--sell)'; await ErrorLog.push('cloudLoad', e); }
}

// ── 錯誤記錄顯示（手機看不到 F12 用）─────────────────────────────────
async function refreshErrorLog() {
  const list = await ErrorLog.getAll();
  const box = $('error-log-list');
  if (!list.length) { box.innerHTML = '<div style="font-size:11px;color:var(--muted);text-align:center;padding:10px">目前沒有錯誤紀錄 👍</div>'; return; }
  box.innerHTML = list.map(e =>
    `<div class="err-log-item"><div class="err-log-time">${e.time}</div><div class="err-log-where">📍 ${e.where}</div><div class="err-log-msg">${e.msg}</div></div>`
  ).join('');
}
async function clearErrorLog() {
  await ErrorLog.clear();
  await refreshErrorLog();
}
