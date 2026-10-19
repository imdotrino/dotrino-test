/**
 * CONSOLA REMOTA — administrar el perfil desde otro aparato, cada uno en su caja.
 *
 * Diseño: `dotrino-vault/docs/consola-remota.md` (§8, «E2E en contenedores»). Lo que
 * prueba, y que ningún test de un solo proceso puede probar: que el **dispositivo-admin
 * admite a un dispositivo nuevo SIN TOCAR EL PC**, que el aviso llega a todos, y que la
 * frontera de lo que NO se delega aguanta desde una máquina de verdad.
 *
 * Tres cajas, tres máquinas:
 *   · `boveda`  — el binario `dotrino-vaultd` con su CLI real (así se instala un usuario)
 *   · `admin`   — el aparato al que el dueño le concede «administra»
 *   · `nuevo`   — el que entra, aprobado a distancia y sin pasar por el PC
 *
 *   node smoke/console.mjs            (Docker si lo hay; si no, cajas locales)
 *   SMOKE_BACKEND=local node smoke/console.mjs
 *   node smoke/console.mjs --verbose
 *
 * Requiere el binario:  cd dotrino-vault && bash packaging/build.sh
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { scenario, runScenarios, startProxy, teardown, ROOT } from './lib/harness.js'
import { pubkeyId } from '../../dotrino-identity/vault/capabilities.js'
import { createBox, destroyBoxes, pickEngine, ECO } from './lib/box.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const BINARY = '/eco/dotrino-vault/dist/dotrino-vaultd'
const VAULT_ENV = { DOTRINO_VAULT_DIR: '/data/vault' }

let proxy = null
let vaultBox = null
const boxes = {}
const events = { admin: [], nuevo: [] }   // los `vault.admin.event` que recibió cada uno

/** `AB12-CD34`, que es como lista la bóveda a una llave. */
async function idOf (pub) {
  const h = (await pubkeyId(pub)).slice(0, 8).toUpperCase()
  return h.slice(0, 4) + '-' + h.slice(4)
}

// ---------- la bóveda: el binario, manejado con su CLI ----------

async function startVaultBox () {
  vaultBox = createBox('vault')
  // El binario trae Node dentro pero espera `libatomic1` del sistema (lo destapó el smoke
  // de dispositivos en un Debian limpio; por eso el `.deb` la declara).
  if (vaultBox.engine === 'docker') {
    vaultBox.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  }
  const output = []
  vaultBox.launch(BINARY, {
    env: { ...VAULT_ENV, PROXY_URL: proxy.url },
    onLine: (l) => { output.push(l); log('[vault] ' + l) }
  })
  await waitFor(() => output.some((l) => l.includes('servicio listo')), { what: 'the vault to start' })
    .catch(() => { throw new Error('the vault (binary) did not start:\n' + output.join('\n')) })
  // Sin `state.json`: desde 0.89 el canal local va cifrado con la clave de la CAJA, y
  // nadie de aquí lo usaba — que la bóveda dijera «servicio listo» ya es el arranque.
  return { output }
}

const ctl = (cmd) => vaultBox.exec(`${BINARY} --ctl ${cmd}`, { env: VAULT_ENV })
const members = () => ctl('members').stdout || ''
/** Los permisos que el acta le reconoce a un miembro (la línea que va debajo de su id). */
function capsOf (id, output = members()) {
  const lines = output.split('\n')
  const i = lines.findIndex((l) => l.includes(id))
  return i >= 0 ? (lines[i + 1] || '') : ''
}
const activity = () => ctl('activity 60').stdout || ''

/** `dotrino-vault pair` EN EL PC (para el primer aparato: el admin todavía no existe). */
async function pairFromThePC () {
  const lines = []
  vaultBox.launch(`${BINARY} --ctl pair`, { env: VAULT_ENV, onLine: (l) => { lines.push(l.trim()); log('[pair] ' + l) } })
  return await waitFor(() => {
    for (const l of lines) {
      if (!l || l.length < 20) continue
      const o = parseInvite(l)
      if (o?.sn) return o
    }
    return null
  }, { what: 'the invite printed by the CLI' })
}

// ---------- los dispositivos, cada uno en su caja ----------

