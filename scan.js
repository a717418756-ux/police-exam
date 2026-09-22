/* ══════════════════════════════════════════════════════════════════════
   scan.js — 條件篩選器（v110）
   ──────────────────────────────────────────────────────────────────
   ★ 定位：不是「推薦會漲/會跌的股票」——19年24檔7,908事件已證方向不可預測，
     任何宣稱能選出「會漲的股票」的功能都是在說謊。
     本功能做的是：把你自己的觀察池逐檔跑完整分析引擎，依「風控與時機」
     條件（本系統唯一有實證的車道）排序，回答的是：
        「這些股票裡，哪幾檔『現在進場的條件結構』比較好？」
     而不是「哪一檔會漲」。最後決定與下單仍然是你。
   ──────────────────────────────────────────────────────────────────
   運作方式：後端 action=scan 批次取K線（20檔/批）→ 前端逐檔跑既有引擎
   （Regime/溫度計/突破統計/Amihud/急跌/勢能）→ 條件計分 → 排序顯示。
   所有引擎都是純前端計算，掃描不需要額外的籌碼API（太重且T+1）。
   ⚠️ 條件分數 ≠ 勝率 ≠ 預測。它是「通過幾項風控條件」的計數。
   ══════════════════════════════════════════════════════════════════════ */
/* v163 檔案版本宣告：讓前端能查出「站上哪個檔案沒更新到」。
   改這個檔時一併把數字改成當版；config.js 的 FILE_VERS 必須同步（自我檢查會擋）。 */
try { (window.SR_FV = window.SR_FV || {})['scan.js'] = 166; } catch (e) {}

/* v115修：前端原送15檔/批，但 Code.gs（GAS後端）上限只取前10檔——
   使用GAS的人每批會默默遺失5檔（不成功也不算失敗，直接消失，總數對不上）。
   統一降為10檔，同時相容 worker.js(上限20) 與 Code.gs(上限10)。
   代價是批次數增加，但正確性優先。 */
const SCAN_BATCH = 10;          // 兩種後端的共同安全值

/* ── 內建掃描池（v111，v166起降為「備援」）─────────────────────────────
   v166：主要來源已改為動態池（見 fetchDynamicPool）——後端每次掃描前抓
   上市＋上櫃當日全市場成交行情，依成交金額取前N名。這解決了靜態清單
   必然過時的問題（成分股調整、下市、合併、新上市）。
   本清單保留為 API 失敗時的備援，而且用到它時畫面會明講「這次用的是
   內建備援清單（可能已過時）」——不讓它變成另一種靜默降級。
   ⚠️ 這是「候選池」不是「推薦清單」——池子只決定掃描範圍，篩選仍由
      條件引擎逐檔判定。
   ──────────────────────────────────────────────────────────────── */
const TW_POOL = [
  // 半導體/電子權值
  '2330','2454','2303','2308','2317','2382','2357','2377','2379','2408','2409','2412','3034','3037','3231','3711','2474','2376','3008','2327','2385','6669','3661','3443','5269','6415','8069','3529','4938','2356','2324','2347','3045','2345','6285','2049','1590','2360','3702','2301',
  // 金融
  '2881','2882','2883','2884','2885','2886','2887','2890','2891','2892','2880','2801','2809','2812','2834','5871','5880','2889',
  // 傳產/塑化/鋼鐵/水泥
  '1301','1303','1326','1216','1101','1102','2002','2027','2015','1605','1802','1717','9945',
  // 航運/觀光/生技
  '2603','2609','2615','2610','2618','2606','5608','2727','2707','1707','1789','4162','6446','4174','1737',
  // 中小型熱門/題材
  '2313','3481','6116','6505','6508','2498','2337','2344','2451','3260','6182','8046','1519','2367','3005','6206','3583','8299','3105','5347','6239','2383','2371','2352','2353'
].filter(c => /^\d{4}$/.test(c));

let _scanAbort = false;

/* 單檔條件評估：回傳通過的條件與未通過的原因（dir: -1做空 / 1做多）*/

