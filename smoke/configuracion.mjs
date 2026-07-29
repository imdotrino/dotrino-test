/**
 * CONFIGURACIÓN PROXIO ↔ BÓVEDA, cada uno en su propia máquina.
 *
 * Lo que prueba, y que ningún otro smoke podía probar: que un agente enrolado saca
 * su configuración del vault y que **el vault manda** — sus valores pisan los del
 * `.env` de la máquina. Es la pieza que hace barata la rotación: se cambia el
 * valor en un solo lugar y ninguna copia rancia olvidada en un VPS sigue ganando.
 *
 * Por qué en CAJAS SEPARADAS y no en un proceso: la bóveda va a vivir en su propio
 * VPS, y el ciclo que define este diseño sólo es real entre máquinas — **el vault
 * le habla a sus servicios POR EL PROXIO**. De ahí sale la única excepción del
 * ecosistema: el proxio no puede esperar al vault (esperaría a alguien que
 * necesita el proxio escuchando), así que arranca con lo que tenga y aplica la
 * configuración cuando llega. Todos los demás agentes SÍ esperan.
 *
 * Y no se cree nada de lo que diga un log: la prueba de que el valor del vault es
 * el que MANDA se hace de caja negra. Se levantan DOS Cloudflare falsos —uno para
 * el valor del `.env`, otro para el del vault— y se mira **cuál de los dos recibe
 * el pedido** cuando un cliente pide credenciales TURN. El que conteste delata qué
 * configuración está de verdad en efecto.
 *
 *   node smoke/configuracion.mjs            (usa Docker si lo hay; si no, cajas locales)
 *   SMOKE_BACKEND=local node smoke/configuracion.mjs
 *   node smoke/configuracion.mjs --verbose
 *
 * Requiere el binario de la bóveda:  cd dotrino-vault && bash packaging/build.sh
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { escenario, correr, freePort, waitPort, teardown, ROOT } from './lib/harness.js'
import { crearCaja, destruirCajas } from './lib/caja.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BINARIO = '/eco/dotrino-vault/dist/dotrino-vaultd'

// Lo que trae el `.env` de la máquina del proxio: viejo, y a punto de perder.
const ENV_KEY_ID = 'llave-vieja-del-env'
// Lo que el dueño cargó en la bóveda. Esto es lo que tiene que ganar.
const VAULT_KEY_ID = 'llave-buena-del-vault'
const VAULT_KEY_ROTADA = 'llave-rotada-en-caliente'

let proxio = null          // la caja del proxio
let boveda = null          // la caja de la bóveda
let proxioProc = null
let bovedaProc = null
let puertoProxy = null
let falsoEnv = null        // Cloudflare falso que representa el valor del .env
let falsoVault = null      // Cloudflare falso que representa el valor del vault
const salidaProxio = []    // todas las líneas que ha escupido el proxio

async function esperar (fn, { timeoutMs = 30000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(200)
  }
  throw new Error('se agotó la espera de ' + que)
}

// ─────────────────────────── Cloudflare falso ───────────────────────────

/**
 * Un Cloudflare TURN de mentira. El proxio le pega a
 * `POST <base>/<keyId>/credentials/generate`, así que el `keyId` viene en la RUTA:
 * devolviéndolo dentro del `username` de las credenciales, el cliente que las
 * recibe puede leer con qué llave se emitieron. Eso convierte «¿qué valor está en
 * efecto?» en algo observable desde fuera, sin fiarse de ningún log.
 */
async function levantarCloudflareFalso (etiqueta) {
  const puerto = await freePort()
  const pedidos = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const m = req.url.match(/^\/(.+)\/credentials\/generate$/)
      const keyId = m ? decodeURIComponent(m[1]) : null
      let ttl = null
      try { ttl = JSON.parse(body || '{}').ttl } catch (_) {}
      pedidos.push({ keyId, ttl, auth: req.headers.authorization || '' })
      log(`[cf:${etiqueta}] pedido con keyId=${keyId} ttl=${ttl}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        iceServers: {
          urls: [`turn:falso-${etiqueta}:3478`],
          // Aquí viaja la prueba: quién emitió, con qué llave y con qué TTL.
          username: `${etiqueta}|${keyId}|${ttl}`,
          credential: 'x'
        }
      }))
    })
  })
  await new Promise((r) => server.listen(puerto, '127.0.0.1', r))
  return {
    etiqueta,
    base: `http://127.0.0.1:${puerto}`,
    pedidos,
    ultimo: () => pedidos[pedidos.length - 1] || null,
    cerrar: () => new Promise((r) => server.close(r))
  }
}

