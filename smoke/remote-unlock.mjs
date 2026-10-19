/**
 * ABRIR LA BÓVEDA DESDE EL ADMIN, de punta a punta.
 *
 * Diseño: `dotrino-vault/docs/abrir-a-distancia.md`. Lo que prueba, y que ningún test de un
 * proceso puede probar: que un aparato **en otra máquina** abre la bóveda con una
 * contraseña que **no vale en la máquina de la bóveda**, y que con ella abierta puede hacer
 * lo que el candado le cortaba.
 *
 * El modelo del dueño: *el admin abre la puerta en remoto, pero no tiene acceso a lo de
 * dentro*. Tres piezas y ninguna sirve sola — tú pones la contraseña, el admin pide, la
 * bóveda hace el trabajo con su maestra.
 *
 *   npm run smoke:remote-unlock  (o: node smoke/remote-unlock.mjs [--verbose])
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { scenario, runScenarios, startProxy, startVault, teardown, tmpDir } from './lib/harness.js'
import { enrollDevice } from '../../dotrino-identity/vault/remote.js'
import { requestAdmin, requestRenew } from '../../dotrino-vault/src/client.js'
import { seal } from '../../dotrino-vault/lib/src/sealed.js'
import { installNodeGlobals } from '../../dotrino-vault/src/node-globals.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const MAIN_PASSWORD = 'la-del-dueno-1414'
const ADMIN_PASSWORD = 'la-del-admin-9999'

let proxy = null
let vault = null
let admin = null      // { device, cert, iss }

/** El molino, tal cual lo hace el navegador con lo que le manda la bóveda. */
const kdf = (password, params) =>
  crypto.scryptSync(String(password), Buffer.from(params.salt, 'base64'),
    params.len, { N: params.N, r: params.r, p: params.p })

/** Una operación de la consola remota, desde el aparato admin. */
const asAdmin = (args) => requestAdmin({
  masterPubkey: admin.iss, proxyUrl: proxy.url, device: admin.device, cert: admin.cert,
  dir: admin.dir, ...args
})

scenario('the vault starts and a device joins as admin', async () => {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })

  const dir = tmpDir('admin')
  installNodeGlobals(dir)
  const qr = await vault.pair({ label: 'admin' })
  const enrolling = enrollDevice({ qr, label: 'admin', onChallenge: ({ code }) => vault.approve(code) })
  const r = await enrolling
  admin = { device: r.device, cert: r.cert, iss: r.master || qr.iss, dir }
  assert.ok(admin.cert, 'the device has its certificate')

  const id = (await import('../../dotrino-identity/vault/capabilities.js'))
  const pub = await id.pubkeyId(admin.device.publickey)
  vault.caps(admin.device.publickey, ['sign', 'admin'])
  await new Promise((r2) => setTimeout(r2, 1500))

  // EL PERMISO VIVE EN EL ACTA; el certificado es su reflejo, y solo se pone al día al
  // RENOVAR. Sin esto el aparato sigue presentando el papel de cuando entró —sin
  // `vault:admin`— y todo contesta «unauthorized: scope».
  const renewed = await requestRenew({
    masterPubkey: admin.iss, proxyUrl: proxy.url, device: admin.device, cert: admin.cert, dir: admin.dir
  })
  admin.cert = renewed.cert || renewed
  assert.ok((admin.cert.scope || []).includes('vault:admin'), 'the new certificate carries vault:admin')
  log('[test] admin ' + pub.slice(0, 8))
})

scenario('with the vault OPEN (no password) the admin manages as usual', async () => {
  const r = await asAdmin({ op: 'audit', limit: 5 })
  assert.ok(Array.isArray(r.entries), 'it reads the audit log')
})

/**
 * EL CANDADO. Poner contraseña cierra el perfil, y a partir de ahí lo que reescribe el acta
 * deja de atenderse — que es exactamente el problema que esto viene a resolver.
 */
scenario('with a password, the vault is locked and `revoke` is no longer served', async () => {
  await vault.profileOp('password-set', { password: MAIN_PASSWORD })
  await vault.profileOp('lock', {})

  await assert.rejects(() => asAdmin({ op: 'revoke', certNonce: 'n-inventado' }),
    (e) => e.code === 'vault-locked', 'while locked, revoke must say it is locked')
})

scenario('without an admin password set, remote unlock is NOT available', async () => {
  await assert.rejects(() => asAdmin({ op: 'unlock.begin', nonce: 'a'.repeat(32) }),
    /has no admin password/, 'it is turned on on purpose, it is not on by default')
})

