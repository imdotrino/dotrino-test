/**
 * smoke:new-profile — UN PERFIL NUEVO, UN APARATO, Y LA BÓVEDA TIENE QUE VER EL PERFIL.
 *
 * El caso del dueño (2026-09-24): creó el perfil «Crifa» en su bóveda, emparejó un aparato,
 * puso nombre y foto… y la bóveda no enseñaba nada. Se reproduce entero y con piezas reales:
 * la bóveda es el BINARIO en su caja, el perfil se crea con su CLI (`profile add` + `profile
 * use`), el aparato es la identidad del ecosistema (la misma que corre en el navegador) en
 * otra caja, y lo que se mira es lo que el dueño mira: `dotrino-vault me`.
 *
 *   npm run smoke:new-profile [-- --verbose]
 */
import assert from 'node:assert/strict'
import { scenario, runScenarios, startProxy, teardown } from './lib/harness.js'
import { createBox, destroyBoxes } from './lib/box.js'
import { waitFor } from './lib/wait.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const BINARY = '/eco/dotrino-vault/dist/dotrino-vaultd'
const ENV = { DOTRINO_VAULT_DIR: '/data/vault' }

let proxy = null
let vaultBox = null
let device = null
const vaultOutput = []

const ctl = (args) => {
  const r = vaultBox.exec(`${BINARY} --ctl ${args}`, { env: ENV })
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '')
  log(`[ctl ${args}] ${out.trim()}`)
  return out
}

// Una foto de verdad, pequeña: el perfil guarda la foto como data URI.
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

scenario('the vault starts as a binary', async () => {
  proxy = await startProxy()
  vaultBox = createBox('vault-profile')
  if (vaultBox.engine === 'docker') vaultBox.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  vaultBox.launch(BINARY, { env: { ...ENV, PROXY_URL: proxy.url }, onLine: (l) => { vaultOutput.push(l); log('[vault] ' + l) } })
  await waitFor(() => /corriendo/.test(ctl('status')), { what: 'the vault to start' })
})

scenario('the «Crifa» profile is created and becomes the active one, as the owner did', async () => {
  ctl('profile add Crifa')
  ctl('profile use Crifa')
  await waitFor(() => /\*\s+Crifa/.test(ctl('status')), { what: 'Crifa to be the active profile' })
})

scenario('a device (the browser identity) pairs with Crifa', async () => {
  const lines = []
  vaultBox.launch(`${BINARY} --ctl pair`, { env: ENV, onLine: (l) => { lines.push(l.trim()); log('[pair] ' + l) } })
  const qr = await waitFor(() => { for (const l of lines) { const o = l.length > 20 && parseInvite(l); if (o?.sn) return o } return null }, { what: 'the invitation' })
  device = createBox('device-profile')
  let code = null
  device.launch(`node --input-type=module -e "$SCRIPT"`, {
    env: {
      QR: JSON.stringify(qr),
      SCRIPT: `
        import { Identity } from '/eco/dotrino-identity/src/node.js'
        const id = await Identity.connect({ dir: '/data/identidad' })
        id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
        await id.enrollDevice(JSON.parse(process.env.QR), { label: 'navegador', join: 'new' })
        console.log('ENROLLED')
        await id.updateMe({ nickname: 'Crifa', avatar: '${PHOTO}', email: 'crifa@example.com', telefono: '0999999999' })
        for (let i = 0; i < 60; i++) {
          const s = await id.profilePushState()
          if (s && s.ok !== null) { console.log('PUSH:' + JSON.stringify(s)); break }
          await new Promise((r) => setTimeout(r, 500))
        }
        console.log('ME:' + JSON.stringify(await id.getMe()))
        setTimeout(() => process.exit(0), 500)
      `
    },
    onLine: (l) => {
      log('[device] ' + l)
      const m = /CODE:(\d+)/.exec(l); if (m && !code) { code = m[1]; ctl('approve ' + code) }
      if (l.startsWith('PUSH:')) device.pushState = JSON.parse(l.slice(5))
    }
  })
  await waitFor(() => device.pushState, { timeoutMs: 60000, what: 'the device to push the profile' })
  assert.equal(device.pushState.ok, true, 'the device says its profile reached the vault: ' + JSON.stringify(device.pushState))
})

