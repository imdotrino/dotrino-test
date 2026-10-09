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
 *   npm run smoke:demo-restaurar
 *   node smoke/demo-restaurar.mjs --verbose
 *
 * Requiere Docker y el build:  cd dotrino-terminal && npm run build
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { escenario, correr, startProxy, startVault, teardown, servirEstatico, tmpDir, ROOT } from './lib/harness.js'
import { dockerDisponible } from './lib/caja.js'
import { servirPaginaDeEntrar, entrar as entrarCon } from './lib/entrar.js'

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
let webIframe = null
let webEntrar = null
let webPwa = null
let navegador = null
let vault = null           // la bóveda en marcha (va cambiando: A, B, C)
let agente = null          // la máquina en marcha: un PROCESO aparte, como en producción
let iss = null             // el perfil de la copia
let direccion = null       // tester-1@…
let telefono = null        // el contexto de navegador del tester que entró ANTES del reset

// El machine-id fijo de la demo. Se usa el del host para que el harness pueda leer el canal
// cifrado de la bóveda (sale del mismo material); en producción es un archivo cualquiera.
const ids = tmpDir('machine-id')
const MACHINE_ID = path.join(ids, 'fijo')
const OTRO_ID = path.join(ids, 'otro')
fs.copyFileSync('/etc/machine-id', MACHINE_ID)
fs.writeFileSync(OTRO_ID, '0123456789abcdef0123456789abcdef\n')

const COPIA = tmpDir('copia')        // la copia guardada: vault/ y maquina/
const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

async function esperar (fn, { timeoutMs = 20000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(150)
  }
  throw new Error('se agotó la espera de ' + que)
}

const entrar = (contexto) => entrarCon(contexto, { paginaUrl: webEntrar.url, iframeUrl: iframeUrl(), proxyUrl: proxy.url, address: direccion, password: CLAVE })

/** Abre la PWA, entra en la máquina y comprueba que la shell contesta. */
async function abrirShell (contexto, { timeoutMs = 45000 } = {}) {
  const p = await contexto.newPage()
  p.on('console', (m) => log('[pwa] ' + m.text()))
  await p.setViewportSize({ width: 900, height: 700 })
  await p.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  try {
    const maquina = p.locator('[data-testid="machine-item"]').first()
    await maquina.waitFor({ timeout: timeoutMs })
    await maquina.click()
    await p.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 20000 })
    await sleep(1500)
    const marca = 'eco-' + Math.random().toString(36).slice(2, 8)
    await p.locator('.xterm-helper-textarea').first().focus()
    await p.keyboard.type(`echo ${marca}-$((1+1))\n`)
    await esperar(async () => (await p.locator('.xterm-rows').first().innerText()).includes(`${marca}-2`), { que: 'la respuesta de la shell' })
  } catch (e) {
    if (LOGS) console.log('[pantalla]\n' + (await p.locator('body').innerText().catch(() => '')).slice(0, 1500))
    throw e
  } finally { await p.close() }
}

/**
 * La máquina, con su comando (`dotrino-terminal-agent`) en un proceso aparte. No en el mismo
 * proceso que el smoke: dos agentes seguidos en un mismo proceso dejaban al segundo sin
 * atender («sesión desconocida o expirada»), cosa que con procesos separados no pasa.
 */
async function arrancarMaquina (dir) {
  const lineas = []
  agente = spawn(process.execPath, ['bin/cli.js', '--dir', dir, '--proxy', proxy.url, '--shell', '/bin/sh'], { cwd: AGENTE, stdio: ['ignore', 'pipe', 'pipe'] })
  const anotar = (b) => { lineas.push(String(b)); log('[maquina] ' + String(b).trim()) }
  agente.stdout.on('data', anotar); agente.stderr.on('data', anotar)
  await esperar(() => lineas.join('').includes('agente activo ·'), { que: 'que la máquina arranque' })
}

