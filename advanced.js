/* ══════════════════════════════════════════════════════════════════════
   advanced.js — 法人等級進階分析（市場→產業→個股 三層）
   ──────────────────────────────────────────────────────────────────
   A. RS Rating 相對強弱評級（vs 大盤，O'Neil 法）
   B. Beta / Alpha（個股 vs 大盤回歸）
   D. 支撐壓力自動辨識（含定錨、圖形線位）
   基本面體檢
   （v188 拿掉 C 機率預測、E 量價雷達、樣本外驗證——理由見各自原位置的註解）
   依賴：app.js($/fmt/fmtV)
   資料限制：產業分類/籌碼集中度無免費API，以近似法或標註
   ──────────────────────────────────────────────────────────────────
   後續新增函式（v79起）：
     computeAnchoring                  — 定錨效應（Liao,Chou&Chiu 2013）
     computeChartPatterns              — 圖形線位引擎：趨勢線/通道/箱型/
                                         三角收斂/M頭W底頸線，線位工具
                                         非方向預測，全程用原始市價
     renderSupportResistance           — 支撐壓力卡渲染，尾端接圖形線位
                                         與突破統計(v90起僅一句話指引)
   ──────────────────────────────────────────────────────────────────
   近期版本異動：
     v79  圖形線位引擎首次加入；str_replace編輯此函式時第4次吃掉catch
          （本檔案高風險區，長函式編輯建議用函式邊界錨點而非行內文字錨點）
     v80  停損×線位重疊偵測聯動（見bingfa.js執行計畫區塊）
     v83  類股廣度線位無關，另見market.js/worker.js
     v90  移除支撐壓力卡內重複的突破成功率數字，改一句話指向溫度計卡
   ⚠️ 已知地雷／注意事項：
     - renderSupportResistance函式較長(200+行)，內含多個try-catch區塊，
       str_replace編輯時務必先view確認catch邊界完整，此檔曾4次因編輯
       誤刪catch導致「Missing catch or finally」語法錯誤
     - computeChartPatterns用ATR自適應容差(tol)判斷觸碰，勿與固定%容差
       混用，否則波動大小不同的股票會有不一致的線位判定標準
   ══════════════════════════════════════════════════════════════════════ */
/* v163 檔案版本宣告：讓前端能查出「站上哪個檔案沒更新到」。
   改這個檔時一併把數字改成當版；config.js 的 FILE_VERS 必須同步（自我檢查會擋）。 */
try { (window.SR_FV = window.SR_FV || {})['advanced.js'] = 198; } catch (e) {}

/* ── 大盤基準快取（避免每檔都重抓）─────────────────────────────────── */
let _benchCache = {};   // key → { d: { closes, lastDate }, t, until }（v177：台美各自計時；v186 有效期看資料日期，見 cacheUntil）
/* v183：個股在盤中會去掉今天未完成的K棒（trimIntradayBar），大盤原本沒去——兩條序列從尾端對齊時
   差了一天，盤中的 Beta/Alpha 全部錯位（實測 2330 的 Beta 0.65 變 0.06）。用同一個規則去掉。
   v186：暫存存原始序列，每次取用時依「當下」去掉（暫存可能是盤中抓的、收盤後才用） */
const benchTrim = (j, us) => trimIntradayBar({ closes: j.closes.slice(), lastDate: j.lastDate, currency: us ? 'USD' : 'TWD' }).closes;
async function fetchBenchmark(isTW) {
  const key = isTW ? 'tw' : 'us';
  const hit = await pcGet(_benchCache, key, 'bench');
  if (hit) return benchTrim(hit.d, !isTW);
  if (!GAS_URL || GAS_URL.indexOf('http') !== 0) return null;
  try {
    const r = await fetchT(`${GAS_URL}?action=benchmark&market=${key}`);
    const j = await r.json();
    if (j.ok && j.closes) {
      const d = { closes: j.closes, lastDate: j.lastDate };
      pcSet(_benchCache, key, 'bench', d, cacheUntil('px', d, Date.now(), !isTW));
      return benchTrim(d, !isTW);
    }
  } catch (e) {
    if (typeof ErrorLog !== 'undefined') ErrorLog.push('fetchBenchmark', e);
  }
  return null;
}

/* ══ A. RS Rating 相對強弱 ════════════════════════════════════════════
   參考 O'Neil 加權概念：個股近期報酬（近季×2+近半年+近年）vs 大盤超額報酬，
   用 tanh 壓縮映射至 1~99。⚠️ 非 IBD 官方跨全市場百分位排名，是單股相對強弱的近似分數
   需大盤資料（從 market 帶入 benchmark 報酬）
   ════════════════════════════════════════════════════════════════════ */
