/**
 * 短線雷達 StockRadar — Google Apps Script 後端代理
 * ────────────────────────────────────────────────
 * 功能：代理抓取台股(TWSE/TPEX) 與 美股(Yahoo) 歷史資料，
 *       回傳統一格式 JSON，解決前端 CORS 問題。
 *
 * 部署方式：
 *   1. 前往 https://script.google.com 新建專案
 *   2. 把這份程式碼整個貼進 Code.gs
 *   3. 右上「部署」→「新增部署作業」→ 類型選「網頁應用程式」
 *   4. 執行身分：我自己；誰可以存取：「所有人」
 *   5. 部署後複製「網頁應用程式 URL」，貼到前端 index.html 的 GAS_URL
 *
 * 呼叫範例：
 *   {GAS_URL}?code=2330   → 台股台積電
 *   {GAS_URL}?code=AAPL   → 美股蘋果
 *
 * ⚠️ 極重要：本檔與 worker.js 必須維持「端點對等」，理由與驗證指令見
 * worker.js檔頭。GAS語法為ES5(var/function)，非worker.js的ES6，
 * 移植邏輯時注意箭頭函式/解構賦值需手動轉譯，勿直接複製貼上。
 *
 * 近期版本異動：
 *   v77  fetchMarket新增dayTrading/dealer（對等worker.js同版本）
 *   v83  fetchMarket新增類股廣度區塊（對等worker.js fetchSectorBreadth）
 */

/* ── 超時保護（v96）────────────────────────────────────────────────────
   v96修「查詢突然變很慢」：GAS 的 UrlFetchApp 預設無超時上限，且本檔為
   序列執行（15個外部請求依序等待），任一來源慢就會累加拖垮整個查詢。
   ★ 所有 UrlFetchApp.fetch 一律帶 timeout: FETCH_TIMEOUT_SEC
   ★ 若追求速度，建議改用 worker.js（Cloudflare Workers，平行抓取快3-5倍）
   ──────────────────────────────────────────────────────────────────── */
