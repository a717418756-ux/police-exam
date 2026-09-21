// ══ settings.js — 設定與匯出 ══════════════════════════
// 依賴：db.js, utils.js, data.js(getWrong), countdown.js(renderSetCountdown)
//
// v2.8.2 重構：
// - IIFE 模組化，內部函式私有化（_gasGetConfig、buildHTML、_blobToBase64 等）
// - 偵錯面板按鈕改 addEventListener（不再依賴全域 _debugLogs/_debugCopyAll）
// - 匯出 HTML / 設定頁 innerHTML 補上 esc()（防止題目含 < > 字元時版面壞掉）
// - 雲端備援補 HTTP 狀態檢查（錯誤訊息更明確）
// - 功能與 v2.8.1 完全相同

(function(){
'use strict';

// ══════════════════════════════════════════════════════════════
// ══ 雲端備份（Google Apps Script）══════════════════════════════
// 架構：PWA → POST → Apps Script → Google Drive
// 不需要 OAuth 登入，只需 Script URL + 自訂密碼
// ══════════════════════════════════════════════════════════════

const GAS_URL_KEY      = 'gasWebAppUrl';
const GAS_PWD_KEY      = 'gasPassword';
const GAS_BACKUP_FILE  = 'YC_Platform_backup.json';
const GAS_SIZE_WARN    = 30 * 1048576;   // Apps Script 上傳約 50MB 上限，30MB 起提醒

// ══ 備份共用規則 ════════════════════════════════════════════════
// 備份用的設定：清掉 7 天前的每日任務勾選紀錄
//   dtask_done_日期 每天新增一筆，只有「當天」會被讀取（歷史達成率另存
//   dtask_history，自己只留 30 天），舊的留著只會讓設定越積越多。
async function _backupSettings(){
  const cut = new Date(); cut.setDate(cut.getDate() - 7);
  const cutKey = 'dtask_done_' + cut.getFullYear() + '-' + String(cut.getMonth()+1).padStart(2,'0')
               + '-' + String(cut.getDate()).padStart(2,'0');
  const keep = [];
  for(const st of await da('settings')){
    if(/^dtask_done_\d{4}-\d{2}-\d{2}$/.test(st.key) && st.key < cutKey){ await dd('settings', st.key); continue; }
    keep.push(st);
  }
  return keep;
}

// 搜尋索引 searchBlob 由其他欄位算得，不寫進備份（約省 1/4 容量），還原時重建。
// ★ 公式必須與 data.js 的 saveQ／saveLaw 完全一致。
const _noBlob = rows => rows.map(({ searchBlob, ...r }) => r);
const _blobQ = q => ((q.stem||'')+' '+(q.groupStem||'')+' '+(q.subject||'')+' '+(q.year||'')+' '
  +(q.exam||'')+' '+(q.num||'')+' '+(q.keywords||[]).join(' ')).toLowerCase();
const _blobLaw = l => [l.lawName, l.article, String(l.articleNumber||''), l.title,
  (l.keywords||[]).join(' '), (l.content||'').startsWith('data:') ? '' : (l.content||'')]
  .filter(Boolean).join(' ').toLowerCase();

// 還原一個資料表：檔案「有這個表」就以檔案為準，空陣列也會清空；
// 檔案「沒有這個表」（舊版備份、雲端備份沒有學習區）才略過，保留手機現有資料。
// ★ 原本空陣列也略過：備份時是空的表，還原後手機上的舊資料仍留著，與備份不一致。
async function _restoreTable(name, rows){
  if(!Array.isArray(rows)) return 0;
  if(name === 'questions') rows = rows.map(q => ({ ...q, searchBlob: _blobQ(q) }));
  if(name === 'laws')      rows = rows.map(l => {   // 條號一律以 art2n 為準（舊備份、桌面版寫回的可能是舊格式）
    const r = { ...l, articleNumber: art2n(l.article) || l.articleNumber || 0 };
    r.searchBlob = _blobLaw(r); return r;
  });
  await dc(name);
  if(rows.length) await bulkPut(name, rows);
  return rows.length;
}
// 設定逐筆覆蓋、不清空
async function _restoreSettings(rows){
  let n = 0;
  for(const st of (Array.isArray(rows) ? rows : [])){
    if(!st || st.key == null) continue;
    await dp('settings', st); n++;
  }
  return n;
}
const _mb = n => (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';

// ════════════════════════════════════════════════════════════
// 【雲端備份：GAS 設定】
// ════════════════════════════════════════════════════════════
async function _gasGetConfig(){
  const url = await getSetting(GAS_URL_KEY,'');
  const pwd = await getSetting(GAS_PWD_KEY,'');
  return { url: url.trim(), pwd: pwd.trim() };
}

async function saveGasConfig(){
  const url = (document.getElementById('gas-url-input')?.value||'').trim();
  const pwd = (document.getElementById('gas-pwd-input')?.value||'').trim();
  if(!url){ toast('請填入 Apps Script 網址'); return; }
  await setSetting(GAS_URL_KEY, url);
  await setSetting(GAS_PWD_KEY, pwd);
  toast('設定已儲存 ✓');
}

async function _gasLoadSavedConfig(){
  const { url, pwd } = await _gasGetConfig();
  const urlEl = document.getElementById('gas-url-input');
  const pwdEl = document.getElementById('gas-pwd-input');
  if(urlEl && url) urlEl.value = url;
  if(pwdEl && pwd) pwdEl.value = pwd;
}

// ── 備份 ────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
// 【雲端備份：備份/還原】
// ════════════════════════════════════════════════════════════
async function gdriveBackup(){ try{
  const { url, pwd } = await _gasGetConfig();
  if(!url){ toast('請先在設定頁填入 Apps Script 網址'); return; }
  toast('備份中…');
  // 雲端備份：考試區 + 答題記錄 + 倒數日 + 使用統計 + 設定（不含 blob 類大檔）
  //   englishVocab（單字本，含自己的遺忘曲線進度）與 healthLogs（健康數據）
  //   都是純文字、無 blob 欄位，理應納入雲端備份；先前漏掉會導致還原後這兩塊資料消失。
  const [qs, ls, ats, countdowns, usageLogs, englishVocab, healthLogs, engMats] = await Promise.all([
    da('questions'), da('laws'), da('attempts'),
    da('countdowns'), da('usageLogs'),
    da('englishVocab'), da('healthLogs'), da('englishMaterials')
  ]);
  const settings = await _backupSettings();
  const body = JSON.stringify({
      version: 3,
      exportedAt: new Date().toISOString(),
      questions: _noBlob(qs),
      laws: _noBlob(ls),
      attempts: ats,
      countdowns: countdowns,
      usageLogs: usageLogs,
      settings: settings,
      englishVocab: englishVocab,
      healthLogs: healthLogs,
      // englishMaterials 存的是切分後的句子陣列（純文字、無 blob），
      // 資料量遠小於題庫，納入雲端備份不會造成負擔
      englishMaterials: engMats
  });
  const size = new Blob([body]).size;
  if(size > GAS_SIZE_WARN && !confirm('雲端備份檔 ' + _mb(size) + '，接近 Google Apps Script 的上傳上限，可能會失敗。\n'
      + '建議改用「本機完整備份」。仍要上傳？')) return;
  const payload = { password: pwd, action: 'backup', filename: GAS_BACKUP_FILE, data: body };
  const res  = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'text/plain'},
    body: JSON.stringify(payload)
  });
  if(!res.ok){ toast('備份失敗：HTTP '+res.status); return; }
  const json = await res.json();
  if(json.ok){
    const t = new Date().toLocaleString('zh-TW');
    await setSetting('lastBackupTime', t);
    _showDoneDialog('雲端備份完成 ✓', [
      '已上傳到你的 Google Drive。',
      '',
      '時間：' + t,
      '大小：' + _mb(size),
      '涵蓋：題庫、法條、答題記錄、設定、倒數日、統計、英語教材、單字本、健康數據',
    ]);
    renderSet();
  }
  else{ toast('備份失敗：'+(json.error||'未知錯誤')); }
}catch(e){ logError('gdriveBackup',e); toast('備份失敗：'+e.message); }}

