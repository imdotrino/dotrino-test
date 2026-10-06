/**
 * LA IMAGEN DE LA DEMO PARA APPLE (`demo-apple/`), de punta a punta y con un navegador.
 *
 * Lo que comprueba, con la imagen de verdad (paquetes de npm, no el código del disco):
 *   · `preparar` crea la cuenta del revisor y la máquina, y deja la dirección;
 *   · `servir` arranca, el revisor entra con esa dirección y abre una shell;
 *   · la shell es de `tester` y NO puede leer la bóveda, su socket ni la copia;
 *   · al reiniciar el contenedor (el reset) lo que dejó el revisor desaparece, y el mismo
 *     teléfono vuelve a abrir una shell.
 *
 *   npm run smoke:demo-apple
 *   node smoke/demo-apple.mjs --logs
 *
 * Requiere Docker y el build:  cd dotrino-terminal && npm run build
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { escenario, correr, startProxy, teardown, servirEstatico, tmpDir, ROOT } from './lib/harness.js'
import { dockerDisponible } from './lib/caja.js'
import { servirPaginaDeEntrar, entrar } from './lib/entrar.js'

const VERBOSE = process.argv.includes('--verbose')
const LOGS = VERBOSE || process.argv.includes('--logs')
const log = (m) => { if (LOGS) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const IMAGEN = 'dotrino-demo-apple:smoke'
const CONTEXTO = path.join(ROOT, 'dotrino-test/demo-apple')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const PWA = path.join(ROOT, 'dotrino-terminal/dist')
const CLAVE = 'contrasena-de-prueba-larga'

let proxy = null
let webIframe = null
let webEntrar = null
let webPwa = null
let navegador = null
let telefono = null
let volumen = null
let contenedor = null
let direccion = null

const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`
const proxyEnCaja = () => proxy.url   // con --network host, el proxio del host es localhost

async function esperar (fn, { timeoutMs = 20000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(200)
  }
  throw new Error('se agotó la espera de ' + que)
}

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' })
const logsDe = () => { const r = docker('logs', contenedor); return (r.stdout || '') + (r.stderr || '') }

/** Las veces que la máquina dijo que está activa: cada arranque del contenedor suma una. */
const arranques = () => (logsDe().match(/agente activo ·/g) || []).length

/**
 * Abre la PWA, entra en la máquina, escribe `ordenes` y espera a que salga `fin`. Devuelve lo
 * que se ve en la terminal.
 */
async function enLaShell (contexto, ordenes, fin) {
  const p = await contexto.newPage()
  p.on('console', (m) => log('[pwa] ' + m.text()))
  await p.setViewportSize({ width: 1000, height: 800 })
  try {
    await p.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
    await p.locator('[data-testid="machine-item"]').first().click({ timeout: 45000 })
    await p.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 20000 })
    await sleep(1500)
    await p.locator('.xterm-helper-textarea').first().focus()
    await p.keyboard.type(ordenes + '\n')
    const texto = () => p.locator('.xterm-rows').first().innerText()
    await esperar(async () => (await texto()).includes(fin), { que: `«${fin}» en la shell` })
    return await texto()
  } catch (e) {
    if (LOGS) console.log('[pantalla]\n' + (await p.locator('body').innerText().catch(() => '')).slice(-1500))
    throw e
  } finally { await p.close() }
}

escenario('la imagen se construye con los paquetes publicados', async () => {
  const r = docker('build', '-q', '-t', IMAGEN, CONTEXTO)
  assert.equal(r.status, 0, 'docker build: ' + r.stderr)
})

escenario('sin copia, «servir» espera y dice cómo prepararla (no entra en un bucle de reinicios)', async () => {
  const vacio = tmpDir('demo-apple-vacio')
  const nombre = `smoke-demo-apple-vacio-${Date.now().toString(36)}`
  assert.equal(docker('run', '-d', '--name', nombre, '-v', `${vacio}:/data`, IMAGEN).status, 0)
  try {
    const salida = () => { const r = docker('logs', nombre); return (r.stdout || '') + (r.stderr || '') }
    await esperar(() => salida().includes('nothing to serve'), { que: 'el aviso de que no hay copia' })
    await sleep(1500)
    assert.equal(docker('inspect', '-f', '{{.State.Running}}', nombre).stdout.trim(), 'true', 'y sigue en marcha')
  } finally {
    docker('rm', '-f', nombre)
    docker('run', '--rm', '-v', `${vacio}:/data`, '--entrypoint', 'sh', IMAGEN, '-c', 'rm -rf /data/*')
  }
})

