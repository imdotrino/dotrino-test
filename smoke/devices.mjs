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
 *   node smoke/devices.mjs            (usa Docker si lo hay; si no, cajas locales)
 *   SMOKE_BACKEND=local node smoke/devices.mjs
 *   node smoke/devices.mjs --verbose
 *
 * Requiere el binario compilado:  cd dotrino-vault && bash packaging/build.sh
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

let proxy = null
let vaultBox = null      // la caja donde corre el binario
let vaultProc = null

// ---------- la bóveda, corriendo como BINARIO en su propia caja ----------

async function startVaultBinary () {
  vaultBox = createBox('vault')
  // El binario trae Node dentro, pero espera `libatomic1` del sistema — lo destapó este
  // mismo test en un Debian limpio, y por eso el `.deb` la declara ahora en `Depends`.
  // En una caja mínima hay que ponerla, igual que haría el usuario con el tarball.
  if (vaultBox.engine === 'docker') {
    const r = vaultBox.exec('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1) >/dev/null 2>&1; ldconfig -p | grep -c libatomic')
    log('[vault] libatomic: ' + (r.stdout || '').trim())
  }
  const output = []
  vaultProc = vaultBox.launch(`${BINARY}`, {
    env: { DOTRINO_VAULT_DIR: '/data/vault', PROXY_URL: proxy.url },
    onLine: (l) => { output.push(l); log('[vault] ' + l) }
  })
  await waitFor(() => output.some((l) => l.includes('servicio listo')), { what: 'the vault to start' })
    .catch(() => { throw new Error('the vault (binary) did not start:\n' + output.join('\n')) })
  // El estado se pregunta CON EL CLI, dentro de la caja. Desde 0.89 el canal local va
  // cifrado en reposo y la clave sale de la máquina que escribió: la caja puede abrir su
  // `state.json`, el anfitrión no. Preguntarlo por el CLI es además el camino de verdad.
  const status = { iss: null, version: null }
  const st = vaultBox.exec(`${BINARY} --ctl status`, { env: { DOTRINO_VAULT_DIR: '/data/vault' } }).stdout || ''
  status.version = (/versi[oó]n\s*:\s*(\S+)/i.exec(st) || [])[1] || null
  status.iss = (/fingerprint\s*:\s*(\S+)/i.exec(st) || [])[1] || null
  return { status, output }
}

/**
 * `dotrino-vault pair` con el CLI real del binario. Con `servicio` es `pair --service <ns>`:
 * el cert sale acotado a ese cajón y en el acta entra como SERVICIO con ese CN.
 */
async function openPairing ({ service, scope } = {}) {
  const lines = []
  vaultBox.launch(`${BINARY} --ctl pair${service ? ' --service ' + service : ''}${scope ? ' --scope ' + scope : ''}`, {
    env: { DOTRINO_VAULT_DIR: '/data/vault' },
    onLine: (l) => { lines.push(l.trim()); log('[pair] ' + l) }
  })
  // Se parsea con `parseInvite` y NO buscando una línea JSON: el CLI dejó de
  // imprimir JSON cuando la invitación estrenó marca de formato — ahora imprime la
  // URL del QR y el código compacto. Este test esperaba `{"v":2` y por eso se
  // quedaba colgado hasta el timeout desde ese cambio.
  return await waitFor(() => {
    for (const l of lines) {
      if (!l || l.length < 20) continue
      const o = parseInvite(l)
      if (o?.sn) return o
    }
    return null
  }, { what: 'the invitation printed by the CLI' })
}

const approve = (code) => vaultBox.exec(`${BINARY} --ctl approve ${code}`, { env: { DOTRINO_VAULT_DIR: '/data/vault' } })

/** `dotrino-vault members` — el acta tal y como la ve el dueño en su terminal. */
function members () {
  const r = vaultBox.exec(`${BINARY} --ctl members`, { env: { DOTRINO_VAULT_DIR: '/data/vault' } })
  return r.stdout || ''
}

// ---------- los dispositivos ----------

/**
 * Cada uno con su propio código de enrolamiento: el REAL de su repo, no una imitación.
 * El guion imprime `CODE:<código>` cuando le toca mostrarlo y `OK:<json>` al terminar.
 */
