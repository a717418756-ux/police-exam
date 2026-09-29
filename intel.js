/* ══════════════════════════════════════════════════════════════════════
   intel.js — 情報面（v168）
   ──────────────────────────────────────────────────────────────────
   取代人工流程：讀新聞、看PTT、查重大訊息 → 再去比對股價與法人有沒有跟上。
   後端負責蒐集、AI歸納事件、事件研究；這裡負責「比對」與呈現。

   比對的核心問題不是「會不會漲」，而是「這個消息，市場買不買單？」
     • 資訊傾向（tilt）：AI 歸納的事件方向，依強度×信心×時間衰減加權
     • 價格反應（CAR/SCAR）：市場模型的累積異常報酬及其顯著性
     • 法人：外資＋投信近5日淨買賣
   三者一致＝共振；不一致＝背離。背離本身就是資訊（利多不漲、利空不跌）。

   ⚠️ EVIDENCE tier U：未經回測，只顯示不計分。任何分數或紀律門都不讀這裡的結果。
   ══════════════════════════════════════════════════════════════════════ */
try { (window.SR_FV = window.SR_FV || {})['intel.js'] = 182; } catch (e) {}

/* 條目標題來自新聞與PTT（任何人都能發文），一律完整跳脫再進 innerHTML。
   不用 layout.js 的 esc：那支是「刪掉」特殊字元，會把「台積電 & 蘋果」弄成「台積電  蘋果」。 */
