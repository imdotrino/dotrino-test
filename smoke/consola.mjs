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
 *   node smoke/consola.mjs            (Docker si lo hay; si no, cajas locales)
 *   SMOKE_BACKEND=local node smoke/consola.mjs
 *   node smoke/consola.mjs --verbose
 *
 * Requiere el binario:  cd dotrino-vault && bash packaging/build.sh
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { escenario, correr, startProxy, teardown, ROOT } from './lib/harness.js'
import { pubkeyId } from '../../dotrino-identity/vault/capabilities.js'
import { crearCaja, destruirCajas, elegirMotor, ECO } from './lib/caja.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BINARIO = '/eco/dotrino-vault/dist/dotrino-vaultd'
const VAULT_ENV = { DOTRINO_VAULT_DIR: '/data/vault' }

let proxy = null
let boveda = null
const cajas = {}
const eventos = { admin: [], nuevo: [] }   // los `vault.admin.event` que recibió cada uno

async function esperar (fn, { timeoutMs = 25000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(200)
  }
  throw new Error('se agotó la espera de ' + que)
}

/** `AB12-CD34`, que es como lista la bóveda a una llave. */
async function idDe (pub) {
  const h = (await pubkeyId(pub)).slice(0, 8).toUpperCase()
  return h.slice(0, 4) + '-' + h.slice(4)
}

// ---------- la bóveda: el binario, manejado con su CLI ----------

async function levantarBoveda () {
  boveda = crearCaja('boveda')
  // El binario trae Node dentro pero espera `libatomic1` del sistema (lo destapó el smoke
  // de dispositivos en un Debian limpio; por eso el `.deb` la declara).
  if (boveda.motor === 'docker') {
    boveda.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  }
  const salida = []
  boveda.lanzar(BINARIO, {
    env: { ...VAULT_ENV, PROXY_URL: proxy.url },
    onLinea: (l) => { salida.push(l); log('[bóveda] ' + l) }
  })
  await esperar(() => salida.some((l) => l.includes('servicio listo')), { que: 'que la bóveda arranque' })
    .catch(() => { throw new Error('la bóveda (binario) no arrancó:\n' + salida.join('\n')) })
  return { estado: JSON.parse(boveda.leer('/data/vault/state.json')), salida }
}

const ctl = (cmd) => boveda.exec(`${BINARIO} --ctl ${cmd}`, { env: VAULT_ENV })
const miembros = () => ctl('members').stdout || ''
const bitacora = () => ctl('activity 60').stdout || ''

/** `dotrino-vault pair` EN EL PC (para el primer aparato: el admin todavía no existe). */
async function emparejamientoDesdeElPC () {
  const lineas = []
  boveda.lanzar(`${BINARIO} --ctl pair`, { env: VAULT_ENV, onLinea: (l) => { lineas.push(l.trim()); log('[pair] ' + l) } })
  return await esperar(() => {
    for (const l of lineas) {
      if (!l || l.length < 20) continue
      const o = parseInvite(l)
      if (o?.sn) return o
    }
    return null
  }, { que: 'la invitación que imprime el CLI' })
}

// ---------- los dispositivos, cada uno en su caja ----------

/** Guion que enrola con el cliente REAL del vault y deja el cert en el disco de la caja. */
const GUION_ENROLAR = `
  import fs from 'node:fs'
  import { enroll } from '/eco/dotrino-vault/src/client.js'
  const qr = JSON.parse(process.env.QR)
  const r = await enroll({ qr, label: process.env.ETIQUETA, dir: '/data/dev', onChallenge: (c) => console.log('CODE:' + c.code) })
  fs.writeFileSync('/data/dev.json', JSON.stringify({ device: r.device, cert: r.cert, iss: r.iss }))
  console.log('OK:' + JSON.stringify({ pub: r.device.publickey, scope: r.cert.scope }))
`

