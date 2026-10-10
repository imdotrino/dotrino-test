/**
 * EL .RPM PUBLICADO, EN FEDORA, VE LAS CONSOLAS DE OTRA MÁQUINA. Lo que tiene instalado alguien
 * de verdad: el `.rpm` de la release (la app de escritorio) y `@dotrino/terminal-agent` de npm,
 * en una caja de Fedora con su propio usuario y su propia pantalla (Xvfb). La otra máquina es
 * un agente en el host. Proxio y bóveda, locales.
 *
 * Lo que prueba, en el orden en que se rompe:
 *   1. el cliente de la caja ve la otra máquina y sus consolas (`dotrino-terminal machines`);
 *   2. la app arranca con lo que trae el paquete y pinta el panel (captura en `--out`);
 *   3. sin enlazar, el panel DICE por qué no hay otras máquinas en vez de callar.
 *
 * La imagen se construye aparte (lleva minutos): ver `smoke/README.md`, «terminal-rpm».
 *
 *   node smoke/terminal-rpm.mjs --out /tmp/capturas [--verbose] [--b-agent <carpeta>]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { escenario, correr, startProxy, startVault, teardown, tmpDir, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null }
const AGENTE = path.join(ROOT, 'dotrino-terminal/agent')
const AGENTE_B = arg('--b-agent') ? path.resolve(arg('--b-agent')) : AGENTE
const IMAGEN = process.env.SMOKE_RPM_IMAGE || 'dotrino-terminal-rpm'
const OUT = path.resolve(arg('--out') || tmpDir('rpm-capturas'))
const CAJA = `smoke-terminal-rpm-${Date.now().toString(36)}`
const PERFIL = '/home/u/.dotrino/agent/terminal-agent'

let proxy = null
let vault = null
let b = null

const pod = (args, opts = {}) => spawnSync('podman', args, { encoding: 'utf8', ...opts })
/** Una orden en la caja, como el usuario `u` y con su pantalla. */
function enCaja (cmd, { root = false, timeout = 60000 } = {}) {
  const r = pod(['exec', ...(root ? [] : ['-u', 'u']), '-e', 'HOME=/home/u', '-e', 'DISPLAY=:9', '-e', 'LANG=es_EC.UTF-8', '-e', 'XDG_RUNTIME_DIR=/tmp/run-u', '-w', '/home/u', CAJA, 'bash', '-c', cmd], { timeout })
  log(`[caja] $ ${cmd}\n${r.stdout}${r.stderr}`)
  return r
}

async function esperar (fn, { timeoutMs = 40000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(500)
  }
  throw new Error('se agotó la espera de ' + que)
}

async function enlazar (nombre) {
  const { enroll } = await import(path.join(AGENTE, 'link.js'))
  const dir = tmpDir('rpm-' + nombre)
  const qr = await vault.pair({ label: nombre })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  return dir
}

/** Mete un enlace hecho fuera como perfil de la caja (lo que deja `dotrino-terminal link`). */
function ponerPerfil (nombre, dir) {
  enCaja(`mkdir -p ${PERFIL}`)
  const r = pod(['cp', dir + '/.', `${CAJA}:${PERFIL}/${nombre}`])
  assert.equal(r.status, 0, r.stderr)
  enCaja(`chown -R u:u /home/u/.dotrino && chmod -R go-rwx /home/u/.dotrino`, { root: true })
}

function captura (nombre) {
  enCaja(`import -window root /tmp/${nombre}.png`)
  const r = pod(['cp', `${CAJA}:/tmp/${nombre}.png`, path.join(OUT, `${nombre}.png`)])
  assert.equal(r.status, 0, r.stderr)
  return path.join(OUT, `${nombre}.png`)
}

/** Despliega el panel de consolas: clic en «»», arriba a la izquierda de la franja. */
const abrirPanel = () => enCaja('xdotool mousemove 15 41 click 1')

/** Abre la app con ese perfil y espera a que su ventana exista. Devuelve su registro. */
async function abrirApp (perfil) {
  enCaja('pkill -f dotrino-terminal-desktop; sleep 1; rm -f /tmp/app.log')
  enCaja(`(nohup dotrino-terminal-desktop ${perfil ? `--name ${perfil}` : ''} >/tmp/app.log 2>&1 &)`)
  await esperar(() => enCaja('xdotool search --class dotrino 2>/dev/null | head -1').stdout.trim(), { que: `la ventana de la app\n${enCaja('cat /tmp/app.log').stdout}` })
}

