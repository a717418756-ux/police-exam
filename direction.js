/* ═══════════════════════════════════════════════════════════════════
   direction.js — 綜合方向卡（v226，T-035）
   ───────────────────────────────────────────────────────────────────
   使用者 11/25：「所有資訊要能整合出一個方向建議」。
   做法：各張卡算完後，把自己的結論（偏多／偏空／中性）丟進來，這裡排成一張表，最上面一句話。

   證據規則（與 config.js 證據等級登記一致，不可放寬）：
     • 方向只取「執行計畫」的那一邊（bingfa.js renderTradeGate：中期因子最強／最弱 20%，A 級；
       沒有中期訊號才退回勢能等級，未回測）。這裡不另外算方向、不投票決定方向。
     • 其餘面向（大盤、匯率、籌碼、基本面、情報、相對強弱）只算「順風／逆風」，標「未回測」，
       不改方向、不改部位。全部偏同一邊也只是背景，不是訊號。
     • 計畫重演的正負號不列入順逆風（T-019：對下一筆沒有預測力）。
   各卡是非同步到的：每次有新的一列就重畫；換股時 dirReset 清空，遲到的舊結果用代碼擋掉。
   ═══════════════════════════════════════════════════════════════════ */
try { (window.SR_FV = window.SR_FV || {})['direction.js'] = 226; } catch (e) {}

const DIR = { code: null, cur: 'TWD', plan: null, rows: {} };
/* 表格列的順序；go＝點了要跳去的卡片 id */
const DIR_ROWS = [
  ['mid', '中期因子', 'bingfa-card'], ['mom', '勢能等級', 'bingfa-card'], ['regime', '市場狀態', 'regime-card'],
  ['rs', '相對強弱', 'rs-card'], ['chip', '法人籌碼', 'chip-card'], ['fund', '營收', 'fundamental-card'],
  ['intel', '新聞情報', 'intel-card'], ['twmkt', '台股大盤', 'market-card'], ['usmkt', '美股大盤', 'market-card'],
  ['macro', '匯率與利率', 'market-card'],
];
const DIR_BASIS = { mid: 1, mom: 1 };   // 方向的依據本身，不重複算進順逆風

function dirReset(code, cur) {
  DIR.code = code; DIR.cur = cur || (/^\d/.test(String(code || '')) ? 'TWD' : 'USD'); DIR.plan = null; DIR.rows = {};
  dirRender();
}
function dirLive(code) { return !!DIR.code && DIR.code === code && (!window._activeCode || window._activeCode === code); }
/* row：{ lean: 1 偏多／-1 偏空／0 中性／null 不分多空, v: 短句, tier: 'A'｜'U'｜'' } */
function dirSet(key, row, code) {
  if (code && !dirLive(code)) return;   // 已換股：丟掉遲到的結果
  if (row) DIR.rows[key] = row; else delete DIR.rows[key];
  dirRender();
}

