const V='em-95181ba0';
const SHELL=['./','index.html','supabase.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin) return;
  if(e.request.mode==='navigate'||u.pathname.endsWith('index.html')){
    e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(V).then(x=>x.put('index.html',c));return r}).catch(()=>caches.match('index.html')));return;}
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(n=>{const c=n.clone();caches.open(V).then(x=>x.put(e.request,c));return n})));
});
self.addEventListener('push',e=>{
  let d={}; try{d=e.data.json()}catch(_){d={title:"Emperor's Mind",body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||"Emperor's Mind",{body:d.body||'',icon:'icon-192.png',badge:'icon-192.png',data:{url:d.url||'#home'},tag:d.tag||undefined}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const target=new URL('./'+(e.notification.data&&e.notification.data.url||''),self.registration.scope).href;
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{
    for(const w of ws){ if('focus' in w){ w.navigate(target).catch(()=>{}); return w.focus(); } }
    return clients.openWindow(target);
  }));
});