// ─────────────────────────── las dos cajas ───────────────────────────

/**
 * Arranca el proxio en su caja. `env` simula lo que `dotenv` le dejaría en el
 * entorno desde su `.env`.
 *
 * OJO con `NODE_ENV`: el proxio NO arranca el bucle del vault cuando vale `test`,
 * así que aquí se deja fuera a propósito. Es exactamente por eso que este camino
 * no lo cubría ningún test: el arnés levanta el proxio con `NODE_ENV=test` y con
 * eso la configuración desde la bóveda nunca se pedía.
 */
async function levantarProxio ({ env = {} } = {}) {
  salidaProxio.length = 0
  // `exec` + pidfile: matar el `docker exec` de afuera NO mata lo que corre
  // adentro. Con `exec`, la shell se convierte EN el proceso, así que `$$` es su
  // pid de verdad y se le puede mandar una señal.
  proxioProc = proxio.lanzar('cd /eco/dotrino-proxy && echo $$ > /data/proxio.pid && exec node server.js', {
    env: {
      PORT: String(puertoProxy),
      PROXY_DB_FILE: '/data/proxy.db',
      VAULT_SERVICE_DIR: '/data/vault-service',
      ...env
    },
    onLinea: (l) => { salidaProxio.push(l); log('[proxio] ' + l) }
  })
  await waitPort(puertoProxy, 25000)
  return proxioProc
}

/** Manda una señal a lo que apunte un pidfile dentro de una caja. */
function matarPorPidfile (caja, pidfile, señal = 'TERM') {
  caja.exec(`[ -f ${pidfile} ] && kill -${señal} $(cat ${pidfile}) 2>/dev/null || true`)
}

async function pararProxio () {
  if (!proxioProc) return
  matarPorPidfile(proxio, '/data/proxio.pid')
  try { proxioProc.kill('SIGTERM') } catch (_) {}
  proxioProc = null
  // El puerto libre es la única señal fiable de que murió: `kill` vuelve enseguida
  // y el proxio se toma su tiempo cerrando conexiones.
  await esperar(async () => {
    try { await waitPort(puertoProxy, 400); return false } catch (_) { return true }
  }, { timeoutMs: 20000, que: 'que el proxio suelte el puerto' })
    .catch(async (e) => { matarPorPidfile(proxio, '/data/proxio.pid', 'KILL'); await sleep(1000); throw e })
}

async function levantarBoveda () {
  const salida = []
  bovedaProc = boveda.lanzar(`echo $$ > /data/boveda.pid && exec ${BINARIO}`, {
    env: { DOTRINO_VAULT_DIR: '/data/vault', PROXY_URL: `ws://127.0.0.1:${puertoProxy}` },
    onLinea: (l) => { salida.push(l); log('[bóveda] ' + l) }
  })
  await esperar(() => salida.some((l) => l.includes('servicio listo')), { que: 'que la bóveda arranque' })
    .catch(() => { throw new Error('la bóveda (binario) no arrancó:\n' + salida.join('\n')) })
  return salida
}

async function pararBoveda () {
  matarPorPidfile(boveda, '/data/boveda.pid')
  try { bovedaProc?.kill('SIGTERM') } catch (_) {}
  bovedaProc = null
  // La bóveda deja un candado sobre su directorio de datos: mientras no lo suelte,
  // la siguiente se niega a arrancar («ya hay una bóveda corriendo»).
  await esperar(() => {
    const r = boveda.exec('[ -f /data/boveda.pid ] && kill -0 $(cat /data/boveda.pid) 2>/dev/null && echo viva || echo muerta')
    return (r.stdout || '').includes('muerta')
  }, { timeoutMs: 15000, que: 'que la bóveda suelte sus datos' })
}

const ctl = (cmd) => boveda.exec(`${BINARIO} --ctl ${cmd}`, { env: { DOTRINO_VAULT_DIR: '/data/vault' } })
const setSecret = (ns, k, v) => ctl(`secret set ${ns} ${k} ${v}`)