// ── 還原 ────────────────────────────────────────────────────
async function gdriveRestore(){ try{
  const { url, pwd } = await _gasGetConfig();
  if(!url){ toast('請先在設定頁填入 Apps Script 網址'); return; }
  cfm('從雲端還原','現有資料將被覆蓋，確定繼續？', async()=>{
    // ── callback 內有獨立的 try-catch（cfm 是非同步，外層 catch 無法攔截）──
    try{
      toast('還原中…');
      const res  = await fetch(url, {
        method:'POST',
        headers:{'Content-Type':'text/plain'},
        body: JSON.stringify({ password:pwd, action:'restore', filename:GAS_BACKUP_FILE })
      });
      if(!res.ok){ toast('還原失敗：HTTP '+res.status); return; }
      const json = await res.json();
      if(!json.ok){ toast('還原失敗：'+(json.error||'未知錯誤')); return; }

      // json.data 可能是字串或已解析的物件（依 GAS 實作而定）
      const bk = (typeof json.data === 'string') ? JSON.parse(json.data) : json.data;
      if(!bk || typeof bk !== 'object'){
        toast('還原失敗：備份資料格式錯誤'); return;
      }

      // 至少要有題目或法規，避免把空的（或壞掉的）備份蓋回來
      const hasData = (bk.questions?.length || bk.laws?.length);
      if(!hasData){
        toast('還原失敗：備份資料為空，請先備份再還原'); return;
      }

      for(const t of ['questions','laws','attempts','countdowns','usageLogs',
                      'englishVocab','healthLogs','englishMaterials'])
        await _restoreTable(t, bk[t]);
      await _restoreSettings(bk.settings);

      _cacheInvalidate();
      const rt = new Date().toLocaleString('zh-TW');
      await setSetting('lastRestoreTime', rt);
      _showDoneDialog('雲端還原完成 ✓', [
        '資料已從 Google Drive 還原。',
        '',
        '時間：' + rt,
        '按「知道了」後會重新整理頁面。',
      ], ()=> location.reload());
    } catch(innerErr){
      logError('gdriveRestore-inner', innerErr);
      toast('還原失敗：'+innerErr.message);
    }
  });
}catch(e){ logError('gdriveRestore',e); toast('還原失敗：'+e.message); }}


