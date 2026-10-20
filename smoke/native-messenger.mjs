/**
 * MESSENGER NATIVO CONTRA LA PWA DE PRODUCCIÓN, la vuelta entera.
 *
 * Un usuario web (messenger.dotrino.com en un Chromium sin ventana) enseña su código; la app
 * nativa lo canjea y le pide contacto; la web acepta; la app escribe y la web contesta. Lo que
 * la app manda va en binario (dotrino-native ≥ 0.42.0) y sellado: si la PWA no lo abriera, no
 * llegaría la solicitud ni el mensaje.
 *
 * Nació el 2026-10-19, al subir messenger a dotrino-native v0.42.0: la prueba de interfaz de iOS
 * (`RoundTripUITests`) ya existía, pero el script que hacía de «la web» no estaba en ningún repo.
 *
 * ESTADO (2026-10-19): la solicitud llega y la web acepta, pero el mensaje del iPhone a la web casi
 * nunca llega (11 de 11 con dotrino-native 0.42, 2 de 3 también con 0.39: no lo trajo el binario).
 * En Android, a mano, sí llega. Pendiente en PENDIENTES.md («Messenger iOS: el DM a la PWA»).
 *
 *   npm run smoke:native-messenger          (iOS: el simulador de la Mac)  [--verbose] [--headed]
 *
 * La Mac compila lo que esté EMPUJADO a dotrino-messenger (hace `git pull`). Variables:
 * SMOKE_MAC (dotrino-mac), SMOKE_IOS_SIM (udid; si no, el primer iPhone disponible).
 */
