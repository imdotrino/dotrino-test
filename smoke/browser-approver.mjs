/**
 * smoke:browser-approver — APROBAR DESDE UN NAVEGADOR, no solo desde el teléfono.
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
 *   npm run smoke:browser-approver [-- --verbose]
 * Requiere el build de la consola:  cd dotrino-vault/web && npm run build
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scenario, runScenarios, startProxy, startVault, teardown, serveStatic, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const CONSOLE_DIST = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')

let proxy = null
let vault = null
let webConsole = null
let webIframe = null
let browser = null
let context = null
let page = null
let svcDir = null
let request = null
let request2 = null

const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`
const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const q = () => `?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}`

scenario('the browser pairs and the owner grants it `approve`', async () => {
  const qr = await vault.pair({ label: 'navegador' })
  page = await context.newPage()
  page.on('console', (m) => log('[browser] ' + m.text()))
  page.on('pageerror', (e) => log('[browser!] ' + e.message))
  await page.goto(`${webConsole.url}/vault${q()}#vault=${b64url(qr)}`)
  const codeBox = page.locator('[data-testid="pair-code"] .digits')
  await codeBox.waitFor({ timeout: 30000 })
  const code = (await codeBox.innerText()).trim()
  await vault.waitPending()
  vault.approve(code)
  await page.waitForFunction(() => !document.querySelector('[data-testid="pair-code"]'), null, { timeout: 30000 })

  const me = vault.acta().members.find((m) => m.label === 'navegador')
  assert.ok(me, 'the browser is in the record')
  await vault.caps(me.pub, [...new Set([...(me.caps || []), 'approve'])])
  const after = vault.acta().members.find((m) => m.pub === me.pub)
  assert.ok(after.caps.includes('approve'), 'and now it can approve: ' + JSON.stringify(after.caps))
})

scenario('a service without `unattended` asks for its keys and is left PENDING', async () => {
  const { enrollService, fetchSecrets } = await import(path.join(ROOT, 'dotrino-vault/lib/src/service.js'))
  await vault.setSecret('miapp', 'API_KEY', 's3cr3t')
  svcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-approver-'))
  const qr = await vault.pair({ service: 'miapp' })
  let approved = null
  await enrollService({ qr, ns: 'miapp', dir: svcDir, onCode: ({ code }) => { approved = vault.approve(code) } })
  await approved
  // Se lanza y NO se espera: se queda esperando a que alguien apruebe.
  let pending = false
  request = fetchSecrets({ dir: svcDir, onPending: () => { pending = true } })
  request.catch(() => {})
  const t = Date.now() + 20000
  while (!pending && Date.now() < t) await new Promise((r) => setTimeout(r, 200))
  assert.ok(pending, 'the vault left the request pending (there is an approver and the service is not unattended)')
})

scenario('the console shows it with its reason: who, which drawer, which command', async () => {
  await page.goto(`${webConsole.url}/approvals${q()}`)
  const item = page.locator('[data-testid="apv-item"]').first()
  await item.waitFor({ timeout: 30000 })
  const text = await item.innerText()
  log('[request] ' + text.replace(/\s+/g, ' '))
  assert.match(text, /pide tus claves de\s+miapp/, 'it says which drawer is asked for: ' + text)
  const cmd = await item.locator('[data-testid="apv-cmd"]').innerText()
  assert.match(cmd, /node/, 'and which command asks: ' + cmd)
  // Los avisos del navegador: se ofrecen o se dice por qué no, nunca en silencio.
  const notices = page.locator('[data-testid="apv-push"], [data-testid="apv-push-on"], [data-testid="apv-push-err"], [data-testid="apv-push-denied"]')
  await notices.first().waitFor({ timeout: 15000 })
  log('[notices] ' + (await notices.first().innerText()))
})

scenario('with notification permission, the browser subscribes to the doorbell under ITS key', async () => {
  await context.grantPermissions(['notifications'], { origin: webConsole.url })
  await page.goto(`${webConsole.url}/approvals${q()}`)
  const r = page.locator('[data-testid="apv-push-on"], [data-testid="apv-push-err"]')
  await r.first().waitFor({ timeout: 30000 })
  const text = await r.first().innerText()
  log('[subscription] ' + text)
  assert.equal(await page.locator('[data-testid="apv-push-on"]').count(), 1, 'it subscribed: ' + text)
})

scenario('with the tab closed, the browser notice says WHY (real Web Push)', async () => {
  // Otro pedido del mismo servicio: la bóveda avisa al aparato que aprueba; no está conectado
  // (la consola solo pregunta y cuelga), así que el proxio lo encola y TIMBRA por Web Push con
  // qué se pide y quién. Chrome lo recibe y el service worker enseña el aviso.
  const { fetchSecrets } = await import(path.join(ROOT, 'dotrino-vault/lib/src/service.js'))
  await page.goto('about:blank')                     // «la pestaña cerrada»: nadie mirando
  // Que se cierren de verdad sus conexiones: si no, el aviso de la bóveda se entrega en vivo
  // a una conexión que se está muriendo, no se encola y no hay timbre.
  await new Promise((r) => setTimeout(r, 4000))
  let pending = false
  const other = fetchSecrets({ dir: svcDir, onPending: () => { pending = true } })
  other.catch(() => {})
  const t = Date.now() + 20000
  while (!pending && Date.now() < t) await new Promise((r) => setTimeout(r, 200))
  assert.ok(pending, 'the second request is also pending')
  // El aviso lo lee la propia página, desde el service worker de la consola.
  await page.goto(`${webConsole.url}/approvals${q()}`)
  let notices = []
  const until = Date.now() + 60000
  while (Date.now() < until) {
    notices = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, url: n.data?.url }))
    })
    if (notices.some((n) => /miapp/.test(n.body))) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  log('[notice] ' + JSON.stringify(notices))
  const notice = notices.find((n) => /miapp/.test(n.body))
  assert.ok(notice, 'a notice with the reason arrived: ' + JSON.stringify(notices))
  assert.equal(notice.title, 'Tu bóveda tiene un pedido')
  assert.match(notice.body, /navegador|[0-9A-F]{4}-[0-9A-F]{4}/, 'it says who asks')
  assert.match(notice.body, /pide tus claves de miapp/, 'and what it asks for')
  assert.equal(notice.url, '/approvals', 'and tapping it opens Requests')
  // Se deja resuelto para que el siguiente escenario apruebe el primero.
  request2 = other
})

scenario('the browser approves and the service receives its keys', async () => {
  await page.goto(`${webConsole.url}/approvals${q()}`)
  await page.locator('[data-testid="apv-approve"]').first().waitFor({ timeout: 30000 })
  await page.locator('[data-testid="apv-approve"]').first().click()
  // El segundo pedido del mismo servicio y cajón REEMPLAZA al primero (es la misma pregunta):
  // al aprobar, recibe sus claves el que sigue esperando.
  const secrets = await (request2 || request)
  assert.equal(secrets.API_KEY, 's3cr3t')
})

scenario('asking whether its configuration changed does NOT open any request', async () => {
  const { fetchDigest } = await import(path.join(ROOT, 'dotrino-vault/lib/src/service.js'))
  const d = await fetchDigest({ dir: svcDir })
  assert.match(d, /^[0-9a-f]{64}$/)
  await page.goto(`${webConsole.url}/approvals${q()}`)
  await page.locator('[data-testid="apv-none"], [data-testid="apv-item"]').first().waitFor({ timeout: 30000 })
  assert.equal(await page.locator('[data-testid="apv-item"]').count(), 0, 'the request list is still empty')
})

console.log('\nSMOKE · approve from a browser (Playwright), all local\n')
if (!fs.existsSync(path.join(CONSOLE_DIST, 'index.html'))) {
  console.error('Missing the console build. Build it with:  cd dotrino-vault/web && npm run build\n')
  process.exit(2)
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  webConsole = await serveStatic(CONSOLE_DIST, { spa: true })
  webIframe = await serveStatic(IFRAME)
  // CHROME DE VERDAD y con PERFIL PERSISTENTE, o no hay Web Push: el Chromium de Playwright no
  // trae servicio de push, y un `newContext` es como una ventana de incógnito, donde Chrome no
  // deja suscribirse («Registration failed - permission denied» en los dos casos).
  const channel = fs.existsSync('/usr/bin/google-chrome') ? 'chrome' : undefined
  if (!channel) console.log('  (no Google Chrome: the Web Push scenario cannot pass)\n')
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-approver-'))
  context = await chromium.launchPersistentContext(profileDir, { headless: !VERBOSE, locale: 'es-ES', ...(channel ? { channel: channel } : {}) })
  const ok = await runScenarios()
  await context?.close(); await browser?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { await context?.close(); await browser?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
