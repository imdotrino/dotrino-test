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
 *   node smoke/sealed-strangers.mjs [--verbose]
 */
import assert from 'node:assert/strict'
import { scenario, runScenarios, startProxy, teardown } from './lib/harness.js'
import { sleep } from './lib/wait.js'

import { WebSocketProxyClient } from '../../dotrino-proxy-client/src/client.js'
import { makeEncKeypair, setSealingPrimitives } from '../../dotrino-proxy-client/src/sealing.js'
import { makeDeviceKey, signWithDevice } from '@dotrino/identity/capabilities'

setSealingPrimitives(await import('@dotrino/identity/content'))

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

let proxy = null

/** Una identidad nueva: llave de firma (la del cable) + llave de cifrado. */
async function identity (name) {
  const signing = await makeDeviceKey()
  const encryption = await makeEncKeypair()
  return {
    name,
    publickey: signing.publickey,
    encPub: encryption.encPub,
    encPrivateKey: encryption.privateKey,
    sign: (data) => signWithDevice({ privateJwk: signing.privateJwk, publickey: signing.publickey, data })
  }
}

/**
 * Un cliente conectado e identificado, con su llave anunciada. Se le envuelve `_sendRaw`
 * para VER lo que sale por el cable: es la única medida honesta de «¿el proxio lo pudo
 * leer?» — mirar una bandera del cliente no prueba nada.
 */
async function connect (id) {
  const c = new WebSocketProxyClient({
    url: proxy.url,
    enableWebRTC: false,
    autoReconnect: false,
    requireSealed: true,
    myEncPub: id.encPub,
    myEncPrivateKey: id.encPrivateKey
  })
  c.wireLog = []
  const raw = c._sendRaw.bind(c)
  c._sendRaw = (frame) => { c.wireLog.push(frame); return raw(frame) }
  c.inbox = []
  c.seenErrors = []
  c.on('message', (from, payload, meta) => c.inbox.push({ from, payload, meta }))
  c.on('error', (e) => c.seenErrors.push(e))

  await c.connect()
  await c.identifyAs({ publickey: id.publickey, sign: id.sign })
  // `identify` anuncia por detrás; aquí se espera a propósito, porque el escenario
  // siguiente pregunta por esta llave.
  await c.announceEncPub({ publickey: id.publickey, encPub: id.encPub, sign: id.sign })
  log(`  ${id.name}: token ${c.token}`)
  return c
}

const withContent = (c) => c.wireLog.filter((f) => f.message !== undefined)

scenario('the proxy says up front that it can serve encryption keys', async () => {
  proxy = await startProxy({ log })
  const ana = await identity('ana')
  const c = await connect(ana)
  assert.equal(c.protocol, 2, 'the proxy does not announce a protocol')
  assert.ok(c.caps.includes('encpub'), `caps without encpub: ${JSON.stringify(c.caps)}`)
  c.close()
})

scenario('ana seals to beto without ever having paired', async () => {
  const ana = await identity('ana')
  const beto = await identity('beto')
  const cAna = await connect(ana)
  const cBeto = await connect(beto)

  // Lo ÚNICO que ana sabe de beto es su pubkey. Ni contacto, ni cita, ni llave.
  assert.equal(cAna._encPubs.has(beto.publickey), false, 'ana already had it beforehand')

  const secret = 'the envelope is in the top drawer'
  await cAna.sendSealed([beto.publickey], { text: secret })

  const sent = withContent(cAna).at(-1)
  assert.ok(!JSON.stringify(sent).includes(secret), 'went out in clear: the proxy read it')
  assert.ok(!JSON.stringify(sent).includes('the envelope'), 'went out in clear')

  await sleep(400)
  assert.equal(cBeto.inbox.length, 1, `beto did not receive it (errors: ${JSON.stringify(cBeto.seenErrors)})`)
  assert.deepEqual(cBeto.inbox[0].payload, { text: secret })
  assert.equal(cBeto.inbox[0].meta.sealed, true, 'arrived unsealed')

  // Y contesta igual, en el otro sentido: la llave de ana también se averigua.
  await cBeto.sendSealed([ana.publickey], { text: 'received' })
  await sleep(400)
  assert.deepEqual(cAna.inbox[0].payload, { text: 'received' })
  assert.equal(cAna.inbox[0].meta.sealed, true)

  cAna.close(); cBeto.close()
})

