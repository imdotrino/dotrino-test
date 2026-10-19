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
 *   npm run smoke:approvals  (o: node smoke/approvals.mjs [--verbose])
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scenario, runScenarios, startProxy, startVault, teardown } from './lib/harness.js'
import { waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const PASSPHRASE = 'cuatro palabras al azar aqui'

let proxy = null
let vault = null
const state = {}

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), 'apv-' + n + '-'))

scenario('the ecosystem starts and a private variable is stored', async () => {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  // La variable entra ANTES de que exista el servicio: es el caso que rompía, porque su
  // envoltura hay que hacérsela después, y eso solo se puede con la bóveda abierta.
  await vault.setSecret('demo', 'TOKEN', 'valor-secreto', false)
  state.serviceDir = tmp('service')
  state.approverDir = tmp('approver')
})

scenario('the SERVICE and the APPROVER enroll, with the vault open', async () => {
  const { enrollService, enrollWithVault } = await import('../../dotrino-vault/lib/src/service.js')

  // El servicio del cajón `demo`.
  const qr = await vault.pair({ service: 'demo' })
  // `onCode` ya aprueba en cuanto el aparato enseña su código, así que NO se espera a
  // `waitPending`: para cuando miraras, la petición ya está consumida y esperas a algo que
  // no va a volver a pasar.
  state.service = await enrollService({
    qr, ns: 'demo', dir: state.serviceDir, label: 'demo', onCode: ({ code }) => vault.approve(code)
  })
  state.servicePub = state.service.device.publickey

  // El aparato que aprueba: un aparato tuyo, sin cajón propio.
  const qr2 = await vault.pair({ label: 'telefono' })
  state.approver = await enrollWithVault({ qr: qr2, label: 'telefono', onCode: ({ code }) => vault.approve(code) })
  state.approverPub = state.approver.device.publickey

  const acta = await vault.members()
  const s = (acta.members || []).find((m) => m.pub === state.servicePub)
  assert.equal(s?.cn, 'demo', 'the service enters the record with its drawer')
  assert.ok(!(s.caps || []).includes('unattended'),
    'and WITHOUT taking the keys on its own: asking is the default, not a flag someone has to remember')
})

scenario('the approving device gets the `approve` permission', async () => {
  const acta = await vault.members()
  const m = (acta.members || []).find((x) => x.pub === state.approverPub)
  await vault.caps(state.approverPub, [...new Set([...(m?.caps || []), 'approve'])])
  const after = await vault.members()
  const y = (after.members || []).find((x) => x.pub === state.approverPub)
  assert.ok((y.caps || []).includes('approve'), 'it can approve now')

  // EL PERMISO ESTÁ EN EL ACTA, PERO EL PAPEL ES DE ANTES. Un cert se emite con lo que el
  // acta decía entonces, así que conceder `aprueba` no basta: hay que pedir uno nuevo. En
  // el teléfono pasa solo (`certDesfasadoDelActa` → renovar al abrir la identidad); aquí,
  // que es un enlace headless, se hace a mano — y es parte de lo que se quiere probar.
  const { requestRenew } = await import('../../dotrino-identity/vault/remote.js')
  const renewed = await requestRenew({
    master: vault.iss, proxy: proxy.url,
    device: state.approver.device, cert: state.approver.cert
  })
  assert.ok((renewed?.cert?.scope || []).includes('vault:approve'), 'the new certificate carries it')
  state.approver = { ...state.approver, cert: renewed.cert }
})

/**
 * LA CONDICIÓN DEL DUEÑO: si los sobres se acotan por cajón y permisos —en vez de envolver
 * para todos—, hay que estar SEGURO de que todos los necesarios se crean.
 *
 * Aquí se comprueba en el caso que fallaba: la variable estaba escrita ANTES de que el
 * servicio existiera, así que su envoltura hay que hacérsela después. Si falta, el servicio
 * recibe un paquete que no puede abrir — y eso es exactamente lo que se veía en producción.
 */
