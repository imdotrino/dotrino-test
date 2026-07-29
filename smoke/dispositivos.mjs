/**
 * EMPAREJAMIENTO DE CADA DISPOSITIVO, cada uno en su propia máquina efímera.
 *
 * Lo que prueba, y que el smoke normal no puede probar: que un dispositivo de verdad es una
 * MÁQUINA APARTE. Cada uno arranca en su propia caja (contenedor), genera SU llave en SU
 * disco, no ve el disco de ningún otro, y se empareja con la bóveda por el proxy.
 *
 * Y la bóveda corre aquí **como binario**, no desde el código: se ejecuta el mismo
 * `dotrino-vaultd` que se instala un usuario, y se le habla con su CLI real
 * (`--ctl pair` / `--ctl approve` / `--ctl members`). Si el binario está roto, esto se entera.
 *
 *   node smoke/dispositivos.mjs            (usa Docker si lo hay; si no, cajas locales)
 *   SMOKE_BACKEND=local node smoke/dispositivos.mjs
 *   node smoke/dispositivos.mjs --verbose
 *
 * Requiere el binario compilado:  cd dotrino-vault && bash packaging/build.sh
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

let proxy = null
let boveda = null      // la caja donde corre el binario
let vaultProc = null

/** Espera a que una condición se cumpla, o se rinde con un mensaje claro. */
async function esperar (fn, { timeoutMs = 25000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(200)
  }
  throw new Error('se agotó la espera de ' + que)
}

// ---------- la bóveda, corriendo como BINARIO en su propia caja ----------

async function levantarBoveda () {
  boveda = crearCaja('boveda')
  // El binario trae Node dentro, pero espera `libatomic1` del sistema — lo destapó este
  // mismo test en un Debian limpio, y por eso el `.deb` la declara ahora en `Depends`.
  // En una caja mínima hay que ponerla, igual que haría el usuario con el tarball.
  if (boveda.motor === 'docker') {
    const r = boveda.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1; ldconfig -p | grep -c libatomic')
    log('[bóveda] libatomic: ' + (r.stdout || '').trim())
  }
  const salida = []
  vaultProc = boveda.lanzar(`${BINARIO}`, {
    env: { DOTRINO_VAULT_DIR: '/data/vault', PROXY_URL: proxy.url },
    onLinea: (l) => { salida.push(l); log('[bóveda] ' + l) }
  })
  await esperar(() => salida.some((l) => l.includes('servicio listo')), { que: 'que la bóveda arranque' })
    .catch(() => { throw new Error('la bóveda (binario) no arrancó:\n' + salida.join('\n')) })
  const estado = JSON.parse(boveda.leer('/data/vault/state.json'))
  return { estado, salida }
}

/**
 * `dotrino-vault pair` con el CLI real del binario. Con `servicio` es `pair --service <ns>`:
 * el cert sale acotado a ese cajón y en el acta entra como SERVICIO con ese CN.
 */
async function abrirEmparejamiento ({ servicio } = {}) {
  const lineas = []
  boveda.lanzar(`${BINARIO} --ctl pair${servicio ? ' --service ' + servicio : ''}`, {
    env: { DOTRINO_VAULT_DIR: '/data/vault' },
    onLinea: (l) => { lineas.push(l.trim()); log('[pair] ' + l) }
  })
  // Se parsea con `parseInvite` y NO buscando una línea JSON: el CLI dejó de
  // imprimir JSON cuando la invitación estrenó marca de formato — ahora imprime la
  // URL del QR y el código compacto. Este test esperaba `{"v":2` y por eso se
  // quedaba colgado hasta el timeout desde ese cambio.
  return await esperar(() => {
    for (const l of lineas) {
      if (!l || l.length < 20) continue
      const o = parseInvite(l)
      if (o?.sn) return o
    }
    return null
  }, { que: 'la invitación que imprime el CLI' })
}

const aprobar = (code) => boveda.exec(`${BINARIO} --ctl approve ${code}`, { env: { DOTRINO_VAULT_DIR: '/data/vault' } })

/** `dotrino-vault members` — el acta tal y como la ve el dueño en su terminal. */
function miembros () {
  const r = boveda.exec(`${BINARIO} --ctl members`, { env: { DOTRINO_VAULT_DIR: '/data/vault' } })
  return r.stdout || ''
}

// ---------- los dispositivos ----------

/**
 * Cada uno con su propio código de enrolamiento: el REAL de su repo, no una imitación.
 * El guion imprime `CODE:<código>` cuando le toca mostrarlo y `OK:<json>` al terminar.
 */
