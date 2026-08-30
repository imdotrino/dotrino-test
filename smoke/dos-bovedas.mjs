/**
 * DOS BÓVEDAS EN LA MISMA CUENTA (multivault), cada una en su propia máquina.
 *
 * Lo que prueba, y que ningún test de un proceso puede probar: que **una bóveda entra en
 * la cuenta de otra con su propia llave** —no con una de aparato inventada—, que el dueño
 * puede darle y quitarle el permiso de **sellar**, y que con ese permiso la segunda
 * bóveda **admite aparatos ella sola**, que es exactamente lo que hay que poder hacer el
 * día que la primera se pierda.
 *
 * Por qué existe esto (dueño, 2026-08-30): *«me resuelve el problema de un desastre que
 * pierda permanentemente un vault»*.
 *
 * Tres cajas, tres máquinas:
 *   · `boveda-a` — la bóveda que tiene la cuenta. Binario real + su CLI.
 *   · `boveda-b` — la otra bóveda. Entra con `join` y recibe `+sella`.
 *   · `aparato`  — un teléfono cualquiera, que entra por B para demostrar que B manda.
 *
 *   node smoke/dos-bovedas.mjs            (Docker si lo hay; si no, cajas locales)
 *   SMOKE_BACKEND=local node smoke/dos-bovedas.mjs
 *   node smoke/dos-bovedas.mjs --verbose
 *
 * Requiere el binario:  cd dotrino-vault && bash packaging/build.sh
 *
 * ⚠️ ESTADO: 3 de 4 escenarios pasan. El cuarto está ROJO A PROPÓSITO y nombra lo que
 * falta, en vez de esconderlo:
 *
 *   `join` mete la cuenta ajena en una cuenta NUEVA de la capa de identidad, y el gestor
 *   de perfiles del daemon no se entera. Resultado: no hay instancia de bóveda para esa
 *   cuenta, nadie se identifica en el proxio con esa llave, y el aviso que manda A
 *   —con el acta donde acaba de conceder `sella`— no llega a ninguna parte. B sigue
 *   creyendo que no puede sellar y no admite a nadie.
 *
 *   Lo que hay que arreglar: que `join` cree un PERFIL DEL GESTOR, como hace
 *   `pair --adopt`, en vez de una cuenta interna de la identidad.
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
const ENV = { DOTRINO_VAULT_DIR: '/data/vault' }

let proxy = null
const bovedas = {}

async function esperar (fn, { timeoutMs = 30000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(200)
  }
  throw new Error('se agotó la espera de ' + que)
}

async function idDe (pub) {
  const h = (await pubkeyId(pub)).slice(0, 8).toUpperCase()
  return h.slice(0, 4) + '-' + h.slice(4)
}

/** Una bóveda de verdad: el binario que se instala un usuario, en su propia caja. */
async function levantar (nombre) {
  const caja = crearCaja(nombre)
  // El binario trae Node dentro pero espera `libatomic1` del sistema (lo destapó el smoke
  // de dispositivos en un Debian limpio; por eso el `.deb` la declara).
  if (caja.motor === 'docker') {
    caja.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  }
  const salida = []
  caja.lanzar(BINARIO, {
    env: { ...ENV, PROXY_URL: proxy.url },
    onLinea: (l) => { salida.push(l); log(`[${nombre}] ` + l) }
  })
  await esperar(() => salida.some((l) => l.includes('servicio listo')), { que: `que arranque ${nombre}` })
    .catch(() => { throw new Error(`${nombre} no arrancó:\n` + salida.join('\n')) })
  const b = {
    caja,
    salida,
    ctl: (cmd) => caja.exec(`${BINARIO} --ctl ${cmd}`, { env: ENV }),
    /** Lanza un `--ctl` que no termina (pair, join) y recoge sus líneas. */
    ctlVivo (cmd) {
      const lineas = []
      caja.lanzar(`${BINARIO} --ctl ${cmd}`, { env: ENV, onLinea: (l) => { lineas.push(l.trim()); log(`[${nombre} ${cmd.split(' ')[0]}] ` + l) } })
      return lineas
    }
  }
  bovedas[nombre] = b
  return b
}

/** `pair` en una bóveda: devuelve la invitación ya parseada. */
async function invitacionDe (b) {
  const lineas = b.ctlVivo('pair')
  return esperar(() => {
    for (const l of lineas) {
      if (!l || l.length < 20) continue
      const o = parseInvite(l)
      if (o?.sn) return o
    }
    return null
  }, { que: 'la invitación que imprime pair' })
}

/** El código de 6 que hay que tipear al otro lado, de una salida cualquiera. */
const codigoEn = (lineas) => esperar(() => {
  for (const l of lineas) {
    const m = /\b(\d{6})\b/.exec(l)
    if (m) return m[1]
  }
  return null
}, { que: 'el código de confirmación' })

let A = null
let B = null
let idB = null

