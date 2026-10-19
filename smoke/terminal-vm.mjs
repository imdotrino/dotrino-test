/**
 * LA TERMINAL EN UNA MÁQUINA DE VERDAD: una VM de Fedora recién instalada, sin nada puesto.
 * Lo que hace alguien que llega de cero, en su orden, y lo que una caja no puede probar:
 * el arranque del sistema, `sudo`, el gestor de paquetes y un reinicio.
 *
 *   1. el instalador universal deja `dotrino-terminal` (sin Node en la máquina);
 *   2. el `.rpm` ANTERIOR de la app se instala con dnf;
 *   3. `dotrino-terminal desktop update` la sube a la última, verificada, con sus dependencias;
 *   4. el perfil se enlaza y `service install` lo deja como servicio;
 *   5. la VM SE REINICIA y, sin que nadie inicie sesión, la otra máquina la ve encendida;
 *   6. la app (en un Xvfb) pinta la otra máquina y su consola en el panel;
 *   7. desde la otra máquina se abre una consola EN la VM.
 *
 * La VM se levanta aparte (ver `smoke/README.md`, «terminal-vm»): un Fedora Cloud con un
 * usuario `tester` con sudo sin contraseña, y su SSH reenviado a un puerto del host.
 *
 *   node smoke/terminal-vm.mjs --ssh-port 2247 --key ~/vms/dotrino-fedora/key --out /tmp/screenshots
 *        [--from 0.2.47] [--verbose]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { scenario, runScenarios, startProxy, startVault, teardown, tmpDir, ROOT } from './lib/harness.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const AGENT = path.join(ROOT, 'dotrino-terminal/agent')
const PORT = Number(arg('--ssh-port', '2247'))
const KEY = path.resolve(arg('--key', path.join(process.env.HOME, 'vms/dotrino-fedora/key')))
const USER = arg('--user', 'tester')
const FROM = arg('--from', '0.2.47')
const OUT = path.resolve(arg('--out') || tmpDir('vm-screenshots'))
const REPO = 'https://github.com/imdotrino/dotrino-terminal/releases/download'
const SSH = ['-i', KEY, '-p', String(PORT), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10']
const PROFILE_DIR = `/home/${USER}/.dotrino/agent/terminal-agent/default`

let proxy = null
let vault = null
let b = null

/** Una orden en la VM, en una shell de INICIO DE SESIÓN: lo que ve una terminal recién abierta. */
function vm (cmd, { timeout = 120000 } = {}) {
  const r = spawnSync('ssh', [...SSH, `${USER}@127.0.0.1`, `bash -lc ${JSON.stringify(cmd)}`], { encoding: 'utf8', timeout })
  log(`[vm] $ ${cmd}\n${r.stdout}${r.stderr}`)
  return { ...r, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const check = (r, what) => { assert.equal(r.status, 0, `${what}\n${r.out}`); return r }

const waitLong = (fn, o) => waitFor(fn, { timeoutMs: 60000, every: 1000, ...o })

/** ¿Contesta el SSH de la VM? Solo se mira el puerto: no inicia sesión. */
const sshOpen = () => new Promise((resolve) => {
  const s = net.connect(PORT, '127.0.0.1')
  let done = false
  const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v) } }
  s.once('data', (d) => finish(/^SSH-/.test(String(d))))
  s.once('error', () => finish(false))
  setTimeout(() => finish(false), 2000)
})

async function linkDevice (name) {
  const { enroll } = await import(path.join(AGENT, 'link.js'))
  const dir = tmpDir('vm-' + name)
  const qr = await vault.pair({ label: name })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  return dir
}

/** Las máquinas que ve B (el agente del host), por su socket local. */
async function machinesSeenByB () {
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(b.dir)
  const r = await new Promise((resolve) => {
    c.on('message', (m) => { if (m.type === 'machines' || m.type === 'fail') resolve(m) })
    c.send({ type: 'machines' })
    setTimeout(() => resolve(null), 20000)
  })
  c.close()
  return r
}

