/**
 * DOS DESCONOCIDOS SE SELLAN, CONTRA EL PROXIO DE VERDAD.
 *
 * Es el caso difícil del sellado, y el que dejaba a seis apps del ecosistema mandando en
 * claro: `sendSealed` exigía la llave de cifrado del otro lado y el pilar no daba ninguna
 * forma de conseguirla. Solo podían sellar dos puntas emparejadas de antemano —la bóveda
 * y la extensión del gestor— que se la habían intercambiado a mano. Una sala de
 * desconocidos no puede hacer eso.
 *
 * Aquí no hay nada simulado: es el `dotrino-proxy` real, en un puerto propio, con dos
 * conexiones que **no se han emparejado nunca**. Lo único que cada una sabe de la otra es
 * su pubkey, que es lo que da un canal público, una invitación o el saludo de una sala.
 *
 * Lo que se mide, y es lo único que responde la pregunta de verdad:
 *   · lo que sale por el cable NO contiene el texto (si lo contuviera, el proxio lo lee);
 *   · llega abierto y marcado `meta.sealed`;
 *   · funciona también con el destinatario APAGADO (cola de 24 h), que es donde un
 *     directorio basado en presencia no tendría nada que contestar;
 *   · una identidad que no anunció llave da `no-encpub` y NO se manda nada en claro.
 *
 *   node smoke/sellado-desconocidos.mjs [--verbose]
 */
import assert from 'node:assert/strict'
import { escenario, correr, startProxy, teardown } from './lib/harness.js'

import { WebSocketProxyClient } from '../../dotrino-proxy-client/src/client.js'
import { makeEncKeypair, setSealingPrimitives } from '../../dotrino-proxy-client/src/sealing.js'
import { makeDeviceKey, signWithDevice } from '@dotrino/identity/capabilities'

setSealingPrimitives(await import('@dotrino/identity/content'))

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

let proxy = null

/** Una identidad nueva: llave de firma (la del cable) + llave de cifrado. */
async function identidad (nombre) {
  const firma = await makeDeviceKey()
  const cifrado = await makeEncKeypair()
  return {
    nombre,
    publickey: firma.publickey,
    encPub: cifrado.encPub,
    encPrivateKey: cifrado.privateKey,
    sign: (data) => signWithDevice({ privateJwk: firma.privateJwk, publickey: firma.publickey, data })
  }
}

/**
 * Un cliente conectado e identificado, con su llave anunciada. Se le envuelve `_sendRaw`
 * para VER lo que sale por el cable: es la única medida honesta de «¿el proxio lo pudo
 * leer?» — mirar una bandera del cliente no prueba nada.
 */
async function conectar (id) {
  const c = new WebSocketProxyClient({
    url: proxy.url,
    enableWebRTC: false,
    autoReconnect: false,
    requireSealed: true,
    myEncPub: id.encPub,
    myEncPrivateKey: id.encPrivateKey
  })
  c.cable = []
  const raw = c._sendRaw.bind(c)
  c._sendRaw = (frame) => { c.cable.push(frame); return raw(frame) }
  c.recibidos = []
  c.errores = []
  c.on('message', (from, payload, meta) => c.recibidos.push({ from, payload, meta }))
  c.on('error', (e) => c.errores.push(e))

  await c.connect()
  await c.identifyAs({ publickey: id.publickey, sign: id.sign })
  // `identify` anuncia por detrás; aquí se espera a propósito, porque el escenario
  // siguiente pregunta por esta llave.
  await c.announceEncPub({ publickey: id.publickey, encPub: id.encPub, sign: id.sign })
  log(`  ${id.nombre}: token ${c.token}`)
  return c
}

const conContenido = (c) => c.cable.filter((f) => f.message !== undefined)
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

escenario('el proxio dice de entrada que sabe servir llaves de cifrado', async () => {
  proxy = await startProxy({ log })
  const ana = await identidad('ana')
  const c = await conectar(ana)
  assert.equal(c.protocol, 2, 'el proxio no anuncia protocolo')
  assert.ok(c.caps.includes('encpub'), `caps sin encpub: ${JSON.stringify(c.caps)}`)
  c.close()
})

