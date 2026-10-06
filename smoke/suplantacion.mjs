/**
 * SUPLANTACIÓN DE IDENTIDAD — ¿se puede hacerse pasar por otro en terminal + vault?
 *
 * Auditoría de seguridad del camino de identidad de la terminal y la bóveda. Levanta el
 * ecosistema real en local (proxio + daemon de la bóveda + el cliente de verdad, por ruta
 * desde sus repos) e intenta, de propósito, lo que un atacante haría. Cada escenario es un
 * ataque que DEBE fallar: si algún día uno pasa, esto se pone en rojo.
 *
 *   node smoke/suplantacion.mjs            (o `npm run smoke:suplantacion`)
 *   node smoke/suplantacion.mjs --verbose  (con los logs del proxio y de la bóveda)
 *
 * Los cuatro ataques:
 *   A · PERSONA FALSA EN EL PROXIO — fabricar un acta con el `profileId` de la víctima para
 *       que el proxio ate su token al perfil ajeno (robo de sus mensajes dirigidos).
 *   B · FIRMANTE NO ADMITIDO — un aparato que nunca entró al acta pide a la bóveda que firme
 *       por la persona, y manosear un cert legítimo (otro `sub`, otro `scope`).
 *   C · PERMISO RETIRADO, PAPEL VIGENTE — quitarle `sign` a un aparato en el acta NO reemite
 *       su cert de 30 días; con el papel viejo en la mano, ¿sigue firmando la bóveda?
 *   D · REPLAY DE HANDSHAKE — reproducir un saludo capturado contra el agente de la terminal.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { escenario, correr, startProxy, startVault, teardown, ROOT, tmpDir } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// El código REAL, por ruta desde sus repos — como el resto de smokes. Si el protocolo
// cambia, el ataque se re-evalúa contra el código nuevo, no contra una copia.
const { enroll, requestSign } = await import(path.join(ROOT, 'dotrino-vault/src/client.js'))
const { Identity } = await import(path.join(ROOT, 'dotrino-identity/src/node.js'))
const { signWithDevice, makeDeviceKey } = await import(path.join(ROOT, 'dotrino-identity/vault/capabilities.js'))

let proxy = null
let vault = null

/** Enrola un aparato como lo haría el de verdad y devuelve `{ device, cert, iss, acta }`. */
async function enrolar (label) {
  const qr = await vault.pair({ label })
  let code = null
  const p = enroll({ qr, label, dir: tmpDir('dev-' + label), onChallenge: (c) => { code = c.code } })
  await vault.waitPending()
  const t = Date.now() + 5000
  while (!code && Date.now() < t) await sleep(50)
  assert.ok(code, 'el aparato muestra su código')
  vault.approve(code)
  return p
}

// ---------------------------------------------------------------------------
// A · PERSONA FALSA EN EL PROXIO
// ---------------------------------------------------------------------------
escenario('A · fabricar un acta con el profileId de la víctima NO ata su perfil en el proxio', async () => {
  const victima = vault.acta()               // la víctima: el perfil de la bóveda
  const { WebSocketProxyClient } = await import(path.join(ROOT, 'dotrino-proxy-client/src/index.js'))

  // El atacante es un aparato cualquiera con SU propia llave. Nunca entró en el acta.
  const atacante = await makeDeviceKey({ label: 'atacante' })

  // Se identifica en el proxio presentando un acta INVENTADA. El proxio ata el token al
  // `profileId` solo si el acta se sostiene (verifyActaMembership). Probamos las dos formas
  // en que un atacante intentaría colarla.
  const identificarseCon = async (acta) => {
    const c = new WebSocketProxyClient({ url: proxy.url, enableWebRTC: false, autoReconnect: false })
    await c.connect()
    const data = { op: 'identify', publickey: atacante.publickey, token: c.token, ts: Date.now() }
    const { signature } = await signWithDevice({ privateJwk: atacante.privateJwk, data })
    const out = await c.identify({ data, signature, acta })
    c.close()
    return out
  }

  // (1) Robo del profileId: el atacante dice ser el perfil de la víctima, se nombra sellador
  //     y FIRMA CON SU PROPIA LLAVE. La firma no cuadra con la llave del perfil → se cae.
  const roboBody = {
    v: victima.v, profileId: victima.profileId, sealedBy: victima.profileId, seq: 1,
    members: [{ pub: atacante.publickey, caps: ['sign', 'sealer'] }]
  }
  const { signature: firmaFalsa } = await signWithDevice({ privateJwk: atacante.privateJwk, data: roboBody })
  const robo = { ...roboBody, sig: firmaFalsa }
  const r1 = await identificarseCon(robo)
  assert.equal(r1.profile, null, 'el acta firmada con otra llave no ata el perfil de la víctima')
  assert.equal(r1.publickey, atacante.publickey, 'el identify normal del atacante sí funciona (solo es él mismo)')

  // (2) Acta coherente consigo misma pero con el profileId de la víctima: el atacante firma
  //     como `sealedBy` = su propia llave (la firma cuadra) pero declara el profileId ajeno.
  //     El proxio exige `sealedBy === profileId` → se cae igual.
  const suplantaBody = {
    v: victima.v, profileId: victima.profileId, sealedBy: atacante.publickey, seq: 1,
    members: [{ pub: atacante.publickey, caps: ['sign', 'sealer'] }]
  }
  const { signature: firmaCoherente } = await signWithDevice({ privateJwk: atacante.privateJwk, data: suplantaBody })
  const r2 = await identificarseCon({ ...suplantaBody, sig: firmaCoherente })
  assert.equal(r2.profile, null, 'un acta cuyo sellador no es el profileId no ata ese perfil')

  // (3) Corromper el acta REAL de la víctima (añadirse un miembro) rompe su firma.
  const trucada = { ...victima, members: [...victima.members, { pub: atacante.publickey, caps: ['sign'] }] }
  const r3 = await identificarseCon(trucada)
  assert.equal(r3.profile, null, 'manosear el acta real rompe su firma: no ata nada')
})

