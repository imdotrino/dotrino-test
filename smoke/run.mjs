/**
 * SMOKE E2E del ecosistema Dotrino — de punta a punta, en local.
 *
 * Levanta el proxy, una bóveda y varios dispositivos/agentes headless (terminal, ia, bot)
 * y comprueba el camino real: emparejar, aprobar con el código correcto, RECHAZAR el
 * equivocado sin emitir certificado, entrar en el acta del perfil, y que revocar corte el
 * acceso de verdad.
 *
 * Usa el MISMO código que usan las piezas reales (el cliente de dispositivo del vault y
 * `@dotrino/identity`), no una reimplementación: si el protocolo cambia, esto se entera.
 *
 * Correr:  node smoke/run.mjs        (o `npm run smoke`)
 */
import assert from 'node:assert/strict'
// Las aserciones sobre MENSAJES aceptan inglés y español: los mensajes de error del
// ecosistema se migraron a inglés (CONVENCIONES §8.1) y estas pruebas se quedaron
// comprobando la frase vieja — cuatro escenarios en rojo sin que nada estuviera roto.
// Se acepta la forma antigua mientras queden piezas sin migrar.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { scenario, runScenarios, startProxy, startVault, teardown, ROOT, tmpDir } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

// El cliente REAL de dispositivo y la identidad REAL, importados por ruta desde sus repos.
const { enroll, requestSign } = await import(path.join(ROOT, 'dotrino-vault/src/client.js'))
const { Identity } = await import(path.join(ROOT, 'dotrino-identity/src/node.js'))

let proxy = null
let vault = null

/** Un dispositivo/agente headless que se enrola como lo haría el de verdad. */
async function device (vault, { label, onCode } = {}) {
  const qr = await vault.pair({ label })
  let code = null
  const p = enroll({
    qr,
    label,
    dir: tmpDir('dev-' + label),
    onChallenge: (c) => { code = c.code; onCode?.(c) }
  })
  const deviceId = await vault.waitPending()
  // esperar a que el propio dispositivo genere su código (lo muestra en su pantalla)
  const t = Date.now() + 5000
  while (!code && Date.now() < t) await new Promise((r) => setTimeout(r, 50))
  assert.ok(code, 'the device must show a 6-digit code')
  return { qr, deviceId, code, enrolled: p }
}

/**
 * NACE CON DOS MIEMBROS, y el segundo es ella misma.
 *
 * Este escenario decía «un solo miembro» y se quedó atrás: desde que la maestra tiene dos
 * trabajos y ninguno más (dueño, 2026-08-31), quien habla por la red es la LLAVE DE
 * COMUNICACIÓN, y esa llave entra en el acta como un miembro con `cn: 'vault'` y `sign` a
 * secas. Por eso el acta recién nacida va por el sello #3: se estrena, se le añade `sealer`
 * al dueño y se admite la llave.
 *
 * Que la llave esté aquí es lo que permite que la bóveda siga sirviendo con el perfil
 * CERRADO; que solo tenga `sign` es lo que impide que eso sirva para leer nada.
 */
scenario('the vault starts with its record: the owner and its own communication key', async () => {
  assert.ok(vault.iss, 'the vault publishes its identity in state.json')
  const acta = vault.acta()
  assert.ok(acta, 'the vault is born with its record')
  // «Manda ella misma» = la selló su propia llave de perfil. El campo `sealer` que se
  // comparaba aquí no existe: se llama `profileId`, y llevaba tiempo dando `undefined`
  // detrás de otra aserción que fallaba antes.
  assert.equal(acta.profileId, acta.sealedBy, 'it is born governing itself')
  assert.equal(acta.sealerChanged, false)

  const owner = acta.members.find((m) => !m.cn)
  const comm = acta.members.find((m) => m.cn === 'vault')
  assert.equal(acta.members.length, 2, 'the owner and the communication key, nobody else')
  assert.deepEqual([...owner.caps].sort(), ['read', 'sealer', 'sign', 'store'])
  assert.deepEqual(comm.caps, ['sign'], 'the communication key talks; it neither reads nor stores')
})