escenario('ana le sella a beto sin haberse emparejado nunca', async () => {
  const ana = await identidad('ana')
  const beto = await identidad('beto')
  const cAna = await conectar(ana)
  const cBeto = await conectar(beto)

  // Lo ÚNICO que ana sabe de beto es su pubkey. Ni contacto, ni cita, ni llave.
  assert.equal(cAna._encPubs.has(beto.publickey), false, 'ya la tenía de antes')

  const secreto = 'el sobre esta en el cajon de arriba'
  await cAna.sendSealed([beto.publickey], { texto: secreto })

  const salido = conContenido(cAna).at(-1)
  assert.ok(!JSON.stringify(salido).includes(secreto), 'salió en claro: el proxio lo leyó')
  assert.ok(!JSON.stringify(salido).includes('el sobre'), 'salió en claro')

  await esperar(400)
  assert.equal(cBeto.recibidos.length, 1, `beto no lo recibió (errores: ${JSON.stringify(cBeto.errores)})`)
  assert.deepEqual(cBeto.recibidos[0].payload, { texto: secreto })
  assert.equal(cBeto.recibidos[0].meta.sealed, true, 'llegó sin sellar')

  // Y contesta igual, en el otro sentido: la llave de ana también se averigua.
  await cBeto.sendSealed([ana.publickey], { texto: 'recibido' })
  await esperar(400)
  assert.deepEqual(cAna.recibidos[0].payload, { texto: 'recibido' })
  assert.equal(cAna.recibidos[0].meta.sealed, true)

  cAna.close(); cBeto.close()
})

escenario('también con el destinatario APAGADO: se sella y espera en la cola de 24 h', async () => {
  const ana = await identidad('ana')
  const beto = await identidad('beto')

  // Beto se conecta, anuncia su llave y SE VA. A partir de aquí no hay presencia ninguna
  // de la que sacar su llave: si el directorio no fuera duradero, aquí no habría nada.
  const cBeto1 = await conectar(beto)
  cBeto1.close()
  await esperar(300)

  const cAna = await conectar(ana)
  await cAna.sendSealed([beto.publickey], { texto: 'te dejo esto dicho' })
  const salido = conContenido(cAna).at(-1)
  assert.ok(!JSON.stringify(salido).includes('te dejo'), 'salió en claro')

  // Beto vuelve: el proxio le drena la cola y el sobre se abre con su llave.
  const cBeto2 = await conectar(beto)
  await esperar(500)
  assert.equal(cBeto2.recibidos.length, 1, `no le llegó lo encolado (errores: ${JSON.stringify(cBeto2.errores)})`)
  assert.deepEqual(cBeto2.recibidos[0].payload, { texto: 'te dejo esto dicho' })
  assert.equal(cBeto2.recibidos[0].meta.sealed, true)
  assert.equal(cBeto2.recibidos[0].meta.queued, true, 'no vino de la cola')

  cAna.close(); cBeto2.close()
})

escenario('a quien no anunció llave NO se le manda nada, y se dice por qué', async () => {
  const ana = await identidad('ana')
  const fantasma = await identidad('fantasma')   // nunca se conectó
  const cAna = await conectar(ana)
  const antes = conContenido(cAna).length

  await assert.rejects(
    () => cAna.sendSealed([fantasma.publickey], { texto: 'hola?' }),
    (e) => e.code === 'no-encpub',
    'no falló con el código que distingue «no hay llave» de «se cayó la red»')
  assert.equal(conContenido(cAna).length, antes, 'mandó algo igual')

  cAna.close()
})

escenario('por TOKEN también se sella: la app dice de quién es el token', async () => {
  const ana = await identidad('ana')
  const beto = await identidad('beto')
  const cAna = await conectar(ana)
  const cBeto = await conectar(beto)

  await cAna.sendSealedTo(cBeto.token, { jugada: 'e4' }, { peerPubkey: beto.publickey })
  const salido = conContenido(cAna).at(-1)
  assert.deepEqual(salido.to, [cBeto.token], 'dejó de ir por token')
  assert.ok(!JSON.stringify(salido).includes('e4'), 'salió en claro')

  await esperar(400)
  assert.deepEqual(cBeto.recibidos[0].payload, { jugada: 'e4' })
  assert.equal(cBeto.recibidos[0].meta.sealed, true)

  cAna.close(); cBeto.close()
})

escenario('nadie puede anunciar la llave de otro', async () => {
  const ana = await identidad('ana')
  const bruto = await identidad('bruto')
  const cBruto = await conectar(bruto)

  // El sobre está bien firmado por ana, pero lo presenta la conexión de bruto.
  await assert.rejects(
    () => cBruto.announceEncPub({ publickey: ana.publickey, encPub: ana.encPub, sign: ana.sign }))

  // Y sigue sin haber llave para ana.
  const cOtro = await conectar(await identidad('otro'))
  await assert.rejects(
    () => cOtro.encPubOf(ana.publickey),
    (e) => e.code === 'no-encpub')

  cBruto.close(); cOtro.close()
})

const ok = await correr()
await teardown()
process.exit(ok ? 0 : 1)
