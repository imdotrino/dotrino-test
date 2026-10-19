/**
 * smoke:chip-key — EL TELÉFONO ES UN SOLO APARATO: su llave del chip tiene perfil Y aprueba.
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
 *   npm run smoke:chip-key [-- --verbose]
 */
import assert from 'node:assert/strict'
import { scenario, runScenarios, startProxy, teardown } from './lib/harness.js'
import { createBox, destroyBoxes } from './lib/box.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'
import { keyLabel } from '../../dotrino-identity/vault/keyid.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
import { waitFor } from './lib/wait.js'
const BINARY = '/eco/dotrino-vault/dist/dotrino-vaultd'
const ENV = { DOTRINO_VAULT_DIR: '/data/vault' }
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let proxy = null
let vault = null

const ctl = (args) => {
  const r = vault.exec(`${BINARY} --ctl ${args}`, { env: ENV })
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '')
  log(`[ctl ${args}] ${out.trim()}`)
  return out
}
/** Una invitación nueva de la bóveda, como la que enseña `dotrino-vault pair`. */
async function invitation (tag) {
  const lines = []
  vault.launch(`${BINARY} --ctl pair`, { env: ENV, onLine: (l) => { lines.push(l.trim()); log(`[${tag}] ` + l) } })
  return waitFor(() => { for (const l of lines) { const o = l.length > 20 && parseInvite(l); if (o?.sn) return o } return null }, { what: 'the invitation' })
}

scenario('the vault starts and a normal device sets the account profile', async () => {
  proxy = await startProxy()
  vault = createBox('vault-chip')
  if (vault.engine === 'docker') vault.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  vault.launch(BINARY, { env: { ...ENV, PROXY_URL: proxy.url }, onLine: (l) => log('[vault] ' + l) })
  await waitFor(() => /corriendo/.test(ctl('status')), { what: 'the vault to start' })
  const qr = await invitation('pair-pc')
  const pc = createBox('pc-chip')
  let pushState = null
  pc.launch(`node --input-type=module -e "$SCRIPT"`, {
    env: {
      QR: JSON.stringify(qr),
      SCRIPT: `
        import { Identity } from '/eco/dotrino-identity/src/node.js'
        const id = await Identity.connect({ dir: '/data/pc' })
        id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
        await id.enrollDevice(JSON.parse(process.env.QR), { label: 'pc', join: 'new' })
        await id.updateMe({ nickname: 'Santiago', avatar: '${PHOTO}', email: 'santi@example.com' })
        for (let i = 0; i < 60; i++) { const s = await id.profilePushState(); if (s && s.ok !== null) { console.log('PUSH:' + JSON.stringify(s)); break } await new Promise((r) => setTimeout(r, 500)) }
        setTimeout(() => process.exit(0), 300)
      `
    },
    onLine: (l) => {
      log('[pc] ' + l)
      const m = /CODE:(\d+)/.exec(l); if (m) ctl('approve ' + m[1])
      if (l.startsWith('PUSH:')) pushState = JSON.parse(l.slice(5))
    }
  })
  await waitFor(() => pushState, { timeoutMs: 60000, what: 'the PC to upload the profile' })
  assert.equal(pushState.ok, true, 'the profile reached the vault: ' + JSON.stringify(pushState))
})

const tel = {}
scenario('the phone pairs with the chip key: no private keys in IndexedDB, and the app receives the account', async () => {
  const qr = await invitation('pair-tel')
  const box = createBox('phone-chip')
  box.launch('node /eco/dotrino-test/smoke/boxes/phone-chip.mjs', {
    env: { QR: JSON.stringify(qr) },
    onLine: (l) => {
      log('[phone] ' + l)
      const m = /^(\w+):(.*)$/.exec(l.trim()); if (!m) return
      let v; try { v = JSON.parse(m[2]) } catch (_) { return }
      if (m[1] === 'CODE') ctl('approve ' + v)
      tel[m[1]] = v
    }
  })
  await waitFor(() => tel.PAIRED, { timeoutMs: 60000, what: 'the phone to pair' })
  assert.equal(tel.PRIVATE_KEYS_IN_IDB, 0, 'no private key in the WebView store')
  await waitFor(() => tel.SAVED, { what: 'the app to receive the account for Approvals' })
  assert.equal(tel.SAVED.cert, true, 'with its certificate')
  assert.equal(tel.SAVED.vault, true, 'and the vault it belongs to')
})

scenario('the phone DOWNLOADS the account profile (what used to come out empty)', async () => {
  await waitFor(() => tel.ME, { what: 'the phone to report its profile' })
  assert.equal(tel.ME.nickname, 'Santiago', JSON.stringify(tel.ME))
  assert.equal(tel.ME.avatar, true, 'the photo: ' + JSON.stringify(tel.ME))
  assert.equal(tel.ME.email, 'santi@example.com', 'a field: ' + JSON.stringify(tel.ME))
})

scenario('in the vault it is ONE device, and with +aprueba the same key approves', async () => {
  // Unirse a la cuenta crea un perfil NUEVO en el teléfono, con su propia llave del chip.
  const id = tel.PAIRED.deviceId
  assert.equal(await keyLabel(tel.PAIRED.pub), id, 'the vault device IS the chip key')
  const members = ctl('members')
  assert.equal(members.split('\n').filter((l) => l.includes(id)).length, 1, `the phone (${id}) is a single member:\n` + members)
  ctl(`caps ${id} +aprueba`)
  await waitFor(() => tel.APPROVES, { timeoutMs: 60000, what: 'the phone to be able to list the requests' })
  assert.ok(Number.isInteger(tel.APPROVES.items))
})

const ok = await runScenarios()
destroyBoxes()
await teardown()
process.exit(ok ? 0 : 1)
