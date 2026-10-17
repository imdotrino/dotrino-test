/**
 * LA CUENTA DE PRUEBA DE TERMINAL: una bóveda, una máquina y un aparato de usuario y contraseña.
 *
 * Es lo que recibe un tester de las apps nativas (iOS sobre todo), que no tiene bóveda ni
 * máquina propia: una dirección `usuario@AB12-CD34-EF56` y una contraseña. Con eso entra desde
 * «Iniciar sesión» y la app de Terminal tiene que encontrar la máquina y abrirle una shell.
 *
 * Las piezas estaban probadas cada una por su lado (el login en `dotrino-vault/test/
 * login-client.test.mjs`, la terminal en `terminal-panel.mjs`). Lo que no se había probado es
 * la cadena entera: que el aparato que nace de una contraseña sirva para la terminal.
 *
 *   npm run smoke:demo-terminal
 *   node smoke/demo-terminal.mjs --verbose      (con los logs y el navegador a la vista)
 *
 * Requiere el build:  cd dotrino-terminal && npm run build
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { scenario, runScenarios, startProxy, startVault, teardown, serveStatic, tmpDir, ROOT } from './lib/harness.js'
import { serveLoginPage, signIn } from './lib/sign-in.js'

const VERBOSE = process.argv.includes('--verbose')
const LOGS = VERBOSE || process.argv.includes('--logs')
const log = (m) => { if (LOGS) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const PWA = path.join(ROOT, 'dotrino-terminal/dist')
const AGENTE = path.join(ROOT, 'dotrino-terminal/agent')

const USUARIO = 'tester-1'
const CLAVE = 'contrasena-de-prueba-larga'

let proxy = null
let vault = null
let webIframe = null
let webEntrar = null
let webPwa = null
let navegador = null
let contexto = null
let agente = null
let cuenta = null          // { address, deviceId, caps, pub }

const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

async function esperar (fn, { timeoutMs = 20000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(150)
  }
  throw new Error('timed out waiting for ' + que)
}

const datosEntrar = (password) => ({ paginaUrl: webEntrar.url, iframeUrl: iframeUrl(), proxyUrl: proxy.url, address: cuenta.address, password })

async function maquinasVisibles (pagina) {
  return pagina.locator('[data-testid="machine-item"]').count()
}

scenario('la bóveda da de alta al tester con usuario y contraseña', async () => {
  cuenta = await vault.loginsAdd(USUARIO, CLAVE, { label: 'tester' })
  assert.match(cuenta.address, new RegExp(`^${USUARIO}@[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$`), 'la dirección: ' + cuenta.address)
  assert.ok(cuenta.caps.includes('sign'), 'con `sign`, que es lo que exige la terminal')
})

scenario('la máquina de prueba se enrola en la bóveda y arranca', async () => {
  const { enroll } = await import(path.join(AGENTE, 'link.js'))
  const { startAgent } = await import(path.join(AGENTE, 'index.js'))
  const dir = tmpDir('terminal-agent')
  const qr = await vault.pair({ label: 'Máquina de prueba' })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  agente = await startAgent({ dir, shell: '/bin/sh', quiet: !LOGS })
  assert.ok(agente.remote, 'con enlace, el agente atiende a los otros aparatos')
})

scenario('sin haber entrado, la terminal pide elegir dónde vive la identidad', async () => {
  const pagina = await contexto.newPage()
  await pagina.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  await esperar(async () => pagina.locator('#goVault').count(), { timeoutMs: 45000, que: 'la pantalla de elegir bóveda' })
  assert.equal(await maquinasVisibles(pagina), 0, 'un perfil nuevo no es de esa cuenta')
  await pagina.close()
})

scenario('con la contraseña equivocada no entra, y lo dice por su código', async () => {
  const r = await signIn(contexto, datosEntrar('no-es-esta-contrasena'))
  assert.equal(r.ok, false, 'no entra')
  assert.equal(r.code, 'login-failed', 'y el código es el de la contraseña: ' + JSON.stringify(r))
})

scenario('el tester entra con su dirección y su contraseña', async () => {
  const r = await signIn(contexto, datosEntrar(CLAVE))
  assert.ok(r.ok, 'entra: ' + JSON.stringify(r))
})

scenario('y la terminal encuentra la máquina y le abre una shell', async () => {
  const pagina = await contexto.newPage()
  pagina.on('console', (m) => log('[pwa] ' + m.text()))
  pagina.on('pageerror', (e) => log('[pwa!] ' + e.message))
  await pagina.setViewportSize({ width: 900, height: 700 })
  await pagina.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  const maquina = pagina.locator('[data-testid="machine-item"]').first()
  await maquina.waitFor({ timeout: 45000 })
  assert.match(await maquina.innerText(), /Máquina de prueba/, 'con el nombre que tiene en el acta')
  await maquina.click()
  await esperar(async () => (await agente.consoles.list()).length === 1, { que: 'que abra una consola en la máquina' })
  // Una orden de verdad: lo que escribe el tester llega a la shell y la respuesta vuelve.
  await pagina.locator('.xterm-helper-textarea').first().focus()
  await pagina.keyboard.type('echo hola-$((40+2))\n')
  await esperar(async () => (await pagina.locator('.xterm-rows').first().innerText()).includes('hola-42'), { que: 'la respuesta de la shell' })
  if (process.env.SMOKE_SHOT) await pagina.screenshot({ path: process.env.SMOKE_SHOT })
  await pagina.close()
})

console.log('\nSMOKE · the terminal test account (user and password), all local\n')
if (!fs.existsSync(path.join(PWA, 'index.html'))) { console.error('Missing a build. Build it with:  cd dotrino-terminal && npm run build\n'); process.exit(2) }
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  webIframe = await serveStatic(IFRAME)
  webEntrar = await serveLoginPage()
  webPwa = await serveStatic(PWA, { spa: true })
  console.log(`  proxy  ${proxy.url}`)
  console.log(`  pwa    ${webPwa.url}/consoles\n`)
  navegador = await chromium.launch({ headless: !VERBOSE })
  contexto = await navegador.newContext({ locale: 'es-ES' })
  const ok = await runScenarios()
  try { agente?.close() } catch (_) {}
  await contexto?.close(); await navegador?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { agente?.close() } catch (_) {}
  try { await contexto?.close(); await navegador?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