function computeRSRating(D, bench) {
  const c = D.closes;
  const n = c.length;
  // 報酬（區間不超過個股實際的K棒數，大盤用同一個區間）
  const L = bench && bench.length > 63 ? Math.min(n, bench.length) : n;   // v184 兩條序列取較短者，區間才真的一樣
  const ret = (a, period) => { const m = a.length, k = Math.min(period, L - 1); return (a[m-1] - a[m-1-k]) / a[m-1-k]; };
  // O'Neil 加權：近一季 ×2 + 近半年 + 近一年
  const r63 = ret(c, 63), r126 = ret(c, 126), r252 = ret(c, 252);
  const weighted = (r63 * 2 + r126 + r252) / 4;
  /* v183：大盤也要用同樣的加權。原本拿「個股加權報酬」減「大盤一年報酬」——兩個不同的量，
     多頭年大盤一年漲很多時，連大盤自己（0050 對 0050）都只得 2 分 */
  const benchReturn = bench && bench.length > 63 ? (ret(bench, 63) * 2 + ret(bench, 126) + ret(bench, 252)) / 4 : null;

  // 若有大盤基準，算相對強弱；否則用絕對報酬映射
  let rsRaw;
  if (benchReturn != null) {
    rsRaw = weighted - benchReturn; // 超額報酬
  } else {
    rsRaw = weighted;
  }
  // 映射到 1~99（用 tanh 壓縮，±30%超額對應極值）
  const rating = Math.round(50 + 49 * Math.tanh(rsRaw / 0.3));
  return {
    rating: Math.max(1, Math.min(99, rating)),
    r63: r63 * 100, r126: r126 * 100, r252: r252 * 100,
    weighted: weighted * 100,
    excess: benchReturn != null ? (weighted - benchReturn) * 100 : null
  };
}

function renderRSRating(rs) {
  const card = document.getElementById('rs-card');
  card.style.display = 'block';
  const col = rs.rating >= 80 ? 'var(--buy)' : rs.rating >= 50 ? 'var(--warn)' : 'var(--sell)';
  document.getElementById('rs-val').textContent = rs.rating;
  document.getElementById('rs-val').style.color = col;
  let desc;
  // 用詞澄清：這是「個股超額報酬強度」換算的分數（tanh壓縮至1-99），
  // 不是 IBD 官方那種跨全市場所有股票做百分位排名的 RS Rating，避免「RS=90」被誤解成「贏過90%股票」
  if (rs.rating >= 90) desc = `超額報酬強度 ${rs.rating} 分，超強勢，法人選股常要求 RS>80`;
  else if (rs.rating >= 70) desc = `超額報酬強度 ${rs.rating} 分，相對強勢`;
  else if (rs.rating >= 50) desc = `超額報酬強度 ${rs.rating} 分，略強於大盤`;
  else desc = `超額報酬強度 ${rs.rating} 分，相對弱勢，留意`;
  document.getElementById('rs-desc').textContent = desc;
  document.getElementById('rs-detail').textContent =
    `近季 ${rs.r63>=0?'+':''}${rs.r63.toFixed(1)}%｜近半年 ${rs.r126>=0?'+':''}${rs.r126.toFixed(1)}%｜近年 ${rs.r252>=0?'+':''}${rs.r252.toFixed(1)}%` +
    (rs.excess != null ? `｜超額報酬 ${rs.excess>=0?'+':''}${rs.excess.toFixed(1)}%` : '｜⚠️ 大盤資料未取得，此為絕對報酬近似（非相對強弱）');
}

/* ══ B. Beta / Alpha ══════════════════════════════════════════════════
   用個股與大盤日報酬做線性回歸：報酬_股 = α + β × 報酬_大盤
   ════════════════════════════════════════════════════════════════════ */
function computeBetaAlpha(D, benchCloses) {
  if (!benchCloses || benchCloses.length < 30) return null;
  const c = D.closes;
  const len = Math.min(c.length, benchCloses.length, 120); // 用近120日
  const sr = [], mr = [];
  for (let i = 1; i < len; i++) {
    const si = c[c.length - len + i], si1 = c[c.length - len + i - 1];
    const bi = benchCloses[benchCloses.length - len + i], bi1 = benchCloses[benchCloses.length - len + i - 1];
    if (si1 && bi1) { sr.push((si - si1) / si1); mr.push((bi - bi1) / bi1); }
  }
  if (sr.length < 20) return null;
  const meanS = sr.reduce((a,b)=>a+b,0)/sr.length;
  const meanM = mr.reduce((a,b)=>a+b,0)/mr.length;
  let cov = 0, varM = 0;
  for (let i = 0; i < sr.length; i++) {
    cov += (sr[i]-meanS)*(mr[i]-meanM);
    varM += (mr[i]-meanM)**2;
  }
  const beta = varM ? cov/varM : 1;
  // Alpha（年化）：個股平均報酬 - beta×大盤平均報酬，×252
  const alpha = (meanS - beta * meanM) * 252 * 100;
  return { beta, alpha };
}