scenario('pairing: with the right code the cert is issued and the device joins the record', async () => {
  const d = await device(vault, { label: 'celular' })
  vault.approve(d.code)
  const res = await d.enrolled
  assert.ok(res.cert, 'the device receives its certificate')
  assert.equal(res.cert.iss, vault.iss, 'signed by the vault it saw in the code')
  assert.equal(res.cert.sub, res.device.publickey, 'and issued for THIS device')

  const dump = await vault.devices()
  assert.ok((dump.issued || []).some((x) => x.sub === res.device.publickey), 'it is recorded')

  const acta = vault.acta()
  // Tres: el dueño, la llave de comunicación de la bóveda y el celular que acaba de entrar.
  assert.equal(acta.members.length, 3, 'approving also admits into the profile')
  assert.ok(acta.members.some((m) => m.pub === res.device.publickey))
})

scenario('WRONG CODE: no certificate is issued, and then the right one works', async () => {
  const before = vault.acta().members.length
  const d = await device(vault, { label: 'intruso' })

  const wrongCode = String((Number(d.code) + 7) % 1000000).padStart(6, '0')
  vault.approve(wrongCode)
  await new Promise((r) => setTimeout(r, 1200))

  assert.equal(vault.acta().members.length, before, 'nobody joined the profile')
  const dump = await vault.devices()
  const issuedNow = (dump.issued || []).filter((x) => x.label === 'intruso')
  assert.equal(issuedNow.length, 0, 'the master key signed no certificate')

  // El dispositivo sigue esperando: con el código bueno, entra.
  vault.approve(d.code)
  const res = await d.enrolled
  assert.ok(res.cert)
  assert.equal(vault.acta().members.length, before + 1)
})

scenario('headless agents (terminal, ia, bot) enroll with the same protocol', async () => {
  for (const name of ['terminal', 'ia', 'bot']) {
    const d = await device(vault, { label: name })
    vault.approve(d.code)
    const res = await d.enrolled
    assert.ok(res.cert, `${name} receives its certificate`)
    const acta = vault.acta()
    assert.ok(acta.members.some((m) => m.label === name), `${name} is in the record`)
  }
})

scenario('revoking really cuts access', async () => {
  const d = await device(vault, { label: 'perdido' })
  vault.approve(d.code)
  const res = await d.enrolled

  // Antes de revocar, la bóveda le firma lo que le pida.
  const signed = await requestSign({
    masterPubkey: vault.iss, proxyUrl: proxy.url, device: res.device, cert: res.cert,
    payload: { hola: 'mundo' }, dir: tmpDir('sign-ok')
  })
  assert.ok(signed.signature, 'with a valid cert, the vault signs')

  const dump = await vault.devices()
  const delegation = (dump.issued || []).find((x) => x.sub === res.device.publickey)
  vault.revoke(delegation.nonce)
  await new Promise((r) => setTimeout(r, 1200))

  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url, device: res.device, cert: res.cert,
      payload: { hola: 'otra vez' }, dir: tmpDir('sign-ko')
    }),
    /unauthorized|no autorizado/,
    'revoked = the vault stops signing for it'
  )
})

scenario('an existing account is NOT taken over by the vault: one more account is created', async () => {
  // Camino B de `dotrino-vault/docs/vinculacion-de-cuentas.md`. Hasta 2026-07-27 esto
  // sobrescribía la cuenta del aparato sin preguntar —la fusión de cuentas que el modelo
  // prohíbe—; ahora la de aquí queda intacta y la de la bóveda entra como una cuenta MÁS.
  const dir = tmpDir('identidad-previa')
  const me = await Identity.connect({ dir })
  const before = await me.myMembership()
  assert.equal(before.isMaster, true, 'before pairing, it governed its own account')

  // Sin decir de qué cuenta se habla, no se toca nada.
  const qrNoChoice = await vault.pair({ label: 'sin-elegir' })
  await assert.rejects(() => me.enrollDevice(qrNoChoice), /already using an account|ya está usando una cuenta/,
    'it does not overwrite the open account')
  assert.equal((await me.myMembership()).profileId, before.profileId, 'it is still its own')

  const qr = await vault.pair({ label: 'navegador' })
  let code = null
  const off = me.onVault((e) => { if (e.phase === 'challenge') code = e.code })
  const p = me.enrollDevice(qr, { join: 'new' })
  await vault.waitPending()
  const t = Date.now() + 5000
  while (!code && Date.now() < t) await new Promise((r) => setTimeout(r, 50))
  assert.ok(code, 'it shows its code')
  vault.approve(code)
  const res = await p
  off()

  assert.equal(res.ok, true)
  assert.equal(res.join.joined, true)
  const now = await me.myMembership()
  assert.equal(now.profileId, vault.acta().profileId, "the active account is the vault's")
  assert.equal(now.isMaster, false, 'and it does not govern there: the vault does')
  assert.notEqual(now.pubkey ?? now.profileId, before.profileId, 'it joined with a NEW key')

  // Y la cuenta de siempre sigue existiendo, entera, en este mismo aparato.
  const profiles = await me.listProfiles()
  assert.equal(profiles.length, 2, 'both accounts remain')
  const oldProfile = profiles.find((x) => !x.current)
  await me.switchProfile(oldProfile.id)
  me.destroy()
  const dev = await Identity.connect({ dir })
  assert.equal((await dev.myMembership()).profileId, before.profileId, 'intact, with its own record')
  dev.destroy()
})

