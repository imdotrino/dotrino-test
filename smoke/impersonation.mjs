/**
 * SUPLANTACIÓN DE IDENTIDAD — ¿se puede hacerse pasar por otro en terminal + vault?
 *
 * Auditoría de seguridad del camino de identidad de la terminal y la bóveda. Levanta el
 * ecosistema real en local (proxio + daemon de la bóveda + el cliente de verdad, por ruta
 * desde sus repos) e intenta, de propósito, lo que un atacante haría. Cada escenario es un
 * ataque que DEBE fallar: si algún día uno pasa, esto se pone en rojo.
 *
 *   node smoke/impersonation.mjs            (o `npm run smoke:impersonation`)
 *   node smoke/impersonation.mjs --verbose  (con los logs del proxio y de la bóveda)
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
import { scenario, runScenarios, startProxy, startVault, teardown, ROOT, tmpDir } from './lib/harness.js'
import { sleep } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

// El código REAL, por ruta desde sus repos — como el resto de smokes. Si el protocolo
// cambia, el ataque se re-evalúa contra el código nuevo, no contra una copia.
const { enroll, requestSign } = await import(path.join(ROOT, 'dotrino-vault/src/client.js'))
const { Identity } = await import(path.join(ROOT, 'dotrino-identity/src/node.js'))
const { signWithDevice, makeDeviceKey } = await import(path.join(ROOT, 'dotrino-identity/vault/capabilities.js'))

let proxy = null
let vault = null

/** Enrola un aparato como lo haría el de verdad y devuelve `{ device, cert, iss, acta }`. */
async function enrollDevice (label) {
  const qr = await vault.pair({ label })
  let code = null
  const p = enroll({ qr, label, dir: tmpDir('dev-' + label), onChallenge: (c) => { code = c.code } })
  await vault.waitPending()
  const t = Date.now() + 5000
  while (!code && Date.now() < t) await sleep(50)
  assert.ok(code, 'the device shows its code')
  vault.approve(code)
  return p
}

// ---------------------------------------------------------------------------
// A · PERSONA FALSA EN EL PROXIO
// ---------------------------------------------------------------------------
scenario('A · forging a record with the victim\'s profileId does NOT bind their profile on the proxy', async () => {
  const victim = vault.acta()               // la víctima: el perfil de la bóveda
  const { WebSocketProxyClient } = await import(path.join(ROOT, 'dotrino-proxy-client/src/index.js'))

  // El atacante es un aparato cualquiera con SU propia llave. Nunca entró en el acta.
  const attacker = await makeDeviceKey({ label: 'attacker' })

  // Se identifica en el proxio presentando un acta INVENTADA. El proxio ata el token al
  // `profileId` solo si el acta se sostiene (verifyActaMembership). Probamos las dos formas
  // en que un atacante intentaría colarla.
  const identifyWith = async (record) => {
    const c = new WebSocketProxyClient({ url: proxy.url, enableWebRTC: false, autoReconnect: false })
    await c.connect()
    const data = { op: 'identify', publickey: attacker.publickey, token: c.token, ts: Date.now() }
    const { signature } = await signWithDevice({ privateJwk: attacker.privateJwk, data })
    const out = await c.identify({ data, signature, acta: record })
    c.close()
    return out
  }

  // (1) Robo del profileId: el atacante dice ser el perfil de la víctima, se nombra sellador
  //     y FIRMA CON SU PROPIA LLAVE. La firma no cuadra con la llave del perfil → se cae.
  const theftBody = {
    v: victim.v, profileId: victim.profileId, sealedBy: victim.profileId, seq: 1,
    members: [{ pub: attacker.publickey, caps: ['sign', 'sealer'] }]
  }
  const { signature: fakeSig } = await signWithDevice({ privateJwk: attacker.privateJwk, data: theftBody })
  const theft = { ...theftBody, sig: fakeSig }
  const r1 = await identifyWith(theft)
  assert.equal(r1.profile, null, 'a record signed with another key does not bind the victim\'s profile')
  assert.equal(r1.publickey, attacker.publickey, 'the attacker\'s normal identify does work (it is only itself)')

  // (2) Acta coherente consigo misma pero con el profileId de la víctima: el atacante firma
  //     como `sealedBy` = su propia llave (la firma cuadra) pero declara el profileId ajeno.
  //     El proxio exige `sealedBy === profileId` → se cae igual.
  const spoofBody = {
    v: victim.v, profileId: victim.profileId, sealedBy: attacker.publickey, seq: 1,
    members: [{ pub: attacker.publickey, caps: ['sign', 'sealer'] }]
  }
  const { signature: consistentSig } = await signWithDevice({ privateJwk: attacker.privateJwk, data: spoofBody })
  const r2 = await identifyWith({ ...spoofBody, sig: consistentSig })
  assert.equal(r2.profile, null, 'a record whose sealer is not the profileId does not bind that profile')

  // (3) Corromper el acta REAL de la víctima (añadirse un miembro) rompe su firma.
  const tampered = { ...victim, members: [...victim.members, { pub: attacker.publickey, caps: ['sign'] }] }
  const r3 = await identifyWith(tampered)
  assert.equal(r3.profile, null, 'tampering with the real record breaks its signature: nothing is bound')
})

