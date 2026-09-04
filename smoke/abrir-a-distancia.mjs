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
 *   node smoke/abrir-a-distancia.mjs [--verbose]
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { escenario, correr, startProxy, startVault, teardown, tmpDir } from './lib/harness.js'
import { enrollDevice } from '../../dotrino-identity/vault/remote.js'
import { requestAdmin, requestRenew } from '../../dotrino-vault/src/client.js'
import { seal } from '../../dotrino-vault/lib/src/sealed.js'
import { installNodeGlobals } from '../../dotrino-vault/src/node-globals.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const PRINCIPAL = 'la-del-dueno-1414'
const DEL_ADMIN = 'la-del-admin-9999'

let proxy = null
let vault = null
let admin = null      // { device, cert, iss }

/** El molino, tal cual lo hace el navegador con lo que le manda la bóveda. */
const molino = (password, params) =>
  crypto.scryptSync(String(password), Buffer.from(params.salt, 'base64'),
    params.len, { N: params.N, r: params.r, p: params.p })

/** Una operación de la consola remota, desde el aparato admin. */
const comoAdmin = (args) => requestAdmin({
  masterPubkey: admin.iss, proxyUrl: proxy.url, device: admin.device, cert: admin.cert,
  dir: admin.dir, ...args
})

escenario('la bóveda arranca y un aparato entra como admin', async () => {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })

  const dir = tmpDir('admin')
  installNodeGlobals(dir)
  const qr = await vault.pair({ label: 'admin' })
  const enrolando = enrollDevice({ qr, label: 'admin', onChallenge: ({ code }) => vault.approve(code) })
  const r = await enrolando
  admin = { device: r.device, cert: r.cert, iss: r.master || qr.iss, dir }
  assert.ok(admin.cert, 'el aparato tiene su papel')

  const id = (await import('../../dotrino-identity/vault/capabilities.js'))
  const pub = await id.pubkeyId(admin.device.publickey)
  vault.caps(admin.device.publickey, ['sign', 'admin'])
  await new Promise((r2) => setTimeout(r2, 1500))

  // EL PERMISO VIVE EN EL ACTA; el certificado es su reflejo, y solo se pone al día al
  // RENOVAR. Sin esto el aparato sigue presentando el papel de cuando entró —sin
  // `vault:admin`— y todo contesta «unauthorized: scope».
  const nuevo = await requestRenew({
    masterPubkey: admin.iss, proxyUrl: proxy.url, device: admin.device, cert: admin.cert, dir: admin.dir
  })
  admin.cert = nuevo.cert || nuevo
  assert.ok((admin.cert.scope || []).includes('vault:admin'), 'el papel nuevo trae vault:admin')
  log('[test] admin ' + pub.slice(0, 8))
})

escenario('con la bóveda ABIERTA (sin contraseña) el admin administra como siempre', async () => {
  const r = await comoAdmin({ op: 'audit', limit: 5 })
  assert.ok(Array.isArray(r.entries), 'lee la bitácora')
})

/**
 * EL CANDADO. Poner contraseña cierra el perfil, y a partir de ahí lo que reescribe el acta
 * deja de atenderse — que es exactamente el problema que esto viene a resolver.
 */
escenario('con contraseña, la bóveda queda cerrada y `revoke` deja de atenderse', async () => {
  await vault.profileOp('password-set', { password: PRINCIPAL })
  await vault.profileOp('lock', {})

  await assert.rejects(() => comoAdmin({ op: 'revoke', certNonce: 'n-inventado' }),
    (e) => e.code === 'vault-locked', 'cerrada, revocar tiene que decir que está cerrada')
})

escenario('sin contraseña de admin puesta, abrir a distancia NO está disponible', async () => {
  await assert.rejects(() => comoAdmin({ op: 'unlock.begin', nonce: 'a'.repeat(32) }),
    /has no admin password/, 'se enciende a propósito, no viene puesto')
})

escenario('se pone la contraseña del admin EN LA MÁQUINA, con el perfil abierto', async () => {
  await vault.profileOp('unlock', { password: PRINCIPAL })
  const r = await vault.profileOp('admin-password-set', { password: DEL_ADMIN })
  assert.match(JSON.stringify(r), /admin/, 'la bóveda confirma: ' + JSON.stringify(r.done || r))
  await vault.profileOp('lock', {})
})

