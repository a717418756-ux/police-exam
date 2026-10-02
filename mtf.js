/* ══════════════════════════════════════════════════════════════════════
   mtf.js — 多時間框架共振 + 波動壓縮指數
   ──────────────────────────────────────────────────────────────────
   A. MTF：日K重採樣出週K/月K，「週線定方向、日線找進場」
      權重：月30% / 週40% / 日30%（無分時資料，60分框架不做）
   C. 壓縮指數：布林帶寬歷史百分位，極度壓縮 = 大變盤前兆
   依賴：app.js(sma)
   資料需求：後端已改抓 2 年日K（月線重採樣約 24 根）
   ──────────────────────────────────────────────────────────────────
   函式清單：
     resampleTF / tfTrendScore — 週期重採樣 + 單週期趨勢分
     computeMTF / renderMTF     — 多時間框架共振主體
     computeCompression         — 布林帶寬歷史百分位（壓縮指數）
   ⚠️ 已知地雷／注意事項：
     - computeMTF回傳的mtf.dir/mtf.total被bingfa.js決策橫幅與行為推理鏈
       引用（v78起renderVerdictBanner第8參數即為mtf），修改回傳結構
       須同步檢查呼叫端解構賦值是否對應
   ══════════════════════════════════════════════════════════════════════ */
/* v163 檔案版本宣告：讓前端能查出「站上哪個檔案沒更新到」。
   改這個檔時一併把數字改成當版；config.js 的 FILE_VERS 必須同步（自我檢查會擋）。 */
try { (window.SR_FV = window.SR_FV || {})['mtf.js'] = 188; } catch (e) {}

/* ── 重採樣：日K → 週K(5日) / 月K(21日) ──────────────────────────── */
function resampleTF(D, size) {
  const c = D.closes, h = D.highs, l = D.lows, n = c.length;
  const out = { closes: [], highs: [], lows: [] };
  for (let end = n; end > 0; end -= size) {
    const s = Math.max(0, end - size);
    out.closes.unshift(c[end - 1]);
    out.highs.unshift(Math.max(...h.slice(s, end)));
    out.lows.unshift(Math.min(...l.slice(s, end)));
  }
  return out;
}

/* ── 單一時間框架趨勢分（0~100）───────────────────────────────────── */
function tfTrendScore(closes, price) {
  const n = closes.length;
  if (n < 6) return { score: 50, note: '資料不足' };
  const maN = (k) => { const s = closes.slice(-Math.min(k, n)); return s.reduce((a, b) => a + b, 0) / s.length; };
  const ma10 = maN(10), ma20 = maN(20);
  let score, note;
  if (price > ma10 && ma10 > ma20) { score = 88; note = '多頭排列'; }
  else if (price > ma10) { score = 68; note = '站上均線'; }
  else if (price < ma10 && ma10 < ma20) { score = 12; note = '空頭排列'; }
  else if (price < ma10) { score = 32; note = '跌破均線'; }
  else { score = 50; note = '均線糾結'; }
  // 近3根方向微調
  if (n >= 4) {
    const up3 = closes[n-1] > closes[n-4];
    score += up3 ? 5 : -5;
  }
  return { score: Math.max(0, Math.min(100, score)), note };
}

/* ── MTF 多時間框架共振 ───────────────────────────────────────────── */
function computeMTF(D) {
  const price = D.price;
  const weekly = resampleTF(D, 5);
  const monthly = resampleTF(D, 21);
  const mScore = tfTrendScore(monthly.closes, price);
  const wScore = tfTrendScore(weekly.closes, price);
  const dScore = tfTrendScore(D.closes.slice(-120), price); // 日線用近半年

  // 加權：月30 / 週40 / 日30（週線是波段交易者的羅盤）
  const total = Math.round(mScore.score * 0.30 + wScore.score * 0.40 + dScore.score * 0.30);

  // 方向與共振判定
  const dirs = [mScore.score, wScore.score, dScore.score].map(s => s >= 60 ? 1 : s <= 40 ? -1 : 0);
  const bulls = dirs.filter(d => d === 1).length;
  const bears = dirs.filter(d => d === -1).length;
  let dir = 0, verdict, vClass;
  if (bulls === 3) { dir = 1; verdict = '三框架同步多頭（月週日全多，最強共振）'; vClass = 'buy'; }
  else if (bears === 3) { dir = -1; verdict = '三框架同步空頭（月週日全空，做空最強共振）'; vClass = 'sell'; }
  else if (bulls >= 2 && bears === 0) { dir = 1; verdict = '偏多共振（大週期多、小週期整理）'; vClass = 'buy'; }
  else if (bears >= 2 && bulls === 0) { dir = -1; verdict = '偏空共振（大週期空、小週期反彈）'; vClass = 'sell'; }
  else { verdict = '框架互相衝突（大小週期方向不一致，勝率低，觀望）'; vClass = 'warn'; }

  // 教科書型態偵測（大週期方向 + 小週期回檔 = 順勢進場點）
  let setup = null;
  if (mScore.score >= 60 && wScore.score >= 60 && dScore.score <= 45) {
    setup = { type: 'long', text: '⭐ 教科書買點型態：月週多頭+日線拉回——19年實測「多頭排列拉回」期望值與隨機進場相當（α≈0），只是較不追高' };
  } else if (mScore.score <= 40 && wScore.score <= 40 && dScore.score >= 55) {
    setup = { type: 'short', text: '⭐ 教科書空點型態：月週空頭+日線反彈——19年實測「空頭排列反彈」期望值與隨機進場相當（α≈0），只是較不追殺' };
  } else if (dScore.score >= 60 && wScore.score <= 35) {
    setup = { type: 'trap', text: '⚠️ 週線仍空但日線轉強——逆大週期的反彈，做多是搶反彈不是波段，快進快出' };
  }

  return { total, dir, verdict, vClass, setup,
    frames: [
      { name: '月線', weight: '30%', ...mScore, bars: monthly.closes.length },
      { name: '週線', weight: '40%', ...wScore, bars: weekly.closes.length },
      { name: '日線', weight: '30%', ...dScore, bars: Math.min(120, D.closes.length) }
    ] };
}

