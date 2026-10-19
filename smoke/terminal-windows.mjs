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
import { scenario, runScenarios, startProxy, startVault, teardown, tmpDir, ROOT } from './lib/harness.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d }
const AGENT = path.join(ROOT, 'dotrino-terminal/agent')
const SSH_HOST = arg('--ssh', 'dotrino-win11')
const HOST = arg('--host', '192.168.122.1')
const VERSION = arg('--version', JSON.parse(fs.readFileSync(path.join(AGENT, 'package.json'), 'utf8')).version)
const PROFILE = 'winvm'
const INSTALLED = process.argv.includes('--installed')
const DESKTOP_ZIP = arg('--desktop') && path.resolve(arg('--desktop'))
const OUT = path.resolve(arg('--out') || tmpDir('win-screenshots'))

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
const mustPass = (r, what) => { assert.equal(r.status, 0, `${what}\n${r.out}`); return r }

const waitLong = (fn, o) => waitFor(fn, { timeoutMs: 60000, every: 1000, ...o })

async function link (name) {
  const { enroll } = await import(path.join(AGENT, 'link.js'))
  const dir = tmpDir('win-' + name)
  const qr = await vault.pair({ label: name })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  return dir
}

/** Las máquinas que ve B (el agente del host), por su socket local. */
async function seenFromB () {
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

const dirVM = () => `${home}\\.dotrino\\agent\\terminal-agent\\${PROFILE}`
const logVM = () => ps(`Get-Content -Tail 30 '${dirVM()}\\agent.log' -ErrorAction SilentlyContinue`).out

scenario('the VM has Node and no terminal agent running', async () => {
  const r = mustPass(ps('[Environment]::OSVersion.VersionString; node -v; $env:USERPROFILE'), 'log into the VM')
  const lines = r.out.trim().split(/\r?\n/)
  home = lines.at(-1).trim()
  console.log(`    ${lines[0]} · node ${lines[1]} · ${home}`)
  // Lo que haya dejado una pasada anterior, fuera: la prueba empieza de cero.
  ps(`dotrino-terminal.cmd service uninstall --name ${PROFILE} --yes 2>&1 | Out-Null; Remove-Item -Recurse -Force '${dirVM()}' -ErrorAction SilentlyContinue`)
  assert.doesNotMatch(ps('Get-CimInstance Win32_Process -Filter "name=\'node.exe\'" | Select-Object -Expand CommandLine').out, /terminal-agent/, 'a terminal agent is already running')
})

scenario(INSTALLED ? 'the agent the VM already has is on the PATH' : `npm installs @dotrino/terminal-agent@${VERSION} with its Windows PTY`, async () => {
  if (!INSTALLED) mustPass(ps(`npm install -g @dotrino/terminal-agent@${VERSION} 2>&1 | Select-Object -Last 3`, { timeout: 400000 }), 'npm install -g')
  const r = mustPass(ps('(Get-Command dotrino-terminal.cmd).Source; $null = dotrino-terminal-agent.cmd --help'), 'the commands on the PATH')
  console.log('    ' + r.out.trim().split(/\r?\n/)[0])
})

scenario('the profile gets linked and another machine (the host) starts', async () => {
  const dirA = await link('windows-vm')
  const dirB = await link('desktop')
  // Desde la VM el host es la puerta de la red de libvirt: el enlace apunta ahí.
  const link = JSON.parse(fs.readFileSync(path.join(dirA, 'link.json'), 'utf8'))
  link.proxy = `ws://${HOST}:${proxy.port}`
  fs.writeFileSync(path.join(dirA, 'link.json'), JSON.stringify(link, null, 2))
  mustPass(ps(`New-Item -ItemType Directory -Force '${dirVM()}' | Out-Null`), 'the profile folder')
  const dest = `${dirVM().replace(/\\/g, '/')}/`
  for (const f of fs.readdirSync(dirA).filter((x) => fs.statSync(path.join(dirA, x)).isFile())) {
    // scp va por SFTP: la ruta viaja tal cual, con sus espacios y sin comillas.
    const r = spawnSync('scp', ['-o', 'BatchMode=yes', path.join(dirA, f), `${SSH_HOST}:${dest}${f}`], { encoding: 'utf8' })
    assert.equal(r.status, 0, `copy ${f}: ${r.stderr}`)
  }
  const proc = spawn(process.execPath, [path.join(AGENT, 'bin/cli.js'), '--dir', dirB, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let output = ''
  proc.stdout.on('data', (d) => { output += d; log(`[B] ${String(d).trimEnd()}`) })
  proc.stderr.on('data', (d) => { output += d; log(`[B!] ${String(d).trimEnd()}`) })
  await waitLong(() => /máquina: /.test(output), { what: () => `B to start\n${output}` })
  b = { dir: dirB, proc }
})

scenario('`service install` from SSH: the agent keeps running after the session closes', async () => {
  const r = mustPass(ps(`dotrino-terminal.cmd service install --name ${PROFILE} 2>&1`), 'service install')
  console.log('    ' + r.out.trim().replace(/\r?\n/g, '\n    '))
  assert.match(r.out, /iniciar sesión en Windows|log in to Windows/)
  // Otra sesión SSH, la anterior ya cerrada: el supervisor y el agente tienen que seguir ahí.
  await sleep(3000)
  const st = await waitLong(() => { const x = ps(`dotrino-terminal.cmd service status --name ${PROFILE} 2>&1`); return /corriendo|running/.test(x.out) ? x : null }, { timeoutMs: 30000, every: 2000, what: () => 'the service running\n' + logVM() })
  console.log('    ' + st.out.trim())
})

scenario('the host sees the VM and opens PowerShell on it', async () => {
  await waitLong(async () => (await seenFromB())?.list?.find((y) => y.name === 'windows-vm'), { timeoutMs: 90000, every: 3000, what: () => 'the host to see the VM\n' + logVM() })
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(b.dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'via', machine: 'windows-vm' })
  c.send({ type: 'open', cols: 100, rows: 30 })
  await waitLong(() => got.find((m) => m.type === 'attached' || m.type === 'fail'), { what: 'a console to open on the VM' })
  assert.equal(got.find((m) => m.type === 'fail'), undefined, JSON.stringify(got.find((m) => m.type === 'fail')))
  c.send({ type: 'input', data: 'Write-Output "from-$(40+2)-$env:COMPUTERNAME"; $PSVersionTable.PSEdition\r' })
  const out = () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('')
  const m = await waitLong(() => /from-42-(\S+)/.exec(out()), { what: () => 'PowerShell to answer from the VM\n' + out() })
  console.log(`    PowerShell answered from ${m[1]}`)
  c.close()
})

if (DESKTOP_ZIP) scenario('the desktop app opens in the Windows session with the profile, and its console is PowerShell', async () => {
  const zip = path.basename(DESKTOP_ZIP)
  const tmp = `${home.replace(/\\/g, '/')}/AppData/Local/Temp/${zip}`
  const r = spawnSync('scp', ['-o', 'BatchMode=yes', DESKTOP_ZIP, `${SSH_HOST}:${tmp}`], { encoding: 'utf8' })
  assert.equal(r.status, 0, `copy the .zip: ${r.stderr}`)
  // Como la instalaría alguien: el .zip desempaquetado en sus programas de usuario.
  const exe = mustPass(ps(`$dst = "$env:LOCALAPPDATA\\Programs\\DotrinoTerminal"; Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue; Expand-Archive '${tmp}' $dst -Force; (Get-ChildItem $dst -Recurse -Filter dotrino-terminal-desktop.exe).FullName`), 'unpack').out.trim().split(/\r?\n/).at(-1)
  console.log('    ' + exe)
  // En la sesión gráfica del usuario (desde SSH no se ve nada): una tarea interactiva, ya.
  mustPass(ps(`$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '--name ${PROFILE}'; $p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive; Register-ScheduledTask -TaskName DotrinoDesktopSmoke -Action $a -Principal $p -Force | Out-Null; Start-ScheduledTask -TaskName DotrinoDesktopSmoke`), 'open the app in the session')
  // Su ventana engancha una consola del agente con la marca de la app (`desktop-<pid>-<n>`).
  const appConsole = await waitLong(async () => {
    const f = (await seenFromB())?.list?.find((y) => y.name === 'windows-vm')
    return f?.consoles?.find((c) => JSON.stringify(c.watchers || []).includes('"tag":"desktop-'))
  }, { timeoutMs: 60000, every: 2000, what: () => 'the app console\n' + ps('Get-Process dotrino-terminal-desktop -ErrorAction SilentlyContinue | Format-List Id,StartTime; Get-Content -Tail 20 "$env:USERPROFILE\\.config\\dotrino-terminal\\desktop.log" -ErrorAction SilentlyContinue').out + logVM() })
  // Desde la otra máquina se entra en ESA consola, la de la ventana, y contesta PowerShell.
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(b.dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'via', machine: 'windows-vm' })
  c.send({ type: 'attach', id: appConsole.id, cols: 100, rows: 30 })
  await waitLong(() => got.find((m) => m.type === 'attached' || m.type === 'fail'), { what: 'attaching to the app console' })
  assert.equal(got.find((m) => m.type === 'fail'), undefined, JSON.stringify(got.find((m) => m.type === 'fail')))
  c.send({ type: 'input', data: 'Write-Output "app-$(6*7)"\r' })
  const out = () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('')
  await waitLong(() => /app-42/.test(out()), { what: () => 'PowerShell to answer in the app console\n' + out() })
  c.close()
  await sleep(1500)
  // La pantalla de la VM, para mirarla: la app abierta con el resultado escrito.
  fs.mkdirSync(OUT, { recursive: true })
  const ppm = path.join(OUT, 'win-app.ppm')
  const shot = spawnSync('virsh', ['-c', 'qemu:///system', 'screenshot', 'win11', ppm], { encoding: 'utf8' })
  if (shot.status === 0) {
    spawnSync('convert', [ppm, path.join(OUT, 'win-app.png')])
    console.log('    screenshot: ' + path.join(OUT, 'win-app.png'))
  }
  ps('Stop-Process -Name dotrino-terminal-desktop -Force -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName DotrinoDesktopSmoke -Confirm:$false')
})

scenario('the VM window, through the named pipe, sees the host', async () => {
  const r = await waitLong(() => { const x = ps(`dotrino-terminal.cmd machines --name ${PROFILE} 2>&1`); return /desktop/.test(x.out) ? x : null }, { timeoutMs: 60000, every: 3000, what: () => 'the VM to see the host\n' + ps(`dotrino-terminal.cmd machines --name ${PROFILE} 2>&1`).out + logVM() })
  console.log('    ' + r.out.trim().replace(/\r?\n/g, '\n    '))
  const rec = JSON.parse(ps(`Get-Content '${dirVM()}\\terminal.pipe'`).out.trim())
  assert.match(rec.pipe, /^\\\\\.\\pipe\\dotrino-terminal-[0-9a-f]{32}$/)
})

scenario('at logon, exactly what the Run entry says gets run', async () => {
  const entry = ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'DotrinoTerminalAgent-${PROFILE}'`).out.trim()
  console.log('    ' + entry)
  assert.match(entry, /supervise --name winvm$/)
  // Se para todo y se lanza esa línea como la lanzaría Windows al iniciar sesión: fuera de la
  // sesión SSH (por WMI), que al cerrarse mataría lo que se lanzara dentro. Así se prueba
  // también que `supervise` se vuelve a lanzar sin ventana y sale.
  const pids = () => ps(`'supervisor.pid','agent.pid' | ForEach-Object { Get-Content "${dirVM()}\\$_" -ErrorAction SilentlyContinue }`).out.trim().split(/\s+/).filter(Boolean)
  const before = pids()
  ps(`foreach ($p in @(${before.join(',')})) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; Remove-Item '${dirVM()}\\supervisor.pid' -ErrorAction SilentlyContinue`)
  await sleep(2000)
  mustPass(ps(`$c = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'DotrinoTerminalAgent-${PROFILE}'; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $c }; 'launched ' + $r.ReturnValue`), 'launch the Run entry')
  await waitLong(() => /corriendo|running/.test(ps(`dotrino-terminal.cmd service status --name ${PROFILE} 2>&1`).out), { timeoutMs: 30000, every: 2000, what: () => 'the supervisor after logon\n' + logVM() })
  const after = pids()
  assert.notDeepEqual(after, before, 'they are the same processes as before')
  await waitLong(async () => {
    const f = (await seenFromB())?.list?.find((y) => y.name === 'windows-vm')
    return f && Array.isArray(f.consoles) ? f : null
  }, { timeoutMs: 90000, every: 3000, what: () => 'the host to see the VM again\n' + logVM() })
})

scenario('`service uninstall` removes it and no agent is left', async () => {
  const r = mustPass(ps(`dotrino-terminal.cmd service uninstall --name ${PROFILE} --yes 2>&1`), 'service uninstall')
  console.log('    ' + r.out.trim())
  assert.match(ps(`dotrino-terminal.cmd service status --name ${PROFILE} 2>&1`).out, /no tiene servicio|has no service/)
  await waitLong(() => !/terminal-agent/.test(ps('Get-CimInstance Win32_Process -Filter "name=\'node.exe\'" | Select-Object -Expand CommandLine').out), { timeoutMs: 15000, what: 'no agent to be left' })
})

console.log(`\nSMOKE · the terminal on Windows 11: agent ${INSTALLED ? 'already installed' : VERSION + ' from npm'}, service, PowerShell from another machine\n`)
const stop = () => { try { b?.proc.kill('SIGTERM') } catch (_) {} }
try {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  console.log(`  proxy  ${proxy.url} (the VM sees it at ws://${HOST}:${proxy.port})\n`)
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
