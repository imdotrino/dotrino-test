/**
 * LA DEMO SE RESTAURA DE UNA COPIA, Y EL TESTER SIGUE ENTRANDO CON LA MISMA DIRECCIÓN.
 *
 * Así se resetea la cuenta de prueba de Terminal (ver `demo-terminal.mjs`): la bóveda y la
 * máquina se preparan UNA vez, se guarda una copia de sus directorios, y cada reset la
 * restaura en contenedores nuevos. Lo que se comprueba:
 *
 *   · la dirección `tester@AB12-CD34-EF56` no cambia: sale del `profileId` del acta, que
 *     viaja en la copia (`dotrino-vault/lib/src/passwordLogins.js`, `accountFingerprint`);
 *   · lo que se añadió después de la copia desaparece al restaurar;
 *   · el tester entra con la MISMA contraseña y abre una shell;
 *   · la bóveda abre en un contenedor NUEVO solo porque `/etc/machine-id` va montado y fijo.
 *     Con otro, para con `kek-machine-changed` (`lib/src/kek.js`, `assertSameMachine`) — sin
 *     montarlo, el material cae al hostname, que es el id del contenedor y cambia cada vez.
 *
 *   npm run smoke:demo-restore
 *   node smoke/demo-restore.mjs --verbose
 *
 * Requiere Docker y el build:  cd dotrino-terminal && npm run build
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { scenario, runScenarios, startProxy, startVault, teardown, serveStatic, tmpDir, ROOT } from './lib/harness.js'
import { dockerAvailable } from './lib/box.js'
import { serveLoginPage, signIn } from './lib/sign-in.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const LOGS = VERBOSE || process.argv.includes('--logs')
const log = (m) => { if (LOGS) console.log(m) }

const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const PWA = path.join(ROOT, 'dotrino-terminal/dist')
const AGENT = path.join(ROOT, 'dotrino-terminal/agent')

const USER = 'tester-1'
const PASSWORD = 'long-test-password'

let proxy = null
let webIframe = null
let webSignIn = null
let webPwa = null
let browser = null
let vault = null           // la bóveda en marcha (va cambiando: A, B, C)
let agent = null          // la máquina en marcha: un PROCESO aparte, como en producción
let iss = null             // el perfil de la copia
let address = null       // tester-1@…
let phone = null        // el contexto de navegador del tester que entró ANTES del reset

// El machine-id fijo de la demo. Se usa el del host para que el harness pueda leer el canal
// cifrado de la bóveda (sale del mismo material); en producción es un archivo cualquiera.
const ids = tmpDir('machine-id')
const MACHINE_ID = path.join(ids, 'fixed')
const OTHER_ID = path.join(ids, 'other')
fs.copyFileSync('/etc/machine-id', MACHINE_ID)
fs.writeFileSync(OTHER_ID, '0123456789abcdef0123456789abcdef\n')

const SNAPSHOT = tmpDir('snapshot')        // la copia guardada: vault/ y maquina/
const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

const signInAs = (context) => signIn(context, { pageUrl: webSignIn.url, iframeUrl: iframeUrl(), proxyUrl: proxy.url, address, password: PASSWORD })

/** Abre la PWA, entra en la máquina y comprueba que la shell contesta. */
async function openShell (context, { timeoutMs = 45000 } = {}) {
  const p = await context.newPage()
  p.on('console', (m) => log('[pwa] ' + m.text()))
  await p.setViewportSize({ width: 900, height: 700 })
  await p.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  try {
    const machine = p.locator('[data-testid="machine-item"]').first()
    await machine.waitFor({ timeout: timeoutMs })
    await machine.click()
    await p.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 20000 })
    await sleep(1500)
    const marker = 'eco-' + Math.random().toString(36).slice(2, 8)
    await p.locator('.xterm-helper-textarea').first().focus()
    await p.keyboard.type(`echo ${marker}-$((1+1))\n`)
    await waitFor(async () => (await p.locator('.xterm-rows').first().innerText()).includes(`${marker}-2`), { what: 'the shell reply' })
  } catch (e) {
    if (LOGS) console.log('[screen]\n' + (await p.locator('body').innerText().catch(() => '')).slice(0, 1500))
    throw e
  } finally { await p.close() }
}

