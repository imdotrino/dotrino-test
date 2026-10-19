/**
 * SMOKE · la INVITACIÓN CORTA leída por la consola del navegador.
 *
 * `smoke/browser.mjs` ya empareja un navegador con la bóveda, pero lo hace con la
 * invitación LARGA (el JSON en base64url): levanta el proxio SIN identidad de nodo, y
 * un proxio sin identidad no puede emitir citas, así que la bóveda cae sola a la forma
 * larga. Por eso el camino que de verdad se usa hoy —el QR corto con la CITA del
 * proxio (`t`)— no lo cubría nadie del lado del navegador.
 *
 * Este escenario cierra ese hueco. Levanta el proxio CON identidad de nodo (como
 * `dotrino-vault/test/pairing-cita.e2e.test.mjs`), pide un emparejamiento y comprueba
 * qué hace la consola con la invitación corta:
 *
 *   1 · la ACEPTA (no la descarta como código inválido) y arranca el proceso, y
 *   2 · la CANJEA contra el proxio y llega a enseñar los seis dígitos.
 *
 * El (1) es el arreglo de la consola; el (2) depende del iframe de identidad, que es
 * quien canjea. Se comprueban por separado a propósito: así, si falla, se ve de qué
 * lado está el problema en vez de tener un «no empareja» sin dueño.
 *
 *   node smoke/short-pairing.mjs [--console <ruta al dist>] [--iframe <ruta>] [--verbose]
 *
 * `--console` y `--iframe` sirven para correrlo contra el build de otra rama y comparar.
 *
 * ESTADO HOY (2026-08-04): el (2) FALLA con el iframe del repo, y no es culpa de la
 * consola. `dotrino-identity/vault/vendor/proxy-client` es una copia vendorizada de
 * 0.6.4, que no tiene `redeemPairingCode` — el mismo `remote.js` que la llama. Sale
 * literalmente «client.redeemPairingCode is not a function». Re-vendorizando 0.10.0 en
 * una copia del iframe, los tres escenarios pasan; o sea que el arreglo pendiente está
 * en `dotrino-identity`, no aquí. Se deja el escenario en rojo A PROPÓSITO: es un fallo
 * real del emparejamiento en producción, y taparlo sería perderlo de vista.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  scenario, runScenarios, startVault, teardown, serveStatic,
  freePort, waitPort, tmpDir, ROOT
} from './lib/harness.js'

const require = createRequire(import.meta.url)
const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const argConsole = process.argv.indexOf('--console')
const CONSOLE = argConsole > -1
  ? path.resolve(process.argv[argConsole + 1])
  : path.join(ROOT, 'dotrino-vault/web/dist')
const argIframe = process.argv.indexOf('--iframe')
const IFRAME = argIframe > -1
  ? path.resolve(process.argv[argIframe + 1])
  : path.join(ROOT, 'dotrino-identity/vault')

let proxy = null
let vault = null
let webConsole = null
let webIframe = null
let browser = null
let context = null

/**
 * Identidad de nodo del proxio. Sin ella no hay citas y la bóveda emite la invitación
 * larga, que es justo lo que este escenario NO quiere probar. Misma forma que la que
 * escribe el vault al enrolar un servicio.
 */
function nodeIdentity (dir) {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const publicJwk = kp.publicKey.export({ format: 'jwk' })
  const privateJwk = kp.privateKey.export({ format: 'jwk' })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'service-identity.json'), JSON.stringify({
    v: 1, ns: 'proxy', iss: 'smoke', enrolledAt: Date.now(),
    device: {
      publickey: JSON.stringify(publicJwk), privateJwk, publicJwk,
      label: 'smoke', createdAt: Date.now()
    }
  }))
  return dir
}