scenario('WITHOUT a certificate and off when removed: it asks on startup and the vault erases it', async () => {
  // EL CASO QUE SE ESCAPABA. El aviso de expulsión se emite al quitar el aparato y viaja por
  // la cola del proxy, que dura 24 h: si estaba apagado, no llega nunca. Y sin certificado
  // —revocado, vencido o perdido— el aparato no puede firmar, ni leer, ni renovar, así que
  // tampoco tenía forma de preguntar: se quedaba enseñando para siempre una cuenta de la que
  // ya lo habían echado. Ahora, al arrancar, pregunta con su propia llave (que es lo que el
  // acta nombra) y la bóveda le contesta con el aviso FIRMADO.
  const dir = tmpDir('sin-papel')
  const me = await Identity.connect({ dir })
  await me.createProfile('Bóveda', { forVault: true })

  const qr = await vault.pair({ label: 'olvidado' })
  let code = null
  const off = me.onVault((e) => { if (e.phase === 'challenge') code = e.code })
  const p = me.enrollDevice(qr)
  await vault.waitPending()
  const t = Date.now() + 8000
  while (!code && Date.now() < t) await new Promise((r) => setTimeout(r, 50))
  vault.approve(code)
  await p
  off()
  const mine = me.me.publickey
  assert.ok(vault.acta().members.some((m) => m.pub === mine), 'it joined the record')
  me.destroy()

  // Se le quita el papel a mano: ese es el aparato que perdió su certificado.
  const f = path.join(dir, 'identity.json')
  const kv = JSON.parse(fs.readFileSync(f, 'utf8'))
  for (const k of Object.keys(kv)) if (/dotrino\.identity\.vault\.(cert|device)$/.test(k)) delete kv[k]
  fs.writeFileSync(f, JSON.stringify(kv))

  // Y se le echa mientras está apagado: el aviso se emite contra nadie y caduca.
  vault.removeDevice(mine)
  await new Promise((r) => setTimeout(r, 1500))
  assert.ok(!vault.acta().members.some((m) => m.pub === mine), 'the vault no longer has it')

  // Enciende. Al arrancar pregunta, y la respuesta le borra la cuenta de la bóveda.
  const restarted = await Identity.connect({ dir })
  const until = Date.now() + 20000
  let gone = false
  while (Date.now() < until && !gone) {
    const acta = await restarted.profileActa().catch(() => null)
    gone = !acta?.acta || acta.acta.profileId !== vault.acta().profileId
    if (!gone) await new Promise((r) => setTimeout(r, 300))
  }
  restarted.destroy()
  assert.ok(gone, 'the account it was removed from left this device, with nobody pressing anything')
})

