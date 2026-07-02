/* ══════════════════════════════════════════════════════════════════════
   journal.js — 交易日誌 + 設定/備份（兩個獨立分頁）
   依賴：config.js、db.js、app.js($/fmt/fmtV/loadSettings/saveSettings)
   ══════════════════════════════════════════════════════════════════════ */

/* ── 開啟 / 關閉面板 ─────────────────────────────────────────────────── */
/* ── 分批進場 / 加碼工具 ──────────────────────────────────────────────
   多批進場，自動算加權平均成本，記錄每批進場日（供抓公式分數）
   ──────────────────────────────────────────────────────────────────── */
let _batchCount = 0;
function addBatchRow() {
  _batchCount++;
  const id = _batchCount;
  const row = document.createElement('div');
  row.className = 'batch-row';
  row.id = 'batch-' + id;
  row.style.cssText = 'display:grid;grid-template-columns:1.1fr 1fr 0.8fr auto;gap:6px;margin-bottom:6px;align-items:center';
  row.innerHTML = `
    <input type="date" class="field-input" id="batch-date-${id}" oninput="calcBatch()" style="font-size:11px;padding:6px">
    <input type="number" step="0.01" placeholder="價格" class="field-input" id="batch-price-${id}" oninput="calcBatch()" style="font-size:11px;padding:6px">
    <input type="number" placeholder="張數" class="field-input" id="batch-qty-${id}" oninput="calcBatch()" style="font-size:11px;padding:6px">
    <button onclick="removeBatchRow(${id})" style="background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:14px">✕</button>`;
  document.getElementById('batch-rows').appendChild(row);
}
function removeBatchRow(id) {
  const r = document.getElementById('batch-' + id);
  if (r) r.remove();
  calcBatch();
}
function getBatchData() {
  const rows = document.querySelectorAll('.batch-row');
  const batches = [];
  rows.forEach(r => {
    const id = r.id.split('-')[1];
    const date = document.getElementById('batch-date-' + id).value;
    const price = parseFloat(document.getElementById('batch-price-' + id).value);
    const qty = parseFloat(document.getElementById('batch-qty-' + id).value);
    if (date && !isNaN(price)) batches.push({ date, price, qty: isNaN(qty) ? 1 : qty });
  });
  return batches;
}
function calcBatch() {
  const batches = getBatchData();
  const res = document.getElementById('batch-result');
  if (batches.length < 1) { res.textContent = ''; return; }
  let totalCost = 0, totalQty = 0;
  batches.forEach(b => { totalCost += b.price * b.qty; totalQty += b.qty; });
  const avgCost = totalCost / totalQty;
  const sorted = [...batches].sort((a,b)=>a.date<b.date?-1:1);
  document.getElementById('tr-entryprice').value = Math.round(avgCost*100)/100;
  document.getElementById('tr-entry').value = sorted[0].date;
  if (totalQty > 0 && batches.every(b=>b.qty)) document.getElementById('tr-shares').value = totalQty;
  res.textContent = `✅ ${batches.length}批 平均成本 ${(Math.round(avgCost*100)/100)}　總${totalQty}張（已填回上方）`;
}