// ════════════════════════════════════════════════════════════
// 【設定頁渲染】
// ════════════════════════════════════════════════════════════
async function renderSet(){  _renderAzureKey().catch(()=>{}); try{
  const[qs,ats,ls]=await Promise.all([da('questions'),da('attempts'),da('laws')]);
  const subs=[...new Set(qs.map(q=>q.subject).filter(Boolean))];
  document.getElementById('db-info').innerHTML=`總題數：${qs.length}<br>法條數：${ls.length}<br>作答記錄：${ats.length}<br>科目：${esc(subs.join('、'))||'無'}<br>題型：選擇 ${qs.filter(q=>q.type==='mc').length} / 申論 ${qs.filter(q=>q.type==='es').length}`;
  renderSetCountdown();
  _gasLoadSavedConfig();
  // 版本號與備份時間
  const [lastBk, lastRs] = await Promise.all([
    getSetting('lastBackupTime','—'),
    getSetting('lastRestoreTime','—')
  ]);
  const verInfoEl = document.getElementById('set-ver-info');
  if(verInfoEl){
    const av = typeof APP_VERSION  !== 'undefined' ? APP_VERSION  : '';
    const dv = typeof DATA_VERSION !== 'undefined' ? DATA_VERSION : '';
    verInfoEl.innerHTML =
      `程式版本：<b>v${av}</b>　題庫版本：<b>${dv}</b><br>` +
      `最後備份：<span style="color:var(--t2)">${esc(lastBk)}</span>　` +
      `最後還原：<span style="color:var(--t2)">${esc(lastRs)}</span>`;

    // 診斷資訊：錯誤日誌
    const diagEl = document.getElementById('set-diag-info');
    if(diagEl){
      const errs = typeof _errLog !== 'undefined' ? _errLog : [];
      if(errs.length === 0){
        diagEl.innerHTML = '<span style="color:var(--grn)">✓ 無錯誤記錄</span>';
      } else {
        const errHtml = errs.slice(-5).reverse().map(e=>
          `<div style="color:var(--red2,#c00);font-size:11px;border-left:2px solid var(--red);padding-left:6px;margin-bottom:4px">` +
          `<b>${esc(e.ctx)}</b>：${esc(e.msg)}<br><span style="color:var(--t2)">${esc(e.t.replace('T',' ').slice(0,19))}</span></div>`
        ).join('');
        diagEl.innerHTML = `<div style="color:var(--t2);font-size:11px;margin-bottom:4px">最近 ${errs.length} 筆錯誤（顯示最後5筆）：</div>${errHtml}`;
      }
    }
  }
  }catch(e){ logError('renderSet',e); }}

// ════════════════════════════════════════════════════════════
// 【資料匯出/匯入】
// ════════════════════════════════════════════════════════════
async function expWrong(){  try{
  const[qs,ats]=await Promise.all([da('questions'),da('attempts')]);
  const wids=getWrong(qs,ats);const wqs=qs.filter(q=>wids.has(q.id));
  if(!wqs.length){toast('目前沒有錯題');return;}
  dl(_buildHTML(wqs,'錯題整理'),'警察考題_錯題_'+today()+'.html','text/html');toast(`匯出 ${wqs.length} 題`);
  }catch(e){ logError('expWrong',e); }}

async function expAll(){  try{
  const qs=await da('questions');if(!qs.length){toast('題庫是空的');return;}
  dl(_buildHTML(qs,'警察考題庫'),'警察考題庫_'+today()+'.html','text/html');toast(`匯出 ${qs.length} 題`);
  }catch(e){ logError('expAll',e); }}