/**
 * EL PASO CLAVE. El aparato deriva EN SU MÁQUINA y manda el resultado dentro de un sobre
 * que solo esta bóveda puede abrir. La contraseña no viaja.
 */
escenario('EL PASO CLAVE: el admin abre la bóveda desde otra máquina', async () => {
  // DOS NONCES: el protocolo los quema al usarlos, así que repetirlo en el segundo mensaje
  // se rechaza con «nonce already used». El del segundo es el que va DENTRO del sobre.
  const params = await comoAdmin({ op: 'unlock.begin', nonce: crypto.randomBytes(16).toString('hex') })
  assert.ok(params?.ek, 'la bóveda aporta una llave efímera')
  assert.ok(params?.salt && params?.N, 'y los números del molino, para derivar igual')

  const nonce = crypto.randomBytes(16).toString('hex')
  const clave = molino(DEL_ADMIN, params)
  const enc = await seal({ ek: params.ek, payload: { nonce, key: clave.toString('base64') } })
  const r = await comoAdmin({ op: 'unlock', nonce, enc })
  assert.equal(r.ok, true, 'la bóveda se abrió: ' + JSON.stringify(r))

  // Y ahora sí: lo que el candado cortaba, se atiende.
  const rev = await comoAdmin({ op: 'revoke', certNonce: 'n-inventado' }).catch((e) => e)
  assert.ok(!(rev instanceof Error) || rev.code !== 'vault-locked',
    'con la bóveda abierta, revocar ya no dice que está cerrada: ' + (rev.message || 'ok'))
})

escenario('el mismo sobre no sirve dos veces', async () => {
  await vault.profileOp('lock', {})
  const params = await comoAdmin({ op: 'unlock.begin', nonce: crypto.randomBytes(16).toString('hex') })
  const nonce = crypto.randomBytes(16).toString('hex')
  const clave = molino(DEL_ADMIN, params)
  const enc = await seal({ ek: params.ek, payload: { nonce, key: clave.toString('base64') } })

  const primera = await comoAdmin({ op: 'unlock', nonce, enc })
  assert.equal(primera.ok, true)

  await vault.profileOp('lock', {})
  // Reproducirlo choca con los DOS candados: el nonce ya está quemado y la efímera ya no
  // existe. Cualquiera de los dos basta; tenerlos los dos es el punto.
  await assert.rejects(() => comoAdmin({ op: 'unlock', nonce, enc }),
    (e) => /nonce already used|ask for a key first/.test(e.message), 'un sobre es de un solo uso')
})

escenario('la contraseña EQUIVOCADA no abre, y el rechazo trae el freno', async () => {
  await vault.profileOp('lock', {})
  const params = await comoAdmin({ op: 'unlock.begin', nonce: crypto.randomBytes(16).toString('hex') })
  const nonce = crypto.randomBytes(16).toString('hex')
  const enc = await seal({ ek: params.ek, payload: { nonce, key: molino('no-es-esa', params).toString('base64') } })

  const e = await comoAdmin({ op: 'unlock', nonce, enc }).catch((err) => err)
  assert.ok(e instanceof Error, 'no debería abrir')
  assert.equal(e.code, 'WRONG_PASSWORD', 'y se distingue por código, no por la frase: ' + e.message)
  assert.ok(Number(e.tries) >= 1, 'el rechazo dice cuántos intentos van: ' + JSON.stringify(e.tries))
})

/**
 * LO QUE LA HACE DOS FACTORES: tecleada en la máquina de la bóveda no abre nada. Sin esto
 * sería una segunda llave de la misma puerta.
 */
escenario('la contraseña del admin NO vale en la máquina de la bóveda', async () => {
  await vault.profileOp('lock', {})
  const r = await vault.profileOp('unlock', { password: DEL_ADMIN }).catch((e) => e)
  const txt = JSON.stringify(r?.done || r?.error || r?.message || r)
  assert.ok(!/desbloq|unlocked|ok/i.test(txt) || /wrong|error/i.test(txt),
    'no puede abrir desde aquí: ' + txt)

  // Y la principal sí, que es lo que prueba que no se rompió el camino de siempre.
  await vault.profileOp('unlock', { password: PRINCIPAL })
})

await correr()
await teardown()