/* ── 前置流動性/炒作門檻（v112）─────────────────────────────────────────
   在跑完整條件引擎「之前」先擋掉不該碰的標的，理由都是實務而非理論：
     ① 日均成交額門檻：流動性不足＝借券借不到、下單推動價格、停損時滑價
        吃掉利潤。做空尤其致命（借不到券根本做不了）。台股18檔實測：
        台灣50/中型100成分股日均成交額 7.7~931億，1億門檻不會誤殺熱門股，
        但能擋掉自行貼入的冷門股。
     ② 炒作偵測：近20日漲幅過大＋單日爆量＝短線資金炒作，波動不可預測、
        軋空風險最高。這類標的無論多空都不適合紀律交易。
     ③ 波動下限：ATR%過低＝沒有波動就沒有價差空間，2-10日週期做不出來。
   ⚠️ 與 Amihud 不衝突：Amihud 是「該股相對自身歷史」的流動性百分位，
      此處是「跨股絕對門檻」，兩者互補（前者看變化、後者看夠不夠大）。
   ──────────────────────────────────────────────────────────────── */
const SCAN_MIN_TURNOVER = 1e8;   // 日均成交額下限：1億台幣（美股以美元計，門檻另計）
function prefilterStock(D) {
  try {
    const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows, v = D.volumes;
    const n = c.length;
    if (n < 60) return { pass: false, why: '資料不足60日' };
    // ① 日均成交額（近20日）
    let amt = 0;
    for (let i = n - 20; i < n; i++) amt += c[i] * v[i];
    amt /= 20;
    const minAmt = D.currency === 'TWD' ? SCAN_MIN_TURNOVER : 1e7;   // 美股門檻 1000萬美元
    if (amt < minAmt) return { pass: false, why: `日均成交額 ${(amt / 1e8).toFixed(2)}億，低於門檻（流動性不足：借券難、滑價大）`, amt };
    // ② 炒作偵測：20日漲幅>40% 且 近5日有單日量>20日均量4倍
    const chg20 = (c[n - 1] - c[n - 21]) / c[n - 21] * 100;
    const vol20 = v.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20;
    const maxV5 = Math.max(...v.slice(n - 5));
    if (chg20 > 40 && vol20 > 0 && maxV5 > vol20 * 4) return { pass: false, why: `20日漲${chg20.toFixed(0)}%＋單日爆量${(maxV5 / vol20).toFixed(1)}倍＝疑似短線炒作（波動不可測、軋空風險高）`, amt };
    // ③ 波動下限：ATR% < 1.2% 代表幾乎不動，短線做不出價差
    let atr = 0;
    for (let k = n - 14; k < n; k++) atr += Math.max(h[k] - l[k], Math.abs(h[k] - c[k - 1]), Math.abs(l[k] - c[k - 1]));
    atr /= 14;
    const atrPct = atr / c[n - 1] * 100;
    if (atrPct < 1.2) return { pass: false, why: `ATR僅 ${atrPct.toFixed(2)}%（波動過低，2-10日週期做不出價差）`, amt };
    return { pass: true, amt, atrPct, chg20 };
  } catch (e) { return { pass: false, why: '前置檢查失敗' }; }
}