/** Guion que enrola con el cliente REAL del vault y deja el cert en el disco de la caja. */
const SCRIPT_ENROLL = `
  import fs from 'node:fs'
  import { enroll } from '/eco/dotrino-vault/src/client.js'
  const qr = JSON.parse(process.env.QR)
  const r = await enroll({ qr, label: process.env.LABEL, dir: '/data/dev', onChallenge: (c) => console.log('CODE:' + c.code) })
  // El ACTA también: trae la clave de contenido envuelta para este aparato, y el almacén de
  // la bóveda solo entra cifrado con ella.
  fs.writeFileSync('/data/dev.json', JSON.stringify({ device: r.device, cert: r.cert, iss: r.iss, acta: r.acta }))
  console.log('OK:' + JSON.stringify({ pub: r.device.publickey, scope: r.cert.scope }))
`

/**
 * Escucha los avisos firmados de la bóveda (`vault.admin.event`). Es un proceso aparte y
 * vivo: un aviso que no llega al aparato no sirve de nada, y eso solo se ve así.
 */
const SCRIPT_LISTEN = `
  import fs from 'node:fs'
  // Por RUTA y no por nombre: el guion vive en /data, así que un import desnudo no
  // encuentra los node_modules del vault (que están en /eco, montado de solo lectura).
  import { WebSocketProxyClient } from '/eco/dotrino-vault/node_modules/@dotrino/proxy-client/src/index.js'
  import { installNodeGlobals } from '/eco/dotrino-vault/src/node-globals.js'
  import { identifyAsDevice, verifyAdminEvent } from '/eco/dotrino-vault/src/client.js'
  import { MSG } from '/eco/dotrino-vault/lib/src/protocol.js'
  installNodeGlobals('/data/listener')
  const { device, iss } = JSON.parse(fs.readFileSync('/data/dev.json', 'utf8'))
  const c = new WebSocketProxyClient({ url: process.env.PROXY, enableWebRTC: false, autoReconnect: true })
  await c.connect()
  await identifyAsDevice(c, device)
  console.log('READY')
  c.on('message', async (_f, p) => {
    if (!p || p.type !== MSG.ADMIN_EVENT) return
    // Un aviso SIN FIRMA no se muestra: si no, cualquiera llenaría de alarmas el aparato.
    const ok = await verifyAdminEvent({ body: p.body, signature: p.signature, master: iss })
    console.log('EVENT:' + JSON.stringify({ ...p.body, signed: ok }))
  })
  setInterval(() => {}, 1 << 30)
`

/** Una operación de la consola remota, desde el aparato. Imprime `RES:` o `ERR:`. */
const SCRIPT_ADMIN = `
  import fs from 'node:fs'
  import { requestAdmin } from '/eco/dotrino-vault/src/client.js'
  const { device, cert, iss } = JSON.parse(fs.readFileSync('/data/dev.json', 'utf8'))
  const args = JSON.parse(process.env.ARGS || '{}')
  try {
    const r = await requestAdmin({ masterPubkey: iss, proxyUrl: process.env.PROXY, device, cert, dir: '/data/op', ...args })
    console.log('RES:' + JSON.stringify(r))
  } catch (e) { console.log('ERR:' + e.message) }
  process.exit(0)
`

/**
 * Pide la lista de dispositivos CON `sinceSeq`, que es lo que manda siempre un aparato ya
 * emparejado. Devuelve el acta que contesta la bóveda: si no llega, el aparato se queda
 * congelado con la copia del día que entró y no se entera de nada más.
 */
const SCRIPT_DEVICES = `
  import fs from 'node:fs'
  import { WebSocketProxyClient } from '/eco/dotrino-vault/node_modules/@dotrino/proxy-client/src/index.js'
  import { installNodeGlobals } from '/eco/dotrino-vault/src/node-globals.js'
  import { signWithDevice } from '/eco/dotrino-identity/vault/capabilities.js'
  import { MSG } from '/eco/dotrino-vault/lib/src/protocol.js'
  installNodeGlobals('/data/dev2')
  const { device, cert, iss } = JSON.parse(fs.readFileSync('/data/dev.json', 'utf8'))
  const c = new WebSocketProxyClient({ url: process.env.PROXY, enableWebRTC: false, autoReconnect: false })
  await c.connect()
  const data = { op: 'devices', sinceSeq: Number(process.env.SINCE || 0), publickey: device.publickey, ts: Date.now() }
  const { signature } = await signWithDevice({ privateJwk: device.privateJwk, data })
  const salida = new Promise((res) => {
    c.on('message', (_f, p) => {
      if (p?.type === MSG.DEVICES_RESULT) res({ ok: true, seq: p.acta?.seq ?? null, members: (p.acta?.members || []).length })
      else if (p?.type === MSG.ERROR) res({ ok: false, error: p.error })
    })
  })
  c.sendByPubkey(iss, { type: MSG.DEVICES, data, signature, cert })
  const r = await salida
  console.log((r.ok ? 'RES:' : 'ERR:') + (r.ok ? JSON.stringify(r) : r.error))
  process.exit(0)
`

