// Service worker de la prueba del TIMBRE. Anota lo que llega y se lo cuenta a la página.
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('push', (event) => {
  let body = null
  try { body = event.data ? event.data.text() : null } catch (_) {}
  event.waitUntil((async () => {
    // Se guarda, para poder leerlo aunque la página no estuviera abierta al llegar.
    const c = await caches.open('doorbell')
    await c.put('/last', new Response(JSON.stringify({ ts: Date.now(), body })))
    const cs = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    for (const cl of cs) cl.postMessage({ type: 'doorbell', body })
    // `userVisibleOnly` obliga a enseñar algo; si no, el navegador castiga la suscripción.
    await self.registration.showNotification('doorbell', { body: body || '(no body)', tag: 'doorbell' })
  })())
})