scenario('the service opens what was written BEFORE it existed', async () => {
  const { fetchSecrets } = await import('../../dotrino-vault/lib/src/service.js')
  // Todavía con la bóveda abierta y con `unattended`, para medir SOLO la envoltura.
  const acta = await vault.members()
  const m = (acta.members || []).find((x) => x.pub === state.servicePub)
  await vault.caps(state.servicePub, [...new Set([...(m?.caps || []), 'unattended'])])
  const s = await fetchSecrets({ dir: state.serviceDir, ns: 'demo' })
  assert.equal(s.TOKEN, 'valor-secreto', 'the wrapping was made when its encryption key was registered')

  // Y se le vuelve a quitar: el resto de la caja prueba el camino con aprobación.
  const again = await vault.members()
  const m2 = (again.members || []).find((x) => x.pub === state.servicePub)
  await vault.caps(state.servicePub, (m2?.caps || []).filter((c) => c !== 'unattended'))
})

scenario('a password is set and the vault is LOCKED', async () => {
  const r = await vault.profile('password-set', { password: PASSPHRASE })
  assert.ok(!r.error, 'the password is stored: ' + (r.error || ''))
  const l = await vault.profile('lock')
  assert.ok(!l.error, 'and it locks: ' + (l.error || ''))
})

scenario('LOCKED: the request reaches the approver — the doorbell does NOT need the master key', async () => {
  const { fetchSecrets } = await import('../../dotrino-vault/lib/src/service.js')

  // El servicio pide. Con la bóveda cerrada y sin `unattended`, esto tiene que quedar
  // pendiente Y avisar a quien aprueba.
  let pending = null
  const asking = fetchSecrets({
    dir: state.serviceDir, ns: 'demo',
    onPending: (p) => { pending = p; log('[service] pending ' + p.id) }
  }).then((v) => ({ v }), (e) => ({ e }))

  await waitFor(() => pending, { timeoutMs: 25000, what: 'the vault to answer «pending»' })

  // LO QUE SE PRUEBA: el aviso SALIÓ. Antes reventaba con «vault locked» antes de mandar
  // nada, así que aquí no había ni línea de salida ni nada encolado para el teléfono.
  const output = vault.log()
  assert.doesNotMatch(output, /could not notify approvers/,
    'notifying the approver must NOT need the master key: locked is the normal state')
  assert.match(output, /rang 1 approver/, 'and it is logged that one approver was rung')

  state.pending = pending
  state.asking = asking
})

scenario('the approver says yes, and the service opens what it receives', async () => {
  const { requestApproval } = await import('../../dotrino-identity/vault/remote.js')
  const { device, cert } = state.approver
  const common = { master: vault.iss, proxy: proxy.url, device, cert }

  const list = await requestApproval({ ...common, op: 'approvals' })
  assert.equal(list.items.length, 1, 'the phone sees ONE request')
  assert.equal(list.items[0].ns, 'demo')

  await requestApproval({ ...common, op: 'approve', id: list.items[0].id })

  const r = await state.asking
  // Y aquí es donde se caía: llegaba, pero sin envoltura no se podía abrir. La envoltura la
  // hizo la bóveda al enrolarlo, con ella abierta, que es el único momento en que puede.
  assert.ok(!r.e, 'the service receives and OPENS what was approved: ' + (r.e?.message || ''))
  assert.equal(r.v.TOKEN, 'valor-secreto', 'and it is the value the owner stored')
})

scenario('a device WITHOUT a wrapping stops and says what to do: it does not ring again', async () => {
  const { isFinal } = await import('../../dotrino-vault/lib/src/service.js')
  // La regla, aparte: reintentar un cajón sin envoltura solo sirve para que el teléfono
  // timbre otra vez y el dueño apruebe otra vez. No lo arregla ninguna aprobación.
  assert.equal(isFinal({ code: 'no-wrapping', message: 'x' }), true)
  assert.equal(isFinal(new Error('the vault did not reply')), false, 'transient errors are retried')
})

runScenarios().finally(async () => {
  await teardown()
  for (const d of [state.serviceDir, state.approverDir]) {
    if (d) try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {}
  }
})
