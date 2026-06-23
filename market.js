/* ══════════════════════════════════════════════════════════════════════
   market.js — 第⓪層 大盤環境
   抓：外資/法人台指期未平倉、PCR、美股隔夜(SOX/Nasdaq/S&P)
   依賴：config.js(GAS_URL)、app.js(fmt/fmtV/$)
   純顯示數據，不干涉個股買賣燈號
   ══════════════════════════════════════════════════════════════════════ */

async function fetchMarket() {
  if (!GAS_URL || GAS_URL.indexOf('http') !== 0) return null;
  try {
    const r = await fetch(`${GAS_URL}?action=market`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.ok ? j : null;
  } catch (e) {
    if (typeof ErrorLog !== 'undefined') ErrorLog.push('fetchMarket', e);
    return null;
  }
}

function renderMarket(m) {
  if (!m) { $('market-card').style.display = 'none'; return; }
  $('market-card').style.display = 'block';
  const boxes = [];
  const t = m.taifex || {}, us = m.us || {};

  // 外資台指期未平倉
  if (t.foreignNet != null) {
    const long = t.foreignNet > 0;
    boxes.push({ cls: long ? 'good' : '', label: '🏦 外資台指期淨未平倉',
      value: `${t.foreignNet > 0 ? '+' : ''}${fmtV(t.foreignNet)} 口`, valCls: long ? 'buy' : 'sell',
      sub: `${long ? '淨多單，外資偏多佈局' : '淨空單，外資偏空避險'}${t.date ? '｜' + t.date : ''}` });
  }
  // 三大法人合計
  if (t.institutionNet != null) {
    const long = t.institutionNet > 0;
    boxes.push({ cls: long ? 'good' : '', label: '🏛️ 三大法人台指期淨額',
      value: `${t.institutionNet > 0 ? '+' : ''}${fmtV(t.institutionNet)} 口`, valCls: long ? 'buy' : 'sell',
      sub: `${long ? '法人整體偏多' : '法人整體偏空'}（僅供環境參考）` });
  }
  // PCR
  if (t.pcrOI != null && t.pcrOI > 0) {
    const pcr = t.pcrOI;
    let tone = 'warn', desc;
    if (pcr > 120) { tone = 'good'; desc = `PCR ${pcr.toFixed(0)}% 偏高，賣權避險濃，散戶恐慌，常為反指標（物極必反偏多）`; }
    else if (pcr < 80) { tone = ''; desc = `PCR ${pcr.toFixed(0)}% 偏低，市場樂觀，留意過熱`; }
    else { desc = `PCR ${pcr.toFixed(0)}%，選擇權多空情緒中性`; }
    boxes.push({ cls: tone, label: '⚖️ PCR 賣權買權比(未平倉)', value: `${pcr.toFixed(0)}%`, valCls: tone === 'good' ? 'buy' : 'warn', sub: desc });
  }
  // 美股隔夜
  const usItem = (label, icon, d, note) => {
    if (!d) return;
    const up = d.changePct >= 0;
    boxes.push({ cls: up ? 'good' : '', label: `${icon} ${label}（隔夜）`,
      value: `${up ? '+' : ''}${d.changePct.toFixed(2)}%`, valCls: up ? 'buy' : 'sell',
      sub: `收 ${fmt(d.price)}｜${note}` });
  };
  usItem('費城半導體 SOX', '🔌', us.sox, '對台積電/聯發科等連動高');
  usItem('那斯達克', '💻', us.nasdaq, '對台股科技股連動');
  usItem('標普 500', '📊', us.sp500, '美股大盤氣氛');

  if (boxes.length === 0) { $('market-card').style.display = 'none'; return; }
  $('market-grid').innerHTML = boxes.map(x =>
    `<div class="risk-box ${x.cls}"><div class="rb-label">${x.label}</div><div class="rb-value ${x.valCls}">${x.value}</div><div class="rb-sub">${x.sub}</div></div>`
  ).join('');
}