function evalScanConditions(D, dir) {
  const pass = [], fail = [];
  let regime = null, ms = null, bs = null, am = null, cp = null, shi = null;
  try { regime = computeRegime(D); } catch (e) {}
  try { ms = computeMoveStage(D); } catch (e) {}
  try { bs = computeBreakoutStats(D); } catch (e) {}
  try { am = computeAmihud(D); } catch (e) {}
  try { cp = computeCrashPhase(D); } catch (e) {}
  try { shi = computeShiPower(D, 50); } catch (e) {}

  // ① 環境：v138 實測順勢/逆勢/盤整期望值無差異，只保留高波動禁令（高波動放空每筆約−1.4~−1.8%）
  if (regime && regime.regime === '高波動危險') fail.push('高波動危險態');
  // ② 波段未到尾端（避免追殺魚尾／追高買在頭部）
  if (ms) {
    const sameDir = (dir === -1 && ms.dir === -1) || (dir === 1 && ms.dir === 1);
    if (sameDir && ms.maturity >= 70) fail.push(`同向波段已走${ms.maturity.toFixed(0)}%（尾端，追單風險高）`);
    else if (sameDir) pass.push(`波段成熟度${ms.maturity.toFixed(0)}%（尚有空間）`);
  }
  // ③ 流動性（Amihud）：稀薄=滑價與跳空放大器
  if (am) {
    if (am.level === '稀薄') fail.push(`流動性稀薄（第${Math.round(am.pct)}分位，滑價風險）`);
    else pass.push(`流動性${am.level}（第${Math.round(am.pct)}分位）`);
  }
  // ④ 急跌階段：末端不追（19年實證跌深處偏反彈）
  if (cp) {
    if (cp.phase === '急跌末端' && dir === -1) fail.push('急跌末端出現承接棒（追空=撿人家出完的）');
    else if (cp.phase === '急跌進行' && dir === -1) pass.push('急跌進行中（空單魚身段）');
  }
  // ⑤ 此股突破可靠度（做空時：假突破率高＝空方有利；做多時反之）
  if (bs && bs.tier === 'high') {
    if (dir === -1 && bs.all.rate < 40) pass.push(`此股突破成功率僅${bs.all.rate.toFixed(0)}%（易假突破，對空方有利）`);
    else if (dir === 1 && bs.all.rate >= 48) pass.push(`此股突破成功率${bs.all.rate.toFixed(0)}%（優於台股38.4%基準）`);
    else if (dir === 1 && bs.all.rate < 38) fail.push(`此股突破成功率僅${bs.all.rate.toFixed(0)}%（追突破期望值為負）`);
  }
  // ⑥ 勢能方向一致（結構性條件，非方向預測）
  if (shi) {
    const s = dir === -1 ? shi.shortShi : shi.shi;
    if (s >= 60) pass.push(`${dir === -1 ? '空' : '多'}方勢能${s}`);
    else if (s < 40) fail.push(`${dir === -1 ? '空' : '多'}方勢能僅${s}（條件不足）`);
  }
  return { pass, fail, score: pass.length - fail.length, regime, ms, bs, am, cp, shi };
}

/* 掃描主流程：分批取K線 → 逐檔評估 → 排序顯示 */

/* v114 主入口：選方向就直接掃內建池，使用者完全不必碰代碼。
   （舊的 runScan 保留給「進階：自訂清單」使用，兩者共用同一套掃描核心） */
/* ── v165 死代碼自動略過 ────────────────────────────────────────────────
   內建池是靜態清單，下市／合併／改代碼一定會發生（1704、2888 都已手動移除過）。
   每次都要人工來修不切實際，所以改成：某檔「連續兩次掃描都查無K線」就記起來，
   之後自動略過並在結果上方明講略過了哪幾檔，附一鍵復原。
   ⚠️ 為什麼要連續兩次：Yahoo 偶發限流也會回查無K線，一次就除名會誤殺活股。
   ⚠️ 只有「查無K線」算數；「不足60日」是真的資料不夠，不是死代碼，不列入。 */
const DEAD_KEY = 'sr_dead_codes';
function loadDead() { try { return JSON.parse(localStorage.getItem(DEAD_KEY) || '{}'); } catch (e) { return {}; } }
function saveDead(m) { try { localStorage.setItem(DEAD_KEY, JSON.stringify(m)); } catch (e) {} }
function resetDead() { try { localStorage.removeItem(DEAD_KEY); } catch (e) {} const b = document.getElementById('scan-result'); if (b) b.innerHTML = '<div style="font-size:12px;color:var(--muted)">已復原被略過的代碼，請重新掃描。</div>'; }

