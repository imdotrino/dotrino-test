/**
 * smoke:perfil-nuevo — UN PERFIL NUEVO, UN APARATO, Y LA BÓVEDA TIENE QUE VER EL PERFIL.
 *
 * El caso del dueño (2026-09-24): creó el perfil «Crifa» en su bóveda, emparejó un aparato,
 * puso nombre y foto… y la bóveda no enseñaba nada. Se reproduce entero y con piezas reales:
 * la bóveda es el BINARIO en su caja, el perfil se crea con su CLI (`profile add` + `profile
 * use`), el aparato es la identidad del ecosistema (la misma que corre en el navegador) en
 * otra caja, y lo que se mira es lo que el dueño mira: `dotrino-vault me`.
 *
 *   npm run smoke:perfil-nuevo [-- --verbose]
 */
import assert from 'node:assert/strict'
import { escenario, correr, startProxy, teardown } from './lib/harness.js'
import { crearCaja, destruirCajas } from './lib/caja.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BINARIO = '/eco/dotrino-vault/dist/dotrino-vaultd'
const ENV = { DOTRINO_VAULT_DIR: '/data/vault' }

let proxy = null
let boveda = null
let aparato = null
const salidaBoveda = []

async function esperar (fn, { timeoutMs = 25000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) { const v = await fn(); if (v) return v; await sleep(200) }
  throw new Error('se agotó la espera de ' + que)
}

const ctl = (args) => {
  const r = boveda.exec(`${BINARIO} --ctl ${args}`, { env: ENV })
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '')
  log(`[ctl ${args}] ${out.trim()}`)
  return out
}

// Una foto de verdad, pequeña: el perfil guarda la foto como data URI.
const FOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

escenario('la bóveda arranca como binario', async () => {
  proxy = await startProxy()
  boveda = crearCaja('boveda-perfil')
  if (boveda.motor === 'docker') boveda.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  boveda.lanzar(BINARIO, { env: { ...ENV, PROXY_URL: proxy.url }, onLinea: (l) => { salidaBoveda.push(l); log('[bóveda] ' + l) } })
  await esperar(() => /corriendo/.test(ctl('status')), { que: 'que la bóveda arranque' })
})

escenario('se crea el perfil «Crifa» y queda como el activo, como hizo el dueño', async () => {
  ctl('profile add Crifa')
  ctl('profile use Crifa')
  await esperar(() => /\*\s+Crifa/.test(ctl('status')), { que: 'que Crifa sea el perfil activo' })
})

escenario('se empareja un aparato (la identidad del navegador) con Crifa', async () => {
  const lineas = []
  boveda.lanzar(`${BINARIO} --ctl pair`, { env: ENV, onLinea: (l) => { lineas.push(l.trim()); log('[pair] ' + l) } })
  const qr = await esperar(() => { for (const l of lineas) { const o = l.length > 20 && parseInvite(l); if (o?.sn) return o } return null }, { que: 'la invitación' })
  aparato = crearCaja('aparato-perfil')
  let codigo = null
  aparato.lanzar(`node --input-type=module -e "$GUION"`, {
    env: {
      QR: JSON.stringify(qr),
      GUION: `
        import { Identity } from '/eco/dotrino-identity/src/node.js'
        const id = await Identity.connect({ dir: '/data/identidad' })
        id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
        await id.enrollDevice(JSON.parse(process.env.QR), { label: 'navegador', join: 'new' })
        console.log('ENROLADO')
        await id.updateMe({ nickname: 'Crifa', avatar: '${FOTO}', email: 'crifa@example.com', telefono: '0999999999' })
        for (let i = 0; i < 60; i++) {
          const s = await id.profilePushState()
          if (s && s.ok !== null) { console.log('EMPUJE:' + JSON.stringify(s)); break }
          await new Promise((r) => setTimeout(r, 500))
        }
        console.log('ME:' + JSON.stringify(await id.getMe()))
        setTimeout(() => process.exit(0), 500)
      `
    },
    onLinea: (l) => {
      log('[aparato] ' + l)
      const m = /CODE:(\d+)/.exec(l); if (m && !codigo) { codigo = m[1]; ctl('approve ' + codigo) }
      if (l.startsWith('EMPUJE:')) aparato.empuje = JSON.parse(l.slice(7))
    }
  })
  await esperar(() => aparato.empuje, { timeoutMs: 60000, que: 'que el aparato empuje el perfil' })
  assert.equal(aparato.empuje.ok, true, 'el aparato dice que su perfil llegó a la bóveda: ' + JSON.stringify(aparato.empuje))
})