/* ── 各卡的結論 → 一列。門檻跟原卡片的文字一致，不另訂 ── */
function dirFromPlan(D, ol) {
  if (!D || !dirLive(D.code)) return;
  const { md, sh, planSide } = ol || {};
  DIR.plan = { side: planSide || null, why: md && md.side ? `中期因子${md.side === 'long' ? '最強' : '最弱'} 20%（有回測）` : sh && planSide ? `勢能 ${sh.grade} 級（未回測）` : '' };
  DIR.rows.mid = md ? { lean: md.side === 'long' ? 1 : md.side === 'short' ? -1 : 0, v: md.label || (md.side ? '' : '待定'), tier: 'A' } : D.currency === 'TWD' ? { lean: null, v: '待定', tier: 'A' } : { lean: null, v: '美股沒有中期因子', tier: '' };
  if (sh) {
    const up = sh.grade === 'A' || sh.grade === 'B', dn = sh.shortGrade === 'A' || sh.shortGrade === 'B';
    DIR.rows.mom = { lean: up && !dn ? 1 : dn && !up ? -1 : 0, v: `${sh.grade} 級`, tier: 'U' };
  }
  dirRender();
}
function dirFromRegime(D, r) {
  if (!r) return;
  dirSet('regime', { lean: null, v: r.regime, tier: '' }, D.code);
}
function dirFromRS(D, rs, gapNote) {
  if (gapNote || !rs) return dirSet('rs', { lean: null, v: '暫停（' + String(gapNote || '資料不足').slice(0, 24) + '）', tier: 'U' }, D.code);
  dirSet('rs', { lean: rs.rating >= 70 ? 1 : rs.rating <= 30 ? -1 : 0, v: `${rs.rating} 分`, tier: 'U' }, D.code);
}
function dirFromChip(D) {
  if (D.currency !== 'TWD') return;
  const ch = D.chip;
  if (!ch || !(typeof chipUsable === 'function' && chipUsable(ch)) || ch.foreign5 == null || ch.trust5 == null)
    return dirSet('chip', { lean: null, v: ch ? '資料不完整，不判讀' : '沒拿到', tier: 'U' }, D.code);
  const n = ch.foreign5 + ch.trust5;
  dirSet('chip', { lean: Math.sign(n), v: `外資＋投信 5 日 ${n >= 0 ? '+' : ''}${fmtV(n)} 張`, tier: 'U' }, D.code);
}
function dirFromFund(D, f) {
  if (!f || f.revYoY == null) return dirSet('fund', { lean: null, v: f ? '沒有月營收' : '沒拿到', tier: 'U' }, D.code);
  const y = f.revYoY;   // 門檻同基本面卡：年減 10% 以上偏空、年增 20% 以上偏多
  dirSet('fund', { lean: y >= 20 ? 1 : y <= -10 ? -1 : 0, v: `月營收年增 ${y >= 0 ? '+' : ''}${y.toFixed(1)}%`, tier: 'U' }, D.code);
}
function dirFromIntel(D, v) {
  if (!v) return;
  dirSet('intel', { lean: v.tone === 'bull' ? 1 : v.tone === 'bear' ? -1 : 0, v: String(v.head || '').replace(/<[^>]*>/g, '').slice(0, 40), tier: 'U' }, D.code);
}
function dirFromMarket(D, m) {
  if (!m || !D) return;
  const us = m.us || {}, fx = m.fx || {}, tw = m.tw || {}, sgn = (x, t) => x == null ? 0 : x > t ? 1 : x < -t ? -1 : 0;
  if (D.currency === 'TWD') {
    const bw = tw.breadth;
    if (bw && bw.total) {
      const up = Math.round(bw.up / bw.total * 100);
      dirSet('twmkt', { lean: up >= 60 ? 1 : up <= 40 ? -1 : 0, v: `類股 ${up}% 上漲${tw.index && tw.index.changePct != null ? `、加權 ${tw.index.changePct >= 0 ? '+' : ''}${tw.index.changePct.toFixed(2)}%` : ''}`, tier: 'U' }, D.code);
    } else dirSet('twmkt', { lean: null, v: '沒拿到', tier: 'U' }, D.code);
  }
  const nas = us.nasdaq && us.nasdaq.changePct, sox = us.sox && us.sox.changePct;
  if (nas != null || sox != null) {
    const a = [nas, sox].filter(x => x != null), avg = a.reduce((s, x) => s + x, 0) / a.length;
    dirSet('usmkt', { lean: sgn(avg, 0.5), v: `${sox != null ? `費半 ${sox >= 0 ? '+' : ''}${sox.toFixed(1)}%` : ''}${sox != null && nas != null ? '、' : ''}${nas != null ? `那指 ${nas >= 0 ? '+' : ''}${nas.toFixed(1)}%` : ''}`, tier: 'U' }, D.code);
  }
  /* 匯率與利率：美元走強、殖利率走高＝對股市逆風（大盤卡的「總體逆風」同一套說法）；台股另看台幣 */
  const parts = [], pts = [];
  if (D.currency === 'TWD' && fx.usdtwd && fx.usdtwd.changePct != null) { pts.push(-sgn(fx.usdtwd.changePct, 0.2)); parts.push(`台幣${fx.usdtwd.changePct > 0 ? '貶' : '升'} ${Math.abs(fx.usdtwd.changePct).toFixed(2)}%`); }
  if (us.dxy && us.dxy.changePct != null) { pts.push(-sgn(us.dxy.changePct, 0.3)); parts.push(`美元指數 ${us.dxy.changePct >= 0 ? '+' : ''}${us.dxy.changePct.toFixed(2)}%`); }
  if (us.tnx && us.tnx.changePct != null) { pts.push(-sgn(us.tnx.changePct, 0.8)); parts.push(`美債 ${tnxPct(us.tnx.price).toFixed(2)}%`); }
  if (pts.length) dirSet('macro', { lean: Math.sign(pts.reduce((s, x) => s + x, 0)), v: parts.join('、'), tier: 'U' }, D.code);
}