function _buildHTML(qs,title){
  const grp={};qs.forEach(q=>{const s=q.subject||'未分類';if(!grp[s])grp[s]=[];grp[s].push(q);});
  const d=new Date().toLocaleDateString('zh-TW');
  let out='<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><title>'+esc(title)+'</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:24px;line-height:1.8;color:#111}h1{font-size:22px;border-bottom:2px solid #333;padding-bottom:7px}h2{font-size:17px;color:#1f6feb;margin-top:28px}.q{margin:14px 0;padding:14px;border:1px solid #ddd;border-radius:8px}.qn{font-size:11px;color:#666}.qs{font-size:14px;font-weight:600;margin-bottom:8px}.opt{font-size:13px;margin:3px 0}.ans{margin-top:8px;font-size:12px;color:#1f6feb;font-weight:600}.note{font-size:11px;color:#666}</style></head><body><h1>'+esc(title)+' — '+d+'</h1>';
  Object.entries(grp).forEach(([sub,sqs])=>{
    out+='<h2>'+esc(sub)+'</h2>';
    sqs.forEach((q,i)=>{
      const meta=[q.year,q.exam,q.num?'第'+q.num+'題':''].filter(Boolean).join(' · ');
      out+='<div class="q"><div class="qn">'+esc(meta)+' · '+(q.type==='mc'?'選擇題':'申論題')+'</div><div class="qs">'+(i+1)+'. '+esc(q.stem||'')+'</div>';
      if(q.type==='mc')Object.entries(q.options||{}).forEach(([k,v])=>{out+='<div class="opt">('+esc(k)+') '+esc(v)+'</div>';});
      if(q.answer)out+='<div class="ans">答案：'+esc(q.answer)+'</div>';
      if(q.answerEs)out+='<div class="note">解析：'+esc(q.answerEs)+'</div>';
      if(q.note)out+='<div class="note">備註：'+esc(q.note)+'</div>';
      out+='</div>';
    });
  });
  return out+'\n</body></html>';
}

// ════════════════════════════════════════════════════════════
// 【資料清除】
// ════════════════════════════════════════════════════════════
async function clearAts(){  try{
  await dc('attempts');
  toast('作答記錄已清除');
  renderSet();
  }catch(e){ logError('clearAts',e); }}

async function delAll(){  try{
  await dc('questions');
  await dc('attempts');
  await dc('laws');
  toast('已全部刪除');
  renderSet();
  }catch(e){ logError('delAll',e); }}


function toggleGasHelp(){
  const el = document.getElementById('gas-help');
  if(!el) return;
  el.classList.toggle('hide');
}

// ════════════════════════════════════════════════════════════
// 本地完整備份 / 還原（書庫 + 影音庫，含實際 Blob 檔案）
// 使用 File System Access API（Chrome/Edge/Android Chrome 支援）
// ════════════════════════════════════════════════════════════