escenario('la bóveda ENSEÑA el perfil que le mandó el aparato (dotrino-vault me)', async () => {
  const out = ctl('me')
  assert.match(out, /nombre\s*:\s*Crifa/, 'el nombre que puso el aparato:\n' + out)
  assert.match(out, /foto\s*:\s*sí/, 'la foto que subió el aparato:\n' + out)
  assert.match(out, /correo\s*:\s*crifa@example\.com/, 'un dato público estándar:\n' + out)
  // El teléfono nace OCULTO: viaja sellado y la bóveda no lo abre. Se dice que está, no qué es.
  assert.match(out, /privados\s*:\s*telefono/, 'un dato privado llega (sellado) y se nombra:\n' + out)
  assert.doesNotMatch(out, /0999999999/, 'y su valor no se enseña:\n' + out)
})

escenario('un SEGUNDO aparato que entra a la cuenta BAJA el perfil (nombre, foto y datos)', async () => {
  // El caso del teléfono del dueño (2026-09-25): emparejó la app con la bóveda abierta y el
  // perfil salió vacío, sin foto ni datos, aunque la bóveda los tenía.
  const lineas = []
  boveda.lanzar(`${BINARIO} --ctl pair`, { env: ENV, onLinea: (l) => { lineas.push(l.trim()); log('[pair2] ' + l) } })
  const qr = await esperar(() => { for (const l of lineas) { const o = l.length > 20 && parseInvite(l); if (o?.sn) return o } return null }, { que: 'la invitación' })
  const otro = crearCaja('aparato2-perfil')
  let codigo = null
  let visto = null
  otro.lanzar(`node --input-type=module -e "$GUION"`, {
    env: {
      QR: JSON.stringify(qr),
      GUION: `
        import { Identity } from '/eco/dotrino-identity/src/node.js'
        const id = await Identity.connect({ dir: '/data/identidad2' })
        id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
        const r = await id.enrollDevice(JSON.parse(process.env.QR), { label: 'telefono', join: 'new' })
        console.log('ENROLADO:' + JSON.stringify(r?.join || null))
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
    onLinea: (l) => {
      log('[aparato2] ' + l)
      const m = /CODE:(\d+)/.exec(l); if (m && !codigo) { codigo = m[1]; ctl('approve ' + codigo) }
      if (l.startsWith('ME2:')) visto = JSON.parse(l.slice(4))
    }
  })
  await esperar(() => visto, { timeoutMs: 60000, que: 'que el segundo aparato diga qué perfil tiene' })
  assert.equal(visto.nickname, 'Crifa', 'el nombre: ' + JSON.stringify(visto))
  assert.equal(visto.avatar, true, 'la foto: ' + JSON.stringify(visto))
  assert.equal(visto.email, 'crifa@example.com', 'un dato público: ' + JSON.stringify(visto))
})

escenario('con el perfil CERRADO enseña lo público igual, y no lista los nombres de lo privado', async () => {
  // Es como estaba el de Crifa en la máquina del dueño: 🔒 tras 5 min sin usarse.
  // Un perfil SIN contraseña no se cierra de verdad (no hay con qué): se le pone una, como el
  // de Crifa en la máquina del dueño, que salía 🔒. La pide por TERMINAL (actual vacía, nueva y
  // repetida, tecleadas con pausas porque lee en modo crudo): `script` le da una.
  const pw = boveda.exec(`(sleep 1; printf '\\r'; sleep 1; printf 'clave-de-prueba\\r'; sleep 1; printf 'clave-de-prueba\\r'; sleep 3) | timeout 20 script -q -c "${BINARIO} --ctl profile password set" /dev/null`, { env: ENV })
  log('[password] ' + (pw.stdout || '') + (pw.stderr || ''))
  assert.match(ctl('lock'), /bloqueado/, 'el candado se pone')
  const out = ctl('me')
  assert.match(out, /nombre\s*:\s*Crifa/, 'lo público se ve con el perfil cerrado:\n' + out)
  assert.match(out, /solo lo público/, 'y se dice que está cerrado:\n' + out)
  assert.doesNotMatch(out, /privados\s*:/, 'sin nombres de datos privados con el candado puesto:\n' + out)
})

const ok = await correr()
if (!ok) {
  console.log('\n--- log de la bóveda (Crifa) ---')
  for (const l of salidaBoveda.filter((l) => /Crifa|profile|record|recovery/i.test(l)).slice(-25)) console.log('  ' + l)
}
destruirCajas()
await teardown()
process.exit(ok ? 0 : 1)
