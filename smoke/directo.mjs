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
 *   node smoke/directo.mjs            (necesita Docker: sin dos cajas no hay dos máquinas)
 *   node smoke/directo.mjs --verbose
 */
import assert from 'node:assert/strict'
import { escenario, correr, startProxy, teardown } from './lib/harness.js'
import { crearCaja, destruirCajas, elegirMotor } from './lib/caja.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let proxy = null
const cajas = {}

/**
 * El guion que corre DENTRO de cada caja. Se cuenta lo que sale por el proxio envolviendo
 * su `_sendRaw`: es la única medida que responde la pregunta de verdad —«¿pasó por ahí?»—
 * en vez de fiarse de una bandera.
 */
const GUION = `
import { WebSocketProxyClient } from '/eco/dotrino-proxy-client/src/client.js'
import { loadNodePeerConnection } from '/eco/dotrino-proxy-client/src/webrtc.js'

const [,, url, rol, otro] = process.argv
const hayWebRTC = !!(await loadNodePeerConnection())
console.log('WEBRTC=' + hayWebRTC)

const c = new WebSocketProxyClient({ url, enableWebRTC: true, autoReconnect: false })
let porProxio = 0
const raw = c._sendRaw.bind(c)
c._sendRaw = (env) => { if (env?.message) porProxio++; return raw(env) }

const token = await c.connect()
console.log('TOKEN=' + token)

if (rol === 'b') {
  c.on('message', (_f, p) => console.log('RECIBIDO=' + JSON.stringify(p)))
  setInterval(() => {}, 1000)
} else {
  // Esperar a que el otro exista antes de hablarle.
  await new Promise((r) => setTimeout(r, 4000))
  c.send(otro, { n: 1 })
  console.log('ENVIADO=1 porProxio=' + porProxio)
  // El canal directo se pidió solo al mandar el primero.
  for (let i = 0; i < 80 && !c.isWebRTCOpen(otro); i++) await new Promise((r) => setTimeout(r, 500))
  console.log('DIRECTO=' + c.isWebRTCOpen(otro))
  const antes = porProxio
  c.send(otro, { n: 2 })
  console.log('ENVIADO=2 nuevosPorProxio=' + (porProxio - antes))
  setInterval(() => {}, 1000)
}
`

function caja (nombre) {
  const c = crearCaja(nombre)
  const salida = []
  cajas[nombre] = { caja: c, salida }
  c.escribir('/data/nodo.mjs', GUION)
  return cajas[nombre]
}

const lanzar = (n, rol, otro = '') => {
  const b = cajas[n]
  b.caja.lanzar(`node /data/nodo.mjs ${proxy.url} ${rol} ${otro}`, {
    env: { HOME: '/data' },
    onLinea: (l) => { b.salida.push(l.trim()); log(`[${n}] ` + l) }
  })
}

const esperar = async (b, re, que, ms = 60000) => {
  const t = Date.now() + ms
  while (Date.now() < t) {
    const l = b.salida.find((x) => re.test(x))
    if (l) return re.exec(l)
    await sleep(200)
  }
  throw new Error('se agotó la espera de ' + que + '\n  salida:\n    ' + b.salida.join('\n    '))
}

escenario('dos máquinas Node, y las dos tienen WebRTC', async () => {
  if (elegirMotor() !== 'docker') {
    throw new Error('esto necesita Docker: en cajas locales los dos «nodos» comparten máquina y no probaría nada')
  }
  proxy = await startProxy({ log })
  const a = caja('nodo-a')
  const b = caja('nodo-b')
  lanzar('nodo-b', 'b')
  const tb = (await esperar(b, /^TOKEN=(.+)$/, 'el token de B'))[1]
  lanzar('nodo-a', 'a', tb)
  await esperar(a, /^TOKEN=/, 'el token de A')

  for (const [n, c] of [['nodo-a', a], ['nodo-b', b]]) {
    const m = await esperar(c, /^WEBRTC=(\w+)$/, 'si ' + n + ' tiene WebRTC')
    assert.equal(m[1], 'true', n + ' tiene que poder hablar WebRTC en Node')
  }
})

escenario('el PRIMER mensaje va por el proxio: no se espera a negociar nada', async () => {
  const m = await esperar(cajas['nodo-a'], /^ENVIADO=1 porProxio=(\d+)$/, 'el primer envío')
  assert.equal(m[1], '1', 'salió por el proxio, que es lo que hay en ese momento')
  const r = await esperar(cajas['nodo-b'], /^RECIBIDO=(.+)$/, 'que B lo reciba')
  assert.deepEqual(JSON.parse(r[1]), { n: 1 })
})

/**
 * EL ESCALÓN QUE ANTES NO EXISTÍA. Y la medida que importa no es «el canal está abierto»
 * sino que **el mensaje ya no pasa por el proxio**: lo primero podría ser cierto y lo
 * segundo no si el enrutado se rompiera.
 */
escenario('y el SEGUNDO ya va directo, sin tocar el proxio', async () => {
  const abierto = await esperar(cajas['nodo-a'], /^DIRECTO=(\w+)$/, 'que se abra el canal directo')
  assert.equal(abierto[1], 'true', 'el canal directo se abre SOLO, sin que nadie lo pida')

  const m = await esperar(cajas['nodo-a'], /^ENVIADO=2 nuevosPorProxio=(\d+)$/, 'el segundo envío')
  assert.equal(m[1], '0', 'el segundo mensaje NO pasó por el proxio')

  const recibidos = cajas['nodo-b'].salida.filter((l) => l.startsWith('RECIBIDO='))
  await esperar(cajas['nodo-b'], /^RECIBIDO=.*"n":2/, 'que B reciba el segundo')
  assert.ok(recibidos.length >= 1, 'y llegó igual, por el otro camino')
})

await correr()
destruirCajas()
await teardown()