// 備份：選擇本地資料夾，將所有書庫和影音庫逐檔案寫入
async function localBackup(){
  if(!window.showDirectoryPicker){
    toast('你的瀏覽器不支援資料夾存取，請用 Chrome 或 Edge');
    return;
  }
  try{
    const dirHandle = await window.showDirectoryPicker({ mode:'readwrite' });
    toast('備份中…請稍候');

    const [ebooks, media, qs, ls, ats, countdowns, usageLogs, refbooks, learnmedia, engMats,
           engVocab, healthLogs] = await Promise.all([
      da('ebooks'), da('leisuremedia'), da('questions'), da('laws'),
      da('attempts'), da('countdowns'), da('usageLogs'),
      da('refbooks'), da('learnmedia'), da('englishMaterials'),
      da('englishVocab'), da('healthLogs')
    ]);
    const settings = await _backupSettings();

    let count = 0;

    // ── 完整資料備份（JSON 單檔，含設定/答題/倒數/統計等非 blob 資料）──
    // englishMaterials 可能含大型內容，但無獨立 blob 欄位，一併寫入
    const examHandle = await dirHandle.getFileHandle('exam_data.json', { create:true });
    const examWriter = await examHandle.createWritable();
    const examBody = JSON.stringify({
      version: 3,
      exportedAt: new Date().toISOString(),
      questions: _noBlob(qs),
      laws: _noBlob(ls),
      attempts: ats,
      settings: settings,
      countdowns: countdowns,
      usageLogs: usageLogs,
      refbooks: refbooks,
      learnmedia: learnmedia,
      englishMaterials: engMats,
      // 單字本與健康數據：純文字無 blob，先前漏備份會導致還原後資料消失
      englishVocab: engVocab,
      healthLogs: healthLogs
    });
    await examWriter.write(examBody);
    await examWriter.close();
    count++;  // exam_data.json 計入項目數

    // ── 書庫備份 ──
    const ebooksDir = await dirHandle.getDirectoryHandle('ebooks', { create:true });
    for(const book of ebooks){
      // metadata（不含 blob 欄位）寫成 JSON
      const { blob:_b, coverBlob:_cb, ...meta } = book;
      // 縮圖（coverThumb, spineThumb）是 Blob，轉成 base64 存在 meta JSON 裡
      const metaOut = { ...meta };
      if(meta.coverThumb instanceof Blob){
        metaOut.coverThumb = await _blobToBase64(meta.coverThumb);
        metaOut._coverThumbIsBase64 = true;
      }
      if(meta.spineThumb instanceof Blob){
        metaOut.spineThumb = await _blobToBase64(meta.spineThumb);
        metaOut._spineThumbIsBase64 = true;
      }
      const metaHandle = await ebooksDir.getFileHandle(`${book.id}.meta.json`, { create:true });
      const metaWriter = await metaHandle.createWritable();
      await metaWriter.write(JSON.stringify(metaOut));
      await metaWriter.close();

      // 實際書檔 blob
      if(book.blob){
        const ext = book.fileType || 'bin';
        const fileHandle = await ebooksDir.getFileHandle(`${book.id}.${ext}`, { create:true });
        const writer = await fileHandle.createWritable();
        await writer.write(book.blob);
        await writer.close();
      }
      count++;
    }

    // ── 影音庫備份 ──
    const mediaDir = await dirHandle.getDirectoryHandle('media', { create:true });
    for(const m of media){
      // metadata
      const { blob:_b, ...meta } = m;
      const metaOut = { ...meta };
      if(meta.thumbnail instanceof Blob){
        metaOut.thumbnail = await _blobToBase64(meta.thumbnail);
        metaOut._thumbnailIsBase64 = true;
      }
      const metaHandle = await mediaDir.getFileHandle(`${m.id}.meta.json`, { create:true });
      const metaWriter = await metaHandle.createWritable();
      await metaWriter.write(JSON.stringify(metaOut));
      await metaWriter.close();

      // 實際媒體 blob
      if(m.blob){
        const ext = m.mimeType?.split('/')[1] || m.type || 'bin';
        const fileHandle = await mediaDir.getFileHandle(`${m.id}.${ext}`, { create:true });
        const writer = await fileHandle.createWritable();
        await writer.write(m.blob);
        await writer.close();
      }
      count++;
    }

    // ── 學習區備份（refbooks 參考書 / learnmedia 教材影音）──
    //   先前只把 meta 寫進 exam_data.json，實際檔案 blob 完全沒備份，
    //   還原後會變成「有標題但打不開」的空殼。這裡比照書庫／影音庫寫出檔案。
    const refDir = await dirHandle.getDirectoryHandle('refbooks', { create:true });
    for(const rb of refbooks){
      const { blob:_b, coverBlob:_cb, ...meta } = rb;
      const metaOut = { ...meta };
      if(meta.coverThumb instanceof Blob){
        metaOut.coverThumb = await _blobToBase64(meta.coverThumb);
        metaOut._coverThumbIsBase64 = true;
      }
      const mh = await refDir.getFileHandle(`${rb.id}.meta.json`, { create:true });
      const mw = await mh.createWritable();
      await mw.write(JSON.stringify(metaOut));
      await mw.close();
      if(rb.blob){
        const ext = rb.fileType || 'bin';
        const fh = await refDir.getFileHandle(`${rb.id}.${ext}`, { create:true });
        const w  = await fh.createWritable();
        await w.write(rb.blob);
        await w.close();
      }
      count++;
    }

    const lmDir = await dirHandle.getDirectoryHandle('learnmedia', { create:true });
    for(const lm of learnmedia){
      const { blob:_b, ...meta } = lm;
      const metaOut = { ...meta };
      if(meta.thumbnail instanceof Blob){
        metaOut.thumbnail = await _blobToBase64(meta.thumbnail);
        metaOut._thumbnailIsBase64 = true;
      }
      const mh = await lmDir.getFileHandle(`${lm.id}.meta.json`, { create:true });
      const mw = await mh.createWritable();
      await mw.write(JSON.stringify(metaOut));
      await mw.close();
      if(lm.blob){
        const ext = lm.mimeType?.split('/')[1] || lm.mediaType || 'bin';
        const fh = await lmDir.getFileHandle(`${lm.id}.${ext}`, { create:true });
        const w  = await fh.createWritable();
        await w.write(lm.blob);
        await w.close();
      }
      count++;
    }

    _showDoneDialog('本機備份完成 ✓', [
      '共 ' + count + ' 個項目已寫入你選的資料夾。',
      '',
      '時間：' + new Date().toLocaleString('zh-TW'),
      '內容：exam_data.json（' + _mb(new Blob([examBody]).size) + '）＋ ebooks／media／refbooks／learnmedia 四個資料夾',
    ]);
  }catch(e){
    if(e.name === 'AbortError') return;  // 使用者取消
    logError('localBackup', e);
    toast('備份失敗：' + e.message);
  }
}