// ---------------------------------------------------------------------------
// B · FIRMANTE NO ADMITIDO
// ---------------------------------------------------------------------------
scenario('B · a device without a valid cert cannot get the vault to sign for the person', async () => {
  const legit = await enrollDevice('legit-b')
  const res = await legit

  // (1) Un aparato que nunca se enroló NO tiene cert. Pedir firma sin cert no cuela.
  const outsider = await makeDeviceKey({ label: 'outsider' })
  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url,
      device: outsider, cert: null, payload: { want: 'your signature' }, dir: tmpDir('sign-no-cert')
    }),
    /unauthorized|no autorizado|shape|cert/i,
    'without a certificate, the vault does not sign'
  )

  // (2) Robar el cert de otro no sirve: el cert ata al aparato (`sub`), así que firmar con la
  //     llave del forastero y presentar el cert del legítimo rompe la cadena (`cert.sub !== D`).
  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url,
      device: outsider, cert: res.cert, payload: { theft: 'a cert' }, dir: tmpDir('sign-stolen-cert')
    }),
    /unauthorized|no autorizado|mismatch|cert/i,
    'someone else\'s cert is useless: it is bound to its owner\'s key'
  )

  // (3) Manosear el cert legítimo (cambiarle el scope para pedir más) rompe la firma de la maestra.
  const certWithMoreScope = { ...res.cert, scope: Array.isArray(res.cert.scope) ? [...res.cert.scope, 'vault:admin'] : [res.cert.scope, 'vault:admin'] }
  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url,
      device: res.device, cert: certWithMoreScope, payload: { raise: 'privileges' }, dir: tmpDir('sign-scope')
    }),
    /unauthorized|no autorizado|signature|cert/i,
    'changing the cert scope breaks the master signature'
  )
})

// ---------------------------------------------------------------------------
// C · PERMISO RETIRADO EN EL ACTA, PERO EL PAPEL SIGUE VIGENTE
// ---------------------------------------------------------------------------
scenario('C · removing `sign` in the record stops signing EVEN THOUGH the 30-day cert is still valid', async () => {
  const res = await (await enrollDevice('legit-c'))

  // Con el permiso puesto, la bóveda le firma lo que pida.
  const ok = await requestSign({
    masterPubkey: vault.iss, proxyUrl: proxy.url,
    device: res.device, cert: res.cert, payload: { hello: 'world' }, dir: tmpDir('sign-c-ok')
  })
  assert.ok(ok.signature, 'with `sign` in the record, it signs')

  // El dueño le quita `sign` (le deja solo `read`). Esto SUBE el seq del acta pero NO reemite
  // ni revoca el cert del aparato: su papel sigue diciendo `vault:sign` hasta 30 días.
  await vault.caps(res.device.publickey, ['read'])
  await sleep(1200)
  const record = await vault.members()
  assert.deepEqual(record.members.find((m) => m.pub === res.device.publickey).caps, ['read'],
    'the record no longer grants signing')

  // El ataque: presentar el MISMO cert vigente y pedir firma. El acta manda sobre el papel.
  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url,
      device: res.device, cert: res.cert, payload: { sign: 'anyway' }, dir: tmpDir('sign-c-ko')
    }),
    /unauthorized|no autorizado|acta/i,
    'with the permission removed, the vault does not sign even if the cert is alive'
  )
})

