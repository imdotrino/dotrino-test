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
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { escenario, correr, startProxy, startVault, teardown, ROOT, tmpDir } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

// El cliente REAL de dispositivo y la identidad REAL, importados por ruta desde sus repos.
const { enroll, requestSign } = await import(path.join(ROOT, 'dotrino-vault/src/client.js'))
const { Identity } = await import(path.join(ROOT, 'dotrino-identity/src/node.js'))

let proxy = null
let vault = null

/** Un dispositivo/agente headless que se enrola como lo haría el de verdad. */
async function dispositivo (vault, { label, onCode } = {}) {
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
  assert.ok(code, 'el dispositivo tiene que mostrar un código de 6 dígitos')
  return { qr, deviceId, code, enrolled: p }
}

escenario('la bóveda arranca, tiene identidad y su propia acta con un solo miembro', async () => {
  assert.ok(vault.iss, 'la bóveda publica su identidad en state.json')
  const acta = vault.acta()
  assert.ok(acta, 'la bóveda nace con su acta')
  assert.equal(acta.seq, 1)
  assert.equal(acta.members.length, 1)
  assert.equal(acta.sealer, acta.sealedBy, 'nace mandando ella misma')
  assert.deepEqual([...acta.members[0].caps].sort(), ['read', 'sign', 'store'])
})

escenario('emparejar: con el código correcto se emite el cert y el dispositivo entra en el acta', async () => {
  const d = await dispositivo(vault, { label: 'celular' })
  vault.approve(d.code)
  const res = await d.enrolled
  assert.ok(res.cert, 'el dispositivo recibe su certificado')
  assert.equal(res.cert.iss, vault.iss, 'firmado por la bóveda que vio en el código')
  assert.equal(res.cert.sub, res.device.publickey, 'y emitido para ESTE dispositivo')

  const dump = await vault.devices()
  assert.ok((dump.issued || []).some((x) => x.sub === res.device.publickey), 'queda registrado')

  const acta = vault.acta()
  assert.equal(acta.members.length, 2, 'aprobar es también admitir en el perfil')
  assert.ok(acta.members.some((m) => m.pub === res.device.publickey))
})

escenario('CÓDIGO EQUIVOCADO: no se emite ningún certificado, y luego el correcto sí funciona', async () => {
  const antes = vault.acta().members.length
  const d = await dispositivo(vault, { label: 'intruso' })

  const malo = String((Number(d.code) + 7) % 1000000).padStart(6, '0')
  vault.approve(malo)
  await new Promise((r) => setTimeout(r, 1200))

  assert.equal(vault.acta().members.length, antes, 'nadie entró en el perfil')
  const dump = await vault.devices()
  const nuevos = (dump.issued || []).filter((x) => x.label === 'intruso')
  assert.equal(nuevos.length, 0, 'la maestra no firmó ningún certificado')

  // El dispositivo sigue esperando: con el código bueno, entra.
  vault.approve(d.code)
  const res = await d.enrolled
  assert.ok(res.cert)
  assert.equal(vault.acta().members.length, antes + 1)
})

escenario('agentes headless (terminal, ia, bot) se enrolan con el mismo protocolo', async () => {
  for (const nombre of ['terminal', 'ia', 'bot']) {
    const d = await dispositivo(vault, { label: nombre })
    vault.approve(d.code)
    const res = await d.enrolled
    assert.ok(res.cert, `${nombre} recibe su certificado`)
    const acta = vault.acta()
    assert.ok(acta.members.some((m) => m.label === nombre), `${nombre} está en el acta`)
  }
})

escenario('revocar corta el acceso de verdad', async () => {
  const d = await dispositivo(vault, { label: 'perdido' })
  vault.approve(d.code)
  const res = await d.enrolled

  // Antes de revocar, la bóveda le firma lo que le pida.
  const firma = await requestSign({
    masterPubkey: vault.iss, proxyUrl: proxy.url, device: res.device, cert: res.cert,
    payload: { hola: 'mundo' }, dir: tmpDir('sign-ok')
  })
  assert.ok(firma.signature, 'con el cert vigente, la bóveda firma')

  const dump = await vault.devices()
  const dele = (dump.issued || []).find((x) => x.sub === res.device.publickey)
  vault.revoke(dele.nonce)
  await new Promise((r) => setTimeout(r, 1200))

  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url, device: res.device, cert: res.cert,
      payload: { hola: 'otra vez' }, dir: tmpDir('sign-ko')
    }),
    /no autorizado/,
    'revocado = la bóveda deja de firmarle'
  )
})