/* ── v166 動態掃描池 ───────────────────────────────────────────────────
   使用者問的是「內建池的檔數能不能浮動，系統自己抓台灣50及中型股來跑分數」。
   做法：後端 action=pool 抓上市(STOCK_DAY_ALL)＋上櫃(tpex_mainboard_daily_close_quotes)
   當日全市場行情，依「當日成交金額」排序取前N名。
   ⚠️ 為什麼用成交金額排序，而不是真的去抓台灣50/中型100成分股：
      官方沒有免費的成分股清單API（成分只在PDF/付費源），而池子存在的理由
      本來就是流動性（借得到券、滑價小）——成交金額是直接量測這件事，
      而且永遠不會過期。台灣50與中型100的成分股本來就會落在成交金額前段。
   ⚠️ 單日成交金額只是「候選產生器」。真正的流動性門檻仍是前置的20日均額≥1億，
      所以某天爆量的冷門股進得了候選、過不了門檻——不會因此放寬標準。
   ⚠️ 失敗一定要吵：回 null，由呼叫端改用 TW_POOL 並在結果上方紅字說明。 */
let _poolNote = '';      // 這次掃描的池子來源說明（渲染在結果上方）
let _autoPool = false;   // 這次的代碼是系統產生的→不要寫進「使用者自訂清單」

function poolN() {
  const s = document.getElementById('scan-pool-n');
  const n = parseInt((s && s.value) || '150', 10);
  return (n >= 20 && n <= 300) ? n : 150;
}

async function fetchDynamicPool(n) {
  const r = await fetchT(`${GAS_URL}?action=pool&n=${n}`, {}, 30000);
  if (!r.ok) throw new Error(`後端 HTTP ${r.status}${r.status === 404 ? '（找不到端點——後端未部署或網址錯誤）' : ''}`);
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); }
  catch (pe) { throw new Error(`後端回傳的不是 JSON（開頭：${txt.slice(0, 40).replace(/</g, '&lt;')}…）——多半是後端尚未部署 v166 的 pool 端點`); }
  if (!j.ok) throw new Error(j.error || '後端錯誤');
  if (!Array.isArray(j.codes) || !j.codes.length) throw new Error('後端無 codes 欄位——後端（worker.js / Code.gs）尚未更新到含 pool 端點的版本，請重新部署');
  return j;
}

async function runScanAuto(dirStr) {
  const ta = document.getElementById('scan-codes');
  const dead = loadDead();
  const sel = document.getElementById('scan-dir');
  if (sel) sel.value = dirStr;                    // 同步方向
  const box = document.getElementById('scan-result');
  const n = poolN();
  let pool = null;
  _poolNote = '';
  if (box) box.innerHTML = '<div style="font-size:12px;color:var(--muted)">正在抓取今日全市場成交排行，組成掃描池…</div>';
  try {
    const p = await fetchDynamicPool(n);
    pool = p.codes.filter(c => !(dead[c] >= 2));
    /* 新鮮度：dataDate 是交易所當日行情日期。比今天舊很多代表連假或來源沒更新，
       這會直接影響「前N名」的組成，所以要講出來而不是默默用舊排行。 */
    const dd = p.dataDate || '';
    const fresh = dd ? `${dd.slice(0, 4)}/${dd.slice(4, 6)}/${dd.slice(6, 8)}` : '日期不明';
    _poolNote = `<div style="margin-bottom:8px;padding:8px 10px;background:var(--bg);border:1px dashed var(--bd2);border-radius:7px;font-size:10px;color:var(--muted);line-height:1.6">
      📊 <b>動態掃描池</b>：取 ${fresh} 上市＋上櫃成交金額前 ${n} 名（全市場符合條件個股 ${p.universe} 檔，第 ${n} 名當日成交金額 ${(p.cutoff / 1e8).toFixed(2)} 億）。
      已排除 ETF／特別股／DR（只留四位數字代碼）。<b>這只是候選範圍，不是推薦</b>——流動性門檻仍以20日均額≥1億逐檔判定。
      ${p.srcErrors ? `<div style="color:var(--warn);margin-top:4px">⚠️ 其中有來源沒拿到，這次的排行<b>不含</b>它：${p.srcErrors.join('；')}</div>` : ''}
    </div>`;
  } catch (e) {
    /* 備援必須吵。靜默改用靜態清單＝使用者以為自己掃的是今日熱門股，
       其實掃的是可能已過時的寫死清單。 */
    pool = TW_POOL.filter(c => !(dead[c] >= 2));
    _poolNote = `<div style="margin-bottom:8px;padding:8px 10px;background:var(--warn-d);border:1px solid var(--warn);border-radius:7px;font-size:10px;color:var(--muted);line-height:1.6">
      ⚠️ <b>這次用的是內建備援清單（${pool.length} 檔），不是今日成交排行</b>——動態池取得失敗：${String(e && e.message || e)}<br>
      備援清單是寫死的，可能已過時（成分調整／下市／新上市都不會反映）。若你的後端尚未部署 v166，請重新部署 worker.js 或 Code.gs 後再掃一次。
    </div>`;
  }
  if (ta) ta.value = pool.join(' ');          // 填入這次實際使用的池子
  _autoPool = true;                           // 系統產生的清單不覆蓋使用者自訂清單
  document.getElementById('scan-short').disabled = true;
  document.getElementById('scan-long').disabled = true;
  try { await runScan(); }
  finally {
    document.getElementById('scan-short').disabled = false;
    document.getElementById('scan-long').disabled = false;
  }
}