scenario('the vault SHOWS the profile the device sent it (dotrino-vault me)', async () => {
  const out = ctl('me')
  assert.match(out, /nombre\s*:\s*Crifa/, 'the name the device set:\n' + out)
  assert.match(out, /foto\s*:\s*sí/, 'the photo the device uploaded:\n' + out)
  assert.match(out, /correo\s*:\s*crifa@example\.com/, 'a standard public field:\n' + out)
  // El teléfono nace OCULTO: viaja sellado y la bóveda no lo abre. Se dice que está, no qué es.
  assert.match(out, /privados\s*:\s*telefono/, 'a private field arrives (sealed) and is named:\n' + out)
  assert.doesNotMatch(out, /0999999999/, 'and its value is not shown:\n' + out)
})

scenario('a SECOND device joining the account DOWNLOADS the profile (name, photo and fields)', async () => {
  // El caso del teléfono del dueño (2026-09-25): emparejó la app con la bóveda abierta y el
  // perfil salió vacío, sin foto ni datos, aunque la bóveda los tenía.
  const lines = []
  vaultBox.launch(`${BINARY} --ctl pair`, { env: ENV, onLine: (l) => { lines.push(l.trim()); log('[pair2] ' + l) } })
  const qr = await waitFor(() => { for (const l of lines) { const o = l.length > 20 && parseInvite(l); if (o?.sn) return o } return null }, { what: 'the invitation' })
  const other = createBox('device2-profile')
  let code = null
  let seen = null
  other.launch(`node --input-type=module -e "$SCRIPT"`, {
    env: {
      QR: JSON.stringify(qr),
      SCRIPT: `
        import { Identity } from '/eco/dotrino-identity/src/node.js'
        const id = await Identity.connect({ dir: '/data/identidad2' })
        id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
        const r = await id.enrollDevice(JSON.parse(process.env.QR), { label: 'telefono', join: 'new' })
        console.log('ENROLLED:' + JSON.stringify(r?.join || null))
        let me = null
        for (let i = 0; i < 40; i++) {
          me = await id.getMe()
          if (me?.nickname === 'Crifa' && me?.avatar) break
          await new Promise((r) => setTimeout(r, 500))
        }
        console.log('ME2:' + JSON.stringify({ nickname: me?.nickname, avatar: !!me?.avatar, email: me?.email ?? me?.fields?.email ?? null, telefono: me?.telefono ?? me?.fields?.telefono ?? null }))
        setTimeout(() => process.exit(0), 500)
      `
    },
    onLine: (l) => {
      log('[device2] ' + l)
      const m = /CODE:(\d+)/.exec(l); if (m && !code) { code = m[1]; ctl('approve ' + code) }
      if (l.startsWith('ME2:')) seen = JSON.parse(l.slice(4))
    }
  })
  await waitFor(() => seen, { timeoutMs: 60000, what: 'the second device to report its profile' })
  assert.equal(seen.nickname, 'Crifa', 'the name: ' + JSON.stringify(seen))
  assert.equal(seen.avatar, true, 'the photo: ' + JSON.stringify(seen))
  assert.equal(seen.email, 'crifa@example.com', 'a public field: ' + JSON.stringify(seen))
})

scenario('with the profile LOCKED it still shows the public part, and does not list the private field names', async () => {
  // Es como estaba el de Crifa en la máquina del dueño: 🔒 tras 5 min sin usarse.
  // Un perfil SIN contraseña no se cierra de verdad (no hay con qué): se le pone una, como el
  // de Crifa en la máquina del dueño, que salía 🔒. La pide por TERMINAL (actual vacía, nueva y
  // repetida, tecleadas con pausas porque lee en modo crudo): `script` le da una.
  const pw = vaultBox.exec(`(sleep 1; printf '\\r'; sleep 1; printf 'clave-de-prueba\\r'; sleep 1; printf 'clave-de-prueba\\r'; sleep 3) | timeout 20 script -q -c "${BINARY} --ctl profile password set" /dev/null`, { env: ENV })
  log('[password] ' + (pw.stdout || '') + (pw.stderr || ''))
  assert.match(ctl('lock'), /bloqueado/, 'the lock is set')
  const out = ctl('me')
  assert.match(out, /nombre\s*:\s*Crifa/, 'the public part is visible with the profile locked:\n' + out)
  assert.match(out, /solo lo público/, 'and it says it is locked:\n' + out)
  assert.doesNotMatch(out, /privados\s*:/, 'no private field names while locked:\n' + out)
})

const ok = await runScenarios()
if (!ok) {
  console.log('\n--- vault log (Crifa) ---')
  for (const l of vaultOutput.filter((l) => /Crifa|profile|record|recovery/i.test(l)).slice(-25)) console.log('  ' + l)
}
destroyBoxes()
await teardown()
process.exit(ok ? 0 : 1)
