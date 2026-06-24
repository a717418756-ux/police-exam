/* ══════════════════════════════════════════════════════════════════════
   journal.js — 交易日誌 + 設定/備份（兩個獨立分頁）
   依賴：config.js、db.js、app.js($/fmt/fmtV/loadSettings/saveSettings)
   ══════════════════════════════════════════════════════════════════════ */

/* ── 開啟 / 關閉面板 ─────────────────────────────────────────────────── */
function openJournal() {
  $('journal-overlay').style.display = 'block';
  switchModalTab('journal');
  const today = new Date().toISOString().slice(0, 10);
  if (!$('tr-entry').value) $('tr-entry').value = today;
  if (!$('tr-exit').value)  $('tr-exit').value = today;
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
  const entryDate = $('tr-entry').value;
  const exitDate  = $('tr-exit').value;
  const code = $('tr-code').value.trim().toUpperCase();
  const dir  = $('tr-dir').value;
  const pnl  = parseFloat($('tr-pnl').value);
  if (!entryDate || !exitDate || isNaN(pnl)) { alert('請填進場日、出場日與盈虧金額'); return; }
  const holdDays = Math.max(0, Math.round((new Date(exitDate) - new Date(entryDate)) / 86400000));
  const result = pnl >= 0 ? 'win' : 'loss';

  // ── 判斷品質欄位 ──
  const mae = parseFloat($('tr-mae').value);            // 最大不利幅度 %
  const plannedStop = parseFloat($('tr-plannedstop').value); // 原訂停損 %
  const holdOn = $('tr-holdon').value;                  // yes/no 凹單
  const exitReason = $('tr-exitreason').value;          // 出場原因

  // ── 自動判定「判斷對錯」──
  // 規則：凹單(holdOn=yes) 或 MAE超過原停損 → 判斷錯誤（即使帳面沒賠）
  let judgment = 'correct';  // correct=判斷正確, wrong=判斷錯誤
  const reasons = [];
  if (holdOn === 'yes') { judgment = 'wrong'; reasons.push('凹單'); }
  if (!isNaN(mae) && !isNaN(plannedStop) && mae > plannedStop) {
    judgment = 'wrong'; reasons.push(`MAE(${mae}%)超過原停損(${plannedStop}%)`);
  }
  if (exitReason === 'holdback') { judgment = 'wrong'; if (!reasons.includes('凹單')) reasons.push('凹單回本'); }

  await dbAddTrade({
    date: exitDate, entryDate, exitDate, holdDays, code, direction: dir, result, pnl,
    mae: isNaN(mae) ? null : mae,
    plannedStop: isNaN(plannedStop) ? null : plannedStop,
    holdOn, exitReason,
    judgment, judgmentReason: reasons.join('、')
  });
  $('tr-pnl').value = ''; $('tr-code').value = '';
  $('tr-mae').value = ''; $('tr-plannedstop').value = '';
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
    box('帳面勝率', (s.winRate * 100).toFixed(0) + '%', 'var(--warn)') +
    box('真實勝率', (s.trueWinRate * 100).toFixed(0) + '%', 'var(--buy)') +
    box('判斷錯誤', s.misjudged + ' 筆', s.misjudged > 0 ? 'var(--sell)' : 'var(--muted)') +
    box('盈虧比', s.payoff.toFixed(2), 'var(--acc)') +
    box('總盈虧', (s.totalPnl >= 0 ? '+' : '') + fmtV(Math.round(s.totalPnl)), s.totalPnl >= 0 ? 'var(--buy)' : 'var(--sell)');

  if (trades.length === 0) {
    $('journal-list').innerHTML = '<div style="font-size:12px;color:var(--muted);text-align:center;padding:16px">尚無交易紀錄，新增後自動計算真實勝率</div>';
    return;
  }
  $('journal-list').innerHTML = trades.map(t => {
    const win = t.result === 'win';
    const hold = t.holdDays != null ? `抱${t.holdDays}天` : '';
    // 判斷錯誤標記（凹單僥倖的假贏單）
    const wrongTag = t.judgment === 'wrong'
      ? `<span style="font-size:9px;background:var(--sell-d);color:var(--sell);padding:1px 5px;border-radius:4px;margin-left:4px" title="${t.judgmentReason||''}">判斷錯</span>` : '';
    return `<div style="display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid ${t.judgment==='wrong'?'var(--sell)':'var(--bd)'};border-radius:8px;padding:8px 12px;margin-bottom:6px">
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted);width:74px">${t.exitDate || t.date}</span>
      <span style="font-family:var(--mono);font-size:12px;width:44px">${t.code || '—'}</span>
      <span style="font-size:10px;color:var(--muted);width:20px">${t.direction === 'long' ? '多' : '空'}</span>
      <span style="font-size:9px;color:var(--muted2);width:38px">${hold}</span>
      <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:${win ? 'var(--buy)' : 'var(--sell)'};flex:1;text-align:right">${t.pnl >= 0 ? '+' : ''}${fmtV(t.pnl)}${wrongTag}</span>
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

// ── 匯出分析用 Markdown（給 AI 回測優化）─────────────────────────────
async function exportMarkdown() {
  const msg = $('settings-msg');
  try {
    const trades = await dbGetAllTrades();
    if (!trades.length) { msg.textContent = '⚠️ 尚無交易紀錄可匯出'; msg.style.color = 'var(--warn)'; return; }
    const s = computeAdvancedStats(trades);
    const cur = n => (n>=0?'+':'') + Math.round(n).toLocaleString();

    let md = `# 短線雷達 交易回測分析資料\n\n`;
    md += `匯出時間：${new Date().toLocaleString('zh-TW')}　|　程式版本：v${APP_VERSION}\n\n`;

    // 一、整體統計
    md += `## 一、整體績效\n\n`;
    md += `| 指標 | 數值 |\n|------|------|\n`;
    md += `| 總交易筆數 | ${s.count} |\n`;
    md += `| **帳面勝率**（含凹單僥倖） | ${(s.winRate*100).toFixed(1)}% |\n`;
    md += `| **真實勝率**（扣除判斷錯誤） | ${(s.trueWinRate*100).toFixed(1)}% |\n`;
    md += `| 判斷錯誤筆數（凹單/MAE超停損） | ${s.misjudged} |\n`;
    md += `| 盈虧比（平均賺/平均賠） | ${s.payoff.toFixed(2)} |\n`;
    md += `| 期望值/筆 | ${cur(s.expectancy)} |\n`;
    md += `| 總盈虧 | ${cur(s.totalPnl)} |\n`;
    md += `| 平均獲利 | ${cur(s.avgWin)} |\n`;
    md += `| 平均虧損 | ${cur(s.avgLoss)} |\n`;
    md += `| 最大連勝 | ${s.maxWinStreak} 筆 |\n`;
    md += `| 最大連敗 | ${s.maxLossStreak} 筆 |\n`;
    md += `| 平均抱倉天數 | ${s.avgHoldDays.toFixed(1)} 天 |\n`;
    md += `| 最大回撤 | ${cur(s.maxDrawdown)} |\n\n`;

    // 重要提示給 AI
    if (s.misjudged > 0) {
      const gap = ((s.winRate - s.trueWinRate) * 100).toFixed(1);
      md += `> ⚠️ **回測校正重點**：帳面勝率與真實勝率相差 ${gap} 個百分點，代表有 ${s.misjudged} 筆是「判斷錯誤但凹單/僥倖沒賠」的假贏單。\n`;
      md += `> 分析訊號有效性時，請以「判斷正確」欄位為準，**不要把這些假贏單當成有效訊號**，否則會把錯誤訊號學成有效訊號（結果論偏誤）。\n\n`;
    }

    // 二、依方向
    md += `## 二、做多 vs 做空\n\n`;
    md += `| 方向 | 筆數 | 勝率 | 盈虧比 | 期望值 |\n|------|------|------|--------|--------|\n`;
    for (const dir of ['long','short']) {
      const d = s.byDirection[dir];
      if (d) md += `| ${dir==='long'?'做多':'做空'} | ${d.count} | ${(d.winRate*100).toFixed(1)}% | ${d.payoff.toFixed(2)} | ${cur(d.expectancy)} |\n`;
    }
    md += `\n`;

    // 三、依股票代碼
    md += `## 三、各股票表現\n\n`;
    md += `| 代碼 | 筆數 | 勝率 | 總盈虧 |\n|------|------|------|--------|\n`;
    for (const code in s.byCode) {
      const d = s.byCode[code];
      md += `| ${code} | ${d.count} | ${(d.winRate*100).toFixed(1)}% | ${cur(d.totalPnl)} |\n`;
    }
    md += `\n`;

    // 四、完整交易明細
    md += `## 四、完整交易明細\n\n`;
    md += `| 進場日 | 出場日 | 抱倉天 | 代碼 | 方向 | 帳面結果 | 判斷對錯 | MAE% | 原停損% | 出場原因 | 盈虧 |\n`;
    md += `|--------|--------|--------|------|------|----------|----------|------|---------|----------|------|\n`;
    const sorted = [...trades].sort((a,b)=>(a.exitDate||a.date)<(b.exitDate||b.date)?1:-1);
    const reasonMap = { tp:'停利達標', sl:'觸及停損', holdback:'凹單回本', early:'提早跑', panic:'恐慌殺出' };
    for (const t of sorted) {
      const judge = t.judgment === 'wrong' ? `❌錯誤(${t.judgmentReason||''})` : '✅正確';
      md += `| ${t.entryDate||'—'} | ${t.exitDate||t.date} | ${t.holdDays!=null?t.holdDays:'—'} | ${t.code||'—'} | ${t.direction==='long'?'多':'空'} | ${t.result==='win'?'賺':'賠'} | ${judge} | ${t.mae!=null?t.mae:'—'} | ${t.plannedStop!=null?t.plannedStop:'—'} | ${reasonMap[t.exitReason]||'—'} | ${cur(t.pnl)} |\n`;
    }
    md += `\n`;

    // 五、目前使用的自創公式（供 AI 參考調整方向）
    md += `## 五、目前系統使用的自創公式\n\n`;
    md += `### STI 訊號張力指數（統計學）\n`;
    md += `\`STI = Σ[wᵢ·tanh(zᵢ)] / Σwᵢ × 100\`，zᵢ 為 Z 分數標準化。子訊號權重：報酬動能 1.2、乖離 1.0、量能 0.8、波幅 0.6。\n\n`;
    md += `### MFD 動量流變導數（微積分）\n`;
    md += `\`MFD = α·(dP/dt) + β·(d²P/dt²)\`，α=1.0、β=3.0。衰竭門檻：加速度 < -0.15%。\n\n`;
    md += `### ECO 熵能轉折指標（資訊論）\n`;
    md += `\`ECO = (1 − H/Hmax)×100\`，H 為夏農熵，5 桶分布。成形門檻：ECO > 40。\n\n`;
    md += `### 崩跌預警權重\n`;
    md += `動能衰竭 +30、熵偏空 +25、量價背離 +20、STI轉空 +15、連漲過熱 +10。高風險門檻 60。\n\n`;
    md += `### 回測加權參數\n`;
    md += `預測天數 ${5} 天、大漲跌門檻 ±3%、最小樣本 3 筆。\n\n`;

    // 下載
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `短線雷達分析_${new Date().toISOString().slice(0,10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    msg.textContent = '✅ 已匯出 Markdown 分析檔，可丟給 AI 回測優化'; msg.style.color = 'var(--buy)';
  } catch (e) {
    msg.textContent = '❌ 匯出失敗：' + e.message; msg.style.color = 'var(--sell)';
    await ErrorLog.push('exportMarkdown', e);
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