/* ── 分批出場 / 停利工具（對稱於分批進場）──────────────────────────── */
let _exitCount = 0;
function addExitRow() {
  _exitCount++;
  const id = _exitCount;
  const row = document.createElement('div');
  row.className = 'exit-row';
  row.id = 'exit-' + id;
  row.style.cssText = 'display:grid;grid-template-columns:1.1fr 1fr 0.8fr auto;gap:6px;margin-bottom:6px;align-items:center';
  row.innerHTML = `
    <input type="date" class="field-input" id="exit-date-${id}" oninput="calcExit()" style="font-size:11px;padding:6px">
    <input type="number" step="0.01" placeholder="價格" class="field-input" id="exit-price-${id}" oninput="calcExit()" style="font-size:11px;padding:6px">
    <input type="number" placeholder="張數" class="field-input" id="exit-qty-${id}" oninput="calcExit()" style="font-size:11px;padding:6px">
    <button onclick="removeExitRow(${id})" style="background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:14px">✕</button>`;
  document.getElementById('exit-rows').appendChild(row);
}
function removeExitRow(id) {
  const r = document.getElementById('exit-' + id);
  if (r) r.remove();
  calcExit();
}
function getExitData() {
  const rows = document.querySelectorAll('.exit-row');
  const exits = [];
  rows.forEach(r => {
    const id = r.id.split('-')[1];
    const date = document.getElementById('exit-date-' + id).value;
    const price = parseFloat(document.getElementById('exit-price-' + id).value);
    const qty = parseFloat(document.getElementById('exit-qty-' + id).value);
    if (date && !isNaN(price)) exits.push({ date, price, qty: isNaN(qty) ? 1 : qty });
  });
  return exits;
}
function calcExit() {
  const exits = getExitData();
  const res = document.getElementById('exit-result');
  if (exits.length < 1) { res.textContent = ''; return; }
  let totalVal = 0, totalQty = 0;
  exits.forEach(e => { totalVal += e.price * e.qty; totalQty += e.qty; });
  const avgExit = totalVal / totalQty;
  const sorted = [...exits].sort((a,b)=>a.date<b.date?-1:1);
  // 出場價=加權平均、出場日=最後一批（全部出清日）
  document.getElementById('tr-exitprice').value = Math.round(avgExit*100)/100;
  document.getElementById('tr-exit').value = sorted[sorted.length-1].date;
  res.textContent = `✅ ${exits.length}批 平均出場價 ${(Math.round(avgExit*100)/100)}　總${totalQty}張（已填回上方）`;
}

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
  const entryPrice = parseFloat($('tr-entryprice').value);
  const exitPrice  = parseFloat($('tr-exitprice').value);
  const shares = parseFloat($('tr-shares').value);          // 選填
  const plannedStop = parseFloat($('tr-plannedstop').value); // 選填
  const isSim = $('tr-sim').checked;                          // 模擬單
  const msg = $('trade-calc-msg');

  if (!entryDate || !exitDate || !code || isNaN(entryPrice) || isNaN(exitPrice)) {
    msg.textContent = '請填進場日、出場日、代碼、進場價、出場價'; msg.style.color = 'var(--sell)'; return;
  }

  const holdDays = Math.max(0, Math.round((new Date(exitDate) - new Date(entryDate)) / 86400000));
  const isLong = dir === 'long';

  // ── 盈虧% ──（做多：漲賺；做空：跌賺）
  const pnlPct = isLong ? (exitPrice - entryPrice) / entryPrice * 100
                        : (entryPrice - exitPrice) / entryPrice * 100;
  const pnl = !isNaN(shares) ? Math.round((isLong ? exitPrice - entryPrice : entryPrice - exitPrice) * shares) : Math.round(pnlPct * 100);
  const result = pnlPct >= 0 ? 'win' : 'loss';

  // ── 自動抓區間K線算 MAE / MFE ──
  msg.textContent = '正在抓取K線自動計算 MAE/MFE...'; msg.style.color = 'var(--muted)';
  let mae = null, mfe = null, autoNote = '';
  try {
    if (GAS_URL && GAS_URL.indexOf('http') === 0) {
      const r = await fetch(`${GAS_URL}?action=range&code=${encodeURIComponent(code)}&from=${entryDate}&to=${exitDate}`);
      const j = await r.json();
      if (j.ok) {
        // 做多：最大不利＝區間最低 vs 進場價（虧多少）；最大有利＝區間最高
        if (isLong) {
          mae = (j.rangeLow - entryPrice) / entryPrice * 100;   // 負值=最深虧
          mfe = (j.rangeHigh - entryPrice) / entryPrice * 100;  // 正值=最高賺
        } else {
          mae = (entryPrice - j.rangeHigh) / entryPrice * 100;  // 做空：最高價是最不利
          mfe = (entryPrice - j.rangeLow) / entryPrice * 100;
        }
        mae = Math.round(mae * 100) / 100;
        mfe = Math.round(mfe * 100) / 100;
        autoNote = `自動計算：區間最深虧 ${mae}%、最高賺 ${mfe}%`;
      } else {
        autoNote = '⚠️ K線抓取失敗，MAE 留空（不影響記錄）';
      }
    }
  } catch (e) {
    autoNote = '⚠️ K線抓取失敗，MAE 留空';
    if (typeof ErrorLog !== 'undefined') ErrorLog.push('MAE自動計算', e);
  }

  // ── 自動判定凹單 & 判斷對錯 ──
  // MAE 為負值，取絕對值與停損比；超過停損還沒在那出場 = 凹單
  let holdOn = 'no', judgment = 'correct', reasons = [];
  const maeAbs = mae != null ? Math.abs(mae) : null;
  if (!isNaN(plannedStop) && maeAbs != null && maeAbs > plannedStop) {
    holdOn = 'yes'; judgment = 'wrong';
    reasons.push(`MAE(-${maeAbs}%)超過原停損(${plannedStop}%)，凹單`);
  }
  // 即使最後賺錢，但中途深虧超過停損 → 判斷錯誤（僥倖回本）
  // 出場原因自動推斷
  let exitReason = result === 'win' ? (judgment === 'wrong' ? 'holdback' : 'tp') : (judgment === 'wrong' ? 'sl' : 'sl');

  // ── 自動抓「進場日當天」的公式分數（讓匯出能改公式）──
  let entryFormulas = null;
  try {
    if (GAS_URL && GAS_URL.indexOf('http') === 0 && typeof computeFormulas === 'function') {
      const hr = await fetch(`${GAS_URL}?action=histuntil&code=${encodeURIComponent(code)}&until=${entryDate}`);
      const hj = await hr.json();
      if (hj.ok && hj.closes) {
        const f = computeFormulas(hj);
        if (f) {
          entryFormulas = {
            sti: Math.round(f.sti.value * 10) / 10,
            mfd: Math.round(f.mfd.value * 100) / 100,
            eco: Math.round(f.eco.value),
            psy: f.psy ? Math.round(f.psy.value) : null,
            fusion: f.fusion.value,
            crash: f.crash.score
          };
          autoNote += `｜進場日公式 FUSION ${f.fusion.value>=0?'+':''}${f.fusion.value}`;
          // 方向一致性：實戰數據證明逆公式進場 MAE 明顯較深（順公式-1.6% vs 逆公式最深-6%）
          const fz = f.fusion.value;
          if ((dir==='short' && fz>=20) || (dir==='long' && fz<=-20)) {
            entryFormulas.align = '逆公式';
            autoNote += `｜⚠️ 逆公式進場（FUSION與方向相反），歷史上這類單套牢較深`;
          } else if ((dir==='short' && fz<=-20) || (dir==='long' && fz>=20)) {
            entryFormulas.align = '順公式';
          } else {
            entryFormulas.align = '中性';
          }
        }
      }
    }
  } catch (e) {
    if (typeof ErrorLog !== 'undefined') ErrorLog.push('進場公式分數', e);
  }

  // ── 分批進場：記錄每批的公式分數 + 分析加碼決策好壞 ──
  const batches = (typeof getBatchData === 'function') ? getBatchData() : [];
  let batchRecords = null;
  if (batches.length >= 2) {
    batchRecords = [];
    const sortedB = [...batches].sort((a,b)=>a.date<b.date?-1:1);
    for (let bi = 0; bi < sortedB.length; bi++) {
      const b = sortedB[bi];
      let bf = null;
      try {
        if (GAS_URL && GAS_URL.indexOf('http') === 0 && typeof computeFormulas === 'function') {
          const r = await fetch(`${GAS_URL}?action=histuntil&code=${encodeURIComponent(code)}&until=${b.date}`);
          const j = await r.json();
          if (j.ok && j.closes) {
            const f = computeFormulas(j);
            if (f) bf = { fusion: f.fusion.value, sti: Math.round(f.sti.value*10)/10, crash: f.crash.score };
          }
        }
      } catch (e) { /* 略過單批 */ }
      // 加碼決策分析：第2批之後，看是順勢加碼還是逆勢攤平
      let addJudge = '';
      if (bi > 0) {
        const prev = sortedB[bi-1];
        const isLong = dir === 'long';
        // 做多加碼在更高價=順勢（對）、更低價=攤平（危險）；做空相反
        const higherPrice = b.price > prev.price;
        const trendAdd = isLong ? higherPrice : !higherPrice;
        addJudge = trendAdd ? '順勢加碼' : '逆勢攤平';
      }
      batchRecords.push({ date: b.date, price: b.price, qty: b.qty, fusion: bf?bf.fusion:null, addJudge });
    }
    autoNote += `｜已記錄 ${batchRecords.length} 批加碼`;
  }

  // ── 分批出場：記錄各批 + 分析停利執行 ──
  const exits = (typeof getExitData === 'function') ? getExitData() : [];
  let exitRecords = null;
  if (exits.length >= 2) {
    const sortedE = [...exits].sort((a,b)=>a.date<b.date?-1:1);
    const isLong = dir === 'long';
    exitRecords = sortedE.map((e, i) => {
      // 分批停利品質：做多時越晚出場價越高=漂亮(讓獲利奔跑)；越低=越賣越差
      let exitJudge = '';
      if (i > 0) {
        const prev = sortedE[i-1];
        const better = isLong ? e.price > prev.price : e.price < prev.price;
        exitJudge = better ? '價更優（讓利潤奔跑）' : '價更差（提早跑或追殺）';
      }
      return { date: e.date, price: e.price, qty: e.qty, exitJudge };
    });
    autoNote += `｜已記錄 ${exitRecords.length} 批出場`;
  }

  await dbAddTrade({
    date: exitDate, entryDate, exitDate, holdDays, code, direction: dir, result,
    entryPrice, exitPrice, pnlPct: Math.round(pnlPct * 100) / 100, pnl,
    shares: isNaN(shares) ? null : shares,
    mae, mfe, plannedStop: isNaN(plannedStop) ? null : plannedStop,
    holdOn, exitReason, judgment, judgmentReason: reasons.join('、'),
    entryFormulas,   // 進場日的公式分數
    batchRecords,    // 分批加碼紀錄
    exitRecords,     // 分批出場紀錄
    sim: isSim       // 模擬單標記
  });

  // 清空價格欄
  $('tr-entryprice').value = ''; $('tr-exitprice').value = ''; $('tr-code').value = '';
  $('tr-sim').checked = false;
  const br = document.getElementById('batch-rows'); if (br) br.innerHTML = '';
  const brs = document.getElementById('batch-result'); if (brs) brs.textContent = '';
  const er = document.getElementById('exit-rows'); if (er) er.innerHTML = '';
  const ers = document.getElementById('exit-result'); if (ers) ers.textContent = '';
  msg.textContent = '✅ 已新增！' + autoNote; msg.style.color = 'var(--buy)';
  await refreshJournal();
  await syncWinRateToMain();
}