/** Renovar: el cert nuevo sale con el scope que dice el ACTA, no con el que tenía. */
const SCRIPT_RENEW = `
  import fs from 'node:fs'
  import { requestRenew } from '/eco/dotrino-vault/src/client.js'
  const d = JSON.parse(fs.readFileSync('/data/dev.json', 'utf8'))
  try {
    const { cert } = await requestRenew({ masterPubkey: d.iss, proxyUrl: process.env.PROXY, device: d.device, cert: d.cert, dir: '/data/ren' })
    // El papel VIEJO se guarda aparte: renovar lo retira, y hay que poder comprobar qué
    // hace la bóveda cuando alguien vuelve a aparecer con él.
    fs.writeFileSync('/data/dev-old.json', JSON.stringify(d))
    fs.writeFileSync('/data/dev.json', JSON.stringify({ ...d, cert }))
    console.log('RES:' + JSON.stringify({ scope: cert.scope }))
  } catch (e) { console.log('ERR:' + e.message) }
  process.exit(0)
`

/** Renunciar a firmar y que la bóveda lo selle en el acta. */
const SCRIPT_RENOUNCE = `
  import fs from 'node:fs'
  import { WebSocketProxyClient } from '/eco/dotrino-vault/node_modules/@dotrino/proxy-client/src/index.js'
  import { installNodeGlobals } from '/eco/dotrino-vault/src/node-globals.js'
  import { signWithDevice } from '/eco/dotrino-identity/vault/capabilities.js'
  import * as Acta from '/eco/dotrino-identity/vault/acta.js'
  import { MSG } from '/eco/dotrino-vault/lib/src/protocol.js'
  installNodeGlobals('/data/ren2')
  const { device, cert, iss } = JSON.parse(fs.readFileSync('/data/dev.json', 'utf8'))
  // El registro lo firma el PROPIO miembro: la bóveda no mira ningún certificado.
  const record = await Acta.makeRenounce({ member: device.publickey, caps: ['sign'], privateJwk: device.privateJwk })
  const c = new WebSocketProxyClient({ url: process.env.PROXY, enableWebRTC: false, autoReconnect: false })
  await c.connect()
  const data = { op: 'renounce', record, publickey: device.publickey, ts: Date.now() }
  const { signature } = await signWithDevice({ privateJwk: device.privateJwk, data })
  const salida = new Promise((res) => {
    c.on('message', (_f, p) => {
      if (p?.type === MSG.RENOUNCE_RESULT) res({ ok: true, seq: p.seq })
      else if (p?.type === MSG.ERROR) res({ ok: false, error: p.error })
    })
  })
  c.sendByPubkey(iss, { type: MSG.RENOUNCE, data, signature, cert })
  const r = await salida
  console.log((r.ok ? 'RES:' : 'ERR:') + (r.ok ? JSON.stringify(r) : r.error))
  process.exit(0)
`

/**
 * Un aparato REVOCADO que vuelve a aparecer: pide la lista y comprueba si la bóveda le
 * reemite el aviso FIRMADO de que está fuera. Si no llega, el aparato no puede borrar nada
 * (un error suelto no va firmado y tiene prohibido borrar), así que se queda enseñando un
 * perfil del que ya lo echaron.
 */
