/**
 * LA IMAGEN DE LA DEMO PARA APPLE (repo `dotrino-demo-apple`), de punta a punta y con un navegador.
 *
 * Lo que comprueba, con la imagen de verdad (paquetes de npm, no el código del disco):
 *   · `prepare` crea la cuenta del revisor y la máquina, y deja la dirección;
 *   · `serve` arranca, el revisor entra con esa dirección y abre una shell;
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
import { scenario, runScenarios, startProxy, teardown, serveStatic, tmpDir, ROOT } from './lib/harness.js'
import { dockerAvailable } from './lib/box.js'
import { serveLoginPage, signIn } from './lib/sign-in.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const LOGS = VERBOSE || process.argv.includes('--logs')
const log = (m) => { if (LOGS) console.log(m) }

const IMAGE = 'dotrino-demo-apple:smoke'
const BUILD_CONTEXT = path.join(ROOT, 'dotrino-demo-apple')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const PWA = path.join(ROOT, 'dotrino-terminal/dist')
const PASSWORD = 'contrasena-de-prueba-larga'

let proxy = null
let webIframe = null
let webSignIn = null
let webPwa = null
let browser = null
let phone = null
let volume = null
let container = null
let address = null

const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`
const proxyInBox = () => proxy.url   // con --network host, el proxio del host es localhost

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' })
const containerLogs = () => { const r = docker('logs', container); return (r.stdout || '') + (r.stderr || '') }

/** Las veces que la máquina dijo que está activa: cada arranque del contenedor suma una. */
// Necesita @dotrino/terminal-agent construido con remote-agent ≥ 0.22.2 (el log dice «agent running»).
const startCount = () => (containerLogs().match(/agent running ·/g) || []).length

/**
 * Abre la PWA, entra en la máquina, escribe `commands` y espera a que salga `end`. Devuelve lo
 * que se ve en la terminal.
 */
async function inTheShell (context, commands, end) {
  const p = await context.newPage()
  p.on('console', (m) => log('[pwa] ' + m.text()))
  await p.setViewportSize({ width: 1000, height: 800 })
  try {
    await p.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
    await p.locator('[data-testid="machine-item"]').first().click({ timeout: 45000 })
    await p.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 20000 })
    await sleep(1500)
    await p.locator('.xterm-helper-textarea').first().focus()
    await p.keyboard.type(commands + '\n')
    const text = () => p.locator('.xterm-rows').first().innerText()
    await waitFor(async () => (await text()).includes(end), { what: `«${end}» in the shell` })
    return await text()
  } catch (e) {
    if (LOGS) console.log('[screen]\n' + (await p.locator('body').innerText().catch(() => '')).slice(-1500))
    throw e
  } finally { await p.close() }
}

scenario('the image builds from the published packages', async () => {
  const r = docker('build', '-q', '-t', IMAGE, BUILD_CONTEXT)
  assert.equal(r.status, 0, 'docker build: ' + r.stderr)
})

scenario('without a snapshot, «serve» waits and says how to prepare it (no restart loop)', async () => {
  const emptyDir = tmpDir('demo-apple-empty')
  const name = `smoke-demo-apple-empty-${Date.now().toString(36)}`
  assert.equal(docker('run', '-d', '--name', name, '-v', `${emptyDir}:/data`, IMAGE).status, 0)
  try {
    const output = () => { const r = docker('logs', name); return (r.stdout || '') + (r.stderr || '') }
    await waitFor(() => output().includes('nothing to serve'), { what: 'the notice that there is no snapshot' })
    await sleep(1500)
    assert.equal(docker('inspect', '-f', '{{.State.Running}}', name).stdout.trim(), 'true', 'and it keeps running')
  } finally {
    docker('rm', '-f', name)
    docker('run', '--rm', '-v', `${emptyDir}:/data`, '--entrypoint', 'sh', IMAGE, '-c', 'rm -rf /data/*')
  }
})