/**
 * `pair --service <ns>` y devuelve el objeto de la invitación.
 *
 * Se parsea con `parseInvite` y NO buscando una línea JSON: el CLI dejó de
 * imprimir JSON cuando la invitación estrenó marca de formato — ahora imprime la
 * URL del QR y el código compacto. `dispositivos.mjs` todavía espera `{"v":2` y
 * por eso se quedaba colgado.
 */
async function abrirEmparejamiento (servicio) {
  const lineas = []
  boveda.lanzar(`${BINARIO} --ctl pair --service ${servicio}`, {
    env: { DOTRINO_VAULT_DIR: '/data/vault' },
    onLinea: (l) => { lineas.push(l.trim()); log('[pair] ' + l) }
  })
  const qr = await esperar(() => {
    for (const l of lineas) {
      if (!l || l.length < 20) continue
      const o = parseInvite(l)
      if (o?.sn) return o
    }
    return null
  }, { que: 'la invitación que imprime `pair --service`' })
  return qr
}

// ─────────────────────────── el cliente que mira ───────────────────────────

/**
 * Pide credenciales TURN como lo haría una app: cliente real, identificado con una
 * llave nueva. La llave es nueva EN CADA PREGUNTA a propósito — el emisor cachea
 * por pubkey, así que reusarla devolvería la respuesta vieja y la prueba diría
 * cualquier cosa.
 *
 * @returns {{enabled:boolean, quien?:string, keyId?:string, ttl?:string}}
 */
async function pedirTurn () {
  const { WebSocketProxyClient } = await import(path.join(ROOT, 'dotrino-proxy-client/src/index.js'))
  const { makeDeviceKey, signWithDevice } = await import(path.join(ROOT, 'dotrino-identity/vault/capabilities.js'))

  const device = await makeDeviceKey({ label: 'mirón' })
  const c = new WebSocketProxyClient({ url: `ws://127.0.0.1:${puertoProxy}`, enableWebRTC: false, autoReconnect: false })
  await c.connect()
  try {
    const firmar = async (d) => (await signWithDevice({ privateJwk: device.privateJwk, data: d })).signature
    const data = { op: 'identify', publickey: device.publickey, token: c.token, ts: Date.now() }
    await c.identify({ data, signature: await firmar(data) })

    // Por la API real del cliente: el pedido va FIRMADO (el proxio sólo emite a
    // conexiones identificadas, para no ser un relay abierto). Mandarlo a mano
    // como un mensaje suelto no llega a ninguna parte.
    const res = await c.getTurnCredentials({ publicKey: device.publickey, sign: firmar })

    if (!res.enabled) return { enabled: false }
    const [quien, keyId, ttl] = String(res.iceServers?.[0]?.username || '').split('|')
    return { enabled: true, quien, keyId, ttl }
  } finally { c.close() }
}

// ─────────────────────────── escenarios ───────────────────────────

escenario('sin bóveda, el proxio corre con su .env (el modo del que se autohospeda)', async () => {
  await levantarProxio({
    env: {
      TURN_KEY_ID: ENV_KEY_ID,
      TURN_KEY_API_TOKEN: 'token-del-env',
      TURN_API_BASE: falsoEnv.base
    }
  })

  const turn = await pedirTurn()
  assert.equal(turn.enabled, true, 'con llaves en el .env, TURN funciona sin ninguna bóveda')
  assert.equal(turn.quien, 'env', 'y las credenciales las emite el destino que dice el .env')
  assert.equal(turn.keyId, ENV_KEY_ID)

  // Sin enrolar no se pide nada a nadie: ni una línea de vault en el log.
  assert.ok(!salidaProxio.some((l) => l.includes('[vault]')),
    'un proxio sin enrolar no habla de vaults')
})

