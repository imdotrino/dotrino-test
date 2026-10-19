/**
 * LAS CONSOLAS DE OTRA MÁQUINA, DESDE UNA VENTANA DE ESTA. Dos agentes de terminal de verdad
 * (cada uno en su proceso), un proxio y una bóveda, todo en local.
 *
 * Lo que prueba: la máquina A, por su socket local (lo que usan `dotrino-terminal` y la app de
 * escritorio), ve que B está encendida, lista sus consolas, abre una ALLÍ y la usa. El agente
 * de A hace de cliente del de B con su propio enlace: es un aparato más del acta.
 *
 *   npm run smoke:terminal-other-machines
 *   node smoke/terminal-other-machines.mjs --verbose
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { scenario, runScenarios, startProxy, startVault, teardown, tmpDir, ROOT } from './lib/harness.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const AGENT = path.join(ROOT, 'dotrino-terminal/agent')
// `--b-agent <carpeta>`: la máquina B corre OTRA versión del agente (una ya publicada, instalada
// en esa carpeta). La norma es que solo la máquina que MIRA necesita la versión nueva: las
// vistas pueden llevar meses sin actualizarse, y eso es lo que hay en la calle.
const iB = process.argv.indexOf('--b-agent')
const AGENT_B = iB > 0 ? path.resolve(process.argv[iB + 1]) : AGENT

let proxy = null
let vault = null
const machines = {}        // a, b: { dir, proc }

async function startMachine (name) {
  const { enroll } = await import(path.join(AGENT, 'link.js'))
  const dir = tmpDir('ta-' + name)
  const qr = await vault.pair({ label: name })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  const proc = spawn(process.execPath, [path.join(name === 'b' ? AGENT_B : AGENT, 'bin/cli.js'), '--dir', dir, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let output = ''
  proc.stdout.on('data', (d) => { output += d; log(`[${name}] ${String(d).trimEnd()}`) })
  proc.stderr.on('data', (d) => { output += d; log(`[${name}!] ${String(d).trimEnd()}`) })
  await waitFor(() => /máquina: /.test(output), { what: `agent ${name} to start\n${output}` })
  machines[name] = { dir, proc }
}

/** Una ventana de la máquina A: el socket local, como `dotrino-terminal`. */
async function openWindow () {
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(machines.a.dir)
  const got = []
  c.on('message', (m) => { got.push(m); log('[window] ' + JSON.stringify(m).slice(0, 160)) })
  return { c, got, last: (type) => got.filter((m) => m.type === type).pop(), out: () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('') }
}

scenario('two machines link to the same vault and start their agent', async () => {
  await startMachine('a')
  await startMachine('b')
})

let idB = null
scenario('A sees that B is on (and A does not list itself)', async () => {
  const w = await openWindow()
  w.c.send({ type: 'machines' })
  await waitFor(() => w.last('machines') || w.last('fail'), { what: 'the machine list' })
  assert.equal(w.last('fail'), undefined, JSON.stringify(w.last('fail')))
  const list = w.last('machines').list
  assert.equal(list.length, 1, JSON.stringify(list))
  assert.equal(list[0].name, 'b')
  assert.match(list[0].id, /^[0-9A-F]{4}-[0-9A-F]{4}$/)
  assert.deepEqual(list[0].consoles, [], 'B has no consoles yet')
  idB = list[0].id
  w.c.close()
})

scenario('a window on A opens a console ON B and uses it', async () => {
  const w = await openWindow()
  w.c.send({ type: 'via', machine: idB })
  w.c.send({ type: 'open', cols: 80, rows: 24 })
  await waitFor(() => w.last('attached') || w.last('fail'), { what: 'attaching to the console on B' })
  assert.equal(w.last('fail'), undefined, JSON.stringify(w.last('fail')))
  // La carpeta del perfil viaja a la shell: es la de B, no la de A.
  w.c.send({ type: 'input', data: 'echo "$DOTRINO_TERMINAL_PROFILE_DIR"\r' })
  await waitFor(() => w.out().includes(machines.b.dir), { what: 'the shell to answer from B' })
  assert.ok(!w.out().includes(machines.a.dir), 'it does not run on A')
  w.c.close()
})