/** Restaura la copia en directorios nuevos y levanta bóveda (en un contenedor nuevo) y máquina. */
async function restaurar (nombre) {
  const dirVault = tmpDir(nombre + '-vault')
  const dirMaquina = tmpDir(nombre + '-maquina')
  fs.cpSync(path.join(COPIA, 'vault'), dirVault, { recursive: true })
  fs.cpSync(path.join(COPIA, 'maquina'), dirMaquina, { recursive: true })
  vault = await startVault({ proxyUrl: proxy.url, name: nombre, log, dir: dirVault, docker: { machineId: MACHINE_ID } })
  // La máquina le habla a la bóveda por el proxio (el socket local queda dentro del
  // contenedor), y no hace falta esperar a que la bóveda esté identificada: se arregla sola.
  await arrancarMaquina(dirMaquina)
}

async function apagarMaquina () {
  if (agente && agente.exitCode == null) {
    agente.kill('SIGTERM')
    await new Promise((r) => agente.once('exit', r))
  }
  agente = null
}

async function apagar () {
  await apagarMaquina()
  await vault?.stop()
  vault = null
}

escenario('se prepara la demo una vez: bóveda en un contenedor, tester y máquina', async () => {
  vault = await startVault({ proxyUrl: proxy.url, name: 'preparar', log, docker: { machineId: MACHINE_ID } })
  iss = vault.iss
  direccion = (await vault.loginsAdd(USUARIO, CLAVE, { label: 'tester' })).address
  const { enroll } = await import(path.join(AGENTE, 'link.js'))
  const dirMaquina = tmpDir('preparar-maquina')
  const qr = await vault.pair({ label: 'Máquina de prueba' })
  await enroll({ qr, dir: dirMaquina, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  const dirVault = vault.dir
  await apagar()
  // La COPIA: los dos directorios con todo apagado, para que nada esté a medio escribir.
  fs.cpSync(dirVault, path.join(COPIA, 'vault'), { recursive: true })
  fs.cpSync(dirMaquina, path.join(COPIA, 'maquina'), { recursive: true })
})

escenario('la copia abre en un contenedor NUEVO, con la misma dirección, y el tester entra', async () => {
  await restaurar('dia-1')
  assert.equal(vault.iss, iss, 'es el mismo perfil')
  const { logins } = await vault.logins('list')
  assert.deepEqual(logins.map((l) => l.user), [USUARIO], 'con su tester')
  telefono = await navegador.newContext({ locale: 'es-ES' })
  const r = await entrar(telefono)
  assert.ok(r.ok, 'entra: ' + JSON.stringify(r))
  await abrirShell(telefono)
})

escenario('durante el día se ensucia: un login de más', async () => {
  await vault.loginsAdd('intruso', 'otra-contrasena-larga', { label: 'intruso' })
  const { logins } = await vault.logins('list')
  assert.ok(logins.some((l) => l.user === 'intruso'), 'el login de más está')
})

escenario('el reset restaura la copia: lo añadido desaparece y la dirección es la misma', async () => {
  await apagar()
  await restaurar('dia-2')
  assert.equal(vault.iss, iss, 'el mismo perfil')
  const { logins, fingerprint } = await vault.logins('list')
  assert.deepEqual(logins.map((l) => l.user), [USUARIO], 'solo el tester: el intruso ya no está')
  const { loginAddress } = await import(path.join(ROOT, 'dotrino-vault/lib/src/passwordLogins.js'))
  assert.equal(loginAddress(USUARIO, fingerprint), direccion, 'y la dirección no cambió')
})

escenario('un teléfono nuevo entra con la MISMA contraseña y abre una shell', async () => {
  const nuevo = await navegador.newContext({ locale: 'es-ES' })
  const r = await entrar(nuevo)
  assert.ok(r.ok, 'entra: ' + JSON.stringify(r))
  await abrirShell(nuevo)
  await nuevo.close()
})

escenario('el teléfono que entró ANTES del reset: o sigue, o vuelve a entrar con la misma contraseña', async () => {
  // El acta restaurada es la misma que la que ya conocía, así que no hay bifurcación. Lo que
  // se perdió es su sesión en la bóveda. Se anota cuál de los dos caminos sale.
  let siguio = true
  try { await abrirShell(telefono, { timeoutMs: 20000 }) } catch (_) { siguio = false }
  if (siguio) { console.log('      (siguió dentro sin volver a entrar)'); return }
  console.log('      (tuvo que volver a entrar)')
  const r = await entrar(telefono)
  assert.ok(r.ok, 'vuelve a entrar: ' + JSON.stringify(r))
  await abrirShell(telefono)
})

escenario('con la pestaña ABIERTA, la máquina se reinicia y la pestaña se recupera sola', async () => {
  // Las sesiones viven en la memoria del agente: al reiniciarse (cada reset de la demo) deja de
  // conocerlas. La pestaña tiene que volver a saludar y seguir, no quedarse en «sesión
  // desconocida o expirada» (el fallo que se vio en la demo de Timone el 2026-10-06).
  const p = await telefono.newPage()
  p.on('console', (m) => log('[pwa] ' + m.text()))
  await p.setViewportSize({ width: 900, height: 700 })
  await p.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  const pantalla = () => p.locator('.xterm-rows').first().innerText()
  const escribir = async (orden) => { await p.locator('.xterm-helper-textarea').first().focus(); await p.keyboard.type(orden + '\n') }
  try {
    await p.locator('[data-testid="machine-item"]').first().click({ timeout: 45000 })
    await p.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 20000 })
    await sleep(1500)
    await escribir('echo antes-$((1+1))')
    await esperar(async () => (await pantalla()).includes('antes-2'), { que: 'la shell antes del reinicio' })
    // Reinicio de la máquina con la pestaña abierta.
    const dirMaquina = agente.spawnargs[agente.spawnargs.indexOf('--dir') + 1]
    await apagarMaquina()
    await arrancarMaquina(dirMaquina)
    // La primera tecla tras el reinicio es la que descubre que la sesión ya no existe.
    await escribir('')
    await esperar(async () => (await p.locator('body').innerText()).includes('ya no existe') || (await p.locator('body').innerText()).includes('no longer'), { timeoutMs: 30000, que: 'el aviso de que la consola ya no existe' })
    await escribir('echo despues-$((2+2))')
    await esperar(async () => (await pantalla()).includes('despues-4'), { que: 'la shell DESPUÉS del reinicio, en la misma pestaña' })
    assert.doesNotMatch(await p.locator('#hint').innerText(), /desconocida|unknown/i, 'sin el error de sesión desconocida')
  } catch (e) {
    if (LOGS) console.log('[pantalla]\n' + (await p.locator('body').innerText().catch(() => '')).slice(-1500))
    throw e
  } finally { await p.close() }
})