/**
 * Escucha los avisos firmados de la bóveda (`vault.admin.event`). Es un proceso aparte y
 * vivo: un aviso que no llega al aparato no sirve de nada, y eso solo se ve así.
 */
const GUION_ESCUCHAR = `
  import fs from 'node:fs'
  // Por RUTA y no por nombre: el guion vive en /data, así que un import desnudo no
  // encuentra los node_modules del vault (que están en /eco, montado de solo lectura).
  import { WebSocketProxyClient } from '/eco/dotrino-vault/node_modules/@dotrino/proxy-client/src/index.js'
  import { installNodeGlobals } from '/eco/dotrino-vault/src/node-globals.js'
  import { identifyAsDevice, verifyAdminEvent } from '/eco/dotrino-vault/src/client.js'
  import { MSG } from '/eco/dotrino-vault/lib/src/protocol.js'
  installNodeGlobals('/data/escucha')
  const { device, iss } = JSON.parse(fs.readFileSync('/data/dev.json', 'utf8'))
  const c = new WebSocketProxyClient({ url: process.env.PROXY, enableWebRTC: false, autoReconnect: true })
  await c.connect()
  await identifyAsDevice(c, device)
  console.log('LISTO')
  c.on('message', async (_f, p) => {
    if (!p || p.type !== MSG.ADMIN_EVENT) return
    // Un aviso SIN FIRMA no se muestra: si no, cualquiera llenaría de alarmas el aparato.
    const ok = await verifyAdminEvent({ body: p.body, signature: p.signature, master: iss })
    console.log('EVENT:' + JSON.stringify({ ...p.body, firmado: ok }))
  })
  setInterval(() => {}, 1 << 30)
`

/** Una operación de la consola remota, desde el aparato. Imprime `RES:` o `ERR:`. */
const GUION_ADMIN = `
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

/** Renovar: el cert nuevo sale con el scope que dice el ACTA, no con el que tenía. */
const GUION_RENOVAR = `
  import fs from 'node:fs'
  import { requestRenew } from '/eco/dotrino-vault/src/client.js'
  const d = JSON.parse(fs.readFileSync('/data/dev.json', 'utf8'))
  try {
    const { cert } = await requestRenew({ masterPubkey: d.iss, proxyUrl: process.env.PROXY, device: d.device, cert: d.cert, dir: '/data/ren' })
    fs.writeFileSync('/data/dev.json', JSON.stringify({ ...d, cert }))
    console.log('RES:' + JSON.stringify({ scope: cert.scope }))
  } catch (e) { console.log('ERR:' + e.message) }
  process.exit(0)
`

/** F4 — datos sensibles: guardar y recuperar un sobre cerrado por el camino real. */
const GUION_SECRETO = `
  import fs from 'node:fs'
  import { requestStore } from '/eco/dotrino-vault/src/client.js'
  const { device, cert, iss } = JSON.parse(fs.readFileSync('/data/dev.json', 'utf8'))
  const args = JSON.parse(process.env.ARGS || '{}')
  try {
    const r = await requestStore({ masterPubkey: iss, proxyUrl: process.env.PROXY, device, cert, dir: '/data/st', ...args })
    console.log('RES:' + JSON.stringify(r))
  } catch (e) { console.log('ERR:' + e.message) }
  process.exit(0)