async function runScan() {
  const raw = document.getElementById('scan-codes').value || '';
  let codes = raw.split(/[\s,，、]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) codes = TW_POOL.slice();   // v114：留空＝自動用內建熱門池（使用者不必準備清單）
  const dir = document.getElementById('scan-dir').value === 'short' ? -1 : 1;
  const box = document.getElementById('scan-result');
  if (!codes.length) { box.innerHTML = '<div style="color:var(--warn);font-size:12px">內建池異常且未輸入代碼——請於「進階」貼上股票代碼</div>'; return; }   // TW_POOL 異常時的最後防線
  /* v166：上限從130放寬到300，配合動態池可選到300檔。
     成本是等待時間（每10檔一批，實測約1.5秒/批 → 300檔約45秒），
     使用者明確表示「讀取資料久點沒關係」，但不能無上限（後端與Yahoo限流）。 */
  if (codes.length > 300) { box.innerHTML = '<div style="color:var(--warn);font-size:12px">一次最多300檔（避免後端負擔過重與被來源限流）</div>'; return; }

  const autoPool = _autoPool; _autoPool = false;   // v166：只對這一次生效
  if (!autoPool) { _poolNote = ''; saveScanPool(); }   // 手動清單才存檔，系統產生的池子不覆蓋使用者自訂清單
  const deadTrack = loadDead();   // v165：累計「查無K線」次數，滿2次才自動略過
  _scanAbort = false;
  document.getElementById('scan-run').disabled = true;
  document.getElementById('scan-stop').style.display = 'inline-block';
  const rows = [];
  const t0 = Date.now();

  for (let i = 0; i < codes.length; i += SCAN_BATCH) {
    if (_scanAbort) break;
    const batch = codes.slice(i, i + SCAN_BATCH);
    box.innerHTML = `<div style="font-size:12px;color:var(--muted)">掃描中… ${Math.min(i + SCAN_BATCH, codes.length)}/${codes.length} 檔（已耗時 ${((Date.now() - t0) / 1000).toFixed(0)}秒）</div>`;
    try {
      // v152：後端改為限流併發＋失敗重試，單批最久可能到 40 秒，逾時上限放寬到 120 秒
      const r = await fetchT(`${GAS_URL}?action=scan&codes=${encodeURIComponent(batch.join(','))}`, {}, 120000);
      /* v116：原本直接 r.json()，後端若回 404 或 HTML 錯誤頁會拋出
         「Unexpected token <」這種無用訊息。先看 HTTP 狀態、再確認是不是 JSON，
         讓錯誤訊息直接指向真正的原因（端點不存在／未部署／回傳非JSON）。 */
      if (!r.ok) throw new Error(`後端 HTTP ${r.status}${r.status === 404 ? '（找不到端點——後端未部署或網址錯誤）' : ''}`);
      const txt = await r.text();
      let j;
      try { j = JSON.parse(txt); }
      catch (pe) { throw new Error(`後端回傳的不是 JSON（開頭：${txt.slice(0, 40).replace(/</g, '&lt;')}…）——多半是後端未部署 scan 端點，或 GAS 部署權限設定錯誤`); }
      if (!j.ok) throw new Error(j.error || '後端錯誤');
      if (!Array.isArray(j.results)) throw new Error('後端無 results 欄位——你的後端（Cloudflare Worker / GAS）可能尚未更新到含 scan 端點的版本，請重新部署 worker.js 或 Code.gs');
      if (j.results.length < batch.length) {
        const got = new Set(j.results.map(x => x.code));
        batch.filter(c => !got.has(c)).forEach(c => rows.push({ code: c, err: true, errMsg: `後端未回傳此檔（送出${batch.length}檔僅回${j.results.length}檔，可能後端批次上限較低）` }));
      }
      for (const item of (j.results || [])) {
        // v152：後端現在會逐檔回傳失敗原因，別再丟掉（丟掉就只剩「ok:false」這種無用訊息）
        if (!item.ok) { rows.push({ code: item.code, err: true, errMsg: item.error }); continue; }
        if (deadTrack[item.code]) delete deadTrack[item.code];   // v165：這次抓到了就清除失敗紀錄
        /* v142：掃描也套用「盤中丟棄未完成K棒」（與個股查詢同一函式），
           否則同一時刻掃描用今日未收K、個股頁用前一日完成K，兩邊結論會不一致 */
        const it = (typeof trimIntradayBar === 'function') ? trimIntradayBar(item) : item;
        const D = {
          code: it.code, currency: /^\d{4,6}$/.test(it.code) ? 'TWD' : 'USD',
          closes: it.closes, highs: it.highs, lows: it.lows, volumes: it.volumes,
          opens: it.opens || undefined, price: it.price, lastDate: it.lastDate,
          /* v152：原本把「還原價」直接當成 rawCloses 塞進去，於是掃描用還原價算
             ATR／20日高低，個股頁用原始價，同一檔兩邊結論可能不同。後端已補傳原始價；
             ||closes 是相容舊後端的退路（舊後端沒這欄位時至少不會壞掉）。 */
          rawCloses: it.rawCloses || it.closes, rawHighs: it.rawHighs || it.highs,
          rawLows: it.rawLows || it.lows, _intraday: it._intraday,
        };
        const pf = prefilterStock(D);
        if (!pf.pass) { rows.push({ code: item.code, price: item.price, filtered: true, why: pf.why }); continue; }
        const ev = evalScanConditions(D, dir);
        rows.push({ code: item.code, price: item.price, turnover: pf.amt, ...ev });
      }
    } catch (e) {
      batch.forEach(c => rows.push({ code: c, err: true, errMsg: e.message }));
    }
  }

  /* v165：把本輪「查無K線」的累計次數寫回；抓得到的已在上面清除。
     只認查無K線，不足60日與其他錯誤不計入（那些不是死代碼）。 */
  for (const r of rows) if (r.err && /查無K線|查無此代碼/.test(r.errMsg || '')) deadTrack[r.code] = (deadTrack[r.code] || 0) + 1;
  saveDead(deadTrack);

  document.getElementById('scan-run').disabled = false;
  document.getElementById('scan-stop').style.display = 'none';
  renderScanResult(rows, dir, ((Date.now() - t0) / 1000).toFixed(0), deadTrack);
}

