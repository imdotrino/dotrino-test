/**
 * APROBAR UN PEDIDO CON LA BÓVEDA CERRADA — que es su estado normal.
 *
 * El candado existe para vivir cerrado: la maestra solo firma el acta y reenvuelve los
 * sobres al abrir, y el resto del tiempo no está en memoria. Todo lo que la bóveda SIRVE
 * tiene que poder servirse así.
 *
 * Lo que se rompió, y por qué no lo cazaba nada (2026-09-01): el aviso a quien aprueba se
 * firmaba con la MAESTRA. Con la bóveda cerrada reventaba antes de mandar nada, así que el
 * proxio no tenía a quién encolar y **el teléfono no timbraba nunca**. Desde fuera era
 * indistinguible de «nadie ha aprobado todavía»: el servicio esperaba, el dueño no se
 * enteraba, y el registro decía «could not notify approvers» en una línea que nadie mira.
 *
 * Y el segundo: al aprobar, la bóveda contestaba un paquete que el aparato NO podía abrir
 * —le faltaba la envoltura de su cajón— y el agente lo tomaba por un tropiezo y volvía a
 * pedir. Así que el teléfono timbraba otra vez. El dueño, textual: «sigo aprobando y
 * aprobando».
 *
 *   node smoke/aprobaciones.mjs [--verbose]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { escenario, correr, startProxy, startVault, teardown } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FRASE = 'cuatro palabras al azar aqui'

let proxy = null
let vault = null
const estado = {}

async function esperar (fn, { timeoutMs = 25000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(200)
  }
  throw new Error('se agotó la espera de ' + que)
}

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), 'apv-' + n + '-'))

escenario('arranca el ecosistema y se guarda una variable privada', async () => {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  // La variable entra ANTES de que exista el servicio: es el caso que rompía, porque su
  // envoltura hay que hacérsela después, y eso solo se puede con la bóveda abierta.
  await vault.setSecret('demo', 'TOKEN', 'valor-secreto', false)
  estado.dirServicio = tmp('servicio')
  estado.dirAprobador = tmp('aprobador')
})

escenario('se enrolan el SERVICIO y el APROBADOR, con la bóveda abierta', async () => {
  const { enrollService, enrollWithVault } = await import('../../dotrino-vault/lib/src/service.js')

  // El servicio del cajón `demo`.
  const qr = await vault.pair({ service: 'demo' })
  // `onCode` ya aprueba en cuanto el aparato enseña su código, así que NO se espera a
  // `waitPending`: para cuando miraras, la petición ya está consumida y esperas a algo que
  // no va a volver a pasar.
  estado.servicio = await enrollService({
    qr, ns: 'demo', dir: estado.dirServicio, label: 'demo', onCode: ({ code }) => vault.approve(code)
  })
  estado.servicioPub = estado.servicio.device.publickey

  // El aparato que aprueba: un aparato tuyo, sin cajón propio.
  const qr2 = await vault.pair({ label: 'telefono' })
  estado.aprobador = await enrollWithVault({ qr: qr2, label: 'telefono', onCode: ({ code }) => vault.approve(code) })
  estado.aprobadorPub = estado.aprobador.device.publickey

  const acta = await vault.members()
  const s = (acta.members || []).find((m) => m.pub === estado.servicioPub)
  assert.equal(s?.cn, 'demo', 'el servicio entra en el acta con su cajón')
  assert.ok(!(s.caps || []).includes('unattended'),
    'y SIN llevarse las claves solo: pedir permiso es el defecto, no una marca que alguien recuerde poner')
})

escenario('el aparato que aprueba recibe el permiso `aprueba`', async () => {
  const acta = await vault.members()
  const m = (acta.members || []).find((x) => x.pub === estado.aprobadorPub)
  await vault.caps(estado.aprobadorPub, [...new Set([...(m?.caps || []), 'approve'])])
  const despues = await vault.members()
  const y = (despues.members || []).find((x) => x.pub === estado.aprobadorPub)
  assert.ok((y.caps || []).includes('approve'), 'ya puede aprobar')

  // EL PERMISO ESTÁ EN EL ACTA, PERO EL PAPEL ES DE ANTES. Un cert se emite con lo que el
  // acta decía entonces, así que conceder `aprueba` no basta: hay que pedir uno nuevo. En
  // el teléfono pasa solo (`certDesfasadoDelActa` → renovar al abrir la identidad); aquí,
  // que es un enlace headless, se hace a mano — y es parte de lo que se quiere probar.
  const { requestRenew } = await import('../../dotrino-identity/vault/remote.js')
  const nuevo = await requestRenew({
    master: vault.iss, proxy: proxy.url,
    device: estado.aprobador.device, cert: estado.aprobador.cert
  })
  assert.ok((nuevo?.cert?.scope || []).includes('vault:approve'), 'el papel nuevo ya lo lleva')
  estado.aprobador = { ...estado.aprobador, cert: nuevo.cert }
})

/**
 * LA CONDICIÓN DEL DUEÑO: si los sobres se acotan por cajón y permisos —en vez de envolver
 * para todos—, hay que estar SEGURO de que todos los necesarios se crean.
 *
 * Aquí se comprueba en el caso que fallaba: la variable estaba escrita ANTES de que el
 * servicio existiera, así que su envoltura hay que hacérsela después. Si falta, el servicio
 * recibe un paquete que no puede abrir — y eso es exactamente lo que se veía en producción.
 */