var FETCH_TIMEOUT_SEC = 8;   // 單一外部來源最長等 8 秒

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
  var code = (e && e.parameter && e.parameter.code ? e.parameter.code : '').trim().toUpperCase();
  var result;

  // 主力縱深（FinMind）：?action=deepchip&code=2330&token=xxx
  if (action === 'deepchip') {
    try {
      var fmToken = (e.parameter.token || '').trim();
      if (!fmToken) throw new Error('no_token');
      result = fetchDeepChip(code, fmToken);
      result.ok = true;
    } catch (err) {
      result = { ok: false, error: String(err.message || err) };
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }

  // 基本面（估值+月營收）：?action=fundamental&code=2330
  if (action === 'fundamental') {
    try {
      result = fetchFundamental(code);
      result.ok = true;
    } catch (err) {
      result = { ok: false, error: String(err.message || err) };
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }

  // 融資融券（散戶心理+軋空）：?action=margin&code=2330
  if (action === 'margin') {
    try {
      result = fetchMargin(code);
      result.ok = true;
    } catch (err) {
      result = { ok: false, error: String(err.message || err) };
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }

  // 截至某日的K線（算進場日當時的公式分數）：?action=histuntil&code=2330&until=2025-01-08
  if (action === 'histuntil') {
    try {
      var hcode = code;
      var until = e.parameter.until || '';
      result = fetchHistUntil(hcode, until);
      result.ok = true;
    } catch (err) {
      result = { ok: false, error: String(err.message || err) };
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }

  // 區間K線（給交易日誌自動算 MAE/MFE）：?action=range&code=2330&from=2025-01-01&to=2025-01-10
  if (action === 'range') {
    try {
      var rcode = code;
      var from = e.parameter.from || '';
      var to = e.parameter.to || '';
      result = fetchRangeOHLC(rcode, from, to);
      result.ok = true;
    } catch (err) {
      result = { ok: false, error: String(err.message || err) };
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }

  // 大盤基準序列（給 RS Rating / Beta 用）：?action=benchmark&market=tw|us
  if (action === 'scan') {
    // v110 批次掃描（與 worker.js 對等）：GAS為序列執行，上限降為10檔/批
    var codesRaw = (e.parameter.codes || '').split(',');
    var codes = [];
    for (var ci = 0; ci < codesRaw.length && codes.length < 10; ci++) {
      var cc = codesRaw[ci].replace(/^\s+|\s+$/g, '');
      if (cc) codes.push(cc);
    }
    if (!codes.length) return ContentService.createTextOutput(JSON.stringify({ ok: false, error: '未提供代碼' })).setMimeType(ContentService.MimeType.JSON);
    /* ── v152 修三個雷（與 worker.js 對等）──
       ① 原本走 fetchTaiwan，那條路會連籌碼(T86)一起抓——掃描根本用不到籌碼，
          卻讓每檔多花數秒並撞上 TWSE 限流，10檔就可能吃掉 GAS 的執行時間上限。
          改走 fetchYahooTW（只抓K線）。
       ② 失敗靜默回 ok:false，原因整個丟掉；且 Yahoo 偶發限流會被誤報成
          「資料不足60日」。改：重試一次並回傳真正原因。
       ③ 只回還原價，前端當成原始價用，掃描與個股頁的 ATR／關卡基準不一致。
          改：原始價一併回傳。 */
    var results = [];
    for (var si = 0; si < codes.length; si++) {
      var cd = codes[si], dd = null, why = '';
      for (var at = 0; at < 2; at++) {
        if (at) Utilities.sleep(600);   // 被限流時退避再試
        try {
          dd = /^\d{4,6}$/.test(cd) ? fetchYahooTW(cd) : fetchYahoo(cd);
          if (dd && dd.closes && dd.closes.length >= 60) break;
          dd = null; why = '查無K線或不足60日（非上市櫃／已下市／新上市，也可能是 Yahoo 當下限流）';
        } catch (se) { dd = null; why = String(se.message || se); }
      }
      if (dd) {
        results.push({ code: cd, ok: true, closes: dd.closes, highs: dd.highs, lows: dd.lows,
          rawCloses: dd.rawCloses, rawHighs: dd.rawHighs, rawLows: dd.rawLows,
          volumes: dd.volumes, opens: dd.opens || null, price: dd.closes[dd.closes.length - 1], lastDate: dd.lastDate || '' });
      } else results.push({ code: cd, ok: false, error: (why || '未知錯誤') + '（已重試1次）' });
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, results: results })).setMimeType(ContentService.MimeType.JSON);
  }
  if (action === 'benchmark') {
    try {
      var mkt = (e.parameter.market || 'tw');
      var benchData;
      if (mkt === 'us') {
        benchData = fetchYahoo('SPY'); // 美股用 SPY
      } else {
        benchData = fetchYahoo('0050.TW'); // 台股用 0050（透過 Yahoo 較快）
      }
      result = { ok: true, closes: benchData.closes };
    } catch (err) {
      result = { ok: false, error: String(err.message || err) };
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }

  // 大盤環境（第⓪層）：?action=market
  if (action === 'market') {
    try { result = fetchMarket(); }
    catch (err) { result = { ok: false, error: String(err.message || err) }; }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }

  // 雲端讀取：?action=sync_get
  if (action === 'sync_get') {
    try {
      var stored = PropertiesService.getUserProperties().getProperty('sync_data');
      result = { ok: true, data: stored ? JSON.parse(stored) : { trades: [], settings: {} } };
    } catch (err) { result = { ok: false, error: String(err.message || err) }; }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    if (!code) throw new Error('缺少股票代碼參數 code');

    // 純數字開頭 → 台股；否則美股
    if (/^\d/.test(code)) {
      result = fetchTaiwan(code);
    } else {
      result = fetchYahoo(code);
    }
    result.ok = true;
  } catch (err) {
    result = { ok: false, error: String(err.message || err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/** ── 台股：TWSE 上市 → 失敗則 TPEX 上櫃 ───────────────────── */
function fetchTaiwan(stockNo) {
  // ── 優先用 Yahoo 一次抓完（快：1次請求 vs TWSE 逐月12次）──
  try {
    var ydata = fetchYahooTW(stockNo);
    if (ydata && ydata.closes && ydata.closes.length >= 60) {
      // 籌碼仍從 TWSE T86 抓
      ydata.chip = fetchTaiwanChip(stockNo);
      return ydata;
    }
  } catch (e) { /* Yahoo 失敗則走 TWSE 備援 */ }

  var now = new Date();
  var yms = [];
  for (var i = 11; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    yms.push(Utilities.formatDate(d, 'Asia/Taipei', 'yyyyMM') + '01');
  }

  var rows = [];
  var name = '';

  // 先試 TWSE 上市
  for (var j = 0; j < yms.length; j++) {
    var url = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=' + yms[j] + '&stockNo=' + stockNo;
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC });
      var txt = resp.getContentText();
      var data = JSON.parse(txt);
      if (data.stat === 'OK' && data.data) {
        if (!name && data.title) {
          var parts = data.title.split(' ');
          name = parts.length > 1 ? parts[1] : stockNo;
        }
        rows = rows.concat(data.data);
      }
    } catch (e) { /* ignore */ }
    Utilities.sleep(600); // 避免 TWSE 限流（每5秒3次），12個月請求需拉長間隔
  }

  // TWSE 沒資料 → 試 TPEX 上櫃
  var isTpex = false;
  if (rows.length === 0) {
    isTpex = true;
    for (var k = 0; k < yms.length; k++) {
      var d2 = new Date(yms[k].slice(0, 4) + '-' + yms[k].slice(4, 6) + '-01');
      var rocY = d2.getFullYear() - 1911;
      var mm = Utilities.formatDate(d2, 'Asia/Taipei', 'MM');
      var url2 = 'https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=' +
                 rocY + '/' + mm + '&stkno=' + stockNo + '&o=json';
      try {
        var resp2 = UrlFetchApp.fetch(url2, { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC });
        var data2 = JSON.parse(resp2.getContentText());
        if (data2.iTotalRecords > 0 && data2.aaData) {
          if (!name) name = data2.stkName || stockNo;
          rows = rows.concat(data2.aaData);
        }
      } catch (e) { /* ignore */ }
      Utilities.sleep(600);
    }
  }

  if (rows.length === 0) throw new Error('找不到台股 ' + stockNo + '，請確認代碼');

  // 解析欄位：[日期, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌, 筆數]
  var parsed = [];
  for (var m = 0; m < rows.length; m++) {
    var r = rows[m];
    var close = num(r[6]);
    if (close <= 0) continue;
    parsed.push({
      open:  num(r[3]),
      high:  num(r[4]),
      low:   num(r[5]),
      close: close,
      vol:   num(r[1])
    });
  }

  if (parsed.length < 10) throw new Error(stockNo + ' 歷史資料不足，無法計算指標');

  var last = parsed[parsed.length - 1];
  var prev = parsed[parsed.length - 2] || last;
  var vols = parsed.map(function (x) { return x.vol; });
  var avg5 = avgN(vols, 5);

  // ── 籌碼面：外資/投信買賣超（近20日 T86）──────────────────
  // 註：免費 API 只有三大法人，「主力(券商分點)」需付費資料，故不提供
  var chip = fetchTaiwanChip(stockNo);

  return {
    name: name || stockNo,
    code: stockNo,
    currency: 'TWD',
    price: last.close,
    open: last.open,
    high: last.high,
    low: last.low,
    prevClose: prev.close,
    volume: last.vol,
    avgVol5: avg5,
    closes:  parsed.map(function (x) { return x.close; }),
    highs:   parsed.map(function (x) { return x.high; }),
    lows:    parsed.map(function (x) { return x.low; }),
    volumes: vols,
    chip: chip   // 籌碼資料（外資/投信買賣超與連買天數）
  };
}

/** ──────────────────────────────────────────────────────────
 *  fetchTaiwanChip — 個股三大法人買賣超（TWSE T86）
 *  回傳近20日外資、投信淨買賣超(張)，及連買天數
 *  限制：免費資料僅三大法人，無券商分點「主力」資料
 *  ────────────────────────────────────────────────────────── */
function fetchTaiwanChip(stockNo) {
  var now = new Date();
  var foreignSeries = [];  // 由舊到新：外資每日淨買賣超(張)
  var trustSeries = [];    // 投信每日淨買賣超(張)
  var dealerSeries = [];   // 自營商
  var dates = [];

  /* v153 修兩個雷（與 worker.js 對等）──
     ① 原本用 day.getDay() 判斷週末，但日期字串卻是用 Asia/Taipei 格式化。
        getDay() 取的是「指令碼專案時區」的星期；專案時區若不是台北（GAS 預設
        常是美洲時區），台北的週六在腳本眼中還是週五 → 週末沒跳過、週一反被跳掉，
        抓取區間整體偏移。星期與日期必須同一個時區算。
     ② 缺少 expected / headMiss / missDates：前端判斷籌碼是否過時完全靠這三個
        欄位（worker.js 有、這裡沒有），於是走 GAS 後端時「籌碼過時」的警示
        永遠不會亮——舊資料被當成今天的照常計分。這是無聲的錯誤，最危險。 */
  var tpeNow = new Date(Date.now() + 8 * 3600000);
  var expDay = new Date(tpeNow.getTime() - (tpeNow.getUTCHours() < 16 ? 1 : 0) * 86400000);
  while (expDay.getUTCDay() === 0 || expDay.getUTCDay() === 6) expDay = new Date(expDay.getTime() - 86400000);
  var expected = Utilities.formatDate(expDay, 'Asia/Taipei', 'yyyyMMdd');
  var missDates = [], noDataDates = [];

  // T86 每日資料，抓近 20 個交易日（往回約 26 個日曆日足夠）
  for (var d = 25; d >= 0; d--) {
    var day = new Date(now.getTime() - d * 86400000);
    var ymd = Utilities.formatDate(day, 'Asia/Taipei', 'yyyyMMdd');
    if (Utilities.formatDate(day, 'Asia/Taipei', 'u') > '5') continue;   // 台北時間的星期六日（u：1=一 … 7=日）
    if (ymd > expected) continue;                                        // 還不該有資料的日子不要浪費請求
    var got = false, noData = false;
    var url = 'https://www.twse.com.tw/fund/T86?response=json&date=' + ymd + '&selectType=ALLBUT0999';
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC });
      var j = JSON.parse(resp.getContentText());
      // stat 非 OK＝該日無資料（國定假日／尚未公布），不是抓取失敗，不可算成缺漏
      if (j.stat !== 'OK' || !j.data) { noDataDates.push(ymd); continue; }
      var F = j.fields || [];
      var exactIdx = function(name) { for (var xi = 0; xi < F.length; xi++) if (F[xi] === name) return xi; return -1; };
      var normIdx = function(name) {
        var target = name.replace(/\s/g, '');
        for (var ni = 0; ni < F.length; ni++) if (String(F[ni]).replace(/\s/g, '') === target) return ni;
        return -1;
      };
      var reIdx = function(re1, re2, exre) {
        for (var ri = 0; ri < F.length; ri++) {
          var s = String(F[ri]);
          if (re1.test(s) && re2.test(s) && (!exre || !exre.test(s))) return ri;
        }
        return -1;
      };
      // 精確全名優先（欄名本身含「不含外資自營商」字樣，舊版排除式比對會誤刪要找的欄，導致外資恆為0）
      var iF = exactIdx('外資及陸資買賣超股數');
      if (iF < 0) iF = normIdx('外資及陸資買賣超股數');
      if (iF < 0) iF = exactIdx('外資及陸資(不含外資自營商)買賣超股數');
      if (iF < 0) iF = normIdx('外資及陸資不含外資自營商買賣超股數');
      if (iF < 0) iF = reIdx(/外資|外陸資/, /買賣超/, null);
      var iT = exactIdx('投信買賣超股數');
      if (iT < 0) iT = reIdx(/投信/, /買賣超/, null);
      var iD = exactIdx('自營商買賣超股數');
      if (iD < 0) iD = normIdx('自營商買賣超股數');
      if (iD < 0) iD = reIdx(/自營商/, /買賣超/, /自行|避險/);
      if (iD < 0) iD = reIdx(/自營商/, /買賣超/, null);
      for (var i = 0; i < j.data.length; i++) {
        var row = j.data[i];
        if ((row[0] || '').trim() === stockNo) {
          foreignSeries.push((iF >= 0 ? num(row[iF]) : 0) / 1000);
          trustSeries.push((iT >= 0 ? num(row[iT]) : 0) / 1000);
          dealerSeries.push((iD >= 0 ? num(row[iD]) : 0) / 1000);
          dates.push(ymd);
          got = true;
          break;
        }
      }
      if (!got) noDataDates.push(ymd);   // 當日有公布但查無此股（未上市/暫停交易），同樣不算抓取失敗
    } catch (e) { missDates.push(ymd); }
    Utilities.sleep(120); // 縮短間隔（T86 限流較寬鬆）
  }

  if (foreignSeries.length === 0) return null;

  // 連買天數（從最新往回數，正值連續）
  function streak(series) {
    var s = 0;
    for (var i = series.length - 1; i >= 0; i--) {
      if (series[i] > 0) s++;
      else break;
    }
    return s;
  }
  function sumLast(series, n) {
    var s = 0, start = Math.max(0, series.length - n);
    for (var i = start; i < series.length; i++) s += series[i];
    return Math.round(s);
  }

  // v153：算出「應該要有資料卻沒抓到」的日子（已扣除非交易日），與 worker.js 對等
  var noDataMap = {};
  for (var nd = 0; nd < noDataDates.length; nd++) noDataMap[noDataDates[nd]] = 1;
  var dueReal = [];
  for (var dr = 0; dr < dates.length; dr++) dueReal.push(dates[dr]);
  for (var mr = 0; mr < missDates.length; mr++) if (!noDataMap[missDates[mr]]) dueReal.push(missDates[mr]);
  dueReal.sort();
  var expectedReal = dueReal.length ? dueReal[dueReal.length - 1] : expected;
  var recent5 = dueReal.slice(Math.max(0, dueReal.length - 5));
  var realMiss = [], gapMiss = 0;
  for (var mi = 0; mi < missDates.length; mi++) {
    if (noDataMap[missDates[mi]]) continue;
    if (recent5.indexOf(missDates[mi]) >= 0) realMiss.push(missDates[mi]); else gapMiss++;
  }

  return {
    dataDate: dates.length ? dates[dates.length - 1] : '',   // v100：最新T86日期（防呆顯示，與worker.js對等）
    expected: expectedReal,          // v153：此刻應該有的最新交易日（已扣除國定假日）
    missDates: realMiss.slice(0, 6), // v153：最新5交易日中實際缺漏的日期
    gapMiss: gapMiss,                // v153：較舊的缺口天數（只影響20日累計精度）
    headMiss: realMiss.length,       // v153：>0＝最新幾天沒抓到，前端會改中性並提示重查
    foreign1: foreignSeries.length ? Math.round(foreignSeries[foreignSeries.length - 1]) : 0,
    foreign5: sumLast(foreignSeries, 5),
    foreign20: sumLast(foreignSeries, 20),
    foreignStreak: streak(foreignSeries),
    trust1: trustSeries.length ? Math.round(trustSeries[trustSeries.length - 1]) : 0,
    trust5: sumLast(trustSeries, 5),
    trust20: sumLast(trustSeries, 20),
    trustStreak: streak(trustSeries),
    dealer5: sumLast(dealerSeries, 5),
    days: foreignSeries.length
  };
}

/** ── 美股：Yahoo Finance ─────────────────────────────────── */
function fetchYahoo(symbol) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol +
            '?interval=1d&range=2y';
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    timeout: FETCH_TIMEOUT_SEC,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  var j = JSON.parse(resp.getContentText());
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('找不到美股 ' + symbol + '，請確認代碼');

  var q = res.indicators.quote[0];
  var meta = res.meta;

  var fArr = adjFactors(res, q);
  var closes = [], highs = [], lows = [], opens = [], vols = [];
  var rawCloses = [], rawHighs = [], rawLows = [];  // 未還原市價（支撐壓力/BOS用）
  var zLast = -1;   // v153：最後一根「實際採用」的K棒索引（結尾若有 null 棒，時間戳不能直接取最後一個）
  for (var zi = 0; zi < (q.close || []).length; zi++) {
    var zc = q.close[zi];
    if (zc == null) continue;
    var zf = fArr[zi];
    // v153：high/low/open 偶發 null 時以收盤價補，避免 NaN 灌進 ATR 與關卡計算
    var zh = q.high[zi] == null ? zc : q.high[zi], zl = q.low[zi] == null ? zc : q.low[zi], zo = q.open[zi] == null ? zc : q.open[zi];
    closes.push(zc * zf); highs.push(zh * zf);
    lows.push(zl * zf); opens.push(zo * zf);
    vols.push(q.volume[zi] || 0);
    rawCloses.push(zc); rawHighs.push(zh); rawLows.push(zl);
    zLast = zi;
  }

  var price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[closes.length - 1];
  var prev  = meta.previousClose != null ? meta.previousClose : closes[closes.length - 2];

  return {
    name: meta.longName || meta.shortName || symbol,
    code: symbol,
    currency: 'USD',
    price: price,
    open: opens[opens.length - 1],
    high: highs[highs.length - 1],
    low: lows[lows.length - 1],
    prevClose: prev,
    volume: vols[vols.length - 1],
    avgVol5: avgN(vols, 5),
    closes: closes, highs: highs, lows: lows, volumes: vols, opens: opens,
    rawCloses: rawCloses, rawHighs: rawHighs, rawLows: rawLows,
    /* v153：原本用 d.getMonth()/getDate()，那是「指令碼專案時區」的日期。
       GAS 專案預設時區常不是 Asia/Taipei，會整整差一天，新鮮度檢查就全錯。
       改用 UTC 格式化，與 worker.js 的 toISOString 完全一致；並取「實際採用的
       最後一根K棒」的時間戳，結尾有 null 棒時才不會報到後一天。 */
    lastDate: (function(){ try { return Utilities.formatDate(new Date(res.timestamp[zLast] * 1000), 'UTC', 'yyyyMMdd'); } catch (e2) { return ''; } })()
  };
}


