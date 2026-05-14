// ══ db.js — IndexedDB 核心 ══════════════════════════════════
const DB_NAME = 'PoliceExamPro', DB_VER = 2;
let db;

function initDB(){
  return new Promise((res,rej)=>{
    const r=indexedDB.open(DB_NAME,DB_VER);
    r.onupgradeneeded=e=>{
      const d=e.target.result;
      if(!d.objectStoreNames.contains('questions')){
        const s=d.createObjectStore('questions',{keyPath:'id',autoIncrement:true});
        s.createIndex('subject','subject',{unique:false});
        s.createIndex('createdAt','createdAt',{unique:false});
      }
      if(!d.objectStoreNames.contains('laws')){
        const s=d.createObjectStore('laws',{keyPath:'id',autoIncrement:true});
        s.createIndex('lawName','lawName',{unique:false});
        s.createIndex('category','category',{unique:false});
        s.createIndex('articleNumber','articleNumber',{unique:false});
      }
      if(!d.objectStoreNames.contains('attempts')){
        const s=d.createObjectStore('attempts',{keyPath:'id',autoIncrement:true});
        s.createIndex('qid','qid',{unique:false});
        s.createIndex('date','date',{unique:false});
      }
    };
    r.onsuccess=e=>{db=e.target.result;res(db);};
    r.onerror=e=>rej(e.target.error);
  });
}

const dg=(st,k)=>new Promise((r,j)=>{const t=db.transaction(st,'readonly');const q=t.objectStore(st).get(k);q.onsuccess=()=>r(q.result);q.onerror=()=>j();});
const da=(st,idx,qry)=>new Promise((r,j)=>{const t=db.transaction(st,'readonly');const o=t.objectStore(st);const q=idx?o.index(idx).getAll(qry):o.getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j([]);});
const dp=(st,data)=>new Promise((r,j)=>{const t=db.transaction(st,'readwrite');const q=t.objectStore(st).put(data);q.onsuccess=()=>r(q.result);q.onerror=()=>j();});
const dd=(st,k)=>new Promise((r,j)=>{const t=db.transaction(st,'readwrite');t.objectStore(st).delete(k).onsuccess=()=>r();});
const dc=(st)=>new Promise((r,j)=>{const t=db.transaction(st,'readwrite');t.objectStore(st).clear().onsuccess=()=>r();});
function bulkPut(st,items){
  return new Promise((res,rej)=>{
    const tx=db.transaction(st,'readwrite');
    const os=tx.objectStore(st);
    let n=0;
    tx.oncomplete=()=>res(n);
    tx.onerror=e=>rej(e);
    items.forEach(it=>{os.put(it).onsuccess=()=>n++;});
  });
}