// ---------------------------------------------------------------------------
// B · FIRMANTE NO ADMITIDO
// ---------------------------------------------------------------------------
escenario('B · un aparato sin cert válido no consigue que la bóveda firme por la persona', async () => {
  const legit = await enrolar('legit-b')
  const res = await legit

  // (1) Un aparato que nunca se enroló NO tiene cert. Pedir firma sin cert no cuela.
  const forastero = await makeDeviceKey({ label: 'forastero' })
  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url,
      device: forastero, cert: null, payload: { quiero: 'tu firma' }, dir: tmpDir('sign-sin-cert')
    }),
    /unauthorized|no autorizado|shape|cert/i,
    'sin certificado, la bóveda no firma'
  )

  // (2) Robar el cert de otro no sirve: el cert ata al aparato (`sub`), así que firmar con la
  //     llave del forastero y presentar el cert del legítimo rompe la cadena (`cert.sub !== D`).
  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url,
      device: forastero, cert: res.cert, payload: { robo: 'de cert' }, dir: tmpDir('sign-cert-robado')
    }),
    /unauthorized|no autorizado|mismatch|cert/i,
    'un cert ajeno no vale: está atado a la llave de su dueño'
  )

  // (3) Manosear el cert legítimo (cambiarle el scope para pedir más) rompe la firma de la maestra.
  const certConMasScope = { ...res.cert, scope: Array.isArray(res.cert.scope) ? [...res.cert.scope, 'vault:admin'] : [res.cert.scope, 'vault:admin'] }
  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url,
      device: res.device, cert: certConMasScope, payload: { subo: 'privilegios' }, dir: tmpDir('sign-scope')
    }),
    /unauthorized|no autorizado|signature|cert/i,
    'cambiarle el scope al cert rompe la firma de la maestra'
  )
})

// ---------------------------------------------------------------------------
// C · PERMISO RETIRADO EN EL ACTA, PERO EL PAPEL SIGUE VIGENTE
// ---------------------------------------------------------------------------
escenario('C · quitarle `sign` en el acta corta la firma AUNQUE el cert de 30 días siga vigente', async () => {
  const res = await (await enrolar('legit-c'))

  // Con el permiso puesto, la bóveda le firma lo que pida.
  const ok = await requestSign({
    masterPubkey: vault.iss, proxyUrl: proxy.url,
    device: res.device, cert: res.cert, payload: { hola: 'mundo' }, dir: tmpDir('sign-c-ok')
  })
  assert.ok(ok.signature, 'con `sign` en el acta, firma')

  // El dueño le quita `sign` (le deja solo `read`). Esto SUBE el seq del acta pero NO reemite
  // ni revoca el cert del aparato: su papel sigue diciendo `vault:sign` hasta 30 días.
  await vault.caps(res.device.publickey, ['read'])
  await sleep(1200)
  const acta = await vault.members()
  assert.deepEqual(acta.members.find((m) => m.pub === res.device.publickey).caps, ['read'],
    'el acta ya no le da firma')

  // El ataque: presentar el MISMO cert vigente y pedir firma. El acta manda sobre el papel.
  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url,
      device: res.device, cert: res.cert, payload: { firmo: 'igual' }, dir: tmpDir('sign-c-ko')
    }),
    /unauthorized|no autorizado|acta/i,
    'con el permiso retirado, la bóveda no firma aunque el cert siga vivo'
  )
})