escenario('una identidad que ya existía se une al perfil de la bóveda y trae su continuidad', async () => {
  const dir = tmpDir('identidad-previa')
  const yo = await Identity.connect({ dir })
  const antes = await yo.myMembership()
  assert.equal(antes.isMaster, true, 'antes de unirse, mandaba en su propio perfil')

  const qr = await vault.pair({ label: 'navegador' })
  let code = null
  const off = yo.onVault((e) => { if (e.phase === 'challenge') code = e.code })
  const p = yo.enrollDevice(qr)
  await vault.waitPending()
  const t = Date.now() + 5000
  while (!code && Date.now() < t) await new Promise((r) => setTimeout(r, 50))
  assert.ok(code, 'muestra su código')
  vault.approve(code)
  const res = await p
  off()

  assert.equal(res.ok, true)
  const ahora = await yo.myMembership()
  assert.notEqual(ahora.profileId, antes.profileId, 'ahora pertenece al perfil de la bóveda')
  assert.equal(ahora.isMaster, false, 'y ya no manda: manda la bóveda')

  const acta = vault.acta()
  const mio = acta.members.find((m) => m.pub === antes.profileId)
  assert.ok(mio, 'está en el acta de la bóveda')
  assert.ok(mio.continuity, 'con el puente a lo que esa identidad hizo antes')
  assert.equal(mio.continuity.from, antes.profileId)
})

escenario('el proxy verifica el acta y bindea el perfil (y rechaza una manipulada)', async () => {
  // Un dispositivo enrolado se identifica presentando su cert y su acta.
  const d = await dispositivo(vault, { label: 'con-acta' })
  vault.approve(d.code)
  const res = await d.enrolled

  const { WebSocketProxyClient } = await import(path.join(ROOT, 'dotrino-proxy-client/src/index.js'))
  const { signWithDevice } = await import(path.join(ROOT, 'dotrino-identity/vault/capabilities.js'))
  const acta = vault.acta()

  const conectar = async (actaAEnviar) => {
    const c = new WebSocketProxyClient({ url: proxy.url, enableWebRTC: false, autoReconnect: false })
    await c.connect()
    const data = { op: 'identify', publickey: res.device.publickey, token: c.token, ts: Date.now() }
    const { signature } = await signWithDevice({ privateJwk: res.device.privateJwk, data })
    const out = await c.identify({ data, signature, cert: res.cert, acta: actaAEnviar })
    c.close()
    return out
  }

  const ok = await conectar(acta)
  assert.equal(ok.profile, acta.profileId, 'el proxy reconoce a la persona detrás del dispositivo')

  // Manipulada: darse a sí mismo un miembro extra rompe la firma → el proxy no la acepta.
  const trucada = { ...acta, members: [...acta.members, { pub: 'pub-inventada', caps: ['sign'] }] }
  const malo = await conectar(trucada)
  assert.equal(malo.profile, null, 'un acta manipulada no bindea nada')
  assert.equal(malo.publickey, res.device.publickey, 'pero el identify normal sigue funcionando')
})

escenario('el contenido viaja CIFRADO: el proxy no ve lo que guardas', async () => {
  const dir = tmpDir('con-contenido')
  const yo = await Identity.connect({ dir })
  const qr = await vault.pair({ label: 'con-contenido' })
  let code = null
  const off = yo.onVault((e) => { if (e.phase === 'challenge') code = e.code })
  const p = yo.enrollDevice(qr)
  await vault.waitPending()
  const t = Date.now() + 5000
  while (!code && Date.now() < t) await new Promise((r) => setTimeout(r, 50))
  vault.approve(code)
  await p
  off()

  // Al entrar en el perfil se le envuelve la clave de contenido.
  const mia = await yo.contentKey()
  assert.ok(mia?.cek, 'el miembro nuevo recibe la clave de contenido del perfil')

  // Guardar y leer a través de la bóveda, cifrado de punta a punta.
  const secreto = 'esto no lo puede ver el proxy ' + Date.now()
  await yo.vaultStore('appendMessage', { threadKey: 'smoke', entry: { id: 'm1', text: secreto } })
  const hilo = await yo.vaultStore('listThread', { threadKey: 'smoke' })
  const textos = JSON.stringify(hilo)
  assert.ok(textos.includes(secreto), 'el dispositivo lee de vuelta lo que guardó')

  // Y en el disco de la bóveda está, porque es SU almacén: lo que no lo ve es el proxy.
  const guardado = fs.readFileSync(path.join(vault.dir, 'p', fs.readdirSync(path.join(vault.dir, 'p'))[0], 'threads.json'), 'utf8')
  assert.ok(guardado.includes(secreto), 'la bóveda sí lo guarda en claro en TU disco')
})

escenario('la CLI muestra el acta y cambia permisos (`members` / `caps`)', async () => {
  const d = await dispositivo(vault, { label: 'con-permisos' })
  vault.approve(d.code)
  const res = await d.enrolled

  const acta = await vault.members()
  assert.ok(acta.members.length >= 2, 'la CLI ve a todos los miembros')
  const mio = acta.members.find((m) => m.pub === res.device.publickey)
  assert.ok(mio.id.match(/^[0-9A-F]{4}-[0-9A-F]{4}$/), 'con un identificador legible')
  assert.ok(mio.caps.length, 'y sus permisos')

  await vault.caps(res.device.publickey, ['read'])
  const despues = await vault.members()
  assert.deepEqual(despues.members.find((m) => m.pub === res.device.publickey).caps, ['read'],
    'quitarle permisos desde la bóveda se refleja en el acta')
})

// ----- arranque -----

console.log('\nSMOKE · ecosistema Dotrino (proxy + bóveda + dispositivos, todo local)\n')
try {
  proxy = await startProxy({ log })
  console.log(`  proxy local en ${proxy.url}`)
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
