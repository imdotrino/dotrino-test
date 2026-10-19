/**
 * LA TERMINAL EN WINDOWS CON UNA CUENTA NORMAL Y UN REINICIO DE VERDAD. Lo que
 * `terminal-windows.mjs` no puede probar desde una sesión SSH de administrador:
 *
 *   1. una cuenta SIN administrador (`dtuser`, con Node en su carpeta) deja el agente como
 *      servicio de su usuario (por SSH no puede dejarlo corriendo ya, y lo tiene que decir);
 *   2. LA VM SE REINICIA y entra sola en esa cuenta: sin ninguna sesión SSH, el host ve la VM
 *      encendida, porque el agente lo levantó la entrada de `HKCU\…\Run`;
 *   3. la app se abre como con un doble clic (el Explorador, sin argumentos: elige el perfil sola),
 *      en esa sesión y sin elevar; su consola es PowerShell de `dtuser`;
 *   4. `desktop update` (lo que corre el menú «Actualizar») baja la release, la verifica y cambia el
 *      `.exe` MIENTRAS la app está abierta; la app vuelve a abrir con el nuevo.
 *
 * Toca la VM entera: la reinicia (cierra la sesión que hubiera) y al final deja el inicio de sesión
 * como estaba (`AutoAdminLogon` y usuario por defecto) y la vuelve a reiniciar.
 *
 * La VM es la `win11` de libvirt (memoria `dotrino-vm-win11`): `ssh dotrino-win11` es el
 * administrador, `ssh dotrino-win11-dt` la cuenta normal.
 *
 *   node smoke/terminal-windows-session.mjs --desktop <zip> [--current 0.2.72] [--out <carpeta>] [--verbose]
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
const ADMIN = 'dotrino-win11'
const USER = 'dotrino-win11-dt'
const USER_NAME = 'dtuser'
const USER_PASS = 'Xq7.Win2026'
const VM_IP = '192.168.122.198'
const HOST = '192.168.122.1'
const PROFILE = 'winvm'
const MACHINE = 'windows-dtuser'
const DESKTOP_ZIP = arg('--desktop') && path.resolve(arg('--desktop'))
const CURRENT = arg('--current', '0.2.72')
const OUT = path.resolve(arg('--out') || tmpDir('win-session'))
const HOME = `C:\\Users\\${USER_NAME}`
const DIR = `${HOME}\\.dotrino\\agent\\terminal-agent\\${PROFILE}`
const APP_DIR = `${HOME}\\Documents\\DotrinoTerminal`
const WINLOGON = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'

let proxy = null
let vault = null
let b = null
let exe = null
let winlogonBefore = null

/** PowerShell en la VM, como `quien` (ADMIN o USER). Codificado: sin comillas que escapar. */
function ps (account, script, { timeout = 120000 } = {}) {
  const full = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Continue'; $env:Path = "$env:USERPROFILE\\node;$env:Path"; $global:LASTEXITCODE=0; ${script}; exit $LASTEXITCODE`
  const enc = Buffer.from(full, 'utf16le').toString('base64')
  // El SSH de la VM a veces no contesta a tiempo (recién arrancada, o con mucho trabajo): se
  // reintenta lo que ni llegó a entrar (código 255), nunca una orden que sí corrió.
  let r
  for (let i = 0; i < 4; i++) {
    r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', account, `powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`], { encoding: 'utf8', timeout })
    if (r.status !== 255) break
    spawnSync('sleep', ['5'])
  }
  // Lo que PowerShell manda por stderr llega en CLIXML: se saca el texto de sus errores.
  const errs = [...String(r.stderr || '').matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1].replace(/_x000D__x000A_/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('')
  const out = `${r.stdout || ''}${String(r.stderr || '').replace(/#< CLIXML\r?\n?/g, '').replace(/<Objs[\s\S]*?<\/Objs>/g, '')}${errs}`
  log(`[${account}] > ${script}\n${out}`)
  return { ...r, out }
}
const check = (r, what) => { assert.equal(r.status, 0, `${what}\n${r.out}`); return r }

const waitLong = (fn, o) => waitFor(fn, { timeoutMs: 60000, every: 1000, ...o })

const sshOpen = () => new Promise((resolve) => {
  const s = net.connect(22, VM_IP)
  let done = false
  const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v) } }
  s.once('data', (d) => finish(/^SSH-/.test(String(d))))
  s.once('error', () => finish(false))
  setTimeout(() => finish(false), 2000)
})

async function linkDevice (name) {
  const { enroll } = await import(path.join(AGENT, 'link.js'))
  const dir = tmpDir('win-' + name)
  const qr = await vault.pair({ label: name })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  return dir
}