escenario('la caja de Fedora arranca con el .rpm y el cliente de npm', async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const r = pod(['run', '-d', '--rm', '--network', 'host', '--name', CAJA, IMAGEN, 'sleep', 'infinity'])
  assert.equal(r.status, 0, `falta la imagen ${IMAGEN}? ${r.stderr}`)
  enCaja('mkdir -p /tmp/run-u && chown u:u /tmp/run-u && chmod 700 /tmp/run-u', { root: true })
  enCaja('(nohup Xvfb :9 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &)', { root: true })
  const v = enCaja('rpm -q dotrino-terminal-desktop; npm ls -g 2>/dev/null | grep terminal-agent').stdout
  console.log('    ' + v.trim().replace(/\n/g, '\n    '))
  assert.match(v, /dotrino-terminal-desktop-\d/)
})

escenario('SIN ENLAZAR: el cliente dice por qué no ve otras máquinas', async () => {
  const r = enCaja('dotrino-terminal machines 2>&1', { timeout: 60000 })
  assert.match(r.stdout, /enlaza|not linked|vault|bóveda/i, r.stdout)
})

escenario('SIN ENLAZAR: la app abre, y el panel dice que el perfil no está enlazado', async () => {
  await abrirApp('default')
  await sleep(9000)                                   // tres lecturas del panel
  console.log('    captura: ' + captura('1-sin-enlazar'))
  abrirPanel()
  await sleep(1500)
  console.log('    captura: ' + captura('1-sin-enlazar-abierto'))
  enCaja('pkill -f dotrino-terminal-desktop; pkill -f bin/cli.js; sleep 1')
})

escenario('dos máquinas: la caja (A) y un agente en el host (B), con una consola abierta', async () => {
  const dirA = await enlazar('fedora')
  const dirB = await enlazar('escritorio')
  enCaja(`rm -rf ${PERFIL}/default`)
  ponerPerfil('default', dirA)
  const proc = spawn(process.execPath, [path.join(AGENTE_B, 'bin/cli.js'), '--dir', dirB, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let salida = ''
  proc.stdout.on('data', (d) => { salida += d; log(`[B] ${String(d).trimEnd()}`) })
  proc.stderr.on('data', (d) => { salida += d; log(`[B!] ${String(d).trimEnd()}`) })
  await esperar(() => /máquina: /.test(salida), { que: `que arranque B\n${salida}` })
  b = { dir: dirB, proc }
  // Una consola en B, suelta: es lo que tiene que salir en el panel de A.
  const { connectLocal } = await import(path.join(AGENTE, 'local.js'))
  const c = await connectLocal(dirB)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'open', cols: 80, rows: 24 })
  await esperar(() => got.find((m) => m.type === 'attached'), { que: 'la consola de B' })
  c.close()
})

escenario('ENLAZADA: el cliente de la caja lista la otra máquina y su consola', async () => {
  const r = await esperar(() => {
    const x = enCaja('dotrino-terminal machines 2>&1', { timeout: 60000 })
    return /escritorio/.test(x.stdout) ? x : null
  }, { timeoutMs: 90000, que: `que la caja vea a B\n${enCaja('dotrino-terminal machines 2>&1; tail -20 ' + PERFIL + '/default/agent.log').stdout}` })
  console.log('    ' + r.stdout.trim().replace(/\n/g, '\n    '))
  assert.match(r.stdout, /1 consolas?|1 consoles?/)
})

escenario('ENLAZADA: la app pinta la otra máquina en el panel (plegado y abierto)', async () => {
  await abrirApp('default')
  // El panel pregunta por las otras máquinas cada pocas lecturas: se le da tiempo.
  await sleep(15000)
  console.log('    captura: ' + captura('2-enlazada'))
  abrirPanel()
  await sleep(1500)
  console.log('    captura: ' + captura('2-enlazada-abierto'))
  const estado = enCaja(`node -e '
    const net = require("net"); const s = net.connect("${PERFIL}/default/terminal.sock")
    s.on("data", (d) => { process.stdout.write(d); s.end() }); s.write(JSON.stringify({ type: "machines" }) + "\\n")
    setTimeout(() => process.exit(0), 5000)'`).stdout
  assert.match(estado, /"name":"escritorio"/, estado)
  console.log('    registro de la app:\n      ' + enCaja('cat /tmp/app.log ~/.config/dotrino-terminal/desktop.log 2>/dev/null | tail -8').stdout.trim().replace(/\n/g, '\n      '))
})

console.log('\nSMOKE · el .rpm publicado, en Fedora, ve las consolas de otra máquina\n')
const parar = () => { try { b?.proc.kill('SIGTERM') } catch (_) {} pod(['rm', '-f', CAJA]) }
try {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  console.log(`  proxy  ${proxy.url}\n  capturas en ${OUT}\n`)
  const ok = await correr()
  parar()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  parar()
  await teardown()
  process.exit(1)
}
