/**
 * smoke:llave-del-chip — EL TELÉFONO ES UN SOLO APARATO: su llave del chip tiene perfil Y aprueba.
 *
 * El caso del dueño (2026-09-25): en la app de Android la pestaña Perfil salía vacía, porque
 * la llave nativa (la que aprueba) y la identidad del WebView eran dos llaves distintas, y
 * solo la nativa estaba en la cuenta. Desde identity 0.103.0 el WebView firma y descifra con
 * la llave del chip. Aquí:
 *
 *   1. un aparato normal (el navegador del PC) pone nombre, foto y correo en la cuenta;
 *   2. el «teléfono» —núcleo del iframe con las llaves en un chip simulado, `cajas/telefono-
 *      chip.mjs`— se empareja: no guarda ninguna privada, BAJA ese perfil y le pasa la cuenta
 *      a la app (`save`, lo que usa la pantalla nativa de Pedidos);
 *   3. en la bóveda es UN aparato nuevo, y con `+aprueba` esa misma llave aprueba.
 *
 *   npm run smoke:llave-del-chip [-- --verbose]
 */
import assert from 'node:assert/strict'
import { escenario, correr, startProxy, teardown } from './lib/harness.js'
import { crearCaja, destruirCajas } from './lib/caja.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'
import { keyLabel } from '../../dotrino-identity/vault/keyid.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BINARIO = '/eco/dotrino-vault/dist/dotrino-vaultd'
const ENV = { DOTRINO_VAULT_DIR: '/data/vault' }
const FOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let proxy = null
let boveda = null

async function esperar (fn, { timeoutMs = 30000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) { const v = await fn(); if (v) return v; await sleep(250) }
  throw new Error('se agotó la espera de ' + que)
}
const ctl = (args) => {
  const r = boveda.exec(`${BINARIO} --ctl ${args}`, { env: ENV })
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '')
  log(`[ctl ${args}] ${out.trim()}`)
  return out
}
/** Una invitación nueva de la bóveda, como la que enseña `dotrino-vault pair`. */
async function invitacion (tag) {
  const lineas = []
  boveda.lanzar(`${BINARIO} --ctl pair`, { env: ENV, onLinea: (l) => { lineas.push(l.trim()); log(`[${tag}] ` + l) } })
  return esperar(() => { for (const l of lineas) { const o = l.length > 20 && parseInvite(l); if (o?.sn) return o } return null }, { que: 'la invitación' })
}

escenario('la bóveda arranca y un aparato normal pone el perfil de la cuenta', async () => {
  proxy = await startProxy()
  boveda = crearCaja('boveda-chip')
  if (boveda.motor === 'docker') boveda.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  boveda.lanzar(BINARIO, { env: { ...ENV, PROXY_URL: proxy.url }, onLinea: (l) => log('[bóveda] ' + l) })
  await esperar(() => /corriendo/.test(ctl('status')), { que: 'que la bóveda arranque' })
  const qr = await invitacion('pair-pc')
  const pc = crearCaja('pc-chip')
  let empuje = null
  pc.lanzar(`node --input-type=module -e "$GUION"`, {
    env: {
      QR: JSON.stringify(qr),
      GUION: `
        import { Identity } from '/eco/dotrino-identity/src/node.js'
        const id = await Identity.connect({ dir: '/data/pc' })
        id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
        await id.enrollDevice(JSON.parse(process.env.QR), { label: 'pc', join: 'new' })
        await id.updateMe({ nickname: 'Santiago', avatar: '${FOTO}', email: 'santi@example.com' })
        for (let i = 0; i < 60; i++) { const s = await id.profilePushState(); if (s && s.ok !== null) { console.log('EMPUJE:' + JSON.stringify(s)); break } await new Promise((r) => setTimeout(r, 500)) }
        setTimeout(() => process.exit(0), 300)
      `
    },
    onLinea: (l) => {
      log('[pc] ' + l)
      const m = /CODE:(\d+)/.exec(l); if (m) ctl('approve ' + m[1])
      if (l.startsWith('EMPUJE:')) empuje = JSON.parse(l.slice(7))
    }
  })
  await esperar(() => empuje, { timeoutMs: 60000, que: 'que el PC suba el perfil' })
  assert.equal(empuje.ok, true, 'el perfil llegó a la bóveda: ' + JSON.stringify(empuje))
})

const tel = {}
escenario('el teléfono se empareja con la llave del chip: sin privadas en IndexedDB, y la app recibe la cuenta', async () => {
  const qr = await invitacion('pair-tel')
  const caja = crearCaja('telefono-chip')
  caja.lanzar('node /eco/dotrino-test/smoke/cajas/telefono-chip.mjs', {
    env: { QR: JSON.stringify(qr) },
    onLinea: (l) => {
      log('[teléfono] ' + l)
      const m = /^(\w+):(.*)$/.exec(l.trim()); if (!m) return
      let v; try { v = JSON.parse(m[2]) } catch (_) { return }
      if (m[1] === 'CODE') ctl('approve ' + v)
      tel[m[1]] = v
    }
  })
  await esperar(() => tel.EMPAREJADO, { timeoutMs: 60000, que: 'que el teléfono se empareje' })
  assert.equal(tel.PRIVADAS_EN_IDB, 0, 'ninguna llave privada en el almacén del WebView')
  await esperar(() => tel.GUARDADA, { que: 'que la app reciba la cuenta para Pedidos' })
  assert.equal(tel.GUARDADA.cert, true, 'con su papel')
  assert.equal(tel.GUARDADA.vault, true, 'y la bóveda a la que pertenece')
})

escenario('el teléfono BAJA el perfil de la cuenta (lo que salía vacío)', async () => {
  await esperar(() => tel.ME, { timeoutMs: 30000, que: 'que el teléfono diga qué perfil tiene' })
  assert.equal(tel.ME.nickname, 'Santiago', JSON.stringify(tel.ME))
  assert.equal(tel.ME.avatar, true, 'la foto: ' + JSON.stringify(tel.ME))
  assert.equal(tel.ME.email, 'santi@example.com', 'un dato: ' + JSON.stringify(tel.ME))
})

escenario('en la bóveda es UN aparato, y con +aprueba la misma llave aprueba', async () => {
  // Unirse a la cuenta crea un perfil NUEVO en el teléfono, con su propia llave del chip.
  const id = tel.EMPAREJADO.deviceId
  assert.equal(await keyLabel(tel.EMPAREJADO.pub), id, 'el aparato de la bóveda ES la llave del chip')
  const members = ctl('members')
  assert.equal(members.split('\n').filter((l) => l.includes(id)).length, 1, `el teléfono (${id}) es un solo miembro:\n` + members)
  ctl(`caps ${id} +aprueba`)
  await esperar(() => tel.APRUEBA, { timeoutMs: 60000, que: 'que el teléfono pueda listar los pedidos' })
  assert.ok(Number.isInteger(tel.APRUEBA.items))
})

const ok = await correr()
destruirCajas()
await teardown()
process.exit(ok ? 0 : 1)