const SCRIPT_REVOKED = `
  import fs from 'node:fs'
  import { WebSocketProxyClient } from '/eco/dotrino-vault/node_modules/@dotrino/proxy-client/src/index.js'
  import { installNodeGlobals } from '/eco/dotrino-vault/src/node-globals.js'
  import { signWithDevice } from '/eco/dotrino-identity/vault/capabilities.js'
  import { verifyRevoke } from '/eco/dotrino-vault/src/client.js'
  import { MSG } from '/eco/dotrino-vault/lib/src/protocol.js'
  installNodeGlobals('/data/rev')
  const { device, cert, iss } = JSON.parse(fs.readFileSync(process.env.DEV || '/data/dev.json', 'utf8'))
  const c = new WebSocketProxyClient({ url: process.env.PROXY, enableWebRTC: false, autoReconnect: false })
  await c.connect()
  // Identificarse es lo que le hace direccionable para el aviso.
  const idData = { op: 'identify', publickey: device.publickey, token: c.token, ts: Date.now() }
  const { signature: idSig } = await signWithDevice({ privateJwk: device.privateJwk, data: idData })
  try { await c.identify({ data: idData, signature: idSig, cert }) } catch (_) {}
  const data = { op: 'devices', sinceSeq: 0, publickey: device.publickey, ts: Date.now() }
  const { signature } = await signWithDevice({ privateJwk: device.privateJwk, data })
  const salida = new Promise((res) => {
    let err = null
    c.on('message', async (_f, p) => {
      if (p?.type === MSG.REVOKED) {
        // FIRMADO por la maestra: es lo único con lo que un aparato puede auto-borrarse.
        const ok = await verifyRevoke({ body: p.body, signature: p.signature, master: iss, devicePubkey: device.publickey })
        res({ ok: true, signed: ok })
      } else if (p?.type === MSG.ERROR) { err = p.error; setTimeout(() => res({ ok: false, error: err }), 2500) }
    })
  })
  c.sendByPubkey(iss, { type: MSG.DEVICES, data, signature, cert })
  const r = await salida
  console.log((r.ok ? 'RES:' : 'ERR:') + (r.ok ? JSON.stringify(r) : r.error))
  process.exit(0)
`

/** F4 — datos sensibles: guardar y recuperar un sobre cerrado por el camino real. */
const SCRIPT_SECRET = `
  import fs from 'node:fs'
  import { requestStore } from '/eco/dotrino-vault/src/client.js'
  const { device, cert, iss, acta } = JSON.parse(fs.readFileSync('/data/dev.json', 'utf8'))
  const args = JSON.parse(process.env.ARGS || '{}')
  try {
    const r = await requestStore({ masterPubkey: iss, proxyUrl: process.env.PROXY, device, cert, acta, dir: '/data/st', ...args })
    console.log('RES:' + JSON.stringify(r))
  } catch (e) { console.log('ERR:' + e.message) }
  process.exit(0)
`

/** Corre un guion en la caja y espera su `RES:`/`ERR:`. */
async function runScript (name, script, { env = {}, what = 'the script' } = {}) {
  const box = boxes[name]
  box.write('/data/step.mjs', script)
  let output = null; const lines = []
  box.launch('node /data/step.mjs', {
    env: { PROXY: proxy.url, ...env },
    onLine: (l) => {
      lines.push(l); log(`[${name}] ` + l)
      if (l.startsWith('RES:')) output = { ok: true, value: JSON.parse(l.slice(4)) }
      if (l.startsWith('ERR:')) output = { ok: false, error: l.slice(4) }
    }
  })
  await waitFor(() => output, { what }).catch(() => { throw new Error(`${name}: no answer for ${what}:\n` + lines.join('\n')) })
  return output
}

/** Enrola un aparato en su propia caja, con el QR que le den, y lo deja escuchando avisos. */
async function enrollInBox (name, qr, { approve }) {
  const box = boxes[name] = createBox(name)
  box.write('/data/enroll.mjs', SCRIPT_ENROLL)
  let code = null; let ok = null; const lines = []
  box.launch('node /data/enroll.mjs', {
    env: { QR: JSON.stringify(qr), LABEL: name },
    onLine: (l) => {
      lines.push(l); log(`[${name}] ` + l)
      if (l.startsWith('CODE:')) code = l.slice(5).trim()
      if (l.startsWith('OK:')) ok = JSON.parse(l.slice(3))
    }
  })
  // El código lo MUESTRA el aparato que entra; aquí hacemos de humano que lo lee.
  await waitFor(() => code, { what: `the code shown by «${name}»` })
    .catch(() => { throw new Error(`${name} showed no code:\n` + lines.join('\n')) })
  await approve(code)
  await waitFor(() => ok, { what: `«${name}» to finish joining` })
    .catch(() => { throw new Error(`${name} did not finish pairing:\n` + lines.join('\n')) })

  // Y se queda escuchando: los avisos hay que recibirlos, no suponerlos.
  box.write('/data/listen.mjs', SCRIPT_LISTEN)
  let ready = false
  box.launch('node /data/listen.mjs', {
    env: { PROXY: proxy.url },
    onLine: (l) => {
      log(`[${name}·listen] ` + l)
      if (l === 'READY') ready = true
      if (l.startsWith('EVENT:')) events[name]?.push(JSON.parse(l.slice(6)))
    }
  })
  await waitFor(() => ready, { what: `«${name}» to start listening for notices` })
  return ok
}