import { spawn, spawnSync } from 'node:child_process'
import { chromium } from 'playwright'
import { scenario, runScenarios, teardown } from './lib/harness.js'
import { waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const MAC = process.env.SMOKE_MAC || 'dotrino-mac'
const PWA = 'https://messenger.dotrino.com/'
const FROM_PHONE = 'hola desde ios'
const FROM_WEB = 'hola ios, te leo desde la web'

let browser = null
let page = null

function run (cmd, args, { timeoutMs = 10 * 60_000 } = {}) {
  log(`$ ${cmd} ${args.join(' ').slice(0, 200)}`)
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  const text = (r.stdout || '') + (r.stderr || '')
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status ?? r.signal}):\n${text.slice(-3000)}`)
  return text
}

/** Without blocking: the web side has to keep acting while the phone's test runs. */
function outputOf (cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    p.stdout.on('data', (b) => { text += b }); p.stderr.on('data', (b) => { text += b })
    p.on('close', () => resolve(text))
  })
}

scenario('the web user opens the PWA and shows its code', async () => {
  // SMOKE_NO_DIRECT=1: the browser cannot open a direct channel (no UDP), everything goes by the proxy.
  const args = process.env.SMOKE_NO_DIRECT ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []
  browser = await chromium.launch({ headless: !process.argv.includes('--headed'), args })
  page = await (await browser.newContext({ locale: 'es-ES' })).newPage()
  // --verbose: every frame the web gets from the proxy (binary: its header), to see what arrives.
  if (VERBOSE) {
    // And what arrives through a direct channel (WebRTC), seen from inside the page.
    await page.addInitScript(() => {
      const Orig = window.RTCPeerConnection
      window.RTCPeerConnection = function (...a) {
        const pc = new Orig(...a)
        const watch = (dc) => dc.addEventListener('message', (ev) => {
          const d = ev.data
          console.log(`[dc<] ${typeof d === 'string' ? 'text ' + d.length : (d instanceof ArrayBuffer ? 'arraybuffer ' + d.byteLength : 'other ' + Object.prototype.toString.call(d))}`)
        })
        pc.addEventListener('datachannel', (ev) => { console.log('[dc] opened by the peer'); watch(ev.channel) })
        const create = pc.createDataChannel.bind(pc)
        pc.createDataChannel = (...b) => { const dc = create(...b); console.log('[dc] opened here'); watch(dc); return dc }
        return pc
      }
      window.RTCPeerConnection.prototype = Orig.prototype
    })
    page.on('console', (m) => { if (/^\[dc/.test(m.text())) log(m.text()) })
    page.on('websocket', (ws) => ws.on('framereceived', (f) => {
      const p = f.payload
      if (typeof p === 'string') { if (!/"type":"(pong|ping)"/.test(p)) log(`[ws<] text ${p.slice(0, 160)}`); return }
      const b = Buffer.from(p)
      const len = b.length >= 5 ? b.readUInt32BE(1) : 0
      log(`[ws<] binary ${b.length} B ${b.subarray(5, 5 + Math.min(len, 200)).toString()}`)
    }))
  }
  await page.goto(PWA)
  // A new browser always asks for the nickname first (and takes a few seconds to: it creates
  // the identity before).
  const nick = page.getByTestId('nickname-input')
  await nick.waitFor({ timeout: 60_000 })
  await nick.fill('Web_Smoke')
  await page.getByTestId('nickname-submit').click()
  await page.getByTestId('add-contact').click()
  await waitFor(async () => /^[A-Z0-9]{6}$/.test((await page.getByTestId('my-code').textContent().catch(() => '') || '').trim()),
    { timeoutMs: 60_000, what: 'the pairing code of the web user' })
})

/** The add-contact dialog and the tutorial bubbles cover the inbox: out of the way, or Accept is never reached. */
async function clearTheWay () {
  for (const skip of ['Saltar', 'Skip']) {
    const b = page.getByText(skip, { exact: true })
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {})
  }
  const close = page.getByTestId('close-add')
  if (await close.isVisible().catch(() => false)) await close.click()
}

scenario('iOS: the app asks for contact, the web accepts, and a message goes each way', async () => {
  const code = (await page.getByTestId('my-code').textContent()).trim()
  log(`[web] code ${code}`)
  const ssh = (script) => run('ssh', [MAC, script])
  const sim = process.env.SMOKE_IOS_SIM ||
    ssh('xcrun simctl list devices available | grep -m1 -oE "iPhone[^(]*\\(([0-9A-F-]{36})\\)" | grep -oE "[0-9A-F-]{36}"').trim()
  if (!sim) throw new Error(`no iPhone simulator on ${MAC}`)
  const dd = '~/dd-messenger-sim'
  // SMOKE_NO_PULL=1: test what is in the Mac's checkout as it is (another dotrino-native, say).
  const pull = process.env.SMOKE_NO_PULL ? 'true' : 'git pull -q --ff-only && git submodule update -q --init'
  ssh(`cd ~/src/dotrino-messenger && ${pull} && cd ios && ~/tools/xcodegen/bin/xcodegen generate -q && (xcrun simctl boot ${sim} 2>/dev/null; true) && ` +
    // From scratch: a contact left by an earlier run would be tapped instead of the new one.
    `(xcrun simctl uninstall ${sim} com.dotrino.messenger 2>/dev/null; true)`)
  const phone = outputOf('ssh', [MAC, `cd ~/src/dotrino-messenger/ios && TEST_RUNNER_PWA_CODE=${code} TEST_RUNNER_PWA_NICK=Web_Smoke xcodebuild -project Messenger.xcodeproj ` +
    `-scheme Messenger -destination 'id=${sim}' -derivedDataPath ${dd} -only-testing:MessengerUITests/RoundTripUITests test`])

  // The two halves at once: whichever fails first stops the scenario, and the phone's own
  // lines go in the error (they are what explains a web side that waited for nothing).
  const lines = (t) => t.split('\n').filter((l) => /error:|SCREEN|TEST (SUCCEEDED|FAILED)/.test(l)).join('\n') || t.slice(-3000)
  const phoneDone = phone.then((t) => {
    log(t.slice(-3000))
    if (!/\*\* TEST SUCCEEDED \*\*/.test(t)) throw new Error('RoundTripUITests did not pass:\n' + lines(t))
  })
  const webDone = webSide().catch(async (e) => {
    const shot = `/tmp/smoke-native-messenger-${Date.now()}.png`
    await page.screenshot({ path: shot }).catch(() => {})
    const t = await Promise.race([phone, new Promise((r) => setTimeout(() => r('(the phone test is still running)'), 5000))])
    throw new Error(`${e.message}\n(the web, at that moment: ${shot})\n--- the phone's test:\n${lines(t)}`)
  })
  try {
    await Promise.all([webDone, phoneDone])
  } catch (e) {
    const shot = `/tmp/smoke-native-messenger-${Date.now()}.png`
    await page.screenshot({ path: shot }).catch(() => {})
    throw new Error(`${e.message}\n(the web, at the end: ${shot})`)
  }
})

async function webSide () {
  await clearTheWay()
  await page.getByTestId('accept-request').waitFor({ timeout: 8 * 60_000 })
  await clearTheWay()
  await page.getByTestId('accept-request').click()
  log('[web] accepted')
  await page.getByTestId('contact-item').first().click({ timeout: 60_000 })
  // In the bubbles: the same text is also in the contact's preview and in the arrival notice.
  await page.getByTestId('msg-text').filter({ hasText: FROM_PHONE }).first().waitFor({ timeout: 4 * 60_000 })
  log('[web] got the message')
  await page.getByTestId('composer-input').fill(FROM_WEB)
  await page.getByTestId('send-message').click()
}

runScenarios().then((ok) => { process.exitCode = ok ? 0 : 1 }).finally(async () => {
  if (browser) await browser.close().catch(() => {})
  await teardown()
})