/** 除權息還原因子（adjclose/close），無 adj 時回傳全1 */
function adjFactors(res, q) {
  var adj = res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
  var out = [];
  for (var i = 0; i < (q.close || []).length; i++) {
    var f = 1, cl = q.close[i];
    if (adj && adj[i] != null && cl > 0) { var ff = adj[i] / cl; if (isFinite(ff) && ff > 0) f = ff; }
    out.push(f);
  }
  return out;
}

/** ── 工具函式 ──────────────────────────────────────────── */
function num(s) {
  if (s == null) return 0;
  var n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}
function clean(arr) {
  return (arr || []).filter(function (v) { return v != null; });
}
function avgN(arr, n) {
  if (arr.length < n + 1) return arr.length ? arr[arr.length - 1] : 0;
  var slice = arr.slice(-n - 1, -1);
  return slice.reduce(function (a, b) { return a + b; }, 0) / n;
}

/**
 * ════════════════════════════════════════════════════════
 * 大盤環境模組（第⓪層）— 在 doGet 中以 ?action=market 呼叫
 * 回傳：三大法人期貨未平倉、散戶多空比、PCR、美股隔夜(SOX/Nasdaq)
 * 全部為「盤後公開資料」，僅供環境參考，非即時訊號
 * ════════════════════════════════════════════════════════
 */
