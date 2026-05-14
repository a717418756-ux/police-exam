// ══ parser.js — 題目與法條解析 ═════════════════════════════
// 依賴：utils.js (autoKeywords, norm, art2n)

function parseBulkText(text){
  console.log('[parseBulkText] 輸入長度:', text?.length, '前30字:', text?.slice(0,30));
  if(!text)return[];
  let t=text;

  // PDF/複製亂碼修正
  t=t.replace(/\r/g,'\n');
  t=t.replace(/\u00A0/g,' ');
  t=t.replace(/\u200B/g,'');

  // ── 私有字元偵測（PDF方塊選項符號）─────────────────────────
  // 找重複出現的私有字元，直接當選項分隔
  const sepMap={};
  for(const ch of t){
    const cp=ch.codePointAt(0);
    if(cp>=0xE000&&cp<=0xF8FF) sepMap[ch]=(sepMap[ch]||0)+1;
  }
  const bestSep=Object.entries(sepMap).filter(([,n])=>n>=3).sort((a,b)=>b[1]-a[1])[0];

  if(bestSep){
    // 私有字元模式：直接按私有字元切選項
    const sep=bestSep[0];
    const escaped=sep.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const tokens=t.split(new RegExp('('+escaped+')')).filter(Boolean);
    const questions=[];
    let cur=null,optIdx=0;
    const KEYS=['A','B','C','D','E'];
    for(let i=0;i<tokens.length;i++){
      const tok=tokens[i];
      if(tok===sep)continue;
      const prevIsSep=(i>0&&tokens[i-1]===sep);
      if(prevIsSep&&cur){
        // 選項內容，逐行檢查是否含新題號
        const lines=tok.split('\n');
        let optVal='';
        for(let li=0;li<lines.length;li++){
          const line=lines[li].trim();
          if(/^\d{1,3}[ .、）]/.test(line)&&li>0){
            if(optVal.trim()&&optIdx<KEYS.length){cur.options[KEYS[optIdx]]=optVal.trim().slice(0,300);optIdx++;}
            if(cur&&Object.keys(cur.options).length>=2)questions.push(cur);
            else if(cur&&cur.stem)questions.push({...cur,type:'es'});
            const numM=line.match(/^(\d{1,3})[ .、）]*/);
            const stem=line.replace(/^\d{1,3}[ .、）]*/,'').trim();
            cur={num:numM?numM[1]:'?',type:'mc',stem,options:{},answer:'',answerEs:'',keywords:autoKeywords(stem),tags:[],note:'',starred:false,createdAt:Date.now()};
            optIdx=0;optVal='';
          } else {optVal+=(optVal?'\n':'')+line;}
        }
        if(optVal.trim()&&cur&&optIdx<KEYS.length){cur.options[KEYS[optIdx]]=optVal.trim().slice(0,300);optIdx++;}
      } else {
        const trimmed=tok.trim();
        if(/^\d{1,3}[ .、）]/.test(trimmed)){
          if(cur&&Object.keys(cur.options).length>=2)questions.push(cur);
          else if(cur&&cur.stem)questions.push({...cur,type:'es'});
          const numM=trimmed.match(/^(\d{1,3})[ .、）]*/);
          const stem=trimmed.replace(/^\d{1,3}[ .、）]*/,'').replace(/\n/g,' ').trim();
          cur={num:numM?numM[1]:'?',type:'mc',stem,options:{},answer:'',answerEs:'',keywords:autoKeywords(stem),tags:[],note:'',starred:false,createdAt:Date.now()};
          optIdx=0;
        }
      }
    }
    if(cur&&Object.keys(cur.options).length>=2)questions.push(cur);
    else if(cur&&cur.stem)questions.push({...cur,type:'es'});
    return questions;
  }

  // ── 一般文字模式（無私有字元）────────────────────────────────
  // 常見 PDF 圖形符號 → §OPT§
  t=t.replace(/[■□▪▫◾◽◆◇▶▷►▸]/g,'§OPT§');
  // 全形轉半形
  t=t.replace(/[Ａ-Ｚａ-ｚ０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));
  // 選項標準化 → §A§ §B§ ...
  t=t.replace(/[（(]\s*([A-Ea-e])\s*[）)]/g,(_,k)=>'§'+k.toUpperCase()+'§');
  t=t.replace(/^([A-Ea-e])[.、．]\s*/gim,(_,k)=>'§'+k.toUpperCase()+'§');
  // §OPT§ 連續出現時依序分配 A B C D E
  let optCount=0;
  t=t.replace(/§OPT§/g,()=>'§'+('ABCDE'[optCount++%5])+'§');
  // 題號標準化
  t=t.replace(/^\s*Q\s*(\d+)/gim,'$1.');
  t=t.replace(/^\s*第\s*(\d+)\s*題/gim,'$1.');
  t=t.replace(/^\s*[（(](\d+)[）)]/gim,'$1.');
  t=t.replace(/^\s*(\d+)[、]/gim,'$1.');

  // 切題
  const qRegex=/(^|\n)(\d{1,3})[.]\s*/g;
  const qMatches=[...t.matchAll(qRegex)];
  if(!qMatches.length){
    // 沒有題號，整段當申論
    const stem=t.replace(/§[A-E]§/g,'').replace(/\s+/g,' ').trim();
    return stem?[{num:'?',type:'es',stem,options:{},answer:'',answerEs:'',keywords:autoKeywords(stem),tags:[],note:'',starred:false,createdAt:Date.now()}]:[];
  }

  const result=[];
  for(let i=0;i<qMatches.length;i++){
    const start=qMatches[i].index+qMatches[i][0].length;
    const end=i+1<qMatches.length?qMatches[i+1].index:t.length;
    const num=qMatches[i][2];
    let block=t.slice(start,end).trim();
    const optRegex=/§([A-E])§/g;
    const optMatches=[...block.matchAll(optRegex)];
    if(optMatches.length<2){
      const stem=block.replace(/§[A-E]§/g,'').replace(/\s+/g,' ').trim();
      if(stem) result.push({num,type:'es',stem,options:{},answer:'',answerEs:'',keywords:autoKeywords(stem),tags:[],note:'',starred:false,createdAt:Date.now()});
      continue;
    }
    const stem=block.slice(0,optMatches[0].index).replace(/\s+/g,' ').trim();
    const options={};
    for(let j=0;j<optMatches.length;j++){
      const key=optMatches[j][1];
      const s=optMatches[j].index+optMatches[j][0].length;
      const e=j+1<optMatches.length?optMatches[j+1].index:block.length;
      let val=block.slice(s,e).replace(/\s+/g,' ').trim();
      if(val.length>300)val=val.slice(0,300);
      options[key]=val;
    }
    if(Object.keys(options).length>=2)
      result.push({num,type:'mc',stem,options,answer:'',answerEs:'',keywords:autoKeywords(stem),tags:[],note:'',starred:false,createdAt:Date.now()});
  }
  return result;
}


