/* ══════════════════════════════════════════════════════════════════════
   help.js — 指標說明資料庫 + 彈出說明系統
   每個卡片右上的 ⓘ 按鈕點擊後，彈出白話解說
   比 README 更貼近操作：怎麼看、買賣怎麼判斷、注意什麼
   ══════════════════════════════════════════════════════════════════════ */

const HELP_DB = {
  // ── 自創公式 ──
  fusion: {
    title: '🔮 FUSION 融合總分',
    what: '把 STI、MFD、ECO 三個自創公式 + 崩跌風險，加權合成的最終方向分數（-100 ~ +100）。',
    how: '正數偏漲、負數偏跌，絕對值越大訊號越強。崩跌高風險時會直接壓低分數轉為避險。',
    note: '這是「綜合結論」，但不該單獨依賴。請搭配趨勢過濾與風險管理一起看。'
  },
  sti: {
    title: '📊 STI 訊號張力指數',
    what: '用統計學的 Z 分數，把 RSI、乖離、量能、波幅等不同指標標準化後加權，算出多空「張力」。',
    how: '正值＝多方力道強，負值＝空方力道強。超過 ±35 視為明確訊號。',
    note: '原創公式，市面無。用 tanh 壓縮極端值，避免單一指標暴衝失真。'
  },
  mfd: {
    title: '📐 MFD 動量流變導數',
    what: '用微積分的一階導數（速度）和二階導數（加速度）分析價格動能變化。',
    how: '關鍵看加速度：價格還在漲但加速度轉負 → 上漲動能衰竭，常是轉折前兆。',
    note: '專抓「漲不動」的頂部訊號，這是看單純指標數值看不出來的。'
  },
  eco: {
    title: '🌀 ECO 熵能轉折指標',
    what: '用資訊論的夏農熵，衡量近期漲跌分布的「混亂度」。',
    how: 'ECO 越高代表趨勢越明確（混沌收斂）；由低轉高常是突破前兆。',
    note: '盤整時熵高（方向亂），趨勢明確時熵低。可預示大波動即將出現。'
  },
  crash: {
    title: '🚨 崩跌預警',
    what: '專為「大跌前警示」設計，需多個空方因子同時成立才觸發（降低假警報）。',
    how: '分數 ≥60 高風險、≥35 中風險。觸發因子包括動能衰竭、量價背離、熵偏空等。',
    note: '無法保證準確，但多因子共振時務必提高警覺，配合停損紀律。'
  },
  // ── 專屬量化分數 ──
  quant: {
    title: '⭐ 專屬量化分數',
    what: '回測「這檔股票」的歷史：每個指標發出訊號後，5天內真的大漲/大跌的命中率。',
    how: '命中率高的指標權重高。大漲分數與大跌分數分開計算，權重明細透明顯示。',
    note: '過去準不代表未來準（過擬合風險）。樣本不足會標「信心低」。隨新資料滾動更新。'
  },
  // ── 市場環境 ──
  market: {
    title: '🌐 大盤環境',
    what: '台指期法人未平倉、PCR 選擇權比、美股隔夜（SOX/Nasdaq）等盤後公開資料。',
    how: '純顯示數據供你參考整體環境，不直接干涉個股買賣判斷。',
    note: '反映「市場情緒傾向」，非即時、非精準預測。'
  },
  mktscore: {
    title: '🌡️ 市場環境總分',
    what: '把外資期貨、PCR、SOX、VIX 合成一個 0~100 的環境分數。',
    how: '70分以上偏多、45~55中性、30以下偏空，用星等直覺呈現。',
    note: '環境偏空時，個股做多要更保守。這是背景濾網，非進場訊號。'
  },
  // ── 籌碼面 ──
  chip: {
    title: '💰 籌碼面',
    what: '外資、投信的買賣超（1/5/20日）與連買天數。',
    how: '法人持續買超（尤其投信連買）常是飆股訊號。賣超則要警惕。',
    note: '「主力（券商分點）」需付費資料，免費 API 無法提供，故只有三大法人。'
  },
  // ── 趨勢 ──
  trend: {
    title: '📈 趨勢過濾',
    what: '用 200 日均線與 50 日均線判斷長期多空，是整個系統的「進場閘門」。',
    how: '站上 200MA 且黃金交叉＝多頭可做多；跌破且死叉＝空頭不宜做多。',
    note: '機構最常用的多空分界。趨勢不對時，其他訊號再多都該收手。'
  },
  // ── 風險管理 ──
  risk: {
    title: '🛡️ 風險管理',
    what: 'ATR 停損、固定風險部位、凱利公式、風報比、移動停利。',
    how: 'ATR 停損比固定%更貼合波動；凱利公式算建議部位（需你填真實勝率）。',
    note: '職業交易員認為「風險控制 > 進場訊號」。單筆風險建議 1%。'
  },
  playbook: {
    title: '🎯 進出場劇本',
    what: '把 ATR 風控整理成具體操作價位：進場、停損、停利1、停利2、風報比。',
    how: '風報比 ≥2 才值得進場。停利分批出場，讓部分獲利奔跑。',
    note: '比看 KD、RSI 數值更實用。實際進場可等回踩支撐再進。'
  },
  riskmetric: {
    title: '📉 風險強化',
    what: '最大回撤（過去一年最深跌幅）與年化波動率。',
    how: '回撤大代表風險高；波動率高代表容易被洗，停損要寬但部位要小。',
    note: '很多人只看報酬率，但回撤更能反映你能不能抱得住。'
  },
  // ── 多週期 ──
  multiperiod: {
    title: '⏱️ 多週期勝率',
    what: '回測 3/5/10/20 天的進場勝率，看這檔適合哪種玩法。',
    how: '哪個天數勝率最高，就代表適合隔日沖、短波段、波段或長抱。',
    note: '幫你找到這檔股票「最適合的持有時間」，而非盲目套用同一週期。'
  },
  // ── 心理 ──
  psych: {
    title: '🧠 心理偏誤檢查',
    what: 'FOMO 追高、損失厭惡、連漲偵測等反人性提醒。',
    how: '連漲過多警示追高風險；提醒你「小賺就跑、大賠硬抱」是人性陷阱。',
    note: '心理學研究：虧損痛苦約為等量獲利快樂的 2 倍。這是系統的靈魂。'
  },
  // ── 健康度 ──
  health: {
    title: '🩺 個股健康度',
    what: '把趨勢、動能、風險、籌碼、市場環境彙整成 A~F 評級的體檢報告。',
    how: '一眼看懂這檔股票各面向的好壞，總評給出整體分數。',
    note: '比一堆指標數字好懂。但仍建議搭配各層級細節判斷。'
  },
  // ── 指標群 ──
  signals: {
    title: '📡 進場訊號',
    what: '14+ 種技術指標（KD、RSI、MACD、布林、威廉、CCI、DMI 等）。',
    how: '依四大類分組：趨勢、動能、震盪、量能。同類訊號一致時較可靠。',
    note: '重要：避免疊加同類指標製造「假確認」。指標是確認工具，非決策觸發。'
  },
  // ── ADX 狀態過濾 ──
  regime: {
    title: '🎛️ 市場狀態（ADX）',
    what: 'ADX 趨勢強度告訴你「現在該用哪種策略」，73% 機構量化策略都用它。',
    how: 'ADX>25：趨勢明確，用均線等趨勢指標；ADX<20：盤整，用 RSI 等震盪指標或觀望。',
    note: '這是「狀態過濾器」——它不告訴你方向，而是告訴你該用什麼工具。'
  }
};

