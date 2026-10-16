/**
 * LA TERMINAL EN WINDOWS, DE VERDAD: una VM de Windows 11 con el agente PUBLICADO en npm.
 * Lo que el runner de CI no prueba: el agente enlazado a una bóveda, hablando por el proxio con
 * otra máquina, y PowerShell abierto desde esa otra máquina.
 *
 *   1. `npm install -g @dotrino/terminal-agent@<versión>` en la VM;
 *   2. el perfil se enlaza (en el host, contra la bóveda de la prueba) y se copia a la VM;
 *   3. `service install` desde una sesión SSH: el agente queda corriendo al cerrarla;
 *   4. el host (otra máquina de la cuenta) ve la VM y abre PowerShell en ella;
 *   5. la ventana de la VM (`dotrino-terminal.cmd machines`, por la tubería con nombre) ve al host;
 *   6. lo que corre al iniciar sesión es exactamente lo apuntado en `HKCU\…\Run`;
 *   7. `service uninstall` lo quita todo.
 *
 * Se llama a `dotrino-terminal.cmd` y no a `dotrino-terminal`: en un Windows recién instalado la
 * política de ejecución de PowerShell no deja correr el `.ps1` que npm pone al lado.
 *
 * La VM es la `win11` de libvirt (ver la memoria `dotrino-vm-win11`): `ssh dotrino-win11`, con
 * Node en el PATH. El host, visto desde la VM, es 192.168.122.1.
 *
 *   node smoke/terminal-windows.mjs [--ssh dotrino-win11] [--host 192.168.122.1] [--version 0.47.0] [--verbose]
 *        [--installed]  no instala nada: prueba lo que la VM ya tenga (una rama, antes de publicarla)
 *        [--desktop <zip>]  además, la app de escritorio de ese .zip (el artefacto de CI o la release):
 *                       se abre en la sesión gráfica de Windows y su consola tiene que ser PowerShell
 *        [--out <carpeta>]  dónde dejar la captura de la pantalla de la VM
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { escenario, correr, startProxy, startVault, teardown, tmpDir, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const AGENTE = path.join(ROOT, 'dotrino-terminal/agent')
const SSH_HOST = arg('--ssh', 'dotrino-win11')
const HOST = arg('--host', '192.168.122.1')
const VERSION = arg('--version', JSON.parse(fs.readFileSync(path.join(AGENTE, 'package.json'), 'utf8')).version)
const PERFIL = 'winvm'
const INSTALLED = process.argv.includes('--installed')
const DESKTOP_ZIP = arg('--desktop') && path.resolve(arg('--desktop'))
const OUT = path.resolve(arg('--out') || tmpDir('win-capturas'))

let proxy = null
let vault = null
let b = null
let home = null          // %USERPROFILE% de la VM

/** Una orden de PowerShell en la VM. Va codificada: así no hay comillas que escapar. */
function ps (script, { timeout = 120000 } = {}) {
  // El código de salida es el de la última orden externa: PowerShell 5.1 da 1 en cuanto una
  // orden escribe por stderr (npm avisa por ahí), aunque haya terminado bien.
  const full = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Continue'; $global:LASTEXITCODE=0; ${script}; exit $LASTEXITCODE`
  const enc = Buffer.from(full, 'utf16le').toString('base64')
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', SSH_HOST, `powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`], { encoding: 'utf8', timeout })
  const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/#< CLIXML\r?\n?/g, '').replace(/<Objs[\s\S]*?<\/Objs>/g, '')
  log(`[vm] > ${script}\n${out}`)
  return { ...r, out }
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

async function enlazar (nombre) {
  const { enroll } = await import(path.join(AGENTE, 'link.js'))
  const dir = tmpDir('win-' + nombre)
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

const dirVM = () => `${home}\\.dotrino\\agent\\terminal-agent\\${PERFIL}`
const logVM = () => ps(`Get-Content -Tail 30 '${dirVM()}\\agent.log' -ErrorAction SilentlyContinue`).out

escenario('la VM tiene Node y ningún agente de terminal corriendo', async () => {
  const r = bien(ps('[Environment]::OSVersion.VersionString; node -v; $env:USERPROFILE'), 'entrar en la VM')
  const lines = r.out.trim().split(/\r?\n/)
  home = lines.at(-1).trim()
  console.log(`    ${lines[0]} · node ${lines[1]} · ${home}`)
  // Lo que haya dejado una pasada anterior, fuera: la prueba empieza de cero.
  ps(`dotrino-terminal.cmd service uninstall --name ${PERFIL} --yes 2>&1 | Out-Null; Remove-Item -Recurse -Force '${dirVM()}' -ErrorAction SilentlyContinue`)
  assert.doesNotMatch(ps('Get-CimInstance Win32_Process -Filter "name=\'node.exe\'" | Select-Object -Expand CommandLine').out, /terminal-agent/, 'ya corre un agente de terminal')
})

escenario(INSTALLED ? 'el agente que ya tiene la VM está en el PATH' : `npm instala @dotrino/terminal-agent@${VERSION} con su PTY para Windows`, async () => {
  if (!INSTALLED) bien(ps(`npm install -g @dotrino/terminal-agent@${VERSION} 2>&1 | Select-Object -Last 3`, { timeout: 400000 }), 'npm install -g')
  const r = bien(ps('(Get-Command dotrino-terminal.cmd).Source; $null = dotrino-terminal-agent.cmd --help'), 'los comandos en el PATH')
  console.log('    ' + r.out.trim().split(/\r?\n/)[0])
})

escenario('el perfil se enlaza y otra máquina (el host) arranca', async () => {
  const dirA = await enlazar('windows-vm')
  const dirB = await enlazar('escritorio')
  // Desde la VM el host es la puerta de la red de libvirt: el enlace apunta ahí.
  const link = JSON.parse(fs.readFileSync(path.join(dirA, 'link.json'), 'utf8'))
  link.proxy = `ws://${HOST}:${proxy.port}`
  fs.writeFileSync(path.join(dirA, 'link.json'), JSON.stringify(link, null, 2))
  bien(ps(`New-Item -ItemType Directory -Force '${dirVM()}' | Out-Null`), 'la carpeta del perfil')
  const dest = `${dirVM().replace(/\\/g, '/')}/`
  for (const f of fs.readdirSync(dirA).filter((x) => fs.statSync(path.join(dirA, x)).isFile())) {
    // scp va por SFTP: la ruta viaja tal cual, con sus espacios y sin comillas.
    const r = spawnSync('scp', ['-o', 'BatchMode=yes', path.join(dirA, f), `${SSH_HOST}:${dest}${f}`], { encoding: 'utf8' })
    assert.equal(r.status, 0, `copiar ${f}: ${r.stderr}`)
  }
  const proc = spawn(process.execPath, [path.join(AGENTE, 'bin/cli.js'), '--dir', dirB, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let salida = ''
  proc.stdout.on('data', (d) => { salida += d; log(`[B] ${String(d).trimEnd()}`) })
  proc.stderr.on('data', (d) => { salida += d; log(`[B!] ${String(d).trimEnd()}`) })
  await esperar(() => /máquina: /.test(salida), { que: () => `que arranque B\n${salida}` })
  b = { dir: dirB, proc }
})

escenario('`service install` desde SSH: el agente sigue corriendo al cerrar la sesión', async () => {
  const r = bien(ps(`dotrino-terminal.cmd service install --name ${PERFIL} 2>&1`), 'service install')
  console.log('    ' + r.out.trim().replace(/\r?\n/g, '\n    '))
  assert.match(r.out, /iniciar sesión en Windows|log in to Windows/)
  // Otra sesión SSH, la anterior ya cerrada: el supervisor y el agente tienen que seguir ahí.
  await sleep(3000)
  const st = await esperar(() => { const x = ps(`dotrino-terminal.cmd service status --name ${PERFIL} 2>&1`); return /corriendo|running/.test(x.out) ? x : null }, { timeoutMs: 30000, cada: 2000, que: () => 'el servicio corriendo\n' + logVM() })
  console.log('    ' + st.out.trim())
})

escenario('el host ve la VM y abre PowerShell en ella', async () => {
  await esperar(async () => (await vistasDesdeB())?.list?.find((y) => y.name === 'windows-vm'), { timeoutMs: 90000, cada: 3000, que: () => 'que el host vea la VM\n' + logVM() })
  const { connectLocal } = await import(path.join(AGENTE, 'local.js'))
  const c = await connectLocal(b.dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'via', machine: 'windows-vm' })
  c.send({ type: 'open', cols: 100, rows: 30 })
  await esperar(() => got.find((m) => m.type === 'attached' || m.type === 'fail'), { que: 'abrir una consola en la VM' })
  assert.equal(got.find((m) => m.type === 'fail'), undefined, JSON.stringify(got.find((m) => m.type === 'fail')))
  c.send({ type: 'input', data: 'Write-Output "desde-$(40+2)-$env:COMPUTERNAME"; $PSVersionTable.PSEdition\r' })
  const out = () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('')
  const m = await esperar(() => /desde-42-(\S+)/.exec(out()), { que: () => 'que PowerShell conteste desde la VM\n' + out() })
  console.log(`    PowerShell contestó desde ${m[1]}`)
  c.close()
})

if (DESKTOP_ZIP) escenario('la app de escritorio abre en la sesión de Windows con el perfil, y su consola es PowerShell', async () => {
  const zip = path.basename(DESKTOP_ZIP)
  const tmp = `${home.replace(/\\/g, '/')}/AppData/Local/Temp/${zip}`
  const r = spawnSync('scp', ['-o', 'BatchMode=yes', DESKTOP_ZIP, `${SSH_HOST}:${tmp}`], { encoding: 'utf8' })
  assert.equal(r.status, 0, `copiar el .zip: ${r.stderr}`)
  // Como la instalaría alguien: el .zip desempaquetado en sus programas de usuario.
  const exe = bien(ps(`$dst = "$env:LOCALAPPDATA\\Programs\\DotrinoTerminal"; Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue; Expand-Archive '${tmp}' $dst -Force; (Get-ChildItem $dst -Recurse -Filter dotrino-terminal-desktop.exe).FullName`), 'desempaquetar').out.trim().split(/\r?\n/).at(-1)
  console.log('    ' + exe)
  // En la sesión gráfica del usuario (desde SSH no se ve nada): una tarea interactiva, ya.
  bien(ps(`$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '--name ${PERFIL}'; $p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive; Register-ScheduledTask -TaskName DotrinoDesktopSmoke -Action $a -Principal $p -Force | Out-Null; Start-ScheduledTask -TaskName DotrinoDesktopSmoke`), 'abrir la app en la sesión')
  // Su ventana engancha una consola del agente con la marca de la app (`desktop-<pid>-<n>`).
  const consola = await esperar(async () => {
    const f = (await vistasDesdeB())?.list?.find((y) => y.name === 'windows-vm')
    return f?.consoles?.find((c) => JSON.stringify(c.watchers || []).includes('"tag":"desktop-'))
  }, { timeoutMs: 60000, cada: 2000, que: () => 'la consola de la app\n' + ps('Get-Process dotrino-terminal-desktop -ErrorAction SilentlyContinue | Format-List Id,StartTime; Get-Content -Tail 20 "$env:USERPROFILE\\.config\\dotrino-terminal\\desktop.log" -ErrorAction SilentlyContinue').out + logVM() })
  // Desde la otra máquina se entra en ESA consola, la de la ventana, y contesta PowerShell.
  const { connectLocal } = await import(path.join(AGENTE, 'local.js'))
  const c = await connectLocal(b.dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'via', machine: 'windows-vm' })
  c.send({ type: 'attach', id: consola.id, cols: 100, rows: 30 })
  await esperar(() => got.find((m) => m.type === 'attached' || m.type === 'fail'), { que: 'engancharse a la consola de la app' })
  assert.equal(got.find((m) => m.type === 'fail'), undefined, JSON.stringify(got.find((m) => m.type === 'fail')))
  c.send({ type: 'input', data: 'Write-Output "app-$(6*7)"\r' })
  const out = () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('')
  await esperar(() => /app-42/.test(out()), { que: () => 'que conteste PowerShell en la consola de la app\n' + out() })
  c.close()
  await sleep(1500)
  // La pantalla de la VM, para mirarla: la app abierta con el resultado escrito.
  fs.mkdirSync(OUT, { recursive: true })
  const ppm = path.join(OUT, 'win-app.ppm')
  const shot = spawnSync('virsh', ['-c', 'qemu:///system', 'screenshot', 'win11', ppm], { encoding: 'utf8' })
  if (shot.status === 0) {
    spawnSync('convert', [ppm, path.join(OUT, 'win-app.png')])
    console.log('    captura: ' + path.join(OUT, 'win-app.png'))
  }
  ps('Stop-Process -Name dotrino-terminal-desktop -Force -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName DotrinoDesktopSmoke -Confirm:$false')
})

escenario('la ventana de la VM, por la tubería con nombre, ve al host', async () => {
  const r = await esperar(() => { const x = ps(`dotrino-terminal.cmd machines --name ${PERFIL} 2>&1`); return /escritorio/.test(x.out) ? x : null }, { timeoutMs: 60000, cada: 3000, que: () => 'que la VM vea al host\n' + ps(`dotrino-terminal.cmd machines --name ${PERFIL} 2>&1`).out + logVM() })
  console.log('    ' + r.out.trim().replace(/\r?\n/g, '\n    '))
  const rec = JSON.parse(ps(`Get-Content '${dirVM()}\\terminal.pipe'`).out.trim())
  assert.match(rec.pipe, /^\\\\\.\\pipe\\dotrino-terminal-[0-9a-f]{32}$/)
})

escenario('al iniciar sesión corre lo apuntado en la entrada de Run, tal cual', async () => {
  const entry = ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'DotrinoTerminalAgent-${PERFIL}'`).out.trim()
  console.log('    ' + entry)
  assert.match(entry, /supervise --name winvm$/)
  // Se para todo y se lanza esa línea como la lanzaría Windows al iniciar sesión: fuera de la
  // sesión SSH (por WMI), que al cerrarse mataría lo que se lanzara dentro. Así se prueba
  // también que `supervise` se vuelve a lanzar sin ventana y sale.
  const pids = () => ps(`'supervisor.pid','agent.pid' | ForEach-Object { Get-Content "${dirVM()}\\$_" -ErrorAction SilentlyContinue }`).out.trim().split(/\s+/).filter(Boolean)
  const antes = pids()
  ps(`foreach ($p in @(${antes.join(',')})) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; Remove-Item '${dirVM()}\\supervisor.pid' -ErrorAction SilentlyContinue`)
  await sleep(2000)
  bien(ps(`$c = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'DotrinoTerminalAgent-${PERFIL}'; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $c }; 'lanzado ' + $r.ReturnValue`), 'lanzar la entrada de Run')
  await esperar(() => /corriendo|running/.test(ps(`dotrino-terminal.cmd service status --name ${PERFIL} 2>&1`).out), { timeoutMs: 30000, cada: 2000, que: () => 'el supervisor tras el inicio de sesión\n' + logVM() })
  const despues = pids()
  assert.notDeepEqual(despues, antes, 'son los mismos procesos de antes')
  await esperar(async () => {
    const f = (await vistasDesdeB())?.list?.find((y) => y.name === 'windows-vm')
    return f && Array.isArray(f.consoles) ? f : null
  }, { timeoutMs: 90000, cada: 3000, que: () => 'que el host vuelva a ver la VM\n' + logVM() })
})

escenario('`service uninstall` lo quita y no queda ningún agente', async () => {
  const r = bien(ps(`dotrino-terminal.cmd service uninstall --name ${PERFIL} --yes 2>&1`), 'service uninstall')
  console.log('    ' + r.out.trim())
  assert.match(ps(`dotrino-terminal.cmd service status --name ${PERFIL} 2>&1`).out, /no tiene servicio|has no service/)
  await esperar(() => !/terminal-agent/.test(ps('Get-CimInstance Win32_Process -Filter "name=\'node.exe\'" | Select-Object -Expand CommandLine').out), { timeoutMs: 15000, que: 'que no quede ningún agente' })
})

console.log(`\nSMOKE · la terminal en Windows 11: agente ${INSTALLED ? 'ya instalado' : VERSION + ' de npm'}, servicio, PowerShell desde otra máquina\n`)
const parar = () => { try { b?.proc.kill('SIGTERM') } catch (_) {} }
try {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  console.log(`  proxy  ${proxy.url} (la VM lo ve en ws://${HOST}:${proxy.port})\n`)
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