let _journalFilter = 'all'; // all / real / sim
function setJournalFilter(f) { _journalFilter = f; refreshJournal(); }

async function refreshJournal() {
  const allTrades = await dbGetAllTrades();
  // 篩選真實/模擬
  const trades = _journalFilter === 'real' ? allTrades.filter(t => !t.sim)
               : _journalFilter === 'sim' ? allTrades.filter(t => t.sim)
               : allTrades;
  const realCount = allTrades.filter(t => !t.sim).length;
  const simCount = allTrades.filter(t => t.sim).length;
  const s = computeStats(trades);
  // 篩選切換按鈕
  const filterBtn = (val, label, n) =>
    `<button onclick="setJournalFilter('${val}')" style="flex:1;padding:6px;font-size:11px;font-weight:600;border-radius:7px;cursor:pointer;border:1px solid ${_journalFilter===val?'var(--acc)':'var(--bd)'};background:${_journalFilter===val?'#3B82F615':'var(--bg)'};color:${_journalFilter===val?'var(--acc)':'var(--muted)'}">${label}${n!=null?` (${n})`:''}</button>`;
  const filterBar = `<div style="display:flex;gap:6px;margin-bottom:12px">${filterBtn('all','全部',allTrades.length)}${filterBtn('real','真實',realCount)}${filterBtn('sim','🧪模擬',simCount)}</div>`;
  const box = (label, val, col) =>
    `<div style="background:var(--bg);border:1px solid var(--bd);border-radius:10px;padding:10px;text-align:center"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:4px">${label}</div><div style="font-family:var(--mono);font-size:18px;font-weight:700;color:${col || 'var(--txt)'}">${val}</div></div>`;
  $('journal-stats').style.display = 'block';
  $('journal-stats').innerHTML =
    filterBar +
    `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">` +
    box('交易筆數', s.count) +
    box('帳面勝率', (s.winRate * 100).toFixed(0) + '%', 'var(--warn)') +
    box('真實勝率', (s.trueWinRate * 100).toFixed(0) + '%', 'var(--buy)') +
    box('判斷錯誤', s.misjudged + ' 筆', s.misjudged > 0 ? 'var(--sell)' : 'var(--muted)') +
    box('盈虧比', s.payoff.toFixed(2), 'var(--acc)') +
    box('總盈虧', (s.totalPnl >= 0 ? '+' : '') + fmtV(Math.round(s.totalPnl)), s.totalPnl >= 0 ? 'var(--buy)' : 'var(--sell)') +
    `</div>`;

  if (trades.length === 0) {
    $('journal-list').innerHTML = '<div style="font-size:12px;color:var(--muted);text-align:center;padding:16px">尚無交易紀錄，新增後自動計算真實勝率</div>';
    return;
  }
  $('journal-list').innerHTML = trades.map(t => {
    const win = t.result === 'win';
    const hold = t.holdDays != null ? `${t.holdDays}天` : '';
    const wrongTag = t.judgment === 'wrong'
      ? `<span style="font-size:9px;background:var(--sell-d);color:var(--sell);padding:1px 5px;border-radius:4px;margin-left:4px" title="${t.judgmentReason||''}">凹單</span>` : '';
    const simTag = t.sim
      ? `<span style="font-size:9px;background:#A855F725;color:var(--purple);padding:1px 5px;border-radius:4px;margin-left:4px">模擬</span>` : '';
    // MAE/MFE 小字（自動算出的）
    const maeMfe = (t.mae != null || t.mfe != null)
      ? `<div style="font-size:9px;color:var(--muted2);margin-top:2px">最深虧 ${t.mae!=null?t.mae+'%':'—'}｜最高賺 ${t.mfe!=null?'+'+t.mfe+'%':'—'}</div>` : '';
    const pnlShow = t.pnlPct != null ? `${t.pnlPct>=0?'+':''}${t.pnlPct}%` : (t.pnl>=0?'+':'')+fmtV(t.pnl);
    return `<div style="background:var(--bg);border:1px solid ${t.judgment==='wrong'?'var(--sell)':'var(--bd)'};border-radius:8px;padding:8px 12px;margin-bottom:6px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-family:var(--mono);font-size:11px;color:var(--muted);width:72px">${t.exitDate || t.date}</span>
        <span style="font-family:var(--mono);font-size:12px;width:44px">${t.code || '—'}</span>
        <span style="font-size:10px;color:var(--muted);width:20px">${t.direction === 'long' ? '多' : '空'}</span>
        <span style="font-size:9px;color:var(--muted2);width:32px">${hold}</span>
        <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:${win ? 'var(--buy)' : 'var(--sell)'};flex:1;text-align:right">${pnlShow}${simTag}${wrongTag}</span>
        <button onclick="delTrade('${t.id}')" style="background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:14px">🗑️</button>
      </div>
      ${maeMfe}
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
  const allTrades = await dbGetAllTrades();
  const trades = allTrades.filter(t => !t.sim); // 凱利公式只用真實單，模擬單不污染實戰勝率
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
  const surl = await dbGetSetting('syncUrl');
  if (surl && $('set-sync-url')) $('set-sync-url').value = surl;
}
async function saveGasUrl() {
  const url = $('set-gas-url').value.trim();
  const msg = $('settings-msg');
  if (url && url.indexOf('http') !== 0) { msg.textContent = '❌ 網址需以 https:// 開頭'; msg.style.color = 'var(--sell)'; return; }
  await dbSetSetting('gasUrl', url);
  GAS_URL = url;                       // 立即生效
  msg.textContent = '✅ 查詢網址已儲存，立即生效';
  msg.style.color = 'var(--buy)';
}

async function saveSyncUrl() {
  const url = $('set-sync-url').value.trim();
  const msg = $('settings-msg');
  if (url && url.indexOf('http') !== 0) { msg.textContent = '❌ 網址需以 https:// 開頭'; msg.style.color = 'var(--sell)'; return; }
  await dbSetSetting('syncUrl', url);
  SYNC_URL = url;                      // 立即生效
  msg.textContent = url ? '✅ 雲端備份網址已儲存（備份將用此網址）' : '✅ 已清空，備份將改用查詢網址';
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

    // 真實單 vs 模擬單分組（模擬單=純照系統判斷做的，最能反映系統準確度）
    const realTrades = trades.filter(t => !t.sim);
    const simTrades = trades.filter(t => t.sim);
    if (simTrades.length > 0) {
      md += `## ★ 真實單 vs 模擬單對照（驗證系統判斷準確度）\n\n`;
      md += `> 模擬單是「完全照本系統判斷」執行的交易，其勝率直接反映**系統判斷準不準**；真實單則含個人臨場操作。\n`;
      md += `> 若模擬單勝率 > 真實單，代表你的臨場操作扣分，應更信任系統；反之則系統需優化。\n\n`;
      const rs = computeStats(realTrades), ss = computeStats(simTrades);
      md += `| 類型 | 筆數 | 帳面勝率 | 真實勝率 | 總盈虧 |\n|------|------|----------|----------|--------|\n`;
      md += `| 真實單 | ${rs.count} | ${(rs.winRate*100).toFixed(1)}% | ${(rs.trueWinRate*100).toFixed(1)}% | ${cur(rs.totalPnl)} |\n`;
      md += `| 🧪模擬單 | ${ss.count} | ${(ss.winRate*100).toFixed(1)}% | ${(ss.trueWinRate*100).toFixed(1)}% | ${cur(ss.totalPnl)} |\n\n`;
    }

    // 一、整體統計
    md += `## 一、整體績效（含真實+模擬）\n\n`;
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
    md += `| 進場日 | 出場日 | 抱倉天 | 代碼 | 方向 | 盈虧% | 判斷對錯 | 最深虧MAE% | 最高賺MFE% | 凹單 |\n`;
    md += `|--------|--------|--------|------|------|-------|----------|-----------|-----------|------|\n`;
    const sorted = [...trades].sort((a,b)=>(a.exitDate||a.date)<(b.exitDate||b.date)?1:-1);
    for (const t of sorted) {
      const judge = t.judgment === 'wrong' ? '❌錯誤' : '✅正確';
      const pnlShow = t.pnlPct != null ? (t.pnlPct>=0?'+':'')+t.pnlPct+'%' : cur(t.pnl);
      md += `| ${t.entryDate||'—'} | ${t.exitDate||t.date} | ${t.holdDays!=null?t.holdDays:'—'} | ${t.code||'—'} | ${t.direction==='long'?'多':'空'} | ${pnlShow} | ${judge} | ${t.mae!=null?t.mae:'—'} | ${t.mfe!=null?'+'+t.mfe:'—'} | ${t.holdOn==='yes'?'是':'否'} |\n`;
    }
    md += `\n`;

    // 四之二、★公式分數 vs 結果對照（AI 改公式的關鍵資料）
    const withFormula = trades.filter(t => t.entryFormulas);
    if (withFormula.length > 0) {
      md += `## 四之二、進場時公式分數 vs 實際結果（★最重要：AI 據此調整公式門檻）\n\n`;
      md += `| 進場日 | 代碼 | 類型 | STI | MFD | ECO | PSY | FUSION | 方向一致 | 崩跌分 | 實際盈虧% | MAE% | 判斷對錯 |\n`;
      md += `|--------|------|------|-----|-----|-----|-----|--------|----------|--------|-----------|------|----------|\n`;
      const sortedF = [...withFormula].sort((a,b)=>(a.exitDate||a.date)<(b.exitDate||b.date)?1:-1);
      for (const t of sortedF) {
        const f = t.entryFormulas;
        const psy = f.psy != null ? f.psy : '—';
        const type = t.sim ? '🧪模擬' : '真實';
        md += `| ${t.entryDate} | ${t.code} | ${type} | ${f.sti>=0?'+':''}${f.sti} | ${f.mfd>=0?'+':''}${f.mfd} | ${f.eco} | ${psy} | ${f.fusion>=0?'+':''}${f.fusion} | ${f.align||'—'} | ${f.crash} | ${t.pnlPct>=0?'+':''}${t.pnlPct}% | ${t.mae!=null?t.mae:'—'} | ${t.judgment==='wrong'?'❌':'✅'} |\n`;
      }
      md += `\n`;
      // 順公式 vs 逆公式 MAE 對照（方向一致性的量化證據）
      const alignG = withFormula.filter(t=>t.entryFormulas.align==='順公式'&&t.mae!=null);
      const againstG = withFormula.filter(t=>t.entryFormulas.align==='逆公式'&&t.mae!=null);
      if (alignG.length || againstG.length) {
        const avgMae = arr => arr.length ? (arr.reduce((a,t)=>a+Math.abs(t.mae),0)/arr.length).toFixed(2) : '—';
        md += `**順公式 vs 逆公式（方向一致性統計）**\n\n`;
        md += `| 類型 | 筆數 | 平均MAE深度 | 凹單數 |\n|------|------|------------|--------|\n`;
        md += `| 順公式 | ${alignG.length} | -${avgMae(alignG)}% | ${alignG.filter(t=>t.judgment==='wrong').length} |\n`;
        md += `| 逆公式 | ${againstG.length} | -${avgMae(againstG)}% | ${againstG.filter(t=>t.judgment==='wrong').length} |\n\n`;
        md += `> 逆公式=進場方向與FUSION相反。若逆公式MAE明顯較深，代表應等公式同向再進場。\n\n`;
      }
      md += `> 💡 **這張表是優化公式的核心**：請分析「進場時的公式分數」與「實際盈虧」的關聯。\n`;
      md += `> 🧪模擬單是純照系統判斷做的，最能反映公式準確度，優先分析模擬單的公式分數與結果關聯。\n`;
      md += `> 例如：FUSION 分數高的進場是否真的勝率較高？某個門檻以上才進場能否提升真實勝率？\n`;
      md += `> STI/MFD/ECO/PSY 哪個與獲利相關性最強？應該調高哪個的權重？崩跌分高時是否該避開？\n\n`;
    } else {
      md += `## 四之二、進場公式分數\n\n尚無含公式分數的交易紀錄。新版交易日誌會自動記錄進場日的 STI/MFD/ECO/FUSION，累積後此處會出現「公式分數 vs 結果」對照表，供 AI 優化公式門檻。\n\n`;
    }
    // 四之三、加碼決策分析（分批進場的交易）
    const withBatch = trades.filter(t => t.batchRecords && t.batchRecords.length >= 2);
    if (withBatch.length > 0) {
      md += `## 四之三、加碼決策分析（分批進場）\n\n`;
      md += `> 分析每次加碼是「順勢加碼」（對的方向繼續加）還是「逆勢攤平」（套牢後攤平成本，危險）。\n\n`;
      md += `| 代碼 | 出場日 | 批次 | 進場日 | 價格 | 加碼判斷 | 進場FUSION | 最終盈虧% |\n`;
      md += `|------|--------|------|--------|------|----------|-----------|----------|\n`;
      for (const t of withBatch) {
        t.batchRecords.forEach((b, i) => {
          md += `| ${i===0?t.code:''} | ${i===0?(t.exitDate||t.date):''} | 第${i+1}批 | ${b.date} | ${b.price} | ${b.addJudge||'首批'} | ${b.fusion!=null?(b.fusion>=0?'+':'')+b.fusion:'—'} | ${i===0?(t.pnlPct>=0?'+':'')+t.pnlPct+'%':''} |\n`;
        });
      }
      md += `\n> 💡 重點分析：逆勢攤平的交易最終是賺是賠？順勢加碼的成功率如何？攤平是否常導致大虧？這能驗證你的加碼策略好壞。\n\n`;
    }

    // 四之四、分批出場（停利執行）分析
    const withExit = trades.filter(t => t.exitRecords && t.exitRecords.length >= 2);
    if (withExit.length > 0) {
      md += `## 四之四、分批出場 / 停利執行分析\n\n`;
      md += `> 分析分批停利執行得好不好：越賣越高（讓利潤奔跑）還是越賣越低（提早跑/追殺）。\n\n`;
      md += `| 代碼 | 出場日 | 批次 | 日期 | 價格 | 停利品質 |\n|------|--------|------|------|------|----------|\n`;
      for (const t of withExit) {
        t.exitRecords.forEach((e, i) => {
          md += `| ${i===0?t.code:''} | ${i===0?(t.exitDate||t.date):''} | 第${i+1}批 | ${e.date} | ${e.price} | ${e.exitJudge||'首批出場'} |\n`;
        });
      }
      md += `\n> 💡 重點：你是否常常太早把整批賣掉、錯過後段大漲？還是賣在相對高點？這驗證你的停利紀律。\n\n`;
    }

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