escenario('con OTRO machine-id la copia no abre, y lo dice: el machine-id fijo es lo que la hace portátil', async () => {
  await apagar()
  const dir = tmpDir('otra-maquina')
  fs.cpSync(path.join(COPIA, 'vault'), dir, { recursive: true })
  let error = null
  try {
    vault = await startVault({ proxyUrl: proxy.url, name: 'otra-maquina', log, dir, docker: { machineId: OTRO_ID } })
  } catch (e) { error = e }
  assert.ok(error, 'no arranca')
  assert.match((error.lines || []).join(''), /kek-machine-changed|DIFFERENT machine/, 'y dice por qué')
})

console.log('\nSMOKE · la demo de Terminal se restaura de una copia (bóveda en Docker, machine-id fijo)\n')
if (!dockerDisponible()) { console.error('Hace falta Docker: lo que se prueba es abrir la copia en un contenedor nuevo.\n'); process.exit(2) }
if (!fs.existsSync(path.join(PWA, 'index.html'))) { console.error('Falta un build. Hazlo con:  cd dotrino-terminal && npm run build\n'); process.exit(2) }
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  webIframe = await servirEstatico(IFRAME)
  webEntrar = await servirPaginaDeEntrar()
  webPwa = await servirEstatico(PWA, { spa: true })
  navegador = await chromium.launch({ headless: !VERBOSE })
  const ok = await correr()
  await apagar()
  await navegador?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  try { agente?.kill('SIGKILL') } catch (_) {}
  try { await navegador?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