function screenshot (name) {
  check(vm(`DISPLAY=:9 import -window root /tmp/${name}.png`), 'the screenshot')
  const r = spawnSync('scp', [...SSH.map((a) => (a === '-p' ? '-P' : a)), `${USER}@127.0.0.1:/tmp/${name}.png`, path.join(OUT, `${name}.png`)], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return path.join(OUT, `${name}.png`)
}

scenario('the VM is a clean Fedora: no Node, no app, no client', async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const r = check(vm('cat /etc/fedora-release; command -v node npm dotrino-terminal dotrino-terminal-desktop; rpm -q libXcursor libxkbcommon-x11; true'), 'sign in to the VM')
  console.log('    ' + r.stdout.trim().split('\n')[0])
  assert.doesNotMatch(r.stdout, /\/(node|npm|dotrino-terminal)\b/, 'the VM is not clean')
})

scenario('the universal installer leaves `dotrino-terminal` in a new terminal', async () => {
  check(vm('curl -fsSL https://install.dotrino.com/install.sh | sh -s -- @dotrino/terminal-agent 2>&1 | tail -15', { timeout: 300000 }), 'the installer')
  const r = check(vm('command -v dotrino-terminal && dotrino-terminal --help | head -1 && dotrino-terminal-agent info 2>&1 | head -2; true'), 'the command in a new shell')
  console.log('    ' + r.stdout.trim().split('\n')[0])
})

scenario(`the release .rpm ${FROM} installs with dnf`, async () => {
  check(vm(`sudo dnf -y -q install ${REPO}/desktop-v${FROM}/dotrino-terminal-desktop-${FROM}-1.x86_64.rpm 2>&1 | tail -3`, { timeout: 300000 }), 'dnf install')
  assert.match(vm('rpm -q dotrino-terminal-desktop').stdout, new RegExp(FROM.replace(/\./g, '\\.')))
})

scenario('`desktop update` without gh installs NOTHING, and says so', async () => {
  const r = vm(`dotrino-terminal desktop update --current ${FROM} 2>&1`, { timeout: 180000 })
  assert.notEqual(r.status, 0)
  assert.match(r.out, /gh/i, r.out)
  assert.match(vm('rpm -q dotrino-terminal-desktop').stdout, new RegExp(FROM.replace(/\./g, '\\.')), 'it was not touched')
})

scenario('`desktop update` with gh: downloads the latest, verifies it and installs it with its dependencies', async () => {
  check(vm('sudo dnf -y -q install gh 2>&1 | tail -2', { timeout: 300000 }), 'install gh')
  const r = check(vm(`dotrino-terminal desktop update --current ${FROM} 2>&1`, { timeout: 300000 }), 'desktop update')
  console.log('    ' + r.out.trim().split('\n').filter((l) => /Publicada|Published|Firmado|Signed|Instalada|Installed/.test(l)).join('\n    '))
  const v = vm('rpm -q dotrino-terminal-desktop libXcursor libxkbcommon-x11 libXi libXrandr').stdout
  console.log('    ' + v.trim().replace(/\n/g, '\n    '))
  assert.doesNotMatch(v, new RegExp(`desktop-${FROM.replace(/\./g, '\\.')}-`), 'still on the previous version')
  assert.doesNotMatch(v, /not installed|no está instalado/, 'the new version needs libraries that were not pulled in')
  // Y ya al día, lo dice sin bajar nada.
  const ver = /desktop-(\d+\.\d+\.\d+)/.exec(v)[1]
  assert.match(vm(`dotrino-terminal desktop update --current ${ver} 2>&1`).out, /al día|up to date/)
})