escenario('el proxio se enrola y la bóveda le CEDE la configuración: pisa el .env', async () => {
  await levantarBoveda()

  // El dueño carga en la bóveda lo que de verdad debe regir.
  setSecret('proxy', 'TURN_KEY_ID', VAULT_KEY_ID)
  setSecret('proxy', 'TURN_KEY_API_TOKEN', 'token-del-vault')
  setSecret('proxy', 'TURN_API_BASE', falsoVault.base)
  const listado = ctl('secret list').stdout || ''
  assert.match(listado, /TURN_KEY_ID/, 'la bóveda guarda el cajón del proxio')

  // Enrolar: el camino real, el mismo comando que corre un operador.
  const qr = await abrirEmparejamiento('proxy')
  proxio.escribir('/data/invitacion.txt', JSON.stringify(qr))
  const lineas = []
  proxio.lanzar("cd /eco/dotrino-proxy && node enroll-vault.js \"$(cat /data/invitacion.txt)\"", {
    env: { VAULT_SERVICE_DIR: '/data/vault-service' },
    onLinea: (l) => { lineas.push(l.trim()); log('[enrol] ' + l) }
  })
  const code = await esperar(() => {
    const l = lineas.find((x) => /approve\s+([A-Z0-9-]{4,})/i.test(x))
    return l ? l.match(/approve\s+([A-Z0-9-]{4,})/i)[1] : null
  }, { que: 'el código de aprobación que muestra el proxio' })
  ctl(`approve ${code}`)
  await esperar(() => proxio.leer('/data/vault-service/service-identity.json'),
    { que: 'la identidad de servicio en el disco del proxio' })

  // En el acta entra como SERVICIO con su CN, no como un dispositivo del dueño.
  assert.match(ctl('members').stdout || '', /proxy/, 'el proxio queda en el acta como servicio')

  // Reiniciar con el MISMO .env viejo: es el caso real, nadie fue a limpiarlo.
  await pararProxio()
  await levantarProxio({
    env: {
      TURN_KEY_ID: ENV_KEY_ID,
      TURN_KEY_API_TOKEN: 'token-del-env',
      TURN_API_BASE: falsoEnv.base
    }
  })

  await esperar(() => salidaProxio.some((l) => l.includes('valor(es) del vault aplicados')),
    { que: 'que llegue la configuración de la bóveda' })

  // El log lo dice…
  const pisadas = salidaProxio.find((l) => l.includes('pisaron el .env'))
  assert.ok(pisadas, 'el proxio avisa qué claves del .env tuvo que pisar')
  assert.match(pisadas, /TURN_KEY_ID/)

  // …pero la prueba es de caja negra: ¿a qué Cloudflare le pega ahora?
  const antes = falsoVault.pedidos.length
  const turn = await pedirTurn()
  assert.equal(turn.enabled, true)
  assert.equal(turn.quien, 'vault', 'las credenciales salen del destino que dice el VAULT, no el .env')
  assert.equal(turn.keyId, VAULT_KEY_ID, 'y con la llave del vault, no con la vieja del .env')
  assert.equal(falsoVault.pedidos.length, antes + 1, 'el pedido llegó al falso del vault')
  assert.equal(falsoVault.ultimo().auth, 'Bearer token-del-vault', 'incluso el token es el del vault')
})

escenario('el proxio NO espera a la bóveda: con ella caída, el transporte sirve igual', async () => {
  // Es LA excepción del ecosistema, y no por importancia: el vault le habla a sus
  // servicios POR el proxio, así que un proxio que lo espera espera a alguien que
  // necesita el proxio escuchando. Todos los demás agentes sí esperan.
  await pararBoveda()
  await pararProxio()
  await levantarProxio({
    env: {
      TURN_KEY_ID: ENV_KEY_ID,
      TURN_KEY_API_TOKEN: 'token-del-env',
      TURN_API_BASE: falsoEnv.base
    }
  })

  // Enrolado y sin bóveda: aun así atiende. Esto es lo que se está probando.
  const turn = await pedirTurn()
  assert.equal(turn.enabled, true, 'el transporte y sus features arrancan sin bóveda')
  assert.equal(turn.quien, 'env', 'cae a lo que tiene, que es su .env — no se queda esperando')

  await esperar(() => salidaProxio.some((l) => /\[vault\].*esperando la configuración/.test(l)),
    { que: 'el aviso de que está esperando a la bóveda' })

  // El primer reintento no es inmediato: el pedido se encola para una bóveda que
  // no está y la espera de respuesta tarda ~30 s en rendirse. Mirar antes de eso
  // no probaría nada.
  await esperar(() => salidaProxio.some((l) => /sin configuración todavía/.test(l)),
    { timeoutMs: 60000, que: 'que reintente en vez de rendirse' })
})

