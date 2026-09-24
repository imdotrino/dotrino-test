/**
 * smoke:actualizacion — LA BÓVEDA SE ACTUALIZA SOLA, CON Y SIN APROBADOR (vaultd ≥ 0.131.2).
 *
 * Contra el release REAL de GitHub y la atestación REAL de sigstore: nada simulado en el
 * camino que importa. La caja hace de máquina con instalación de usuario
 * (`~/.local/share/dotrino/bin`), un bucle hace de systemd (`Restart=always`, con
 * `INVOCATION_ID` para que el daemon sepa que alguien lo levanta), y el binario de prueba se
 * presenta como 0.131.2 para que la última publicada le parezca nueva.
 *
 *   1. SIN aprobadores: instala sola y se reinicia EN EL ACTO (no a los ~2 min del vigilante).
 *   2. CON un aprobador que es un NAVEGADOR (no un teléfono): pide permiso, el navegador lo ve
 *      como «actualizarse», lo aprueba, y entonces instala y se reinicia.
 *
 * Necesita red hacia GitHub. `dotrino-vault/dist/` tiene que traer los dos binarios:
 * `dotrino-vaultd` (el código actual con su versión) y `dotrino-vaultd-viejo` (el mismo código
 * presentándose como anterior a la última publicada).
 *
 *   npm run smoke:actualizacion [-- --verbose]
 */
import assert from 'node:assert/strict'
import { escenario, correr, startProxy, teardown } from './lib/harness.js'
import { crearCaja, destruirCajas } from './lib/caja.js'
import { parseInvite } from '../../dotrino-vault/lib/src/invite.js'
import { keyLabel } from '../../dotrino-identity/vault/keyid.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DIST = '/eco/dotrino-vault/dist'
const HOME = '/root'
const BIN = `${HOME}/.local/share/dotrino/bin/dotrino-vaultd`
const GH_V = '2.101.0'

let proxy = null

async function esperar (fn, { timeoutMs = 60000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) { const v = await fn(); if (v) return v; await sleep(500) }
  throw new Error('se agotó la espera de ' + que)
}

/** Una máquina con instalación de usuario: libatomic, un `gh` de usuario comprobado y el binario. */
function maquina (nombre, dataDir) {
  const caja = crearCaja(nombre)
  const sh = (cmd) => {
    const r = caja.exec(cmd, { env: { HOME } })
    const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '')
    log(`[${nombre}] $ ${cmd.slice(0, 90)}\n${out.trim()}`)
    return out
  }
  sh('ldconfig -p | grep -q libatomic || (apt-get update -qq && apt-get install -y -qq libatomic1 curl ca-certificates) >/dev/null 2>&1; command -v curl >/dev/null || (apt-get install -y -qq curl ca-certificates >/dev/null 2>&1)')
  // `gh` como binario de USUARIO, comprobado contra la suma que publica GitHub CLI: es lo que
  // hace el dueño en sus máquinas, y es el que la bóveda debe preferir al del sistema.
  sh(`set -e; F=gh_${GH_V}_linux_amd64.tar.gz; T=$(mktemp -d); cd $T; curl -sL -o $F https://github.com/cli/cli/releases/download/v${GH_V}/$F; curl -sL -o s.txt https://github.com/cli/cli/releases/download/v${GH_V}/gh_${GH_V}_checksums.txt; grep " $F$" s.txt | sha256sum -c - ; tar xzf $F; mkdir -p ${HOME}/.local/bin; install -m755 gh_${GH_V}_linux_amd64/bin/gh ${HOME}/.local/bin/gh`)
  const ENV = { HOME, DOTRINO_VAULT_DIR: dataDir }
  const ctl = (args) => {
    const r = caja.exec(`${BIN} --ctl ${args}`, { env: ENV })
    const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '')
    log(`[${nombre}] ctl ${args}\n${out.trim()}`)
    return out
  }
  const poner = (binario) => sh(`mkdir -p $(dirname ${BIN}) && cp ${DIST}/${binario} ${BIN}.new && chmod 755 ${BIN}.new && mv ${BIN}.new ${BIN}`)
  const lineas = []
  /** Un bucle que hace de systemd: si el daemon sale, lo vuelve a levantar. */
  const arrancar = () => caja.lanzar(
    `bash -c 'while true; do ${BIN}; echo "SALIO:$?"; sleep 1; done'`,
    { env: { ...ENV, PROXY_URL: proxy.url, INVOCATION_ID: 'smoke' }, onLinea: (l) => { lineas.push({ t: Date.now(), l }); log(`[${nombre}] ${l}`) } }
  )
  const version = () => (/versi[oó]n\s*:\s*(\S+)/.exec(ctl('status')) || [])[1] || null
  const linea = (re) => lineas.find((x) => re.test(x.l))
  return { caja, sh, ctl, poner, arrancar, version, linea, lineas }
}

let publicada = null

escenario('el release publicado se puede leer (la prueba necesita red hacia GitHub)', async () => {
  proxy = await startProxy()
  const r = await fetch('https://api.github.com/repos/imdotrino/dotrino-vault/releases/latest', { headers: { accept: 'application/vnd.github+json' } })
  assert.equal(r.status, 200, 'GitHub contesta')
  publicada = String((await r.json()).tag_name).replace(/^v/, '')
  log('[release] última publicada: ' + publicada)
})