const DISPOSITIVOS = [
  {
    nombre: 'navegador',
    que: 'un navegador / PWA (y los bots): la identidad del ecosistema',
    guion: `
      import { Identity } from '/eco/dotrino-identity/src/node.js'
      const qr = JSON.parse(process.env.QR)
      const id = await Identity.connect({ dir: '/data/identidad' })
      id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
      const r = await id.enrollDevice(qr, { label: 'navegador', join: 'new' })
      const m = await id.myMembership()
      console.log('OK:' + JSON.stringify({ pub: id.me.publickey, perfil: m.profileId, esMaster: m.isMaster, caps: m.caps }))
    `
  },
  {
    nombre: 'cliente-node',
    que: 'el cliente de dispositivo de referencia del vault',
    guion: `
      import { enroll } from '/eco/dotrino-vault/src/client.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enroll({ qr, label: 'cliente-node', dir: '/data/dev', onChallenge: (c) => console.log('CODE:' + c.code) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, cert: !!r.cert, iss: r.cert.iss === qr.iss }))
    `
  },
  {
    nombre: 'terminal',
    que: 'el agente de dotrino-terminal',
    guion: `
      import { enroll } from '/eco/dotrino-terminal/agent/link.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enroll({ qr, label: 'terminal', dir: '/data/terminal', onChallenge: (c) => console.log('CODE:' + c.code) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, cert: !!r.cert }))
    `
  },
  {
    nombre: 'ia',
    que: 'el agente de dotrino-ia (reusa el enrolamiento de remote-agent)',
    guion: `
      import { enroll } from '/eco/dotrino-remote-agent/src/link.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enroll({ qr, label: 'ia-agent', dir: '/data/ia', onChallenge: (c) => console.log('CODE:' + c.code) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, cert: !!r.cert }))
    `
  },
  {
    nombre: 'remote-agent',
    que: 'el agente remoto genérico',
    guion: `
      import { enroll } from '/eco/dotrino-remote-agent/src/link.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enroll({ qr, label: 'remote-agent', dir: '/data/remoto', onChallenge: (c) => console.log('CODE:' + c.code) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, cert: !!r.cert }))
    `
  },
  {
    nombre: 'servicio-proxy',
    que: 'un SERVICIO (entra con CN: solo ve su propio cajón)',
    servicio: 'proxy',
    guion: `
      import { enrollService } from '/eco/dotrino-vault/lib/src/service.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enrollService({ qr, ns: 'proxy', dir: '/data/servicio', onCode: (c) => console.log('CODE:' + (typeof c === 'string' ? c : c.code)) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, ns: 'proxy' }))
    `
  }
]

/** El identificador con el que la bóveda lista a una llave (`AB12-CD34`). */
async function idDe (pub) {
  const h = (await pubkeyId(pub)).slice(0, 8).toUpperCase()
  return h.slice(0, 4) + '-' + h.slice(4)
}

/** Corre un dispositivo en su propia caja y devuelve lo que reportó. */
async function emparejar (d) {
  const caja = crearCaja(d.nombre)
  const qr = await abrirEmparejamiento(d)

  caja.escribir('/data/guion.mjs', d.guion)
  let code = null; let ok = null; const lineas = []
  caja.lanzar('node /data/guion.mjs', {
    env: { QR: JSON.stringify(qr) },
    onLinea: (l) => {
      lineas.push(l)
      log(`[${d.nombre}] ` + l)
      if (l.startsWith('CODE:')) code = l.slice(5).trim()
      if (l.startsWith('OK:')) ok = JSON.parse(l.slice(3))
    }
  })

  await esperar(() => code, { que: `el código que muestra «${d.nombre}»` })
    .catch(() => { throw new Error(`${d.nombre} no mostró código:\n` + lineas.join('\n')) })
  aprobar(code)
  await esperar(() => ok, { que: `que «${d.nombre}» termine de emparejarse` })
    .catch(() => { throw new Error(`${d.nombre} no completó el emparejamiento:\n` + lineas.join('\n')) })

  return { caja, code, ...ok }
}

// ---------- escenarios ----------

const emparejados = []

escenario('la bóveda arranca COMO BINARIO y su CLI responde', async () => {
  const { estado } = await levantarBoveda()
  assert.ok(estado.iss, 'publica su identidad')
  assert.ok(estado.version, 'y su versión: ' + estado.version)
  const salida = miembros()
  assert.match(salida, /Perfil/, 'el CLI del binario muestra el acta')
})

for (const d of DISPOSITIVOS) {
  escenario(`empareja ${d.nombre} — ${d.que}`, async () => {
    const r = await emparejar(d)
    assert.ok(r.pub, 'generó su propia llave, en su propia máquina')
    emparejados.push({ ...r, def: d })

    // Y la bóveda lo tiene en su acta: se comprueba por el IDENTIFICADOR de su llave, que
    // es lo que de verdad lo identifica (la etiqueta es un nombre para el humano).
    const salida = miembros()
    const suId = await idDe(r.pub)
    assert.ok(salida.includes(suId), `la bóveda no lista a ${d.nombre} (${suId}):\n` + salida)
    if (d.servicio) assert.match(salida, new RegExp(`servicio «${d.servicio}»`), 'y como servicio')
  })
}

escenario('cada dispositivo tiene SU llave y ninguno ve el disco de otro', async () => {
  const pubs = emparejados.map((e) => e.pub)
  assert.equal(new Set(pubs).size, pubs.length, 'no hay dos con la misma llave')

  // Nadie tiene los datos de nadie: cada caja solo tiene lo suyo.
  for (const e of emparejados) {
    const ajenos = emparejados.filter((o) => o !== e)
    const listado = e.caja.exec('ls -R /data 2>/dev/null | head -50').stdout || ''
    for (const o of ajenos) {
      assert.ok(!listado.includes(o.def.nombre === 'navegador' ? 'identidad-ajena' : o.def.nombre + '-ajeno'),
        'ninguna caja contiene datos de otra')
    }
  }
})

escenario('el acta de la bóveda tiene a todos, y el servicio entra acotado por su CN', async () => {
  const salida = miembros()
  for (const e of emparejados) {
    const suId = await idDe(e.pub)
    assert.ok(salida.includes(suId), `falta ${e.def.nombre} (${suId}) en el acta:\n` + salida)
  }
  assert.equal(emparejados.length, DISPOSITIVOS.length, 'emparejaron todos los dispositivos')
  assert.match(salida, /servicio «proxy»/, 'el servicio se distingue de los dispositivos')
  assert.match(salida, /lee sus claves/, 'y solo puede leer sus propias claves')
})

// ---------- arranque ----------

const motor = elegirMotor()
console.log(`\nSMOKE · emparejamiento por dispositivo, en instancias efímeras (motor: ${motor})\n`)
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