// ---------- escenarios ----------

let admin = null
let newcomer = null

scenario('the vault starts as a binary and the admin joins as a normal device', async () => {
  await startVaultBox()
  const qr = await pairFromThePC()
  admin = await enrollInBox('admin', qr, { approve: (code) => ctl(`approve ${code}`) })
  assert.ok(admin.pub, 'it generated its key on its own machine')
  // Recién emparejado NO administra: eso se concede aparte, y a propósito.
  assert.ok(!admin.scope.includes('vault:admin'), 'the QR never grants administration: ' + admin.scope)
  assert.ok(members().includes(await idOf(admin.pub)), 'the vault lists it in the record')
})

scenario('without «administra», the remote console says no', async () => {
  const r = await runScript('admin', SCRIPT_ADMIN, { env: { ARGS: JSON.stringify({ op: 'pending' }) }, what: 'the answer to pending' })
  assert.equal(r.ok, false, 'it should not be able to administer')
  assert.match(r.error, /unauthorized/, r.error)
})

scenario('the owner grants «administra» ON THE PC and the permission arrives by renewing the cert', async () => {
  const id = await idOf(admin.pub)
  const output = ctl(`caps ${id} +administra`)
  assert.equal(output.status, 0, 'the CLI accepted the change: ' + (output.stderr || output.stdout))
  await sleep(1200)
  assert.match(members(), /administra el perfil/i, 'the record now says it administers:\n' + members())

  // El cert VIEJO sigue sin el scope: la política vive en el acta, y el cert es su
  // reflejo. Renovar es lo que lo pone al día — antes copiaba el scope viejo y el
  // permiso concedido no llegaba NUNCA al cert.
  const r = await runScript('admin', SCRIPT_RENEW, { what: 'the renewal' })
  assert.ok(r.ok, 'could not renew: ' + r.error)
  assert.ok(r.value.scope.includes('vault:admin'), 'the new cert carries vault:admin: ' + r.value.scope)
})

scenario('the old paper is NOT an expulsion: changing permissions does not delete the device', async () => {
  // El fallo, contado por el dueño: «le di permisos de admin al dispositivo y ahora
  // desapareció como que hubiera sido revocado». Cambiar permisos obliga a renovar, y
  // renovar retira el certificado anterior. Si al reaparecer con el papel viejo la bóveda
  // le manda el aviso FIRMADO de expulsión, el aparato se borra solo: pierde su enlace
  // con la bóveda y vuelve a ser una cuenta suelta, sin que nadie lo haya echado.
  // Un papel retirado se responde con «renueva», no con «estás fuera».
  const r = await runScript('admin', SCRIPT_REVOKED, { env: { DEV: '/data/dev-old.json' }, what: 'the answer to the old cert' })
  assert.equal(r.ok, false, 'with the old cert an expulsion notice must NOT arrive: the device would delete itself')
  assert.match(r.error, /revoked/, 'what does arrive is an unsigned rejection, which deletes nothing: ' + r.error)
  // Y sigue siendo del perfil, que es lo que hace que el aviso no proceda.
  assert.match(members(), new RegExp(await idOf(admin.pub)), 'the device is still in the record:\n' + members())
})

scenario('now it administers: it sees the activity log and what is pending', async () => {
  const r = await runScript('admin', SCRIPT_ADMIN, { env: { ARGS: JSON.stringify({ op: 'audit', limit: 10 }) }, what: 'the activity log' })
  assert.ok(r.ok, 'it should be able to read the activity log: ' + r.error)
  assert.ok(Array.isArray(r.value.entries), 'it returns entries')
})

scenario('an admin can NOT create another admin nor pair services', async () => {
  for (const scope of [['vault:admin'], ['vault:secrets:proxy']]) {
    const r = await runScript('admin', SCRIPT_ADMIN, {
      env: { ARGS: JSON.stringify({ op: 'pair', scope }) }, what: 'the answer to pair'
    })
    assert.equal(r.ok, false, `pair with ${scope} should be rejected`)
    assert.match(r.error, /cannot grant admin or service secrets/, r.error)
  }
  // Y la frontera está en la BÓVEDA, no en la pantalla: queda escrito en la bitácora.
  assert.match(activity(), /forbidden-scope/, 'the rejection is audited')
})