scenario('«prepare» creates the reviewer account and the machine (password typed in a terminal)', async () => {
  volume = tmpDir('demo-apple-data')
  // `logins add` lee la contraseña del TERMINAL, así que hace falta uno: `script` lo pone.
  const command = `docker run --rm -it --network host -v ${volume}:/data -e DEMO_PROXY=${proxyInBox()} ${IMAGE} prepare`
  const p = spawn('script', ['-qec', command, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let typed = 0
  const onData = (b) => {
    output += String(b); log('[prepare] ' + String(b).trimEnd())
    const asked = (output.match(/Contraseña para|Repítela/g) || []).length
    while (typed < asked) { typed++; p.stdin.write(PASSWORD + '\r') }
  }
  p.stdout.on('data', onData); p.stderr.on('data', onData)
  const code = await new Promise((r) => p.on('exit', r))
  assert.equal(code, 0, 'prepare finishes cleanly:\n' + output.slice(-1500))
  // La que se lee en pantalla, que es la que se pega en App Store Connect.
  address = (/user:\s+(\S+)/.exec(output) || [])[1]
  assert.match(address, /^apple@[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/, 'the address: ' + address)
})

scenario('«serve» starts and the reviewer signs in with the address and the password', async () => {
  container = `smoke-demo-apple-${Date.now().toString(36)}`
  const r = docker('run', '-d', '--name', container, '--network', 'host', '-v', `${volume}:/data`, '-e', `DEMO_PROXY=${proxyInBox()}`, IMAGE)
  assert.equal(r.status, 0, 'docker run: ' + r.stderr)
  await waitFor(() => startCount() >= 1, { timeoutMs: 30000, what: 'the machine to start' })
  phone = await browser.newContext({ locale: 'es-ES' })
  const e = await signIn(phone, { pageUrl: webSignIn.url, iframeUrl: iframeUrl(), proxyUrl: proxy.url, address, password: PASSWORD })
  assert.ok(e.ok, 'signs in: ' + JSON.stringify(e))
})

scenario('the shell belongs to «tester» and cannot read the vault, its socket or the snapshot', async () => {
  const t = await inTheShell(phone,
    'id -un; ls /data/run/vault; ls /run/vault; ls /data/snapshot; touch ~/dirty /tmp/dirty; echo done-$((3*3))', 'done-9')
  assert.match(t, /^tester$/m, 'the one typing is tester')
  assert.match(t, /\/data\/run\/vault.*Permission denied/, 'the vault directory is locked')
  assert.match(t, /\/run\/vault.*Permission denied/, 'the socket one too')
  assert.match(t, /\/data\/snapshot.*Permission denied/, 'and the snapshot (what survives the reset)')
})

scenario('the reset (restarting the container) wipes what was left and the same phone still gets in', async () => {
  const before = startCount()
  assert.equal(docker('restart', container).status, 0, 'docker restart')
  await waitFor(() => startCount() > before, { timeoutMs: 30000, what: 'the machine to start again' })
  const t = await inTheShell(phone, 'ls -A ~ /tmp; echo done-$((2*2))', 'done-4')
  assert.doesNotMatch(t, /dirty/, 'neither ~/dirty nor /tmp/dirty')
})

scenario('without a volume (Timone): the snapshot arrives in chunks via DEMO_SNAPSHOT_B64_<n>, answers on the port and the reviewer gets in', async () => {
  // `export 8000` desde un contenedor con el volumen: una línea por variable, porque Timone
  // limita cada valor a 8192 caracteres.
  const ex = docker('run', '--rm', '-v', `${volume}:/data`, IMAGE, 'export', '8000')
  assert.equal(ex.status, 0, 'export: ' + ex.stderr)
  const parts = ex.stdout.trim().split('\n')
  assert.ok(parts.length > 1, 'it comes out in several parts: ' + parts.length)
  for (const p of parts) assert.match(p, /^[A-Za-z0-9+/=]{1,8000}$/, 'each one base64 and at most 8000')
  const vars = parts.flatMap((p, i) => ['-e', `DEMO_SNAPSHOT_B64_${i + 1}=${p}`])
  docker('rm', '-f', container)
  const port = 18000 + Math.floor(Math.random() * 1000)
  container = `smoke-demo-apple-env-${Date.now().toString(36)}`
  const r = docker('run', '-d', '--name', container, '--network', 'host',
    '-e', `DEMO_PROXY=${proxyInBox()}`, ...vars, '-e', `DEMO_HTTP_PORT=${port}`, IMAGE)
  assert.equal(r.status, 0, 'docker run without a volume: ' + r.stderr)
  await waitFor(() => startCount() >= 1, { timeoutMs: 30000, what: 'the machine to start' })
  assert.match(containerLogs(), /snapshot loaded from DEMO_SNAPSHOT_B64/, 'it loaded the snapshot from the variable')
  assert.match(containerLogs(), new RegExp('serving ' + address.replace(/[-@]/g, '\\$&')), 'with the same address')
  const ok = await waitFor(() => fetch(`http://127.0.0.1:${port}/`).then((x) => x.text()).catch(() => null), { what: 'the 200 on the port' })
  assert.equal(ok.trim(), 'ok')
  const t = await inTheShell(phone, 'id -un; echo done-$((5+5))', 'done-10')
  assert.match(t, /^tester$/m, 'and the shell belongs to tester')
})

console.log('\nSMOKE · the Apple demo image (prepare, serve, isolation and reset)\n')
if (!dockerAvailable()) { console.error('Docker is required.\n'); process.exit(2) }
if (spawnSync('script', ['--version']).status !== 0) { console.error('`script` (util-linux) is required.\n'); process.exit(2) }
if (!fs.existsSync(path.join(PWA, 'index.html'))) { console.error('Missing a build. Build it with:  cd dotrino-terminal && npm run build\n'); process.exit(2) }

async function cleanUp () {
  if (container) docker('rm', '-f', container)
  // Lo escribió root dentro del contenedor: se borra desde otro, o el teardown no puede.
  if (volume) docker('run', '--rm', '-v', `${volume}:/data`, '--entrypoint', 'sh', IMAGE, '-c', 'rm -rf /data/* /data/.[!.]*')
}

try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  webIframe = await serveStatic(IFRAME)
  webSignIn = await serveLoginPage()
  webPwa = await serveStatic(PWA, { spa: true })
  browser = await chromium.launch({ headless: !VERBOSE })
  const ok = await runScenarios()
  if (!ok && LOGS && container) console.log('[container]\n' + containerLogs().slice(-3000))
  await browser?.close()
  await cleanUp()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { await browser?.close() } catch (_) {}
  await cleanUp()
  await teardown()
  process.exit(1)
}