scenario("A's panel lists B's console, and a new window reattaches to it", async () => {
  const p = await openWindow()
  const list = await waitFor(async () => {
    p.c.send({ type: 'machines' })
    await sleep(300)
    const m = p.last('machines')
    return m && m.list[0]?.consoles?.length === 1 && m.list[0].consoles[0].viewers === 0 ? m.list : null
  }, { what: "B's console to show up detached in A's list" })
  const cid = list[0].consoles[0].id
  const w = await openWindow()
  w.c.send({ type: 'via', machine: 'b' })                 // por nombre también
  w.c.send({ type: 'attach', id: cid, cols: 80, rows: 24 })
  await waitFor(() => w.last('attached'), { what: 'reattaching to the console' })
  assert.ok(w.out().includes(machines.b.dir), 'it brings back what was on screen')
  // Cerrarla desde el panel de A, sin ventana.
  w.c.close()
  p.c.send({ type: 'far', machine: idB, msg: { type: 'kill', id: cid } })
  await waitFor(async () => {
    p.c.send({ type: 'machines' })
    await sleep(300)
    return p.last('machines').list[0]?.consoles?.length === 0
  }, { what: "B's console to close" })
  p.c.close()
})

scenario('B keeps serving the others: A took nothing away by connecting as a client', async () => {
  // El agente de A tiene DOS conexiones con su llave (la suya de agente y la de cliente).
  // B le abre una consola a A, que es el camino inverso, para ver que A sigue recibiendo.
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const c = await connectLocal(machines.b.dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'via', machine: 'a' })
  c.send({ type: 'open', cols: 80, rows: 24 })
  await waitFor(() => got.find((m) => m.type === 'attached' || m.type === 'fail'), { what: 'B to open a console on A' })
  assert.equal(got.find((m) => m.type === 'fail'), undefined, JSON.stringify(got.find((m) => m.type === 'fail')))
  c.close()
})

scenario('with the vault off and no stored record, a new machine SAYS it could not ask', async () => {
  // Lo que pasaba: contestaba una lista vacía, igual que si no hubiera otras máquinas.
  const { enroll } = await import(path.join(AGENT, 'link.js'))
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const dir = tmpDir('ta-c')
  const qr = await vault.pair({ label: 'c' })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  await vault.stop()
  const proc = spawn(process.execPath, [path.join(AGENT, 'bin/cli.js'), '--dir', dir, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let output = ''
  proc.stdout.on('data', (d) => { output += d })
  proc.stderr.on('data', (d) => { output += d })
  machines.c = { dir, proc }
  // Necesita @dotrino/terminal-agent construido con remote-agent ≥ 0.22.5 (el log dice «agent running»).
  await waitFor(() => /agent running/.test(output), { what: `agent c to start\n${output}` })
  const c = await connectLocal(dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'machines' })
  const r = await waitFor(() => got.find((m) => m.type === 'machines' || m.type === 'fail'), { timeoutMs: 60000, what: 'the answer' })
  c.close()
  assert.equal(r.type, 'fail', 'it answered with a list: ' + JSON.stringify(r))
  assert.equal(r.code, 'no-record', JSON.stringify(r))
})

scenario('a linked machine WITHOUT NETWORK still opens its local consoles', async () => {
  // Lo que pasaba: el agente moría al no llegar al proxio, y no se abría ni una consola de aquí.
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const dir = tmpDir('ta-sinred')
  fs.cpSync(machines.a.dir, dir, { recursive: true })
  for (const f of ['agent.pid', 'terminal.sock']) fs.rmSync(path.join(dir, f), { force: true })
  const link = JSON.parse(fs.readFileSync(path.join(dir, 'link.json'), 'utf8'))
  link.proxy = 'ws://127.0.0.1:1'                                  // nadie escucha ahí
  fs.writeFileSync(path.join(dir, 'link.json'), JSON.stringify(link))
  const proc = spawn(process.execPath, [path.join(AGENT, 'bin/cli.js'), '--dir', dir, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let output = ''
  proc.stdout.on('data', (d) => { output += d })
  proc.stderr.on('data', (d) => { output += d })
  machines.offline = { dir, proc }
  await waitFor(() => /agent running/.test(output), { timeoutMs: 40000, what: `the agent to start without network\n${output}` })
  assert.match(output, /local windows work/, 'it did not say the remote part failed to start')
  const c = await connectLocal(dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'open', cols: 80, rows: 24 })
  await waitFor(() => got.find((m) => m.type === 'attached'), { what: 'opening a local console without network' })
  c.close()
})

console.log('\nSMOKE · another machine\'s consoles from a window on this one, all local\n')
const stopAll = () => { for (const m of Object.values(machines)) { try { m.proc.kill('SIGTERM') } catch (_) {} } }
try {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  console.log(`  proxy  ${proxy.url}\n`)
  const ok = await runScenarios()
  stopAll()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  stopAll()
  await teardown()
  process.exit(1)
}
