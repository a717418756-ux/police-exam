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

const SCAN_BATCH = 15;          // 每批檔數（後端上限20，留餘裕）

/* ── 內建掃描池（v111）─────────────────────────────────────────────────
   使用者要的是「按一鍵就給代碼」，不必自己貼清單。此池以台灣50＋中型100
   的主要成分為骨幹（約120檔）：流動性佳＝借券/融券容易、滑價小，正是
   短線與做空唯一可行的區間。小型冷門股刻意排除（借不到券、滑價吃掉利潤）。
   ⚠️ 這是「候選池」不是「推薦清單」——池子只決定掃描範圍，篩選仍由
      條件引擎逐檔判定。
   ⚠️ 靜態清單必然會過時（成分股調整、下市、合併）。已知下市者已移除
      （1704榮化2019下市、2888新光金2025合併），但未來仍會有。掃描時
      抓不到資料的會顯示「失敗」，此時自行從輸入框刪掉即可；你編輯後的
      清單會自動記住（localStorage），下次打開沿用。
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

  // ① 環境順風（順勢原則，19年結構性證據：逆環境操作是最常見死法）
  if (regime) {
    if (regime.regime === '高波動危險') fail.push('高波動危險態');
    else if ((dir === -1 && regime.regime === '空頭趨勢') || (dir === 1 && regime.regime === '多頭趨勢')) pass.push(`環境順風（${regime.regime}）`);
    else if (regime.regime === '盤整') fail.push('盤整態（波段勝率低）');
    else fail.push(`環境逆風（${regime.regime}）`);
  }
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
async function runScanAuto(dirStr) {
  const ta = document.getElementById('scan-codes');
  if (ta) ta.value = TW_POOL.join(' ');          // 自動填入內建池
  const sel = document.getElementById('scan-dir');
  if (sel) sel.value = dirStr;                    // 同步方向
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
  if (codes.length > 130) { box.innerHTML = '<div style="color:var(--warn);font-size:12px">一次最多130檔（避免後端負擔過重與等待過久）</div>'; return; }

  saveScanPool();   // v113：掃描前存檔（使用者常編輯後直接掃，不關面板）
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
      const r = await fetchT(`${GAS_URL}?action=scan&codes=${encodeURIComponent(batch.join(','))}`, {}, 60000);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '後端錯誤');
      if (!Array.isArray(j.results)) throw new Error('後端無 results 欄位——你的後端（Cloudflare Worker / GAS）可能尚未更新到含 scan 端點的版本，請重新部署 worker.js 或 Code.gs');
      for (const item of (j.results || [])) {
        if (!item.ok) { rows.push({ code: item.code, err: true }); continue; }
        const D = {
          code: item.code, currency: /^\d{4,6}$/.test(item.code) ? 'TWD' : 'USD',
          closes: item.closes, highs: item.highs, lows: item.lows, volumes: item.volumes,
          opens: item.opens || undefined, price: item.price, lastDate: item.lastDate,
          rawCloses: item.closes, rawHighs: item.highs, rawLows: item.lows,
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

  document.getElementById('scan-run').disabled = false;
  document.getElementById('scan-stop').style.display = 'none';
  renderScanResult(rows, dir, ((Date.now() - t0) / 1000).toFixed(0));
}

function stopScan() { _scanAbort = true; }

function renderScanResult(rows, dir, secs) {
  const box = document.getElementById('scan-result');
  const good = rows.filter(r => !r.err && !r.filtered).sort((a, b) => b.score - a.score);
  const errs = rows.filter(r => r.err);
  const filt = rows.filter(r => r.filtered);   // v112：前置門檻擋掉的（流動性/炒作/波動）
  const dirTxt = dir === -1 ? '做空' : '做多';
  let h = `<div style="font-size:11px;color:var(--muted);margin-bottom:8px">
    ${dirTxt}條件掃描完成｜${good.length} 檔通過前置${filt.length ? ` / ${filt.length} 檔被門檻擋下` : ''}${errs.length ? ` / ${errs.length} 檔失敗` : ''}｜耗時 ${secs} 秒
    <div style="font-size:10px;color:var(--muted2);margin-top:4px">依「通過條件數 − 未通過數」排序。<b>這不是漲跌預測</b>——19年7,908事件已證方向不可測；此處排的是「目前進場的條件結構」，最終仍須逐檔開啟完整分析與紀律門確認。</div>
  </div>`;

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
      <div style="margin-top:5px"><button onclick="document.getElementById('code').value='${r.code}';closeScan();go();" style="font-size:10px;padding:3px 9px;border-radius:5px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer">開啟完整分析 →</button></div>
    </div>`;
  });

  if (errs.length) h += `<div style="font-size:10px;color:var(--muted2);margin-top:6px">取得失敗：${errs.map(e => e.code).join('、')}（代碼錯誤、非上市櫃、或資料不足60日）</div>`;
  if (filt.length) {
    /* v113 防禦：若「成交額不足」佔了絕大多數，比較可能是資料單位或後端版本問題，
       而不是這些熱門股真的都沒量——寧可提示使用者查證，也不要默默把全部擋光。 */
    const liqFail = filt.filter(f => f.why && f.why.indexOf('成交額') >= 0).length;
    const totalScanned = good.length + filt.length;
    if (totalScanned >= 10 && liqFail / totalScanned > 0.7) {
      h += `<div style="margin-top:10px;padding:8px 10px;background:var(--warn)10;border:1px solid var(--warn);border-radius:8px;font-size:10px;color:var(--muted);line-height:1.6">
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
