/* ═══════════════════════════════════════════════════════════════════
   direction.js — 綜合方向卡（v226，T-035）
   ───────────────────────────────────────────────────────────────────
   使用者 11/25：「所有資訊要能整合出一個方向建議」。
   做法：各張卡算完後，把自己的結論（偏多／偏空／中性）丟進來，這裡排成一張表，最上面一句話。

   證據規則（與 config.js 證據等級登記一致，不可放寬）：
     • 方向只取「執行計畫」的那一邊（bingfa.js renderTradeGate：中期因子最強／最弱 20%，A 級；
       v230 起沒有中期訊號就觀望，勢能等級不再當備用方向，台股、美股都一樣）。這裡不另外算方向、不投票決定方向。
     • 其餘面向（大盤、匯率、籌碼、基本面、情報、相對強弱）只算「順風／逆風」，標「未回測」，
       不改方向、不改部位。全部偏同一邊也只是背景，不是訊號。
     • 計畫重演的正負號不列入順逆風（T-019：對下一筆沒有預測力）。
   各卡是非同步到的：每次有新的一列就重畫；換股時 dirReset 清空，遲到的舊結果用代碼擋掉。
   ═══════════════════════════════════════════════════════════════════ */
try { (window.SR_FV = window.SR_FV || {})['direction.js'] = 230; } catch (e) {}

const DIR = { code: null, cur: 'TWD', plan: null, rows: {}, ai: null };
/* 表格列的順序；go＝點了要跳去的卡片 id */
const DIR_ROWS = [
  ['mid', '中期因子', 'bingfa-card'], ['mom', '勢能等級', 'bingfa-card'], ['regime', '市場狀態', 'regime-card'],
  ['rs', '相對強弱', 'rs-card'], ['chip', '法人籌碼', 'chip-card'], ['fund', '營收', 'fundamental-card'],
  ['intel', '新聞情報', 'intel-card'], ['twmkt', '台股大盤', 'market-card'], ['usmkt', '美股大盤', 'market-card'],
  ['macro', '匯率與利率', 'market-card'],
];
const DIR_BASIS = { mid: 1 };   // 方向的依據本身，不重複算進順逆風（v230 勢能不再是依據，改列背景）

