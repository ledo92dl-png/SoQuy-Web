
 // So Quy 1.4.1: resilient offline shell + best-effort background sync.
const CACHE = 'soquy-app-v141';
const SHELL = ['./index.html']; // Only the HTML is mandatory. Root/manifest may be gated or 404.

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Required shell must be cached before activating offline mode.
    await cache.addAll(SHELL);
    // A missing or protected manifest must not block the offline app.
    try { const r = await fetch('./manifest.json', {cache:'no-store'});
      if(r.ok && (r.headers.get('content-type')||'').includes('json')) await cache.put('./manifest.json',r);
    } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith('soquy-') && key !== CACHE)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // Online: fetch current HTML so new releases are not hidden by old cache.
      try {
        const response = await fetch('./index.html', {cache:'no-store'});
        if (response.ok && (response.headers.get('content-type')||'').includes('html')) {
          await cache.put('./index.html', response.clone());
          return response;
        }
      } catch (_) {}
      return await cache.match('./index.html') || Response.error();
    })());
    return;
  }

  // App files are cache-first.
  // Cloud requests are cross-origin and not cached.
  if (url.pathname.endsWith('/sw.js')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;

    const response = await fetch(req);
    if (response.ok) {
      await cache.put(req, response.clone());
    }
    return response;
  })());
});


// Three-way merge by stable ID. Independent offline additions are combined.
function mergeData(base,local,remote){
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const mergeList=(field)=>{
  const b=new Map((base?.[field]||[]).map(x=>[x.id,x]));
  const l=new Map((local?.[field]||[]).map(x=>[x.id,x]));
  const r=new Map((remote?.[field]||[]).map(x=>[x.id,x]));
  const result=[];
  for(const key of new Set([...r.keys(),...l.keys(),...b.keys()])){
   const bv=b.get(key),lv=l.get(key),rv=r.get(key);
   let chosen;
   if(same(lv,rv))chosen=lv;
   else if(same(lv,bv))chosen=rv;
   else if(same(rv,bv))chosen=lv;
   else if(bv===undefined&&lv!==undefined&&rv===undefined)chosen=lv;
   else if(bv===undefined&&rv!==undefined&&lv===undefined)chosen=rv;
   else throw Error('XUNG ĐỘT: cùng chỉnh sửa '+field+' / '+key+'. Hãy sao lưu JSON để đối chiếu.');
   if(chosen!==undefined)result.push(chosen);
  }
  return result;
 };
 return {funds:mergeList('funds'),accounts:mergeList('accounts'),tx:mergeList('tx')};
}

// Best-effort Background Sync. Runs only on browsers that support it.
const BG_DB='soquy-background-v133',BG_STORE='state';
function openBG(){return new Promise((resolve,reject)=>{const r=indexedDB.open(BG_DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(BG_STORE);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function getBG(key){const d=await openBG();return new Promise((resolve,reject)=>{const t=d.transaction(BG_STORE,'readonly'),r=t.objectStore(BG_STORE).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);t.oncomplete=()=>d.close()})}
async function putBG(key,value){const d=await openBG();return new Promise((resolve,reject)=>{const t=d.transaction(BG_STORE,'readwrite');t.objectStore(BG_STORE).put(value,key);t.oncomplete=()=>{d.close();resolve()};t.onerror=()=>reject(t.error)})}
async function delBG(key){const d=await openBG();return new Promise((resolve,reject)=>{const t=d.transaction(BG_STORE,'readwrite');t.objectStore(BG_STORE).delete(key);t.oncomplete=()=>{d.close();resolve()};t.onerror=()=>reject(t.error)})}
async function bgFetch(auth,path,body,token){const r=await fetch(auth.url+path,{method:'POST',headers:{apikey:auth.key,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});const raw=await r.text();let value;try{value=JSON.parse(raw)}catch{value=raw}if(!r.ok)throw Error(value?.message||value?.error||'HTTP '+r.status);return value}
async function uploadInBackground(){
 const pending=await getBG('pending'),auth=await getBG('auth');
 if(!pending||!auth?.refresh||!auth?.url||!auth?.key)return;
 // Never publish a legacy offline snapshot without a verified common ancestor.
 if(Number(pending.known)>0 && !pending.base)return;
 // Do not launch another upload before the page reconciles a previous success.
 if(await getBG('uploaded'))return;
 const clientsNow=await self.clients.matchAll({type:'window',includeUncontrolled:true});
 if(clientsNow.some(c=>c.visibilityState==='visible'))return;
 let token=auth.access;
 if(!token||Date.now()/1000>auth.expires-90){
  const r=await fetch(auth.url+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:auth.key,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:auth.refresh})});
  const d=await r.json();if(!r.ok||!d.access_token)throw Error('Cần đăng nhập lại để đồng bộ');
  auth.access=d.access_token;auth.refresh=d.refresh_token||auth.refresh;auth.expires=d.expires_at||(Date.now()/1000+(d.expires_in||3600));token=auth.access;await putBG('auth',auth);
 }
 const local=JSON.parse(pending.data);
 let base=null;try{base=JSON.parse(pending.base||'null')}catch{}
 for(let attempt=0;attempt<5;attempt++){
  const response=await fetch(auth.url+'/rest/v1/finance_snapshots?select=revision,data&limit=1',{
   headers:{apikey:auth.key,Authorization:'Bearer '+token},cache:'no-store'
  });
  if(!response.ok)throw Error('Không tải được bản đám mây: '+response.status);
  const rows=await response.json();const remote=rows[0]||null;
  if(!remote&&Number(pending.known)!==0)throw Error('Bản đám mây không còn tồn tại');
  const merged=remote&&Number(remote.revision)!==Number(pending.known)?mergeData(base,local,remote.data):local;
  try{
   const revision=await bgFetch(auth,'/rest/v1/rpc/save_finance_snapshot',{
    expected_revision:remote?Number(remote.revision):0,new_data:merged
   },token);
   await putBG('uploaded',{data:JSON.stringify(merged),source:pending.data,known:pending.known,revision,at:Date.now()});
   const latest=await getBG('pending');
   if(latest?.data===pending.data&&latest?.known===pending.known)await delBG('pending');
   for(const client of clientsNow)client.postMessage({type:'SOQUY_BG_UPLOADED'});
   return;
  }catch(e){if(/revision|conflict|409|phiên bản|xung đột/i.test(e.message)&&attempt<4)continue;throw e}
 }
}
self.addEventListener('sync',event=>{if(event.tag==='soquy-upload-v133')event.waitUntil(uploadInBackground())});