function parseOnePart(text){
  // ── 1. 私有字元當選項分隔點 ─────────────────────────────────
  const sepMap={};
  for(const ch of text){const cp=ch.codePointAt(0);if(cp>=0xE000&&cp<=0xF8FF)sepMap[ch]=(sepMap[ch]||0)+1;}
  const best=Object.entries(sepMap).filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1])[0];
  if(best){
    const sep=best[0];
    const pts=text.split(sep).map(p=>p.replace(/\n/g,' ').replace(/\s+/g,' ').trim()).filter(Boolean);
    if(pts.length>=3){
      const numM=pts[0].match(/^([一二三四五六七八九十\d]+)[ .、）\t]*/);
      const num=numM?numM[1]:'?';
      const stem=pts[0].replace(/^[一二三四五六七八九十\d]+[ .、）\t]*/,'').trim();
      if(stem&&stem.length>=3){
        const keys=['A','B','C','D','E'];const options={};
        pts.slice(1).forEach((v,i)=>{if(i<keys.length&&v)options[keys[i]]=v.slice(0,300);});
        if(Object.keys(options).length>=2)
          return{num,type:'mc',stem,options,answer:'',keywords:autoKeywords(stem),tags:[],note:'',starred:false,createdAt:Date.now()};
      }
    }
  }
  // ── 2. 一般 ABC 選項解析 ──────────────────────────────────────
  text=text.replace(/[Ａ-Ｚａ-ｚ０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));
  text=text.replace(/（/g,'(').replace(/）/g,')');
  ['Ⓐ','Ⓑ','Ⓒ','Ⓓ','Ⓔ'].forEach((c,i)=>{text=text.replaceAll(c,'('+'ABCDE'[i]+') ');});
  ['🄐','🄑','🄒','🄓','🄔'].forEach((c,i)=>{text=text.replaceAll(c,'('+'ABCDE'[i]+') ');});
  text=text.replace(/\u00A0/g,' ').replace(/\u200B/g,'');
  text=text.replace(/\(?([A-Ea-e])\)?[.)、．）]\s*/g,(_,k)=>' §'+k.toUpperCase()+'§ ');
  const numM2=text.match(/^([一二三四五六七八九十\d]+)[ .、）\t]*/);
  const num2=numM2?numM2[1]:'?';
  let body=text.replace(/^[一二三四五六七八九十\d]+[ .、）\t]*/,'').trim();
  if(!body||body.length<3)return null;
  const marks=[...body.matchAll(/§([A-E])§/g)].map(m=>({key:m[1],pos:m.index,end:m.index+m[0].length}));
  if(marks.length<2){
    const s=body.replace(/§[A-E]§/g,'').replace(/\n/g,' ').replace(/\s+/g,' ').trim();
    return s.length>=5?{num:num2,type:'es',stem:s,options:{},answer:'',answerEs:'',keywords:autoKeywords(s),tags:[],note:'',starred:false,createdAt:Date.now()}:null;
  }
  let si=0;
  for(let i=0;i<marks.length;i++){if(marks[i].key==='A'&&marks.slice(i+1).some(x=>x.key==='B')){si=i;break;}}
  const stem2=body.slice(0,marks[si].pos).replace(/§[A-E]§/g,'').replace(/\n/g,' ').replace(/\s+/g,' ').trim();
  if(!stem2||stem2.length<3)return null;
  const opts={};
  for(let i=si;i<marks.length;i++){
    const k=marks[i].key,vs=marks[i].end,ve=i+1<marks.length?marks[i+1].pos:body.length;
    let v=body.slice(vs,ve).replace(/§[A-E]§/g,'').replace(/\n/g,' ').replace(/\s+/g,' ').trim();
    if(v.length>300)v=v.slice(0,300);if(v)opts[k]=v;
  }
  if(Object.keys(opts).length>=2)
    return{num:num2,type:'mc',stem:stem2,options:opts,answer:'',keywords:autoKeywords(stem2),tags:[],note:'',starred:false,createdAt:Date.now()};
  return{num:num2,type:'es',stem:stem2,options:{},answer:'',answerEs:'',keywords:autoKeywords(stem2),tags:[],note:'',starred:false,createdAt:Date.now()};
}

