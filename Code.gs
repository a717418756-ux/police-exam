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
 */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
  var code = (e && e.parameter && e.parameter.code ? e.parameter.code : '').trim().toUpperCase();
  var result;

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
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
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
        var resp2 = UrlFetchApp.fetch(url2, { muteHttpExceptions: true });
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

  // T86 每日資料，抓近 20 個交易日（往回約 26 個日曆日足夠）
  for (var d = 25; d >= 0; d--) {
    var day = new Date(now.getTime() - d * 86400000);
    var wd = day.getDay();
    if (wd === 0 || wd === 6) continue; // 跳過週末
    var ymd = Utilities.formatDate(day, 'Asia/Taipei', 'yyyyMMdd');
    var url = 'https://www.twse.com.tw/fund/T86?response=json&date=' + ymd + '&selectType=ALLBUT0999';
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var j = JSON.parse(resp.getContentText());
      if (j.stat !== 'OK' || !j.data) continue;
      for (var i = 0; i < j.data.length; i++) {
        var row = j.data[i];
        var rcode = (row[0] || '').trim();
        if (rcode === stockNo) {
          var foreign = num(row[4]) / 1000;
          var trust   = num(row[10]) / 1000;
          var dealer  = num(row[11]) / 1000;
          foreignSeries.push(foreign);
          trustSeries.push(trust);
          dealerSeries.push(dealer);
          dates.push(ymd);
          break;
        }
      }
    } catch (e) { /* 略過單日 */ }
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

  return {
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
            '?interval=1d&range=1y';
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  var j = JSON.parse(resp.getContentText());
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('找不到美股 ' + symbol + '，請確認代碼');

  var q = res.indicators.quote[0];
  var meta = res.meta;

  var closes = clean(q.close);
  var highs  = clean(q.high);
  var lows   = clean(q.low);
  var opens  = clean(q.open);
  var vols   = clean(q.volume);

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
    closes: closes, highs: highs, lows: lows, volumes: vols
  };
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

  // ── 1. 期交所：三大法人期貨未平倉（台指期）─────────────────
  try {
    // 期交所 OpenAPI：三大法人－區分各期貨契約－依日期
    var url1 = 'https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfAsSpecificFuturesContractByDate';
    var r1 = UrlFetchApp.fetch(url1, { muteHttpExceptions: true });
    var arr1 = JSON.parse(r1.getContentText());
    // 篩出台指期(TX)，加總三大法人多空淨額未平倉口數
    var txRows = arr1.filter(function(x){
      var name = x['商品名稱'] || x['ContractName'] || '';
      return name.indexOf('臺股期貨') >= 0 || name === 'TX';
    });
    if (txRows.length) {
      var foreignNet = 0, totalNet = 0, dataDate = '';
      txRows.forEach(function(x){
        dataDate = x['日期'] || x['Date'] || dataDate;
        var who = x['身份別'] || x['InstitutionalInvestorType'] || '';
        var net = num(x['多空淨額未平倉口數'] || x['OpenInterestNetLongAndShort'] || x['多空淨額交易口數'] || 0);
        totalNet += net;
        if (who.indexOf('外資') >= 0) foreignNet = net;
      });
      out.taifex.date = dataDate;
      out.taifex.foreignNet = foreignNet;        // 外資台指期淨未平倉(口)
      out.taifex.institutionNet = totalNet;      // 三大法人合計淨未平倉(口)
    }
  } catch(e){ out.taifex.error = String(e); }

  // ── 2. 期交所：選擇權 PCR（Put/Call Ratio）────────────────
  try {
    var url2 = 'https://openapi.taifex.com.tw/v1/PutCallRatio';
    var r2 = UrlFetchApp.fetch(url2, { muteHttpExceptions: true });
    var arr2 = JSON.parse(r2.getContentText());
    if (arr2.length) {
      var latest = arr2[0]; // 最新一筆
      out.taifex.pcrOI = num(latest['putCallRatioOfOpenInterest'] || latest['未平倉量比率%'] || latest['PutCallRatio'] || 0);
      out.taifex.pcrVol = num(latest['putCallRatioOfVolume'] || latest['成交量比率%'] || 0);
      out.taifex.pcrDate = latest['date'] || latest['日期'] || '';
    }
  } catch(e){ out.taifex.pcrError = String(e); }

  // ── 3. 美股隔夜：SOX 費半 + Nasdaq（透過 Yahoo）────────────
  try {
    out.us.sox = yahooQuote('^SOX');     // 費城半導體
    out.us.nasdaq = yahooQuote('^IXIC'); // 那斯達克
    out.us.sp500 = yahooQuote('^GSPC');  // 標普500
    out.us.vix = yahooQuote('^VIX');     // VIX 恐慌指數（新增）
  } catch(e){ out.us.error = String(e); }

  return out;
}