scenario('also with the recipient OFFLINE: sealed and waiting in the 24 h queue', async () => {
  const ana = await identity('ana')
  const beto = await identity('beto')

  // Beto se conecta, anuncia su llave y SE VA. A partir de aquí no hay presencia ninguna
  // de la que sacar su llave: si el directorio no fuera duradero, aquí no habría nada.
  const cBeto1 = await connect(beto)
  cBeto1.close()
  await sleep(300)

  const cAna = await connect(ana)
  await cAna.sendSealed([beto.publickey], { text: 'leaving this for you' })
  const sent = withContent(cAna).at(-1)
  assert.ok(!JSON.stringify(sent).includes('leaving this'), 'went out in clear')

  // Beto vuelve: el proxio le drena la cola y el sobre se abre con su llave.
  const cBeto2 = await connect(beto)
  await sleep(500)
  assert.equal(cBeto2.inbox.length, 1, `the queued message did not arrive (errors: ${JSON.stringify(cBeto2.seenErrors)})`)
  assert.deepEqual(cBeto2.inbox[0].payload, { text: 'leaving this for you' })
  assert.equal(cBeto2.inbox[0].meta.sealed, true)
  assert.equal(cBeto2.inbox[0].meta.queued, true, 'it did not come from the queue')

  cAna.close(); cBeto2.close()
})

scenario('nothing is sent to someone who announced no key, and the reason is given', async () => {
  const ana = await identity('ana')
  const ghost = await identity('ghost')   // nunca se conectó
  const cAna = await connect(ana)
  const before = withContent(cAna).length

  await assert.rejects(
    () => cAna.sendSealed([ghost.publickey], { text: 'hello?' }),
    (e) => e.code === 'no-encpub',
    'did not fail with the code that tells «no key» apart from «network down»')
  assert.equal(withContent(cAna).length, before, 'it sent something anyway')

  cAna.close()
})

scenario('sealing by TOKEN too: the app says whose token it is', async () => {
  const ana = await identity('ana')
  const beto = await identity('beto')
  const cAna = await connect(ana)
  const cBeto = await connect(beto)

  await cAna.sendSealedTo(cBeto.token, { move: 'e4' }, { peerPubkey: beto.publickey })
  const sent = withContent(cAna).at(-1)
  assert.deepEqual(sent.to, [cBeto.token], 'it no longer goes by token')
  assert.ok(!JSON.stringify(sent).includes('e4'), 'went out in clear')

  await sleep(400)
  assert.deepEqual(cBeto.inbox[0].payload, { move: 'e4' })
  assert.equal(cBeto.inbox[0].meta.sealed, true)

  cAna.close(); cBeto.close()
})

scenario('nobody can announce someone else\'s key', async () => {
  const ana = await identity('ana')
  const brute = await identity('brute')
  const cBruto = await connect(brute)

  // El sobre está bien firmado por ana, pero lo presenta la conexión de bruto.
  await assert.rejects(
    () => cBruto.announceEncPub({ publickey: ana.publickey, encPub: ana.encPub, sign: ana.sign }))

  // Y sigue sin haber llave para ana.
  const cOther = await connect(await identity('other'))
  await assert.rejects(
    () => cOther.encPubOf(ana.publickey),
    (e) => e.code === 'no-encpub')

  cBruto.close(); cOther.close()
})

const ok = await runScenarios()
await teardown()
process.exit(ok ? 0 : 1)