scenario('the profile is linked, and another machine (the host) starts with a console open', async () => {
  const dirA = await linkDevice('fedora-vm')
  const dirB = await linkDevice('escritorio')
  // Desde la VM el host es 10.0.2.2: el enlace apunta ahí, como apuntaría al proxio real.
  const link = JSON.parse(fs.readFileSync(path.join(dirA, 'link.json'), 'utf8'))
  link.proxy = `ws://10.0.2.2:${proxy.port}`
  fs.writeFileSync(path.join(dirA, 'link.json'), JSON.stringify(link, null, 2))
  check(vm(`mkdir -p ${PROFILE_DIR} && chmod 700 ${PROFILE_DIR}`), 'the profile folder')
  const r = spawnSync('scp', [...SSH.map((a) => (a === '-p' ? '-P' : a)), '-r', dirA + '/.', `${USER}@127.0.0.1:${PROFILE_DIR}/`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const proc = spawn(process.execPath, [path.join(AGENT, 'bin/cli.js'), '--dir', dirB, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let output = ''
  proc.stdout.on('data', (d) => { output += d; log(`[B] ${String(d).trimEnd()}`) })
  proc.stderr.on('data', (d) => { output += d; log(`[B!] ${String(d).trimEnd()}`) })
  await waitLong(() => /máquina: /.test(output), { what: () => `B to start\n${output}` })
  b = { dir: dirB, proc }
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(dirB)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'open', cols: 80, rows: 24 })
  await waitLong(() => got.find((m) => m.type === 'attached'), { what: 'B\'s console' })
  c.close()
})

scenario('`service install`: the agent stays as a user service, without sudo', async () => {
  const r = check(vm('dotrino-terminal service install 2>&1'), 'service install')
  console.log('    ' + r.out.trim().replace(/\n/g, '\n    '))
  assert.match(check(vm('systemctl --user is-active dotrino-terminal-agent-default.service'), 'the service').stdout, /^active/)
  assert.match(vm('dotrino-terminal service status').out, /corriendo|running/)
  // Arrancar al encender: si el sistema no lo dio solo, es la orden que el mensaje dice.
  if (!/Linger=yes/.test(vm(`loginctl show-user ${USER} -p Linger`).stdout)) {
    assert.match(r.out, /sudo loginctl enable-linger/, 'it does not start at boot and does not say how to fix it')
    check(vm(`sudo loginctl enable-linger ${USER}`), 'enable-linger')
    console.log('    (needed: sudo loginctl enable-linger)')
  }
  const m = await waitLong(async () => { const x = await machinesSeenByB(); return x?.list?.find((y) => y.name === 'fedora-vm') ? x : null }, { timeoutMs: 90000, every: 3000, what: 'the host to see the VM' })
  assert.ok(m)
})

scenario('THE VM REBOOTS: with nobody signing in, the host sees it on again', async () => {
  vm('sudo systemctl reboot', { timeout: 15000 })
  await waitLong(async () => !(await sshOpen()), { timeoutMs: 60000, what: 'the VM to shut down' })
  // Mientras está caída, B deja de verla (o la da por no contestar).
  await waitLong(sshOpen, { timeoutMs: 180000, every: 2000, what: 'the VM to come back' })
  // OJO: aquí no se entra por SSH. Lo único que habla con la VM es el proxio.
  const m = await waitLong(async () => {
    const x = await machinesSeenByB()
    const f = x?.list?.find((y) => y.name === 'fedora-vm')
    return f && Array.isArray(f.consoles) ? f : null
  }, { timeoutMs: 180000, every: 3000, what: 'the VM agent to come back by itself after the reboot' })
  console.log(`    the host sees ${m.name} (${m.id}) without having signed in to it`)
  // Ahora sí se entra, a mirar: el servicio arrancó con el sistema y no ha habido ninguna sesión.
  const r = vm('systemctl --user show dotrino-terminal-agent-default.service -p ActiveState -p ExecMainStartTimestamp; uptime -s; last -n 5 2>/dev/null | head -5')
  console.log('    ' + r.stdout.trim().replace(/\n/g, '\n    '))
  assert.match(r.stdout, /ActiveState=active/)
})

scenario('the VM client lists the host and its console', async () => {
  const r = await waitLong(() => { const x = vm('dotrino-terminal machines 2>&1'); return /escritorio/.test(x.out) ? x : null }, { timeoutMs: 90000, every: 3000, what: () => 'the VM to see the host\n' + vm(`dotrino-terminal machines 2>&1; tail -20 ${PROFILE_DIR}/agent.log; journalctl --user -u dotrino-terminal-agent-default -n 20 --no-pager`).out })
  console.log('    ' + r.out.trim().replace(/\n/g, '\n    '))
  assert.match(r.out, /1 consolas?|1 consoles?/)
})

scenario('the .rpm app opens with what the package brought and draws the other machine', async () => {
  // Solo la pantalla y con qué capturarla: las librerías de la app las tuvo que traer el .rpm.
  check(vm('sudo dnf -y -q install xorg-x11-server-Xvfb ImageMagick xdotool mesa-vulkan-drivers dejavu-sans-mono-fonts 2>&1 | tail -2', { timeout: 400000 }), 'install the display')
  vm('(nohup Xvfb :9 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &) ; sleep 2')
  vm('(DISPLAY=:9 nohup dotrino-terminal-desktop --name default >/tmp/app.log 2>&1 &) ; sleep 1')
  await waitLong(() => vm('DISPLAY=:9 xdotool search --class dotrino 2>/dev/null | head -1').stdout.trim(), { timeoutMs: 40000, what: () => 'the app window\n' + vm('cat /tmp/app.log').out })
  await sleep(15000)
  console.log('    screenshot: ' + screenshot('vm-1-collapsed'))
  vm('DISPLAY=:9 xdotool mousemove 15 41 click 1')
  await sleep(2000)
  console.log('    screenshot: ' + screenshot('vm-2-expanded'))
  // Lo que el panel pintó sale de aquí: lo mismo que la app le pregunta al agente.
  const state = vm(`node -e 'const s=require("net").connect("${PROFILE_DIR}/terminal.sock");s.on("data",(d)=>{process.stdout.write(d);s.end()});s.write(JSON.stringify({type:"machines"})+"\\n");setTimeout(()=>process.exit(0),5000)'`).stdout
  assert.match(state, /"name":"escritorio"/, state)
  vm('pkill -f dotrino-terminal-desktop; true')
})

scenario('from the host a console opens ON the VM, and runs there', async () => {
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(b.dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'via', machine: 'fedora-vm' })
  c.send({ type: 'open', cols: 80, rows: 24 })
  await waitLong(() => got.find((m) => m.type === 'attached' || m.type === 'fail'), { what: 'opening a console on the VM' })
  assert.equal(got.find((m) => m.type === 'fail'), undefined, JSON.stringify(got.find((m) => m.type === 'fail')))
  c.send({ type: 'input', data: 'cat /etc/fedora-release; hostname\r' })
  const out = () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('')
  await waitLong(() => /Fedora release/.test(out()), { what: () => 'the shell to answer from the VM\n' + out() })
  c.close()
})

scenario('`service uninstall` removes it and the agent stops running', async () => {
  const r = check(vm('dotrino-terminal service uninstall --yes 2>&1'), 'service uninstall')
  console.log('    ' + r.out.trim())
  assert.match(vm('dotrino-terminal service status').out, /no tiene servicio|has no service/)
  assert.equal(vm('pgrep -f "bin/cli.js"').stdout.trim(), '', 'an agent is still running')
})

console.log('\nSMOKE · the terminal on a clean Fedora VM: install, update, service, reboot and other machines\n')
const stop = () => { try { b?.proc.kill('SIGTERM') } catch (_) {} }
try {
  if (!(await sshOpen())) throw new Error(`no VM listening for SSH on port ${PORT}`)
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