function renderBetaAlpha(ba) {
  const card = document.getElementById('beta-card');
  if (!ba) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const boxes = [
    { label: '📊 Beta 波動係數', value: ba.beta.toFixed(2),
      valCls: ba.beta > 1.3 ? 'sell' : ba.beta < 0.8 ? 'buy' : 'warn',
      cls: ba.beta > 1.3 ? '' : 'good',
      sub: ba.beta > 1.3 ? `大盤漲1%，此股約漲 ${ba.beta.toFixed(1)}%，高波動高風險` :
           ba.beta < 0.8 ? `波動低於大盤，相對抗跌` : `與大盤波動接近` },
    { label: '💎 Alpha 超額報酬(年化)', value: (ba.alpha>=0?'+':'')+ba.alpha.toFixed(1)+'%',
      valCls: ba.alpha >= 0 ? 'buy' : 'sell',
      cls: ba.alpha >= 0 ? 'good' : '',
      sub: ba.alpha >= 0 ? `扣除大盤影響後仍正報酬，真有實力` : `跑輸大盤，超額報酬為負` }
  ];
  document.getElementById('beta-grid').innerHTML = boxes.map(x =>
    `<div class="risk-box ${x.cls}"><div class="rb-label">${x.label}</div><div class="rb-value ${x.valCls}">${x.value}</div><div class="rb-sub">${x.sub}</div></div>`
  ).join('');
}

/* v188 拿掉 C「機率預測」與 C-2「機率品質檢驗」：9 訊號投票的歷史命中率，LogLoss 劣於「直接用基準漲跌率」（X 級） */

/* ══ D-alt. 定錨效應（Anchoring Bias，與D支撐壓力互補）═══════════════════════════════════════
   行為金融學：投資人會用「整數關卡」與「歷史高低點」當心理錨點，而非理性評估。
   文獻依據：Liao, Chou, Chiu (2013)《定錨效應對外資動能交易行為的影響：
   來自台灣股市的證據》，證實台灣市場外資交易行為確實受定錨效應影響。
   與現有「支撐壓力」的差異：支撐壓力抓的是技術轉折點（實際成交密集區）；
   此處抓的是「心理整數關卡」與「52週高低點」——兩者成因不同，不重複，互補。
   ════════════════════════════════════════════════════════════════════ */
function computeAnchoring(D) {
  const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows;
  const price = D.rawCloses ? D.rawCloses[D.rawCloses.length - 1] : D.price;
  const n = c.length;

  // 整數關卡：依價格量級決定關卡間距（10元股看整數、100元股看5的倍數、1000元股看50的倍數）
  const magnitude = price < 20 ? 1 : price < 100 ? 5 : price < 500 ? 10 : price < 2000 ? 50 : 100;
  const nearestRound = Math.round(price / magnitude) * magnitude;
  const roundDist = Math.abs(price - nearestRound) / price * 100;
  const nearRound = roundDist < 1.5;  // 距離整數關卡在1.5%以內視為「貼近」

  // 52週高低點（約252交易日，資料不足時用可得長度近似）
  const lookback = Math.min(252, n);
  const high52 = Math.max(...h.slice(-lookback));
  const low52 = Math.min(...l.slice(-lookback));
  const distFromHigh = (high52 - price) / high52 * 100;   // 距52週高點百分比
  const distFromLow = (price - low52) / low52 * 100;       // 距52週低點百分比
  const nearHigh52 = distFromHigh < 3;
  const nearLow52 = distFromLow < 3;

  const notes = [];
  if (nearRound) notes.push(`貼近整數關卡 ${nearestRound}（距離${roundDist.toFixed(1)}%）——散戶與法人常在此掛單，易有心理性支撐/壓力`);
  if (nearHigh52) notes.push(`貼近52週高點 ${n < 252 ? '（資料未滿一年，近似）' : ''}${high52.toFixed(1)}——歷史高點是最強心理錨點，突破常需要更大量能確認，反之則易獲利了結賣壓`);
  if (nearLow52) notes.push(`貼近52週低點 ${n < 252 ? '（資料未滿一年，近似）' : ''}${low52.toFixed(1)}——留意「這裡曾經很便宜」的定錨心理，可能引發搶反彈或恐慌加碼摸底`);

  if (!notes.length) return null;
  return { nearRound, nearestRound, roundDist, nearHigh52, nearLow52, high52, low52, distFromHigh, distFromLow, notes };
}