escenario('SIN aprobadores: se actualiza sola y se reinicia EN EL ACTO', async () => {
  const m = maquina('upd-sola', '/data/sola')
  m.poner('dotrino-vaultd-viejo')
  m.arrancar()
  await esperar(() => m.version(), { que: 'que la bóveda arranque' })
  const vieja = m.version()
  assert.notEqual(vieja, publicada, `el binario de prueba tiene que ser anterior a ${publicada}`)
  const inst = await esperar(() => m.linea(/installed · restarting now/), { timeoutMs: 180000, que: 'que instale la versión publicada' })
  assert.ok(m.linea(/verified against its attestation/), 'la verificó contra sigstore antes de tocar nada')
  const salio = await esperar(() => m.lineas.find((x) => x.t >= inst.t && /SALIO:/.test(x.l)), { timeoutMs: 30000, que: 'que el proceso se vaya para reiniciarse' })
  assert.ok(salio.t - inst.t < 15000, `se reinició a los ${salio.t - inst.t} ms de instalar: no espera al vigilante (~2 min)`)
  await esperar(() => m.version() === publicada && !/corre la versi/.test(m.ctl('status')), { timeoutMs: 60000, que: `que corra la ${publicada}` })
})

escenario('CON un aprobador que es un NAVEGADOR: pide permiso, se aprueba desde el navegador, y entonces se actualiza', async () => {
  const m = maquina('upd-aprobada', '/data/aprobada')
  // Primero con la versión al día, para que no se actualice antes de tener aprobador.
  m.poner('dotrino-vaultd')
  m.arrancar()
  await esperar(() => m.version(), { que: 'que la bóveda arranque' })

  // El navegador: la identidad del ecosistema, la misma que corre en vault.dotrino.com.
  const lineasPair = []
  m.caja.lanzar(`${BIN} --ctl pair`, { env: { HOME, DOTRINO_VAULT_DIR: '/data/aprobada' }, onLinea: (l) => lineasPair.push(l.trim()) })
  const qr = await esperar(() => { for (const l of lineasPair) { const o = l.length > 20 && parseInvite(l); if (o?.sn) return o } return null }, { que: 'la invitación' })
  const nav = crearCaja('upd-navegador')
  const salidaNav = []
  let aprobo = null
  nav.lanzar(`node --input-type=module -e "$GUION"`, {
    env: {
      QR: JSON.stringify(qr),
      GUION: `
        import { Identity } from '/eco/dotrino-identity/src/node.js'
        const id = await Identity.connect({ dir: '/data/navegador' })
        id.onVault((e) => { if (e.phase === 'challenge') console.log('CODE:' + e.code) })
        await id.enrollDevice(JSON.parse(process.env.QR), { label: 'navegador', join: 'new' })
        console.log('PUB:' + id.me.publickey)
        // Espera a que le den el permiso y a que aparezca el pedido de actualizarse.
        for (let i = 0; i < 400; i++) {
          const r = await id.vaultApprovals('approvals').catch((e) => ({ error: e.message }))
          if (r?.error) { if (i % 10 === 0) console.log('ESPERA:' + r.error) }
          const p = (r?.items || []).find((x) => x.kind === 'update')
          if (p) {
            console.log('PEDIDO:' + JSON.stringify({ kind: p.kind, version: p.ctx?.version, from: p.ctx?.from }))
            const a = await id.vaultApprovals('approve', { id: p.id })
            console.log('APROBADO:' + JSON.stringify(a))
            break
          }
          await new Promise((res) => setTimeout(res, 1500))
        }
        setTimeout(() => process.exit(0), 500)
      `
    },
    onLinea: (l) => {
      salidaNav.push(l); log('[navegador] ' + l)
      const c = /CODE:(\d+)/.exec(l); if (c) m.ctl('approve ' + c[1])
      if (l.startsWith('PEDIDO:')) aprobo = JSON.parse(l.slice(7))
    }
  })
  const pub = await esperar(() => { const x = salidaNav.find((l) => l.startsWith('PUB:')); return x && x.slice(4) }, { que: 'que el navegador entre' })
  // El permiso de aprobar lo da el dueño en la bóveda, igual que a un teléfono.
  // Por su HUELLA, que sale de su llave: la etiqueta la pone `pair` y no dice quién es.
  const id = await keyLabel(pub)
  assert.match(m.ctl('members'), new RegExp(id), 'el navegador aparece entre los miembros')
  m.ctl(`caps ${id} +aprueba`)
  log('[aprobador] ' + id + ' ' + pub.slice(0, 40))

  // Ahora sí: el binario anterior. El vigilante lo nota (~2 min) y reinicia; al arrancar ve la
  // versión nueva y, como hay aprobador, pide.
  m.poner('dotrino-vaultd-viejo')
  await esperar(() => m.linea(/asking one of 1 approver/), { timeoutMs: 240000, que: 'que pida permiso al aprobador' })
  assert.equal(m.linea(/installed · restarting now/), undefined, 'no instala nada sin el sí')
  await esperar(() => aprobo, { timeoutMs: 120000, que: 'que el navegador vea el pedido' })
  assert.equal(aprobo.kind, 'update', 'el navegador lo ve como una actualización, no como un pedido de claves')
  assert.equal(aprobo.version, publicada, 'y sabe a qué versión')
  await esperar(() => m.linea(/installed · restarting now/), { timeoutMs: 180000, que: 'que instale tras el sí' })
  await esperar(() => m.version() === publicada && !/corre la versi/.test(m.ctl('status')), { timeoutMs: 60000, que: `que corra la ${publicada}` })
})

const ok = await correr()
destruirCajas()
await teardown()
process.exit(ok ? 0 : 1)