function dirReset(code, cur) {
  DIR.code = code; DIR.cur = cur || (/^\d/.test(String(code || '')) ? 'TWD' : 'USD'); DIR.plan = null; DIR.rows = {}; DIR.ai = null;
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
  const { md, sh, planSide, mid } = ol || {};
  DIR.plan = { side: planSide || null, why: planSide && md ? `中期因子${md.side === 'long' ? '最強' : '最弱'} 20%（有回測）` : '',
    none: planSide ? '' : typeof midWhy === 'function' ? midWhy(D.currency, mid, md) : '' };   // v230 觀望時講原因
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
/* v229 Gemini 併進摘要：只放後端已驗證過引用的那一句（worker validateAI：引用不存在的條目已剔除），
   優先用「下一個交易日該注意什麼」；AI 沒成功就不放，不拿程式文字冒充 AI */
function dirFromIntel(D, v, j) {
  if (!v || !D || !dirLive(D.code)) return;
  const ai = j && j.ai, txt = ai && ai.status === 'ok' ? ai.outlook || ai.summary : '';
  DIR.ai = txt ? { html: citeI(txt, j.items || []), outlook: !!ai.outlook } : null;
  dirSet('intel', { lean: v.tone === 'bull' ? 1 : v.tone === 'bear' ? -1 : 0, v: String(v.head || '').replace(/<[^>]*>/g, '').slice(0, 40), tier: 'U' }, D.code);
}
/* v229 資料日：開盤前或對方市場還沒開時，報價是上一個交易日的——不是今天就標日期；台股盤中標「盤中」 */
function dirToday() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''); }
function dirTag(d, liveOk) {
  const y = mktYmd(d);
  if (!y) return '';
  if (y !== dirToday()) return `（${mktMD(y)}）`;
  return liveOk && inSession(Date.now(), ...SESS.tw) ? '（盤中）' : '';
}
function dirFromMarket(D, m) {
  if (!m || !D) return;
  const us = m.us || {}, fx = m.fx || {}, tw = m.tw || {}, sgn = (x, t) => x == null ? 0 : x > t ? 1 : x < -t ? -1 : 0;
  if (D.currency === 'TWD') {
    /* v229 類股廣度是前一交易日收盤後公布的，盤中的加權已經是今天的。兩者日期不同時，傾向看比較新的加權漲跌
       （±0.5%，與美股同門檻），不拿昨天的廣度當今天的順風（11/25 實測：廣度 97% 上漲是 11/24，當天盤中加權 −4.9%） */
    const bw = tw.breadth, ix = tw.index, bd = bw && bw.total ? mktYmd(bw.date) : '';
    const up = bw && bw.total ? Math.round(bw.up / bw.total * 100) : null, ic = ix && ix.changePct != null ? ix.changePct : null;
    const parts = [];
    if (ic != null) parts.push(`加權 ${ic >= 0 ? '+' : ''}${ic.toFixed(2)}%${dirTag(ix.date, true)}`);
    if (up != null) parts.push(`類股 ${up}% 上漲${dirTag(bw.date)}`);
    const lean = ic != null && ix.date && (!bd || ix.date > bd) ? sgn(ic, 0.5) : up != null ? (up >= 60 ? 1 : up <= 40 ? -1 : 0) : ic != null ? sgn(ic, 0.5) : null;
    dirSet('twmkt', parts.length ? { lean, v: parts.join('、'), tier: 'U' } : { lean: null, v: '沒拿到', tier: 'U' }, D.code);
  }
  const nas = us.nasdaq && us.nasdaq.changePct, sox = us.sox && us.sox.changePct;
  if (nas != null || sox != null) {
    const a = [nas, sox].filter(x => x != null), avg = a.reduce((s, x) => s + x, 0) / a.length;
    dirSet('usmkt', { lean: sgn(avg, 0.5), v: `${sox != null ? `費半 ${sox >= 0 ? '+' : ''}${sox.toFixed(1)}%` : ''}${sox != null && nas != null ? '、' : ''}${nas != null ? `那指 ${nas >= 0 ? '+' : ''}${nas.toFixed(1)}%` : ''}${dirTag((us.sox || us.nasdaq).date)}`, tier: 'U' }, D.code);
  }
  /* 匯率與利率：美元走強、殖利率走高＝對股市逆風（大盤卡的「總體逆風」同一套說法）；台股另看台幣 */
  const parts = [], pts = [];
  if (D.currency === 'TWD' && fx.usdtwd && fx.usdtwd.changePct != null) { pts.push(-sgn(fx.usdtwd.changePct, 0.2)); parts.push(`台幣${fx.usdtwd.changePct > 0 ? '貶' : '升'} ${Math.abs(fx.usdtwd.changePct).toFixed(2)}%`); }
  if (us.dxy && us.dxy.changePct != null) { pts.push(-sgn(us.dxy.changePct, 0.3)); parts.push(`美元指數 ${us.dxy.changePct >= 0 ? '+' : ''}${us.dxy.changePct.toFixed(2)}%`); }
  if (us.tnx && us.tnx.changePct != null) { pts.push(-sgn(us.tnx.changePct, 0.8)); parts.push(`美債 ${tnxPct(us.tnx.price).toFixed(2)}%`); }
  if (pts.length) dirSet('macro', { lean: Math.sign(pts.reduce((s, x) => s + x, 0)), v: parts.join('、'), tier: 'U' }, D.code);
}

