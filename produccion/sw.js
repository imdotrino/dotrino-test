// Service worker de la prueba del TIMBRE. Anota lo que llega y se lo cuenta a la página.
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('push', (event) => {
  let cuerpo = null
  try { cuerpo = event.data ? event.data.text() : null } catch (_) {}
  event.waitUntil((async () => {
    // Se guarda, para poder leerlo aunque la página no estuviera abierta al llegar.
    const c = await caches.open('timbre')
    await c.put('/ultimo', new Response(JSON.stringify({ ts: Date.now(), cuerpo })))
    const cs = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    for (const cl of cs) cl.postMessage({ tipo: 'timbre', cuerpo })
    // `userVisibleOnly` obliga a enseñar algo; si no, el navegador castiga la suscripción.
    await self.registration.showNotification('timbre', { body: cuerpo || '(sin cuerpo)', tag: 'timbre' })
  })())
})
