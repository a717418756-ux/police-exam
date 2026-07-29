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
let _scanAbort = false;

/* 單檔條件評估：回傳通過的條件與未通過的原因（dir: -1做空 / 1做多）*/
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
async function runScan() {
  const raw = document.getElementById('scan-codes').value || '';
  const codes = raw.split(/[\s,，、]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const dir = document.getElementById('scan-dir').value === 'short' ? -1 : 1;
  const box = document.getElementById('scan-result');
  if (!codes.length) { box.innerHTML = '<div style="color:var(--warn);font-size:12px">請先輸入股票代碼（空白或逗號分隔）</div>'; return; }
  if (codes.length > 60) { box.innerHTML = '<div style="color:var(--warn);font-size:12px">一次最多60檔（避免後端負擔過重與等待過久）</div>'; return; }

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
      for (const item of (j.results || [])) {
        if (!item.ok) { rows.push({ code: item.code, err: true }); continue; }
        const D = {
          code: item.code, currency: /^\d{4,6}$/.test(item.code) ? 'TWD' : 'USD',
          closes: item.closes, highs: item.highs, lows: item.lows, volumes: item.volumes,
          opens: item.opens || undefined, price: item.price, lastDate: item.lastDate,
          rawCloses: item.closes, rawHighs: item.highs, rawLows: item.lows,
        };
        const ev = evalScanConditions(D, dir);
        rows.push({ code: item.code, price: item.price, ...ev });
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
  const good = rows.filter(r => !r.err).sort((a, b) => b.score - a.score);
  const errs = rows.filter(r => r.err);
  const dirTxt = dir === -1 ? '做空' : '做多';
  let h = `<div style="font-size:11px;color:var(--muted);margin-bottom:8px">
    ${dirTxt}條件掃描完成｜${good.length} 檔有效${errs.length ? ` / ${errs.length} 檔失敗` : ''}｜耗時 ${secs} 秒
    <div style="font-size:10px;color:var(--muted2);margin-top:4px">依「通過條件數 − 未通過數」排序。<b>這不是漲跌預測</b>——19年7,908事件已證方向不可測；此處排的是「目前進場的條件結構」，最終仍須逐檔開啟完整分析與紀律門確認。</div>
  </div>`;

  if (!good.length) h += '<div style="font-size:12px;color:var(--warn)">沒有成功取得資料的股票</div>';

  good.forEach(r => {
    const col = r.score >= 3 ? 'var(--buy)' : r.score >= 1 ? 'var(--warn)' : 'var(--muted)';
    h += `<div style="border:1px solid ${col}40;border-radius:8px;padding:9px 11px;margin-bottom:7px;background:${col}08">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
        <span style="font-size:13px;font-weight:700">${r.code} <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${r.price != null ? fmt(r.price) : ''}</span></span>
        <span style="font-size:11px;font-weight:700;color:${col}">條件 +${r.pass.length} / −${r.fail.length}</span>
      </div>
      ${r.pass.map(p => `<div style="font-size:10px;color:var(--buy);line-height:1.5">✓ ${p}</div>`).join('')}
      ${r.fail.map(f => `<div style="font-size:10px;color:var(--sell);line-height:1.5">✗ ${f}</div>`).join('')}
      <div style="margin-top:5px"><button onclick="document.getElementById('code').value='${r.code}';closeScan();go();" style="font-size:10px;padding:3px 9px;border-radius:5px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer">開啟完整分析 →</button></div>
    </div>`;
  });

  if (errs.length) h += `<div style="font-size:10px;color:var(--muted2);margin-top:6px">取得失敗：${errs.map(e => e.code).join('、')}（代碼錯誤、非上市櫃、或資料不足60日）</div>`;
  box.innerHTML = h;
}

function openScan() {
  const ov = document.getElementById('scan-overlay');
  if (ov) ov.style.display = 'block';
}
function closeScan() {
  const ov = document.getElementById('scan-overlay');
  if (ov) ov.style.display = 'none';
}