/* ── 結論：方向只看計畫；其他列只分「支持／反對」兩行並附數值，讓使用者自己判斷（v229 使用者：不要丟很多結果） ── */
function dirSummary() {
  const side = DIR.plan && DIR.plan.side, s = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  const ctx = DIR_ROWS.map(r => r[0]).filter(k => DIR.rows[k] && !DIR_BASIS[k] && DIR.rows[k].lean != null);
  const bull = ctx.filter(k => DIR.rows[k].lean > 0), bear = ctx.filter(k => DIR.rows[k].lean < 0);
  if (!DIR.plan) return { tone: 'wait', head: '分析中…', why: '', pro: [], con: [], proL: '', conL: '', note: '' };
  if (!s) return { tone: 'wait', head: '觀望', why: DIR.plan.none || '沒有回測過的方向訊號', pro: bull, con: bear, proL: '偏多的背景', conL: '偏空的背景',
    note: '背景因子未回測，只供參考，不構成進場理由' };
  const withK = s > 0 ? bull : bear, against = s > 0 ? bear : bull;
  return { tone: s > 0 ? 'bull' : 'bear', head: s > 0 ? '做多試單' : '做空試單', why: `依${DIR.plan.why || '執行計畫'}`,
    pro: withK, con: against, proL: '順風', conL: '逆風',
    note: (against.length >= withK.length + 2 ? '逆風明顯較多：只用試單部位、嚴守停損。' : '') + '順逆風未回測，不改方向與部位' };
}

function dirRender() {
  const el = document.getElementById('vb-dir');
  if (!el) return;
  if (!DIR.code) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const sm = dirSummary();
  const col = sm.tone === 'bull' ? 'var(--buy)' : sm.tone === 'bear' ? 'var(--sell)' : 'var(--muted)';
  const name = k => (DIR_ROWS.find(r => r[0] === k) || [k, k])[1];
  const line = (lab, ks, c) => lab ? `<div class="dir-pc"><b style="color:${c}">${lab}</b>${ks.length
    ? ks.map(k => `<span class="dir-it">${name(k)} <span class="dir-iv">${escI(DIR.rows[k].v || '')}</span></span>`).join('')
    : '<span class="dir-it dir-none">無</span>'}</div>` : '';
  const proC = sm.tone === 'bear' ? 'var(--sell)' : 'var(--buy)', conC = sm.tone === 'bear' ? 'var(--buy)' : 'var(--sell)';
  const keys = DIR_ROWS.filter(([k]) => DIR.rows[k]);
  const rows = keys.map(([k, label, go]) => {
    const r = DIR.rows[k];
    const arrow = r.lean == null ? '<span class="dir-ar dir-na">·</span>' : r.lean > 0 ? '<span class="dir-ar dir-up">▲</span>' : r.lean < 0 ? '<span class="dir-ar dir-dn">▼</span>' : '<span class="dir-ar dir-flat">■</span>';
    const tier = r.tier === 'A' ? '<span class="dir-tier dir-a">回測</span>' : r.tier === 'U' ? '<span class="dir-tier">未回測</span>' : '';
    return `<button type="button" class="dir-row" onclick="dirGo('${go}')">${arrow}<span class="dir-k">${label}</span><span class="dir-v">${escI(r.v || '')}</span>${tier}</button>`;
  }).join('');
  let open = false; try { open = localStorage.getItem('sr_dir_more') === '1'; } catch (e) {}
  el.innerHTML = `<div class="dir-head" style="border-left-color:${col}">
      <div class="dir-title" style="color:${col}">🧭 ${escI(sm.head)}${sm.why ? `<span class="dir-why">${escI(sm.why)}</span>` : ''}</div>
    </div>
    ${line(sm.proL, sm.pro, proC)}${line(sm.conL, sm.con, conC)}
    ${DIR.ai ? `<div class="dir-ai"><b>📰 消息面</b><span class="dir-src">Gemini 整理新聞・${DIR.ai.outlook ? '下一個交易日' : '近一週'}・未回測</span><div>${DIR.ai.html}</div></div>` : ''}
    ${sm.note ? `<div class="dir-note">${escI(sm.note)}</div>` : ''}
    ${rows ? `<details class="dir-more"${open ? ' open' : ''} ontoggle="try{localStorage.setItem('sr_dir_more',this.open?'1':'0')}catch(e){}"><summary>全部 ${keys.length} 項依據（點一列看細節）</summary>
      <div class="dir-grid">${rows}</div>
      <div class="dir-foot">▲ 偏多　▼ 偏空　■ 中性　· 不分多空｜資料陸續載入中會自動更新</div></details>` : ''}`;
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