/** 抓單一美股/指數最新報價與漲跌幅 */
function yahooQuote(symbol) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=5d';
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
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

/** ──────────────────────────────────────────────────────────
 *  fetchRangeOHLC — 抓指定日期區間的每日 OHLC
 *  給交易日誌自動計算 MAE（最大不利）/ MFE（最大有利）
 *  code: 2330 或 AAPL；from/to: yyyy-MM-dd
 *  ────────────────────────────────────────────────────────── */
function fetchRangeOHLC(code, from, to) {
  if (!code) throw new Error('缺少股票代碼');
  if (!from || !to) throw new Error('缺少日期區間');

  // 台股加 .TW
  var symbol = /^\d/.test(code) ? code + '.TW' : code;

  // Yahoo period1/period2（Unix 秒），to 多加一天確保含當日
  var p1 = Math.floor(new Date(from + 'T00:00:00').getTime() / 1000);
  var p2 = Math.floor(new Date(to + 'T23:59:59').getTime() / 1000) + 86400;

  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
            '?interval=1d&period1=' + p1 + '&period2=' + p2;
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  var j = JSON.parse(r.getContentText());
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('找不到 ' + code + ' 的區間資料');

  var q = res.indicators.quote[0];
  var highs = [], lows = [], closes = [];
  for (var i = 0; i < (q.high || []).length; i++) {
    if (q.high[i] != null) highs.push(q.high[i]);
    if (q.low[i] != null) lows.push(q.low[i]);
    if (q.close[i] != null) closes.push(q.close[i]);
  }
  if (highs.length === 0) throw new Error('區間內無交易資料（可能日期錯誤或非交易日）');

  return {
    rangeHigh: Math.max.apply(null, highs),   // 區間最高
    rangeLow: Math.min.apply(null, lows),     // 區間最低
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
  var symbol = /^\d/.test(code) ? code + '.TW' : code;
  // 抓 until 往前 200 個日曆日（確保有足夠交易日）
  var untilTime = Math.floor(new Date(until + 'T23:59:59').getTime() / 1000) + 86400;
  var fromTime = untilTime - 200 * 86400;
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
            '?interval=1d&period1=' + fromTime + '&period2=' + untilTime;
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  var j = JSON.parse(r.getContentText());
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('找不到 ' + code + ' 的歷史資料');
  var q = res.indicators.quote[0];
  var closes = [], highs = [], lows = [], volumes = [];
  for (var i = 0; i < (q.close || []).length; i++) {
    if (q.close[i] != null) { closes.push(q.close[i]); highs.push(q.high[i]); lows.push(q.low[i]); volumes.push(q.volume[i] || 0); }
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
              '?interval=1d&range=1y';
    try {
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
      var j = JSON.parse(r.getContentText());
      var res = j.chart && j.chart.result && j.chart.result[0];
      if (!res || !res.indicators || !res.indicators.quote) continue;
      var q = res.indicators.quote[0];
      var meta = res.meta || {};
      var ts = res.timestamp || [];
      var closes = [], highs = [], lows = [], opens = [], vols = [];
      for (var i = 0; i < ts.length; i++) {
        if (q.close[i] == null) continue;
        closes.push(q.close[i]); highs.push(q.high[i]); lows.push(q.low[i]);
        opens.push(q.open[i]); vols.push(q.volume[i] || 0);
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
        closes: closes, highs: highs, lows: lows, volumes: vols
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
      var r = UrlFetchApp.fetch('https://www.twse.com.tw/exchange/MI_MARGN?response=json&date=' + ymd + '&selectType=ALL', { muteHttpExceptions: true });
      var j = JSON.parse(r.getContentText());
      var rows = j.data || null;
      if (!rows && j.tables) {  // 新版格式：找含個股列的表
        for (var t = 0; t < j.tables.length; t++) {
          var td = j.tables[t].data || [];
          if (td.length && /^\d{4}/.test((td[0][0] || '').trim())) { rows = td; break; }
        }
      }
      if (!rows) continue;
      for (var i = 0; i < rows.length; i++) {
        if ((rows[i][0] || '').trim() === stockNo) {
          // 欄位：融資今日餘額 idx6、融券今日餘額 idx12
          series.push({ ymd: ymd, margin: num(rows[i][6]), shortBal: num(rows[i][12]) });
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
    marginBal: last.margin,
    marginChg5: base ? (last.margin - base) / base * 100 : 0,
    shortBal: last.shortBal,
    shortRatio: last.margin ? last.shortBal / last.margin * 100 : 0,
    days: series.length
  };
}