/**
 * La máquina, con su comando (`dotrino-terminal-agent`) en un proceso aparte. No en el mismo
 * proceso que el smoke: dos agentes seguidos en un mismo proceso dejaban al segundo sin
 * atender («sesión desconocida o expirada»), cosa que con procesos separados no pasa.
 */
async function startMachine (dir) {
  const lines = []
  agent = spawn(process.execPath, ['bin/cli.js', '--dir', dir, '--proxy', proxy.url, '--shell', '/bin/sh'], { cwd: AGENT, stdio: ['ignore', 'pipe', 'pipe'] })
  const record = (b) => { lines.push(String(b)); log('[machine] ' + String(b).trim()) }
  agent.stdout.on('data', record); agent.stderr.on('data', record)
  // Necesita @dotrino/terminal-agent construido con remote-agent ≥ 0.22.2 (el log dice «agent running»).
  await waitFor(() => lines.join('').includes('agent running ·'), { what: 'the machine to start' })
}

/** Restaura la copia en directorios nuevos y levanta bóveda (en un contenedor nuevo) y máquina. */
async function restore (name) {
  const vaultDir = tmpDir(name + '-vault')
  const machineDir = tmpDir(name + '-machine')
  fs.cpSync(path.join(SNAPSHOT, 'vault'), vaultDir, { recursive: true })
  fs.cpSync(path.join(SNAPSHOT, 'machine'), machineDir, { recursive: true })
  vault = await startVault({ proxyUrl: proxy.url, name: name, log, dir: vaultDir, docker: { machineId: MACHINE_ID } })
  // La máquina le habla a la bóveda por el proxio (el socket local queda dentro del
  // contenedor), y no hace falta esperar a que la bóveda esté identificada: se arregla sola.
  await startMachine(machineDir)
}

async function stopMachine () {
  if (agent && agent.exitCode == null) {
    agent.kill('SIGTERM')
    await new Promise((r) => agent.once('exit', r))
  }
  agent = null
}

async function stopAll () {
  await stopMachine()
  await vault?.stop()
  vault = null
}