`

/** Corre un guion en la caja y espera su `RES:`/`ERR:`. */
async function correrGuion (nombre, guion, { env = {}, que = 'el guion' } = {}) {
  const caja = cajas[nombre]
  caja.escribir('/data/paso.mjs', guion)
  let salida = null; const lineas = []
  caja.lanzar('node /data/paso.mjs', {
    env: { PROXY: proxy.url, ...env },
    onLinea: (l) => {
      lineas.push(l); log(`[${nombre}] ` + l)
      if (l.startsWith('RES:')) salida = { ok: true, valor: JSON.parse(l.slice(4)) }
      if (l.startsWith('ERR:')) salida = { ok: false, error: l.slice(4) }
    }
  })
  await esperar(() => salida, { que }).catch(() => { throw new Error(`${nombre}: sin respuesta de ${que}:\n` + lineas.join('\n')) })
  return salida
}

/** Enrola un aparato en su propia caja, con el QR que le den, y lo deja escuchando avisos. */
async function enrolarEnCaja (nombre, qr, { aprobar }) {
  const caja = cajas[nombre] = crearCaja(nombre)
  caja.escribir('/data/enrolar.mjs', GUION_ENROLAR)
  let code = null; let ok = null; const lineas = []
  caja.lanzar('node /data/enrolar.mjs', {
    env: { QR: JSON.stringify(qr), ETIQUETA: nombre },
    onLinea: (l) => {
      lineas.push(l); log(`[${nombre}] ` + l)
      if (l.startsWith('CODE:')) code = l.slice(5).trim()
      if (l.startsWith('OK:')) ok = JSON.parse(l.slice(3))
    }
  })
  // El código lo MUESTRA el aparato que entra; aquí hacemos de humano que lo lee.
  await esperar(() => code, { que: `el código que muestra «${nombre}»` })
    .catch(() => { throw new Error(`${nombre} no mostró código:\n` + lineas.join('\n')) })
  await aprobar(code)
  await esperar(() => ok, { que: `que «${nombre}» termine de entrar` })
    .catch(() => { throw new Error(`${nombre} no completó el emparejamiento:\n` + lineas.join('\n')) })

  // Y se queda escuchando: los avisos hay que recibirlos, no suponerlos.
  caja.escribir('/data/escuchar.mjs', GUION_ESCUCHAR)
  let listo = false
  caja.lanzar('node /data/escuchar.mjs', {
    env: { PROXY: proxy.url },
    onLinea: (l) => {
      log(`[${nombre}·escucha] ` + l)
      if (l === 'LISTO') listo = true
      if (l.startsWith('EVENT:')) eventos[nombre]?.push(JSON.parse(l.slice(6)))
    }
  })
  await esperar(() => listo, { que: `que «${nombre}» se ponga a escuchar avisos` })
  return ok
}

// ---------- escenarios ----------

let admin = null
let nuevo = null

escenario('la bóveda arranca como binario y el admin entra como un aparato normal', async () => {
  await levantarBoveda()
  const qr = await emparejamientoDesdeElPC()
  admin = await enrolarEnCaja('admin', qr, { aprobar: (code) => ctl(`approve ${code}`) })
  assert.ok(admin.pub, 'generó su llave en su propia máquina')
  // Recién emparejado NO administra: eso se concede aparte, y a propósito.
  assert.ok(!admin.scope.includes('vault:admin'), 'el QR nunca otorga administración: ' + admin.scope)
  assert.ok(miembros().includes(await idDe(admin.pub)), 'la bóveda lo lista en el acta')
})

escenario('sin «administra», la consola remota le dice que no', async () => {
  const r = await correrGuion('admin', GUION_ADMIN, { env: { ARGS: JSON.stringify({ op: 'pending' }) }, que: 'la respuesta a pending' })
  assert.equal(r.ok, false, 'no debería poder administrar')
  assert.match(r.error, /unauthorized/, r.error)
})

escenario('el dueño concede «administra» EN EL PC y el permiso llega renovando el cert', async () => {
  const id = await idDe(admin.pub)
  const salida = ctl(`caps ${id} +administra`)
  assert.equal(salida.status, 0, 'el CLI aceptó el cambio: ' + (salida.stderr || salida.stdout))
  await sleep(1200)
  assert.match(miembros(), /administra el perfil/i, 'el acta ya dice que administra:\n' + miembros())

  // El cert VIEJO sigue sin el scope: la política vive en el acta, y el cert es su
  // reflejo. Renovar es lo que lo pone al día — antes copiaba el scope viejo y el
  // permiso concedido no llegaba NUNCA al cert.
  const r = await correrGuion('admin', GUION_RENOVAR, { que: 'la renovación' })
  assert.ok(r.ok, 'no pudo renovar: ' + r.error)
  assert.ok(r.valor.scope.includes('vault:admin'), 'el cert nuevo estrena vault:admin: ' + r.valor.scope)
})

escenario('ahora sí administra: ve la bitácora y lo pendiente', async () => {
  const r = await correrGuion('admin', GUION_ADMIN, { env: { ARGS: JSON.stringify({ op: 'audit', limit: 10 }) }, que: 'la bitácora' })
  assert.ok(r.ok, 'debería poder leer la bitácora: ' + r.error)
  assert.ok(Array.isArray(r.valor.entries), 'devuelve entradas')
})

escenario('un admin NO puede crear otro admin ni emparejar servicios', async () => {
  for (const scope of [['vault:admin'], ['vault:secrets:proxy']]) {
    const r = await correrGuion('admin', GUION_ADMIN, {
      env: { ARGS: JSON.stringify({ op: 'pair', scope }) }, que: 'la respuesta a pair'
    })
    assert.equal(r.ok, false, `pair con ${scope} debería rechazarse`)
    assert.match(r.error, /cannot grant admin or service secrets/, r.error)
  }
  // Y la frontera está en la BÓVEDA, no en la pantalla: queda escrito en la bitácora.
  assert.match(bitacora(), /forbidden-scope/, 'el rechazo queda auditado')
})

escenario('EL PASO CLAVE: el admin admite a un aparato nuevo SIN TOCAR EL PC', async () => {
  const r = await correrGuion('admin', GUION_ADMIN, {
    env: { ARGS: JSON.stringify({ op: 'pair', label: 'nuevo' }) }, que: 'la invitación remota'
  })
  assert.ok(r.ok, 'el admin debería poder abrir un emparejamiento: ' + r.error)
  const qr = r.valor.qr
  assert.ok(qr?.sn, 'responde la invitación para pintar el QR')

  // El aparato nuevo entra y muestra su código; el ADMIN lo teclea desde su máquina.
  nuevo = await enrolarEnCaja('nuevo', qr, {
    aprobar: async (code) => {
      const a = await correrGuion('admin', GUION_ADMIN, {
        env: { ARGS: JSON.stringify({ op: 'approve', code }) }, que: 'la aprobación remota'
      })
      assert.ok(a.ok, 'el admin no pudo aprobar: ' + a.error)
    }
  })
  assert.ok(nuevo.pub, 'el aparato nuevo generó su llave')
  assert.ok(miembros().includes(await idDe(nuevo.pub)), 'y está en el acta de la bóveda')

  // La bitácora dice QUIÉN aprobó, no solo que se aprobó: con la administración
  // delegada, «se aprobó» ya no identifica a nadie.
  const b = bitacora()
  assert.match(b, /admin\.approve/, 'la aprobación remota queda auditada:\n' + b)
  assert.ok(b.includes(await idDe(admin.pub)), 'y con el aparato que la pidió:\n' + b)
})

escenario('administrar a distancia NO es invisible: el aviso llega firmado', async () => {
  // Esto es la contrapartida de delegar la administración: si un admin comprometido mete
  // un aparato, tiene que verse sin ir a mirar la bitácora.
  await esperar(() => eventos.admin.some((e) => e.ev === 'enrolled'), { que: 'el aviso de que entró alguien' })
  const ev = eventos.admin.find((e) => e.ev === 'enrolled')
  assert.ok(ev.firmado, 'viene firmado por la maestra (uno sin firma no se muestra)')
  assert.equal(ev.by, await idDe(admin.pub), 'y dice QUIÉN lo admitió')
  assert.equal(eventos.admin.filter((e) => e.ev === 'enrolled' && e.ts === ev.ts).length, 1,
    'una sola vez: renovar el cert no debe multiplicar el aviso')

  // Al recién llegado NO se le avisa de su propia entrada: se entera recibiendo su
  // certificado, y cuando se pone a escuchar el aviso ya pasó. Que está en el canal se
  // comprueba con el siguiente evento (más abajo, al quitarle «administra» al otro).
})

escenario('F4 — datos sensibles: el aparato guarda un sobre cerrado y lo recupera', async () => {
  const puesto = await correrGuion('nuevo', GUION_SECRETO, {
    env: { ARGS: JSON.stringify({ method: 'secure.put', args: { meta: 'META-SELLADA', enc: 'VALOR-SELLADO' } }) },
    que: 'guardar el dato sensible'
  })
  assert.ok(puesto.ok, 'no pudo guardar: ' + puesto.error)
  const id = puesto.valor.id

  const lista = await correrGuion('nuevo', GUION_SECRETO, {
    env: { ARGS: JSON.stringify({ method: 'secure.list' }) }, que: 'la lista'
  })
  assert.equal(lista.valor.length, 1)
  assert.equal(lista.valor[0].meta, 'META-SELLADA')
  assert.equal(lista.valor[0].enc, undefined, 'listar NO baja el valor')

  const uno = await correrGuion('nuevo', GUION_SECRETO, {
    env: { ARGS: JSON.stringify({ method: 'secure.get', args: { id } }) }, que: 'la ficha'
  })
  assert.equal(uno.valor.enc, 'VALOR-SELLADO', 'el valor solo viaja al abrir la ficha')

  // Y en el disco de la bóveda no se ve nada: `threads.json` va cifrado en reposo.
  const raw = boveda.leer('/data/vault/p/' + (boveda.exec('ls /data/vault/p').stdout || '').trim().split('\n')[0] + '/threads.json') || ''
  assert.ok(!raw.includes('VALOR-SELLADO'), 'el valor no queda en claro en el disco de la bóveda')
})

escenario('el perfil que editas en el aparato se ve en la bóveda (`dotrino-vault me`)', async () => {
  // Cambiar el apodo o la foto en un dispositivo tiene que llegar a la bóveda —es la copia
  // autoritativa— y el dueño tiene que poder COMPROBARLO desde su máquina. La foto va como
  // data-URI, igual que la manda la identidad de verdad.
  const foto = 'data:image/png;base64,' + Buffer.alloc(9000, 7).toString('base64')
  const r = await correrGuion('nuevo', GUION_SECRETO, {
    env: {
      ARGS: JSON.stringify({
        method: 'profileSet',
        args: { me: { nickname: 'Seyacat', nombres: 'Santiago', email: 'sandrade@dotrino.com', telefono: '0999', telefonoVisible: false, avatar: foto } }
      })
    },
    que: 'guardar el perfil desde el aparato'
  })
  assert.ok(r.ok, 'el aparato no pudo guardar su perfil: ' + r.error)

  const salida = ctl('me').stdout || ''
  assert.match(salida, /Seyacat/, 'la bóveda muestra el apodo nuevo:\n' + salida)
  assert.match(salida, /image\/png/, 'y que hay foto, con su tipo:\n' + salida)
  assert.match(salida, /8\.8 KB/, 'y su tamaño:\n' + salida)
  assert.match(salida, /sandrade@dotrino\.com/, 'y los datos:\n' + salida)
  assert.match(salida, /0999.*oculto/, 'respetando lo que el usuario marcó como oculto:\n' + salida)
  assert.ok(!salida.includes('base64'), 'pero NO vomita el data-URI de la foto en la terminal')

  // Y escribir en la bóveda queda ANOTADO: antes la bitácora contaba quién entró, pero no
  // qué hizo después.
  const b = bitacora()
  assert.match(b, /profileSet|guardó|store/i, 'la escritura queda en la bitácora:\n' + b)
})

escenario('renombrar un dispositivo: el nombre con el que lo reconoces', async () => {
  // El aparato entra con el nombre que le da la identidad al emparejarse —y si no le
  // pusiste uno, con TU apodo de ese momento—, así que se queda desfasado en cuanto te
  // renombras. Antes cambiarlo exigía revocarlo y volver a emparejarlo.
  const id = await idDe(nuevo.pub)
  assert.ok(miembros().includes('nuevo'), 'entró con la etiqueta del emparejamiento')

  const r = ctl(`label ${id} "Teléfono de casa"`)
  assert.equal(r.status, 0, 'el CLI aceptó el cambio: ' + (r.stderr || r.stdout))
  await sleep(1200)

  const acta = miembros()
  assert.ok(acta.includes('Teléfono de casa'), 'el acta lo llama por su nombre nuevo:\n' + acta)
  assert.ok(acta.includes(id), 'y sigue siendo el mismo aparato')

  // La lista de DISPOSITIVOS lee las delegaciones, no el acta: si solo se tocara una de
  // las dos, el nombre viejo seguiría a la vista donde más se mira.
  const devs = ctl('devices').stdout || ''
  assert.ok(devs.includes('Teléfono de casa'), 'y las delegaciones también:\n' + devs)
  assert.ok(!devs.includes('· nuevo'), 'el nombre viejo ya no está')

  // Renombrar NO toca permisos: sigue pudiendo guardar lo suyo.
  const sigue = await correrGuion('nuevo', GUION_SECRETO, {
    env: { ARGS: JSON.stringify({ method: 'secure.list' }) }, que: 'sus datos sensibles'
  })
  assert.ok(sigue.ok, 'renombrar no le quitó permisos: ' + sigue.error)
})

escenario('quitar «administra» corta la administración EN EL ACTO', async () => {
  ctl(`caps ${await idDe(admin.pub)} -administra`)
  await sleep(1200)
  // Con el cert TODAVÍA en la mano (no ha caducado): antes seguía administrando hasta un
  // mes, porque solo se miraba el cert. Ahora se cruza con el acta, como los secretos.
  const r = await correrGuion('admin', GUION_ADMIN, {
    env: { ARGS: JSON.stringify({ op: 'pending' }) }, que: 'la respuesta a pending'
  })
  assert.equal(r.ok, false, 'ya no debería administrar')
  assert.match(r.error, /unauthorized/, r.error)

  // Y el cambio de permisos se le avisa a TODOS los miembros, incluido el que acaba de
  // entrar: es la prueba de que el aparato nuevo quedó enganchado al canal de avisos.
  for (const quien of ['admin', 'nuevo']) {
    await esperar(() => eventos[quien].some((e) => e.ev === 'caps' && !e.caps.includes('admin')),
      { que: `el aviso del cambio de permisos en «${quien}»` })
    assert.ok(eventos[quien].find((e) => e.ev === 'caps').firmado, `el aviso a «${quien}» viene firmado`)
  }
})

escenario('y renovar ya no le devuelve el permiso: el cert sigue al acta', async () => {
  const r = await correrGuion('admin', GUION_RENOVAR, { que: 'la renovación' })
  assert.ok(r.ok, 'debería poder renovar (sigue siendo miembro): ' + r.error)
  assert.ok(!r.valor.scope.includes('vault:admin'), 'pero sin administración: ' + r.valor.scope)
})

// ---------- arranque ----------

const motor = elegirMotor()
console.log(`\nSMOKE · consola remota: admitir a distancia, cada aparato en su caja (motor: ${motor})\n`)
if (!fs.existsSync(path.join(ROOT, 'dotrino-vault/dist/dotrino-vaultd'))) {
  console.error('Falta el binario. Compílalo con:  cd dotrino-vault && bash packaging/build.sh\n')
  process.exit(2)
}
try {
  proxy = await startProxy({ log })
  console.log(`  proxy local en ${proxy.url}`)
  console.log(`  ecosistema montado de solo lectura desde ${ECO}\n`)
  const ok = await correr()
  destruirCajas()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  destruirCajas()
  await teardown()
  process.exit(1)
}