/* ══ D. 支撐壓力自動辨識 ══════════════════════════════════════════════
   用近期轉折高低點 + 成交密集區，找出支撐壓力位
   ════════════════════════════════════════════════════════════════════ */
function computeSupportResistance(D) {
  // 支撐壓力是「人類記憶的關卡」，用未還原市價（若後端未更新則fallback還原價，不報錯）
  const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows;
  const price = (D.rawCloses ? D.rawCloses[D.rawCloses.length - 1] : D.price);
  const N = Math.min(120, c.length);
  const hs = h.slice(-N), ls = l.slice(-N);

  // 找局部轉折高點（壓力）與低點（支撐）
  const pivots = { res: [], sup: [] };
  for (let i = 2; i < N-2; i++) {
    if (hs[i] > hs[i-1] && hs[i] > hs[i-2] && hs[i] > hs[i+1] && hs[i] > hs[i+2]) pivots.res.push(hs[i]);
    if (ls[i] < ls[i-1] && ls[i] < ls[i-2] && ls[i] < ls[i+1] && ls[i] < ls[i+2]) pivots.sup.push(ls[i]);
  }
  // 壓力：高於現價、由近到遠取3個；支撐：低於現價取3個
  const res = [...new Set(pivots.res.filter(p => p > price).map(p => Math.round(p*100)/100))].sort((a,b)=>a-b).slice(0,3);
  const sup = [...new Set(pivots.sup.filter(p => p < price).map(p => Math.round(p*100)/100))].sort((a,b)=>b-a).slice(0,3);
  return { res, sup, price };
}