/* ── 彈出說明 ──────────────────────────────────────────────────────── */
function showHelp(key) {
  const h = HELP_DB[key];
  if (!h) return;
  let overlay = document.getElementById('help-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'help-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:400;background:rgba(5,8,15,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div style="max-width:420px;width:100%;background:var(--surf);border:1px solid var(--bd);border-radius:16px;padding:22px;max-height:80vh;overflow-y:auto">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
      <div style="font-size:17px;font-weight:700">${h.title}</div>
      <button onclick="document.getElementById('help-overlay').remove()" style="background:var(--bg);border:1px solid var(--bd);color:var(--txt);border-radius:8px;width:30px;height:30px;cursor:pointer;flex-shrink:0;font-size:15px">✕</button>
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:10px;color:var(--acc);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">這是什麼</div>
      <div style="font-size:13px;line-height:1.7;color:var(--txt)">${h.what}</div>
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:10px;color:var(--buy);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">怎麼看 / 怎麼用</div>
      <div style="font-size:13px;line-height:1.7;color:var(--txt)">${h.how}</div>
    </div>
    <div style="background:var(--bg);border:1px solid var(--bd);border-radius:10px;padding:12px">
      <div style="font-size:10px;color:var(--warn);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">⚠️ 注意</div>
      <div style="font-size:12px;line-height:1.6;color:var(--muted)">${h.note}</div>
    </div>
  </div>`;
}

// 產生 ⓘ 按鈕的 HTML（放在卡片標題列右上）
function helpBtn(key) {
  return `<button onclick="showHelp('${key}')" class="help-btn" title="說明">ⓘ</button>`;
}
