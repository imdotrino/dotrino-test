/**
 * EL REPLICADOR: la cuenta contesta con la bóveda APAGADA.
 *
 * Lo que prueba, y que ningún test de un proceso puede probar: que un servicio recibe sus
 * claves de una máquina que **no tiene la maestra** y **no puede abrir lo que entrega**,
 * mientras la bóveda está apagada. Diseño: `dotrino-vault/docs/replicas.md` §8.bis.
 *
 * No sustituye al multivault (`dos-bovedas.mjs`): aquello es una segunda bóveda que SELLA,
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
import { escenario, correr, startProxy, teardown } from './lib/harness.js'
import { crearCaja, destruirCajas } from './lib/caja.js'
import { enrollService, fetchSecrets, readServiceIdentity } from '../../dotrino-vault/lib/src/service.js'
import { atRestFor } from '../../dotrino-vault/lib/src/atrest.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BINARIO = '/eco/dotrino-vault/dist/dotrino-vaultd'
const NS = 'demo'
const VALOR = 'la-clave-que-tiene-que-llegar'

let proxy = null
let B = null          // la bóveda
let R = null          // el replicador
let idReplica = null
let dirServicio = null
let dirNuevo = null

async function esperar (fn, { timeoutMs = 30000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  let ultimo = null
  while (Date.now() < t) {
    try { const v = await fn(); if (v) return v } catch (e) { ultimo = e }
    await sleep(200)
  }
  throw new Error('se agotó la espera de ' + que + (ultimo ? ' · último error: ' + ultimo.message : ''))
}

/** Una caja con el binario dentro, lista para recibir órdenes. */
function caja (nombre, { env = {} } = {}) {
  const c = crearCaja(nombre)
  if (c.motor === 'docker') {
    c.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  }
  const base = { ...env }
  const salida = []
  return {
    caja: c,
    salida,
    exec: (cmd) => c.exec(`${BINARIO} --ctl ${cmd}`, { env: base }),
    lanzar (cmd) {
      const lineas = []
      c.lanzar(cmd, { env: { ...base, PROXY_URL: proxy.url }, onLinea: (l) => { lineas.push(l.trim()); salida.push(l); log(`[${nombre}] ` + l) } })
      return lineas
    }
  }
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

escenario('la bóveda arranca y guarda una clave', async () => {
  proxy = await startProxy({ log })
  B = caja('boveda', { DOTRINO_VAULT_DIR: '/data/vault' })
  B.lanzar(BINARIO)
  await esperar(() => B.salida.some((l) => l.includes('servicio listo')), { que: 'que arranque la bóveda' })

  const r = B.exec(`secret set ${NS} API_KEY ${VALOR}`)
  assert.equal(r.status, 0, 'guardar la clave: ' + (r.stderr || r.stdout))
})

escenario('un servicio la lee de la BÓVEDA, y con eso conoce la cuenta', async () => {
  const lineas = B.lanzar(`${BINARIO} --ctl pair --service ${NS} --quiet`)
  const inv = await esperar(() => {
    for (const l of lineas) { const o = parseInvite(l); if (o?.sn) return o }
    return null
  }, { que: 'la invitación del servicio' })

  dirServicio = tmp('smoke-serv-')
  const enrolando = enrollService({ qr: inv, ns: NS, dir: dirServicio, label: 'servicio', onCode: ({ code }) => { B.exec(`approve ${code}`) } })
  await enrolando

  // SIN `desatendido` la bóveda pide aprobación en cada arranque, que es el defecto desde
  // el 2026-09-01. Aquí no hay teléfono que apruebe, así que se le concede — es justo lo
  // que se hace con un servidor de verdad.
  // POR EL NOMBRE DEL CAJÓN, no por la palabra «servicio»: la propia llave de
  // comunicación de la bóveda sale como «[servicio «vault»]», así que buscar «servicio» a
  // secas casaba con ELLA — y el permiso acababa puesto en la bóveda, no en el agente.
  const idServ = await esperar(() => {
    const a = B.exec('members').stdout || ''
    const l = a.split('\n').find((x) => x.includes(`«${NS}»`))
    return l ? (/\b([0-9A-F]{4}-[0-9A-F]{4})\b/.exec(l) || [])[1] : null
  }, { que: 'que el acta liste al servicio' })
  B.exec(`caps ${idServ} +desatendido`)

  // `approvalTimeoutMs` corto: un pedido de aprobación bloquea CINCO minutos, y con eso
  // el bucle de reintento no llegaba nunca a probar después de conceder el permiso.
  const s = await esperar(() => fetchSecrets({ dir: dirServicio, ns: NS, approvalTimeoutMs: 2500 }).catch(() => null),
    { que: 'que la bóveda entregue la clave' })
  assert.equal(s.API_KEY, VALOR, 'con la bóveda encendida se lee como siempre')

  // El PIN: es lo que después le permite creerle a un replicador. Sin esto no le creería.
  // El archivo va cifrado en reposo, así que se lee con el lector del pilar y no a mano.
  const link = readServiceIdentity(dirServicio)
  assert.equal(typeof link.actaSeq, 'number', 'el servicio se quedó con el `seq` que vio')
})

escenario('el replicador entra en la cuenta, y entra SIN llave de cifrado', async () => {
  R = caja('replicador', { DOTRINO_REPLICA_DIR: '/data/replica' })

  const lineas = B.lanzar(`${BINARIO} --ctl pair --scope replica --label replicador --quiet`)
  const inv = await esperar(() => {
    for (const l of lineas) { const o = parseInvite(l); if (o?.sn) return o }
    return null
  }, { que: 'la invitación del replicador' })
    .catch((e) => { throw new Error(e.message + '\n  lo que dijo pair:\n    ' + lineas.join('\n    ')) })

  const enrolando = R.lanzar(`${BINARIO} --ctl replica enroll '${JSON.stringify(inv).replace(/'/g, "'\\''")}'`)
  const codigo = await esperar(() => {
    for (const l of enrolando) { const m = /código:\s*(\d{6})/.exec(l); if (m) return m[1] }
    return null
  }, { que: 'el código que muestra el replicador' })
  B.exec(`approve ${codigo}`)
  await esperar(() => enrolando.some((l) => /ya está en la cuenta/.test(l)), { que: 'que el replicador confirme' })

  // EL ID SALE DE QUIEN SE ENROLA, no de buscar su etiqueta en el acta: la etiqueta la
  // pone la BÓVEDA al emparejar, así que buscarla aquí es adivinar. Esto es exacto.
  idReplica = await esperar(() => {
    for (const l of enrolando) { const m = /máquina:\s*([0-9A-F]{4}-[0-9A-F]{4})/i.exec(l); if (m) return m[1] }
    return null
  }, { que: 'el identificador del replicador' })

  const acta = await esperar(() => {
    const a = B.exec('members').stdout || ''
    return a.includes(idReplica) ? a : null
  }, { que: 'que el acta liste al replicador' })
  log('[test] acta:\n' + acta)
})

/**
 * LA GARANTÍA, y es estructural: sin `encPub` no hay a dónde envolverle un sobre. Regla
 * del dueño — «recibirá todos los sobres que se generen, ningún sobre firmado para él».
 */
escenario('a un replicador no se le puede envolver nada, y no puede nada más', async () => {
  const permisos = B.exec('members').stdout || ''
  const linea = permisos.split('\n').findIndex((l) => l.includes(idReplica))
  const suyas = permisos.split('\n').slice(linea, linea + 2).join(' ')
  assert.ok(!/sella|sealer|administra|admin/i.test(suyas), 'un replicador no sella ni administra: ' + suyas)
})

escenario('con la bóveda APAGADA, el servicio sigue recibiendo su clave', async () => {
  R.lanzar(`${BINARIO} --ctl replica run`)
  await esperar(() => R.salida.some((l) => /record #\d+ ·.*bundle/.test(l)), { que: 'que la bóveda le empuje los sobres' })

  // UN INTERCAMBIO MÁS, CON LA BÓVEDA VIVA. El servicio aprende sus replicadores DEL ACTA,
  // y la suya es la de antes de que el replicador entrara. No es un rodeo del test: es
  // cómo funciona, y conviene que se vea aquí — a un replicador nuevo hay que dejar que
  // los servicios lo conozcan mientras la bóveda todavía contesta.
  await esperar(async () => {
    await fetchSecrets({ dir: dirServicio, ns: NS, approvalTimeoutMs: 2500 }).catch(() => null)
    return (readServiceIdentity(dirServicio)?.replicas || []).length > 0
  }, { que: 'que el servicio se entere de que hay un replicador' })

  // Se apaga la bóveda de verdad: la caja entera.
  B.caja.destruir()
  await sleep(1500)

  const s = await esperar(() => fetchSecrets({ dir: dirServicio, ns: NS, approvalTimeoutMs: 2500 })
    .catch((e) => { log('[test] el replicador contestó pero no valió: ' + e.message); return null }),
  { que: 'que el replicador conteste', timeoutMs: 45000 })
  assert.equal(s.API_KEY, VALOR, 'la clave llega igual, y el replicador no puede abrirla')
})

/**
 * EL FRENO QUE CIERRA R1 SIN ORÁCULO (`replicas.md` §6.1): un replicador solo le contesta
 * a quien YA conoce la cuenta. A un aparato nuevo no hay con qué compararle un acta
 * atrasada, así que no se le cree y tiene que preguntarle a la bóveda.
 */
escenario('a un aparato que nunca vio la cuenta, el replicador NO le vale', async () => {
  dirNuevo = tmp('smoke-nuevo-')
  // Se copia el enlace del servicio que sí funciona y se le BORRA el pin: es exactamente
  // un aparato que tiene su papel pero nunca ha hablado con la bóveda.
  const link = readServiceIdentity(dirServicio)
  delete link.actaSeq
  fs.writeFileSync(path.join(dirNuevo, 'service-identity.json'),
    atRestFor(dirNuevo).encrypt(JSON.stringify(link, null, 2)), { mode: 0o600 })

  await assert.rejects(
    () => fetchSecrets({ dir: dirNuevo, ns: NS, approvalTimeoutMs: 2500 }),
    (e) => e.code === 'replica-unknown-account',
    'sin pin no se le cree a un replicador: que conteste la bóveda')
})

await correr()
destruirCajas()
await teardown()