// ---------------------------------------------------------------------------
// D · REPLAY DE HANDSHAKE contra el agente de la terminal
// ---------------------------------------------------------------------------
scenario('D · replaying a captured handshake does NOT open a session with the agent (freshness ±5 min)', async () => {
  // El agente remoto, con un transporte DE MENTIRA inyectado (seam documentado de
  // `startRemoteAgent`): así se prueba el guardia anti-replay sin red ni PTY. El guardia de
  // frescura corre ANTES de verificar la cadena, así que el saludo viejo se rechaza por su
  // `ts`, sea cual sea el cert — que es justo lo que protege.
  const { startRemoteAgent } = await import(path.join(ROOT, 'dotrino-remote-agent/src/agent.js'))
  const { signWithDevice: raSign, makeDeviceKey: raMakeKey } = await import(path.join(ROOT, 'dotrino-remote-agent/node_modules/@dotrino/identity/vault/capabilities.js'))
  const { HS, ERROR } = await import(path.join(ROOT, 'dotrino-remote-agent/protocol.js'))

  const clientKey = await raMakeKey({ label: 'client' })
  const agentKey = await raMakeKey({ label: 'agent' })

  // Enlace mínimo: lo justo para que el agente arranque. El cert es de pega a propósito —
  // el saludo viejo muere en la frescura, antes de que el cert importe.
  const link = {
    device: agentKey,
    cert: { v: 1, iss: agentKey.publickey, sub: agentKey.publickey, scope: 'vault:sign', iat: Date.now(), seq: 1, nonce: 'x' },
    iss: agentKey.publickey,
    proxy: proxy.url
  }

  const sent = []
  const listeners = []
  const fake = {
    token: 'tok-agent',
    on (ev, cb) { if (ev === 'message') listeners.push(cb); return () => {} },
    async identifyAs () {},
    sendByPubkey () {},
    send (to, obj) { sent.push({ to, obj }) },
    close () {},
    deliver (from, payload) { for (const h of listeners) h(from, payload) }
  }

  const agent = await startRemoteAgent({ label: 'terminal-agent', dir: tmpDir('agent-d'), link, quiet: !VERBOSE, client: fake })

  // Un saludo bien formado y firmado. Se captura y se reproduce dos veces.
  const makeHs = (ts) => signWithDevHS(clientKey, raSign, ts)

  // (1) Reproducido TARDE (ts de hace 10 min) → rechazado por frescura (posible replay).
  sent.length = 0
  fake.deliver('tok-client', { type: HS, ...(await makeHs(Date.now() - 10 * 60 * 1000)) })
  await sleep(300)
  const stale = sent.find((e) => e.obj?.type === ERROR)
  assert.ok(stale, 'the agent answers the stale handshake with an error')
  assert.match(stale.obj.error, /vencido|replay|expired/i, 'and rejects it as expired / replay')

  // (2) El mismo saludo, FRESCO, pasa la frescura (y recién ahí falla por la cadena de pega):
  //     prueba que el rechazo de (1) fue por el `ts`, no porque todo saludo se caiga.
  sent.length = 0
  fake.deliver('tok-client', { type: HS, ...(await makeHs(Date.now())) })
  await sleep(300)
  const fresh = sent.find((e) => e.obj?.type === ERROR)
  assert.ok(fresh, 'the fresh handshake also ends in an error (dummy cert)')
  assert.doesNotMatch(fresh.obj.error, /vencido|replay|expired/i,
    'but NOT for freshness: it passed the anti-replay guard and failed later (unauthorized)')

  agent.close()
})

/** Arma un `ra.hs` firmado por el cliente con el `ts` dado. */
async function signWithDevHS (clientKey, raSign, ts) {
  const eph = Buffer.from(await import('node:crypto').then((c) => c.randomBytes(16))).toString('base64')
  const data = { op: 'ra.hs', eph, publickey: clientKey.publickey, ts }
  const { signature } = await raSign({ privateJwk: clientKey.privateJwk, data })
  return { data, signature, cert: { v: 1, iss: clientKey.publickey, sub: clientKey.publickey, scope: 'vault:sign', iat: ts, seq: 1, nonce: 'y' } }
}

// ----- arranque -----
console.log('\nIMPERSONATION · terminal + vault (proxy + vault + real client, all local)\n')
try {
  proxy = await startProxy({ log })
  console.log(`  local proxy at ${proxy.url}`)
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  console.log(`  vault with identity ${vault.state.fingerprint}\n`)
  const ok = await runScenarios()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  await teardown()
  process.exit(1)
}