scenario('the proxy verifies the record and binds the profile (and rejects a tampered one)', async () => {
  // Un dispositivo enrolado se identifica presentando su cert y su acta.
  const d = await device(vault, { label: 'con-acta' })
  vault.approve(d.code)
  const res = await d.enrolled

  const { WebSocketProxyClient } = await import(path.join(ROOT, 'dotrino-proxy-client/src/index.js'))
  const { signWithDevice } = await import(path.join(ROOT, 'dotrino-identity/vault/capabilities.js'))
  const acta = vault.acta()

  const connect = async (actaToSend) => {
    const c = new WebSocketProxyClient({ url: proxy.url, enableWebRTC: false, autoReconnect: false })
    await c.connect()
    const data = { op: 'identify', publickey: res.device.publickey, token: c.token, ts: Date.now() }
    const { signature } = await signWithDevice({ privateJwk: res.device.privateJwk, data })
    const out = await c.identify({ data, signature, cert: res.cert, acta: actaToSend })
    c.close()
    return out
  }

  const ok = await connect(acta)
  assert.equal(ok.profile, acta.profileId, 'the proxy recognizes the person behind the device')

  // Manipulada: darse a sí mismo un miembro extra rompe la firma → el proxy no la acepta.
  const tampered = { ...acta, members: [...acta.members, { pub: 'pub-inventada', caps: ['sign'] }] }
  const rejected = await connect(tampered)
  assert.equal(rejected.profile, null, 'a tampered record binds nothing')
  assert.equal(rejected.publickey, res.device.publickey, 'but the normal identify still works')
})

scenario('content travels ENCRYPTED: the proxy does not see what you store', async () => {
  const dir = tmpDir('con-contenido')
  const me = await Identity.connect({ dir })
  const qr = await vault.pair({ label: 'con-contenido' })
  let code = null
  const off = me.onVault((e) => { if (e.phase === 'challenge') code = e.code })
  const p = me.enrollDevice(qr, { join: 'new' })
  await vault.waitPending()
  const t = Date.now() + 5000
  while (!code && Date.now() < t) await new Promise((r) => setTimeout(r, 50))
  vault.approve(code)
  await p
  off()

  // Al entrar en el perfil se le envuelve la clave de contenido.
  const key = await me.contentKey()
  assert.ok(key?.cek, "the new member receives the profile's content key")

  // Guardar y leer a través de la bóveda, cifrado de punta a punta.
  const secret = 'esto no lo puede ver el proxy ' + Date.now()
  await me.vaultStore('appendMessage', { threadKey: 'smoke', entry: { id: 'm1', text: secret } })
  const thread = await me.vaultStore('listThread', { threadKey: 'smoke' })
  const texts = JSON.stringify(thread)
  assert.ok(texts.includes(secret), 'the device reads back what it stored')

  // Y en el disco de la bóveda tampoco se ve: el archivo va CIFRADO en reposo con una
  // clave ligada a ESA máquina, así que llevarse el archivo no es llevarse el contenido.
  // (Antes esto guardaba en claro y el smoke lo daba por bueno.)
  const profileDir = path.join(vault.dir, 'p', fs.readdirSync(path.join(vault.dir, 'p'))[0])
  for (const f of ['threads.json', 'vault.json', 'secrets.json', 'identity.json']) {
    const filePath = path.join(profileDir, f)
    if (!fs.existsSync(filePath)) continue
    const stored = fs.readFileSync(filePath, 'utf8')
    assert.ok(stored.startsWith('DOTRINO-ATREST-v1.'), f + ' must be encrypted at rest')
    assert.ok(!stored.includes(secret), f + ' must not leave the content in plain sight')
  }

  // Pero la bóveda sí lo lee: releerlo por el mismo camino devuelve lo guardado.
  const reread = await me.vaultStore('listThread', { threadKey: 'smoke' })
  assert.ok(JSON.stringify(reread).includes(secret), 'encrypted yes, unreadable to its owner no')
})

scenario('the CLI shows the record and changes permissions (`members` / `caps`)', async () => {
  const d = await device(vault, { label: 'con-permisos' })
  vault.approve(d.code)
  const res = await d.enrolled

  const acta = await vault.members()
  assert.ok(acta.members.length >= 2, 'the CLI sees all members')
  const mine = acta.members.find((m) => m.pub === res.device.publickey)
  assert.ok(mine.id.match(/^[0-9A-F]{4}-[0-9A-F]{4}$/), 'with a readable identifier')
  assert.ok(mine.caps.length, 'and its permissions')

  await vault.caps(res.device.publickey, ['read'])
  const after = await vault.members()
  assert.deepEqual(after.members.find((m) => m.pub === res.device.publickey).caps, ['read'],
    'removing permissions from the vault shows in the record')
})