function fetchMarket() {
  var out = { ok: true, taifex: {}, us: {} };
  // v156：來源失敗要讓使用者看得到（前端對缺欄位是「不顯示那一格」，會整個維度靜默消失）
  var srcErr = [];

  // ── 1. 期交所：三大法人期貨未平倉（台指期）─────────────────
  try {
    // 期交所 OpenAPI：三大法人－區分各期貨契約－依日期
    var url1 = 'https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate'   /* v157：端點名稱已對照期交所官方 OAS 清單確認。舊名 ...DetailsOfAsSpecificFuturesContractByDate 不存在，期交所會把它導回 API 目錄頁(HTML)，於是外資台指期整個維度靜默消失 */;
    var r1 = UrlFetchApp.fetch(url1, { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC });
    var arr1 = JSON.parse(r1.getContentText());
    /* v155：這支端點兩個後端原本猜的欄名完全不同（GAS 猜 商品名稱／多空淨額未平倉口數，
       worker.js 猜 ContractName／OpenInterestNetAmount），最多只有一邊對，也可能兩邊都錯。
       而且比對不到時會算出 0，前端的 if(foreignNet != null) 會把 0 當成「外資偏空」照樣計分——
       產生一個看起來很正常的假訊號。PCR 端點已證實欄名寫死會整個失效，這裡一併改成
       關鍵字比對＋比不到就回 null（當成沒資料），並且只採最新一天、不跨日累加。 */
    /* v158：欄位名稱已用期交所實際回傳核對（2026-09-22），與 worker.js 同一組：
       ContractCode=「臺股期貨」、Item=「外資及陸資」、OpenInterest(Net)=多空淨額未平倉口數。
       ⚠️ OpenInterest(Net) 必須完全比對：同列另有 ContractValueofOpenInterest(Net)(Thousands)
          是契約金額千元，寬鬆比對會抓到金額，數字大三個數量級。 */
    var gKey = function (row, res) { var ks = Object.keys(row);
      for (var t = 0; t < res.length; t++) for (var i = 0; i < ks.length; i++) if (res[t].test(ks[i])) return row[ks[i]];
      return null; };
    var gDate = function (x) { return String(gKey(x, [/^Date$/i, /^日期$/]) || ''); };
    var txRows = arr1.filter(function(x){
      return String(gKey(x, [/^ContractCode$/i, /^ContractName$/i, /^商品名稱$/, /^契約名稱$/]) || '') === '臺股期貨';
    });
    if (txRows.length) {
      var foreignNet = null, totalNet = null, dataDate = '';
      txRows.forEach(function(x){ var dv = gDate(x); if (dv > dataDate) dataDate = dv; });
      txRows.forEach(function(x){
        if (dataDate && gDate(x) !== dataDate) return;   // 只採最新那一天
        var raw = gKey(x, [/^OpenInterest\(Net\)$/i, /^未平倉多空淨額口數$/, /^OpenInterestNetAmount$/i]);
        if (raw === null || raw === '') return;          // 欄位對不上就不要生出 0
        var net = num(raw);
        totalNet = (totalNet === null ? 0 : totalNet) + net;
        if (String(gKey(x, [/^Item$/i, /^IdentityType$/i, /^身份別$/]) || '').indexOf('外資') >= 0) foreignNet = net;
      });
      if (foreignNet !== null || totalNet !== null) {
        out.taifex.date = dataDate;
        out.taifex.foreignNet = foreignNet;        // 外資台指期淨未平倉(口)
        out.taifex.institutionNet = totalNet;      // 三大法人合計淨未平倉(口)
      }
    }
  } catch(e){ out.taifex.error = String(e); srcErr.push({ name: '外資台指期', why: String(e.message || e).slice(0, 120) }); }

  // ── 2. 期交所：選擇權 PCR（Put/Call Ratio）────────────────
  try {
    var url2 = 'https://openapi.taifex.com.tw/v1/PutCallRatio';
    var r2 = UrlFetchApp.fetch(url2, { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC });
    var arr2 = JSON.parse(r2.getContentText());
    if (arr2.length) {
      /* v155（依實際回傳驗證後修正）：真實欄名是 PutCallOIRatio% / PutCallVolumeRatio%，
         這裡猜的 putCallRatioOfOpenInterest 永遠對不上 → pcrOI/pcrVol 一直是 0，
         前端 if(pcrOI) 又把 0 跳過，於是「選擇權 PCR」整個維度靜默失效。
         另外順序已確認為日期降冪，取最新改成明確比日期（不靠索引 0）。
         比不到比率欄位時，直接用 PutOI/CallOI 自己算，欄名再改也不會失效。 */
      var pKey = function (row, res) { var ks = Object.keys(row);
        for (var t = 0; t < res.length; t++) for (var i = 0; i < ks.length; i++)
          if (res[t].test(ks[i]) && row[ks[i]] !== '' && row[ks[i]] != null) return num(row[ks[i]]);
        return null; };
      var pDate = function (x) { return String(x['Date'] || x['date'] || x['日期'] || ''); };
      var latest = arr2[0];
      for (var ai = 1; ai < arr2.length; ai++) if (pDate(arr2[ai]) > pDate(latest)) latest = arr2[ai];
      var pRatio = function (a, b) { return (a !== null && b) ? a / b * 100 : null; };
      var oiR = pKey(latest, [/OIRatio/i, /OpenInterest.*Ratio|Ratio.*OpenInterest/i, /未平倉.*比率/]);
      var volR = pKey(latest, [/VolumeRatio/i, /Volume.*Ratio|Ratio.*Volume/i, /成交量.*比率/]);
      out.taifex.pcrOI = oiR !== null ? oiR : pRatio(pKey(latest, [/^PutOI$/i]), pKey(latest, [/^CallOI$/i]));
      out.taifex.pcrVol = volR !== null ? volR : pRatio(pKey(latest, [/^PutVolume$/i]), pKey(latest, [/^CallVolume$/i]));
      out.taifex.pcrDate = pDate(latest);
    }
  } catch(e){ out.taifex.pcrError = String(e); srcErr.push({ name: '選擇權PCR', why: String(e.message || e).slice(0, 120) }); }

  // ── 3. 美股隔夜：SOX 費半 + Nasdaq（透過 Yahoo）────────────
  try {
    out.us.sox = yahooQuote('^SOX');     // 費城半導體
    out.us.nasdaq = yahooQuote('^IXIC'); // 那斯達克
    out.us.sp500 = yahooQuote('^GSPC');  // 標普500
    out.us.vix = yahooQuote('^VIX');     // VIX 恐慌指數（新增）
    out.us.dxy = yahooQuote('DX-Y.NYB'); // 美元指數（強美元=外資匯出壓力）
    out.us.tnx = yahooQuote('^TNX');     // 美債10年殖利率×10
  } catch(e){ out.us.error = String(e); }

  // ── 類股廣度（TWSE MI_INDEX：37類股指數漲跌計數；本端點不含個股家數，類股為代理。格式已以真實樣本驗證 2026-07）──
  try {
    var rB = UrlFetchApp.fetch('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX', { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC });
    var arrB = JSON.parse(rB.getContentText());
    if (arrB && arrB.length) {
      var upB = 0, dnB = 0, flatB = 0;
      for (var bi = 0; bi < arrB.length; bi++) {
        var nm = arrB[bi]['指數'] || '';
        if (nm.indexOf('類指數') < 0 || nm.indexOf('報酬') >= 0) continue;
        var cB = arrB[bi]['漲跌'];
        if (cB === '+') upB++; else if (cB === '-') dnB++; else flatB++;
      }
      if (upB + dnB + flatB >= 15) {
        if (!out.tw) out.tw = {};
        out.tw.breadth = { up: upB, dn: dnB, flat: flatB, total: upB + dnB + flatB, date: arrB[0]['日期'] || '' };
      }
    }
  } catch(e){}

  if (out.taifex.foreignNet == null && !srcErr.length) srcErr.push({ name: '外資台指期', why: '端點有回應但取不到可用欄位' });
  if (out.taifex.pcrOI == null) srcErr.push({ name: '選擇權PCR', why: '端點有回應但取不到可用欄位' });
  if (srcErr.length) out.sourceErrors = srcErr;
  return out;
}

