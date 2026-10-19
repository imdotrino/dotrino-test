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
 *   · `vault-a` — la bóveda que tiene la cuenta. Binario real + su CLI.
 *   · `vault-b` — la otra bóveda. Entra con `join` y recibe `+sella`.
 *   · `device`   — un teléfono cualquiera, que entra por B para demostrar que B manda.
 *
 *   node smoke/two-vaults.mjs            (Docker si lo hay; si no, cajas locales)
 *   SMOKE_BACKEND=local node smoke/two-vaults.mjs
 *   node smoke/two-vaults.mjs --verbose
 *
 * Requiere el binario:  cd dotrino-vault && bash packaging/build.sh
 *
 * ESTADO: 4 de 4 (2026-08-30). Estuvo tres tandas en 3/4, y los tres fallos que hubo que
 * arreglar para cerrarlo merecen quedar escritos, porque ninguno se veía desde fuera:
 *
 *   1. `join` metía la cuenta ajena en una cuenta interna de la capa de identidad, y el
 *      gestor de perfiles del daemon no se enteraba: no había instancia de bóveda para
 *      ella y nadie se identificaba en el proxio con esa llave. Ahora `join` crea un
 *      PERFIL DEL GESTOR, como `pair --adopt`.
 *   2. Los avisos iban solo a `listDelegations().issued` —lo que ESTA bóveda enroló—, y
 *      la segunda bóveda entró por `join`, así que la delegación la había emitido la
 *      primera. Cuando la segunda sellaba, no tenía a quién avisar. Ahora se avisa a los
 *      MIEMBROS DEL ACTA, que es la lista correcta.
 *   3. Tras `join`, la cuenta adoptada no quedaba como la activa, así que aprobar un
 *      aparato lo metía en el `Perfil 1` vacío del primer arranque —sin decir nada—.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { scenario, runScenarios, startProxy, teardown, ROOT } from './lib/harness.js'
