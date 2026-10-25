// Service worker: permite instalar la app, abrirla sin internet (con los últimos datos guardados) y recibir notificaciones.
const CACHE = 'cuentas-camioneta-v8';
const CFG = 'cam-sw-cfg';   // dirección de la hoja y sesión, para pedir el aviso cuando llega una notificación
const ARCHIVOS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CFG).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Red primero (para recibir actualizaciones), caché si no hay conexión.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // no-cache: siempre pregunta al servidor si hay versión nueva, para no mezclar archivos viejos y nuevos
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      const copia = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copia));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});

/* ---------- notificaciones ---------- */
self.addEventListener('message', e => {
  if (!e.data || e.data.tipo !== 'sesion') return;
  e.waitUntil(caches.open(CFG).then(c => e.data.token
    ? c.put('cfg', new Response(JSON.stringify({ api: e.data.api, token: e.data.token })))
    : c.delete('cfg')));
});
async function leerCfg() {
  try { const r = await (await caches.open(CFG)).match('cfg'); return r ? await r.json() : null; } catch (err) { return null; }
}
// La notificación llega vacía: se pide a la hoja el último aviso para mostrar qué pasó
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let cuerpo = 'Tu administrador registró un movimiento.', tag = 'camioneta';
    const cfg = await leerCfg();
    if (cfg) {
      try {
        const j = await (await fetch(cfg.api, { method: 'POST', body: JSON.stringify({ accion: 'avisos', token: cfg.token }) })).json();
        const a = j.ok && j.avisos && j.avisos[0];
        if (a) { cuerpo = (a.usuario ? a.usuario + ': ' : '') + a.texto; tag = a.id; }
      } catch (err) {}
    }
    await self.registration.showNotification('Cuentas de la Camioneta', {
      body: cuerpo, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './?vista=avisos' }
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    const abierta = lista.find(c => new URL(c.url).pathname.startsWith(new URL(self.registration.scope).pathname));
    if (abierta) { abierta.postMessage({ tipo: 'abrir-avisos' }); return abierta.focus(); }
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || './');
  }));
});
