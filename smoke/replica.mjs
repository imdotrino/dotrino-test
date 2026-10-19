/**
 * EL REPLICADOR: la cuenta contesta con la bóveda APAGADA.
 *
 * Lo que prueba, y que ningún test de un proceso puede probar: que un servicio recibe sus
 * claves de una máquina que **no tiene la maestra** y **no puede abrir lo que entrega**,
 * mientras la bóveda está apagada. Diseño: `dotrino-vault/docs/replicas.md` §8.bis.
 *
 * No sustituye al multivault (`two-vaults.mjs`): aquello es una segunda bóveda que SELLA,
 * esto es un repartidor que no decide nada. Las dos piezas existen y prueban cosas
 * distintas — una cubre el desastre, la otra el día a día con la máquina del dueño apagada.
 *
 * Dos cajas y un servicio:
 *   · `boveda`      — la bóveda de verdad. Binario real + su CLI.
 *   · `replicador`  — el mismo binario en modo `replica`. Sin maestra.
 *   · el servicio   — corre EN ESTE proceso, con la librería que usa `dotrino-env`.
 *
 *   node smoke/replica.mjs            (Docker si lo hay; si no, cajas locales)
 *   node smoke/replica.mjs --verbose
 *
 * Requiere el binario:  cd dotrino-vault && bash packaging/build.sh
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scenario, runScenarios, startProxy, teardown } from './lib/harness.js'
import { createBox, destroyBoxes } from './lib/box.js'
import { sleep, waitFor } from './lib/wait.js'
import { WebSocketProxyClient } from '@dotrino/proxy-client'
import { makeDeviceKey, signWithDevice } from '@dotrino/identity/capabilities'
import { enrollService, fetchSecrets, readServiceIdentity } from '../../dotrino-vault/lib/src/service.js'
import { makeEphemeralKey, openSealed } from '../../dotrino-vault/lib/src/sealed.js'
import { MSG } from '../../dotrino-vault/lib/src/protocol.js'
import { atRestFor } from '../../dotrino-vault/lib/src/atrest.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const BINARY = '/eco/dotrino-vault/dist/dotrino-vaultd'
const NS = 'demo'
const VALUE = 'the-key-that-must-arrive'

let proxy = null
let B = null          // la bóveda
let R = null          // el replicador
let replicaId = null
let serviceDir = null
let newDir = null

/** Una caja con el binario dentro, lista para recibir órdenes. */
function box (name, { env = {} } = {}) {
  const c = createBox(name)
  if (c.engine === 'docker') {
    c.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  }
  const base = { ...env }
  const output = []
  return {
    box: c,
    output,
    exec: (cmd) => c.exec(`${BINARY} --ctl ${cmd}`, { env: base }),
    launch (cmd) {
      const lines = []
      c.launch(cmd, { env: { ...base, PROXY_URL: proxy.url }, onLine: (l) => { lines.push(l.trim()); output.push(l); log(`[${name}] ` + l) } })
      return lines
    }
  }
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

scenario('the vault starts and stores a key', async () => {
  proxy = await startProxy({ log })
  B = box('vault', { DOTRINO_VAULT_DIR: '/data/vault' })
  B.launch(BINARY)
  await waitFor(() => B.output.some((l) => l.includes('servicio listo')), { retryErrors: true, what: 'the vault to start' })

  const r = B.exec(`secret set ${NS} API_KEY ${VALUE}`)
  assert.equal(r.status, 0, 'store the key: ' + (r.stderr || r.stdout))
})

scenario('a service reads it from the VAULT, and so learns the account', async () => {
  const lines = B.launch(`${BINARY} --ctl pair --service ${NS} --quiet`)
  const inv = await waitFor(() => {
    for (const l of lines) { const o = parseInvite(l); if (o?.sn) return o }
    return null
  }, { retryErrors: true, what: 'the service invitation' })

  serviceDir = tmp('smoke-serv-')
  const enrolling = enrollService({ qr: inv, ns: NS, dir: serviceDir, label: 'service', onCode: ({ code }) => { B.exec(`approve ${code}`) } })
  await enrolling

  // SIN `desatendido` la bóveda pide aprobación en cada arranque, que es el defecto desde
  // el 2026-09-01. Aquí no hay teléfono que apruebe, así que se le concede — es justo lo
  // que se hace con un servidor de verdad.
  // POR EL NOMBRE DEL CAJÓN, no por la palabra «servicio»: la propia llave de
  // comunicación de la bóveda sale como «[servicio «vault»]», así que buscar «servicio» a
  // secas casaba con ELLA — y el permiso acababa puesto en la bóveda, no en el agente.
  const serviceId = await waitFor(() => {
    const a = B.exec('members').stdout || ''
    const l = a.split('\n').find((x) => x.includes(`«${NS}»`))
    return l ? (/\b([0-9A-F]{4}-[0-9A-F]{4})\b/.exec(l) || [])[1] : null
  }, { retryErrors: true, what: 'the record to list the service' })
  B.exec(`caps ${serviceId} +desatendido`)

  // `approvalTimeoutMs` corto: un pedido de aprobación bloquea CINCO minutos, y con eso
  // el bucle de reintento no llegaba nunca a probar después de conceder el permiso.
  const s = await waitFor(() => fetchSecrets({ dir: serviceDir, ns: NS, approvalTimeoutMs: 2500 }).catch(() => null),
    { retryErrors: true, what: 'the vault to hand over the key' })
  assert.equal(s.API_KEY, VALUE, 'with the vault on it reads as always')

  // El PIN: es lo que después le permite creerle a un replicador. Sin esto no le creería.
  // El archivo va cifrado en reposo, así que se lee con el lector del pilar y no a mano.
  const link = readServiceIdentity(serviceDir)
  assert.equal(typeof link.actaSeq, 'number', 'the service kept the `seq` it saw')
})

scenario('the replicator joins the account, WITHOUT an encryption key', async () => {
  R = box('replicator', { DOTRINO_REPLICA_DIR: '/data/replica' })

  const lines = B.launch(`${BINARY} --ctl pair --scope replica --name replicador --quiet`)
  const inv = await waitFor(() => {
    for (const l of lines) { const o = parseInvite(l); if (o?.sn) return o }
    return null
  }, { retryErrors: true, what: 'the replicator invitation' })
    .catch((e) => { throw new Error(e.message + '\n  what pair said:\n    ' + lines.join('\n    ')) })

  const enrolling = R.launch(`${BINARY} --ctl replica enroll '${JSON.stringify(inv).replace(/'/g, "'\\''")}'`)
  const code = await waitFor(() => {
    for (const l of enrolling) { const m = /código:\s*(\d{6})/.exec(l); if (m) return m[1] }
    return null
  }, { retryErrors: true, what: 'the code the replicator shows' })
  B.exec(`approve ${code}`)
  await waitFor(() => enrolling.some((l) => /ya está en la cuenta/.test(l)), { retryErrors: true, what: 'the replicator to confirm' })

  // EL ID SALE DE QUIEN SE ENROLA, no de buscar su etiqueta en el acta: la etiqueta la
  // pone la BÓVEDA al emparejar, así que buscarla aquí es adivinar. Esto es exacto.
  replicaId = await waitFor(() => {
    for (const l of enrolling) { const m = /máquina:\s*([0-9A-F]{4}-[0-9A-F]{4})/i.exec(l); if (m) return m[1] }
    return null
  }, { retryErrors: true, what: 'the replicator id' })

  const record = await waitFor(() => {
    const a = B.exec('members').stdout || ''
    return a.includes(replicaId) ? a : null
  }, { retryErrors: true, what: 'the record to list the replicator' })
  log('[test] record:\n' + record)
})

/**
 * LA GARANTÍA, y es estructural: sin `encPub` no hay a dónde envolverle un sobre. Regla
 * del dueño — «recibirá todos los sobres que se generen, ningún sobre firmado para él».
 */
scenario('nothing can be wrapped for a replicator, and it can do nothing else', async () => {
  const perms = B.exec('members').stdout || ''
  const lineIdx = perms.split('\n').findIndex((l) => l.includes(replicaId))
  const own = perms.split('\n').slice(lineIdx, lineIdx + 2).join(' ')
  assert.ok(!/sella|sealer|administra|admin/i.test(own), 'a replicator neither seals nor administers: ' + own)
})

scenario('with the vault OFF, the service still receives its key', async () => {
  R.launch(`${BINARY} --ctl replica run`)
  await waitFor(() => R.output.some((l) => /record #\d+ ·.*bundle/.test(l)), { retryErrors: true, what: 'the vault to push it the envelopes' })

  // UN INTERCAMBIO MÁS, CON LA BÓVEDA VIVA. El servicio aprende sus replicadores DEL ACTA,
  // y la suya es la de antes de que el replicador entrara. No es un rodeo del test: es
  // cómo funciona, y conviene que se vea aquí — a un replicador nuevo hay que dejar que
  // los servicios lo conozcan mientras la bóveda todavía contesta.
  await waitFor(async () => {
    await fetchSecrets({ dir: serviceDir, ns: NS, approvalTimeoutMs: 2500 }).catch(() => null)
    return (readServiceIdentity(serviceDir)?.replicas || []).length > 0
  }, { retryErrors: true, what: 'the service to learn there is a replicator' })

  // Se apaga la bóveda de verdad: la caja entera.
  B.box.destroy()
  await sleep(1500)

  const s = await waitFor(() => fetchSecrets({ dir: serviceDir, ns: NS, approvalTimeoutMs: 2500 })
    .catch((e) => { log('[test] the replicator answered but it was not valid: ' + e.message); return null }),
  { retryErrors: true, what: 'the replicator to answer', timeoutMs: 45000 })
  assert.equal(s.API_KEY, VALUE, 'the key still arrives, and the replicator cannot open it')
})

/**
 * UN DESCONOCIDO PIDIENDO EL CAJÓN. Es la contraparte del escenario siguiente y hay que
 * tener las dos, porque prueban cosas distintas en lados distintos:
 *
 *   · el siguiente prueba que NUESTRO cliente no le cree a un replicador sin pin;
 *   · este prueba que el REPLICADOR no le contesta a quien no debe.
 *
 * Lo primero no protege de nadie: un atacante no corre nuestro cliente. La petición ya
 * viaja firmada y con papel desde `fetchSecrets`, así que comprobarlos no cuesta un
 * mensaje nuevo — solo mirarlos.
 *
 * El intruso no tiene nada: llave recién hecha, ningún papel, nunca estuvo en el acta.
 * Solo sabe a quién preguntar y por qué cajón, que es lo que se aprende mirando.
 */
scenario('the replicator gives a STRANGER neither the drawer nor the record', async () => {
  const link = readServiceIdentity(serviceDir)
  const replicaPub = (link.replicas || [])[0]
  assert.ok(replicaPub, 'the service must know the replicator for this to prove anything')

  const intruder = await makeDeviceKey()
  const eph = await makeEphemeralKey()
  const cli = new WebSocketProxyClient({ url: proxy.url })
  await cli.connect()
  const ident = { op: 'identify', publickey: intruder.publickey, token: cli.token, ts: Date.now() }
  await cli.identify({ data: ident, signature: (await signWithDevice({ privateJwk: intruder.privateJwk, data: ident })).signature })

  const reply = new Promise((resolve) => {
    cli.on('message', (_from, p) => { if (p?.type === MSG.SECRETS_RESULT || p?.type === MSG.ERROR) resolve(p) })
    setTimeout(() => resolve(null), 8000)
  })
  // NI FIRMA NI PAPEL: exactamente lo que un extraño puede mandar.
  cli.sendByPubkey(replicaPub, {
    type: MSG.SECRETS,
    data: { op: 'secrets', ns: NS, ek: eph.ek, publickey: link.device.publickey, ts: Date.now() }
  })
  const p = await reply
  try { cli.close() } catch (_) {}

  assert.ok(p, 'the replicator did not even answer, which is also fine')
  assert.notEqual(p.type, MSG.SECRETS_RESULT,
    'the replicator handed the drawer to someone who signed nothing')

  // Y lo que iba DENTRO, que es lo que de verdad se escapaba: el acta es el inventario de
  // aparatos del dueño, y la bóveda no se lo enseña ni a un servicio de la casa.
  if (p.type === MSG.SECRETS_RESULT) {
    const inside = await openSealed({ privateKey: eph.privateKey, enc: p.body?.enc })
    assert.fail('it also handed over the record with ' + (inside?.acta?.members || []).length + ' devices')
  }
})

/**
 * EL FRENO QUE CIERRA R1 SIN ORÁCULO (`replicas.md` §6.1): un replicador solo le contesta
 * a quien YA conoce la cuenta. A un aparato nuevo no hay con qué compararle un acta
 * atrasada, así que no se le cree y tiene que preguntarle a la bóveda.
 */
scenario('for a device that never saw the account, the replicator is NOT enough', async () => {
  newDir = tmp('smoke-new-')
  // Se copia el enlace del servicio que sí funciona y se le BORRA el pin: es exactamente
  // un aparato que tiene su papel pero nunca ha hablado con la bóveda.
  const link = readServiceIdentity(serviceDir)
  delete link.actaSeq
  fs.writeFileSync(path.join(newDir, 'service-identity.json'),
    atRestFor(newDir).encrypt(JSON.stringify(link, null, 2)), { mode: 0o600 })

  await assert.rejects(
    () => fetchSecrets({ dir: newDir, ns: NS, approvalTimeoutMs: 2500 }),
    (e) => e.code === 'replica-unknown-account',
    'without a pin a replicator is not trusted: the vault must answer')
})

await runScenarios()
destroyBoxes()
await teardown()