// 還原：選擇備份資料夾，讀取並還原所有項目
async function localRestore(){
  if(!window.showDirectoryPicker){
    toast('你的瀏覽器不支援資料夾存取，請用 Chrome 或 Edge');
    return;
  }
  cfm('本地完整還原', '所有資料（題庫、法條、答題記錄、設定、倒數日、統計、書庫、影音、學習區教材、英語庫、單字本、健康數據）將被覆蓋，確定繼續？', async()=>{
    try{
      const dirHandle = await window.showDirectoryPicker({ mode:'read' });
      toast('還原中…請稍候');

      let count = 0;

      // ── 題庫 + 法條還原 ──
      try{
        const examHandle = await dirHandle.getFileHandle('exam_data.json');
        const examFile   = await examHandle.getFile();
        const examData   = JSON.parse(await examFile.text());
        for(const t of ['questions','laws','attempts','countdowns','usageLogs','refbooks','learnmedia',
                        'englishMaterials','englishVocab','healthLogs'])
          count += await _restoreTable(t, examData[t]);
        count += await _restoreSettings(examData.settings);
      }catch(e){ /* exam_data.json 不存在就跳過 */ }

      // ── 書庫還原 ──
      try{
        const ebooksDir = await dirHandle.getDirectoryHandle('ebooks');
        await dc('ebooks');
        for await(const [name, handle] of ebooksDir.entries()){
          if(!name.endsWith('.meta.json')) continue;
          const file = await handle.getFile();
          const meta = JSON.parse(await file.text());

          // 還原縮圖 Blob
          if(meta._coverThumbIsBase64 && meta.coverThumb){
            meta.coverThumb = await _base64ToBlob(meta.coverThumb, 'image/jpeg');
            delete meta._coverThumbIsBase64;
          }
          if(meta._spineThumbIsBase64 && meta.spineThumb){
            meta.spineThumb = await _base64ToBlob(meta.spineThumb, 'image/jpeg');
            delete meta._spineThumbIsBase64;
          }

          // 讀取書檔 blob
          const ext = meta.fileType || 'bin';
          try{
            const blobHandle = await ebooksDir.getFileHandle(`${meta.id}.${ext}`);
            meta.blob = await blobHandle.getFile();
          }catch(e){ meta.blob = null; }

          await dp('ebooks', meta);
          count++;
        }
      }catch(e){ /* ebooks 資料夾不存在就跳過 */ }

      // ── 影音庫還原 ──
      try{
        const mediaDir = await dirHandle.getDirectoryHandle('media');
        await dc('leisuremedia');
        for await(const [name, handle] of mediaDir.entries()){
          if(!name.endsWith('.meta.json')) continue;
          const file = await handle.getFile();
          const meta = JSON.parse(await file.text());

          // 還原縮圖 Blob
          if(meta._thumbnailIsBase64 && meta.thumbnail){
            meta.thumbnail = await _base64ToBlob(meta.thumbnail, 'image/jpeg');
            delete meta._thumbnailIsBase64;
          }

          // 讀取媒體 blob
          const ext = meta.mimeType?.split('/')[1] || meta.type || 'bin';
          try{
            const blobHandle = await mediaDir.getFileHandle(`${meta.id}.${ext}`);
            meta.blob = await blobHandle.getFile();
          }catch(e){ meta.blob = null; }

          await dp('leisuremedia', meta);
          count++;
        }
      }catch(e){ /* media 資料夾不存在就跳過 */ }

      // ── 學習區還原（refbooks / learnmedia 的實際檔案）──
      //   舊版備份沒有這兩個資料夾時會直接跳過，不影響其他還原結果。
      try{
        const refDir = await dirHandle.getDirectoryHandle('refbooks');
        await dc('refbooks');
        for await(const [name, handle] of refDir.entries()){
          if(!name.endsWith('.meta.json')) continue;
          const meta = JSON.parse(await (await handle.getFile()).text());
          if(meta._coverThumbIsBase64 && meta.coverThumb){
            meta.coverThumb = await _base64ToBlob(meta.coverThumb, 'image/jpeg');
            delete meta._coverThumbIsBase64;
          }
          const ext = meta.fileType || 'bin';
          try{
            const bh = await refDir.getFileHandle(`${meta.id}.${ext}`);
            meta.blob = await bh.getFile();
          }catch(e){ meta.blob = null; }
          await dp('refbooks', meta);
          count++;
        }
      }catch(e){ /* refbooks 資料夾不存在就跳過 */ }

      try{
        const lmDir = await dirHandle.getDirectoryHandle('learnmedia');
        await dc('learnmedia');
        for await(const [name, handle] of lmDir.entries()){
          if(!name.endsWith('.meta.json')) continue;
          const meta = JSON.parse(await (await handle.getFile()).text());
          if(meta._thumbnailIsBase64 && meta.thumbnail){
            meta.thumbnail = await _base64ToBlob(meta.thumbnail, 'image/jpeg');
            delete meta._thumbnailIsBase64;
          }
          const ext = meta.mimeType?.split('/')[1] || meta.mediaType || 'bin';
          try{
            const bh = await lmDir.getFileHandle(`${meta.id}.${ext}`);
            meta.blob = await bh.getFile();
          }catch(e){ meta.blob = null; }
          await dp('learnmedia', meta);
          count++;
        }
      }catch(e){ /* learnmedia 資料夾不存在就跳過 */ }

      _cacheInvalidate?.();
      _showDoneDialog('本機還原完成 ✓', [
        '共 ' + count + ' 個項目已還原。',
        '',
        '時間：' + new Date().toLocaleString('zh-TW'),
        '按「知道了」後會重新整理頁面。',
      ], ()=> location.reload());
    }catch(e){
      if(e.name === 'AbortError') return;
      logError('localRestore', e);
      toast('還原失敗：' + e.message);
    }
  });
}