function stopScan() { _scanAbort = true; }

function renderScanResult(rows, dir, secs, deadTrack) {
  const box = document.getElementById('scan-result');
  const good = rows.filter(r => !r.err && !r.filtered).sort((a, b) => b.score - a.score);
  const errs = rows.filter(r => r.err);
  const filt = rows.filter(r => r.filtered);   // v112：前置門檻擋掉的（流動性/炒作/波動）
  const dirTxt = dir === -1 ? '做空' : '做多';
  let h = _poolNote || '';   // v166：池子從哪來、資料哪一天、門檻在哪——一律講清楚
  h += `<div style="font-size:11px;color:var(--muted);margin-bottom:8px">
    ${dirTxt}條件掃描完成｜${good.length} 檔通過前置${filt.length ? ` / ${filt.length} 檔被門檻擋下` : ''}${errs.length ? ` / ${errs.length} 檔失敗` : ''}｜耗時 ${secs} 秒
    ${(() => {
      /* v115：以前只顯示「N檔失敗」，使用者無從得知原因。這裡把後端實際回傳的
         錯誤攤開——全部失敗且耗時極短，幾乎都是後端沒有 scan 端點（未重新部署）。 */
      const msgs = [...new Set(errs.map(e => e.errMsg).filter(Boolean))];
      if (!errs.length) return '';
      const allFail = good.length === 0 && filt.length === 0;
      return `<div style="margin-top:6px;padding:8px 10px;background:var(--sell-d);border:1px solid var(--sell);border-radius:7px;font-size:10px;color:var(--muted);line-height:1.6">
        <b style="color:var(--sell)">失敗原因</b>：${msgs.length ? msgs.map(m => `<div>・${m}</div>`).join('') : '<div>・後端未回報原因——你的後端尚未更新到 v152（舊版失敗時不會說明原因），請重新部署 worker.js 或 Code.gs</div>'}
        ${allFail ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)">
          <b>全部失敗且耗時 ${secs} 秒（極短）＝請求被立即拒絕</b>，最常見原因：<br>
          ① <b>後端尚未重新部署</b>：scan 是新端點，舊版 worker.js / Code.gs 不認得 action=scan，會直接回錯。單筆查詢正常不代表後端是新版（單筆走的是另一條路由）。<br>
          ② 檢查方式：把這個網址貼到瀏覽器看回傳內容 →<br>
          <span style="font-family:var(--mono);font-size:9px;word-break:break-all;color:var(--accent)">${(typeof GAS_URL !== 'undefined' ? GAS_URL : '{你的後端網址}')}?action=scan&codes=2330</span><br>
          回傳含 <b>"results"</b> ＝後端已是新版；若回傳錯誤或一般股票資料 ＝ 需重新部署。
        </div>` : ''}
      </div>`;
    })()}
    <div style="font-size:10px;color:var(--muted2);margin-top:4px">依「通過條件數 − 未通過數」排序。<b>這不是漲跌預測</b>——19年7,908事件已證方向不可測；此處排的是「目前進場的條件結構」，最終仍須逐檔開啟完整分析與紀律門確認。</div>
  </div>`;

  // v165：明講這次自動略過了哪幾檔死代碼，並提供一鍵復原（不要讓它變成另一種靜默）
  const skipped = Object.keys(deadTrack || {}).filter(c => deadTrack[c] >= 2);
  if (skipped.length) h += `<div style="margin-top:6px;padding:8px 10px;background:var(--bg);border:1px dashed var(--bd2);border-radius:7px;font-size:10px;color:var(--muted);line-height:1.6">
    ℹ️ 已自動略過 ${skipped.length} 檔連續查無K線的代碼（多半是下市／合併／改代碼）：<b>${skipped.join('、')}</b>
    <button onclick="resetDead()" style="margin-left:6px;background:transparent;border:1px solid var(--bd2);color:var(--acc);border-radius:5px;font-size:10px;padding:2px 8px;cursor:pointer">復原</button></div>`;

  if (!good.length) h += '<div style="font-size:12px;color:var(--warn)">沒有成功取得資料的股票</div>';

  good.forEach(r => {
    const col = r.score >= 3 ? 'var(--buy)' : r.score >= 1 ? 'var(--warn)' : 'var(--muted)';
    h += `<div style="border:1px solid ${col}40;border-radius:8px;padding:9px 11px;margin-bottom:7px;background:${col}08">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
        <span style="font-size:13px;font-weight:700">${r.code} <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${r.price != null ? fmt(r.price) : ''}</span>${r.turnover ? `<span style="font-size:10px;color:var(--muted2);margin-left:6px">日均${(r.turnover / 1e8).toFixed(1)}億</span>` : ''}</span>
        <span style="font-size:11px;font-weight:700;color:${col}">條件 +${r.pass.length} / −${r.fail.length}</span>
      </div>
      ${r.pass.map(p => `<div style="font-size:10px;color:var(--buy);line-height:1.5">✓ ${p}</div>`).join('')}
      ${r.fail.map(f => `<div style="font-size:10px;color:var(--sell);line-height:1.5">✗ ${f}</div>`).join('')}
      <div style="margin-top:5px"><button onclick="document.getElementById('ticker-input').value='${r.code}';closeScan();go();" style="font-size:10px;padding:3px 9px;border-radius:5px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer">開啟完整分析 →</button></div>
    </div>`;
  });

  // v152：逐檔列出真正原因，而不是把所有失敗混成一句「代碼錯誤或資料不足」
  if (errs.length) h += `<details style="margin-top:6px"><summary style="font-size:11px;color:var(--muted2);cursor:pointer">取得失敗的 ${errs.length} 檔（點開看原因）</summary>
    <div style="margin-top:6px">${errs.map(e => `<div style="font-size:10px;color:var(--muted2);line-height:1.6">・<b>${e.code}</b>：${e.errMsg || '後端未回報原因'}</div>`).join('')}</div></details>`;
  if (filt.length) {
    /* v113 防禦：若「成交額不足」佔了絕大多數，比較可能是資料單位或後端版本問題，
       而不是這些熱門股真的都沒量——寧可提示使用者查證，也不要默默把全部擋光。 */
    const liqFail = filt.filter(f => f.why && f.why.indexOf('成交額') >= 0).length;
    const totalScanned = good.length + filt.length;
    if (totalScanned >= 10 && liqFail / totalScanned > 0.7) {
      h += `<div style="margin-top:10px;padding:8px 10px;background:var(--warn-d);border:1px solid var(--warn);border-radius:8px;font-size:10px;color:var(--muted);line-height:1.6">
        ⚠️ 有 ${liqFail}/${totalScanned} 檔因「成交額不足」被擋——若這些是你熟悉的熱門股，代表資料量單位可能異常（例如後端回傳「張」而非「股」），並非它們真的沒量。
        請先確認後端已更新至最新版；若持續如此，暫時把此結果視為不可用，改用逐檔分析。</div>`;
    }
    h += `<details style="margin-top:10px"><summary style="font-size:11px;color:var(--muted2);cursor:pointer">被前置門檻擋下的 ${filt.length} 檔（點開看原因）</summary>
      <div style="margin-top:6px">${filt.map(f => `<div style="font-size:10px;color:var(--muted2);line-height:1.6">・<b>${f.code}</b>：${f.why}</div>`).join('')}</div>
      <div style="font-size:9px;color:var(--muted2);margin-top:6px">門檻：日均成交額≥1億（借券/滑價）、非短線炒作（20日漲>40%＋爆量4倍）、ATR≥1.2%（要有波動才做得出價差）</div></details>`;
  }
  box.innerHTML = h;
}

/* v113：記住使用者編輯後的清單（靜態池會過時，使用者自訂的才是長期可用的） */
function saveScanPool() {
  try { const ta = document.getElementById('scan-codes'); if (ta) localStorage.setItem('scanPool', ta.value); } catch (e) {}
}
function openScan() {
  const ov = document.getElementById('scan-overlay');
  if (ov) ov.style.display = 'block';
  try {   // v113：沿用上次編輯過的清單（比靜態池可靠，因為你會維護它）
    const saved = localStorage.getItem('scanPool');
    const ta = document.getElementById('scan-codes');
    if (saved && ta && !ta.value.trim()) ta.value = saved;
  } catch (e) {}
}
function closeScan() {
  saveScanPool();
  const ov = document.getElementById('scan-overlay');
  if (ov) ov.style.display = 'none';
}
