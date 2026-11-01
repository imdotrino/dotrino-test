/**
 * ¿UN CONTENT NODE RECIBE LA LLAVE DE LA CUENTA? La biblioteca de `dotrino-content` la necesita
 * para abrir lo que subió el teléfono: bóveda real, enrolamiento real, y se mira el acta que le
 * queda al node.
 *
 *   node smoke/content-key.mjs [--verbose]
 */
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import { startProxy, startVault, teardown, tmpDir } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const ROOT = new URL('../..', import.meta.url).pathname
const proxy = await startProxy({ log })
const vault = await startVault({ proxyUrl: proxy.url, log })
const env = { ...process.env, DOTRINO_VAULT_DIR: vault.dir, PROXY_URL: proxy.url }
const VAULTD = path.join(ROOT, 'dotrino-vault/bin/dotrino-vault.js')
const ctl = (...a) => execFileSync(process.execPath, [VAULTD, ...a], { env, encoding: 'utf8', cwd: path.join(ROOT, 'dotrino-vault') })

const nodeHome = tmpDir('content-home')
const nenv = { ...process.env, HOME: nodeHome, DOTRINO_CONTENT_LINK_DIR: path.join(nodeHome, 'link'), DOTRINO_CONTENT_DIR: path.join(nodeHome, 'data'), DOTRINO_PROXY_URL: proxy.url }
const CLI = path.join(ROOT, 'dotrino-content/bin/cli.js')

const pairLines = []
const pair = spawn(process.execPath, [VAULTD, 'pair', '--service', 'content'], { env, cwd: path.join(ROOT, 'dotrino-vault') })
pair.stdout.on('data', (b) => { pairLines.push(...String(b).split('\n')); log('[pair] ' + b) })
pair.stderr.on('data', (b) => log('[pair!] ' + b))
let code = null
for (let i = 0; i < 100 && !code; i++) { await new Promise((r) => setTimeout(r, 200)); code = pairLines.map((l) => l.trim()).find((l) => /^(https?:\/\/\S+#|[A-Za-z0-9_-]{40,}$)/.test(l)) }
if (!code) throw new Error('no invitation:\n' + pairLines.join('\n'))

const enr = spawn(process.execPath, [CLI, 'enroll', code], { env: nenv })
let out = ''
enr.stdout.on('data', (b) => { out += b; log('[enroll] ' + b); const m = /approve\s+([A-Z0-9-]{4,})/i.exec(out); if (m && !enr.done) { enr.done = true; log(ctl('approve', m[1])) } })
enr.stderr.on('data', (b) => { out += b; log('[enroll!] ' + b) })
const rc = await new Promise((r) => enr.on('close', r))
pair.kill()
if (rc !== 0) throw new Error('enroll failed:\n' + out)

const node = spawn(process.execPath, [CLI, 'start', '--port', '0', '--gui-port', '3798'], { env: nenv })
let nout = ''
node.stdout.on('data', (b) => { nout += b; log('[node] ' + b) }); node.stderr.on('data', (b) => { nout += b; log('[node!] ' + b) })
const { loadLink } = await import(path.join(ROOT, 'dotrino-content/node_modules/@dotrino/remote-agent/src/link.js'))
let verdict = null
for (let i = 0; i < 45 && !verdict; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const link = loadLink(path.join(nodeHome, 'link'))
  const m = link?.acta?.members?.find((x) => x.pub === link.device.publickey)
  const wrapped = link?.acta?.keyring?.some((g) => g.wraps?.[link.device.publickey])
  log(`t=${i} seq=${link?.acta?.seq} member=${!!m} encPub=${!!m?.encPub} gens=${link?.acta?.keyring?.length} wrapped=${wrapped}`)
  if (wrapped) verdict = 'WRAPPED'
  if (i === 44) verdict = `NOT WRAPPED member=${!!m} encPub=${!!m?.encPub} gens=${link?.acta?.keyring?.length}`
}
console.log('content key:', verdict)
console.log(nout.split('\n').filter((l) => /library window|control plane/.test(l)).join('\n'))
node.kill()
pair.kill()
await vault.stop()
await teardown()
process.exit(verdict === 'WRAPPED' ? 0 : 1)
