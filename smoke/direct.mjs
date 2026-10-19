/**
 * DOS MÁQUINAS EN LA MISMA RED SE HABLAN DIRECTO, SIN PASAR POR EL PROXIO.
 *
 * Es el escalón 2 de la regla del transporte (`CLAUDE.md`): socket local → **WebRTC
 * directo** → WebRTC por TURN → proxio, y el proxio el último.
 *
 * Hasta el 2026-09-03 ese escalón no existía en Node —no hay `RTCPeerConnection`— así que
 * dos servicios del dueño en la misma red se hablaban dando la vuelta por internet. El
 * pilar ahora carga una implementación en JavaScript puro (`werift`), y eso es lo que esto
 * comprueba: no que la librería funcione, sino que **el mensaje deja de pasar por el
 * proxio** cuando puede ir directo.
 *
 * Dos cajas, que es el punto entero: en un solo proceso esto no prueba nada.
 *   · `nodo-a` y `nodo-b` — dos máquinas, con el proxio del banco de pruebas en medio
 *     SOLO para presentarse.
 *
 *   node smoke/direct.mjs            (necesita Docker: sin dos cajas no hay dos máquinas)
 *   node smoke/direct.mjs --verbose
 */
import assert from 'node:assert/strict'
import { scenario, runScenarios, startProxy, teardown } from './lib/harness.js'
import { createBox, destroyBoxes, pickEngine } from './lib/box.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
import { sleep } from './lib/wait.js'

let proxy = null
const boxes = {}

/**
 * El guion que corre DENTRO de cada caja. Se cuenta lo que sale por el proxio envolviendo
 * su `_sendRaw`: es la única medida que responde la pregunta de verdad —«¿pasó por ahí?»—
 * en vez de fiarse de una bandera.
 */
const SCRIPT = `
import { WebSocketProxyClient } from '/eco/dotrino-proxy-client/src/client.js'
import { loadNodePeerConnection } from '/eco/dotrino-proxy-client/src/webrtc.js'

const [,, url, role, other] = process.argv
const hasWebRTC = !!(await loadNodePeerConnection())
console.log('WEBRTC=' + hasWebRTC)

const c = new WebSocketProxyClient({ url, enableWebRTC: true, autoReconnect: false })
let viaProxy = 0
const raw = c._sendRaw.bind(c)
c._sendRaw = (env) => { if (env?.message) viaProxy++; return raw(env) }

const token = await c.connect()
console.log('TOKEN=' + token)

if (role === 'b') {
  c.on('message', (_f, p) => console.log('RECEIVED=' + JSON.stringify(p)))
  setInterval(() => {}, 1000)
} else {
  // Esperar a que el otro exista antes de hablarle.
  await new Promise((r) => setTimeout(r, 4000))
  c.send(other, { n: 1 })
  console.log('SENT=1 viaProxy=' + viaProxy)
  // El canal directo se pidió solo al mandar el primero.
  for (let i = 0; i < 80 && !c.isWebRTCOpen(other); i++) await new Promise((r) => setTimeout(r, 500))
  console.log('DIRECT=' + c.isWebRTCOpen(other))
  const before = viaProxy
  c.send(other, { n: 2 })
  console.log('SENT=2 newViaProxy=' + (viaProxy - before))
  setInterval(() => {}, 1000)
}
`

function box (name) {
  const c = createBox(name)
  const output = []
  boxes[name] = { box: c, output }
  c.write('/data/node.mjs', SCRIPT)
  return boxes[name]
}

const launch = (n, role, other = '') => {
  const b = boxes[n]
  b.box.launch(`node /data/node.mjs ${proxy.url} ${role} ${other}`, {
    env: { HOME: '/data' },
    onLine: (l) => { b.output.push(l.trim()); log(`[${n}] ` + l) }
  })
}

const waitForLine = async (b, re, what, ms = 60000) => {
  const t = Date.now() + ms
  while (Date.now() < t) {
    const l = b.output.find((x) => re.test(x))
    if (l) return re.exec(l)
    await sleep(200)
  }
  throw new Error('timed out waiting for ' + what + '\n  output:\n    ' + b.output.join('\n    '))
}

scenario('two Node machines, and both have WebRTC', async () => {
  if (pickEngine() !== 'docker') {
    throw new Error('this needs Docker: in local boxes both «nodes» share a machine and it would prove nothing')
  }
  proxy = await startProxy({ log })
  const a = box('node-a')
  const b = box('node-b')
  launch('node-b', 'b')
  const tb = (await waitForLine(b, /^TOKEN=(.+)$/, "B's token"))[1]
  launch('node-a', 'a', tb)
  await waitForLine(a, /^TOKEN=/, "A's token")

  for (const [n, c] of [['node-a', a], ['node-b', b]]) {
    const m = await waitForLine(c, /^WEBRTC=(\w+)$/, 'whether ' + n + ' has WebRTC')
    assert.equal(m[1], 'true', n + ' must be able to speak WebRTC in Node')
  }
})

scenario('the FIRST message goes through the proxy: nothing waits for negotiation', async () => {
  const m = await waitForLine(boxes['node-a'], /^SENT=1 viaProxy=(\d+)$/, 'the first send')
  assert.equal(m[1], '1', 'it went through the proxy, which is what is available at that moment')
  const r = await waitForLine(boxes['node-b'], /^RECEIVED=(.+)$/, 'B to receive it')
  assert.deepEqual(JSON.parse(r[1]), { n: 1 })
})

/**
 * EL ESCALÓN QUE ANTES NO EXISTÍA. Y la medida que importa no es «el canal está abierto»
 * sino que **el mensaje ya no pasa por el proxio**: lo primero podría ser cierto y lo
 * segundo no si el enrutado se rompiera.
 */
scenario('and the SECOND one goes direct, without touching the proxy', async () => {
  const opened = await waitForLine(boxes['node-a'], /^DIRECT=(\w+)$/, 'the direct channel to open')
  assert.equal(opened[1], 'true', 'the direct channel opens ON ITS OWN, without anyone asking')

  const m = await waitForLine(boxes['node-a'], /^SENT=2 newViaProxy=(\d+)$/, 'the second send')
  assert.equal(m[1], '0', 'the second message did NOT go through the proxy')

  const received = boxes['node-b'].output.filter((l) => l.startsWith('RECEIVED='))
  await waitForLine(boxes['node-b'], /^RECEIVED=.*"n":2/, 'B to receive the second one')
  assert.ok(received.length >= 1, 'and it still arrived, by the other path')
})

await runScenarios()
destroyBoxes()
await teardown()