scenario('THE KEY STEP: the admin admits a new device WITHOUT TOUCHING THE PC', async () => {
  const r = await runScript('admin', SCRIPT_ADMIN, {
    env: { ARGS: JSON.stringify({ op: 'pair', label: 'nuevo' }) }, what: 'the remote invite'
  })
  assert.ok(r.ok, 'the admin should be able to open a pairing: ' + r.error)
  const qr = r.value.qr
  assert.ok(qr?.sn, 'it answers with the invite to draw the QR')

  // El aparato nuevo entra y muestra su código; el ADMIN lo teclea desde su máquina.
  newcomer = await enrollInBox('nuevo', qr, {
    approve: async (code) => {
      const a = await runScript('admin', SCRIPT_ADMIN, {
        env: { ARGS: JSON.stringify({ op: 'approve', code }) }, what: 'the remote approval'
      })
      assert.ok(a.ok, 'the admin could not approve: ' + a.error)
    }
  })
  assert.ok(newcomer.pub, 'the new device generated its key')
  assert.ok(members().includes(await idOf(newcomer.pub)), 'and it is in the vault\'s record')

  // La bitácora dice QUIÉN aprobó, no solo que se aprobó: con la administración
  // delegada, «se aprobó» ya no identifica a nadie.
  const b = activity()
  assert.match(b, /admin\.approve/, 'the remote approval is audited:\n' + b)
  assert.ok(b.includes(await idOf(admin.pub)), 'and with the device that asked for it:\n' + b)
})

scenario('remote administration is NOT invisible: the notice arrives signed', async () => {
  // Esto es la contrapartida de delegar la administración: si un admin comprometido mete
  // un aparato, tiene que verse sin ir a mirar la bitácora.
  await waitFor(() => events.admin.some((e) => e.ev === 'enrolled'), { what: 'the notice that someone joined' })
  const ev = events.admin.find((e) => e.ev === 'enrolled')
  assert.ok(ev.signed, 'it is signed by the master (an unsigned one is not shown)')
  assert.equal(ev.by, await idOf(admin.pub), 'and it says WHO admitted it')
  assert.equal(events.admin.filter((e) => e.ev === 'enrolled' && e.ts === ev.ts).length, 1,
    'only once: renewing the cert must not multiply the notice')

  // Al recién llegado NO se le avisa de su propia entrada: se entera recibiendo su
  // certificado, y cuando se pone a escuchar el aviso ya pasó. Que está en el canal se
  // comprueba con el siguiente evento (más abajo, al quitarle «administra» al otro).
})

scenario('F4 — sensitive data: the device stores a sealed envelope and gets it back', async () => {
  const stored = await runScript('nuevo', SCRIPT_SECRET, {
    env: { ARGS: JSON.stringify({ method: 'secure.put', args: { meta: 'META-SELLADA', enc: 'VALOR-SELLADO' } }) },
    what: 'storing the sensitive value'
  })
  assert.ok(stored.ok, 'could not store: ' + stored.error)
  const id = stored.value.id

  const listed = await runScript('nuevo', SCRIPT_SECRET, {
    env: { ARGS: JSON.stringify({ method: 'secure.list' }) }, what: 'the list'
  })
  assert.equal(listed.value.length, 1)
  assert.equal(listed.value[0].meta, 'META-SELLADA')
  assert.equal(listed.value[0].enc, undefined, 'listing does NOT download the value')

  const one = await runScript('nuevo', SCRIPT_SECRET, {
    env: { ARGS: JSON.stringify({ method: 'secure.get', args: { id } }) }, what: 'the entry'
  })
  assert.equal(one.value.enc, 'VALOR-SELLADO', 'the value only travels when opening the entry')

  // Y en el disco de la bóveda no se ve nada: `threads.json` va cifrado en reposo.
  const raw = vaultBox.read('/data/vault/p/' + (vaultBox.exec('ls /data/vault/p').stdout || '').trim().split('\n')[0] + '/threads.json') || ''
  assert.ok(!raw.includes('VALOR-SELLADO'), 'the value is not left in clear on the vault\'s disk')
})