/** Lo que B (el agente del host) sabe de la VM: su ficha, con sus consolas. */
async function findVm () {
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(b.dir)
  const r = await new Promise((resolve) => {
    c.on('message', (m) => { if (m.type === 'machines' || m.type === 'fail') resolve(m) })
    c.send({ type: 'machines' })
    setTimeout(() => resolve(null), 20000)
  })
  c.close()
  return r?.list?.find((y) => y.name === MACHINE) || null
}

/** Desde el host, en esa consola de la VM: escribe `input` y espera `re` en lo que salga. */
async function inConsole (id, input, re) {
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(b.dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'via', machine: MACHINE })
  c.send({ type: 'attach', id, cols: 110, rows: 30 })
  await waitLong(() => got.find((m) => m.type === 'attached' || m.type === 'fail'), { what: 'attaching to the console' })
  assert.equal(got.find((m) => m.type === 'fail'), undefined, JSON.stringify(got.find((m) => m.type === 'fail')))
  c.send({ type: 'input', data: input + '\r' })
  const out = () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('')
  const m = await waitLong(() => re.exec(out()), { what: () => `the console to answer\n${out()}` })
  c.close()
  return m
}

/** La consola que mira la ventana de la app (`desktop-<pid>-<n>`), si hay. */
const appConsole = (vm) => vm?.consoles?.find((c) => JSON.stringify(c.watchers || []).includes('"tag":"desktop-'))

function screenshot (name) {
  fs.mkdirSync(OUT, { recursive: true })
  const ppm = path.join(OUT, `${name}.ppm`)
  if (spawnSync('virsh', ['-c', 'qemu:///system', 'screenshot', 'win11', ppm]).status !== 0) return
  spawnSync('convert', [ppm, path.join(OUT, `${name}.png`)])
  console.log('    screenshot: ' + path.join(OUT, `${name}.png`))
}

/**
 * La app, como la abre un doble clic: el Explorador la lanza en la sesión de `dtuser`, sin
 * argumentos y sin elevar. La tarea la crea el administrador (con el token de la sesión de
 * `dtuser`): a una cuenta normal por SSH Windows le niega WMI, que es lo que usan los cmdlets de
 * tareas, y `schtasks` no le resuelve su propio usuario. En XML, para que la ruta con espacios no
 * pierda las comillas por el camino.
 */