function renderSupportResistance(sr, D) {
  const card = document.getElementById('sr-card');
  card.style.display = 'block';
  const resHtml = sr.res.length ? sr.res.map((r,i) =>
    `<div style="display:flex;justify-content:space-between;padding:5px 10px;background:var(--sell-d);border-radius:6px;margin-bottom:4px"><span style="font-size:11px;color:var(--muted)">壓力${i+1}</span><span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--sell)">${fmt(r)}</span></div>`
  ).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px">近期無明顯壓力（接近高點）</div>';
  const supHtml = sr.sup.length ? sr.sup.map((s,i) =>
    `<div style="display:flex;justify-content:space-between;padding:5px 10px;background:var(--buy-d);border-radius:6px;margin-bottom:4px"><span style="font-size:11px;color:var(--muted)">支撐${i+1}</span><span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--buy)">${fmt(s)}</span></div>`
  ).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px">近期無明顯支撐（接近低點）</div>';
  document.getElementById('sr-content').innerHTML =
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div><div style="font-size:10px;color:var(--sell);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">⬆️ 上方壓力</div>${resHtml}</div>
      <div><div style="font-size:10px;color:var(--buy);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">⬇️ 下方支撐</div>${supHtml}</div>
    </div>
    <div style="text-align:center;margin-top:10px;font-family:var(--mono);font-size:12px;color:var(--muted)">目前價格 ${fmt(sr.price)}</div>`;

  // 定錨效應（心理關卡，與上方技術支撐壓力互補顯示）
  try {
    if (typeof computeAnchoring === 'function' && D) {
      const anchor = computeAnchoring(D);
      if (anchor && anchor.notes.length) {
        let html2 = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--bd)">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🧠 定錨效應（心理關卡，非技術轉折點）</div>`;
        anchor.notes.forEach(n => {
          html2 += `<div style="font-size:11px;color:var(--muted);line-height:1.6;padding:3px 0">▸ ${n}</div>`;
        });
        html2 += `<div style="font-size:9px;color:var(--muted2);margin-top:4px">依據：Liao, Chou & Chiu (2013) 台灣股市定錨效應實證研究</div></div>`;
        document.getElementById('sr-content').innerHTML += html2;
      }
    }
  } catch (e) { /* 略過，不影響主卡片 */ }

  // 圖形線位（趨勢線/通道/箱型/三角/頸線——線位工具非方向預測）
  try {
    if (typeof computeChartPatterns === 'function' && D) {
      const cp = computeChartPatterns(D);
      if (cp && cp.patterns.length) {
        let html3 = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--bd)">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">📐 圖形線位（觸碰容差 ±${cp.tol}%）</div>`;
        cp.patterns.forEach(p => {
          html3 += `<div style="padding:7px 10px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;margin-bottom:6px">
            <div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-size:12px;font-weight:700">${p.kind}</span><span style="font-family:var(--mono);font-size:12px;font-weight:700;color:var(--acc)">${fmt(p.level)}${p.level2 ? ' / ' + fmt(p.level2) : ''}</span></div>
            <div style="font-size:10px;color:var(--muted);line-height:1.55;margin-top:2px">${p.note}</div>
          </div>`;
        });
        let fbTxt = '';
        try {
          const bs2 = typeof computeBreakoutStats === 'function' ? computeBreakoutStats(D) : null;
          if (bs2) fbTxt = `<br>📊 突破線位不等於突破成功——此股歷史統計與台股基準詳見「行情溫度計」卡的突破結構檢查。`;
        } catch (e3) {}
        html3 += `<div style="font-size:9px;color:var(--muted2);line-height:1.5">線位＝參考線位（停損擺放、突破觀察；下單數字以紀律門執行計畫為準），非方向預測（19年7,908事件已證純價格方向訊號α≈0）。人人看得到的線=停損聚集區，突破/跌破常先掃停損，等回測確認更穩。${fbTxt}</div></div>`;
        document.getElementById('sr-content').innerHTML += html3;
      }
    }
  } catch (e) { /* 略過，不影響主卡片 */ }
}

/* v188 拿掉 E「量價雷達」（87.5% 時間顯示「正常」，窒息量／放量與成交量格、主力足跡重複）與「樣本外驗證」
   （驗的是 X 級的 9 訊號投票，測試期命中率中位數 0.50，卻會對使用者說「樣本外仍有效」） */

/* ══ 基本面體檢（台股：估值 + 月營收）════════════════════════════════
   定位：背景濾網，不是進出場訊號。波段層級的用途：
   ①營收連續衰退 = 空單的基本面順風 ②估值極端 = 泡沫語境
   ③殖利率 = 空單除息成本提醒
   ════════════════════════════════════════════════════════════════════ */
const _fundCache = {};
async function loadFundamentalCard(D) {
  const card = document.getElementById('fundamental-card');
  if (!card) return;
  if (D.currency !== 'TWD') { card.style.display = 'none'; return; }
  let f = null, why = '';
  const hit = await pcGet(_fundCache, D.code, 'fund');   // v186 估值是盤後資料：當天的到了就留到下一個 16:00
  if (hit) f = hit.d;
  else {
    try {
      const r = await fetchT(`${GAS_URL}?action=fundamental&code=${encodeURIComponent(D.code)}`);
      const j = await r.json();
      if (j.ok) { f = j; pcSet(_fundCache, D.code, 'fund', j, cacheUntil('post', { date: j.valDate, ok: !!j.valDate && !j.valErr && !j.revErr }, Date.now())); }
      else why = j.error || '後端沒有回傳原因';
    } catch (e) { why = String(e && e.message || e); if (typeof ErrorLog !== 'undefined') ErrorLog.push('基本面', e); }
  }
  if (window._activeCode && window._activeCode !== D.code) return;  // 已換股，丟棄遲到結果
  card.style.display = 'block';
  // v187 拿不到要講原因（原本整張卡默默消失：上櫃股看不出是「沒資料」還是「來源不支援」）
  if (!f) { document.getElementById('fundamental-content').innerHTML = `<div style="font-size:12px;color:var(--warn);line-height:1.6">⚠️ 基本面取得失敗：${escI(why)}（估值表只涵蓋上市股；上櫃股的營收來源尚未用真實回應驗證過）</div>`; return; }

  // 判讀（空方交易者視角）
  const notes = [];
  if (f.revYoY != null) {
    if (f.revYoY <= -10) notes.push({ c: 'var(--sell)', t: `營收年減 ${f.revYoY.toFixed(1)}%——基本面偏空順風：空單有基本面支持，反彈是空點不是買點` });
    else if (f.revYoY >= 20) notes.push({ c: 'var(--buy)', t: `營收年增 +${f.revYoY.toFixed(1)}%——成長強勁：做空=逆基本面，技術翻空也要快進快出別戀戰` });
  }
  if (f.pe != null && f.pe > 0) {
    if (f.pe >= 40) notes.push({ c: 'var(--warn)', t: `本益比 ${f.pe.toFixed(1)} 偏高——估值進入泡沫語境，若同時過熱/擁擠，大跌燃料充足` });
    else if (f.pe <= 10) notes.push({ c: 'var(--muted)', t: `本益比 ${f.pe.toFixed(1)} 偏低——便宜不是買進理由（可能是價值陷阱），但重挫後支撐較實` });
  } else if (f.pe === 0) {
    notes.push({ c: 'var(--sell)', t: '本益比無法計算（虧損中）——虧損股是空方的基本面獵物，但也最容易暴力軋空，嚴設停損' });
  }
  if (f.dividendYield != null && f.dividendYield >= 5) {
    notes.push({ c: 'var(--warn)', t: `殖利率 ${f.dividendYield.toFixed(1)}%——空單跨除息日要付股息（成本），留意除息時程` });
  }

  const box = (label, val, sub) => `<div class="risk-box"><div class="rb-label">${label}</div><div class="rb-value">${val}</div><div class="rb-sub">${sub}</div></div>`;
  let html = `<div class="risk-grid">
    ${box('📈 月營收 YoY', f.revYoY != null ? (f.revYoY >= 0 ? '+' : '') + f.revYoY.toFixed(1) + '%' : '—', f.revMonth ? '資料月份 ' + f.revMonth : '去年同月比')}
    ${f.valErr ? `<div style="grid-column:1/-1;font-size:10px;color:var(--warn);margin-top:2px">⚠️ 估值抓不到：${escI(f.valErr)}</div>` : ''}
    ${f.revErr ? `<div style="grid-column:1/-1;font-size:10px;color:var(--warn);margin-top:2px">⚠️ 月營收抓不到：${escI(f.revErr)}</div>` : ''}
    ${f.valDate ? `<div style="grid-column:1/-1;font-size:9px;color:var(--muted2);margin-top:2px">估值(PE/PB/殖利率)資料日：${String(f.valDate).slice(4,6)}/${String(f.valDate).slice(6,8)}${(() => { try { const fr = (typeof checkDataFreshness === 'function') ? checkDataFreshness(f.valDate, 0) : null; return (fr && fr.stale) ? ` <span style="color:var(--sell)">⚠️ 落後約${fr.gapDays}個交易日</span>` : ''; } catch (e) { return ''; } })()}</div>` : ''}
    ${box('📊 月營收 MoM', f.revMoM != null ? (f.revMoM >= 0 ? '+' : '') + f.revMoM.toFixed(1) + '%' : '—', '上月比較')}
    ${box('💰 本益比', f.pe != null && f.pe > 0 ? f.pe.toFixed(1) : (f.pe === 0 ? '虧損' : '—'), 'PE')}
    ${box('🏦 股價淨值比', f.pb != null && f.pb > 0 ? f.pb.toFixed(2) : '—', 'PB')}
  </div>`;
  if (f.dividendYield != null && f.dividendYield > 0) html += `<div style="font-size:11px;color:var(--muted);margin-top:8px">殖利率 ${f.dividendYield.toFixed(2)}%</div>`;
  notes.forEach(x => { html += `<div style="margin-top:8px;padding:9px 12px;background:${x.c}10;border:1px solid ${x.c}50;border-radius:8px;font-size:11px;color:var(--muted);line-height:1.6">${x.t}</div>`; });
  html += `<div style="font-size:10px;color:var(--muted2);margin-top:10px;line-height:1.6">💡 基本面在波段層級是「背景濾網」不是進出場訊號：避免逆重大基本面做單、放大泡沫判斷。台股月營收每月10日前公布，常是行情引爆點。資料：證交所 BWIBBU / 月營收彙總。</div>`;
  document.getElementById('fundamental-content').innerHTML = html;
}

/* ══ 圖形線位引擎：趨勢線/通道/箱型/三角收斂/頸線 ═══════════════════════
   定位（重要）：這是「線位工具」不是「方向預測」——19年5055事件已證明純價格
   方向訊號α≈0，本引擎只回答「市場共同看到的線在哪個價位」（Lo, Mamaysky &
   Wang 2000：型態提供增量資訊而非獲利保證）。線位價值：①可下單的具體價位
   （突破觸發/停損擺放）②與反明牌整合——人人看得到的線=停損聚集區易被掃。
   全部使用未還原原始市價（下單價位鐵律）。
   ════════════════════════════════════════════════════════════════════ */
/* ══ 【區塊 G】圖形線位引擎 ═══════════════════════════════════════════
   趨勢線/通道/箱型/三角收斂/M頭W底頸線 → 回傳「今日的線位價格」
   ⚠️ 定位是線位工具，非方向預測（19年7,908事件已證純價格方向訊號α≈0）
   ⚠️ 全程用原始市價（可下單價位鐵律）；容差 tol 為 ATR 自適應，勿改固定%
   ⚠️ 本函式被 bingfa.js 的執行計畫引用（停損×線位重疊偵測），改回傳結構
      須同步檢查該處
   ⚠️ 此檔案為 str_replace 高風險區（曾4次誤刪 catch），長函式編輯建議先
      view 確認 try-catch 邊界
   ════════════════════════════════════════════════════════════════════ */
function computeChartPatterns(D) {
  const c = D.rawCloses || D.closes, h = D.rawHighs || D.highs, l = D.rawLows || D.lows;
  const n = c.length;
  if (n < 60) return null;
  const price = c[n - 1];
  const N = Math.min(120, n);
  const off = n - N;   // 只看近120日
  // ATR%容差（線觸碰判定）
  let tr = 0; for (let i = n - 20; i < n; i++) tr += Math.abs(c[i] - c[i - 1]) / c[i - 1];
  const tol = Math.max(0.008, (tr / 20) * 1.5);   // 至少0.8%

  // ── 轉折點（與支撐壓力同款5點法，帶索引）──
  const pivH = [], pivL = [];
  for (let i = off + 2; i < n - 2; i++) {
    if (h[i] > h[i-1] && h[i] > h[i-2] && h[i] > h[i+1] && h[i] > h[i+2]) pivH.push({ i, p: h[i] });
    if (l[i] < l[i-1] && l[i] < l[i-2] && l[i] < l[i+1] && l[i] < l[i+2]) pivL.push({ i, p: l[i] });
  }
  if (pivH.length < 2 && pivL.length < 2) return null;
  const out = [];
  const lineVal = (a, b, x) => a.p + (b.p - a.p) / (b.i - a.i) * (x - a.i);
  /* v184：數「另外幾次」回到線上——連續貼線的K棒算同一次，含兩個定線轉折點的那兩次不算。
     原本逐根計數：轉折點本身＋旁邊幾根幾乎一定貼線，實測 840 條上升線有 833 條顯示「另有N次觸碰確認」，其中 327 條其實一次都沒有 */
  const touches = (a, b, isLow) => {
    let t = 0, run = false, pivot = false;
    for (let i = a.i; i <= n; i++) {
      const hit = i < n && Math.abs((isLow ? l[i] : h[i]) - lineVal(a, b, i)) / lineVal(a, b, i) < tol;
      if (hit) { run = true; if (i === a.i || i === b.i) pivot = true; }
      else if (run) { if (!pivot) t++; run = false; pivot = false; }
    }
    return t;
  };

  // ── 趨勢線：最近兩個「遞升低點」=上升趨勢線；「遞降高點」=下降趨勢線 ──
  let upLine = null, dnLine = null;
  for (let k = pivL.length - 1; k >= 1 && !upLine; k--) {
    for (let j = k - 1; j >= 0; j--) {
      if (pivL[j].p < pivL[k].p && pivL[k].i - pivL[j].i >= 8) {
        upLine = { a: pivL[j], b: pivL[k], t: touches(pivL[j], pivL[k], true) }; break;
      }
    }
  }
  for (let k = pivH.length - 1; k >= 1 && !dnLine; k--) {
    for (let j = k - 1; j >= 0; j--) {
      if (pivH[j].p > pivH[k].p && pivH[k].i - pivH[j].i >= 8) {
        dnLine = { a: pivH[j], b: pivH[k], t: touches(pivH[j], pivH[k], false) }; break;
      }
    }
  }
  const nearTxt = (v) => {
    const d = (price - v) / v * 100;
    const ad = Math.abs(d);
    return ad < tol * 100 ? `⚡現價正在線上（${d >= 0 ? '+' : ''}${d.toFixed(1)}%）` : d > 0 ? `線在下方 ${ad.toFixed(1)}%（支撐性質）` : `線在上方 ${ad.toFixed(1)}%（壓力性質）`;
  };
  const conf = t => t ? `另有${t}次回到線上確認` : '只由兩個轉折點連成、尚未經第三次觸碰確認';
  if (upLine) {
    const v = lineVal(upLine.a, upLine.b, n - 1);
    if (v > 0 && v < price * 1.3) out.push({ kind: '上升趨勢線', level: v, confirmed: upLine.t > 0, note: `${conf(upLine.t)}，${nearTxt(v)}。跌破此線=結構轉弱訊號，也是多單停損參考位（注意：人人看得到的線，破線常先掃停損再反轉）` });
  }
  if (dnLine) {
    const v = lineVal(dnLine.a, dnLine.b, n - 1);
    if (v > 0 && v > price * 0.7) out.push({ kind: '下降趨勢線', level: v, confirmed: dnLine.t > 0, note: `${conf(dnLine.t)}，${nearTxt(v)}。帶量站上此線=結構轉強訊號（突破需量能配合，無量突破多為假突破）` });
  }
  // ── 通道：趨勢線+對側平行線 ──
  if (upLine) {
    const slope = (upLine.b.p - upLine.a.p) / (upLine.b.i - upLine.a.i);
    let maxDev = 0;
    for (let i = upLine.a.i; i < n; i++) { const d = h[i] - (upLine.a.p + slope * (i - upLine.a.i)); if (d > maxDev) maxDev = d; }
    const top = lineVal(upLine.a, upLine.b, n - 1) + maxDev;
    if (maxDev > 0 && top > price) out.push({ kind: '上升通道頂', level: top, confirmed: upLine.t > 0, note: `通道上緣（壓力），觸及常見獲利了結；通道操作=下緣買上緣賣，突破上緣才是加速` });
  }

  // ── 箱型整理：近40日高低點各自「走平」（斜率相對價格<0.05%/日）──
  {
    const M = Math.min(40, N);
    const hs = h.slice(n - M), ls = l.slice(n - M);
    const hMax = Math.max(...hs), lMin = Math.min(...ls);
    const range = (hMax - lMin) / price * 100;
    // 用前半/後半極值比較判斷走平
    const hs1 = Math.max(...hs.slice(0, M >> 1)), hs2 = Math.max(...hs.slice(M >> 1));
    const ls1 = Math.min(...ls.slice(0, M >> 1)), ls2 = Math.min(...ls.slice(M >> 1));
    const flatTop = Math.abs(hs2 - hs1) / price < 0.02, flatBot = Math.abs(ls2 - ls1) / price < 0.02;
    if (flatTop && flatBot && range < 15 && range > 3) {
      out.push({ kind: '箱型整理', level: hMax, level2: lMin, note: `近${M}日箱頂 ${fmt(hMax)}／箱底 ${fmt(lMin)}（幅度${range.toFixed(1)}%）。箱內高賣低買；帶量突破箱頂/跌破箱底才是方向啟動，量度目標≈箱高一倍` });
    } else if (flatTop && !flatBot && ls2 > ls1) {
      out.push({ kind: '上升三角（頸線）', level: hMax, note: `水平壓力 ${fmt(hMax)} + 低點墊高=買方漸強的收斂。帶量突破水平線為經典訊號，假突破率也高（人人在看），突破回測不破再確認更穩` });
    } else if (flatBot && !flatTop && hs2 < hs1) {
      out.push({ kind: '下降三角（頸線）', level: lMin, note: `水平支撐 ${fmt(lMin)} + 高點降低=賣方漸強的收斂。跌破水平線為經典弱勢訊號，但注意破線掃停損後回穩的假跌破` });
    }
  }

  // ── 對稱三角收斂：高點遞降+低點遞升同時成立 ──
  if (upLine && dnLine && upLine.b.i > n - 45 && dnLine.b.i > n - 45) {
    const uV = lineVal(upLine.a, upLine.b, n - 1), dV = lineVal(dnLine.a, dnLine.b, n - 1);
    if (dV > uV && (dV - uV) / price < 0.10) {
      // 收斂中：算頂點距離
      const uS = (upLine.b.p - upLine.a.p) / (upLine.b.i - upLine.a.i);
      const dS = (dnLine.b.p - dnLine.a.p) / (dnLine.b.i - dnLine.a.i);
      const apexDays = (uS - dS) !== 0 ? Math.round((dV - uV) / (uS - dS)) : 99;
      if (apexDays > 0 && apexDays < 60) out.push({ kind: '三角收斂', level: dV, level2: uV, note: `上緣 ${fmt(dV)}／下緣 ${fmt(uV)}，約 ${apexDays} 個交易日內收斂到頂點——波動壓縮接近尾聲，突破方向常伴隨動能釋放（方向本身不可預測，等突破確認+量能）` });
    }
  }

  // ── 頸線：雙重頂/雙重底 ──
  {
    const HH = pivH.slice(-3), LL = pivL.slice(-3);
    if (HH.length >= 2) {
      const [x, y] = HH.slice(-2);
      if (Math.abs(x.p - y.p) / y.p < 0.03 && y.i - x.i >= 10) {
        const valley = Math.min(...l.slice(x.i, y.i + 1));
        if (price > valley && price < y.p * 1.02) out.push({ kind: 'M頭頸線（潛在）', level: valley, note: `兩高點 ${fmt(x.p)}/${fmt(y.p)} 相近，頸線=中間低點 ${fmt(valley)}。跌破頸線才算型態成立（量度跌幅≈頭高），未破前只是雙高不是M頭` });
      }
    }
    if (LL.length >= 2) {
      const [x, y] = LL.slice(-2);
      if (Math.abs(x.p - y.p) / y.p < 0.03 && y.i - x.i >= 10) {
        const peak = Math.max(...h.slice(x.i, y.i + 1));
        if (price < peak && price > y.p * 0.98) out.push({ kind: 'W底頸線（潛在）', level: peak, note: `兩低點 ${fmt(x.p)}/${fmt(y.p)} 相近，頸線=中間高點 ${fmt(peak)}。帶量突破頸線才算W底成立（量度漲幅≈底深），未破前只是雙低` });
      }
    }
  }

  return out.length ? { patterns: out, tol: Math.round(tol * 1000) / 10 } : null;
}