/** 抓單一美股/指數最新報價與漲跌幅 */
function yahooQuote(symbol) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=5d';
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC, headers: { 'User-Agent': 'Mozilla/5.0' } });
  var j = JSON.parse(r.getContentText());
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) return null;
  var meta = res.meta;
  var price = meta.regularMarketPrice;
  var prev = meta.chartPreviousClose || meta.previousClose;
  var chgPct = prev ? (price - prev) / prev * 100 : 0;
  return { price: price, prevClose: prev, changePct: chgPct };
}

/**
 * 雲端儲存（POST）：action=sync_save
 * 前端以 text/plain 傳 JSON，存到 UserProperties
 */
function doPost(e) {
  var result;
  try {
    var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
    if (action === 'sync_save') {
      var payload = e.postData && e.postData.contents ? e.postData.contents : '{}';
      // 驗證可解析
      JSON.parse(payload);
      PropertiesService.getUserProperties().setProperty('sync_data', payload);
      result = { ok: true, savedAt: new Date().toISOString() };
    } else {
      result = { ok: false, error: '未知的 action' };
    }
  } catch (err) {
    result = { ok: false, error: String(err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/** v153：指定期間的 Yahoo 原始結果；台股自動試 .TW → .TWO（與 worker.js 對等） */
function yahooRangeGS(code, qs) {
  var syms = /^\d/.test(code) ? [code + '.TW', code + '.TWO'] : [code];
  for (var si = 0; si < syms.length; si++) {
    try {
      var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(syms[si]) +
                '?interval=1d&' + qs + '&includeAdjustedClose=true';
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.getResponseCode() !== 200) continue;
      var j = JSON.parse(r.getContentText());
      var res = j.chart && j.chart.result && j.chart.result[0];
      if (!res || !res.indicators || !res.indicators.quote) continue;
      var cl = res.indicators.quote[0].close || [];
      for (var k = 0; k < cl.length; k++) if (cl[k] != null) return res;
    } catch (e) { /* 換下一個後綴 */ }
  }
  return null;
}

/** ──────────────────────────────────────────────────────────
 *  fetchRangeOHLC — 抓指定日期區間的每日 OHLC
 *  給交易日誌自動計算 MAE（最大不利）/ MFE（最大有利）
 *  code: 2330 或 AAPL；from/to: yyyy-MM-dd
 *  ────────────────────────────────────────────────────────── */
function fetchRangeOHLC(code, from, to) {
  if (!code) throw new Error('缺少股票代碼');
  if (!from || !to) throw new Error('缺少日期區間');

  /* v153 修三個雷：
     ① 'T00:00:00' 沒有 Z，是用「指令碼專案時區」解析；worker.js 用的是 Z（UTC）。
        專案時區一換，同一筆交易的區間就差一天，MAE/MFE 兩個後端算出來會不同。
     ② to 多加 86400 秒＝把出場日的次一交易日也算進最大有利/不利幅度。
        台股日K時間戳是當日 01:00Z，23:59:59Z 早已涵蓋當天，本來就不必多加。
     ③ 只試 .TW，上櫃股票的日誌永遠算不出 MAE/MFE。 */
  var p1 = Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000);
  var p2 = Math.floor(new Date(to + 'T23:59:59Z').getTime() / 1000);
  var res = yahooRangeGS(code, 'period1=' + p1 + '&period2=' + p2);
  if (!res) throw new Error('找不到 ' + code + ' 的區間資料');

  var q = res.indicators.quote[0];
  var fArr4 = adjFactors(res, q);
  /* v153 修陣列錯位：原本 high/low/close 各自獨立判斷 null 後 push，
     只要某一根 K 棒缺了其中一項，三個陣列長度就不同、彼此對不上同一天，
     firstClose/lastClose 會指到與 rangeHigh/rangeLow 不同的K棒。
     改為與 worker.js 一致：以「收盤價存在」為唯一閘門，缺的高低以收盤價補。 */
  var highs = [], lows = [], closes = [], rawHighs = [], rawLows = [], hasDiv = false;
  for (var i = 0; i < (q.close || []).length; i++) {
    var c4 = q.close[i];
    if (c4 == null) continue;
    var f4 = fArr4[i];
    if (Math.abs(f4 - 1) > 0.001) hasDiv = true;
    var h4 = q.high[i] == null ? c4 : q.high[i], l4 = q.low[i] == null ? c4 : q.low[i];
    highs.push(h4 * f4); rawHighs.push(h4);
    lows.push(l4 * f4); rawLows.push(l4);
    closes.push(c4 * f4);
  }
  if (highs.length === 0) throw new Error('區間內無交易資料（可能日期錯誤或非交易日）');

  return {
    rangeHigh: Math.max.apply(null, rawHighs),      // 原始價（對齊使用者輸入的進場價）
    rangeLow: Math.min.apply(null, rawLows),
    rangeHighAdj: Math.max.apply(null, highs),      // 還原價
    rangeLowAdj: Math.min.apply(null, lows),
    hasDividend: hasDiv,
    days: highs.length,
    firstClose: closes[0],
    lastClose: closes[closes.length - 1]
  };
}

/** ──────────────────────────────────────────────────────────
 *  fetchHistUntil — 抓「截至某日期」前約120根K線
 *  用來計算進場日當天的 STI/MFD/ECO/FUSION 公式分數
 *  ────────────────────────────────────────────────────────── */
function fetchHistUntil(code, until) {
  if (!code || !until) throw new Error('缺少代碼或日期');
  /* v153 修前視偏差：原本多加 86400 秒，等於把「進場日的次一交易日」抓進來。
     這支端點是要算「進場當下能看到的公式分數」，多一根未來K棒＝分數偷看到明天。
     同時修掉沒有 Z 的時區解析與只試 .TW 的問題。 */
  var untilTime = Math.floor(new Date(until + 'T23:59:59Z').getTime() / 1000);
  var fromTime = untilTime - 200 * 86400;
  var res = yahooRangeGS(code, 'period1=' + fromTime + '&period2=' + untilTime);
  if (!res) throw new Error('找不到 ' + code + ' 的歷史資料');
  var q = res.indicators.quote[0];
  var fArr3 = adjFactors(res, q);
  var closes = [], highs = [], lows = [], volumes = [];
  for (var i = 0; i < (q.close || []).length; i++) {
    if (q.close[i] != null) { var c3 = q.close[i], f3 = fArr3[i];
      var h3 = q.high[i] == null ? c3 : q.high[i], l3 = q.low[i] == null ? c3 : q.low[i];   // v154：缺值補收盤
      closes.push(c3 * f3); highs.push(h3 * f3); lows.push(l3 * f3); volumes.push(q.volume[i] || 0); }
  }
  if (closes.length < 30) throw new Error('進場日前資料不足');
  return { closes: closes, highs: highs, lows: lows, volumes: volumes,
           price: closes[closes.length-1], prevClose: closes[closes.length-2] || closes[closes.length-1] };
}

/** ──────────────────────────────────────────────────────────
 *  fetchYahooTW — 用 Yahoo 一次抓台股一年K線（取代逐月 TWSE，大幅加速）
 *  ────────────────────────────────────────────────────────── */
function fetchYahooTW(stockNo) {
  // 先試 .TW（上市），失敗再試 .TWO（上櫃）
  var suffixes = ['.TW', '.TWO'];
  for (var s = 0; s < suffixes.length; s++) {
    var symbol = stockNo + suffixes[s];
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
              '?interval=1d&range=2y';
    try {
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC, headers: { 'User-Agent': 'Mozilla/5.0' } });
      var j = JSON.parse(r.getContentText());
      var res = j.chart && j.chart.result && j.chart.result[0];
      if (!res || !res.indicators || !res.indicators.quote) continue;
      var q = res.indicators.quote[0];
      var meta = res.meta || {};
      var ts = res.timestamp || [];
      var fArr2 = adjFactors(res, q);
      var closes = [], highs = [], lows = [], opens = [], vols = [];
      var rawCloses = [], rawHighs = [], rawLows = [];  // 未還原市價
      var tLast = -1;
      for (var i = 0; i < ts.length; i++) {
        var cc = q.close[i];
        if (cc == null) continue;
        var f2 = fArr2[i];
        var hh = q.high[i] == null ? cc : q.high[i], ll = q.low[i] == null ? cc : q.low[i], oo = q.open[i] == null ? cc : q.open[i];
        closes.push(cc * f2); highs.push(hh * f2); lows.push(ll * f2);
        opens.push(oo * f2); vols.push(q.volume[i] || 0);
        rawCloses.push(cc); rawHighs.push(hh); rawLows.push(ll);
        tLast = i;
      }
      if (closes.length < 60) continue;
      var last = closes.length - 1;
      return {
        name: meta.shortName || meta.symbol || stockNo,
        code: stockNo, currency: 'TWD',
        price: closes[last], open: opens[last], high: highs[last], low: lows[last],
        prevClose: closes[last - 1] || closes[last],
        volume: vols[last],
        avgVol5: vols.slice(-5).reduce(function(a,b){return a+b;},0) / Math.min(5, vols.length),
        closes: closes, highs: highs, lows: lows, volumes: vols, opens: opens,
        rawCloses: rawCloses, rawHighs: rawHighs, rawLows: rawLows,
        /* v153 補漏：這裡一直沒有回傳 lastDate，而 worker.js 有。
           結果是走 GAS 後端時，台股的「資料新鮮度檢查」與「盤中丟棄未完成K棒」
           兩道防線全部靜默失效——畫面不會說資料是舊的，也可能拿今天未收盤的K棒
           去算指標。這是端點對等被破壞造成的無聲錯誤。 */
        lastDate: (function(){ try { return Utilities.formatDate(new Date(ts[tLast] * 1000), 'UTC', 'yyyyMMdd'); } catch (e3) { return ''; } })()
      };
    } catch (e) { /* 試下一個後綴 */ }
  }
  return null;
}

