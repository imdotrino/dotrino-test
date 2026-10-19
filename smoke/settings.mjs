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
 *   node smoke/settings.mjs            (usa Docker si lo hay; si no, cajas locales)
 *   SMOKE_BACKEND=local node smoke/settings.mjs
 *   node smoke/settings.mjs --verbose
 *
 * Requiere el binario de la bóveda:  cd dotrino-vault && bash packaging/build.sh
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { scenario, runScenarios, freePort, waitPort, teardown, ROOT } from './lib/harness.js'
import { createBox, destroyBoxes } from './lib/box.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const BINARY = '/eco/dotrino-vault/dist/dotrino-vaultd'

// Lo que trae el `.env` de la máquina del proxio: viejo, y a punto de perder.
const ENV_KEY_ID = 'old-key-from-env'
// Lo que el dueño cargó en la bóveda. Esto es lo que tiene que ganar.
const VAULT_KEY_ID = 'good-key-from-vault'
const VAULT_KEY_ROTATED = 'key-rotated-live'

let proxyBox = null          // la caja del proxio
let vaultBox = null          // la caja de la bóveda
let proxyProc = null
let vaultProc = null
let proxyPort = null
let fakeEnv = null        // Cloudflare falso que representa el valor del .env
let fakeVault = null      // Cloudflare falso que representa el valor del vault
const proxyOutput = []    // todas las líneas que ha escupido el proxio
let proxyStartedAt = 0        // cuándo arrancó el proxio actual (para la gracia de arranque)

// ─────────────────────────── Cloudflare falso ───────────────────────────

/**
 * Un Cloudflare TURN de mentira. El proxio le pega a
 * `POST <base>/<keyId>/credentials/generate`, así que el `keyId` viene en la RUTA:
 * devolviéndolo dentro del `username` de las credenciales, el cliente que las
 * recibe puede leer con qué llave se emitieron. Eso convierte «¿qué valor está en
 * efecto?» en algo observable desde fuera, sin fiarse de ningún log.
 */