scenario('the demo is prepared once: vault in a container, tester and machine', async () => {
  vault = await startVault({ proxyUrl: proxy.url, name: 'prepare', log, docker: { machineId: MACHINE_ID } })
  iss = vault.iss
  address = (await vault.loginsAdd(USER, PASSWORD, { label: 'tester' })).address
  const { enroll } = await import(path.join(AGENT, 'link.js'))
  const machineDir = tmpDir('prepare-machine')
  const qr = await vault.pair({ label: 'Test machine' })
  await enroll({ qr, dir: machineDir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  const vaultDir = vault.dir
  await stopAll()
  // La COPIA: los dos directorios con todo apagado, para que nada esté a medio escribir.
  fs.cpSync(vaultDir, path.join(SNAPSHOT, 'vault'), { recursive: true })
  fs.cpSync(machineDir, path.join(SNAPSHOT, 'machine'), { recursive: true })
})

scenario('the snapshot opens in a NEW container, with the same address, and the tester signs in', async () => {
  await restore('day-1')
  assert.equal(vault.iss, iss, 'it is the same profile')
  const { logins } = await vault.logins('list')
  assert.deepEqual(logins.map((l) => l.user), [USER], 'with its tester')
  phone = await browser.newContext({ locale: 'es-ES' })
  const r = await signInAs(phone)
  assert.ok(r.ok, 'signs in: ' + JSON.stringify(r))
  await openShell(phone)
})

scenario('during the day it gets dirty: an extra login', async () => {
  await vault.loginsAdd('intruder', 'another-long-password', { label: 'intruder' })
  const { logins } = await vault.logins('list')
  assert.ok(logins.some((l) => l.user === 'intruder'), 'the extra login is there')
})

scenario('the reset restores the snapshot: what was added is gone and the address is the same', async () => {
  await stopAll()
  await restore('day-2')
  assert.equal(vault.iss, iss, 'the same profile')
  const { logins, fingerprint } = await vault.logins('list')
  assert.deepEqual(logins.map((l) => l.user), [USER], 'only the tester: the intruder is gone')
  const { loginAddress } = await import(path.join(ROOT, 'dotrino-vault/lib/src/passwordLogins.js'))
  assert.equal(loginAddress(USER, fingerprint), address, 'and the address did not change')
})

scenario('a new phone signs in with the SAME password and opens a shell', async () => {
  const fresh = await browser.newContext({ locale: 'es-ES' })
  const r = await signInAs(fresh)
  assert.ok(r.ok, 'signs in: ' + JSON.stringify(r))
  await openShell(fresh)
  await fresh.close()
})

scenario('the phone that signed in BEFORE the reset: either stays in, or signs in again with the same password', async () => {
  // El acta restaurada es la misma que la que ya conocía, así que no hay bifurcación. Lo que
  // se perdió es su sesión en la bóveda. Se anota cuál de los dos caminos sale.
  let stayed = true
  try { await openShell(phone, { timeoutMs: 20000 }) } catch (_) { stayed = false }
  if (stayed) { console.log('      (stayed signed in without signing in again)'); return }
  console.log('      (had to sign in again)')
  const r = await signInAs(phone)
  assert.ok(r.ok, 'signs in again: ' + JSON.stringify(r))
  await openShell(phone)
})

scenario('with the tab OPEN, the machine restarts and the tab recovers by itself', async () => {
  // Las sesiones viven en la memoria del agente: al reiniciarse (cada reset de la demo) deja de
  // conocerlas. La pestaña tiene que volver a saludar y seguir, no quedarse en «sesión
  // desconocida o expirada» (el fallo que se vio en la demo de Timone el 2026-10-06).
  const p = await phone.newPage()
  p.on('console', (m) => log('[pwa] ' + m.text()))
  await p.setViewportSize({ width: 900, height: 700 })
  await p.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  const screen = () => p.locator('.xterm-rows').first().innerText()
  const typeLine = async (cmd) => { await p.locator('.xterm-helper-textarea').first().focus(); await p.keyboard.type(cmd + '\n') }
  try {
    await p.locator('[data-testid="machine-item"]').first().click({ timeout: 45000 })
    await p.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 20000 })
    await sleep(1500)
    await typeLine('echo before-$((1+1))')
    await waitFor(async () => (await screen()).includes('before-2'), { what: 'the shell before the restart' })
    // Reinicio de la máquina con la pestaña abierta.
    const machineDir = agent.spawnargs[agent.spawnargs.indexOf('--dir') + 1]
    await stopMachine()
    await startMachine(machineDir)
    // La primera tecla tras el reinicio es la que descubre que la sesión ya no existe.
    await typeLine('')
    await waitFor(async () => (await p.locator('body').innerText()).includes('ya no existe') || (await p.locator('body').innerText()).includes('no longer'), { timeoutMs: 30000, what: 'the notice that the console no longer exists' })
    await typeLine('echo after-$((2+2))')
    await waitFor(async () => (await screen()).includes('after-4'), { what: 'the shell AFTER the restart, in the same tab' })
    assert.doesNotMatch(await p.locator('#hint').innerText(), /desconocida|unknown/i, 'without the unknown-session error')
  } catch (e) {
    if (LOGS) console.log('[screen]\n' + (await p.locator('body').innerText().catch(() => '')).slice(-1500))
    throw e
  } finally { await p.close() }
})

scenario('with ANOTHER machine-id the snapshot does not open, and says so: the fixed machine-id is what makes it portable', async () => {
  await stopAll()
  const dir = tmpDir('other-machine')
  fs.cpSync(path.join(SNAPSHOT, 'vault'), dir, { recursive: true })
  let error = null
  try {
    vault = await startVault({ proxyUrl: proxy.url, name: 'other-machine', log, dir, docker: { machineId: OTHER_ID } })
  } catch (e) { error = e }
  assert.ok(error, 'it does not start')
  assert.match((error.lines || []).join(''), /kek-machine-changed|DIFFERENT machine/, 'and says why')
})

console.log('\nSMOKE · the Terminal demo restores from a snapshot (vault in Docker, fixed machine-id)\n')
if (!dockerAvailable()) { console.error('Docker is required: what is tested is opening the snapshot in a new container.\n'); process.exit(2) }
if (!fs.existsSync(path.join(PWA, 'index.html'))) { console.error('Missing a build. Build it with:  cd dotrino-terminal && npm run build\n'); process.exit(2) }
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  webIframe = await serveStatic(IFRAME)
  webSignIn = await serveLoginPage()
  webPwa = await serveStatic(PWA, { spa: true })
  browser = await chromium.launch({ headless: !VERBOSE })
  const ok = await runScenarios()
  await stopAll()
  await browser?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { agent?.kill('SIGKILL') } catch (_) {}
  try { await browser?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
