/* ══════════════════════════════════════════════════════════════════════
   advanced.js — 法人等級進階分析（市場→產業→個股 三層）
   ──────────────────────────────────────────────────────────────────
   A. RS Rating 相對強弱評級（vs 大盤，O'Neil 法）
   B. Beta / Alpha（個股 vs 大盤回歸）
   C. 機率預測（取代買賣燈，改顯示上漲機率%）
   D. 支撐壓力自動辨識
   E. 量價異常雷達
   F. 市場情緒儀表板（融資融券+VIX+PCR 合成）
   依賴：app.js($/fmt/fmtV)、quant.js(signalsAtIndex)
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

/* ── 大盤基準快取（避免每檔都重抓）─────────────────────────────────── */
let _benchCache = { tw: null, us: null, time: 0 };
async function fetchBenchmark(isTW) {
  const key = isTW ? 'tw' : 'us';
  // 快取 10 分鐘
  if (_benchCache[key] && (Date.now() - _benchCache.time < 600000)) return _benchCache[key];
  if (!GAS_URL || GAS_URL.indexOf('http') !== 0) return null;
  try {
    const r = await fetch(`${GAS_URL}?action=benchmark&market=${key}`);
    const j = await r.json();
    if (j.ok && j.closes) {
      _benchCache[key] = j.closes;
      _benchCache.time = Date.now();
      return j.closes;
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
function computeRSRating(D, benchReturn) {
  const c = D.closes;
  const n = c.length;
  // 個股報酬（加權近期：近63日權重高）
  const ret = (period) => {
    if (n <= period) return (c[n-1] - c[0]) / c[0];
    return (c[n-1] - c[n-1-period]) / c[n-1-period];
  };
  // O'Neil 加權：近一季 ×2 + 近半年 + 近一年
  const r63 = ret(63), r126 = ret(126), r252 = ret(252);
  const weighted = (r63 * 2 + r126 + r252) / 4;

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
  else if (rs.rating >= 50) desc = `中等強度，與大盤同步`;
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

/* ══ C. 機率預測（取代買賣燈）════════════════════════════════════════
   用多週期回測的上漲機率，直接顯示 % 而非買賣燈
   ════════════════════════════════════════════════════════════════════ */
function computeProbability(D) {
  const periods = [5, 10, 20];
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes;
  const n = c.length;
  const results = [];
  // 當前訊號只算一次（原本誤放在迴圈內，每根K棒重複計算 → 效能浪費）
  const curSigOnce = signalsAtIndex(c, h, l, v, n-1);
  const curBuysN = curSigOnce ? Object.values(curSigOnce).filter(s=>s==='buy').length : 0;
  const curSellsN = curSigOnce ? Object.values(curSigOnce).filter(s=>s==='sell').length : 0;
  const curBull = curBuysN > curSellsN;
  for (const horizon of periods) {
    let upCount = 0, total = 0;
    if (!curSigOnce) { results.push({ horizon, prob: null, samples: 0 }); continue; }
    for (let i = 60; i < n - horizon; i++) {
      const sig = signalsAtIndex(c, h, l, v, i);
      if (!sig) continue;
      const vals = Object.values(sig);
      const buys = vals.filter(s => s === 'buy').length;
      const sells = vals.filter(s => s === 'sell').length;
      // 只統計與當前同向的歷史情境
      if ((curBull && buys > sells) || (!curBull && sells > buys)) {
        total++;
        const fut = (c[i+horizon] - c[i]) / c[i];
        if (curBull ? fut > 0 : fut < 0) upCount++;
      }
    }
    const prob = total >= 5 ? upCount/total : null;  // 最小樣本 3→5：3筆算出的機率統計上沒意義
    results.push({ horizon, prob, samples: total });
  }
  // 當前方向
  const curSig = signalsAtIndex(c, h, l, v, n-1);
  const cb = curSig ? Object.values(curSig).filter(s=>s==='buy').length : 0;
  const cs = curSig ? Object.values(curSig).filter(s=>s==='sell').length : 0;
  return { results, direction: cb > cs ? 'up' : cb < cs ? 'down' : 'neutral' };
}

function renderProbability(p) {
  const card = document.getElementById('prob-card');
  if (!p || p.results.every(r => r.prob === null)) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const dirText = p.direction === 'up' ? '上漲' : p.direction === 'down' ? '下跌' : '盤整';
  document.getElementById('prob-dir').textContent = `當前訊號偏「${dirText}」，歷史相似情境的${dirText}機率：`;
  const rows = p.results.map(r => {
    const pct = r.prob != null ? (r.prob*100).toFixed(0)+'%' : '樣本不足';
    const col = r.prob == null ? 'var(--muted)' : r.prob >= 0.6 ? 'var(--buy)' : r.prob >= 0.5 ? 'var(--warn)' : 'var(--sell)';
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd)">
      <span style="font-family:var(--mono);font-size:13px;width:46px">${r.horizon}日</span>
      <div style="flex:1;height:8px;background:var(--bd);border-radius:99px;overflow:hidden"><div style="height:100%;width:${r.prob!=null?r.prob*100:0}%;background:${col}"></div></div>
      <span style="font-family:var(--mono);font-size:15px;font-weight:700;color:${col};width:54px;text-align:right">${pct}</span>
      <span style="font-size:9px;color:var(--muted);width:48px;text-align:right">${r.samples}樣本</span>
    </div>`;
  }).join('');
  document.getElementById('prob-rows').innerHTML = rows;
}

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
  const cur = '';
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
        html3 += `<div style="font-size:9px;color:var(--muted2);line-height:1.5">線位=可下單的具體價位（突破觸發/停損擺放），非方向預測（19年7,908事件已證純價格方向訊號α≈0）。人人看得到的線=停損聚集區，突破/跌破常先掃停損，等回測確認更穩。${fbTxt}</div></div>`;
        document.getElementById('sr-content').innerHTML += html3;
      }
    }
  } catch (e) { /* 略過，不影響主卡片 */ }
}

/* ══ E. 量價異常雷達 ══════════════════════════════════════════════════ */
function computeVolPriceRadar(D) {
  const c = D.closes, v = D.volumes, h = D.highs;
  const price = D.price, prevClose = D.prevClose;
  const alerts = [];
  if (v.length < 6) return alerts;

  const vr = v[v.length-1] / (v.slice(-6,-1).reduce((a,b)=>a+b,0)/5);
  const chgPct = (price - prevClose) / prevClose * 100;

  // 量增價未漲 → 出貨疑慮
  if (vr > 2.5 && Math.abs(chgPct) < 1.5) {
    alerts.push({ type:'warn', icon:'⚠️', title:`量增 ${vr.toFixed(1)}倍 但僅漲跌 ${chgPct.toFixed(1)}%`,
      desc:'爆量卻沒推動股價，可能是高檔出貨或換手，留意主力動向' });
  }
  // 量縮創高 → 上攻動能不足
  const recentHigh = Math.max(...h.slice(-20, -1));
  if (price > recentHigh && vr < 0.8) {
    alerts.push({ type:'warn', icon:'⚠️', title:'量縮創新高',
      desc:'價格創高但量能萎縮，買盤接手意願低，上攻動能不足，留意假突破' });
  }
  // 放量大漲 → 健康攻擊
  if (vr > 1.8 && chgPct > 3) {
    alerts.push({ type:'good', icon:'🚀', title:`放量大漲 ${chgPct.toFixed(1)}%（量 ${vr.toFixed(1)}倍）`,
      desc:'量價齊揚，資金認同，屬健康攻擊型態' });
  }
  // 窒息量 → 可能變盤
  if (vr < 0.5) {
    alerts.push({ type:'warn', icon:'😴', title:`窒息量（僅均量 ${(vr*100).toFixed(0)}%）`,
      desc:'成交極度萎縮，多空觀望，常為變盤前兆，留意次日方向' });
  }
  if (alerts.length === 0) {
    alerts.push({ type:'good', icon:'✅', title:'量價關係正常', desc:'目前無明顯量價背離或異常訊號' });
  }
  return alerts;
}

function renderVolPriceRadar(alerts) {
  const card = document.getElementById('vpradar-card');
  card.style.display = 'block';
  document.getElementById('vpradar-list').innerHTML = alerts.map(a =>
    `<div class="psych-alert ${a.type==='good'?'ok':'fire'}"><span class="pa-icon">${a.icon}</span><div class="pa-body"><div class="pa-title ${a.type==='good'?'ok':'fire'}">${a.title}</div><div class="pa-desc">${a.desc}</div></div></div>`
  ).join('');
}

/* ══ 樣本外驗證（Out-of-Sample Validation）══════════════════════════
   回答「這檔股票的訊號準確率可不可信」的誠實方法：
   前70%歷史當「訓練段」、後30%當「測試段」（模型沒看過的資料）。
   訓練段命中率高但測試段掉很多 = 過擬合（歷史內漂亮、未來失效）。
   這是量化機構與散戶曲線擬合者的分水嶺。
   ════════════════════════════════════════════════════════════════════ */
function computeOOSValidation(D, horizon = 5) {
  const c = D.closes, h = D.highs, l = D.lows, v = D.volumes, n = c.length;
  if (n < 250) return null;  // 2年資料才夠切
  const split = Math.floor(n * 0.7);

  const evalRange = (from, to) => {
    let hit = 0, tot = 0;
    for (let i = from; i < to - horizon; i++) {
      const sig = signalsAtIndex(c, h, l, v, i);
      if (!sig) continue;
      const vals = Object.values(sig);
      const buys = vals.filter(s => s === 'buy').length;
      const sells = vals.filter(s => s === 'sell').length;
      if (buys === sells) continue;  // 無方向不計
      const dir = buys > sells ? 1 : -1;
      tot++;
      const fut = c[i + horizon] - c[i];
      if ((dir === 1 && fut > 0) || (dir === -1 && fut < 0)) hit++;
    }
    return { rate: tot ? hit / tot : null, n: tot };
  };

  const train = evalRange(60, split);
  const test = evalRange(split, n);
  if (train.rate == null || test.rate == null) return null;

  const drop = (train.rate - test.rate) * 100;
  let verdict, vClass;
  if (test.n < 20) { verdict = '測試樣本不足，無法下結論'; vClass = 'warn'; }
  else if (test.rate >= 0.55 && drop <= 10) { verdict = '樣本外仍有效——此股的技術訊號有實際參考價值'; vClass = 'buy'; }
  else if (drop > 12) { verdict = '過擬合警訊——歷史內漂亮但沒看過的資料上失效，此股技術訊號別重壓'; vClass = 'sell'; }
  else if (test.rate >= 0.45 && test.rate < 0.55) { verdict = '樣本外接近擲硬幣——此股技術訊號參考價值低，決策改倚重籌碼/主力/融資維度'; vClass = 'warn'; }
  else if (test.rate < 0.45) { verdict = '樣本外反向——此股訊號甚至略帶反指標性質，多空判斷需極度保守'; vClass = 'sell'; }
  else { verdict = '樣本外普通——訊號可參考但需其他維度共振確認'; vClass = 'warn'; }

  // Walk-Forward：3個滾動窗（比單一70/30切分更嚴謹，避免「切點剛好落在好時機」的偶然性）
  // 2年資料切成4段，依序 [60%訓練→接續20%測試] 滾動3次
  let wf = null;
  if (n >= 400) {
    const segLen = Math.floor((n - 60) / 4);
    const windows = [];
    for (let w = 0; w < 3; w++) {
      const trainFrom = 60 + w * segLen, trainTo = trainFrom + segLen * 2;
      const testTo = trainTo + segLen;
      if (testTo > n) break;
      const tr = evalRange(trainFrom, trainTo), te = evalRange(trainTo, testTo);
      if (tr.rate != null && te.rate != null && te.n >= 5) windows.push({ train: tr.rate, test: te.rate, n: te.n });
    }
    if (windows.length >= 2) {
      const avgTest = windows.reduce((a, x) => a + x.test, 0) / windows.length;
      const consistent = windows.every(x => x.test >= 0.40);  // 沒有任何一段崩到反指標區
      wf = { windows, avgTest, consistent };
    }
  }

  return { train, test, drop, verdict, vClass, horizon, wf };
}

function renderOOS(D) {
  const card = document.getElementById('oos-card');
  if (!card) return;
  const o = computeOOSValidation(D);
  if (!o) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const colMap = { buy: 'var(--buy)', warn: 'var(--warn)', sell: 'var(--sell)' };
  const col = colMap[o.vClass];
  const bar = (label, r, c2) => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="font-size:11px;width:110px;color:var(--muted)">${label}</span>
      <div style="flex:1;height:8px;background:var(--bd);border-radius:99px;overflow:hidden"><div style="height:100%;width:${(r.rate*100).toFixed(0)}%;background:${c2}"></div></div>
      <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${c2};width:46px;text-align:right">${(r.rate*100).toFixed(1)}%</span>
      <span style="font-size:9px;color:var(--muted2);width:52px;text-align:right">${r.n}樣本</span>
    </div>`;
  document.getElementById('oos-content').innerHTML = `
    ${bar('訓練段（前70%歷史）', o.train, 'var(--acc)')}
    ${bar('測試段（後30%未見過）', o.test, col)}
    <div style="margin-top:10px;padding:10px 12px;background:${col}10;border:1px solid ${col}50;border-radius:9px;font-size:12px;font-weight:600;color:${col};line-height:1.6">${o.verdict}</div>
    ${o.wf ? `
    <div style="margin-top:12px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Walk-Forward 滾動驗證（${o.wf.windows.length}個時段，比單一切分更嚴謹）</div>
    ${o.wf.windows.map((w,i)=>`<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:11px;color:var(--muted)"><span style="width:50px">時段${i+1}</span><span style="font-family:var(--mono);color:${w.test>=0.5?'var(--buy)':'var(--sell)'}">${(w.test*100).toFixed(0)}%</span><span style="color:var(--muted2)">(${w.n}樣本)</span></div>`).join('')}
    <div style="font-size:11px;color:${o.wf.consistent?'var(--buy)':'var(--warn)'};margin-top:4px">${o.wf.consistent?'✓ 各時段皆未崩至反指標區間，訊號較穩健':'⚠️ 部分時段測試命中率過低，訊號穩健度不足'}（平均 ${(o.wf.avgTest*100).toFixed(1)}%）</div>
    ` : ''}
    <div style="font-size:10px;color:var(--muted2);margin-top:8px;line-height:1.6">💡 訓練段=用來「學」的歷史；測試段=模型沒看過的近期資料，最接近「未來」。兩段差距小且測試段>55% 才代表訊號真的有預測力（${o.horizon}日方向命中率，含各50%的隨機基準）。這是誠實的準確率，不是樣本內的漂亮數字。</div>`;
}

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
  let f = null;
  const hit = _fundCache[D.code];
  if (hit && Date.now() - hit.t < 600000) f = hit.d;
  else {
    try {
      const r = await fetch(`${GAS_URL}?action=fundamental&code=${encodeURIComponent(D.code)}`);
      const j = await r.json();
      if (j.ok) { f = j; _fundCache[D.code] = { d: j, t: Date.now() }; }
    } catch (e) { if (typeof ErrorLog !== 'undefined') ErrorLog.push('基本面', e); }
  }
  if (window._activeCode && window._activeCode !== D.code) return;  // 已換股，丟棄遲到結果
  if (!f) { card.style.display = 'none'; return; }
  card.style.display = 'block';

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
  const touches = (a, b, arr, isLow) => {
    let t = 0;
    for (let i = a.i; i < n; i++) {
      const v = lineVal(a, b, i), ref = isLow ? l[i] : h[i];
      if (Math.abs(ref - v) / v < tol) t++;
    }
    return t;
  };

  // ── 趨勢線：最近兩個「遞升低點」=上升趨勢線；「遞降高點」=下降趨勢線 ──
  let upLine = null, dnLine = null;
  for (let k = pivL.length - 1; k >= 1 && !upLine; k--) {
    for (let j = k - 1; j >= 0; j--) {
      if (pivL[j].p < pivL[k].p && pivL[k].i - pivL[j].i >= 8) {
        const t = touches(pivL[j], pivL[k], l, true);
        if (t >= 2) { upLine = { a: pivL[j], b: pivL[k], t }; break; }
      }
    }
  }
  for (let k = pivH.length - 1; k >= 1 && !dnLine; k--) {
    for (let j = k - 1; j >= 0; j--) {
      if (pivH[j].p > pivH[k].p && pivH[k].i - pivH[j].i >= 8) {
        const t = touches(pivH[j], pivH[k], h, false);
        if (t >= 2) { dnLine = { a: pivH[j], b: pivH[k], t }; break; }
      }
    }
  }
  const nearTxt = (v) => {
    const d = (price - v) / v * 100;
    const ad = Math.abs(d);
    return ad < tol * 100 ? `⚡現價正在線上（${d >= 0 ? '+' : ''}${d.toFixed(1)}%）` : d > 0 ? `線在下方 ${ad.toFixed(1)}%（支撐性質）` : `線在上方 ${ad.toFixed(1)}%（壓力性質）`;
  };
  if (upLine) {
    const v = lineVal(upLine.a, upLine.b, n - 1);
    if (v > 0 && v < price * 1.3) out.push({ kind: '上升趨勢線', level: v, note: `${upLine.t}次觸碰確認，${nearTxt(v)}。跌破此線=結構轉弱訊號，也是多單停損參考位（注意：人人看得到的線，破線常先掃停損再反轉）` });
  }
  if (dnLine) {
    const v = lineVal(dnLine.a, dnLine.b, n - 1);
    if (v > 0 && v > price * 0.7) out.push({ kind: '下降趨勢線', level: v, note: `${dnLine.t}次觸碰確認，${nearTxt(v)}。帶量站上此線=結構轉強訊號（突破需量能配合，無量突破多為假突破）` });
  }
  // ── 通道：趨勢線+對側平行線 ──
  if (upLine) {
    const slope = (upLine.b.p - upLine.a.p) / (upLine.b.i - upLine.a.i);
    let maxDev = 0;
    for (let i = upLine.a.i; i < n; i++) { const d = h[i] - (upLine.a.p + slope * (i - upLine.a.i)); if (d > maxDev) maxDev = d; }
    const top = lineVal(upLine.a, upLine.b, n - 1) + maxDev;
    if (maxDev > 0 && top > price) out.push({ kind: '上升通道頂', level: top, note: `通道上緣（壓力），觸及常見獲利了結；通道操作=下緣買上緣賣，突破上緣才是加速` });
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