async function startFakeCloudflare (label) {
  const port = await freePort()
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const m = req.url.match(/^\/(.+)\/credentials\/generate$/)
      const keyId = m ? decodeURIComponent(m[1]) : null
      let ttl = null
      try { ttl = JSON.parse(body || '{}').ttl } catch (_) {}
      requests.push({ keyId, ttl, auth: req.headers.authorization || '' })
      log(`[cf:${label}] request with keyId=${keyId} ttl=${ttl}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        iceServers: {
          urls: [`turn:fake-${label}:3478`],
          // Aquí viaja la prueba: quién emitió, con qué llave y con qué TTL.
          username: `${label}|${keyId}|${ttl}`,
          credential: 'x'
        }
      }))
    })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return {
    label,
    base: `http://127.0.0.1:${port}`,
    requests,
    last: () => requests[requests.length - 1] || null,
    close: () => new Promise((r) => server.close(r))
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
async function startProxyInBox ({ env = {} } = {}) {
  proxyOutput.length = 0
  proxyStartedAt = Date.now()
  // `exec` + pidfile: matar el `docker exec` de afuera NO mata lo que corre
  // adentro. Con `exec`, la shell se convierte EN el proceso, así que `$$` es su
  // pid de verdad y se le puede mandar una señal.
  proxyProc = proxyBox.launch('cd /eco/dotrino-proxy && echo $$ > /data/proxy.pid && exec node server.js', {
    env: {
      PORT: String(proxyPort),
      PROXY_DB_FILE: '/data/proxy.db',
      VAULT_SERVICE_DIR: '/data/vault-service',
      ...env
    },
    onLine: (l) => { proxyOutput.push(l); log('[proxy] ' + l) }
  })
  await waitPort(proxyPort, 25000)
  return proxyProc
}

/** Manda una señal a lo que apunte un pidfile dentro de una caja. */
function killByPidfile (box, pidfile, sig = 'TERM') {
  box.exec(`[ -f ${pidfile} ] && kill -${sig} $(cat ${pidfile}) 2>/dev/null || true`)
}

async function stopProxy () {
  if (!proxyProc) return
  killByPidfile(proxyBox, '/data/proxy.pid')
  try { proxyProc.kill('SIGTERM') } catch (_) {}
  proxyProc = null
  // El puerto libre es la única señal fiable de que murió: `kill` vuelve enseguida
  // y el proxio se toma su tiempo cerrando conexiones.
  await waitFor(async () => {
    try { await waitPort(proxyPort, 400); return false } catch (_) { return true }
  }, { timeoutMs: 20000, what: 'the proxy to release the port' })
    .catch(async (e) => { killByPidfile(proxyBox, '/data/proxy.pid', 'KILL'); await sleep(1000); throw e })
}

async function startVaultInBox () {
  const output = []
  vaultProc = vaultBox.launch(`echo $$ > /data/vault.pid && exec ${BINARY}`, {
    env: { DOTRINO_VAULT_DIR: '/data/vault', PROXY_URL: `ws://127.0.0.1:${proxyPort}` },
    onLine: (l) => { output.push(l); log('[vault] ' + l) }
  })
  await waitFor(() => output.some((l) => l.includes('servicio listo')), { what: 'the vault to start' })
    .catch(() => { throw new Error('the vault (binary) did not start:\n' + output.join('\n')) })
  return output
}

async function stopVault () {
  killByPidfile(vaultBox, '/data/vault.pid')
  try { vaultProc?.kill('SIGTERM') } catch (_) {}
  vaultProc = null
  // La bóveda deja un candado sobre su directorio de datos: mientras no lo suelte,
  // la siguiente se niega a arrancar («ya hay una bóveda corriendo»).
  await waitFor(() => {
    const r = vaultBox.exec('[ -f /data/vault.pid ] && kill -0 $(cat /data/vault.pid) 2>/dev/null && echo alive || echo dead')
    return (r.stdout || '').includes('dead')
  }, { timeoutMs: 15000, what: 'the vault to release its data' })
}

const ctl = (cmd) => vaultBox.exec(`${BINARY} --ctl ${cmd}`, { env: { DOTRINO_VAULT_DIR: '/data/vault' } })
const setSecret = (ns, k, v) => ctl(`secret set ${ns} ${k} ${v}`)

/**
 * `pair --service <ns>` y devuelve el objeto de la invitación.
 *
 * Se parsea con `parseInvite` y NO buscando una línea JSON: el CLI dejó de
 * imprimir JSON cuando la invitación estrenó marca de formato — ahora imprime la
 * URL del QR y el código compacto. `devices.mjs` todavía espera `{"v":2` y
 * por eso se quedaba colgado.
 */
async function openPairing (service) {
  const lines = []
  vaultBox.launch(`${BINARY} --ctl pair --service ${service}`, {
    env: { DOTRINO_VAULT_DIR: '/data/vault' },
    onLine: (l) => { lines.push(l.trim()); log('[pair] ' + l) }
  })
  const qr = await waitFor(() => {
    for (const l of lines) {
      if (!l || l.length < 20) continue
      const o = parseInvite(l)
      if (o?.sn) return o
    }
    return null
  }, { what: 'the invitation printed by `pair --service`' })
  return qr
}

// ─────────────────────────── el cliente que mira ───────────────────────────

/**
 * Pide credenciales TURN como lo haría una app: cliente real, identificado con una
 * llave nueva. La llave es nueva EN CADA PREGUNTA a propósito — el emisor cachea
 * por pubkey, así que reusarla devolvería la respuesta vieja y la prueba diría
 * cualquier cosa.
 *
 * @returns {{enabled:boolean, issuer?:string, keyId?:string, ttl?:string}}
 */
async function askTurn () {
  const { WebSocketProxyClient } = await import(path.join(ROOT, 'dotrino-proxy-client/src/index.js'))
  const { makeDeviceKey, signWithDevice } = await import(path.join(ROOT, 'dotrino-identity/vault/capabilities.js'))

  const device = await makeDeviceKey({ label: 'watcher' })
  const c = new WebSocketProxyClient({ url: `ws://127.0.0.1:${proxyPort}`, enableWebRTC: false, autoReconnect: false })
  await c.connect()
  try {
    const sign = async (d) => (await signWithDevice({ privateJwk: device.privateJwk, data: d })).signature
    const data = { op: 'identify', publickey: device.publickey, token: c.token, ts: Date.now() }
    await c.identify({ data, signature: await sign(data) })

    // Por la API real del cliente: el pedido va FIRMADO (el proxio sólo emite a
    // conexiones identificadas, para no ser un relay abierto). Mandarlo a mano
    // como un mensaje suelto no llega a ninguna parte.
    const res = await c.getTurnCredentials({ publicKey: device.publickey, sign })

    if (!res.enabled) return { enabled: false }
    const [issuer, keyId, ttl] = String(res.iceServers?.[0]?.username || '').split('|')
    return { enabled: true, issuer, keyId, ttl }
  } finally { c.close() }
}

/**
 * Lo que el proxio publica sobre su relación con la bóveda: `null` = al día, o
 * `{ reason, since }` si hay configuración nueva que no aplicó. Va en `GET /peers`
 * y no en un log porque el proxio no se reinicia solo: el pendiente tiene que
 * quedar donde se vea sin ir a leer archivos.
 */
async function vaultStatus () {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/peers`).catch(() => null)
  if (!res?.ok) return null
  return (await res.json()).vault ?? null
}

// ─────────────────────────── escenarios ───────────────────────────

scenario('without a vault, the proxy runs on its .env (the self-hosting mode)', async () => {
  await startProxyInBox({
    env: {
      TURN_KEY_ID: ENV_KEY_ID,
      TURN_KEY_API_TOKEN: 'token-from-env',
      TURN_API_BASE: fakeEnv.base
    }
  })

  const turn = await askTurn()
  assert.equal(turn.enabled, true, 'with keys in the .env, TURN works without any vault')
  assert.equal(turn.issuer, 'env', 'and the credentials come from the target the .env names')
  assert.equal(turn.keyId, ENV_KEY_ID)

  // Sin enrolar no se pide nada a nadie: ni una línea de vault en el log.
  assert.ok(!proxyOutput.some((l) => l.includes('[vault]')),
    'an unenrolled proxy says nothing about vaults')
})

scenario('the proxy enrolls and the vault HANDS it the config: it overrides the .env', async () => {
  await startVaultInBox()

  // El dueño carga en la bóveda lo que de verdad debe regir.
  setSecret('proxy', 'TURN_KEY_ID', VAULT_KEY_ID)
  setSecret('proxy', 'TURN_KEY_API_TOKEN', 'token-from-vault')
  setSecret('proxy', 'TURN_API_BASE', fakeVault.base)
  const listing = ctl('secret list').stdout || ''
  assert.match(listing, /TURN_KEY_ID/, 'the vault stores the proxy drawer')

  // Enrolar: el camino real, el mismo comando que corre un operador.
  const qr = await openPairing('proxy')
  proxyBox.write('/data/invitation.txt', JSON.stringify(qr))
  const lines = []
  proxyBox.launch("cd /eco/dotrino-proxy && node enroll-vault.js \"$(cat /data/invitation.txt)\"", {
    env: { VAULT_SERVICE_DIR: '/data/vault-service' },
    onLine: (l) => { lines.push(l.trim()); log('[enrol] ' + l) }
  })
  const code = await waitFor(() => {
    const l = lines.find((x) => /approve\s+([A-Z0-9-]{4,})/i.test(x))
    return l ? l.match(/approve\s+([A-Z0-9-]{4,})/i)[1] : null
  }, { what: 'the approval code shown by the proxy' })
  ctl(`approve ${code}`)
  await waitFor(() => proxyBox.read('/data/vault-service/service-identity.json'),
    { what: 'the service identity on the proxy disk' })

  // En el acta entra como SERVICIO con su CN, no como un dispositivo del dueño.
  assert.match(ctl('members').stdout || '', /proxy/, 'the proxy is in the record as a service')

  // Reiniciar con el MISMO .env viejo: es el caso real, nadie fue a limpiarlo.
  await stopProxy()
  await startProxyInBox({
    env: {
      TURN_KEY_ID: ENV_KEY_ID,
      TURN_KEY_API_TOKEN: 'token-from-env',
      TURN_API_BASE: fakeEnv.base
    }
  })

  await waitFor(() => proxyOutput.some((l) => l.includes('value(s) from the vault to the environment')),
    { what: 'the vault config to arrive' })

  // El log lo dice…
  const overridden = proxyOutput.find((l) => l.includes("override this machine's .env"))
  assert.ok(overridden, 'the proxy says which .env keys it had to override')
  assert.match(overridden, /TURN_KEY_ID/)

  // …pero la prueba es de caja negra: ¿a qué Cloudflare le pega ahora?
  const before = fakeVault.requests.length
  const turn = await askTurn()
  assert.equal(turn.enabled, true)
  assert.equal(turn.issuer, 'vault', 'the credentials come from the target the VAULT names, not the .env')
  assert.equal(turn.keyId, VAULT_KEY_ID, 'and with the vault key, not the old one from the .env')
  assert.equal(fakeVault.requests.length, before + 1, 'the request reached the vault fake')
  assert.equal(fakeVault.last().auth, 'Bearer token-from-vault', 'even the token is the vault one')
})

scenario('WITHOUT A PASSWORD the vault still seals: the value is not in the clear on its disk', async () => {
  // La bóveda de este smoke no tiene contraseña, que es como arranca cualquiera. Eso
  // NO significa «sin cifrar»: las variables privadas siguen selladas a la llave de
  // cada aparato, y lo único que cambia es con qué se abre la copia maestra (la llave
  // de esta máquina en vez de una frase).
  //
  // La diferencia práctica es honesta y hay que decirla: como el material de esa llave
  // vive en el mismo disco, quien se lleve el disco la reconstruye. Lo que se comprueba
  // aquí es que la maquinaria está puesta —los sobres son sobres— para que el día que
  // haya frase proteja de verdad sin migrar nada.
  const dir = '/data/vault'
  // El valor del vault que está en efecto ahora mismo (privado por defecto).
  const wanted = VAULT_KEY_ID

  // 1. En el archivo, tal cual: ni rastro del valor. Va cifrado en reposo Y sellado.
  // El archivo puede estar en el dir del perfil o en la raíz, según cómo se creó.
  const where = (vaultBox.exec(`find ${dir} -name secrets.json 2>/dev/null | head -1`).stdout || '').trim()
  assert.ok(where, `there should be a secrets.json under ${dir}`)
  const raw = vaultBox.exec(`head -c 4000 ${where}`).stdout || ''
  assert.ok(!raw.includes(wanted), 'the value of a private variable must NOT appear in the file')

  // 2. Y la lista de la propia bóveda lo tapa, en vez de enseñarlo.
  const list = ctl('secret list').stdout || ''
  assert.ok(list.includes('TURN_KEY_ID'), 'the variable must be there')
  assert.ok(!list.includes(wanted), 'but its value is not shown: it is private')

  // 3. Lo definitivo: el proxio SÍ lo está usando. O sea que el sobre se abre por el
  //    camino bueno —con la llave del aparato— aunque el archivo sea ilegible.
  const turn = await askTurn()
  assert.equal(turn.issuer, 'vault', 'the proxy uses the vault value, which it only gets by opening its envelope')
  assert.equal(turn.keyId, wanted, 'and it is exactly the sealed value, opened with the device key')
})

scenario('the proxy does NOT wait for the vault: with it down, transport still works', async () => {
  // Es LA excepción del ecosistema, y no por importancia: el vault le habla a sus
  // servicios POR el proxio, así que un proxio que lo espera espera a alguien que
  // necesita el proxio escuchando. Todos los demás agentes sí esperan.
  await stopVault()
  await stopProxy()
  await startProxyInBox({
    env: {
      TURN_KEY_ID: ENV_KEY_ID,
      TURN_KEY_API_TOKEN: 'token-from-env',
      TURN_API_BASE: fakeEnv.base
    }
  })

  // Enrolado y sin bóveda: aun así atiende. Esto es lo que se está probando.
  const turn = await askTurn()
  assert.equal(turn.enabled, true, 'transport and its features start without a vault')
  assert.equal(turn.issuer, 'env', 'it uses what it has, its .env — it does not sit waiting')

  await waitFor(() => proxyOutput.some((l) => /\[vault\].*waiting for the vault config/.test(l)),
    { what: 'the notice that it is waiting for the vault' })

  // El primer reintento no es inmediato: el pedido se encola para una bóveda que
  // no está y la espera de respuesta tarda ~30 s en rendirse. Mirar antes de eso
  // no probaría nada.
  await waitFor(() => proxyOutput.some((l) => /no config yet/.test(l)),
    { timeoutMs: 60000, what: 'a retry instead of giving up' })
})

scenario('rotating in the vault does NOT arrive live; it arrives on restart', async () => {
  // El límite real de hoy, fijado como hecho comprobado y no como sorpresa: la
  // configuración se pide UNA vez por arranque. Cambiarla en la bóveda mientras el
  // agente corre no le llega — hace falta reiniciarlo.
  // Se reinicia el proxio en vez de esperar a que le toque el siguiente reintento:
  // el backoff llega a 60 s y el test acabaría midiendo la paciencia del bucle en
  // lugar de lo que interesa, que es de dónde sale el valor.
  await startVaultInBox()
  await stopProxy()
  await startProxyInBox({
    env: { TURN_KEY_ID: ENV_KEY_ID, TURN_KEY_API_TOKEN: 'token-from-env', TURN_API_BASE: fakeEnv.base }
  })
  await waitFor(() => proxyOutput.some((l) => l.includes('value(s) from the vault to the environment')),
    { timeoutMs: 60000, what: 'the vault to come back and deliver the config' })
  assert.equal((await askTurn()).keyId, VAULT_KEY_ID, 'with the vault back, the vault wins')

  setSecret('proxy', 'TURN_KEY_ID', VAULT_KEY_ROTATED)
  await sleep(1500)
  assert.equal((await askTurn()).keyId, VAULT_KEY_ID,
    'the running proxy does NOT notice the change: there is no live reload')

  await stopProxy()
  await startProxyInBox({
    env: { TURN_KEY_ID: ENV_KEY_ID, TURN_KEY_API_TOKEN: 'token-from-env', TURN_API_BASE: fakeEnv.base }
  })
  await waitFor(() => proxyOutput.some((l) => l.includes('value(s) from the vault to the environment')),
    { what: 'the config after the restart' })
  assert.equal((await askTurn()).keyId, VAULT_KEY_ROTATED, 'once restarted, it takes the rotated value')
})

scenario('the vault ANNOUNCES the change and the proxy shows it without restarting', async () => {
  // El proxio es el único agente que NO se apaga al recibir el aviso: reiniciarlo
  // corta las conexiones de todo el ecosistema —incluida la de la bóveda que mandó
  // el aviso—, así que ahí un fallo no se degrada, se cae todo. Lo anota y lo
  // publica en `GET /peers`; el momento del reinicio lo elige un humano.
  // El resto de los agentes sí salen, y su supervisor los levanta limpios.
  assert.equal(await vaultStatus(), null, 'before the notice, the proxy is up to date')

  // PRIMERO, la defensa: un aviso que llega RECIÉN ARRANCADO se ignora a propósito.
  // Sin esa gracia, una configuración que rompe el arranque haría un ciclo —el
  // agente sale, el supervisor lo levanta, vuelve a salir— y esto lo comprueba en
  // vez de esperar a que alguien lo descubra en producción.
  setSecret('proxy', 'TURN_KEY_ID', 'rotated-within-grace')
  await waitFor(() => proxyOutput.some((l) => /right after start: ignored/.test(l)),
    { timeoutMs: 30000, what: 'the startup grace to drop the notice' })
  assert.equal(await vaultStatus(), null, 'within the grace, the notice leaves nothing pending')

  // Y AHORA sí, pasada la gracia (30 s desde que arrancó este proxio).
  await waitFor(() => Date.now() - proxyStartedAt > 31000, { timeoutMs: 40000, what: 'the startup grace to pass' })
  setSecret('proxy', 'TURN_KEY_ID', 'rotated-by-notice')

  const pending = await waitFor(async () => await vaultStatus(), { timeoutMs: 30000, what: 'the vault notice' })
  assert.equal(pending.reason, 'changed')
  assert.ok(Date.parse(pending.since) > 0, 'it says since when something is unapplied')

  assert.ok(proxyOutput.some((l) => /NEW config in the vault/.test(l)),
    'and it also says so in the log')

  // Sigue sirviendo: no se reinició ni se quedó a medias.
  assert.equal((await askTurn()).keyId, VAULT_KEY_ROTATED,
    'it keeps the config it had; the notice does not change it by itself')
})

scenario('it warns about what arrived late and is not in effect until restart', async () => {
  // Consecuencia honesta de no esperar: lo que sólo se lee al arrancar queda en el
  // entorno pero no cambia nada hasta el próximo reinicio. Callarlo sería la
  // diferencia entre rotar y creer que rotaste.
  setSecret('proxy', 'PROXY_MAX_FANOUT', '7')
  await stopProxy()
  await startProxyInBox({
    env: { TURN_KEY_ID: ENV_KEY_ID, TURN_KEY_API_TOKEN: 'token-from-env', TURN_API_BASE: fakeEnv.base }
  })
  const notice = await waitFor(
    () => proxyOutput.find((l) => l.includes('only read at startup')),
    { what: 'the notice about late variables' }
  )
  assert.match(notice, /PROXY_MAX_FANOUT/, 'it names exactly which one arrived late')
})

// ─────────────────────────── arranque ───────────────────────────

if (!fs.existsSync(path.join(ROOT, 'dotrino-vault/dist/dotrino-vaultd'))) {
  console.error('\nMissing the vault binary. Build it:\n  cd dotrino-vault && bash packaging/build.sh\n')
  process.exit(2)
}

console.log('\nSMOKE · PROXY ↔ VAULT configuration (each in its own box)\n')
let allOk = false
try {
  proxyPort = await freePort()
  fakeEnv = await startFakeCloudflare('env')
  fakeVault = await startFakeCloudflare('vault')

  proxyBox = createBox('proxy')
  vaultBox = createBox('vault')
  console.log(`  engine: ${proxyBox.engine} · proxy at ws://127.0.0.1:${proxyPort}`)
  // El binario trae Node dentro pero espera `libatomic1` del sistema (lo destapó
  // `devices.mjs` en un Debian limpio). En una caja mínima hay que ponerla.
  if (vaultBox.engine === 'docker') {
    vaultBox.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  }

  allOk = await runScenarios()   // `runScenarios()` devuelve un booleano, no un código de salida
} catch (e) {
  console.error('\n✖ ' + (e?.stack || e?.message || e))
  allOk = false
} finally {
  await stopProxy().catch(() => {})
  await stopVault().catch(() => {})
  await fakeEnv?.close()
  await fakeVault?.close()
  destroyBoxes()
  await teardown()
}
process.exit(allOk ? 0 : 1)