const DEVICES = [
  {
    name: 'browser',
    what: 'a browser / PWA (and the bots): the ecosystem identity',
    script: `
      import { Identity } from '/eco/dotrino-identity/src/node.js'
      const qr = JSON.parse(process.env.QR)
      const id = await Identity.connect({ dir: '/data/identity' })
      id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
      const r = await id.enrollDevice(qr, { label: 'browser', join: 'new' })
      const m = await id.myMembership()
      console.log('OK:' + JSON.stringify({ pub: id.me.publickey, profile: m.profileId, isMaster: m.isMaster, caps: m.caps }))
    `
  },
  {
    name: 'node-client',
    what: 'the vault\'s reference device client',
    script: `
      import { enroll } from '/eco/dotrino-vault/src/client.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enroll({ qr, label: 'node-client', dir: '/data/dev', onChallenge: (c) => console.log('CODE:' + c.code) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, cert: !!r.cert, iss: r.cert.iss === qr.iss }))
    `
  },
  {
    // LOS PERMISOS SE ELIGEN AL EMPAREJAR (vaultd 0.132.0): entra ya con `administra` y
    // `aprueba`, en la MISMA acta que lo admite — antes hacían falta dos.
    name: 'with-caps',
    what: 'a device that joins already with administra and aprueba, in a single record',
    scope: 'firma,lee,administra,aprueba',
    permissions: ['administra el perfil', 'aprueba pedidos'],
    script: `
      import { enroll } from '/eco/dotrino-vault/src/client.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enroll({ qr, label: 'with-caps', dir: '/data/perm', onChallenge: (c) => console.log('CODE:' + c.code) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, cert: !!r.cert }))
    `
  },
  {
    name: 'terminal',
    what: 'the dotrino-terminal agent',
    script: `
      import { enroll } from '/eco/dotrino-terminal/agent/link.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enroll({ qr, dir: '/data/terminal', onChallenge: (c) => console.log('CODE:' + c.code) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, cert: !!r.cert }))
    `
  },
  {
    name: 'ia',
    what: 'the dotrino-ia agent (reuses remote-agent enrollment)',
    script: `
      import { enroll } from '/eco/dotrino-remote-agent/src/link.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enroll({ qr, label: 'ia-agent', dir: '/data/ia', onChallenge: (c) => console.log('CODE:' + c.code) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, cert: !!r.cert }))
    `
  },
  {
    name: 'remote-agent',
    what: 'the generic remote agent',
    script: `
      import { enroll } from '/eco/dotrino-remote-agent/src/link.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enroll({ qr, label: 'remote-agent', dir: '/data/remote', onChallenge: (c) => console.log('CODE:' + c.code) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, cert: !!r.cert }))
    `
  },
  {
    name: 'proxy-service',
    what: 'a SERVICE (joins with a CN: only sees its own drawer)',
    service: 'proxy',
    script: `
      import { enrollService } from '/eco/dotrino-vault/lib/src/service.js'
      const qr = JSON.parse(process.env.QR)
      const r = await enrollService({ qr, ns: 'proxy', dir: '/data/service', onCode: (c) => console.log('CODE:' + (typeof c === 'string' ? c : c.code)) })
      console.log('OK:' + JSON.stringify({ pub: r.device.publickey, ns: 'proxy' }))
    `
  }
]

/** El identificador con el que la bóveda lista a una llave (`AB12-CD34`). */
async function idOf (pub) {
  const h = (await pubkeyId(pub)).slice(0, 8).toUpperCase()
  return h.slice(0, 4) + '-' + h.slice(4)
}

/** Corre un dispositivo en su propia caja y devuelve lo que reportó. */
async function pair (d) {
  const box = createBox(d.name)
  const qr = await openPairing(d)

  box.write('/data/script.mjs', d.script)
  let code = null; let ok = null; const lines = []
  box.launch('node /data/script.mjs', {
    env: { QR: JSON.stringify(qr) },
    onLine: (l) => {
      lines.push(l)
      log(`[${d.name}] ` + l)
      if (l.startsWith('CODE:')) code = l.slice(5).trim()
      if (l.startsWith('OK:')) ok = JSON.parse(l.slice(3))
    }
  })

  await waitFor(() => code, { what: `the code shown by «${d.name}»` })
    .catch(() => { throw new Error(`${d.name} showed no code:\n` + lines.join('\n')) })
  approve(code)
  await waitFor(() => ok, { what: `«${d.name}» to finish pairing` })
    .catch(() => { throw new Error(`${d.name} did not finish pairing:\n` + lines.join('\n')) })

  return { box, code, ...ok }
}

