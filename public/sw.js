/* Service worker AUTODESTRUCTIVO.
 *
 * test.dotrino.com fue PWA y dejó de serlo. Un 404 de sw.js NO mata de forma
 * fiable al service worker viejo (que además sirve HTML cacheado y hace que el
 * sitio "siga pareciendo PWA"). Por eso servimos ESTE sw.js en la misma ruta:
 * el navegador lo detecta como actualización del SW registrado, lo activa, y
 * aquí borramos todas las cachés, nos desregistramos y recargamos las pestañas
 * para que carguen la versión actual (sin PWA). Es transitorio: tras correr no
 * queda ningún service worker. */
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    } catch (e) { /* sin cachés */ }
    try { await self.registration.unregister() } catch (e) { /* ya desregistrado */ }
    const clients = await self.clients.matchAll({ type: 'window' })
    for (const c of clients) { try { c.navigate(c.url) } catch (e) { /* no navegable */ } }
  })())
})
