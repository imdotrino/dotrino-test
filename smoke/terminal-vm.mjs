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
 *   node smoke/terminal-vm.mjs --ssh-port 2247 --key ~/vms/dotrino-fedora/key --out /tmp/capturas
 *        [--from 0.2.47] [--verbose]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { escenario, correr, startProxy, startVault, teardown, tmpDir, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const AGENTE = path.join(ROOT, 'dotrino-terminal/agent')
const PORT = Number(arg('--ssh-port', '2247'))
const KEY = path.resolve(arg('--key', path.join(process.env.HOME, 'vms/dotrino-fedora/key')))
const USER = arg('--user', 'tester')
const FROM = arg('--from', '0.2.47')
const OUT = path.resolve(arg('--out') || tmpDir('vm-capturas'))
const REPO = 'https://github.com/imdotrino/dotrino-terminal/releases/download'
const SSH = ['-i', KEY, '-p', String(PORT), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10']
const PERFIL = `/home/${USER}/.dotrino/agent/terminal-agent/default`

let proxy = null
let vault = null
let b = null

/** Una orden en la VM, en una shell de INICIO DE SESIÓN: lo que ve una terminal recién abierta. */
function vm (cmd, { timeout = 120000 } = {}) {
  const r = spawnSync('ssh', [...SSH, `${USER}@127.0.0.1`, `bash -lc ${JSON.stringify(cmd)}`], { encoding: 'utf8', timeout })
  log(`[vm] $ ${cmd}\n${r.stdout}${r.stderr}`)
  return { ...r, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const bien = (r, que) => { assert.equal(r.status, 0, `${que}\n${r.out}`); return r }

async function esperar (fn, { timeoutMs = 60000, cada = 1000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(cada)
  }
  throw new Error('se agotó la espera de ' + (typeof que === 'function' ? que() : que))
}

/** ¿Contesta el SSH de la VM? Solo se mira el puerto: no inicia sesión. */
const sshAbierto = () => new Promise((resolve) => {
  const s = net.connect(PORT, '127.0.0.1')
  let dicho = false
  const fin = (v) => { if (!dicho) { dicho = true; s.destroy(); resolve(v) } }
  s.once('data', (d) => fin(/^SSH-/.test(String(d))))
  s.once('error', () => fin(false))
  setTimeout(() => fin(false), 2000)
})

async function enlazar (nombre) {
  const { enroll } = await import(path.join(AGENTE, 'link.js'))
  const dir = tmpDir('vm-' + nombre)
  const qr = await vault.pair({ label: nombre })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  return dir
}

/** Las máquinas que ve B (el agente del host), por su socket local. */
async function vistasDesdeB () {
  const { connectLocal } = await import(path.join(AGENTE, 'local.js'))
  const c = await connectLocal(b.dir)
  const r = await new Promise((resolve) => {
    c.on('message', (m) => { if (m.type === 'machines' || m.type === 'fail') resolve(m) })
    c.send({ type: 'machines' })
    setTimeout(() => resolve(null), 20000)
  })
  c.close()
  return r
}

function captura (nombre) {
  bien(vm(`DISPLAY=:9 import -window root /tmp/${nombre}.png`), 'la captura')
  const r = spawnSync('scp', [...SSH.map((a) => (a === '-p' ? '-P' : a)), `${USER}@127.0.0.1:/tmp/${nombre}.png`, path.join(OUT, `${nombre}.png`)], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return path.join(OUT, `${nombre}.png`)
}

escenario('la VM es un Fedora limpio: sin Node, sin la app, sin el cliente', async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const r = bien(vm('cat /etc/fedora-release; command -v node npm dotrino-terminal dotrino-terminal-desktop; rpm -q libXcursor libxkbcommon-x11; true'), 'entrar en la VM')
  console.log('    ' + r.stdout.trim().split('\n')[0])
  assert.doesNotMatch(r.stdout, /\/(node|npm|dotrino-terminal)\b/, 'la VM no está limpia')
})

escenario('el instalador universal deja `dotrino-terminal` en una terminal nueva', async () => {
  bien(vm('curl -fsSL https://install.dotrino.com/install.sh | sh -s -- @dotrino/terminal-agent 2>&1 | tail -15', { timeout: 300000 }), 'el instalador')
  const r = bien(vm('command -v dotrino-terminal && dotrino-terminal --help | head -1 && dotrino-terminal-agent info 2>&1 | head -2; true'), 'el comando en una shell nueva')
  console.log('    ' + r.stdout.trim().split('\n')[0])
})

escenario(`el .rpm ${FROM} de la release se instala con dnf`, async () => {
  bien(vm(`sudo dnf -y -q install ${REPO}/desktop-v${FROM}/dotrino-terminal-desktop-${FROM}-1.x86_64.rpm 2>&1 | tail -3`, { timeout: 300000 }), 'dnf install')
  assert.match(vm('rpm -q dotrino-terminal-desktop').stdout, new RegExp(FROM.replace(/\./g, '\\.')))
})

escenario('`desktop update` sin gh NO instala nada, y lo dice', async () => {
  const r = vm(`dotrino-terminal desktop update --current ${FROM} 2>&1`, { timeout: 180000 })
  assert.notEqual(r.status, 0)
  assert.match(r.out, /gh/i, r.out)
  assert.match(vm('rpm -q dotrino-terminal-desktop').stdout, new RegExp(FROM.replace(/\./g, '\\.')), 'no se tocó')
})

escenario('`desktop update` con gh: baja la última, la verifica y la instala con sus dependencias', async () => {
  bien(vm('sudo dnf -y -q install gh 2>&1 | tail -2', { timeout: 300000 }), 'instalar gh')
  const r = bien(vm(`dotrino-terminal desktop update --current ${FROM} 2>&1`, { timeout: 300000 }), 'desktop update')
  console.log('    ' + r.out.trim().split('\n').filter((l) => /Publicada|Published|Firmado|Signed|Instalada|Installed/.test(l)).join('\n    '))
  const v = vm('rpm -q dotrino-terminal-desktop libXcursor libxkbcommon-x11 libXi libXrandr').stdout
  console.log('    ' + v.trim().replace(/\n/g, '\n    '))
  assert.doesNotMatch(v, new RegExp(`desktop-${FROM.replace(/\./g, '\\.')}-`), 'sigue en la versión anterior')
  assert.doesNotMatch(v, /not installed|no está instalado/, 'la versión nueva pide librerías que no se trajeron')
  // Y ya al día, lo dice sin bajar nada.
  const ver = /desktop-(\d+\.\d+\.\d+)/.exec(v)[1]
  assert.match(vm(`dotrino-terminal desktop update --current ${ver} 2>&1`).out, /al día|up to date/)
})

escenario('el perfil se enlaza, y otra máquina (el host) arranca con una consola abierta', async () => {
  const dirA = await enlazar('fedora-vm')
  const dirB = await enlazar('escritorio')
  // Desde la VM el host es 10.0.2.2: el enlace apunta ahí, como apuntaría al proxio real.
  const link = JSON.parse(fs.readFileSync(path.join(dirA, 'link.json'), 'utf8'))
  link.proxy = `ws://10.0.2.2:${proxy.port}`
  fs.writeFileSync(path.join(dirA, 'link.json'), JSON.stringify(link, null, 2))
  bien(vm(`mkdir -p ${PERFIL} && chmod 700 ${PERFIL}`), 'la carpeta del perfil')
  const r = spawnSync('scp', [...SSH.map((a) => (a === '-p' ? '-P' : a)), '-r', dirA + '/.', `${USER}@127.0.0.1:${PERFIL}/`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const proc = spawn(process.execPath, [path.join(AGENTE, 'bin/cli.js'), '--dir', dirB, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let salida = ''
  proc.stdout.on('data', (d) => { salida += d; log(`[B] ${String(d).trimEnd()}`) })
  proc.stderr.on('data', (d) => { salida += d; log(`[B!] ${String(d).trimEnd()}`) })
  await esperar(() => /máquina: /.test(salida), { que: () => `que arranque B\n${salida}` })
  b = { dir: dirB, proc }
  const { connectLocal } = await import(path.join(AGENTE, 'local.js'))
  const c = await connectLocal(dirB)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'open', cols: 80, rows: 24 })
  await esperar(() => got.find((m) => m.type === 'attached'), { que: 'la consola de B' })
  c.close()
})

escenario('`service install`: el agente queda como servicio del usuario, sin sudo', async () => {
  const r = bien(vm('dotrino-terminal service install 2>&1'), 'service install')
  console.log('    ' + r.out.trim().replace(/\n/g, '\n    '))
  assert.match(bien(vm('systemctl --user is-active dotrino-terminal-agent-default.service'), 'el servicio').stdout, /^active/)
  assert.match(vm('dotrino-terminal service status').out, /corriendo|running/)
  // Arrancar al encender: si el sistema no lo dio solo, es la orden que el mensaje dice.
  if (!/Linger=yes/.test(vm(`loginctl show-user ${USER} -p Linger`).stdout)) {
    assert.match(r.out, /sudo loginctl enable-linger/, 'no arranca al encender y no dice cómo arreglarlo')
    bien(vm(`sudo loginctl enable-linger ${USER}`), 'enable-linger')
    console.log('    (hizo falta: sudo loginctl enable-linger)')
  }
  const m = await esperar(async () => { const x = await vistasDesdeB(); return x?.list?.find((y) => y.name === 'fedora-vm') ? x : null }, { timeoutMs: 90000, cada: 3000, que: 'que el host vea la VM' })
  assert.ok(m)
})

escenario('LA VM SE REINICIA: sin que nadie inicie sesión, el host la vuelve a ver encendida', async () => {
  vm('sudo systemctl reboot', { timeout: 15000 })
  await esperar(async () => !(await sshAbierto()), { timeoutMs: 60000, que: 'que la VM se apague' })
  // Mientras está caída, B deja de verla (o la da por no contestar).
  await esperar(sshAbierto, { timeoutMs: 180000, cada: 2000, que: 'que la VM vuelva' })
  // OJO: aquí no se entra por SSH. Lo único que habla con la VM es el proxio.
  const m = await esperar(async () => {
    const x = await vistasDesdeB()
    const f = x?.list?.find((y) => y.name === 'fedora-vm')
    return f && Array.isArray(f.consoles) ? f : null
  }, { timeoutMs: 180000, cada: 3000, que: 'que el agente de la VM vuelva solo tras el reinicio' })
  console.log(`    el host ve ${m.name} (${m.id}) sin haber iniciado sesión en ella`)
  // Ahora sí se entra, a mirar: el servicio arrancó con el sistema y no ha habido ninguna sesión.
  const r = vm('systemctl --user show dotrino-terminal-agent-default.service -p ActiveState -p ExecMainStartTimestamp; uptime -s; last -n 5 2>/dev/null | head -5')
  console.log('    ' + r.stdout.trim().replace(/\n/g, '\n    '))
  assert.match(r.stdout, /ActiveState=active/)
})

escenario('el cliente de la VM lista el host y su consola', async () => {
  const r = await esperar(() => { const x = vm('dotrino-terminal machines 2>&1'); return /escritorio/.test(x.out) ? x : null }, { timeoutMs: 90000, cada: 3000, que: () => 'que la VM vea al host\n' + vm(`dotrino-terminal machines 2>&1; tail -20 ${PERFIL}/agent.log; journalctl --user -u dotrino-terminal-agent-default -n 20 --no-pager`).out })
  console.log('    ' + r.out.trim().replace(/\n/g, '\n    '))
  assert.match(r.out, /1 consolas?|1 consoles?/)
})

escenario('la app del .rpm abre con lo que trajo el paquete y pinta la otra máquina', async () => {
  // Solo la pantalla y con qué capturarla: las librerías de la app las tuvo que traer el .rpm.
  bien(vm('sudo dnf -y -q install xorg-x11-server-Xvfb ImageMagick xdotool mesa-vulkan-drivers dejavu-sans-mono-fonts 2>&1 | tail -2', { timeout: 400000 }), 'instalar la pantalla')
  vm('(nohup Xvfb :9 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &) ; sleep 2')
  vm('(DISPLAY=:9 nohup dotrino-terminal-desktop --name default >/tmp/app.log 2>&1 &) ; sleep 1')
  await esperar(() => vm('DISPLAY=:9 xdotool search --class dotrino 2>/dev/null | head -1').stdout.trim(), { timeoutMs: 40000, que: () => 'la ventana de la app\n' + vm('cat /tmp/app.log').out })
  await sleep(15000)
  console.log('    captura: ' + captura('vm-1-plegado'))
  vm('DISPLAY=:9 xdotool mousemove 15 41 click 1')
  await sleep(2000)
  console.log('    captura: ' + captura('vm-2-abierto'))
  // Lo que el panel pintó sale de aquí: lo mismo que la app le pregunta al agente.
  const estado = vm(`node -e 'const s=require("net").connect("${PERFIL}/terminal.sock");s.on("data",(d)=>{process.stdout.write(d);s.end()});s.write(JSON.stringify({type:"machines"})+"\\n");setTimeout(()=>process.exit(0),5000)'`).stdout
  assert.match(estado, /"name":"escritorio"/, estado)
  vm('pkill -f dotrino-terminal-desktop; true')
})

escenario('desde el host se abre una consola EN la VM, y corre allí', async () => {
  const { connectLocal } = await import(path.join(AGENTE, 'local.js'))
  const c = await connectLocal(b.dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'via', machine: 'fedora-vm' })
  c.send({ type: 'open', cols: 80, rows: 24 })
  await esperar(() => got.find((m) => m.type === 'attached' || m.type === 'fail'), { que: 'abrir una consola en la VM' })
  assert.equal(got.find((m) => m.type === 'fail'), undefined, JSON.stringify(got.find((m) => m.type === 'fail')))
  c.send({ type: 'input', data: 'cat /etc/fedora-release; hostname\r' })
  const out = () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('')
  await esperar(() => /Fedora release/.test(out()), { que: () => 'que la shell conteste desde la VM\n' + out() })
  c.close()
})

escenario('`service uninstall` lo quita y el agente deja de correr', async () => {
  const r = bien(vm('dotrino-terminal service uninstall --yes 2>&1'), 'service uninstall')
  console.log('    ' + r.out.trim())
  assert.match(vm('dotrino-terminal service status').out, /no tiene servicio|has no service/)
  assert.equal(vm('pgrep -f "bin/cli.js"').stdout.trim(), '', 'sigue corriendo un agente')
})

console.log('\nSMOKE · la terminal en una VM de Fedora limpia: instalar, actualizar, servicio, reinicio y otras máquinas\n')
const parar = () => { try { b?.proc.kill('SIGTERM') } catch (_) {} }
try {
  if (!(await sshAbierto())) throw new Error(`no hay una VM escuchando SSH en el puerto ${PORT}`)
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