/** ──────────────────────────────────────────────────────────
 *  fetchMargin — 融資融券餘額（TWSE MI_MARGN，近~12交易日）
 *  融資=散戶槓桿代理；券資比=融券/融資（軋空偵測）
 *  ────────────────────────────────────────────────────────── */
function fetchMargin(stockNo) {
  if (!/^\d/.test(stockNo)) throw new Error('僅台股上市股票提供融資融券');
  var now = new Date();
  var series = [];
  for (var d = 16; d >= 0; d--) {
    var day = new Date(now.getTime() - d * 86400000);
    var wd = day.getDay();
    if (wd === 0 || wd === 6) continue;
    var ymd = Utilities.formatDate(day, 'Asia/Taipei', 'yyyyMMdd');
    try {
      var r = UrlFetchApp.fetch('https://www.twse.com.tw/exchange/MI_MARGN?response=json&date=' + ymd + '&selectType=ALL', { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC });
      var j = JSON.parse(r.getContentText());
      var rows = j.data || null;
      if (!rows && j.tables) {  // 新版格式：找含個股列的表
        for (var t = 0; t < j.tables.length; t++) {
          var td = j.tables[t].data || [];
          if (td.length && /^\d{4}/.test((td[0][0] || '').trim())) { rows = td; break; }
        }
      }
      if (!rows) continue;
      var mfields = j.fields || null;
      if (!mfields && j.tables) { for (var tt = 0; tt < j.tables.length; tt++) { var td2 = j.tables[tt].data || []; if (td2.length && /^\d{4}/.test((td2[0][0]||'').trim())) { mfields = j.tables[tt].fields; break; } } }
      var iMar = 6, iShort = 12;
      if (mfields) {
        for (var mf = 0; mf < mfields.length; mf++) {
          var ms = String(mfields[mf]);
          if (ms.indexOf('融資') >= 0 && ms.indexOf('今日餘額') >= 0) iMar = mf;
          if (ms.indexOf('融券') >= 0 && ms.indexOf('今日餘額') >= 0) iShort = mf;
        }
      }
      for (var i = 0; i < rows.length; i++) {
        if ((rows[i][0] || '').trim() === stockNo) {
          series.push({ ymd: ymd, margin: num(rows[i][iMar]), shortBal: num(rows[i][iShort]) });
          break;
        }
      }
    } catch (e) { /* 略過單日 */ }
    Utilities.sleep(120);
  }
  if (!series.length) throw new Error('無融資融券資料（可能為上櫃股或無信用交易）');
  var last = series[series.length - 1];
  var base = series.length > 5 ? series[series.length - 6].margin : series[0].margin;
  return {
    dataDate: last.ymd || '',   // v100：最新MI_MARGN日期（防呆顯示，與worker.js對等）
    marginBal: last.margin,
    marginChg5: base ? (last.margin - base) / base * 100 : 0,
    shortBal: last.shortBal,
    shortRatio: last.margin ? last.shortBal / last.margin * 100 : 0,
    days: series.length
  };
}