scenario('the profile you edit on the device shows up in the vault (`dotrino-vault me`)', async () => {
  // Cambiar el apodo o la foto en un dispositivo tiene que llegar a la bóveda —es la copia
  // autoritativa— y el dueño tiene que poder COMPROBARLO desde su máquina. La foto va como
  // data-URI, igual que la manda la identidad de verdad.
  const photo = 'data:image/png;base64,' + Buffer.alloc(9000, 7).toString('base64')
  const r = await runScript('nuevo', SCRIPT_SECRET, {
    env: {
      ARGS: JSON.stringify({
        method: 'profileSet',
        args: { me: { nickname: 'Seyacat', nombres: 'Santiago', email: 'sandrade@dotrino.com', telefono: '0999', telefonoVisible: false, avatar: photo } }
      })
    },
    what: 'storing the profile from the device'
  })
  assert.ok(r.ok, 'the device could not store its profile: ' + r.error)

  const output = ctl('me').stdout || ''
  assert.match(output, /Seyacat/, 'the vault shows the new nickname:\n' + output)
  assert.match(output, /image\/png/, 'and that there is a photo, with its type:\n' + output)
  assert.match(output, /8\.8 KB/, 'and its size:\n' + output)
  assert.match(output, /sandrade@dotrino\.com/, 'and the data:\n' + output)
  assert.match(output, /0999.*oculto/, 'respecting what the user marked as hidden:\n' + output)
  assert.ok(!output.includes('base64'), 'but it does NOT dump the photo data-URI in the terminal')

  // Y escribir en la bóveda queda ANOTADO: antes la bitácora contaba quién entró, pero no
  // qué hizo después.
  const b = activity()
  assert.match(b, /profileSet|guardó|store/i, 'the write is in the activity log:\n' + b)
})

scenario('an already paired device KEEPS receiving the record (sinceSeq)', async () => {
  // Un navegador que ya entró manda SIEMPRE `sinceSeq` para que le llegue la cadena que se
  // perdió. Esa rama llamaba a `identity.actaHistory`, que no existía en el envoltorio de
  // Node: TypeError síncrono, la bóveda contestaba error, y el aparato se quedaba con la
  // copia del acta del día que emparejó — sin permisos nuevos, sin nombres nuevos y sin
  // forma de enterarse. El escenario con sinceSeq=0 no lo pillaba.
  for (const since of [0, 1]) {
    const r = await runScript('nuevo', SCRIPT_DEVICES, {
      env: { SINCE: String(since) }, what: `the device list with sinceSeq=${since}`
    })
    assert.ok(r.ok, `with sinceSeq=${since} the vault should answer: ` + r.error)
    assert.ok(r.value.seq >= 1, 'and send the record: ' + JSON.stringify(r.value))
    assert.ok(r.value.members >= 2, 'with its members: ' + JSON.stringify(r.value))
  }
})

scenario('renaming a device: the name you recognise it by', async () => {
  // El aparato entra con el nombre que le da la identidad al emparejarse —y si no le
  // pusiste uno, con TU apodo de ese momento—, así que se queda desfasado en cuanto te
  // renombras. Antes cambiarlo exigía revocarlo y volver a emparejarlo.
  const id = await idOf(newcomer.pub)
  assert.ok(members().includes('nuevo'), 'it joined with the pairing label')

  const r = ctl(`label ${id} "Teléfono de casa"`)
  assert.equal(r.status, 0, 'the CLI accepted the change: ' + (r.stderr || r.stdout))
  await sleep(1200)

  const acta = members()
  assert.ok(acta.includes('Teléfono de casa'), 'the record calls it by its new name:\n' + acta)
  assert.ok(acta.includes(id), 'and it is still the same device')

  // La lista de DISPOSITIVOS lee las delegaciones, no el acta: si solo se tocara una de
  // las dos, el nombre viejo seguiría a la vista donde más se mira.
  const devs = ctl('devices').stdout || ''
  assert.ok(devs.includes('Teléfono de casa'), 'and so do the delegations:\n' + devs)
  assert.ok(!devs.includes('· nuevo'), 'the old name is gone')

  // Renombrar NO toca permisos: sigue pudiendo guardar lo suyo.
  const still = await runScript('nuevo', SCRIPT_SECRET, {
    env: { ARGS: JSON.stringify({ method: 'secure.list' }) }, what: 'its sensitive data'
  })
  assert.ok(still.ok, 'renaming did not remove permissions: ' + still.error)
})