function renderMTF(D) {
  const card = document.getElementById('mtf-card');
  if (!card) return;
  card.style.display = 'block';
  const m = computeMTF(D);
  const colMap = { buy: 'var(--buy)', sell: 'var(--sell)', warn: 'var(--warn)' };
  const col = colMap[m.vClass];

  let html = `<div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
    <div style="text-align:center;min-width:70px">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">MTF總分</div>
      <div style="font-family:var(--mono);font-size:34px;font-weight:800;color:${col};line-height:1">${m.total}</div>
    </div>
    <div style="flex:1;font-size:12px;font-weight:600;color:${col};line-height:1.6">${m.verdict}</div>
  </div>`;

  m.frames.forEach(f => {
    const fc = f.score >= 60 ? 'var(--buy)' : f.score <= 40 ? 'var(--sell)' : 'var(--warn)';
    html += `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--bd)">
      <span style="font-size:12px;width:44px;color:var(--muted)">${f.name}</span>
      <span style="font-size:9px;color:var(--muted2);width:32px">${f.weight}</span>
      <div style="flex:1;height:6px;background:var(--bd);border-radius:99px;overflow:hidden"><div style="height:100%;width:${f.score}%;background:${fc}"></div></div>
      <span style="font-family:var(--mono);font-size:12px;font-weight:700;color:${fc};width:30px;text-align:right">${f.score}</span>
      <span style="font-size:10px;color:var(--muted);width:58px;text-align:right">${f.note}</span>
    </div>`;
  });

  if (m.setup) {
    const sc = m.setup.type === 'trap' ? 'var(--warn)' : m.setup.type === 'short' ? 'var(--sell)' : 'var(--buy)';
    html += `<div style="margin-top:12px;padding:10px 12px;background:${sc}12;border:1px solid ${sc}50;border-radius:8px;font-size:11px;color:var(--muted);line-height:1.6"><span style="color:${sc};font-weight:700">${m.setup.text.split('：')[0]}</span>：${m.setup.text.split('：').slice(1).join('：')}</div>`;
  }
  html += `<div style="font-size:10px;color:var(--muted2);margin-top:10px;line-height:1.5">💡 週K/月K由2年日K重採樣。法人邏輯：大週期定方向，小週期找進場——日線再漂亮，週線月線反向就別做波段。</div>`;
  document.getElementById('mtf-content').innerHTML = html;
}

/* v188 拿掉 B「貝氏機率」：極端區嚴重失準（宣稱 10～20% 實際 64%），壓縮後 LogLoss 仍劣於基準、8 檔有 7 檔較差（X 級） */

/* ══ C. 波動壓縮指數（大變盤前兆）════════════════════════════════════
   布林帶寬 / 價格，對比近120日分布的百分位。>85 = 極度壓縮
   ════════════════════════════════════════════════════════════════════ */
function computeCompression(D) {
  const c = D.closes, n = c.length;
  if (n < 60) return null;
  const bbw = (end) => {
    const s = c.slice(Math.max(0, end - 20), end);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / s.length);
    return (4 * sd) / mean;  // 上下軌寬 / 均值
  };
  const now = bbw(n);
  const hist = [];
  for (let i = Math.max(40, n - 120); i <= n; i += 2) hist.push(bbw(i));
  const tighter = hist.filter(x => x >= now).length;
  const pct = Math.round(tighter / hist.length * 100);  // 百分位：越高=現在越壓縮
  let level, desc;
  if (pct >= 85) { level = 'extreme'; desc = `帶寬壓縮度 ${pct}%（近半年最窄區間）——能量高度壓縮，通常臨近大變盤，配合量能與結構判斷突破方向`; }
  else if (pct >= 65) { level = 'high'; desc = `帶寬壓縮度 ${pct}%，波動收斂中，留意變盤`; }
  else { level = 'normal'; desc = `帶寬壓縮度 ${pct}%，波動正常`; }
  return { pct, level, desc };
}
