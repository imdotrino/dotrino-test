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
import { scenario, runScenarios, startProxy, startVault, teardown, tmpDir, ROOT } from './lib/harness.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null }
const AGENT = path.join(ROOT, 'dotrino-terminal/agent')
const AGENT_B = arg('--b-agent') ? path.resolve(arg('--b-agent')) : AGENT
const IMAGE = process.env.SMOKE_RPM_IMAGE || 'dotrino-terminal-rpm'
const OUT = path.resolve(arg('--out') || tmpDir('rpm-screenshots'))
// `--app <binario>`: la app compilada en este repo, en vez de la que trae el .rpm.
const APP = arg('--app') ? path.resolve(arg('--app')) : null
const BOX = `smoke-terminal-rpm-${Date.now().toString(36)}`
const PROFILE = '/home/u/.dotrino/agent/terminal-agent'

let proxy = null
let vault = null
let b = null

const pod = (args, opts = {}) => spawnSync('podman', args, { encoding: 'utf8', ...opts })
/** Una orden en la caja, como el usuario `u` y con su pantalla. */
function inBox (cmd, { root = false, timeout = 60000 } = {}) {
  const r = pod(['exec', ...(root ? [] : ['-u', 'u']), '-e', 'HOME=/home/u', '-e', 'DISPLAY=:9', '-e', 'LANG=es_EC.UTF-8', '-e', 'XDG_RUNTIME_DIR=/tmp/run-u', '-w', '/home/u', BOX, 'bash', '-c', cmd], { timeout })
  log(`[box] $ ${cmd}\n${r.stdout}${r.stderr}`)
  return r
}

const waitLong = (fn, o) => waitFor(fn, { timeoutMs: 40000, every: 500, ...o })

async function link (name) {
  const { enroll } = await import(path.join(AGENT, 'link.js'))
  const dir = tmpDir('rpm-' + name)
  const qr = await vault.pair({ label: name })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  return dir
}

/** Mete un enlace hecho fuera como perfil de la caja (lo que deja `dotrino-terminal link`). */
function putProfile (name, dir) {
  inBox(`mkdir -p ${PROFILE}`)
  const r = pod(['cp', dir + '/.', `${BOX}:${PROFILE}/${name}`])
  assert.equal(r.status, 0, r.stderr)
  inBox(`chown -R u:u /home/u/.dotrino && chmod -R go-rwx /home/u/.dotrino`, { root: true })
}

function screenshot (name) {
  inBox(`import -window root /tmp/${name}.png`)
  const r = pod(['cp', `${BOX}:/tmp/${name}.png`, path.join(OUT, `${name}.png`)])
  assert.equal(r.status, 0, r.stderr)
  return path.join(OUT, `${name}.png`)
}

/** Despliega el panel de consolas: clic en «»», arriba a la izquierda de la franja. */
const openPanel = () => inBox('xdotool mousemove 15 41 click 1')

/** Abre la app con ese perfil y espera a que su ventana exista. Devuelve su registro. */
async function openApp (profile) {
  inBox('pkill -f dotrino-terminal-desktop; sleep 1; rm -f /tmp/app.log')
  inBox(`(nohup dotrino-terminal-desktop ${profile ? `--name ${profile}` : ''} >/tmp/app.log 2>&1 &)`)
  await waitLong(() => inBox('xdotool search --class dotrino 2>/dev/null | head -1').stdout.trim(), { what: `the app window\n${inBox('cat /tmp/app.log').stdout}` })
}

scenario('the Fedora box starts with the .rpm and the npm client', async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const r = pod(['run', '-d', '--rm', '--network', 'host', '--name', BOX, IMAGE, 'sleep', 'infinity'])
  assert.equal(r.status, 0, `missing image ${IMAGE}? ${r.stderr}`)
  inBox('mkdir -p /tmp/run-u && chown u:u /tmp/run-u && chmod 700 /tmp/run-u', { root: true })
  if (APP) assert.equal(pod(['cp', APP, `${BOX}:/usr/bin/dotrino-terminal-desktop`]).status, 0, 'could not copy the app in')
  inBox('(nohup Xvfb :9 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &)', { root: true })
  const v = inBox('rpm -q dotrino-terminal-desktop; npm ls -g 2>/dev/null | grep terminal-agent').stdout
  console.log('    ' + v.trim().replace(/\n/g, '\n    '))
  assert.match(v, /dotrino-terminal-desktop-\d/)
})

scenario('NOT LINKED: the client says why it sees no other machines', async () => {
  const r = inBox('dotrino-terminal machines 2>&1', { timeout: 60000 })
  assert.match(r.stdout, /enlaza|not linked|vault|bóveda/i, r.stdout)
})

scenario('NOT LINKED: the app opens, and the panel says the profile is not linked', async () => {
  await openApp('default')
  await sleep(9000)                                   // three panel reads
  console.log('    screenshot: ' + screenshot('1-not-linked'))
  openPanel()
  await sleep(1500)
  console.log('    screenshot: ' + screenshot('1-not-linked-open'))
  inBox('pkill -f dotrino-terminal-desktop; pkill -f bin/cli.js; sleep 1')
})

scenario('two machines: the box (A) and an agent on the host (B), with a console open', async () => {
  const dirA = await link('fedora')
  const dirB = await link('desktop')
  inBox(`rm -rf ${PROFILE}/default`)
  putProfile('default', dirA)
  const proc = spawn(process.execPath, [path.join(AGENT_B, 'bin/cli.js'), '--dir', dirB, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let output = ''
  proc.stdout.on('data', (d) => { output += d; log(`[B] ${String(d).trimEnd()}`) })
  proc.stderr.on('data', (d) => { output += d; log(`[B!] ${String(d).trimEnd()}`) })
  await waitLong(() => /máquina: /.test(output), { what: `B to start\n${output}` })
  b = { dir: dirB, proc }
  // Una consola en B, suelta: es lo que tiene que salir en el panel de A.
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(dirB)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'open', cols: 80, rows: 24 })
  await waitLong(() => got.find((m) => m.type === 'attached'), { what: 'B\'s console' })
  c.close()
})

