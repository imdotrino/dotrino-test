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
import { waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const LOGS = VERBOSE || process.argv.includes('--logs')
const log = (m) => { if (LOGS) console.log(m) }

const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const PWA = path.join(ROOT, 'dotrino-terminal/dist')
const AGENT = path.join(ROOT, 'dotrino-terminal/agent')

const USER = 'tester-1'
const PASSWORD = 'contrasena-de-prueba-larga'

let proxy = null
let vault = null
let webIframe = null
let webSignIn = null
let webPwa = null
let browser = null
let context = null
let agent = null
let account = null          // { address, deviceId, caps, pub }

const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

const signInData = (password) => ({ pageUrl: webSignIn.url, iframeUrl: iframeUrl(), proxyUrl: proxy.url, address: account.address, password })

async function visibleMachines (page) {
  return page.locator('[data-testid="machine-item"]').count()
}

scenario('the vault registers the tester with user and password', async () => {
  account = await vault.loginsAdd(USER, PASSWORD, { label: 'tester' })
  assert.match(account.address, new RegExp(`^${USER}@[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$`), 'the address: ' + account.address)
  assert.ok(account.caps.includes('sign'), 'with `sign`, which is what the terminal requires')
})

scenario('the test machine enrolls in the vault and starts', async () => {
  const { enroll } = await import(path.join(AGENT, 'link.js'))
  const { startAgent } = await import(path.join(AGENT, 'index.js'))
  const dir = tmpDir('terminal-agent')
  const qr = await vault.pair({ label: 'Máquina de prueba' })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  agent = await startAgent({ dir, shell: '/bin/sh', quiet: !LOGS })
  assert.ok(agent.remote, 'with a link, the agent serves the other devices')
})

scenario('before signing in, the terminal asks where the identity lives', async () => {
  const page = await context.newPage()
  await page.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  await waitFor(async () => page.locator('#goVault').count(), { timeoutMs: 45000, what: 'the vault picker screen' })
  assert.equal(await visibleMachines(page), 0, 'a new profile does not belong to that account')
  await page.close()
})

scenario('with the wrong password it does not sign in, and says so by its code', async () => {
  const r = await signIn(context, signInData('no-es-esta-contrasena'))
  assert.equal(r.ok, false, 'it does not sign in')
  assert.equal(r.code, 'login-failed', 'and the code is the password one: ' + JSON.stringify(r))
})

scenario('the tester signs in with their address and password', async () => {
  const r = await signIn(context, signInData(PASSWORD))
  assert.ok(r.ok, 'signs in: ' + JSON.stringify(r))
})

scenario('and the terminal finds the machine and opens a shell on it', async () => {
  const page = await context.newPage()
  page.on('console', (m) => log('[pwa] ' + m.text()))
  page.on('pageerror', (e) => log('[pwa!] ' + e.message))
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  const machine = page.locator('[data-testid="machine-item"]').first()
  await machine.waitFor({ timeout: 45000 })
  assert.match(await machine.innerText(), /Máquina de prueba/, 'with the name it has in the record')
  await machine.click()
  await waitFor(async () => (await agent.consoles.list()).length === 1, { what: 'a console to open on the machine' })
  // Una orden de verdad: lo que escribe el tester llega a la shell y la respuesta vuelve.
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('echo hola-$((40+2))\n')
  await waitFor(async () => (await page.locator('.xterm-rows').first().innerText()).includes('hola-42'), { what: 'the shell answer' })
  if (process.env.SMOKE_SHOT) await page.screenshot({ path: process.env.SMOKE_SHOT })
  await page.close()
})

console.log('\nSMOKE · the terminal test account (user and password), all local\n')
if (!fs.existsSync(path.join(PWA, 'index.html'))) { console.error('Missing a build. Build it with:  cd dotrino-terminal && npm run build\n'); process.exit(2) }
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  webIframe = await serveStatic(IFRAME)
  webSignIn = await serveLoginPage()
  webPwa = await serveStatic(PWA, { spa: true })
  console.log(`  proxy  ${proxy.url}`)
  console.log(`  pwa    ${webPwa.url}/consoles\n`)
  browser = await chromium.launch({ headless: !VERBOSE })
  context = await browser.newContext({ locale: 'es-ES' })
  const ok = await runScenarios()
  try { agent?.close() } catch (_) {}
  await context?.close(); await browser?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { agent?.close() } catch (_) {}
  try { await context?.close(); await browser?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