escenario('rotar en la bóveda NO llega en caliente; llega al reiniciar', async () => {
  // El límite real de hoy, fijado como hecho comprobado y no como sorpresa: la
  // configuración se pide UNA vez por arranque. Cambiarla en la bóveda mientras el
  // agente corre no le llega — hace falta reiniciarlo.
  // Se reinicia el proxio en vez de esperar a que le toque el siguiente reintento:
  // el backoff llega a 60 s y el test acabaría midiendo la paciencia del bucle en
  // lugar de lo que interesa, que es de dónde sale el valor.
  await levantarBoveda()
  await pararProxio()
  await levantarProxio({
    env: { TURN_KEY_ID: ENV_KEY_ID, TURN_KEY_API_TOKEN: 'token-del-env', TURN_API_BASE: falsoEnv.base }
  })
  await esperar(() => salidaProxio.some((l) => l.includes('valor(es) del vault aplicados')),
    { timeoutMs: 60000, que: 'que la bóveda vuelva y entregue la configuración' })
  assert.equal((await pedirTurn()).keyId, VAULT_KEY_ID, 'con la bóveda de vuelta, manda el vault')

  setSecret('proxy', 'TURN_KEY_ID', VAULT_KEY_ROTADA)
  await sleep(1500)
  assert.equal((await pedirTurn()).keyId, VAULT_KEY_ID,
    'el proxio en marcha NO se entera del cambio: no hay recarga en caliente')

  await pararProxio()
  await levantarProxio({
    env: { TURN_KEY_ID: ENV_KEY_ID, TURN_KEY_API_TOKEN: 'token-del-env', TURN_API_BASE: falsoEnv.base }
  })
  await esperar(() => salidaProxio.some((l) => l.includes('valor(es) del vault aplicados')),
    { que: 'la configuración tras el reinicio' })
  assert.equal((await pedirTurn()).keyId, VAULT_KEY_ROTADA, 'reiniciado, sí toma el valor rotado')
})

escenario('avisa de lo que llegó tarde y no está en efecto hasta reiniciar', async () => {
  // Consecuencia honesta de no esperar: lo que sólo se lee al arrancar queda en el
  // entorno pero no cambia nada hasta el próximo reinicio. Callarlo sería la
  // diferencia entre rotar y creer que rotaste.
  setSecret('proxy', 'PROXY_MAX_FANOUT', '7')
  await pararProxio()
  await levantarProxio({
    env: { TURN_KEY_ID: ENV_KEY_ID, TURN_KEY_API_TOKEN: 'token-del-env', TURN_API_BASE: falsoEnv.base }
  })
  const aviso = await esperar(
    () => salidaProxio.find((l) => l.includes('sólo se leen al arrancar')),
    { que: 'el aviso de las variables que llegan tarde' }
  )
  assert.match(aviso, /PROXY_MAX_FANOUT/, 'nombra exactamente cuál llegó tarde')
})

// ─────────────────────────── arranque ───────────────────────────

if (!fs.existsSync(path.join(ROOT, 'dotrino-vault/dist/dotrino-vaultd'))) {
  console.error('\nFalta el binario de la bóveda. Compílalo:\n  cd dotrino-vault && bash packaging/build.sh\n')
  process.exit(2)
}

console.log('\nSMOKE · configuración PROXIO ↔ BÓVEDA (cada uno en su caja)\n')
let todoBien = false
try {
  puertoProxy = await freePort()
  falsoEnv = await levantarCloudflareFalso('env')
  falsoVault = await levantarCloudflareFalso('vault')

  proxio = crearCaja('proxio')
  boveda = crearCaja('boveda')
  console.log(`  motor: ${proxio.motor} · proxio en ws://127.0.0.1:${puertoProxy}`)
  // El binario trae Node dentro pero espera `libatomic1` del sistema (lo destapó
  // `dispositivos.mjs` en un Debian limpio). En una caja mínima hay que ponerla.
  if (boveda.motor === 'docker') {
    boveda.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  }

  todoBien = await correr()   // `correr()` devuelve un booleano, no un código de salida
} catch (e) {
  console.error('\n✖ ' + (e?.stack || e?.message || e))
  todoBien = false
} finally {
  await pararProxio().catch(() => {})
  await pararBoveda().catch(() => {})
  await falsoEnv?.cerrar()
  await falsoVault?.cerrar()
  destruirCajas()
  await teardown()
}
process.exit(todoBien ? 0 : 1)