scenario('the admin password is set ON THE MACHINE, with the profile open', async () => {
  await vault.profileOp('unlock', { password: MAIN_PASSWORD })
  const r = await vault.profileOp('admin-password-set', { password: ADMIN_PASSWORD })
  assert.match(JSON.stringify(r), /admin/, 'the vault confirms: ' + JSON.stringify(r.done || r))
  await vault.profileOp('lock', {})
})

/**
 * EL PASO CLAVE. El aparato deriva EN SU MÁQUINA y manda el resultado dentro de un sobre
 * que solo esta bóveda puede abrir. La contraseña no viaja.
 */
scenario('THE KEY STEP: the admin unlocks the vault from another machine', async () => {
  // DOS NONCES: el protocolo los quema al usarlos, así que repetirlo en el segundo mensaje
  // se rechaza con «nonce already used». El del segundo es el que va DENTRO del sobre.
  const params = await asAdmin({ op: 'unlock.begin', nonce: crypto.randomBytes(16).toString('hex') })
  assert.ok(params?.ek, 'the vault provides an ephemeral key')
  assert.ok(params?.salt && params?.N, 'and the KDF parameters, to derive the same way')

  const nonce = crypto.randomBytes(16).toString('hex')
  const key = kdf(ADMIN_PASSWORD, params)
  const enc = await seal({ ek: params.ek, payload: { nonce, key: key.toString('base64') } })
  const r = await asAdmin({ op: 'unlock', nonce, enc })
  assert.equal(r.ok, true, 'the vault unlocked: ' + JSON.stringify(r))

  // Y ahora sí: lo que el candado cortaba, se atiende.
  const rev = await asAdmin({ op: 'revoke', certNonce: 'n-inventado' }).catch((e) => e)
  assert.ok(!(rev instanceof Error) || rev.code !== 'vault-locked',
    'with the vault open, revoke no longer says it is locked: ' + (rev.message || 'ok'))
})

scenario('the same envelope does not work twice', async () => {
  await vault.profileOp('lock', {})
  const params = await asAdmin({ op: 'unlock.begin', nonce: crypto.randomBytes(16).toString('hex') })
  const nonce = crypto.randomBytes(16).toString('hex')
  const key = kdf(ADMIN_PASSWORD, params)
  const enc = await seal({ ek: params.ek, payload: { nonce, key: key.toString('base64') } })

  const first = await asAdmin({ op: 'unlock', nonce, enc })
  assert.equal(first.ok, true)

  await vault.profileOp('lock', {})
  // Reproducirlo choca con los DOS candados: el nonce ya está quemado y la efímera ya no
  // existe. Cualquiera de los dos basta; tenerlos los dos es el punto.
  await assert.rejects(() => asAdmin({ op: 'unlock', nonce, enc }),
    (e) => /nonce already used|ask for a key first/.test(e.message), 'an envelope is single-use')
})

scenario('the WRONG password does not unlock, and the rejection carries the throttle', async () => {
  await vault.profileOp('lock', {})
  const params = await asAdmin({ op: 'unlock.begin', nonce: crypto.randomBytes(16).toString('hex') })
  const nonce = crypto.randomBytes(16).toString('hex')
  const enc = await seal({ ek: params.ek, payload: { nonce, key: kdf('no-es-esa', params).toString('base64') } })

  const e = await asAdmin({ op: 'unlock', nonce, enc }).catch((err) => err)
  assert.ok(e instanceof Error, 'it should not unlock')
  assert.equal(e.code, 'WRONG_PASSWORD', 'and it is told apart by code, not by the message: ' + e.message)
  assert.ok(Number(e.tries) >= 1, 'the rejection says how many tries so far: ' + JSON.stringify(e.tries))
})

/**
 * LO QUE LA HACE DOS FACTORES: tecleada en la máquina de la bóveda no abre nada. Sin esto
 * sería una segunda llave de la misma puerta.
 */
scenario("the admin password does NOT work on the vault's machine", async () => {
  await vault.profileOp('lock', {})
  const r = await vault.profileOp('unlock', { password: ADMIN_PASSWORD }).catch((e) => e)
  const txt = JSON.stringify(r?.done || r?.error || r?.message || r)
  assert.ok(!/desbloq|unlocked|ok/i.test(txt) || /wrong|error/i.test(txt),
    'it cannot unlock from here: ' + txt)

  // Y la principal sí, que es lo que prueba que no se rompió el camino de siempre.
  await vault.profileOp('unlock', { password: MAIN_PASSWORD })
})

await runScenarios()
await teardown()