scenario('CN: a service only sees ITS secrets drawer, nothing else', async () => {
  const { enrollService, waitForSecrets, fetchSecrets } = await import(path.join(ROOT, 'dotrino-vault/lib/src/service.js'))

  // La bóveda guarda un secreto para `proxy` y otro para `geo`.
  const setSecret = (ns, k, v) => {
    fs.writeFileSync(path.join(vault.dir, 'secret-request.json'), JSON.stringify({ op: 'set', ns, key: k, value: v }), { mode: 0o600 })
    process.kill(vault.pid, 'SIGUSR2')
    return new Promise((r) => setTimeout(r, 500))
  }
  await setSecret('proxy', 'TURN_KEY', 'solo-del-proxy')
  await setSecret('geo', 'DB_URL', 'solo-del-geo')

  // El servicio `proxy` se enrola con `pair --service proxy`.
  const qr = await vault.pair({ service: 'proxy' })
  const dir = tmpDir('svc-proxy')
  let code = null
  const p = enrollService({ qr, ns: 'proxy', dir, onCode: (c) => { code = typeof c === 'string' ? c : c.code } })
  await vault.waitPending()
  const t = Date.now() + 5000
  while (!code && Date.now() < t) await new Promise((r) => setTimeout(r, 50))
  vault.approve(code)
  await p

  // En el acta entra como SERVICIO con su CN, no como un dispositivo del usuario.
  const acta = await vault.members()
  const svc = acta.members.find((m) => m.cn === 'proxy')
  assert.ok(svc, 'the service is in the record with its name')
  assert.equal(svc.isService, true)
  assert.deepEqual(svc.caps, [], 'without any permission: its name opens its drawer')

  // Lee lo suyo…
  const secrets = await waitForSecrets({ dir, ns: 'proxy' })
  assert.equal((secrets.secrets || secrets).TURN_KEY, 'solo-del-proxy', 'the service reads its own')

  // …y pedir el cajón de otro no cuela.
  await assert.rejects(() => fetchSecrets({ dir, ns: 'geo' }), /unauthorized|no autorizado/,
    "another service's drawer does not open, not even with a valid cert")
})

scenario("messaging the PERSON: both of a contact's devices open the same message", async () => {
  // Bob tiene dos dispositivos en su perfil; Alice es otra persona.
  const bob = await Identity.connect({ dir: tmpDir('bob') })
  const bob2 = await Identity.connect({ dir: tmpDir('bob2') })
  const alice = await Identity.connect({ dir: tmpDir('alice') })

  await bob.admitMember({
    pub: bob2.me.publickey,
    encPub: await bob2.getEncryptionPubkey(),
    label: 'Celular de Bob',
    caps: ['store', 'read']
  })

  // Lo que viaja entre pares es la TARJETA, no el acta: sin etiquetas ni permisos.
  const card = await bob.profileCard()
  assert.equal(card.keys.length, 2)
  assert.equal(JSON.stringify(card).includes('Celular de Bob'), false, 'it does not tell Alice what it calls its devices')

  const r = await alice.adoptPeerCard(card)
  assert.equal(r.adopted, true)
  assert.equal(r.devices, 2)

  const envelope = await alice.encrypt([{ publickey: bob.me.publickey }], 'hola Bob')
  assert.equal(Object.keys(envelope.wrap).length, 2, 'one wrap per device')

  const aliceEnc = await alice.getEncryptionPubkey()
  for (const [who, dev] of [['PC', bob], ['phone', bob2]]) {
    const { plaintext } = await dev.decrypt(aliceEnc, null, envelope)
    assert.equal(plaintext, 'hola Bob', "Bob's " + who + ' opens it')
  }

  const stranger = await Identity.connect({ dir: tmpDir('ajeno') })
  await assert.rejects(() => stranger.decrypt(aliceEnc, null, envelope), /not among the message recipients|no está entre los destinatarios/)
})

// ----- arranque -----

console.log('\nSMOKE · Dotrino ecosystem (proxy + vault + devices, all local)\n')
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
