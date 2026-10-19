/**
 * LA APP DOTRINO (Android e iOS) CONTRA UNA BÓVEDA DE VERDAD, de punta a punta.
 *
 * Lo que prueba, en cada plataforma: la app abre la invitación de la bóveda, la bóveda aprueba el
 * código de seis dígitos que enseña la app, y en Pedidos la app aprueba una escritura (la bóveda
 * la guarda) y después un pedido de claves de un servicio (el servicio las recibe). Todo lo que
 * la app le manda a la bóveda va en binario (dotrino-native ≥ 0.42.0): si la bóveda no lo
 * entendiera, no contestaría y no saldría ningún pedido.
 *
 * Nació el 2026-10-19: la 0.4.25 salió probada solo con las pruebas de la librería, y el dueño:
 * «no se puede ir sin probar, para eso tienes dotrino test».
 *
 * Las piezas:
 *   · las bóvedas, en una caja (`dotrino-native/test-vectors/e2e-live.mjs`: A para Android, B
 *     para iOS), en el proxio de PRODUCCIÓN — la página de alta es https y no puede abrir un
 *     proxio local desde dentro de la app;
 *   · el código de seis dígitos: en iOS la prueba lo entrega por HTTP aquí (puerto 8778,
 *     `/code/B?c=…`); en Android lo escribe en el log (`dotrino-live`) y se lee con `adb logcat`,
 *     porque la app no permite HTTP en claro;
 *   · Android: el emulador (`adb`, solo un `emulator-*`: desinstala y reinstala la app), con la
 *     prueba instrumentada `LiveVaultTest` de dotrino-app — uiautomator no sirve, la pantalla de
 *     Pedidos nunca está en reposo;
 *   · iOS: el simulador de la Mac (`ssh dotrino-mac`), con `LiveVaultUITests` de dotrino-app. La
 *     Mac compila lo que esté EMPUJADO a dotrino-app (hace `git pull`).
 *
 *   npm run smoke:native-app                    (las dos plataformas)
 *   node smoke/native-app.mjs --android         (solo una: --android | --ios)  [--verbose]
 *
 * Variables: SMOKE_MAC (dotrino-mac), SMOKE_IOS_SIM (udid; si no, el primer iPhone disponible),
 * SMOKE_LAN_IP (la IP de esta máquina que ve la Mac; si no, la primera de la red local).
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { scenario, runScenarios, teardown } from './lib/harness.js'
import { ECO } from './lib/box.js'
import { waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const only = process.argv.includes('--android') ? 'android' : process.argv.includes('--ios') ? 'ios' : null
const MAC = process.env.SMOKE_MAC || 'dotrino-mac'
const PORT = 8778
const APP = path.join(ECO, 'dotrino-app')

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-native-app-'))
const has = (f) => fs.existsSync(path.join(out, f))
const read = (f) => fs.readFileSync(path.join(out, f), 'utf8').trim()
let box = null
let server = null

/** Corre un comando y devuelve su salida; si falla, lanza con lo que dijo. */
function run (cmd, args, { cwd, timeoutMs = 10 * 60_000 } = {}) {
  log(`$ ${cmd} ${args.join(' ').slice(0, 200)}`)
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  const text = (r.stdout || '') + (r.stderr || '')
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] || ''} failed (${r.status ?? r.signal}):\n${text.slice(-3000)}`)
  log(text.slice(-2000))
  return text
}

/** Runs a command WITHOUT blocking this process (the code server has to keep answering), and gives what it printed. */
function outputOf (cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    p.stdout.on('data', (b) => { text += b }); p.stderr.on('data', (b) => { text += b })
    p.on('close', () => resolve(text))
  })
}

/** The address of the default route: the bridges of VMs and containers also look «local». */
function lanIp () {
  if (process.env.SMOKE_LAN_IP) return process.env.SMOKE_LAN_IP
  const src = (spawnSync('ip', ['-4', 'route', 'get', '1.1.1.1'], { encoding: 'utf8' }).stdout || '').match(/ src ([\d.]+)/)
  if (!src) throw new Error('no LAN address for the Mac to reach this machine: set SMOKE_LAN_IP')
  return src[1]
}

/** Lo que pasa en la bóveda de una cuenta: enrolada, escritura guardada, claves entregadas. */
async function vaultSaw (name) {
  await waitFor(() => has(`written-${name}.txt`), { timeoutMs: 60_000, what: `the vault ${name} to store the approved write` })
  await waitFor(() => has(`read-done-${name}.txt`) || has(`read-denied-${name}.txt`), { timeoutMs: 60_000, what: `the service of ${name} to get its keys` })
  if (has(`read-denied-${name}.txt`)) throw new Error(`the key request of ${name} was denied: ${read(`read-denied-${name}.txt`)}`)
}

scenario('the vaults start in their box, and the code server', async () => {
  box = `smoke-native-app-${Date.now().toString(36)}`
  const child = spawn('docker', ['run', '--rm', '--name', box, '--network', 'host',
    '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp',
    '-v', `${ECO}:/eco:ro`, '-v', `${out}:/out`, '-w', '/eco',
    'node:22-bookworm-slim', 'node', 'dotrino-native/test-vectors/e2e-live.mjs', '/out'], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (b) => log('[vaults] ' + String(b).trim()))
  child.stderr.on('data', (b) => log('[vaults!] ' + String(b).trim()))
  await waitFor(() => has('invite-A.txt') && has('invite-B.txt'), { timeoutMs: 60_000, what: 'the invites of the two vaults' })

  // La app entrega aquí el código; y cuando la escritura de una cuenta queda guardada, se pide
  // la lectura del servicio de esa cuenta (el segundo pedido que la app aprueba).
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const m = u.pathname.match(/^\/code\/([AB])$/)
    const c = u.searchParams.get('c') || ''
    if (!m || !/^\d{6}$/.test(c)) { res.writeHead(400); res.end(); return }
    fs.writeFileSync(path.join(out, `code-${m[1]}.txt`), c)
    log(`[code] ${m[1]} ${c}`)
    res.writeHead(200); res.end('ok')
  }).listen(PORT, '0.0.0.0')
  const asked = new Set()
  setInterval(() => {
    for (const n of ['A', 'B']) {
      if (!asked.has(n) && has(`written-${n}.txt`)) { asked.add(n); fs.writeFileSync(path.join(out, `read-${n}.txt`), '') }
    }
  }, 300).unref()
})

if (only !== 'ios') {
  scenario('ANDROID: the app enrolls and approves a write and a key request', async () => {
    const serial = (run('adb', ['devices']).match(/^(emulator-\d+)\s+device$/m) || [])[1]
    if (!serial) throw new Error('no Android emulator running (adb devices): start the AVD dotrino-test')
    const adb = (...a) => run('adb', ['-s', serial, ...a])
    run('./gradlew', ['-q', ':app:assembleDebug', ':app:assembleDebugAndroidTest'], { cwd: path.join(APP, 'android') })
    run('./gradlew', ['-q', ':identity-app:assembleDebug'], { cwd: path.join(APP, 'native/android') })
    // Un emulador: lo instalado puede llevar otra firma (la de Play), y no se actualiza encima.
    for (const pkg of ['com.dotrino.app', 'com.dotrino.app.test', 'com.dotrino.identity']) spawnSync('adb', ['-s', serial, 'uninstall', pkg], { stdio: 'ignore' })
    adb('install', '-r', path.join(APP, 'native/android/identity-app/build/outputs/apk/debug/identity-app-debug.apk'))
    adb('install', '-r', path.join(APP, 'android/app/build/outputs/apk/debug/app-debug.apk'))
    adb('install', '-r', path.join(APP, 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'))
    adb('shell', 'pm', 'grant', 'com.dotrino.app', 'android.permission.POST_NOTIFICATIONS')
    adb('shell', 'input', 'keyevent', '82')
    // The app does not allow cleartext HTTP: the test logs the code and it is read from here.
    adb('logcat', '-c')
    const logcat = spawn('adb', ['-s', serial, 'logcat', '-s', 'dotrino-live:I'], { stdio: ['ignore', 'pipe', 'ignore'] })
    logcat.stdout.on('data', (b) => {
      const c = String(b).match(/code (\d{6})/)
      if (c && !has('code-A.txt')) { fs.writeFileSync(path.join(out, 'code-A.txt'), c[1]); log(`[code] A ${c[1]}`) }
    })
    const res = await outputOf('adb', ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'invite', `'${read('invite-A.txt')}'`,
      'com.dotrino.app.test/androidx.test.runner.AndroidJUnitRunner']).finally(() => logcat.kill())
    log(res)
    if (!/OK \(1 test\)/.test(res)) throw new Error('LiveVaultTest did not pass:\n' + res.slice(-3000))
    await vaultSaw('A')
  })
}

if (only !== 'android') {
  scenario('iOS: the app enrolls and approves a write and a key request', async () => {
    const ssh = (script) => run('ssh', [MAC, script])
    const sim = process.env.SMOKE_IOS_SIM ||
      (ssh('xcrun simctl list devices available | grep -m1 -oE "iPhone[^(]*\\(([0-9A-F-]{36})\\)" | grep -oE "[0-9A-F-]{36}"').trim())
    if (!sim) throw new Error(`no iPhone simulator on ${MAC}`)
    const dd = '~/dd-app-sim'
    ssh(`cd ~/src/dotrino-app && git pull -q --ff-only && cd ios && ~/tools/xcodegen/bin/xcodegen generate -q && ` +
      `(xcrun simctl boot ${sim} 2>/dev/null; true) && ` +
      `xcodebuild -project Dotrino.xcodeproj -scheme Dotrino -configuration Debug -destination 'id=${sim}' -derivedDataPath ${dd} build -quiet && ` +
      `xcrun simctl install ${sim} ${dd}/Build/Products/Debug-iphonesimulator/Dotrino.app`)
    // ASYNC on purpose: the test delivers the code to the server of THIS process while it runs,
    // and a spawnSync would keep Node from answering it.
    const text = await outputOf('ssh', [MAC, `cd ~/src/dotrino-app/ios && TEST_RUNNER_LIVE_INVITE='${read('invite-B.txt')}' ` +
      `TEST_RUNNER_LIVE_CODE_URL=http://${lanIp()}:${PORT}/code/B xcodebuild -project Dotrino.xcodeproj -scheme DotrinoUITests ` +
      `-destination 'id=${sim}' -derivedDataPath ${dd} -only-testing:DotrinoUITests/LiveVaultUITests test`])
    log(text.slice(-3000))
    if (!/\*\* TEST SUCCEEDED \*\*/.test(text)) {
      const why = text.split('\n').filter((l) => /SCREEN:|error:/.test(l)).join('\n')
      throw new Error('LiveVaultUITests did not pass:\n' + (why || text.slice(-3000)))
    }
    await vaultSaw('B')
  })
}

runScenarios().then((ok) => { process.exitCode = ok ? 0 : 1 }).finally(async () => {
  if (box) spawnSync('docker', ['rm', '-f', box], { stdio: 'ignore' })
  if (server) server.close()
  await teardown()
  fs.rmSync(out, { recursive: true, force: true })
})