escenario('el servicio abre lo que se escribió ANTES de que él existiera', async () => {
  const { fetchSecrets } = await import('../../dotrino-vault/lib/src/service.js')
  // Todavía con la bóveda abierta y con `unattended`, para medir SOLO la envoltura.
  const acta = await vault.members()
  const m = (acta.members || []).find((x) => x.pub === estado.servicioPub)
  await vault.caps(estado.servicioPub, [...new Set([...(m?.caps || []), 'unattended'])])
  const s = await fetchSecrets({ dir: estado.dirServicio, ns: 'demo' })
  assert.equal(s.TOKEN, 'valor-secreto', 'la envoltura se le hizo al registrar su llave de cifrado')

  // Y se le vuelve a quitar: el resto de la caja prueba el camino con aprobación.
  const otra = await vault.members()
  const m2 = (otra.members || []).find((x) => x.pub === estado.servicioPub)
  await vault.caps(estado.servicioPub, (m2?.caps || []).filter((c) => c !== 'unattended'))
})

escenario('se pone contraseña y se CIERRA la bóveda', async () => {
  const r = await vault.profile('password-set', { password: FRASE })
  assert.ok(!r.error, 'la contraseña se guarda: ' + (r.error || ''))
  const l = await vault.profile('lock')
  assert.ok(!l.error, 'y se cierra: ' + (l.error || ''))
})

escenario('CERRADA: el pedido llega al que aprueba — el timbre NO necesita la maestra', async () => {
  const { fetchSecrets } = await import('../../dotrino-vault/lib/src/service.js')

  // El servicio pide. Con la bóveda cerrada y sin `unattended`, esto tiene que quedar
  // pendiente Y avisar a quien aprueba.
  let pendiente = null
  const pidiendo = fetchSecrets({
    dir: estado.dirServicio, ns: 'demo',
    onPending: (p) => { pendiente = p; log('[servicio] pendiente ' + p.id) }
  }).then((v) => ({ v }), (e) => ({ e }))

  await esperar(() => pendiente, { que: 'que la bóveda conteste «pendiente»' })

  // LO QUE SE PRUEBA: el aviso SALIÓ. Antes reventaba con «vault locked» antes de mandar
  // nada, así que aquí no había ni línea de salida ni nada encolado para el teléfono.
  const salida = vault.log()
  assert.doesNotMatch(salida, /could not notify approvers/,
    'avisar a quien aprueba NO puede necesitar la maestra: cerrada es el estado normal')
  assert.match(salida, /rang 1 approver/, 'y consta que se timbró a uno')

  estado.pendiente = pendiente
  estado.pidiendo = pidiendo
})

escenario('el que aprueba dice que sí, y el servicio abre lo que le llega', async () => {
  const { requestApproval } = await import('../../dotrino-identity/vault/remote.js')
  const { device, cert } = estado.aprobador
  const comun = { master: vault.iss, proxy: proxy.url, device, cert }

  const lista = await requestApproval({ ...comun, op: 'approvals' })
  assert.equal(lista.items.length, 1, 'el teléfono ve UN pedido')
  assert.equal(lista.items[0].ns, 'demo')

  await requestApproval({ ...comun, op: 'approve', id: lista.items[0].id })

  const r = await estado.pidiendo
  // Y aquí es donde se caía: llegaba, pero sin envoltura no se podía abrir. La envoltura la
  // hizo la bóveda al enrolarlo, con ella abierta, que es el único momento en que puede.
  assert.ok(!r.e, 'el servicio recibe y ABRE lo aprobado: ' + (r.e?.message || ''))
  assert.equal(r.v.TOKEN, 'valor-secreto', 'y es el valor que guardó el dueño')
})

escenario('un aparato SIN envoltura corta y dice qué hacer: no vuelve a hacer timbrar', async () => {
  const { isFinal } = await import('../../dotrino-vault/lib/src/service.js')
  // La regla, aparte: reintentar un cajón sin envoltura solo sirve para que el teléfono
  // timbre otra vez y el dueño apruebe otra vez. No lo arregla ninguna aprobación.
  assert.equal(isFinal({ code: 'no-wrapping', message: 'x' }), true)
  assert.equal(isFinal(new Error('the vault did not reply')), false, 'lo transitorio sí se reintenta')
})

correr().finally(async () => {
  await teardown()
  for (const d of [estado.dirServicio, estado.dirAprobador]) {
    if (d) try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {}
  }
})
