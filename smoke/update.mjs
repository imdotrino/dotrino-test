/**
 * smoke:update — LA BÓVEDA SE ACTUALIZA SOLA, Y PIDE PERMISO SI SE ENCIENDE EL AJUSTE (vaultd ≥ 0.146.0).
 *
 * Contra el release REAL de GitHub y la atestación REAL de sigstore: nada simulado en el
 * camino que importa. La caja hace de máquina con instalación de usuario
 * (`~/.local/share/dotrino/bin`), un bucle hace de systemd (`Restart=always`, con
 * `INVOCATION_ID` para que el daemon sepa que alguien lo levanta), y el binario de prueba se
 * presenta como 0.131.2 para que la última publicada le parezca nueva.
 *
 *   1. POR DEFECTO: instala sola y se reinicia EN EL ACTO (no a los ~2 min del vigilante).
 *   2. CON EL AJUSTE ENCENDIDO (`update --approval on`) y un aprobador que es un NAVEGADOR (no
 *      un teléfono): pide permiso, el navegador lo ve como «actualizarse», lo aprueba, y
 *      entonces instala y se reinicia.
 *
 * Necesita red hacia GitHub. `dotrino-vault/dist/` tiene que traer los dos binarios:
 * `dotrino-vaultd` (el código actual con su versión) y `dotrino-vaultd-viejo` (el mismo código
 * presentándose como anterior a la última publicada).
 *
 *   npm run smoke:update [-- --verbose]
 */
import assert from 'node:assert/strict'
import { scenario, runScenarios, startProxy, teardown } from './lib/harness.js'
import { createBox, destroyBoxes } from './lib/box.js'
import { waitFor } from './lib/wait.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'
import { keyLabel } from '../../dotrino-identity/vault/keyid.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const DIST = '/eco/dotrino-vault/dist'
const HOME = '/root'
const BIN = `${HOME}/.local/share/dotrino/bin/dotrino-vaultd`
const GH_V = '2.101.0'

let proxy = null

const waitLong = (fn, o) => waitFor(fn, { timeoutMs: 60000, every: 500, ...o })

/** Una máquina con instalación de usuario: libatomic, un `gh` de usuario comprobado y el binario. */
function machine (name, dataDir) {
  const box = createBox(name)
  const sh = (cmd) => {
    const r = box.exec(cmd, { env: { HOME } })
    const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '')
    log(`[${name}] $ ${cmd.slice(0, 90)}\n${out.trim()}`)
    return out
  }
  sh('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1 curl ca-certificates) >/dev/null 2>&1; command -v curl >/dev/null || (apt-get install -y -qq curl ca-certificates >/dev/null 2>&1)')
  // `gh` como binario de USUARIO, comprobado contra la suma que publica GitHub CLI: es lo que
  // hace el dueño en sus máquinas, y es el que la bóveda debe preferir al del sistema.
  sh(`set -e; F=gh_${GH_V}_linux_amd64.tar.gz; T=$(mktemp -d); cd $T; curl -sL -o $F https://github.com/cli/cli/releases/download/v${GH_V}/$F; curl -sL -o s.txt https://github.com/cli/cli/releases/download/v${GH_V}/gh_${GH_V}_checksums.txt; grep " $F$" s.txt | sha256sum -c - ; tar xzf $F; mkdir -p ${HOME}/.local/bin; install -m755 gh_${GH_V}_linux_amd64/bin/gh ${HOME}/.local/bin/gh`)
  const ENV = { HOME, DOTRINO_VAULT_DIR: dataDir }
  const ctl = (args) => {
    const r = box.exec(`${BIN} --ctl ${args}`, { env: ENV })
    const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '')
    log(`[${name}] ctl ${args}\n${out.trim()}`)
    return out
  }
  const putBinary = (binary) => sh(`mkdir -p $(dirname ${BIN}) && cp ${DIST}/${binary} ${BIN}.new && chmod 755 ${BIN}.new && mv ${BIN}.new ${BIN}`)
  const lines = []
  /** Un bucle que hace de systemd: si el daemon sale, lo vuelve a levantar. */
  const start = () => box.launch(
    `bash -c 'while true; do ${BIN}; echo "EXITED:$?"; sleep 1; done'`,
    { env: { ...ENV, PROXY_URL: proxy.url, INVOCATION_ID: 'smoke' }, onLine: (l) => { lines.push({ t: Date.now(), l }); log(`[${name}] ${l}`) } }
  )
  const version = () => (/versi[oó]n\s*:\s*(\S+)/.exec(ctl('status')) || [])[1] || null
  const line = (re) => lines.find((x) => re.test(x.l))
  return { box, sh, ctl, putBinary, start, version, line, lines }
}

let published = null

scenario('the published release can be read (the test needs network access to GitHub)', async () => {
  proxy = await startProxy()
  const r = await fetch('https://api.github.com/repos/imdotrino/dotrino-vault/releases/latest', { headers: { accept: 'application/vnd.github+json' } })
  assert.equal(r.status, 200, 'GitHub answers')
  published = String((await r.json()).tag_name).replace(/^v/, '')
  log('[release] latest published: ' + published)
})

