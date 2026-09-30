/**
 * smoke:aprobador-navegador — APROBAR DESDE UN NAVEGADOR, no solo desde el teléfono.
 *
 * Dueño (2026-09-30): «la aprobación no debe ser exclusiva del teléfono, puede ser de un
 * browser aprobador»; «es importante que se sepa el porqué de la notificación y la aprobación».
 *
 * Todo en local y con la consola REAL en Chromium: la bóveda y el proxio se levantan aquí, la
 * consola y el iframe de identidad se sirven del disco.
 *
 *   1. El navegador se empareja con la bóveda y el dueño le da `aprueba`.
 *   2. Un servicio (sin `unattended`) pide sus claves: queda EN ESPERA.
 *   3. La consola lo enseña con su porqué —quién, qué cajón, qué comando y desde dónde— y ofrece
 *      los avisos del navegador.
 *   4. El navegador aprueba y el servicio recibe sus claves.
 *   5. Preguntar si su configuración cambió (`digest`) NO abre ningún pedido nuevo.
 *
 *   npm run smoke:aprobador-navegador [-- --verbose]
 * Requiere el build de la consola:  cd dotrino-vault/web && npm run build
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { escenario, correr, startProxy, startVault, teardown, servirEstatico, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const CONSOLA = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')

let proxy = null
let vault = null
let webConsola = null
let webIframe = null
let navegador = null
let contexto = null
let page = null
let svcDir = null
let pedido = null
let pedido2 = null

const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`
const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const q = () => `?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}`

escenario('el navegador se empareja y el dueño le da `aprueba`', async () => {
  const qr = await vault.pair({ label: 'navegador' })
  page = await contexto.newPage()
  page.on('console', (m) => log('[navegador] ' + m.text()))
  page.on('pageerror', (e) => log('[navegador!] ' + e.message))
  await page.goto(`${webConsola.url}/vault${q()}#vault=${b64url(qr)}`)
  const caja = page.locator('[data-testid="pair-code"] .digits')
  await caja.waitFor({ timeout: 30000 })
  const code = (await caja.innerText()).trim()
  await vault.waitPending()
  vault.approve(code)
  await page.waitForFunction(() => !document.querySelector('[data-testid="pair-code"]'), null, { timeout: 30000 })

  const yo = vault.acta().members.find((m) => m.label === 'navegador')
  assert.ok(yo, 'el navegador está en el acta')
  await vault.caps(yo.pub, [...new Set([...(yo.caps || []), 'approve'])])
  const despues = vault.acta().members.find((m) => m.pub === yo.pub)
  assert.ok(despues.caps.includes('approve'), 'y ahora puede aprobar: ' + JSON.stringify(despues.caps))
})

escenario('un servicio sin `unattended` pide sus claves y queda EN ESPERA', async () => {
  const { enrollService, fetchSecrets } = await import(path.join(ROOT, 'dotrino-vault/lib/src/service.js'))
  await vault.setSecret('miapp', 'API_KEY', 's3cr3t')
  svcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-aprobador-'))
  const qr = await vault.pair({ service: 'miapp' })
  let aprobado = null
  await enrollService({ qr, ns: 'miapp', dir: svcDir, onCode: ({ code }) => { aprobado = vault.approve(code) } })
  await aprobado
  // Se lanza y NO se espera: se queda esperando a que alguien apruebe.
  let esperando = false
  pedido = fetchSecrets({ dir: svcDir, onPending: () => { esperando = true } })
  pedido.catch(() => {})
  const t = Date.now() + 20000
  while (!esperando && Date.now() < t) await new Promise((r) => setTimeout(r, 200))
  assert.ok(esperando, 'la bóveda dejó el pedido en espera (hay quien apruebe y el servicio no es desatendido)')
})

escenario('la consola lo enseña con su porqué: quién, qué cajón, qué comando', async () => {
  await page.goto(`${webConsola.url}/approvals${q()}`)
  const item = page.locator('[data-testid="apv-item"]').first()
  await item.waitFor({ timeout: 30000 })
  const texto = await item.innerText()
  log('[pedido] ' + texto.replace(/\s+/g, ' '))
  assert.match(texto, /pide tus claves de\s+miapp/, 'dice qué cajón pide: ' + texto)
  const cmd = await item.locator('[data-testid="apv-cmd"]').innerText()
  assert.match(cmd, /node/, 'y qué comando lo pide: ' + cmd)
  // Los avisos del navegador: se ofrecen o se dice por qué no, nunca en silencio.
  const avisos = page.locator('[data-testid="apv-push"], [data-testid="apv-push-on"], [data-testid="apv-push-err"], [data-testid="apv-push-denied"]')
  await avisos.first().waitFor({ timeout: 15000 })
  log('[avisos] ' + (await avisos.first().innerText()))
})

escenario('con permiso de avisos, el navegador se suscribe al timbre bajo SU llave', async () => {
  await contexto.grantPermissions(['notifications'], { origin: webConsola.url })
  await page.goto(`${webConsola.url}/approvals${q()}`)
  const r = page.locator('[data-testid="apv-push-on"], [data-testid="apv-push-err"]')
  await r.first().waitFor({ timeout: 30000 })
  const texto = await r.first().innerText()
  log('[suscripción] ' + texto)
  assert.equal(await page.locator('[data-testid="apv-push-on"]').count(), 1, 'se suscribió: ' + texto)
})

escenario('con la pestaña cerrada, el aviso del navegador dice el PORQUÉ (Web Push de verdad)', async () => {
  // Otro pedido del mismo servicio: la bóveda avisa al aparato que aprueba; no está conectado
  // (la consola solo pregunta y cuelga), así que el proxio lo encola y TIMBRA por Web Push con
  // qué se pide y quién. Chrome lo recibe y el service worker enseña el aviso.
  const { fetchSecrets } = await import(path.join(ROOT, 'dotrino-vault/lib/src/service.js'))
  await page.goto('about:blank')                     // «la pestaña cerrada»: nadie mirando
  // Que se cierren de verdad sus conexiones: si no, el aviso de la bóveda se entrega en vivo
  // a una conexión que se está muriendo, no se encola y no hay timbre.
  await new Promise((r) => setTimeout(r, 4000))
  let esperando = false
  const otro = fetchSecrets({ dir: svcDir, onPending: () => { esperando = true } })
  otro.catch(() => {})
  const t = Date.now() + 20000
  while (!esperando && Date.now() < t) await new Promise((r) => setTimeout(r, 200))
  assert.ok(esperando, 'el segundo pedido también queda en espera')
  // El aviso lo lee la propia página, desde el service worker de la consola.
  await page.goto(`${webConsola.url}/approvals${q()}`)
  let avisos = []
  const hasta = Date.now() + 60000
  while (Date.now() < hasta) {
    avisos = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, url: n.data?.url }))
    })
    if (avisos.some((n) => /miapp/.test(n.body))) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  log('[aviso] ' + JSON.stringify(avisos))
  const aviso = avisos.find((n) => /miapp/.test(n.body))
  assert.ok(aviso, 'llegó un aviso con el porqué: ' + JSON.stringify(avisos))
  assert.equal(aviso.title, 'Tu bóveda tiene un pedido')
  assert.match(aviso.body, /navegador|[0-9A-F]{4}-[0-9A-F]{4}/, 'dice quién pide')
  assert.match(aviso.body, /pide tus claves de miapp/, 'y qué pide')
  assert.equal(aviso.url, '/approvals', 'y al tocarlo abre Pedidos')
  // Se deja resuelto para que el siguiente escenario apruebe el primero.
  pedido2 = otro
})

escenario('el navegador aprueba y el servicio recibe sus claves', async () => {
  await page.goto(`${webConsola.url}/approvals${q()}`)
  await page.locator('[data-testid="apv-approve"]').first().waitFor({ timeout: 30000 })
  await page.locator('[data-testid="apv-approve"]').first().click()
  // El segundo pedido del mismo servicio y cajón REEMPLAZA al primero (es la misma pregunta):
  // al aprobar, recibe sus claves el que sigue esperando.
  const secretos = await (pedido2 || pedido)
  assert.equal(secretos.API_KEY, 's3cr3t')
})

escenario('preguntar si cambió su configuración NO abre ningún pedido', async () => {
  const { fetchDigest } = await import(path.join(ROOT, 'dotrino-vault/lib/src/service.js'))
  const d = await fetchDigest({ dir: svcDir })
  assert.match(d, /^[0-9a-f]{64}$/)
  await page.goto(`${webConsola.url}/approvals${q()}`)
  await page.locator('[data-testid="apv-none"], [data-testid="apv-item"]').first().waitFor({ timeout: 30000 })
  assert.equal(await page.locator('[data-testid="apv-item"]').count(), 0, 'la lista de pedidos sigue vacía')
})

console.log('\nSMOKE · aprobar desde un navegador (Playwright), todo en local\n')
if (!fs.existsSync(path.join(CONSOLA, 'index.html'))) {
  console.error('Falta el build de la consola. Hazlo con:  cd dotrino-vault/web && npm run build\n')
  process.exit(2)
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  webConsola = await servirEstatico(CONSOLA, { spa: true })
  webIframe = await servirEstatico(IFRAME)
  // CHROME DE VERDAD y con PERFIL PERSISTENTE, o no hay Web Push: el Chromium de Playwright no
  // trae servicio de push, y un `newContext` es como una ventana de incógnito, donde Chrome no
  // deja suscribirse («Registration failed - permission denied» en los dos casos).
  const canal = fs.existsSync('/usr/bin/google-chrome') ? 'chrome' : undefined
  if (!canal) console.log('  (sin Google Chrome: el escenario del Web Push no puede pasar)\n')
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-aprobador-'))
  contexto = await chromium.launchPersistentContext(perfil, { headless: !VERBOSE, locale: 'es-ES', ...(canal ? { channel: canal } : {}) })
  const ok = await correr()
  await contexto?.close(); await navegador?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  try { await contexto?.close(); await navegador?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