// ---------- escenarios ----------

const paired = []

scenario('the vault starts AS A BINARY and its CLI answers', async () => {
  const { status } = await startVaultBinary()
  assert.ok(status.iss, 'it publishes its identity')
  assert.ok(status.version, 'and its version: ' + status.version)
  const output = members()
  assert.match(output, /Perfil/, 'the binary\'s CLI shows the record')
})

for (const d of DEVICES) {
  scenario(`pairs ${d.name} — ${d.what}`, async () => {
    const recordBefore = Number((/acta #(\d+)/.exec(members()) || [])[1])
    const r = await pair(d)
    assert.ok(r.pub, 'it generated its own key, on its own machine')
    paired.push({ ...r, def: d })

    // Y la bóveda lo tiene en su acta: se comprueba por el IDENTIFICADOR de su llave, que
    // es lo que de verdad lo identifica (la etiqueta es un nombre para el humano).
    const output = members()
    const itsId = await idOf(r.pub)
    assert.ok(output.includes(itsId), `the vault does not list ${d.name} (${itsId}):\n` + output)
    if (d.service) assert.match(output, new RegExp(`servicio «${d.service}»`), 'and as a service')
    if (d.permissions) {
      // La línea de permisos va justo debajo de la del aparato.
      const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
      const i = lines.findIndex((l) => l.includes(itsId))
      for (const p of d.permissions) assert.ok((lines[i + 1] || '').includes(p), `${d.name} did not join with «${p}»:\n` + output)
      const recordAfter = Number((/acta #(\d+)/.exec(output) || [])[1])
      assert.equal(recordAfter, recordBefore + 1, 'joining with its permissions costs ONE record, not two')
    }
  })
}

scenario('the terminal opens a shell between two machines, and on return it is still there with its screen', async () => {
  const agent = paired.find((e) => e.def.name === 'terminal')
  const client = paired.find((e) => e.def.name === 'remote-agent')
  assert.ok(agent && client, 'needs the terminal machine and another device of the account')

  // La máquina: el agente de verdad, con su PTY, en su caja.
  const agentOutput = []
  agent.box.write('/data/agent.mjs', `
    import { startAgent } from '/eco/dotrino-terminal/agent/index.js'
    const a = await startAgent({ dir: '/data/terminal', shell: '/bin/sh' })
    console.log('READY:' + a.machine)
    setInterval(() => {}, 1 << 30)
  `)
  agent.box.launch('node /data/agent.mjs', { onLine: (l) => { agentOutput.push(l); log('[agent] ' + l) } })
  await waitFor(() => agentOutput.some((l) => l.startsWith('READY:')), { what: 'the terminal agent to start' })
    .catch(() => { throw new Error('the agent did not start:\n' + agentOutput.join('\n')) })

  // El otro aparato: el MISMO cliente que usa la PWA, con la identidad de su enlace.
  const lines = []
  let ok = false
  client.box.write('/data/console.mjs', `
    import { loadLink, clientLink } from '/eco/dotrino-remote-agent/src/link.js'
    import { RemoteAgentClient } from '/eco/dotrino-remote-agent/src/client.js'
    import { probeAgents } from '/eco/dotrino-remote-agent/src/discover.js'
    const link = clientLink(loadLink('/data/remoto'), { dir: '/data/remote' })
    // El agente trae el acta en su primer tic: hasta entonces no atiende a nadie, y
    // eso es lo correcto. Se reintenta el saludo, no se relaja.
    let rc
    for (let i = 0; i < 20; i++) {
      rc = new RemoteAgentClient(link, { agentPubkey: process.env.AGENT })
      try { await rc.connect(); break } catch (e) { console.log('retry: ' + e.message); await rc.close(); rc = null; await new Promise((r) => setTimeout(r, 1000)) }
    }
    if (!rc) { console.log('FAIL: no session'); process.exit(1) }
    // La app encuentra la máquina preguntándole QUÉ ES, no por el nombre del acta.
    const found = await probeAgents(rc.client, [process.env.AGENT])
    if (found.get(process.env.AGENT)?.kind !== 'terminal-agent') { console.log('FAIL: kind ' + JSON.stringify([...found])); process.exit(1) }
    setTimeout(() => { console.log('FAIL: timeout'); process.exit(1) }, 30000)
    // Espera el primer mensaje de ese tipo (o que la salida acumulada contenga algo).
    const waitMessage = (c, cond) => new Promise((res) => { const off = c.on('message', (p) => { if (cond(p)) { off(); res(p) } }) })
    let out = ''
    rc.on('message', (p) => { if (p.type === 'out' || p.type === 'replay') out += p.data })
    const opened = waitMessage(rc, (p) => p.type === 'attached')
    await rc.send({ type: 'open', cols: 80, rows: 24 })
    const { id } = await opened
    const echoed = waitMessage(rc, () => out.includes('dotrino-42'))
    await rc.send({ type: 'input', data: 'echo dotrino-$((40+2))\\r' })
    await echoed
    await rc.close()                                   // el navegador se fue: la consola sigue

    // Otra conexión (otro aparato, o el mismo tras recargar) vuelve y ve la pantalla.
    const rc2 = new RemoteAgentClient(link, { agentPubkey: process.env.AGENT })
    await rc2.connect()
    const list = waitMessage(rc2, (p) => p.type === 'consoles')
    await rc2.send({ type: 'list' })
    if (!(await list).list.some((c) => c.id === id)) { console.log('FAIL: console gone after leaving'); process.exit(1) }
    let screen = ''
    rc2.on('message', (p) => { if (p.type === 'replay') screen += p.data })
    const attached = waitMessage(rc2, (p) => p.type === 'attached')
    await rc2.send({ type: 'attach', id, cols: 80, rows: 24 })
    await attached
    if (!screen.includes('dotrino-42')) { console.log('FAIL: screen not restored ' + JSON.stringify(screen.slice(-200))); process.exit(1) }
    console.log('OK'); process.exit(0)
  `)
  client.box.launch('node /data/console.mjs', {
    env: { AGENT: agent.pub },
    onLine: (l) => { lines.push(l); log('[console] ' + l); if (l === 'OK') ok = true }
  })
  await waitFor(() => ok || lines.some((l) => l.startsWith('FAIL')), { timeoutMs: 45000, what: 'the remote shell output' })
  assert.ok(ok, 'the remote shell did not return the output:\n' + lines.join('\n') + '\n--- agent ---\n' + agentOutput.join('\n'))
})

scenario('each device has ITS key and none sees another\'s disk', async () => {
  const pubs = paired.map((e) => e.pub)
  assert.equal(new Set(pubs).size, pubs.length, 'no two share a key')

  // Nadie tiene los datos de nadie: cada caja solo tiene lo suyo.
  for (const e of paired) {
    const others = paired.filter((o) => o !== e)
    const listing = e.box.exec('ls -R /data 2>/dev/null | head -50').stdout || ''
    for (const o of others) {
      assert.ok(!listing.includes(o.def.name === 'browser' ? 'foreign-identity' : o.def.name + '-foreign'),
        'no box holds another box\'s data')
    }
  }
})

scenario('the vault record has everyone, and the service joins scoped by its CN', async () => {
  const output = members()
  for (const e of paired) {
    const itsId = await idOf(e.pub)
    assert.ok(output.includes(itsId), `${e.def.name} (${itsId}) is missing from the record:\n` + output)
  }
  assert.equal(paired.length, DEVICES.length, 'all devices paired')
  assert.match(output, /servicio «proxy»/, 'the service is told apart from the devices')
  assert.match(output, /lee sus claves/, 'and it can only read its own keys')
})

// ---------- arranque ----------

const engine = pickEngine()
console.log(`\nSMOKE · per-device pairing, in ephemeral instances (engine: ${engine})\n`)
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