scenario('BY DEFAULT: it updates itself and restarts RIGHT AWAY', async () => {
  const m = machine('upd-sola', '/data/sola')
  m.putBinary('dotrino-vaultd-viejo')
  m.start()
  await waitLong(() => m.version(), { what: 'the vault to start' })
  const old = m.version()
  assert.notEqual(old, published, `the test binary must be older than ${published}`)
  const inst = await waitLong(() => m.line(/installed · restarting now/), { timeoutMs: 180000, what: 'it to install the published version' })
  assert.ok(m.line(/verified against its attestation/), 'it verified it against sigstore before touching anything')
  const exited = await waitLong(() => m.lines.find((x) => x.t >= inst.t && /EXITED:/.test(x.l)), { timeoutMs: 30000, what: 'the process to exit in order to restart' })
  assert.ok(exited.t - inst.t < 15000, `it restarted ${exited.t - inst.t} ms after installing: it does not wait for the watchdog (~2 min)`)
  await waitLong(() => m.version() === published && !/corre la versi/.test(m.ctl('status')), { timeoutMs: 60000, what: `${published} to be running` })
})

scenario('WITH THE SETTING ON and an approver that is a BROWSER: it asks, the browser approves, and then it updates', async () => {
  const m = machine('upd-aprobada', '/data/aprobada')
  // Primero con la versión al día, para que no se actualice antes de tener aprobador.
  m.putBinary('dotrino-vaultd')
  m.start()
  await waitLong(() => m.version(), { what: 'the vault to start' })

  // El navegador: la identidad del ecosistema, la misma que corre en vault.dotrino.com.
  const pairLines = []
  m.box.launch(`${BIN} --ctl pair`, { env: { HOME, DOTRINO_VAULT_DIR: '/data/aprobada' }, onLine: (l) => pairLines.push(l.trim()) })
  const qr = await waitLong(() => { for (const l of pairLines) { const o = l.length > 20 && parseInvite(l); if (o?.sn) return o } return null }, { what: 'the invitation' })
  const browser = createBox('upd-navegador')
  const browserOutput = []
  let seenRequest = null
  browser.launch(`node --input-type=module -e "$SCRIPT"`, {
    env: {
      QR: JSON.stringify(qr),
      SCRIPT: `
        import { Identity } from '/eco/dotrino-identity/src/node.js'
        const id = await Identity.connect({ dir: '/data/navegador' })
        id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
        await id.enrollDevice(JSON.parse(process.env.QR), { label: 'navegador', join: 'new' })
        console.log('PUB:' + id.me.publickey)
        // Espera a que le den el permiso y a que aparezca el pedido de actualizarse.
        for (let i = 0; i < 400; i++) {
          const r = await id.vaultApprovals('approvals').catch((e) => ({ error: e.message }))
          if (r?.error) { if (i % 10 === 0) console.log('WAIT:' + r.error) }
          const p = (r?.items || []).find((x) => x.kind === 'update')
          if (p) {
            console.log('REQUEST:' + JSON.stringify({ kind: p.kind, version: p.ctx?.version, from: p.ctx?.from }))
            const a = await id.vaultApprovals('approve', { id: p.id })
            console.log('APPROVED:' + JSON.stringify(a))
            break
          }
          await new Promise((res) => setTimeout(res, 1500))
        }
        setTimeout(() => process.exit(0), 500)
      `
    },
    onLine: (l) => {
      browserOutput.push(l); log('[browser] ' + l)
      const c = /CODE:(\d+)/.exec(l); if (c) m.ctl('approve ' + c[1])
      if (l.startsWith('REQUEST:')) seenRequest = JSON.parse(l.slice(8))
    }
  })
  const pub = await waitLong(() => { const x = browserOutput.find((l) => l.startsWith('PUB:')); return x && x.slice(4) }, { what: 'the browser to sign in' })
  // El permiso de aprobar lo da el dueño en la bóveda, igual que a un teléfono.
  // Por su HUELLA, que sale de su llave: la etiqueta la pone `pair` y no dice quién es.
  const id = await keyLabel(pub)
  assert.match(m.ctl('members'), new RegExp(id), 'the browser shows up among the members')
  m.ctl(`caps ${id} +approve`)
  log('[approver] ' + id + ' ' + pub.slice(0, 40))
  // Pedir permiso es un ajuste, apagado por defecto: sin encenderlo se actualizaría sola.
  assert.match(m.ctl('update --approval on'), /pide aprobaci[oó]n/, 'the setting is on')
  assert.match(m.ctl('status'), /actualizar\s*:\s*pide aprobaci[oó]n/, 'and `status` says so')

  // Ahora sí: el binario anterior. El vigilante lo nota (~2 min) y reinicia; al arrancar ve la
  // versión nueva y, como el ajuste está encendido y hay aprobador, pide.
  m.putBinary('dotrino-vaultd-viejo')
  await waitLong(() => m.line(/asking .*approver/), { timeoutMs: 240000, what: 'it to ask the approver' })
  assert.equal(m.line(/installed · restarting now/), undefined, 'it installs nothing without the yes')
  await waitLong(() => seenRequest, { timeoutMs: 120000, what: 'the browser to see the request' })
  assert.equal(seenRequest.kind, 'update', 'the browser sees it as an update, not as a key request')
  assert.equal(seenRequest.version, published, 'and knows which version')
  await waitLong(() => m.line(/installed · restarting now/), { timeoutMs: 180000, what: 'it to install after the yes' })
  await waitLong(() => m.version() === published && !/corre la versi/.test(m.ctl('status')), { timeoutMs: 60000, what: `${published} to be running` })
})

const ok = await runScenarios()
destroyBoxes()
await teardown()
process.exit(ok ? 0 : 1)
