/**
 * LAS CONSOLAS DE OTRA MÁQUINA, DESDE UNA VENTANA DE ESTA. Dos agentes de terminal de verdad
 * (cada uno en su proceso), un proxio y una bóveda, todo en local.
 *
 * Lo que prueba: la máquina A, por su socket local (lo que usan `dotrino-terminal` y la app de
 * escritorio), ve que B está encendida, lista sus consolas, abre una ALLÍ y la usa. El agente
 * de A hace de cliente del de B con su propio enlace: es un aparato más del acta.
 *
 *   npm run smoke:terminal-otras-maquinas
 *   node smoke/terminal-otras-maquinas.mjs --verbose
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { escenario, correr, startProxy, startVault, teardown, tmpDir, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const AGENTE = path.join(ROOT, 'dotrino-terminal/agent')

let proxy = null
let vault = null
const maquinas = {}        // a, b: { dir, proc }

async function esperar (fn, { timeoutMs = 30000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(150)
  }
  throw new Error('se agotó la espera de ' + que)
}

async function levantar (nombre) {
  const { enroll } = await import(path.join(AGENTE, 'link.js'))
  const dir = tmpDir('ta-' + nombre)
  const qr = await vault.pair({ label: nombre })
  await enroll({ qr, dir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  const proc = spawn(process.execPath, [path.join(AGENTE, 'bin/cli.js'), '--dir', dir, '--shell', '/bin/sh'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  let salida = ''
  proc.stdout.on('data', (d) => { salida += d; log(`[${nombre}] ${String(d).trimEnd()}`) })
  proc.stderr.on('data', (d) => { salida += d; log(`[${nombre}!] ${String(d).trimEnd()}`) })
  await esperar(() => /máquina: /.test(salida), { que: `que arranque el agente ${nombre}\n${salida}` })
  maquinas[nombre] = { dir, proc }
}

/** Una ventana de la máquina A: el socket local, como `dotrino-terminal`. */
async function ventana () {
  const { connectLocal } = await import(path.join(AGENTE, 'local.js'))
  const c = await connectLocal(maquinas.a.dir)
  const got = []
  c.on('message', (m) => { got.push(m); log('[ventana] ' + JSON.stringify(m).slice(0, 160)) })
  return { c, got, last: (type) => got.filter((m) => m.type === type).pop(), out: () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('') }
}

escenario('dos máquinas se enlazan a la misma bóveda y arrancan su agente', async () => {
  await levantar('a')
  await levantar('b')
})

let idB = null
escenario('desde A se ve que B está encendida (y A no se lista a sí misma)', async () => {
  const w = await ventana()
  w.c.send({ type: 'machines' })
  await esperar(() => w.last('machines') || w.last('fail'), { que: 'la lista de máquinas' })
  assert.equal(w.last('fail'), undefined, JSON.stringify(w.last('fail')))
  const list = w.last('machines').list
  assert.equal(list.length, 1, JSON.stringify(list))
  assert.equal(list[0].name, 'b')
  assert.match(list[0].id, /^[0-9A-F]{4}-[0-9A-F]{4}$/)
  assert.deepEqual(list[0].consoles, [], 'B todavía no tiene consolas')
  idB = list[0].id
  w.c.close()
})

escenario('una ventana de A abre una consola EN B y la usa', async () => {
  const w = await ventana()
  w.c.send({ type: 'via', machine: idB })
  w.c.send({ type: 'open', cols: 80, rows: 24 })
  await esperar(() => w.last('attached') || w.last('fail'), { que: 'engancharse a la consola de B' })
  assert.equal(w.last('fail'), undefined, JSON.stringify(w.last('fail')))
  // La carpeta del perfil viaja a la shell: es la de B, no la de A.
  w.c.send({ type: 'input', data: 'echo "$DOTRINO_TERMINAL_PROFILE_DIR"\r' })
  await esperar(() => w.out().includes(maquinas.b.dir), { que: 'que la shell conteste desde B' })
  assert.ok(!w.out().includes(maquinas.a.dir), 'no corre en A')
  w.c.close()
})

escenario('el panel de A lista la consola de B, y una ventana nueva la retoma', async () => {
  const p = await ventana()
  const lista = await esperar(async () => {
    p.c.send({ type: 'machines' })
    await sleep(300)
    const m = p.last('machines')
    return m && m.list[0]?.consoles?.length === 1 && m.list[0].consoles[0].viewers === 0 ? m.list : null
  }, { que: 'que la consola de B salga suelta en la lista de A' })
  const cid = lista[0].consoles[0].id
  const w = await ventana()
  w.c.send({ type: 'via', machine: 'b' })                 // por nombre también
  w.c.send({ type: 'attach', id: cid, cols: 80, rows: 24 })
  await esperar(() => w.last('attached'), { que: 'retomar la consola' })
  assert.ok(w.out().includes(maquinas.b.dir), 'trae lo que había en pantalla')
  // Cerrarla desde el panel de A, sin ventana.
  w.c.close()
  p.c.send({ type: 'far', machine: idB, msg: { type: 'kill', id: cid } })
  await esperar(async () => {
    p.c.send({ type: 'machines' })
    await sleep(300)
    return p.last('machines').list[0]?.consoles?.length === 0
  }, { que: 'que la consola de B se cierre' })
  p.c.close()
})

escenario('B sigue atendiendo a los demás: A no le quitó nada al conectarse como cliente', async () => {
  // El agente de A tiene DOS conexiones con su llave (la suya de agente y la de cliente).
  // B le abre una consola a A, que es el camino inverso, para ver que A sigue recibiendo.
  const { connectLocal } = await import(path.join(AGENTE, 'local.js'))
  const c = await connectLocal(maquinas.b.dir)
  const got = []
  c.on('message', (m) => got.push(m))
  c.send({ type: 'via', machine: 'a' })
  c.send({ type: 'open', cols: 80, rows: 24 })
  await esperar(() => got.find((m) => m.type === 'attached' || m.type === 'fail'), { que: 'que B abra una consola en A' })
  assert.equal(got.find((m) => m.type === 'fail'), undefined, JSON.stringify(got.find((m) => m.type === 'fail')))
  c.close()
})

console.log('\nSMOKE · las consolas de otra máquina desde una ventana de esta, todo en local\n')
const parar = () => { for (const m of Object.values(maquinas)) { try { m.proc.kill('SIGTERM') } catch (_) {} } }
try {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  console.log(`  proxy  ${proxy.url}\n`)
  const ok = await correr()
  parar()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  parar()
  await teardown()
  process.exit(1)
}