const miembrosA = () => A.ctl('members').stdout || ''
/** Los permisos que el acta le reconoce a un miembro (su línea y la de debajo). */
const permisosDe = (id, salida = miembrosA()) => {
  const l = salida.split('\n')
  const i = l.findIndex((x) => x.includes(id))
  return i >= 0 ? (l[i] + ' ' + (l[i + 1] || '')) : ''
}

escenario('B entra en la cuenta de A CON SU PROPIA LLAVE', async () => {
  A = await levantar('boveda-a')
  B = await levantar('boveda-b')

  const invitacion = await invitacionDe(A)
  const lineasJoin = B.ctlVivo(`join '${JSON.stringify(invitacion).replace(/'/g, "'\\''")}'`)
  const codigo = await codigoEn(lineasJoin)
  log('[test] código que muestra B: ' + codigo)

  A.ctl(`approve ${codigo}`)
  await esperar(() => lineasJoin.some((l) => /ya es miembro|acta #/.test(l)), { que: 'que B confirme que entró' })

  const acta = await esperar(() => {
    const a = miembrosA()
    return [...a.matchAll(/\b([0-9A-F]{4}-[0-9A-F]{4})\b/g)].length >= 2 ? a : null
  }, { que: 'que el acta de A liste a B' })
  log('[test] acta de A tras el join:\n' + acta)

  const ids = [...acta.matchAll(/\b([0-9A-F]{4}-[0-9A-F]{4})\b/g)].map((m) => m[1])
  idB = ids[ids.length - 1]
  assert.ok(idB, 'el acta de A tiene que listar a B')
})

escenario('B NO nace pudiendo sellar: es un permiso y se concede a mano', async () => {
  assert.ok(!/sella|sealer/i.test(permisosDe(idB)),
    'como «administra», sellar no se empareja — se concede desde el PC')
})

escenario('el dueño le DA el permiso de sellar, y se lo puede QUITAR', async () => {
  A.ctl(`caps ${idB} +sella`)
  await esperar(() => /sella|sealer/i.test(permisosDe(idB)), { que: 'que el acta le reconozca sellar' })

  A.ctl(`caps ${idB} -sella`)
  await esperar(() => !/sella|sealer/i.test(permisosDe(idB)), { que: 'que el permiso se retire' })

  A.ctl(`caps ${idB} +sella`)
  await esperar(() => /sella|sealer/i.test(permisosDe(idB)), { que: 'que se pueda volver a dar' })
})

/**
 * EL PASO CLAVE, y el desastre que esto viene a cubrir: A no interviene en ningún momento.
 */
escenario('con el permiso, B admite un aparato ELLA SOLA y A adopta ese acta', async () => {
  const telefono = crearCaja('aparato')
  const invitacionB = await invitacionDe(B)
  const lineas = []
  telefono.escribir('/data/enrolar.mjs', `
    import { enroll } from '/eco/dotrino-vault/src/client.js'
    const qr = JSON.parse(process.env.QR)
    const r = await enroll({ qr, label: 'teléfono', dir: '/data/dev', onChallenge: (c) => console.log('CODE:' + c.code) })
    console.log('OK:' + JSON.stringify({ pub: r.device.publickey }))
  `)
  telefono.lanzar('node /data/enrolar.mjs', {
    env: { QR: JSON.stringify(invitacionB) },
    onLinea: (l) => { lineas.push(l.trim()); log('[aparato] ' + l) }
  })
  const codigoTel = await esperar(() => {
    const l = lineas.find((x) => x.startsWith('CODE:'))
    return l ? l.slice(5) : null
  }, { que: 'el código del teléfono' })

  B.ctl(`approve ${codigoTel}`)
  const ok = await esperar(() => lineas.find((l) => l.startsWith('OK:')), {
    que: 'que el teléfono acabe de enrolarse por B.\n' +
      '      SE SABE POR QUÉ FALLA (ver la cabecera): `join` deja la cuenta en una cuenta\n' +
      '      interna de la identidad que el gestor de perfiles del daemon no conoce, así que\n' +
      '      B no se identifica con esa llave, no recibe el acta donde A le dio `sella`, y\n' +
      '      sigue sin poder admitir. Arreglo: que `join` cree un perfil del gestor.'
  })
  const idTel = await idDe(JSON.parse(ok.slice(3)).pub)
  log('[test] el teléfono entró por B: ' + idTel)

  // Lo que cierra el círculo: no son dos cuentas paralelas, es UNA. Lo que sella B lo
  // adopta A por las reglas de siempre (§2.4.1), sin que nadie toque el PC de A.
  await esperar(() => miembrosA().includes(idTel), {
    timeoutMs: 45000,
    que: 'que A adopte el acta que selló B'
  })
})

// ---------- arranque ----------

const motor = elegirMotor()
console.log(`\nSMOKE · dos bóvedas en la misma cuenta (motor: ${motor})\n`)
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