import { pubkeyId } from '../../dotrino-identity/vault/capabilities.js'
import { createBox, destroyBoxes, pickEngine, ECO } from './lib/box.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'
import { waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const BINARY = '/eco/dotrino-vault/dist/dotrino-vaultd'
const ENV = { DOTRINO_VAULT_DIR: '/data/vault' }

let proxy = null
const vaults = {}

async function idOf (pub) {
  const h = (await pubkeyId(pub)).slice(0, 8).toUpperCase()
  return h.slice(0, 4) + '-' + h.slice(4)
}

/** Una bóveda de verdad: el binario que se instala un usuario, en su propia caja. */
async function startVaultBox (name) {
  const box = createBox(name)
  // El binario trae Node dentro pero espera `libatomic1` del sistema (lo destapó el smoke
  // de dispositivos en un Debian limpio; por eso el `.deb` la declara).
  if (box.engine === 'docker') {
    box.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1')
  }
  const output = []
  box.launch(BINARY, {
    env: { ...ENV, PROXY_URL: proxy.url },
    onLine: (l) => { output.push(l); log(`[${name}] ` + l) }
  })
  await waitFor(() => output.some((l) => l.includes('servicio listo')), { what: `${name} to start` })
    .catch(() => { throw new Error(`${name} did not start:\n` + output.join('\n')) })
  const b = {
    box,
    output,
    ctl: (cmd) => box.exec(`${BINARY} --ctl ${cmd}`, { env: ENV }),
    /** Lanza un `--ctl` que no termina (pair, join) y recoge sus líneas. */
    ctlLive (cmd) {
      const lines = []
      box.launch(`${BINARY} --ctl ${cmd}`, { env: ENV, onLine: (l) => { lines.push(l.trim()); log(`[${name} ${cmd.split(' ')[0]}] ` + l) } })
      return lines
    }
  }
  vaults[name] = b
  return b
}

/** `pair` en una bóveda: devuelve la invitación ya parseada. */
async function inviteOf (b) {
  const lines = b.ctlLive('pair')
  return waitFor(() => {
    for (const l of lines) {
      if (!l || l.length < 20) continue
      const o = parseInvite(l)
      if (o?.sn) return o
    }
    return null
  }, { what: 'the invite printed by pair' })
}

/** El código de 6 que hay que tipear al otro lado, de una salida cualquiera. */
const codeIn = (lines) => waitFor(() => {
  for (const l of lines) {
    const m = /\b(\d{6})\b/.exec(l)
    if (m) return m[1]
  }
  return null
}, { what: 'the confirmation code' })

let A = null
let B = null
let idB = null

const membersOfA = () => A.ctl('members').stdout || ''
/** Los permisos que el acta le reconoce a un miembro (su línea y la de debajo). */
const capsOf = (id, output = membersOfA()) => {
  const l = output.split('\n')
  const i = l.findIndex((x) => x.includes(id))
  return i >= 0 ? (l[i] + ' ' + (l[i + 1] || '')) : ''
}

scenario('B joins A\'s account WITH ITS OWN KEY', async () => {
  A = await startVaultBox('vault-a')
  B = await startVaultBox('vault-b')

  const invite = await inviteOf(A)
  const joinLines = B.ctlLive(`join '${JSON.stringify(invite).replace(/'/g, "'\\''")}'`)
  const code = await codeIn(joinLines)
  log('[test] code shown by B: ' + code)

  A.ctl(`approve ${code}`)
  await waitFor(() => joinLines.some((l) => /ya es miembro|acta #/.test(l)), { what: 'B to confirm it joined' })

  const record = await waitFor(() => {
    const a = membersOfA()
    return [...a.matchAll(/\b([0-9A-F]{4}-[0-9A-F]{4})\b/g)].length >= 2 ? a : null
  }, { what: 'A\'s record to list B' })
  log('[test] A\'s record after the join:\n' + record)

  const ids = [...record.matchAll(/\b([0-9A-F]{4}-[0-9A-F]{4})\b/g)].map((m) => m[1])
  idB = ids[ids.length - 1]
  assert.ok(idB, 'A\'s record must list B')
})

scenario('B is NOT born able to seal: it is a permission granted by hand', async () => {
  assert.ok(!/sella|sealer/i.test(capsOf(idB)),
    'like «administra», sealing is not paired — it is granted from the PC')
})

scenario('the owner GRANTS the seal permission, and can REVOKE it', async () => {
  A.ctl(`caps ${idB} +sella`)
  await waitFor(() => /sella|sealer/i.test(capsOf(idB)), { what: 'the record to grant it sealing' })

  A.ctl(`caps ${idB} -sella`)
  await waitFor(() => !/sella|sealer/i.test(capsOf(idB)), { what: 'the permission to be removed' })

  A.ctl(`caps ${idB} +sella`)
  await waitFor(() => /sella|sealer/i.test(capsOf(idB)), { what: 'the permission to be granted again' })
})

/**
 * EL PASO CLAVE, y el desastre que esto viene a cubrir: A no interviene en ningún momento.
 */
scenario('with the permission, B admits a device ON ITS OWN and A adopts that record', async () => {
  const phone = createBox('device')
  const inviteB = await inviteOf(B)
  const lines = []
  phone.write('/data/enroll.mjs', `
    import { enroll } from '/eco/dotrino-vault/src/client.js'
    const qr = JSON.parse(process.env.QR)
    const r = await enroll({ qr, label: 'phone', dir: '/data/dev', onChallenge: (c) => console.log('CODE:' + c.code) })
    console.log('OK:' + JSON.stringify({ pub: r.device.publickey }))
  `)
  phone.launch('node /data/enroll.mjs', {
    env: { QR: JSON.stringify(inviteB) },
    onLine: (l) => { lines.push(l.trim()); log('[device] ' + l) }
  })
  const phoneCode = await waitFor(() => {
    const l = lines.find((x) => x.startsWith('CODE:'))
    return l ? l.slice(5) : null
  }, { what: 'the phone\'s code' })

  B.ctl(`approve ${phoneCode}`)
  const ok = await waitFor(() => lines.find((l) => l.startsWith('OK:')), {
    what: 'the phone to finish enrolling through B (without A stepping in)'
  })
  const phoneId = await idOf(JSON.parse(ok.slice(3)).pub)
  log('[test] the phone joined through B: ' + phoneId)

  // Lo que cierra el círculo: no son dos cuentas paralelas, es UNA. Lo que sella B lo
  // adopta A por las reglas de siempre (§2.4.1), sin que nadie toque el PC de A.
  await waitFor(() => membersOfA().includes(phoneId), {
    timeoutMs: 45000,
    what: 'A to adopt the record sealed by B'
  })
})

// ---------- arranque ----------

const engine = pickEngine()
console.log(`\nSMOKE · two vaults on the same account (engine: ${engine})\n`)
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
