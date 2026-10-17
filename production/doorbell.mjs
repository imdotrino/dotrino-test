/**
 * EL TIMBRE, CONTRA EL PROXIO DE PRODUCCIÓN.
 *
 * ⚠️ **Esta prueba SÍ toca producción**, y por eso vive aparte de `smoke/` y no entra en
 * `npm run smoke`. Lo que toca es lo mínimo: una identidad de usar y tirar (la llave
 * suelta del cliente del proxio, en un perfil de navegador nuevo que se borra al acabar)
 * y dos mensajes a esa pubkey, que no le importan a nadie. No hay bóveda de por medio.
 *
 * Existe porque el timbre es lo único de la cadena que NO se puede probar en local: hace
 * falta un servicio de push de verdad al que el navegador esté conectado. Todo lo demás
 * —que la bóveda de pestaña atienda, apruebe y avise— está en `smoke/password-manager.mjs`.
 *
 * Lo que comprueba, en orden:
 *
 *   1. el proxio de producción tiene Web Push encendido y da su VAPID
 *   2. un navegador se suscribe con ella y registra la suscripción firmada
 *   3. esa pubkey se apaga → le mandan algo → **suena** (≈1 s)
 *   4. con la PESTAÑA CERRADA —solo el service worker— vuelve a sonar
 *   5. al volver a abrir, **la cola baja sola**: llega lo que quedó esperando
 *
 * ⚠️ **El proxio tarda unos segundos en dar por muerto un socket.** Un mensaje enviado
 * justo después de cerrar la pestaña se «entrega» a la conexión que el proxio todavía
 * cree viva: ni se encola ni suena. Con 1,5 s de espera esta prueba no sonaba; con 6 s,
 * sí. No es un detalle del test: es una ventana real en la que un pedido se pierde.
 *
 *   npm run prod:timbre
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import fs from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT)

const AQUI = dirname(fileURLToPath(import.meta.url))
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' }
const srv = http.createServer((req, res) => {
  const p = join(AQUI, decodeURIComponent(req.url.split('?')[0]) === '/' ? '/index.html' : req.url.split('?')[0])
  if (!p.startsWith(AQUI) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': TIPOS[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream',
    'service-worker-allowed': '/' })
  fs.createReadStream(p).pipe(res)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
// `localhost` es contexto seguro; 127.0.0.1 también, y es lo que exige el service worker.
const BASE = `http://localhost:${srv.address().port}/`
console.log('  page    ', BASE)

const perfil = await mkdtemp(join(tmpdir(), 'timbre-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', '--no-sandbox'],
  permissions: ['notifications'],
})
const page = await ctx.newPage()
page.on('console', (m) => { if (!/favicon/.test(m.text())) console.log('   [page]', m.text()) })
page.on('pageerror', (e) => console.log('   [page!]', e.message))
page.on('response', (r) => {
  // El favicon que el navegador pide solo no interesa; cualquier otro fallo sí.
  if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) console.log('   [' + r.status() + ']', r.url())
})

try {
  await page.goto(BASE)
  // El módulo se resuelve solo: hay que esperar a que ASIGNE la promesa antes de leerla.
  await page.waitForFunction(() => !!window.__listo, null, { timeout: 60000 })
  const quien = await page.evaluate(() => window.__listo)
  console.log('  pubkey  ', JSON.parse(quien.publickey).x.slice(0, 16) + '…')
  console.log('  subscribed to production push ✓')

  const sub = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    const s = await reg.pushManager.getSubscription()
    return s ? s.endpoint : null
  })
  console.log('  endpoint', sub ? sub.slice(0, 58) + '…' : '(none)')
  if (!sub) throw new Error('the browser gave no push subscription')

  // 2. Se desconecta: para el proxio, esta pubkey pasa a estar apagada.
  await page.evaluate(() => window.__cliente.close())
  await page.waitForTimeout(6000)
  console.log('  the fake vault «goes offline» ✓')

  // 3. Alguien le manda algo desde fuera.
  const { WebSocketProxyClient } = await import(new URL('../../dotrino-proxy-client/src/index.js', import.meta.url).href)
  const otro = new WebSocketProxyClient({ url: 'wss://proxy.dotrino.com', enableWebRTC: false, autoReconnect: false })
  await otro.connect()
  otro.sendByPubkey([quien.publickey], { hola: 'esto debería quedar encolado' })
  console.log('  message sent to an offline pubkey ✓')

  // 4. ¿Suena?
  const t0 = Date.now()
  let sono = false
  for (let i = 0; i < 60; i++) {
    sono = await page.evaluate(() => (window.__timbres || []).length > 0)
    if (sono) break
    await page.waitForTimeout(1000)
  }
  if (sono) {
    console.log(`\n  DOORBELL RECEIVED in ${((Date.now() - t0) / 1000).toFixed(1)} s:`,
      JSON.stringify(await page.evaluate(() => window.__timbres)))
  } else {
    console.log('\n  DID NOT RING within 60 s.')
    console.log('  stored by the SW:', JSON.stringify(await page.evaluate(async () => {
      const c = await caches.open('timbre'); const r = await c.match('/ultimo')
      return r ? await r.json() : null
    })))
  }
  let cerrada = false
  let bajo = '(no se llegó)'
  if (sono) {
  // ---- 5. AHORA DE VERDAD: la pestaña CERRADA ---------------------------------
  //
  // Es el caso del dueño: la bóveda vive en una pestaña y la pestaña no está. Solo queda
  // el service worker, que es a quien despierta el push. Se comprueba por lo que deja
  // escrito, porque no hay nadie mirando cuando llega.
  console.log('\n  --- and now with the tab CLOSED ---')
  await page.evaluate(async () => {
    const c = await caches.open('timbre'); await c.delete('/ultimo')
  })
  await page.close()
  await new Promise((r) => setTimeout(r, 1500))
  console.log('  the tab closes; only the service worker remains ✓')

  otro.sendByPubkey([quien.publickey], { hola: 'con la pestaña cerrada' })
  console.log('  second message sent ✓')
  await new Promise((r) => setTimeout(r, 8000))

  const page2 = await ctx.newPage()
  await page2.goto(BASE)
  await page2.waitForFunction(() => !!window.__listo, null, { timeout: 60000 })
  const guardado = await page2.evaluate(async () => {
    const c = await caches.open('timbre'); const r = await c.match('/ultimo')
    return r ? await r.json() : null
  })
  cerrada = !!guardado
  console.log(cerrada
    ? `  DOORBELL RECEIVED WITH THE TAB CLOSED: ${JSON.stringify(guardado)}`
    : '  nothing arrived with the tab closed')

  // ---- 6. ¿Y lo que quedó esperando, baja al VOLVER a abrir? -------------------
  //
  // Reabrir la página ES reabrir la bóveda: su cliente conecta y se identifica solo, y
  // el proxio le entrega lo que tenía guardado. `page2` ya lo hizo arriba, así que basta
  // con mirar lo que anotó.
  await page2.waitForTimeout(4000)
  bajo = JSON.stringify(await page2.evaluate(() => window.__mensajes || []))
  console.log(`  on reopening, the queue drains by itself: ${bajo}`)

  }
  otro.close()
  process.exitCode = (sono && cerrada && /encolado|cerrada/.test(bajo)) ? 0 : 1
} finally {
  await ctx.close(); await rm(perfil, { recursive: true, force: true }); srv.close()
}