const escI = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? escI(u) : '';
const pctI = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
const tpI = t => { const d = new Date(t + 8 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const SIG = 1.96;   // |SCAR| 門檻（雙尾 5%）
// 內文的 [n] 換成可點的來源連結；指向不存在條目的引用直接拿掉
const citeI = (s, items) => escI(s).replace(/\[(\d+)\]/g, (m, n) => { const it = items[+n], u = it && safeUrl(it.url);
  return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer" style="color:var(--acc);text-decoration:none;font-size:.85em;vertical-align:super">[${+n + 1}]</a>` : ''; });
const TILT_MIN = 0.25;

/* ── 判讀：資訊傾向 × 價格反應 × 法人 ── */
function intelVerdict(j, D) {
  const notes = [];
  const main = (j.events || []).filter(e => e.study && e.type !== '股價走勢報導')
    .sort((a, b) => b.mag * b.conf - a.mag * a.conf)[0];
  const st = main && main.study, ok = st && st.status === 'ok';
  const sig = ok && Math.abs(st.scar) >= SIG;
  const reaction = !st ? '' : st.status === 'pending' ? '消息在最後一根K棒之後，市場尚未交易'
    : st.status !== 'ok' ? '歷史資料不足，無法做事件研究'
    : `CAR ${pctI(st.car)}（${st.L}日，SCAR ${st.scar.toFixed(1)}，${sig ? '統計顯著' : '不顯著'}）`;
  const ch = D && D.chip;
  // v182：用全站同一個「籌碼可用」標準；外資、投信兩個都要有值才加總（缺一個不可當 0）
  const inst = chipUsable(ch) && (ch.n5 == null || ch.n5 >= 3) && ch.foreign5 != null && ch.trust5 != null ? ch.foreign5 + ch.trust5 : null;
  const instS = inst == null ? 0 : Math.sign(inst);

  if (ok && Math.abs(st.preScar) >= SIG) notes.push(`⚠️ 消息公布前5日已有顯著異常報酬 ${pctI(st.pre)}——消息可能早已被交易，公布後的反應會被低估`);
  const p = j.attention && j.attention.ptt;
  if (p && p.bull + p.bear >= 5) {
    const sh = Math.max(p.bull, p.bear) / (p.bull + p.bear);
    if (sh >= 0.8) notes.push(`PTT［標的］${p.bull >= p.bear ? '看多' : '看空'} ${(sh * 100).toFixed(0)}%（${p.bull + p.bear}篇）——情緒一面倒屬「擁擠」風險，不是方向訊號`);
  }
  /* v175 熱度依交易日歸戶（後端 heat()）：暴增＝最新交易日或「收盤後累積中」≥ 3 則且 ≥ 3× 先前交易日中位數 */
  const nw = j.attention && j.attention.news;
  if (nw && nw.saturated) notes.push('新聞量已達來源上限，無法判斷熱度趨勢（熱門股常見）');
  else if (nw && nw.med != null && Array.isArray(nw.series) && nw.series.length) {   // 舊版後端（v174 以前）沒有 series，不可崩
    const bar = Math.max(nw.med, 1) * 3, last = nw.series[nw.series.length - 1];
    if (nw.pending >= 3 && nw.pending >= bar) notes.push(`新聞熱度暴增：收盤後已累積 ${nw.pending} 則（將影響下一個交易日），為先前交易日中位數的 ${(nw.pending / Math.max(nw.med, 1)).toFixed(1)} 倍——預期波動放大`);
    else if (last.n >= 3 && last.n >= bar) notes.push(`新聞熱度暴增：${last.d.slice(4, 6)}/${last.d.slice(6)} 當日 ${last.n} 則，為先前交易日中位數的 ${(last.n / Math.max(nw.med, 1)).toFixed(1)} 倍——預期波動放大`);
  }
  if (j.tilt && j.tilt.conflict >= 0.35) notes.push(`事件方向分歧（少數方權重 ${(j.tilt.conflict * 100).toFixed(0)}%）`);

  if (j.ai.status !== 'ok') {
    return { tone: 'neutral', notes, head: main ? `重大訊息「${main.title}」：${reaction}` : '近7日無重大訊息', sub: 'AI 未啟用，無法判讀新聞與PTT的方向，只能回答市場對官方公告有沒有反應' };
  }
  const T = j.tilt ? j.tilt.tilt : 0, dir = T >= TILT_MIN ? 1 : T <= -TILT_MIN ? -1 : 0, word = dir > 0 ? '多' : '空';
  if (!dir) return { tone: 'neutral', notes, head: j.tilt && j.tilt.conflict >= 0.35 ? '資訊面多空分歧' : '資訊面中性，無明確方向的事件', sub: main ? `主要事件「${main.title}」：${reaction}` : '' };
  const lead = `資訊面偏${word}（傾向 ${T > 0 ? '+' : ''}${T.toFixed(2)}）`;
  if (!ok) return { tone: 'info', notes, head: `${lead}；${reaction || '無可做事件研究的事件'}`, sub: main ? `主要事件：${main.title}` : '' };
  const sub = `主要事件「${main.title}」：${reaction}`;
  if (sig && Math.sign(st.car) === dir) {
    if (instS === -dir) return { tone: 'warn', notes, sub, head: dir > 0 ? '利多已反映，但法人反手賣超——留意利多出盡' : '利空已反映，但法人逆勢買超——留意賣壓竭盡' };
    return { tone: dir > 0 ? 'bull' : 'bear', notes, sub, head: `共振：利${word}已被市場確認${instS === dir ? '，法人同向' : ''}` };
  }
  if (sig) return { tone: 'warn', notes, sub, head: dir > 0 ? '背離：資訊偏多但股價顯著走弱——市場不買單，或有尚未揭露的利空' : '背離：資訊偏空但股價顯著走強——利空不跌' };
  return { tone: 'info', notes, sub, head: `${lead}，股價尚未顯著反應${instS === dir ? '；法人已同向布局' : instS === -dir ? '；法人反向操作' : ''}` };
}

function renderIntel(j, D) {
  const v = intelVerdict(j, D);
  const C = { bull: 'var(--buy)', bear: 'var(--sell)', warn: 'var(--warn)', info: 'var(--acc)', neutral: 'var(--muted)' }[v.tone];
  const cite = s => citeI(s, j.items);
  const aiLine = {
    ok: j.ai.summary ? `<div style="font-size:12px;line-height:1.7;margin:10px 0">${cite(j.ai.summary)}</div>` : '',
    'no-key': '<div style="font-size:11px;color:var(--muted);margin:10px 0">AI 歸納未啟用：後端尚未設定 GEMINI_KEY（Cloudflare：Settings → Variables and Secrets；GAS：專案設定 → 指令碼屬性）。下方仍列出原始條目與官方公告的市場反應。</div>',
    'no-items': '<div style="font-size:11px;color:var(--muted);margin:10px 0">近7日沒有可歸納的條目。</div>',
    error: `<div style="font-size:11px;color:var(--warn);margin:10px 0">⚠️ AI 歸納失敗：${escI(j.ai.why)}——下方仍列出原始條目。</div>`,
  }[j.ai.status] || '';
  const DIR = { 1: ['▲', 'var(--buy)'], '-1': ['▼', 'var(--sell)'], 0: ['●', 'var(--muted)'] };
  const kindName = { news: '新聞', intl: '國際', social: '社群', ptt: 'PTT', mops: '公告', rev: '月營收' };
  const evRows = (j.events || []).map(e => {
    const trend = e.type === '股價走勢報導';   // 價格的結果，不計入方向——畫面上也不能用漲跌箭頭暗示它是訊號
    const [ar, col] = trend ? ['○', 'var(--muted2)'] : DIR[e.dir] || DIR[0], st = e.study;
    const kinds = {}; e.ids.forEach(i => { const k = j.items[i] && j.items[i].kind; if (k) kinds[k] = (kinds[k] || 0) + 1; });
    const react = !st ? '' : st.status === 'pending' ? '市場尚未交易' : st.status !== 'ok' ? '資料不足'
      : `CAR <b style="color:${Math.abs(st.scar) >= SIG ? (st.car > 0 ? 'var(--buy)' : 'var(--sell)') : 'var(--muted)'}">${pctI(st.car)}</b>（SCAR ${st.scar.toFixed(1)}${Math.abs(st.scar) >= SIG ? '，顯著' : ''}）${Math.abs(st.preScar) >= SIG ? `・事前 ${pctI(st.pre)}` : ''}`;
    return `<div style="padding:8px 0;border-top:1px solid var(--bd)">
      <div style="display:flex;gap:8px;align-items:baseline"><span style="color:${col};font-weight:800">${ar}</span>
        <span style="flex:1;font-size:12px;font-weight:600">${escI(e.title)}</span>
        <span style="font-size:10px;color:var(--muted2);white-space:nowrap">${escI(e.type)}${trend ? '・不計入方向' : e.dir || e.type !== '重大訊息' ? `・強度${e.mag}` : ''}</span></div>
      <div style="font-size:10px;color:var(--muted);margin-top:3px;padding-left:18px;line-height:1.6">
        首見 ${tpI(e.first)}・${Object.keys(kinds).map(k => `${kindName[k] || k}×${kinds[k]}`).join(' ')}${e.conf != null && j.ai.status === 'ok' ? `・信心 ${(e.conf * 100).toFixed(0)}%` : ''}${react ? `<br>${react}` : ''}</div></div>`;
  }).join('');
  const nw = j.attention && j.attention.news, pt = j.attention && j.attention.ptt;
  const att = [
    nw ? (nw.saturated ? `新聞 7日 ≥${nw.n} 則（已達上限）` : `新聞 7日 ${nw.n} 則${nw.trend ? `・熱度${nw.trend}（×${nw.ratio.toFixed(1)}）` : ''}`) : '',
    j.attention && j.attention.social ? `網友社群 7日 ${j.attention.social} 篇` : '',
    j.attention && j.attention.intl ? `國際外電 7日 ${j.attention.intl} 則` : '',
    pt ? `PTT 7日 ${pt.n} 篇${pt.bull + pt.bear ? `・［標的］多 ${pt.bull} 空 ${pt.bear}` : ''}${pt.hot ? `・爆文 ${pt.hot}` : ''}${pt.boo ? `・噓文 ${pt.boo}` : ''}` : '',
  ].filter(Boolean).join('　｜　');
  /* v179 月營收：官方硬資料。驚奇度＝本月年增率偏離過去24個月常態的程度，|SUR|≥2 才算明顯；公布後市場有沒有買單看事件研究 */
  const rv = j.revenue, md = d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const revBox = rv ? (() => {
    const st = rv.study, sig = st && st.status === 'ok' && Math.abs(st.scar) >= SIG;
    const sur = rv.sur == null ? (rv.n >= 12 ? `過去 ${rv.n} 個月年增率完全相同，無法算驚奇度` : `歷史只有 ${rv.n} 個月（需 12 個月），不算驚奇度`)
      : `驚奇度 ${rv.sur >= 0 ? '+' : ''}${rv.sur.toFixed(1)}${Math.abs(rv.sur) >= 2 ? (rv.sur > 0 ? '，明顯優於常態' : '，明顯差於常態') : '，在常態範圍內'}（過去 ${rv.n} 個月年增平均 ${pctI(rv.mean)}）`;
    const react = !rv.seen ? '公布日不明（FinMind 2026/4/21 以前的資料沒有入庫日），不做市場反應分析'
      : !st ? '' : st.status === 'pending' ? `${md(rv.seen)} 公布，市場尚未交易` : st.status !== 'ok' ? '歷史資料不足，無法做市場反應分析'
      : `約 ${md(rv.seen)} 公布 → 市場反應 CAR ${pctI(st.car)}（${st.L}日，SCAR ${st.scar.toFixed(1)}，${sig ? '顯著' : '不顯著'}）${Math.abs(st.preScar) >= SIG ? `・公布前5日已有 ${pctI(st.pre)}（可能盤中公布或提前反應）` : ''}`;
    return `<div style="margin-top:8px;padding:8px 11px;border:1px solid var(--bd);border-radius:8px;font-size:11px;line-height:1.7;color:var(--muted)">
      📊 <b style="color:var(--txt)">${Math.floor(rv.ym / 100)}/${rv.ym % 100} 月營收（官方）</b>：年增 <b style="color:${rv.yoy >= 0 ? 'var(--buy)' : 'var(--sell)'}">${pctI(rv.yoy)}</b>${rv.mom != null ? `・月增 ${pctI(rv.mom)}` : ''}${rv.ytd != null ? `・今年累計年增 ${pctI(rv.ytd)}` : ''}${Math.abs(rv.streak) >= 3 ? `・連續 ${Math.abs(rv.streak)} 個月年${rv.streak > 0 ? '增' : '減'}` : ''}
      <br>${sur}${react ? `<br>${react}` : ''}</div>`;
  })() : '';
  // 每交易日新聞量長條圖（最後一根虛線＝收盤後累積、待下一個交易日開盤反應）
  const bars = nw && nw.series && nw.series.length ? (() => {
    const cols = nw.series.map(x => ({ l: `${+x.d.slice(4, 6)}/${+x.d.slice(6)}`, n: x.n, p: false })).concat(nw.pending ? [{ l: '待開盤', n: nw.pending, p: true }] : []);
    const mx = Math.max(1, ...cols.map(c => c.n));
    return `<div style="display:flex;align-items:flex-end;gap:6px;height:84px;margin-top:10px" title="每交易日新聞量（13:30 後與假日的新聞算到下一個交易日）">${cols.map(c =>
      `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%"><span style="font-size:9px;color:var(--muted)">${c.n}</span><div style="width:100%;max-width:26px;height:${Math.max(3, c.n / mx * 54)}px;border-radius:3px 3px 0 0;${c.p ? 'border:1px dashed var(--acc);background:transparent' : 'background:var(--acc)'}"></div><span style="font-size:9px;color:var(--muted2);margin-top:2px;white-space:nowrap">${c.l}</span></div>`).join('')}</div>`;
  })() : '';
  const src = j.items.map((it, i) => { const u = safeUrl(it.url);
    return `<div style="font-size:10.5px;line-height:1.6;padding:3px 0;color:var(--muted)"><span style="color:var(--muted2)">[${i + 1}] ${tpI(it.t)}・${escI(it.src)}</span><br>${u ? `<a href="${u}" target="_blank" rel="noopener noreferrer" style="color:var(--txt);text-decoration:none">${escI(it.title)}</a>` : escI(it.title)}</div>`; }).join('');
  const status = [
    `資料時間 ${tpI(j.asOf)}${j.lastBar ? `・事件研究用到 ${j.lastBar.slice(4, 6)}/${j.lastBar.slice(6, 8)} 收盤` : ''}${j.newsVia ? `・新聞來源 ${escI(j.newsVia)}` : ''}${j.engine ? `・由 ${escI(j.engine)} 處理` : ''}${j.cached ? '・取自後端 10 分鐘快取' : j.timing ? `・耗時：抓資料 ${Math.round(j.timing.fetch / 1000)} 秒、AI ${Math.round(j.timing.ai / 1000)} 秒` : ''}`,
    j.ai.status === 'ok' ? `AI：${escI(j.ai.model)}（${escI(j.ai.prompt)}）${j.ai.dropped ? `・剔除 ${j.ai.dropped} 個無有效引用的事件` : ''}` : '',
    { saved: '今日快照已存（供日後回測）', 'no-kv': '未存快照（後端未綁 KV）' }[j.snapshot] || (j.snapshot ? `快照：${escI(j.snapshot)}` : ''),
  ].filter(Boolean).join('　');
  return `
    <div style="display:flex;justify-content:flex-end;margin-bottom:6px"><span style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--bd2);color:var(--muted2)">未經回測・不計入任何分數</span></div>
    <div style="border-left:3px solid ${C};background:var(--bg);border-radius:8px;padding:10px 12px">
      <div style="font-size:13.5px;font-weight:800;color:${C};line-height:1.5">${escI(v.head)}</div>
      ${v.sub ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;line-height:1.6">${escI(v.sub)}</div>` : ''}
      ${v.notes.map(n => `<div style="font-size:11px;color:var(--warn);margin-top:5px;line-height:1.6">${escI(n)}</div>`).join('')}
    </div>
    ${revBox}
    ${aiLine}
    ${evRows ? `<div style="margin-top:6px">${evRows}</div>` : ''}
    ${att ? `<div style="font-size:10.5px;color:var(--muted);margin-top:8px;padding-top:8px;border-top:1px solid var(--bd)">${att}${bars}</div>` : ''}
    ${(j.srcErrors || []).length ? `<div style="font-size:10.5px;color:var(--warn);margin-top:8px;line-height:1.6">⚠️ 這些來源這次沒拿到——是「沒有資料」不是「沒有消息」：${j.srcErrors.map(escI).join('；')}</div>` : ''}
    ${(j.notes || []).map(n => `<div style="font-size:10.5px;color:var(--muted);margin-top:4px">ℹ️ ${escI(n)}</div>`).join('')}
    ${j.items.length ? `<details style="margin-top:8px"><summary style="font-size:11px;color:var(--muted2);cursor:pointer">來源條目（${j.items.length}）</summary><div style="margin-top:6px">${src}</div></details>` : ''}
    <div style="font-size:9.5px;color:var(--muted2);margin-top:8px;line-height:1.6">${status}<br>CAR＝扣除大盤與個股β之後的累積異常報酬；|SCAR|≥1.96 代表反應大到不太可能是雜訊。13:30 後的消息從隔日起算。</div>`;
}

/* ── v178 AI 綜合研判：近一週逐日漲跌拆解＋歸因，與下一個交易日的消息面情境 ──
   跟情報卡共用同一次後端回應（同一次 Gemini 呼叫），不另外抓。
   拆解（大盤帶動 vs 個股自身）是程式算的，AI 只負責從「當天」的消息找原因；
   個股自身不顯著的日子不找原因——那天是跟著大盤走，硬配新聞就是看圖說故事。 */
function renderAiCard(j) {
  const mv = j.moves, WD = '日一二三四五六', pc = x => `<span style="color:${x >= 0 ? 'var(--buy)' : 'var(--sell)'}">${pctI(x)}</span>`;
  const day = d => `${+d.slice(4, 6)}/${+d.slice(6)}（${WD[new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T00:00:00Z`).getUTCDay()]}）`;
  const aiOK = j.ai.status === 'ok';
  const rows = mv === undefined ? '<div style="font-size:11px;color:var(--warn)">後端還沒更新到 v178（回應裡沒有逐日拆解）——請重新部署 Code.gs（新版本）與 worker.js</div>'
    : !mv ? '<div style="font-size:11px;color:var(--muted)">日K或大盤資料不足（估計 β 至少要 60 個交易日），無法逐日拆解。</div>'
    : mv.days.map(x => { const sig = Math.abs(x.z) >= SIG;
      const why = !sig ? '個股自身不顯著——主要是跟著大盤或正常波動，不找消息硬配'
        : x.why ? `可能原因：${citeI(x.why, j.items)}`
        : aiOK ? '個股自身顯著，但當天的消息都解釋不了——可能是類股資金、籌碼，或新聞沒報的因素'
        : '個股自身顯著（AI 未啟用，無法對照當天消息）';
      return `<div style="padding:7px 0;border-top:1px solid var(--bd)">
        <div style="display:flex;gap:8px;align-items:baseline;font-size:12px"><b style="min-width:70px">${day(x.d)}</b><span>漲跌 ${pc(x.ret)}</span>
          <span style="font-size:10.5px;color:var(--muted)">大盤帶動 ${pctI(x.mkt)}・個股自身 ${sig ? `<b>${pc(x.ar)}</b>` : pctI(x.ar)}</span></div>
        <div style="font-size:11px;color:${sig ? 'var(--txt)' : 'var(--muted)'};margin-top:3px;line-height:1.6">${why}</div></div>`; }).join('');
  const pend = mv ? mv.pending.length : 0;
  const outlook = aiOK && j.ai.outlook ? citeI(j.ai.outlook, j.items)
    : aiOK ? (mv ? '（AI 這次沒有給出展望）' : '（沒有逐日拆解時不產生展望）')
    : j.ai.status === 'no-items' ? '近7日沒有可歸納的消息，下一個交易日消息面沒有新變數。'
    : `AI ${j.ai.status === 'no-key' ? '未啟用（後端尚未設定 GEMINI_KEY）' : '歸納失敗'}——上面的逐日拆解是程式算的，仍然有效；收盤後有 ${pend} 則消息，見情報卡的來源條目。`;
  return `<div style="font-size:10px;color:var(--muted);letter-spacing:.5px;margin-bottom:2px">近一週逐日拆解：這天漲跌是大盤帶的，還是個股自己的事？</div>${rows}
    <div style="margin-top:10px;padding:9px 11px;background:var(--bg);border-left:3px solid var(--acc);border-radius:7px">
      <div style="font-size:11px;font-weight:700;color:var(--acc);margin-bottom:3px">下一個交易日的消息面${mv ? `（收盤後 ${pend} 則新消息）` : ''}</div>
      <div style="font-size:12px;line-height:1.7">${outlook}</div></div>
    <div style="font-size:9.5px;color:var(--muted2);margin-top:8px;line-height:1.6">拆解：漲跌＝大盤帶動（β×大盤漲跌）＋個股自身；${mv ? `β=${mv.beta.toFixed(2)}，用分析期間之前 ${mv.n} 個交易日估計。` : ''}個股自身超過 1.96 倍日常波動才算顯著，才對照「當天」的消息（13:30 後的消息算下一個交易日）。展望是情境，不是漲跌預測；未經回測，不計入任何分數——能不能做以紀律門為準。</div>`;
}

const _intelCache = new Map();
/* v181 同一檔進行中的請求共用：A→B→A 快速切回時，不重打一次後端（Gemini 有額度），
   也不會讓後到的那次失敗蓋掉先到的好結果；進度秒數沿用第一次開始的時間 */
const _intelFlight = new Map();
function intelFlight(code) {
  if (!_intelFlight.has(code)) {
    const p = (async () => {
      const tk = typeof FINMIND_TOKEN !== 'undefined' && FINMIND_TOKEN ? `&token=${encodeURIComponent(FINMIND_TOKEN)}` : '';   // 有 token 時 FinMind 額度較高；沒有也能用
      const r = await fetchT(`${GAS_URL}?action=intel&code=${encodeURIComponent(code)}${tk}`, {}, INTEL_WAIT);
      if (!r.ok) throw new Error(`後端 HTTP ${r.status}`);
      const txt = await r.text();
      let j;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('後端回傳的不是 JSON——多半是後端尚未部署 v168 的 intel 端點'); }
      if (!j.ok) throw new Error(j.error || '後端錯誤');
      if (!Array.isArray(j.items) || !j.ai) throw new Error('後端沒有情報欄位——worker.js / Code.gs 尚未更新到 v168，請重新部署');
      _intelCache.set(code, { t: Date.now(), j });
      return j;
    })().finally(() => _intelFlight.delete(code));
    _intelFlight.set(code, { p, t0: Date.now() });
  }
  return _intelFlight.get(code);
}   // code → { t, j }：同一檔10分鐘內不重抓（AI 呼叫有額度）
/* v176 進度顯示：後端是一次請求，途中回報不了進度——能確定的只有「已經等了幾秒」。
   秒數持續跳動＝頁面活著、仍在等後端；階段文字依一般耗時推估（標明「預估」）；
   到上限就明講逾時並給重試，不會無限轉圈。 */
let INTEL_WAIT = 90000;   // v182：60→90 秒（Worker 等 GAS 80 秒）；GAS 算完的結果保留 10 分鐘，逾時後重試通常直接拿到
const INTEL_STAGES = [[0, '連線後端'], [3, '抓取新聞、PTT、公告與K線'], [12, 'AI 歸納事件、計算事件研究'], [35, '比平常久，仍在等待後端']];
let _intelTimer = 0;
function intelProgress(box, code, t0) {
  clearInterval(_intelTimer);   // 同一檔連點兩次時，停掉前一個計時，否則它會在結果出來後繼續蓋上「已等 N 秒」
  const paint = () => {
    const s = Math.floor((Date.now() - t0) / 1000), st = INTEL_STAGES.filter(x => s >= x[0]).pop()[1], max = INTEL_WAIT / 1000;
    box.innerHTML = `<div style="font-size:12px;color:var(--muted);line-height:1.6">${st}（預估）… 已等 <b>${s}</b> 秒<span style="color:var(--muted2)">　最多等 ${max} 秒</span></div>
      <div style="height:3px;background:var(--bd);border-radius:2px;margin-top:6px;overflow:hidden" title="已等待時間／等待上限（不是完成度）"><div style="height:100%;width:${Math.min(100, s / max * 100)}%;background:var(--acc);transition:width 1s linear"></div></div>`;
  };
  paint();   // 第一次一定要畫：否則畫面會停留在上一檔股票的情報（換股時最危險）
  const id = setInterval(() => {   // 用自己的 id 停自己：共用變數此時可能已是新股票的計時，停錯會讓新畫面卡住
    if (window._activeCode && window._activeCode !== code) { clearInterval(id); return; }
    paint();
  }, 1000);
  _intelTimer = id;
}
async function loadIntelCard(D) {
  const card = document.getElementById('intel-card'), box = document.getElementById('intel-content');
  const aiCard = document.getElementById('ai-card'), aiBox = document.getElementById('ai-body');
  if (!card || !box) return;
  if (D.currency !== 'TWD' || !GAS_URL) { card.style.display = 'none'; if (aiCard) aiCard.style.display = 'none'; return; }
  card.style.display = 'block';
  if (aiCard) { aiCard.style.display = 'block'; aiBox.innerHTML = '<div style="font-size:12px;color:var(--muted)">等待情報面資料（與上方情報卡共用同一次抓取，進度看情報卡）…</div>'; }
  window._intelD = D;   // 給「重試」按鈕用
  let j;
  try {
    const c = _intelCache.get(D.code);
    if (c && Date.now() - c.t < 600e3) j = c.j;
    else {
      const f = intelFlight(D.code);
      intelProgress(box, D.code, f.t0);
      j = await f.p;
    }
  } catch (e) {
    if (window._activeCode && window._activeCode !== D.code) return;
    clearInterval(_intelTimer);
    const msg = String(e && e.message || e), slow = /超時/.test(msg);
    box.innerHTML = `<div style="font-size:12px;color:var(--warn);line-height:1.6">⚠️ ${slow
      ? `等了 ${INTEL_WAIT / 1000} 秒後端都沒有回應（不是頁面當機）——GAS 仍會在背景算完並保留結果 10 分鐘，稍後按重試通常可直接取得`
      : `情報面取得失敗：${escI(msg)}`}
      <button onclick="loadIntelCard(window._intelD)" style="margin-left:6px;font-size:11px;padding:3px 10px;border-radius:5px;border:1px solid var(--bd2);background:transparent;color:var(--acc);cursor:pointer">重試</button></div>`;
    if (aiBox) aiBox.innerHTML = '<div style="font-size:12px;color:var(--warn)">⚠️ 情報面資料沒拿到，無法逐日歸因——錯誤原因與重試按鈕在上方情報卡</div>';
    return;
  }
  if (window._activeCode && window._activeCode !== D.code) return;   // 已換股，丟棄遲到結果
  clearInterval(_intelTimer);
  try { box.innerHTML = renderIntel(j, D); if (aiBox) aiBox.innerHTML = renderAiCard(j); }
  catch (e) {   // 資料已到但顯示程式出錯：明講，不讓兩張卡停在「已等 N 秒」「等待中」
    const m = `<div style="font-size:12px;color:var(--warn)">⚠️ 情報面資料已取得，但顯示時出錯（${escI(e && e.message || e)}）——這是程式問題，請回報</div>`;
    box.innerHTML = m; if (aiBox) aiBox.innerHTML = m;
    if (typeof ErrorLog !== 'undefined') ErrorLog.push('情報面顯示', e);
  }
}