/** ──────────────────────────────────────────────────────────
 *  fetchFundamental — 估值(BWIBBU_d) + 月營收(OpenAPI t187ap05_L)
 *  ────────────────────────────────────────────────────────── */
function fetchFundamental(stockNo) {
  if (!/^\d/.test(stockNo)) throw new Error('僅台股上市提供基本面資料');
  var out = { pe: null, pb: null, dividendYield: null, valDate: null, revMoM: null, revYoY: null, revMonth: null };

  // 估值：往回找最近交易日
  for (var d = 0; d <= 7; d++) {
    var day = new Date(Date.now() - d * 86400000);
    var wd = day.getDay();
    if (wd === 0 || wd === 6) continue;
    var ymd = Utilities.formatDate(day, 'Asia/Taipei', 'yyyyMMdd');
    try {
      var r = UrlFetchApp.fetch('https://www.twse.com.tw/exchange/BWIBBU_d?response=json&date=' + ymd + '&selectType=ALL', { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC });
      var j = JSON.parse(r.getContentText());
      var rows = j.data || null;
      if (!rows && j.tables) { for (var t = 0; t < j.tables.length; t++) { var td = j.tables[t].data || []; if (td.length && /^\d{4}/.test((td[0][0] || '').trim())) { rows = td; break; } } }
      if (!rows) continue;
      var bfields = j.fields || null;
      if (!bfields && j.tables) { for (var bt = 0; bt < j.tables.length; bt++) { var bd = j.tables[bt].data || []; if (bd.length && /^\d{4}/.test((bd[0][0]||'').trim())) { bfields = j.tables[bt].fields; break; } } }
      var iY = 2, iPE = 4, iPB = 5;
      if (bfields) {
        for (var bf = 0; bf < bfields.length; bf++) {
          var bs = String(bfields[bf]);
          if (bs.indexOf('殖利率') >= 0) iY = bf;
          if (bs.indexOf('本益比') >= 0) iPE = bf;
          if (bs.indexOf('淨值比') >= 0) iPB = bf;
        }
      }
      for (var i = 0; i < rows.length; i++) {
        if ((rows[i][0] || '').trim() === stockNo) {
          out.dividendYield = num(rows[i][iY]); out.pe = num(rows[i][iPE]); out.pb = num(rows[i][iPB]);
          out.valDate = ymd;   // v123：與 worker.js 對等（估值資料日，供前端顯示與新鮮度檢查）
          break;
        }
      }
      break;
    } catch (e) { /* 試前一天 */ }
  }

  // 月營收（中文鍵以子字串比對防改版）
  var revSrcs = ['t187ap05_L', 't187ap05_O'];  // 上市 → 上櫃 fallback
  for (var s2 = 0; s2 < revSrcs.length && out.revYoY == null; s2++) {
  try {
    var r2 = UrlFetchApp.fetch('https://openapi.twse.com.tw/v1/opendata/' + revSrcs[s2], { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC });
    var arr = JSON.parse(r2.getContentText());
    if (Array.isArray(arr)) {
      for (var a = 0; a < arr.length; a++) {
        var row = arr[a], code2 = null, mom = null, yoy = null, ym = null;
        var keys = Object.keys(row);
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k];
          if (key.indexOf('公司代號') >= 0) code2 = String(row[key]).trim();
          else if (key.indexOf('上月比較') >= 0) mom = num(row[key]);
          else if (key.indexOf('去年同月') >= 0) yoy = num(row[key]);
          else if (key.indexOf('資料年月') >= 0) ym = String(row[key]).trim();
        }
        if (code2 === stockNo) { out.revMoM = mom; out.revYoY = yoy; out.revMonth = ym; break; }
      }
    }
  } catch (e) { /* 換下一來源 */ }
  }

  if (out.pe == null && out.revYoY == null) throw new Error('無基本面資料');
  return out;
}