escenario('«preparar» crea la cuenta del revisor y la máquina (contraseña tecleada en un terminal)', async () => {
  volumen = tmpDir('demo-apple-data')
  // `logins add` lee la contraseña del TERMINAL, así que hace falta uno: `script` lo pone.
  const orden = `docker run --rm -it --network host -v ${volumen}:/data -e DEMO_PROXY=${proxyEnCaja()} ${IMAGEN} preparar`
  const p = spawn('script', ['-qec', orden, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let salida = ''
  let tecleadas = 0
  const leer = (b) => {
    salida += String(b); log('[preparar] ' + String(b).trimEnd())
    const pide = (salida.match(/Contraseña para|Repítela/g) || []).length
    while (tecleadas < pide) { tecleadas++; p.stdin.write(CLAVE + '\r') }
  }
  p.stdout.on('data', leer); p.stderr.on('data', leer)
  const code = await new Promise((r) => p.on('exit', r))
  assert.equal(code, 0, 'preparar termina bien:\n' + salida.slice(-1500))
  // La que se lee en pantalla, que es la que se pega en App Store Connect.
  direccion = (/user:\s+(\S+)/.exec(salida) || [])[1]
  assert.match(direccion, /^apple@[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/, 'la dirección: ' + direccion)
})

escenario('«servir» arranca y el revisor entra con la dirección y la contraseña', async () => {
  contenedor = `smoke-demo-apple-${Date.now().toString(36)}`
  const r = docker('run', '-d', '--name', contenedor, '--network', 'host', '-v', `${volumen}:/data`, '-e', `DEMO_PROXY=${proxyEnCaja()}`, IMAGEN)
  assert.equal(r.status, 0, 'docker run: ' + r.stderr)
  await esperar(() => arranques() >= 1, { timeoutMs: 30000, que: 'que la máquina arranque' })
  telefono = await navegador.newContext({ locale: 'es-ES' })
  const e = await entrar(telefono, { paginaUrl: webEntrar.url, iframeUrl: iframeUrl(), proxyUrl: proxy.url, address: direccion, password: CLAVE })
  assert.ok(e.ok, 'entra: ' + JSON.stringify(e))
})

escenario('la shell es de «tester» y no puede leer la bóveda, su socket ni la copia', async () => {
  const t = await enLaShell(telefono,
    'id -un; ls /data/run/vault; ls /run/vault; ls /data/copia; touch ~/sucio /tmp/sucio; echo fin-$((3*3))', 'fin-9')
  assert.match(t, /^tester$/m, 'quien escribe es tester')
  assert.match(t, /\/data\/run\/vault.*Permission denied/, 'el directorio de la bóveda está cerrado')
  assert.match(t, /\/run\/vault.*Permission denied/, 'el del socket también')
  assert.match(t, /\/data\/copia.*Permission denied/, 'y la copia (lo que sobrevive al reset)')
})

escenario('el reset (reiniciar el contenedor) borra lo que dejó y el mismo teléfono sigue entrando', async () => {
  const antes = arranques()
  assert.equal(docker('restart', contenedor).status, 0, 'docker restart')
  await esperar(() => arranques() > antes, { timeoutMs: 30000, que: 'que la máquina vuelva a arrancar' })
  const t = await enLaShell(telefono, 'ls -A ~ /tmp; echo fin-$((2*2))', 'fin-4')
  assert.doesNotMatch(t, /sucio/, 'ni ~/sucio ni /tmp/sucio')
})

console.log('\nSMOKE · la imagen de la demo para Apple (preparar, servir, aislamiento y reset)\n')
if (!dockerDisponible()) { console.error('Hace falta Docker.\n'); process.exit(2) }
if (spawnSync('script', ['--version']).status !== 0) { console.error('Hace falta `script` (util-linux).\n'); process.exit(2) }
if (!fs.existsSync(path.join(PWA, 'index.html'))) { console.error('Falta un build. Hazlo con:  cd dotrino-terminal && npm run build\n'); process.exit(2) }

async function limpiar () {
  if (contenedor) docker('rm', '-f', contenedor)
  // Lo escribió root dentro del contenedor: se borra desde otro, o el teardown no puede.
  if (volumen) docker('run', '--rm', '-v', `${volumen}:/data`, '--entrypoint', 'sh', IMAGEN, '-c', 'rm -rf /data/* /data/.[!.]*')
}

try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  webIframe = await servirEstatico(IFRAME)
  webEntrar = await servirPaginaDeEntrar()
  webPwa = await servirEstatico(PWA, { spa: true })
  navegador = await chromium.launch({ headless: !VERBOSE })
  const ok = await correr()
  if (!ok && LOGS && contenedor) console.log('[contenedor]\n' + logsDe().slice(-3000))
  await navegador?.close()
  await limpiar()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  try { await navegador?.close() } catch (_) {}
  await limpiar()
  await teardown()
  process.exit(1)
}