/* ── 結論句：方向只看計畫；其他列算順風／逆風 ── */
function dirSummary() {
  const side = DIR.plan && DIR.plan.side, s = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  const ctx = Object.keys(DIR.rows).filter(k => !DIR_BASIS[k] && DIR.rows[k].lean != null);
  const name = k => (DIR_ROWS.find(r => r[0] === k) || [k, k])[1];
  const bull = ctx.filter(k => DIR.rows[k].lean > 0), bear = ctx.filter(k => DIR.rows[k].lean < 0);
  if (!DIR.plan) return { tone: 'wait', head: '分析中…', sub: '' };
  if (!s) {
    const lean = bull.length > bear.length ? '偏多' : bear.length > bull.length ? '偏空' : '分歧';
    return { tone: 'wait', head: '觀望：沒有已回測的方向訊號',
      sub: ctx.length ? `背景 ${bull.length} 項偏多、${bear.length} 項偏空（${lean}）——未回測，只當參考，不構成進場理由` : '' };
  }
  const withK = s > 0 ? bull : bear, against = s > 0 ? bear : bull;
  const head = `${s > 0 ? '偏多（做多試單）' : '偏空（做空試單）'}：依${DIR.plan.why || '執行計畫'}`;
  let sub = `順風 ${withK.length} 項${withK.length ? '（' + withK.map(name).join('、') + '）' : ''}；逆風 ${against.length} 項${against.length ? '（' + against.map(name).join('、') + '）' : ''}`;
  if (against.length >= withK.length + 2) sub += '——逆風明顯較多，照計畫只用試單部位、嚴守停損';
  return { tone: s > 0 ? 'bull' : 'bear', head, sub: sub + '。順逆風未回測，不改方向與部位' };
}

function dirRender() {
  const el = document.getElementById('vb-dir');
  if (!el) return;
  if (!DIR.code) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const sm = dirSummary();
  const col = sm.tone === 'bull' ? 'var(--buy)' : sm.tone === 'bear' ? 'var(--sell)' : 'var(--muted)';
  const rows = DIR_ROWS.filter(([k]) => DIR.rows[k]).map(([k, label, go]) => {
    const r = DIR.rows[k];
    const arrow = r.lean == null ? '<span class="dir-ar dir-na">·</span>' : r.lean > 0 ? '<span class="dir-ar dir-up">▲</span>' : r.lean < 0 ? '<span class="dir-ar dir-dn">▼</span>' : '<span class="dir-ar dir-flat">■</span>';
    const tier = r.tier === 'A' ? '<span class="dir-tier dir-a">回測</span>' : r.tier === 'U' ? '<span class="dir-tier">未回測</span>' : '';
    return `<button type="button" class="dir-row" onclick="dirGo('${go}')">${arrow}<span class="dir-k">${label}</span><span class="dir-v">${escI(r.v || '')}</span>${tier}</button>`;
  }).join('');
  el.innerHTML = `<div class="dir-head" style="border-left-color:${col}">
      <div class="dir-title" style="color:${col}">🧭 ${escI(sm.head)}</div>
      ${sm.sub ? `<div class="dir-sub">${escI(sm.sub)}</div>` : ''}
    </div>
    ${rows ? `<div class="dir-grid">${rows}</div>` : ''}
    <div class="dir-foot">▲ 偏多　▼ 偏空　■ 中性　· 不分多空｜點一列看細節｜資料陸續載入中會自動更新</div>`;
  el.style.display = 'block';
}

/* 點一列：切到那張卡所在的分頁並捲過去 */
function dirGo(cardId) {
  try {
    const t = typeof TABS !== 'undefined' ? TABS.find(x => x.cards.includes(cardId)) : null;
    if (t && typeof switchTab === 'function') switchTab(t.id);
    const c = document.getElementById(cardId);
    if (!c) return;
    /* switchTab 會先平滑捲到分頁頂端，距離長時要 1 秒左右；中途再捲會被它蓋掉。
       等捲動結束（scrollend）再跳；不支援 scrollend 或根本沒捲動時，1.2 秒後補跳一次 */
    let done = false;
    const go = () => { if (done) return; done = true; c.scrollIntoView({ block: 'start' }); };
    window.addEventListener('scrollend', go, { once: true });
    setTimeout(go, 1200);
  } catch (e) {}
}
