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
try { (window.SR_FV = window.SR_FV || {})['intel.js'] = 170; } catch (e) {}

/* 條目標題來自新聞與PTT（任何人都能發文），一律完整跳脫再進 innerHTML。
   不用 layout.js 的 esc：那支是「刪掉」特殊字元，會把「台積電 & 蘋果」弄成「台積電  蘋果」。 */
const escI = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? escI(u) : '';
const pctI = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
const tpI = t => { const d = new Date(t + 8 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const SIG = 1.96;   // |SCAR| 門檻（雙尾 5%）
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
  const inst = ch && (ch.n5 == null || ch.n5 >= 3) && (ch.foreign5 != null || ch.trust5 != null) ? (ch.foreign5 || 0) + (ch.trust5 || 0) : null;
  const instS = inst == null ? 0 : Math.sign(inst);

  if (ok && Math.abs(st.preScar) >= SIG) notes.push(`⚠️ 消息公布前5日已有顯著異常報酬 ${pctI(st.pre)}——消息可能早已被交易，公布後的反應會被低估`);
  const p = j.attention && j.attention.ptt;
  if (p && p.bull + p.bear >= 5) {
    const sh = Math.max(p.bull, p.bear) / (p.bull + p.bear);
    if (sh >= 0.8) notes.push(`PTT［標的］${p.bull >= p.bear ? '看多' : '看空'} ${(sh * 100).toFixed(0)}%（${p.bull + p.bear}篇）——情緒一面倒屬「擁擠」風險，不是方向訊號`);
  }
  const nw = j.attention && j.attention.news;
  if (nw && nw.saturated) notes.push('新聞量已達來源上限，無法計算注意力倍數（熱門股常見）');
  else if (nw && nw.ratio >= 3 && nw.last24 >= 3) notes.push(`新聞注意力暴增：近24小時 ${nw.last24} 則，為前6日中位數的 ${nw.ratio.toFixed(1)} 倍——預期波動放大`);
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
  const cite = s => escI(s).replace(/\[(\d+)\]/g, (m, n) => { const it = j.items[+n], u = it && safeUrl(it.url);
    return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer" style="color:var(--acc);text-decoration:none;font-size:.85em;vertical-align:super">[${+n + 1}]</a>` : ''; });
  const aiLine = {
    ok: j.ai.summary ? `<div style="font-size:12px;line-height:1.7;margin:10px 0">${cite(j.ai.summary)}</div>` : '',
    'no-key': '<div style="font-size:11px;color:var(--muted);margin:10px 0">AI 歸納未啟用：後端尚未設定 GEMINI_KEY（Cloudflare：Settings → Variables and Secrets；GAS：專案設定 → 指令碼屬性）。下方仍列出原始條目與官方公告的市場反應。</div>',
    'no-items': '<div style="font-size:11px;color:var(--muted);margin:10px 0">近7日沒有可歸納的條目。</div>',
    error: `<div style="font-size:11px;color:var(--warn);margin:10px 0">⚠️ AI 歸納失敗：${escI(j.ai.why)}——下方仍列出原始條目。</div>`,
  }[j.ai.status] || '';
  const DIR = { 1: ['▲', 'var(--buy)'], '-1': ['▼', 'var(--sell)'], 0: ['●', 'var(--muted)'] };
  const kindName = { news: '新聞', social: '社群', ptt: 'PTT', mops: '公告' };
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
    nw ? (nw.saturated ? `新聞 7日 ≥${nw.n} 則（已達上限）` : `新聞 近24h ${nw.last24} 則／前6日中位數 ${nw.med}`) : '',
    j.attention && j.attention.social ? `網友社群 7日 ${j.attention.social} 篇` : '',
    pt ? `PTT 7日 ${pt.n} 篇${pt.bull + pt.bear ? `・［標的］多 ${pt.bull} 空 ${pt.bear}` : ''}` : '',
  ].filter(Boolean).join('　｜　');
  const src = j.items.map((it, i) => { const u = safeUrl(it.url);
    return `<div style="font-size:10.5px;line-height:1.6;padding:3px 0;color:var(--muted)"><span style="color:var(--muted2)">[${i + 1}] ${tpI(it.t)}・${escI(it.src)}</span><br>${u ? `<a href="${u}" target="_blank" rel="noopener noreferrer" style="color:var(--txt);text-decoration:none">${escI(it.title)}</a>` : escI(it.title)}</div>`; }).join('');
  const status = [
    `資料時間 ${tpI(j.asOf)}${j.lastBar ? `・事件研究用到 ${j.lastBar.slice(4, 6)}/${j.lastBar.slice(6, 8)} 收盤` : ''}${j.newsVia ? `・新聞來源 ${escI(j.newsVia)}` : ''}`,
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
    ${aiLine}
    ${evRows ? `<div style="margin-top:6px">${evRows}</div>` : ''}
    ${att ? `<div style="font-size:10.5px;color:var(--muted);margin-top:8px;padding-top:8px;border-top:1px solid var(--bd)">${att}</div>` : ''}
    ${(j.srcErrors || []).length ? `<div style="font-size:10.5px;color:var(--warn);margin-top:8px;line-height:1.6">⚠️ 這些來源這次沒拿到——是「沒有資料」不是「沒有消息」：${j.srcErrors.map(escI).join('；')}</div>` : ''}
    ${(j.notes || []).map(n => `<div style="font-size:10.5px;color:var(--muted);margin-top:4px">ℹ️ ${escI(n)}</div>`).join('')}
    ${j.items.length ? `<details style="margin-top:8px"><summary style="font-size:11px;color:var(--muted2);cursor:pointer">來源條目（${j.items.length}）</summary><div style="margin-top:6px">${src}</div></details>` : ''}
    <div style="font-size:9.5px;color:var(--muted2);margin-top:8px;line-height:1.6">${status}<br>CAR＝扣除大盤與個股β之後的累積異常報酬；|SCAR|≥1.96 代表反應大到不太可能是雜訊。13:30 後的消息從隔日起算。</div>`;
}

const _intelCache = new Map();   // code → { t, j }：同一檔10分鐘內不重抓（AI 呼叫有額度）
async function loadIntelCard(D) {
  const card = document.getElementById('intel-card'), box = document.getElementById('intel-content');
  if (!card || !box) return;
  if (D.currency !== 'TWD' || !GAS_URL) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  box.innerHTML = '<div style="font-size:12px;color:var(--muted)">正在蒐集新聞、PTT 與重大訊息，AI 歸納約需 5～20 秒…</div>';
  let j;
  try {
    const c = _intelCache.get(D.code);
    if (c && Date.now() - c.t < 600e3) j = c.j;
    else {
      const r = await fetchT(`${GAS_URL}?action=intel&code=${encodeURIComponent(D.code)}`, {}, 60000);
      if (!r.ok) throw new Error(`後端 HTTP ${r.status}`);
      const txt = await r.text();
      try { j = JSON.parse(txt); } catch (e) { throw new Error('後端回傳的不是 JSON——多半是後端尚未部署 v168 的 intel 端點'); }
      if (!j.ok) throw new Error(j.error || '後端錯誤');
      if (!Array.isArray(j.items) || !j.ai) throw new Error('後端沒有情報欄位——worker.js / Code.gs 尚未更新到 v168，請重新部署');
      _intelCache.set(D.code, { t: Date.now(), j });
    }
  } catch (e) {
    if (window._activeCode && window._activeCode !== D.code) return;
    box.innerHTML = `<div style="font-size:12px;color:var(--warn)">⚠️ 情報面取得失敗：${escI(e && e.message || e)}</div>`;
    return;
  }
  if (window._activeCode && window._activeCode !== D.code) return;   // 已換股，丟棄遲到結果
  box.innerHTML = renderIntel(j, D);
}