scenario('LINKED: the box client lists the other machine and its console', async () => {
  const r = await waitLong(() => {
    const x = inBox('dotrino-terminal machines 2>&1', { timeout: 60000 })
    return /desktop/.test(x.stdout) ? x : null
  }, { timeoutMs: 90000, what: `the box to see B\n${inBox('dotrino-terminal machines 2>&1; tail -20 ' + PROFILE + '/default/agent.log').stdout}` })
  console.log('    ' + r.stdout.trim().replace(/\n/g, '\n    '))
  assert.match(r.stdout, /1 consolas?|1 consoles?/)
})

scenario('LINKED: the app draws the other machine in the panel (collapsed and open)', async () => {
  await openApp('default')
  // El panel pregunta por las otras máquinas cada pocas lecturas: se le da tiempo.
  await sleep(15000)
  console.log('    screenshot: ' + screenshot('2-linked'))
  openPanel()
  await sleep(1500)
  console.log('    screenshot: ' + screenshot('2-linked-open'))
  const state = inBox(`node -e '
    const net = require("net"); const s = net.connect("${PROFILE}/default/terminal.sock")
    s.on("data", (d) => { process.stdout.write(d); s.end() }); s.write(JSON.stringify({ type: "machines" }) + "\\n")
    setTimeout(() => process.exit(0), 5000)'`).stdout
  assert.match(state, /"name":"desktop"/, state)
  console.log('    app log:\n      ' + inBox('cat /tmp/app.log ~/.config/dotrino-terminal/desktop.log 2>/dev/null | tail -8').stdout.trim().replace(/\n/g, '\n      '))
})

scenario('a console of the OTHER machine opens in THIS window, and switching back works the same', async () => {
  const windows = () => inBox('xdotool search --onlyvisible --class dotrino 2>/dev/null | wc -l').stdout.trim()
  const before = windows()
  // El panel está abierto: la consola de «desktop» es la fila bajo su nombre.
  inBox('xdotool mousemove 70 245 click 1')
  await sleep(6000)
  console.log('    screenshot: ' + screenshot('3-remote-in-this-window'))
  assert.equal(windows(), before, 'another window opened')
  // La shell que contesta es la de la otra máquina: su carpeta de perfil no es la de la caja.
  inBox('xdotool windowfocus $(xdotool search --onlyvisible --class dotrino | head -1); xdotool mousemove 600 300 click 1; sleep 1; xdotool type --delay 40 \'echo DIR=$DOTRINO_TERMINAL_PROFILE_DIR\'; xdotool key Return')
  await sleep(2500)
  console.log('    screenshot: ' + screenshot('4-remote-typing'))
  const list = async () => { const { connectLocal } = await import(path.join(AGENT, 'local.js')); const c = await connectLocal(b.dir); const r = await new Promise((res) => { c.on('message', (m) => { if (m.type === 'consoles') res(m.list) }); c.send({ type: 'list' }) }); c.close(); return r }
  const onB = await list()
  // Lo tecleado en la ventana llegó a la shell de la otra máquina, y la consola tomó el tamaño
  // de esta ventana, como cualquier consola que se pone en pantalla.
  const { connectLocal: cl } = await import(path.join(AGENT, 'local.js'))
  const spy = await cl(b.dir)
  const seen = []
  spy.on('message', (m) => seen.push(m))
  spy.send({ type: 'attach', id: onB[0].id, cols: onB[0].cols, rows: onB[0].rows, keep: true })
  await sleep(1500)
  spy.send({ type: 'detach' }); spy.close()
  const screen = seen.filter((m) => m.type === 'replay' || m.type === 'out').map((m) => m.data).join('')
  console.log(`    the other machine\'s console: ${onB[0].cols}×${onB[0].rows} · ${JSON.stringify(screen.slice(-120))}`)
  assert.match(screen, new RegExp('DIR=' + b.dir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')), 'what was typed did not reach the other machine')
  assert.ok(onB[0].cols > 80, `the console did not take the window size: ${onB[0].cols}×${onB[0].rows}`)
  assert.equal(onB.length, 1, 'no other console was created on the other machine')
  assert.ok(onB[0].viewers >= 1, 'the box window is not watching the other machine\'s console: ' + JSON.stringify(onB[0].watchers))
  // De vuelta a la de aquí, con un clic en su fila.
  inBox('xdotool mousemove 70 132 click 1')
  await sleep(5000)
  console.log('    screenshot: ' + screenshot('5-back-on-the-local-one'))
  assert.equal(windows(), before, 'another window opened when switching back')
  const after = await waitLong(async () => { const l = await list(); return l[0].viewers === 0 ? l : null }, { what: 'the other machine\'s console to be released' })
  assert.equal(after.length, 1, 'the other machine\'s console is still alive')
})

console.log('\nSMOKE · the published .rpm, on Fedora, sees another machine\'s consoles\n')
const stop = () => { try { b?.proc.kill('SIGTERM') } catch (_) {} pod(['rm', '-f', BOX]) }
try {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  console.log(`  proxy  ${proxy.url}\n  screenshots in ${OUT}\n`)
  const ok = await runScenarios()
  stop()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  stop()
  await teardown()
  process.exit(1)
}