function parseAnswerStr(ans){
  // "DACB" -> {1:'D',2:'A',3:'C',4:'B'}
  // "1.D 2.A 3.C" -> {1:'D',2:'A',3:'C'}
  const result={};
  if(!ans)return result;
  const a=norm(ans).trim();
  if(/^[A-Ea-e]+$/.test(a)){// Pure answer string
    [...a.toUpperCase()].forEach((ch,i)=>result[i+1]=ch);
  } else {
    // numbered: "1.D 2.A" or "1 D 2 A"
    const matches=[...a.matchAll(/(\d+)[.、\s]?\s*([A-Ea-e])/gi)];
    matches.forEach(m=>result[parseInt(m[1])]=m[2].toUpperCase());
  }
  return result;
}

// ══ BULK UI ══



function parseLawText(text, lawName, category, source){
  let t = norm(text);
  // 「第 六 條」帶空格 → 「第六條」
  t = t.replace(/第\s+([一二三四五六七八九十百千\d]+)\s+條/g, '第$1條');
  t = t.replace(/第\s+([一二三四五六七八九十百千\d]+)\s+條\s*之\s*([一二三四五六七八九十\d]+)/g, '第$1條之$2');
  t = t.replace(/\u3000/g, ' ');

  const parts = t.split(/(?=第[一二三四五六七八九十百千\d]+條(?:之[一二三四五六七八九十\d]+)?)/g)
                  .map(p=>p.trim()).filter(Boolean);
  const items = [];
  for(const part of parts){
    const am = part.match(/^(第[一二三四五六七八九十百千\d]+條(?:之[一二三四五六七八九十\d]+)?)/);
    if(!am) continue;
    const article = am[1];
    const content = part.slice(article.length).trim();
    if(!content) continue;
    const articleNumber = art2n(article);
    items.push({
      lawName: lawName||'', article, articleNumber,
      category: category||'statute', source: source||'',
      content, keywords: autoKeywords(content),
      tags:[], notes:'', highlights:[], relatedLaws:[], relatedQuestions:[],
      favorite:false, createdAt:Date.now(), updatedAt:Date.now()
    });
  }
  return items;
}