// ---------------------------------------------------------------------------
// D · REPLAY DE HANDSHAKE contra el agente de la terminal
// ---------------------------------------------------------------------------
escenario('D · reproducir un saludo capturado NO abre sesión con el agente (frescura ±5 min)', async () => {
  // El agente remoto, con un transporte DE MENTIRA inyectado (seam documentado de
  // `startRemoteAgent`): así se prueba el guardia anti-replay sin red ni PTY. El guardia de
  // frescura corre ANTES de verificar la cadena, así que el saludo viejo se rechaza por su
  // `ts`, sea cual sea el cert — que es justo lo que protege.
  const { startRemoteAgent } = await import(path.join(ROOT, 'dotrino-remote-agent/src/agent.js'))
  const { signWithDevice: raSign, makeDeviceKey: raMakeKey } = await import(path.join(ROOT, 'dotrino-remote-agent/node_modules/@dotrino/identity/vault/capabilities.js'))
  const { HS, ERROR } = await import(path.join(ROOT, 'dotrino-remote-agent/protocol.js'))

  const cliente = await raMakeKey({ label: 'cliente' })
  const agenteKey = await raMakeKey({ label: 'agente' })

  // Enlace mínimo: lo justo para que el agente arranque. El cert es de pega a propósito —
  // el saludo viejo muere en la frescura, antes de que el cert importe.
  const link = {
    device: agenteKey,
    cert: { v: 1, iss: agenteKey.publickey, sub: agenteKey.publickey, scope: 'vault:sign', iat: Date.now(), seq: 1, nonce: 'x' },
    iss: agenteKey.publickey,
    proxy: proxy.url
  }

  const enviados = []
  const oyentes = []
  const fake = {
    token: 'tok-agente',
    on (ev, cb) { if (ev === 'message') oyentes.push(cb); return () => {} },
    async identifyAs () {},
    sendByPubkey () {},
    send (to, obj) { enviados.push({ to, obj }) },
    close () {},
    entregar (from, payload) { for (const h of oyentes) h(from, payload) }
  }

  const agente = await startRemoteAgent({ label: 'terminal-agent', dir: tmpDir('agente-d'), link, quiet: !VERBOSE, client: fake })

  // Un saludo bien formado y firmado. Se captura y se reproduce dos veces.
  const makeHs = (ts) => signWithDevHS(cliente, raSign, ts)

  // (1) Reproducido TARDE (ts de hace 10 min) → rechazado por frescura (posible replay).
  enviados.length = 0
  fake.entregar('tok-cliente', { type: HS, ...(await makeHs(Date.now() - 10 * 60 * 1000)) })
  await sleep(300)
  const viejo = enviados.find((e) => e.obj?.type === ERROR)
  assert.ok(viejo, 'el agente contesta un error al saludo viejo')
  assert.match(viejo.obj.error, /vencido|replay|expired/i, 'y lo rechaza como caducado / replay')

  // (2) El mismo saludo, FRESCO, pasa la frescura (y recién ahí falla por la cadena de pega):
  //     prueba que el rechazo de (1) fue por el `ts`, no porque todo saludo se caiga.
  enviados.length = 0
  fake.entregar('tok-cliente', { type: HS, ...(await makeHs(Date.now())) })
  await sleep(300)
  const fresco = enviados.find((e) => e.obj?.type === ERROR)
  assert.ok(fresco, 'el saludo fresco también termina en error (cert de pega)')
  assert.doesNotMatch(fresco.obj.error, /vencido|replay|expired/i,
    'pero NO por frescura: pasó el guardia anti-replay y se cayó más adelante (no autorizado)')

  agente.close()
})

/** Arma un `ra.hs` firmado por el cliente con el `ts` dado. */
async function signWithDevHS (cliente, raSign, ts) {
  const eph = Buffer.from(await import('node:crypto').then((c) => c.randomBytes(16))).toString('base64')
  const data = { op: 'ra.hs', eph, publickey: cliente.publickey, ts }
  const { signature } = await raSign({ privateJwk: cliente.privateJwk, data })
  return { data, signature, cert: { v: 1, iss: cliente.publickey, sub: cliente.publickey, scope: 'vault:sign', iat: ts, seq: 1, nonce: 'y' } }
}

// ----- arranque -----
console.log('\nSUPLANTACIÓN · terminal + vault (proxio + bóveda + cliente real, todo local)\n')
try {
  proxy = await startProxy({ log })
  console.log(`  proxio local en ${proxy.url}`)
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  console.log(`  bóveda con identidad ${vault.state.fingerprint}\n`)
  const ok = await correr()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  await teardown()
  process.exit(1)
}