// 輔助：Blob → base64 字串
function _blobToBase64(blob){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload  = ()=> resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 輔助：base64 字串 → Blob
function _base64ToBlob(b64, mimeType='image/jpeg'){
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for(let i=0; i<bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return Promise.resolve(new Blob([arr], { type:mimeType }));
}

// ── Azure TTS Key 設定 ───────────────────────────────────────
async function saveAzureKey(value){
  const v = value.trim();
  await setSetting('tts_azure_key', v);
  if(v.length > 10) toast('Azure Key 已儲存（'+v.length+'字元）✓');
}
async function _renderAzureKey(){
  const key = await getSetting('tts_azure_key','');
  const el  = document.getElementById('tts-azure-key');
  if(el && key) el.value = key;
  _renderAzureUsage().catch(()=>{});
}

// Azure 用量估算顯示（免費層 F0 為每月 50 萬字元）
//   ★ 估算值：SSML 標籤是否計入、失敗重試、跨月時區都可能與微軟後台有出入，
//     用途是「快用完前有個警覺」，精確數字仍以 Azure 後台為準。
async function _renderAzureUsage(){
  const box = document.getElementById('azure-usage');
  if(!box) return;
  const u = await getSetting('azure_usage', null);
  const ym = new Date().toISOString().slice(0, 7);
  const chars = (u && u.ym === ym) ? (u.chars || 0) : 0;
  const FREE = 500000;
  const pct  = Math.min(100, Math.round(chars / FREE * 100));
  const warn = pct >= 80;
  box.innerHTML =
    '本月已用約 <b style="color:' + (warn ? 'var(--org)' : 'var(--t1)') + '">'
    + chars.toLocaleString() + '</b> 字元 ／ 免費 ' + FREE.toLocaleString()
    + '（' + pct + '%）'
    + '<div style="height:5px;border-radius:3px;background:var(--bg2);margin-top:5px;overflow:hidden">'
    + '<div style="height:100%;width:' + pct + '%;background:' + (warn ? 'var(--org)' : 'var(--acc)') + '"></div></div>'
    + '<div style="margin-top:4px;opacity:.8">估算值，實際用量以 Azure 後台為準</div>';
}


// ── 需手動關閉的完成提示 ──────────────────────────────────────
//   備份是重要操作，用 toast 幾秒就消失，沒注意到就不確定成功了沒。
//   改用彈窗，必須按「知道了」才關閉，並顯示完成時間供核對。
//   onClose：關閉後要執行的動作（例如還原完成後重新整理頁面）
function _showDoneDialog(title, lines, onClose){
  const ov = document.createElement('div');
  ov.className = 'ov on';   // 沿用既有說明彈窗的樣式（.ov + .sh），確保外觀一致
  ov.id = 'done-dialog-ov';
  const close = ()=>{ ov.remove(); if(typeof onClose === 'function') onClose(); };
  ov.innerHTML =
    '<div class="sh" onclick="event.stopPropagation()" style="max-width:420px">'
    + '<div class="shdl"></div>'
    + '<div class="sht"><span>' + esc(title) + '</span></div>'
    + '<div style="padding:2px 18px 8px;font-size:13px;line-height:1.9;color:var(--t1)">'
    +   lines.map(l => l ? esc(l) : '').join('<br>')
    + '</div>'
    + '<div style="padding:6px 18px 22px">'
    +   '<button class="btn bp bw" id="done-dialog-ok" '
    +   'style="width:100%;padding:11px;font-size:14px;font-weight:600">知道了</button>'
    + '</div>'
    + '</div>';
  ov.onclick = (e)=>{ if(e.target === ov) close(); };
  document.body.appendChild(ov);
  document.getElementById('done-dialog-ok').onclick = close;
}

// ══ 偵錯面板 ══════════════════════════════════════════════════
const _debugLogs = [];
const _MAX_LOGS = 200;

// 攔截 console.error / console.warn 與未捕獲錯誤
(function(){
  const _origError = console.error.bind(console);
  const _origWarn  = console.warn.bind(console);
  const _push = (level, args) => {
    const msg = args.map(a => {
      if(a instanceof Error) return a.stack || a.message;
      if(typeof a === 'object'){ try{ return JSON.stringify(a); }catch(e){ return String(a); } }
      return String(a);
    }).join(' ');
    _debugLogs.unshift({ t: new Date().toLocaleTimeString('zh-TW'), level, msg });
    if(_debugLogs.length > _MAX_LOGS) _debugLogs.pop();
    // 紅點提示
    const dot = document.getElementById('debug-dot');
    if(dot && level==='error') dot.style.display = 'inline-block';
  };
  console.error = (...a) => { _push('error', a); _origError(...a); };
  console.warn  = (...a) => { _push('warn',  a); _origWarn(...a); };
  // 攔截未捕獲的錯誤
  window.addEventListener('error', e => {
    _push('error', [e.message + ' (' + (e.filename||'').split('/').pop() + ':' + e.lineno + ')']);
  });
  window.addEventListener('unhandledrejection', e => {
    _push('error', ['Promise rejected: ' + (e.reason?.message || e.reason || e)]);
  });
})();

function _debugCopyAll(){
  const txt = _debugLogs.map(l=>'['+l.t+']['+l.level+'] '+l.msg).join('\n');
  if(navigator.clipboard){
    navigator.clipboard.writeText(txt).then(()=>toast('已複製')).catch(()=>{
      _debugFallbackCopy(txt);
    });
  } else {
    _debugFallbackCopy(txt);
  }
}
function _debugFallbackCopy(txt){
  const ta = document.createElement('textarea');
  ta.value = txt; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); toast('已複製'); }
  catch(e){ toast('複製失敗，請手動長按選取'); }
  document.body.removeChild(ta);
}