/** El proxio, pero CON identidad de nodo (el harness lo levanta sin ella). */
async function startProxyWithNode () {
  const port = await freePort()
  const dir = nodeIdentity(path.join(tmpDir('proxy-node'), 'vault-service'))
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(ROOT, 'dotrino-proxy'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', VAULT_SERVICE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (b) => log('[proxy] ' + String(b).trim()))
  child.stderr.on('data', (b) => log('[proxy!] ' + String(b).trim()))
  await waitPort(port)
  return { url: `ws://localhost:${port}`, port, child }
}

/** La invitación tal y como viaja: el texto que va en el QR y en el `#fragment`. */
function inviteText (qr, proxyUrl) {
  const { encodeInvite } = require(path.join(ROOT, 'dotrino-vault/lib/src/invite.js'))
  return encodeInvite({ ...qr, proxy: qr.proxy || proxyUrl })
}

/** Abre la consola con la invitación en el `#fragment`, apuntando al iframe local. */
async function openConsole (hash = '') {
  const page = await context.newPage()
  page.on('console', (m) => log('[browser] ' + m.text()))
  page.on('pageerror', (e) => log('[browser!] ' + e.message))
  await page.goto(
    `${webConsole.url}/vault?vault=${encodeURIComponent(webIframe.url + '/?proxy=' + encodeURIComponent(proxy.url))}&proxy=${encodeURIComponent(proxy.url)}${hash}`
  )
  // Con invitación en el fragmento la consola se va DIRECTA al proceso, y entonces la
  // lista de miembros no se pinta: se espera a lo que llegue primero.
  await page.waitForSelector(
    '[data-testid="members"] .member, [data-testid="pair-flow"], .msg.bad',
    { timeout: 30000 }
  )
  return page
}

let invite = null

scenario('the vault issues the SHORT invite when the proxy can issue appointments', async () => {
  const qr = await vault.pair({ label: 'browser-short' })
  log('[vault] qr: ' + JSON.stringify(qr))
  assert.ok(qr.conn || (qr.iss && qr.token), 'the vault published something pairable')
  assert.ok(qr.sn, 'with its session nonce')
  assert.ok(qr.conn, 'and it is the SHORT form (a proxy appointment), not the long one with the key')

  invite = inviteText(qr, proxy.url)
  log('[vault] invite: ' + invite)
  assert.ok(invite.length < 160, 'the invite is really short: ' + invite.length)
})

scenario('the console ACCEPTS the short invite (does not discard it as invalid)', async () => {
  const page = await openConsole('#v=' + encodeURIComponent(invite))

  // Lo que rompía antes: `extractPayload`/`announce` exigían `iss`+`token`, que la
  // invitación corta no lleva, así que la consola contestaba «código no válido» y
  // no llegaba a intentar nada.
  const rejection = page.locator('.msg.bad, [data-testid="pair-error"]')
  const flow = page.locator('[data-testid="pair-flow"], [data-testid="pair-code"], .pair-flow')

  await Promise.race([
    flow.first().waitFor({ timeout: 20000 }).catch(() => {}),
    rejection.first().waitFor({ timeout: 20000 }).catch(() => {})
  ])

  const rejectionText = await rejection.first().isVisible().catch(() => false)
    ? await rejection.first().innerText()
    : ''
  assert.ok(
    !/no válido|inválid|invalid|antigua|old version/i.test(rejectionText),
    'the console does not discard it: ' + rejectionText
  )
  assert.ok(
    await flow.first().isVisible().catch(() => false),
    'and it starts the pairing flow'
  )
  await page.close()
})

scenario('and redeems it against the proxy until it shows the six digits', async () => {
  // Invitación NUEVA: la cita es de un solo uso y el escenario anterior gastó la suya.
  const fresh = inviteText(await vault.pair({ label: 'browser-short-2' }), proxy.url)
  const page = await openConsole('#v=' + encodeURIComponent(fresh))
  const codeBox = page.locator('[data-testid="pair-code"] .digits')
  const error = page.locator('[data-testid="pair-error"]')
  await Promise.race([
    codeBox.waitFor({ timeout: 40000 }).catch(() => {}),
    error.waitFor({ timeout: 40000 }).catch(() => {})
  ])
  if (await error.isVisible().catch(() => false)) {
    // Quien canjea la cita es el IFRAME de identidad, no la consola: si falla aquí,
    // el problema está del otro lado del `postMessage`.
    assert.fail('redeeming failed in the identity iframe: ' + (await error.innerText()).trim())
  }
  const code = (await codeBox.innerText()).trim()
  assert.match(code, /^\d{6}$/, 'six digits to type into the vault')

  // Y el emparejamiento se cierra de verdad: la bóveda lo admite en su acta.
  const before = vault.acta().members.length
  await vault.waitPending()
  vault.approve(code)
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="pair-code"]'),
    null, { timeout: 30000 }
  )
  assert.equal(vault.acta().members.length, before + 1, 'the vault admitted it into its record')
  await page.close()
})

// ---------- arranque ----------

console.log('\nSMOKE · the SHORT invite in the browser console\n')
if (!fs.existsSync(path.join(CONSOLE, 'index.html'))) {
  console.error(`Missing the console build in ${CONSOLE}.\n`)
  process.exit(2)
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxyWithNode()
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  webConsole = await serveStatic(CONSOLE, { spa: true })
  webIframe = await serveStatic(IFRAME)
  console.log(`  proxy     ${proxy.url}  (with node identity: issues appointments)`)
  console.log(`  console   ${webConsole.url}/vault   ← ${CONSOLE}`)
  console.log(`  identity ${webIframe.url}  (the iframe, on another origin)\n`)

  browser = await chromium.launch({ headless: !VERBOSE })
  context = await browser.newContext({ locale: 'es-ES' })

  const ok = await runScenarios()
  await context?.close(); await browser?.close()
  try { proxy?.child?.kill('SIGKILL') } catch (_) {}
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { await context?.close(); await browser?.close() } catch (_) {}
  try { proxy?.child?.kill('SIGKILL') } catch (_) {}
  await teardown()
  process.exit(1)
}