/** ──────────────────────────────────────────────────────────
 *  FinMind 主力縱深：千張大戶 + 借券空單 + 分點（GAS 序列版）
 *  ────────────────────────────────────────────────────────── */
function fmGet(dataset, params, token) {
  var url = 'https://api.finmindtrade.com/api/v4/data?dataset=' + dataset;
  for (var k in params) url += '&' + k + '=' + encodeURIComponent(params[k]);
  try {
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, timeout: FETCH_TIMEOUT_SEC, headers: { Authorization: 'Bearer ' + token } });
    var j = JSON.parse(r.getContentText());
    return (j && j.data) || [];
  } catch (e) { return []; }
}

function fetchDeepChip(stockNo, token) {
  if (!/^\d/.test(stockNo)) throw new Error('僅台股提供主力縱深');
  var iso = function (d) { return Utilities.formatDate(new Date(Date.now() - d * 86400000), 'Asia/Taipei', 'yyyy-MM-dd'); };

  var holding = fmGet('TaiwanStockHoldingSharesPer', { data_id: stockNo, start_date: iso(70) }, token);
  var sbl = fmGet('TaiwanDailyShortSaleBalances', { data_id: stockNo, start_date: iso(20) }, token);
  var dayTrade = []; try { dayTrade = fmGet('TaiwanStockDayTrading', { data_id: stockNo, start_date: iso(20) }, token); } catch (e) {}
  var inst = []; try { inst = fmGet('TaiwanStockInstitutionalInvestorsBuySell', { data_id: stockNo, start_date: iso(15) }, token); } catch (e) {}

  var big = null;
  if (holding.length) {
    var byDate = {};
    for (var i = 0; i < holding.length; i++) {
      var row = holding[i];
      var lvl = String(row.HoldingSharesLevel || '');
      if (/合|total/i.test(lvl)) continue;
      var mm = lvl.replace(/,/g, '').match(/\d+/);
      var first = mm ? parseInt(mm[0], 10) : 0;
      var pct = Number(row.percent) || 0;
      if (pct >= 100) continue;
      var d = row.date;
      if (!byDate[d]) byDate[d] = { big: 0, small: 0 };
      if (first >= 1000001) byDate[d].big += pct;
      else if (first < 50001) byDate[d].small += pct;
    }
    var dates = Object.keys(byDate).sort();
    if (dates.length) {
      var last = byDate[dates[dates.length - 1]], first0 = byDate[dates[0]];
      big = { bigPct: Math.round(last.big * 100) / 100, bigChg: Math.round((last.big - first0.big) * 100) / 100,
        smallPct: Math.round(last.small * 100) / 100, smallChg: Math.round((last.small - first0.small) * 100) / 100,
        weeks: dates.length, lastDate: dates[dates.length - 1] };
    }
  }

  var lend = null;
  if (sbl.length) {
    var keys = Object.keys(sbl[0]);
    var sblKey = null;
    for (var k2 = 0; k2 < keys.length; k2++) {
      if (/SBL/i.test(keys[k2]) && /Balance/i.test(keys[k2]) && !/Limit|Quota/i.test(keys[k2])) { sblKey = keys[k2]; break; }
    }
    if (sblKey) {
      var series = sbl.map(function (r) { return Number(r[sblKey]) || 0; });
      var bal = series[series.length - 1];
      var base = series.length > 5 ? series[series.length - 6] : series[0];
      lend = { bal: Math.round(bal / 1000), chg5: base ? Math.round((bal - base) / base * 1000) / 10 : 0 };
    }
  }

  var brokers = [];
  var tdates = sbl.map(function (r) { return r.date; }).filter(function (x) { return x; }).sort().slice(-3);
  for (var t = 0; t < tdates.length; t++) {
    var rows = fmGet('TaiwanStockTradingDailyReport', { data_id: stockNo, date: tdates[t] }, token);
    if (!rows.length) continue;
    var sumBuy = 0, sumSell = 0;
    var nets = rows.map(function (r) { var b = Number(r.buy) || 0, s = Number(r.sell) || 0; sumBuy += b; sumSell += s; return b - s; })
      .sort(function (a, b) { return b - a; });
    var mainBuy = 0, mainSell = 0;
    for (var a = 0; a < Math.min(15, nets.length); a++) if (nets[a] > 0) mainBuy += nets[a];
    for (var z = Math.max(0, nets.length - 15); z < nets.length; z++) if (nets[z] < 0) mainSell += nets[z];
    var tot = sumBuy + sumSell;
    brokers.push({ date: tdates[t], mainNet: Math.round((mainBuy + mainSell) / 1000),
      conc: tot ? Math.round((mainBuy - mainSell) / tot * 1000) / 10 : 0 });
    Utilities.sleep(120);
  }

  if (!big && !lend && !brokers.length) throw new Error('FinMind 無此股資料或 token 無效');
  // 當沖比重
  var dayTrading = null;
  if (dayTrade.length) {
    var dtRows = dayTrade.filter(function (r) { return Number(r.Volume) > 0; });
    if (dtRows.length >= 3) {
      var ratios = dtRows.map(function (r) { return (Number(r.BuyAfterSale) || 0) / Number(r.Volume) * 100; });
      var curR = ratios[ratios.length - 1];
      var avgR = ratios.reduce(function (a, b) { return a + b; }, 0) / ratios.length;
      dayTrading = { cur: Math.round(curR * 10) / 10, avg20: Math.round(avgR * 10) / 10, days: dtRows.length };
    }
  }
  // 自營商自行 vs 避險
  var dealer = null;
  if (inst.length) {
    var self5 = 0, hedge5 = 0, seenD = {};
    for (var ii = 0; ii < inst.length; ii++) {
      var rr = inst[ii];
      if (rr.name === 'Dealer_self') { self5 += (Number(rr.buy) - Number(rr.sell)) || 0; seenD[rr.date] = 1; }
      if (rr.name === 'Dealer_Hedging') { hedge5 += (Number(rr.buy) - Number(rr.sell)) || 0; }
    }
    if (Object.keys(seenD).length >= 3) {
      dealer = { selfNet: Math.round(self5 / 1000), hedgeNet: Math.round(hedge5 / 1000), days: Object.keys(seenD).length };
    }
  }
  return { big: big, lend: lend, brokers: brokers, dayTrading: dayTrading, dealer: dealer };
}