function openDebugPanel(){
  document.getElementById('debug-panel-ov')?.remove();
  const ov = document.createElement('div');
  ov.id = 'debug-panel-ov';
  ov.className = 'ov-full-col';
  const dot = document.getElementById('debug-dot');
  if(dot) dot.style.display = 'none';

  const header = document.createElement('div');
  header.className = 'log-viewer-header';
  header.innerHTML = `
    <span style="font-size:13px;font-weight:700;color:#fff;flex:1">偵錯紀錄（最新在上）</span>
    <button data-dbg="copy" title="全部複製" style="background:none;border:none;cursor:pointer;color:#aaa;padding:6px">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>
    <button data-dbg="clear" title="清除紀錄" style="background:none;border:none;cursor:pointer;color:#aaa;padding:6px">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
    </button>
    <button data-dbg="close" title="關閉" style="background:none;border:none;cursor:pointer;color:#aaa;padding:6px">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  // 事件委派：偵錯面板按鈕（不再依賴全域函式）
  header.addEventListener('click', e=>{
    const btn = e.target.closest('[data-dbg]');
    if(!btn) return;
    if(btn.dataset.dbg === 'copy') _debugCopyAll();
    else if(btn.dataset.dbg === 'clear'){ _debugLogs.length = 0; openDebugPanel(); }
    else if(btn.dataset.dbg === 'close') ov.remove();
  });
  ov.appendChild(header);

  const list = document.createElement('div');
  list.className = 'log-viewer-list';
  if(!_debugLogs.length){
    list.innerHTML = '<div style="color:#555;padding:20px 16px">目前無錯誤紀錄</div>';
  } else {
    _debugLogs.forEach(l => {
      const div = document.createElement('div');
      div.className = 'log-viewer-row';
      div.style.cssText =
        (l.level==='error' ? 'background:rgba(200,50,50,0.12);color:#f87171;' : 'color:#fbbf24;');
      div.innerHTML = '<span style="opacity:.5;margin-right:8px">' + l.t + '</span>'
        + '<span style="opacity:.6;margin-right:8px;font-size:10px;text-transform:uppercase">[' + l.level + ']</span>'
        + esc(l.msg).replace(/\n/g,'<br>');
      list.appendChild(div);
    });
  }
  ov.appendChild(list);
  document.body.appendChild(ov);
}

// ════════ 公開 API ════════
const Settings = {
  saveGasConfig, gdriveBackup, gdriveRestore,
  renderSet, expWrong, expAll,
  clearAts, delAll, toggleGasHelp,
  localBackup, localRestore, saveAzureKey, openDebugPanel
};
window.Settings = Settings;
Object.assign(window, Settings);

})();
