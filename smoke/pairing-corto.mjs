/**
 * SMOKE · la INVITACIÓN CORTA leída por la consola del navegador.
 *
 * `smoke/navegador.mjs` ya empareja un navegador con la bóveda, pero lo hace con la
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
 *   node smoke/pairing-corto.mjs [--consola <ruta al dist>] [--iframe <ruta>] [--verbose]
 *
 * `--consola` y `--iframe` sirven para correrlo contra el build de otra rama y comparar.
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
  escenario, correr, startVault, teardown, servirEstatico,
  freePort, waitPort, tmpDir, ROOT
} from './lib/harness.js'

const require = createRequire(import.meta.url)
const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const argConsola = process.argv.indexOf('--consola')
const CONSOLA = argConsola > -1
  ? path.resolve(process.argv[argConsola + 1])
  : path.join(ROOT, 'dotrino-vault/web/dist')
const argIframe = process.argv.indexOf('--iframe')
const IFRAME = argIframe > -1
  ? path.resolve(process.argv[argIframe + 1])
  : path.join(ROOT, 'dotrino-identity/vault')

let proxy = null
let vault = null
let webConsola = null
let webIframe = null
let navegador = null
let contexto = null

/**
 * Identidad de nodo del proxio. Sin ella no hay citas y la bóveda emite la invitación
 * larga, que es justo lo que este escenario NO quiere probar. Misma forma que la que
 * escribe el vault al enrolar un servicio.
 */
function identidadDeNodo (dir) {
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
async function startProxyConNodo () {
  const port = await freePort()
  const dir = identidadDeNodo(path.join(tmpDir('proxy-nodo'), 'vault-service'))
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
function textoDeInvitacion (qr, proxyUrl) {
  const { encodeInvite } = require(path.join(ROOT, 'dotrino-vault/lib/src/invite.js'))
  return encodeInvite({ ...qr, proxy: qr.proxy || proxyUrl })
}

/** Abre la consola con la invitación en el `#fragment`, apuntando al iframe local. */
async function abrirConsola (hash = '') {
  const page = await contexto.newPage()
  page.on('console', (m) => log('[navegador] ' + m.text()))
  page.on('pageerror', (e) => log('[navegador!] ' + e.message))
  await page.goto(
    `${webConsola.url}/vault?vault=${encodeURIComponent(webIframe.url + '/?proxy=' + encodeURIComponent(proxy.url))}&proxy=${encodeURIComponent(proxy.url)}${hash}`
  )
  // Con invitación en el fragmento la consola se va DIRECTA al proceso, y entonces la
  // lista de miembros no se pinta: se espera a lo que llegue primero.
  await page.waitForSelector(
    '[data-testid="members"] .member, [data-testid="pair-flow"], .msg.bad',
    { timeout: 30000 }
  )
  return page
}

let invitacion = null

escenario('la bóveda emite la invitación CORTA cuando el proxio sabe dar citas', async () => {
  const qr = await vault.pair({ label: 'navegador-corto' })
  log('[bóveda] qr: ' + JSON.stringify(qr))
  assert.ok(qr.conn || (qr.iss && qr.token), 'la bóveda publicó algo emparejable')
  assert.ok(qr.sn, 'con su nonce de sesión')
  assert.ok(qr.conn, 'y es la forma CORTA (una cita del proxio), no la larga con la llave')

  invitacion = textoDeInvitacion(qr, proxy.url)
  log('[bóveda] invitación: ' + invitacion)
  assert.ok(invitacion.length < 160, 'la invitación es corta de verdad: ' + invitacion.length)
})

escenario('la consola ACEPTA la invitación corta (no la descarta como inválida)', async () => {
  const page = await abrirConsola('#v=' + encodeURIComponent(invitacion))

  // Lo que rompía antes: `extractPayload`/`announce` exigían `iss`+`token`, que la
  // invitación corta no lleva, así que la consola contestaba «código no válido» y
  // no llegaba a intentar nada.
  const rechazo = page.locator('.msg.bad, [data-testid="pair-error"]')
  const proceso = page.locator('[data-testid="pair-flow"], [data-testid="pair-code"], .pair-flow')

  await Promise.race([
    proceso.first().waitFor({ timeout: 20000 }).catch(() => {}),
    rechazo.first().waitFor({ timeout: 20000 }).catch(() => {})
  ])

  const textoRechazo = await rechazo.first().isVisible().catch(() => false)
    ? await rechazo.first().innerText()
    : ''
  assert.ok(
    !/no válido|inválid|invalid|antigua|old version/i.test(textoRechazo),
    'la consola no la descarta: ' + textoRechazo
  )
  assert.ok(
    await proceso.first().isVisible().catch(() => false),
    'y arranca el proceso de emparejamiento'
  )
  await page.close()
})

escenario('y la canjea contra el proxio hasta enseñar los seis dígitos', async () => {
  // Invitación NUEVA: la cita es de un solo uso y el escenario anterior gastó la suya.
  const fresca = textoDeInvitacion(await vault.pair({ label: 'navegador-corto-2' }), proxy.url)
  const page = await abrirConsola('#v=' + encodeURIComponent(fresca))
  const caja = page.locator('[data-testid="pair-code"] .digits')
  const error = page.locator('[data-testid="pair-error"]')
  await Promise.race([
    caja.waitFor({ timeout: 40000 }).catch(() => {}),
    error.waitFor({ timeout: 40000 }).catch(() => {})
  ])
  if (await error.isVisible().catch(() => false)) {
    // Quien canjea la cita es el IFRAME de identidad, no la consola: si falla aquí,
    // el problema está del otro lado del `postMessage`.
    assert.fail('el canje falló en el iframe de identidad: ' + (await error.innerText()).trim())
  }
  const code = (await caja.innerText()).trim()
  assert.match(code, /^\d{6}$/, 'seis dígitos para teclear en la bóveda')

  // Y el emparejamiento se cierra de verdad: la bóveda lo admite en su acta.
  const antes = vault.acta().members.length
  await vault.waitPending()
  vault.approve(code)
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="pair-code"]'),
    null, { timeout: 30000 }
  )
  assert.equal(vault.acta().members.length, antes + 1, 'la bóveda lo admitió en su acta')
  await page.close()
})

// ---------- arranque ----------

console.log('\nSMOKE · la invitación CORTA en la consola del navegador\n')
if (!fs.existsSync(path.join(CONSOLA, 'index.html'))) {
  console.error(`Falta el build de la consola en ${CONSOLA}.\n`)
  process.exit(2)
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxyConNodo()
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  webConsola = await servirEstatico(CONSOLA, { spa: true })
  webIframe = await servirEstatico(IFRAME)
  console.log(`  proxy     ${proxy.url}  (con identidad de nodo: emite citas)`)
  console.log(`  consola   ${webConsola.url}/vault   ← ${CONSOLA}`)
  console.log(`  identidad ${webIframe.url}  (el iframe, en otro origen)\n`)

  navegador = await chromium.launch({ headless: !VERBOSE })
  contexto = await navegador.newContext({ locale: 'es-ES' })

  const ok = await correr()
  await contexto?.close(); await navegador?.close()
  try { proxy?.child?.kill('SIGKILL') } catch (_) {}
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  try { await contexto?.close(); await navegador?.close() } catch (_) {}
  try { proxy?.child?.kill('SIGKILL') } catch (_) {}
  await teardown()
  process.exit(1)
}