scenario('renouncing: the device drops signing and the vault SEALS it in the record', async () => {
  // Renunciar no pasa por el Master (funciona con la bóveda apagada, que es cuando hace
  // falta), pero tiene que LLEGAR al acta: una renuncia que solo vive en el aparato no es
  // oponible a nadie —la bóveda le seguiría aceptando peticiones— y en el caso que la
  // justifica, que te lo roben, su copia local no vale nada.
  const r = await runScript('nuevo', SCRIPT_RENOUNCE, { what: 'the renunciation' })
  assert.ok(r.ok, 'the vault should seal it: ' + r.error)

  const id = await idOf(newcomer.pub)
  assert.ok(!/firma/.test(capsOf(id)), 'the record no longer grants it signing:\n' + members())
  assert.match(activity(), /renounce|renunci/i, 'and it is in the activity log')

  // Y el Master puede devolvérselo: si conceder no limpiara la renuncia, `effectiveCaps`
  // la restaría para siempre y la promesa de la interfaz sería mentira.
  ctl(`caps ${id} +firma`)
  await sleep(1500)
  assert.match(capsOf(id), /firma/, 'the Master gives it back:\n' + members())
})

scenario('removing «administra» cuts administration AT ONCE', async () => {
  ctl(`caps ${await idOf(admin.pub)} -administra`)
  await sleep(1200)
  // Con el cert TODAVÍA en la mano (no ha caducado): antes seguía administrando hasta un
  // mes, porque solo se miraba el cert. Ahora se cruza con el acta, como los secretos.
  const r = await runScript('admin', SCRIPT_ADMIN, {
    env: { ARGS: JSON.stringify({ op: 'pending' }) }, what: 'the answer to pending'
  })
  assert.equal(r.ok, false, 'it should no longer administer')
  assert.match(r.error, /unauthorized/, r.error)

  // Y el cambio de permisos se le avisa a TODOS los miembros, incluido el que acaba de
  // entrar: es la prueba de que el aparato nuevo quedó enganchado al canal de avisos.
  for (const who of ['admin', 'nuevo']) {
    await waitFor(() => events[who].some((e) => e.ev === 'caps' && !e.caps.includes('admin')),
      { what: `the permission-change notice on «${who}»` })
    assert.ok(events[who].find((e) => e.ev === 'caps').signed, `the notice to «${who}» is signed`)
  }
})

scenario('and renewing does not give the permission back: the cert follows the record', async () => {
  const r = await runScript('admin', SCRIPT_RENEW, { what: 'the renewal' })
  assert.ok(r.ok, 'it should be able to renew (it is still a member): ' + r.error)
  assert.ok(!r.value.scope.includes('vault:admin'), 'but without administration: ' + r.value.scope)
})

scenario('the vault RE-SENDS the signed notice to a revoked device', async () => {
  // Quitar un aparato mientras está apagado era invisible para él: el aviso firmado se
  // manda una vez y, si no estaba escuchando, no volvía a mandarse nunca. Con un error
  // suelto no puede borrar nada —no va firmado, y borrar con eso sería destruir datos
  // ajenos con un mensaje— así que seguía enseñando el perfil como si nada.
  const id = await idOf(newcomer.pub)
  ctl(`revoke ${id}`)   // por IDENTIFICADOR: todos sus certificados
  await sleep(1200)

  const r = await runScript('nuevo', SCRIPT_REVOKED, { what: 'the revocation notice' })
  assert.ok(r.ok, 'the vault should re-send the notice, not just say «unauthorized»: ' + r.error)
  assert.ok(r.value.signed, 'and SIGNED by the master: without a signature the device cannot delete anything')

  // Y se va del ACTA, no solo de la lista de certificados. Quitar era media operación
  // en cada sitio: la pantalla del PC le retiraba los papeles pero lo dejaba de miembro,
  // así que la consola web seguía pintando «un dispositivo que en la bóveda ya no
  // existe». La lista de miembros es la que ve la web.
  const list = members()
  assert.ok(!list.includes(id), 'the removed device is still in the record:\n' + list)
})

// ---------- arranque ----------

const engine = pickEngine()
console.log(`\nSMOKE · remote console: admit remotely, each device in its own box (engine: ${engine})\n`)
if (!fs.existsSync(path.join(ROOT, 'dotrino-vault/dist/dotrino-vaultd'))) {
  console.error('Missing the binary. Build it with:  cd dotrino-vault && bash packaging/build.sh\n')
  process.exit(2)
}
try {
  proxy = await startProxy({ log })
  console.log(`  local proxy at ${proxy.url}`)
  console.log(`  ecosystem mounted read-only from ${ECO}\n`)
  const ok = await runScenarios()
  destroyBoxes()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  destroyBoxes()
  await teardown()
  process.exit(1)
}