function openAsDoubleClick () {
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="Author"><UserId>$env:COMPUTERNAME\\${USER_NAME}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>explorer.exe</Command><Arguments>"${exe}"</Arguments></Exec></Actions>
</Task>`
  check(ps(ADMIN, `$f = "$env:TEMP\\double-click.xml"; Set-Content -Path $f -Encoding Unicode -Value @"\n${xml}\n"@; schtasks.exe /Create /TN DotrinoDoubleClick /XML $f /F | Out-Null; schtasks.exe /Run /TN DotrinoDoubleClick | Out-Null`), 'open the app from Explorer')
}

scenario('a non-admin account, with Node in its folder and the npm agent', async () => {
  const r = check(ps(USER, 'whoami; ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); node -v; (Get-Command dotrino-terminal.cmd).Source'), 'sign in as the normal account')
  const [who, admin, node, cmd] = r.out.trim().split(/\r?\n/).map((l) => l.trim())
  console.log(`    ${who} · admin: ${admin} · node ${node} · ${cmd}`)
  assert.equal(admin, 'False', 'the test account must not be an administrator')
  // De cero: ni servicio ni carpeta del perfil de una pasada anterior.
  ps(USER, `dotrino-terminal.cmd service uninstall --name ${PROFILE} --yes 2>&1 | Out-Null; Remove-Item -Recurse -Force '${DIR}' -ErrorAction SilentlyContinue`)
})

scenario('the profile is linked and stays as a service of that account', async () => {
  const dirA = await linkDevice(MACHINE)
  const dirB = await linkDevice('desktop')
  const link = JSON.parse(fs.readFileSync(path.join(dirA, 'link.json'), 'utf8'))
  link.proxy = `ws://${HOST}:${proxy.port}`
  fs.writeFileSync(path.join(dirA, 'link.json'), JSON.stringify(link, null, 2))
  check(ps(USER, `New-Item -ItemType Directory -Force '${DIR}' | Out-Null`), 'the profile folder')
  for (const f of fs.readdirSync(dirA).filter((x) => fs.statSync(path.join(dirA, x)).isFile())) {
    const r = spawnSync('scp', ['-o', 'BatchMode=yes', path.join(dirA, f), `${USER}:${DIR.replace(/\\/g, '/')}/${f}`], { encoding: 'utf8' })
    assert.equal(r.status, 0, `copy ${f}: ${r.stderr}`)
  }
  const proc = spawn(process.execPath, [path.join(AGENT, 'bin/cli.js'), '--dir', dirB, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let output = ''
  proc.stdout.on('data', (d) => { output += d; log(`[B] ${String(d).trimEnd()}`) })
  proc.stderr.on('data', (d) => { output += d; log(`[B!] ${String(d).trimEnd()}`) })
  await waitLong(() => /máquina: /.test(output), { what: () => `B to start\n${output}` })
  b = { dir: dirB, proc }
  const r = check(ps(USER, `dotrino-terminal.cmd service install --name ${PROFILE}`), 'service install')
  console.log('    ' + r.out.trim().replace(/\r?\n/g, '\n    '))
  // Una cuenta normal no puede dejarlo corriendo desde SSH (WMI le dice que no): tiene que
  // decirlo, con la entrada de Run ya puesta. Lo levanta el inicio de sesión del reinicio.
  assert.match(r.out, /próxima vez que inicies sesión|next time you log in/)
  assert.match(check(ps(USER, `(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'DotrinoTerminalAgent-${PROFILE}'`), 'the Run entry').out, /supervise --name winvm/)
})

scenario('the app, unpacked into that account\'s Documents', async () => {
  assert.ok(DESKTOP_ZIP, 'missing --desktop <zip>')
  const tmp = `${HOME.replace(/\\/g, '/')}/AppData/Local/Temp/${path.basename(DESKTOP_ZIP)}`
  const r = spawnSync('scp', ['-o', 'BatchMode=yes', DESKTOP_ZIP, `${USER}:${tmp}`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  exe = check(ps(USER, `Remove-Item -Recurse -Force '${APP_DIR}' -ErrorAction SilentlyContinue; Expand-Archive '${tmp}' '${APP_DIR}' -Force; (Get-ChildItem '${APP_DIR}' -Recurse -Filter dotrino-terminal-desktop.exe).FullName`), 'unpack').out.trim().split(/\r?\n/).at(-1)
  console.log('    ' + exe)
})

scenario('THE VM REBOOTS and signs into that account by itself: the host sees it without any SSH session', async () => {
  // Lo de antes, para dejarlo igual al final.
  winlogonBefore = JSON.parse(check(ps(ADMIN, `Get-ItemProperty '${WINLOGON}' | Select-Object AutoAdminLogon,DefaultUserName,DefaultDomainName | ConvertTo-Json -Compress`), 'read the sign-in settings').out.trim().split(/\r?\n/).at(-1))
  check(ps(ADMIN, `Set-ItemProperty '${WINLOGON}' AutoAdminLogon '1'; Set-ItemProperty '${WINLOGON}' DefaultUserName '${USER_NAME}'; Set-ItemProperty '${WINLOGON}' DefaultDomainName '.'; Set-ItemProperty '${WINLOGON}' DefaultPassword '${USER_PASS}'`), 'auto sign-in to the normal account')
  ps(ADMIN, 'shutdown.exe /r /t 0 /f', { timeout: 15000 })
  await waitLong(async () => !(await sshOpen()), { timeoutMs: 90000, what: 'the VM to shut down' })
  // Ni una sesión SSH desde aquí hasta que el host la vea: lo único que habla con la VM es el proxio.
  const t0 = Date.now()
  const vm = await waitLong(async () => { const f = await findVm(); return f && Array.isArray(f.consoles) ? f : null }, { timeoutMs: 300000, every: 5000, what: 'the VM agent to come back by itself after the reboot' })
  console.log(`    the host sees ${vm.name} (${vm.id}) ${Math.round((Date.now() - t0) / 1000)} s after shutting down, without SSH`)
  const r = ps(ADMIN, `query user; Get-CimInstance Win32_Process -Filter "name='node.exe'" | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; '{0} {1}' -f $o.User, ($_.CommandLine -replace '.*bin\\\\', '') }`)
  console.log('    ' + r.out.trim().replace(/\r?\n/g, '\n    '))
  assert.match(r.out, /dtuser\s+console\s+\d+\s+(Activo|Active)/i, 'the normal account is not on the console')
  assert.match(r.out, /dtuser cli\.js"? supervise --name winvm/, 'the supervisor does not belong to the normal account')
})

scenario('a double click opens the app in that session, unelevated, and its console is that account\'s PowerShell', async () => {
  openAsDoubleClick()
  const vm = await waitLong(async () => { const f = await findVm(); return appConsole(f) ? f : null }, { timeoutMs: 60000, every: 2000, what: () => 'the app console\n' + ps(USER, 'Get-Process dotrino-terminal-desktop -ErrorAction SilentlyContinue | Format-List Id,StartTime; Get-Content -Tail 20 "$env:USERPROFILE\\.config\\dotrino-terminal\\desktop.log" -ErrorAction SilentlyContinue').out })
  const c = appConsole(vm)
  const m = await inConsole(c.id, 'Write-Output ("who=" + [Environment]::UserName + " admin=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) + " " + $PSVersionTable.PSEdition)', /who=(\S+) admin=(\S+) (\S+)/)
  console.log(`    the app console: ${m[0]}`)
  assert.equal(m[1], USER_NAME)
  assert.equal(m[2], 'False')
  await sleep(1500)
  screenshot('win-double-click')
})

scenario('«Update» swaps the .exe with the app open, verified, and the app reopens with the new one', async () => {
  const before = ps(USER, `(Get-FileHash '${exe}').Hash`).out.trim().split(/\r?\n/).at(-1)
  // Lo mismo que corre el menú «Actualizar» de la app, con la app abierta (su `.exe` en uso).
  const r = ps(USER, `dotrino-terminal.cmd desktop update --current ${CURRENT} --exe '${exe}'`, { timeout: 300000 })
  console.log('    ' + r.out.trim().replace(/\r?\n/g, '\n    '))
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /Firmado por la release|Signed by the release/, 'it did not say it verified the signature')
  assert.match(r.out, /Instalada la|Installed/)
  const state = ps(USER, `Test-Path '${exe}.old'; (Get-FileHash '${exe}').Hash; (Get-Process dotrino-terminal-desktop -ErrorAction SilentlyContinue).Path`).out.trim().split(/\r?\n/)
  console.log(`    .exe.old: ${state[0]} · the open app keeps running from: ${state[2] || '(none)'}`)
  assert.equal(state[0], 'True', 'the old .exe was not moved aside')
  assert.ok(state[1] && before, 'no hash of the .exe')
  // Se cierra y se vuelve a abrir, como haría quien la usa: arranca la nueva.
  ps(USER, 'Stop-Process -Name dotrino-terminal-desktop -Force -ErrorAction SilentlyContinue')
  await waitLong(async () => !appConsole(await findVm()), { timeoutMs: 30000, every: 2000, what: 'the app console to be released' })
  openAsDoubleClick()
  await waitLong(async () => appConsole(await findVm()), { timeoutMs: 60000, every: 2000, what: 'the new app to be open' })
  const started = ps(USER, 'Get-Content -Tail 3 "$env:USERPROFILE\\.config\\dotrino-terminal\\desktop.log"').out
  console.log('    ' + started.trim().split(/\r?\n/).filter((l) => /start/.test(l)).at(-1))
  await sleep(1500)
  screenshot('win-after-update')
})

/** Deja la VM como estaba: sin la app ni el servicio, y el inicio de sesión de antes. */
async function cleanUp () {
  if (!(await sshOpen())) return
  ps(USER, `Stop-Process -Name dotrino-terminal-desktop -Force -ErrorAction SilentlyContinue; dotrino-terminal.cmd service uninstall --name ${PROFILE} --yes 2>&1 | Out-Null`)
  ps(ADMIN, 'schtasks.exe /Delete /TN DotrinoDoubleClick /F 2>$null | Out-Null')
  if (!winlogonBefore) return
  ps(ADMIN, `Set-ItemProperty '${WINLOGON}' AutoAdminLogon '${winlogonBefore.AutoAdminLogon ?? '0'}'; Set-ItemProperty '${WINLOGON}' DefaultUserName '${winlogonBefore.DefaultUserName ?? ''}'; Set-ItemProperty '${WINLOGON}' DefaultDomainName '${winlogonBefore.DefaultDomainName ?? '.'}'; Remove-ItemProperty '${WINLOGON}' DefaultPassword -ErrorAction SilentlyContinue`)
  // Y se reinicia: la sesión de la cuenta de prueba no se queda abierta.
  ps(ADMIN, 'shutdown.exe /r /t 0 /f', { timeout: 15000 })
  console.log(`  the VM goes back to its previous sign-in (AutoAdminLogon=${winlogonBefore.AutoAdminLogon}, ${winlogonBefore.DefaultUserName}) and reboots`)
}

console.log('\nSMOKE · the terminal on Windows: normal account, real reboot, double click and app update\n')
const stop = () => { try { b?.proc.kill('SIGTERM') } catch (_) {} }
try {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  console.log(`  proxy  ${proxy.url} (the VM sees it at ws://${HOST}:${proxy.port})\n`)
  const ok = await runScenarios()
  await cleanUp()
  stop()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { await cleanUp() } catch (_) {}
  stop()
  await teardown()
  process.exit(1)
}
