/**
 * Andamiaje del smoke E2E: levanta el ecosistema entero en la máquina donde corre.
 *
 * Nada de esto toca producción: el proxy es una instancia local en un puerto propio y el
 * vault vive en un directorio temporal que se borra al terminar. Por eso el smoke puede
 * correr en CI sin credenciales (regla de `dotrino-vault/docs/acta-de-perfil.md §5`).
 *
 * Piezas que sabe levantar:
 *   · el PROXY del ecosistema (`dotrino-proxy`), en `ws://localhost:<puerto>`
 *   · una BÓVEDA (`dotrino-vault`, el daemon) con su perfil recién creado
 *   · DISPOSITIVOS y AGENTES headless (terminal / ia / bot), que son identidades Node
 *     usando exactamente el mismo protocolo que los reales
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import * as atRest from '../../../dotrino-vault/src/atrest.js'

export const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname)
export const PROXY_DIR = path.join(ROOT, 'dotrino-proxy')
export const VAULT_DIR = path.join(ROOT, 'dotrino-vault')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Un puerto libre de verdad (pedido al SO y devuelto). */
export function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Espera a que algo escuche en el puerto (o se rinde con un error legible). */
export async function waitPort (port, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ port, host: '127.0.0.1' })
      s.on('connect', () => { s.destroy(); resolve(true) })
      s.on('error', () => resolve(false))
    })
    if (ok) return true
    await sleep(150)
  }
  throw new Error(`nada escuchando en el puerto ${port} tras ${timeoutMs} ms`)
}

const procs = []
const dirs = []

function track (child, name) {
  procs.push({ child, name })
  return child
}

export function tmpDir (prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-' + prefix + '-'))
  dirs.push(d)
  return d
}

/** Levanta el proxy local. Devuelve `{ url, port }`. */
export async function startProxy ({ log = () => {} } = {}) {
  const port = await freePort()
  const child = track(spawn(process.execPath, ['server.js'], {
    cwd: PROXY_DIR,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  }), 'proxy')
  child.stdout.on('data', (b) => log('[proxy] ' + String(b).trim()))
  child.stderr.on('data', (b) => log('[proxy!] ' + String(b).trim()))
  await waitPort(port)
  return { url: `ws://localhost:${port}`, port }
}

/**
 * Levanta una bóveda (el daemon) con datos en un directorio temporal, apuntando al proxy
 * local. Devuelve helpers para hablarle por el mismo canal que usa la CLI: archivos de
 * petición + señales (así el smoke ejercita el camino real, no una API interna).
 */
export async function startVault ({ proxyUrl, name = 'vault', log = () => {} } = {}) {
  const dir = tmpDir(name)
  const child = track(spawn(process.execPath, ['bin/dotrino-vaultd.js'], {
    cwd: VAULT_DIR,
    env: { ...process.env, DOTRINO_VAULT_DIR: dir, PROXY_URL: proxyUrl },
    stdio: ['ignore', 'pipe', 'pipe']
  }), name)
  const lines = []
  child.stdout.on('data', (b) => { lines.push(String(b)); log(`[${name}] ` + String(b).trim()) })
  child.stderr.on('data', (b) => { lines.push(String(b)); log(`[${name}!] ` + String(b).trim()) })

  const stateFile = path.join(dir, 'state.json')
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
  const until = Date.now() + 20000
  let state = null
  while (Date.now() < until) {
    state = readJson(stateFile)
    if (state?.iss) break
    await sleep(200)
  }
  if (!state?.iss) throw new Error(`la bóveda ${name} no arrancó:\n` + lines.join(''))

  const writeReq = (file, obj) => fs.writeFileSync(path.join(dir, file), JSON.stringify(obj), { mode: 0o600 })
  const signal = (sig) => process.kill(child.pid, sig)

  return {
    dir, pid: child.pid, iss: state.iss, state,
    /**
     * `dotrino-vault pair` → devuelve el QR. Con `service` es `pair --service <ns>`: el cert
     * sale limitado a `vault:secrets:<ns>` y en el acta entra como SERVICIO con ese CN.
     */
    async pair ({ service, label } = {}) {
      try { fs.rmSync(path.join(dir, 'pair.json'), { force: true }) } catch (_) {}
      writeReq('pair-request.json', { ...(label ? { label } : {}), ...(service ? { service } : {}) })
      signal('SIGUSR1')
      const t = Date.now() + 8000
      while (Date.now() < t) {
        const p = readJson(path.join(dir, 'pair.json'))
        if (p?.qr) return p.qr
        await sleep(120)
      }
      throw new Error('la bóveda no publicó el emparejamiento')
    },
    /** Espera a que un dispositivo pida enrolarse y devuelve su deviceId. */
    async waitPending (timeoutMs = 15000) {
      const t = Date.now() + timeoutMs
      while (Date.now() < t) {
        const p = readJson(path.join(dir, 'pending-enroll.json'))
        if (p?.deviceId) return p.deviceId
        await sleep(150)
      }
      throw new Error('ningún dispositivo pidió enrolarse')
    },
    /** `dotrino-vault approve <código>`. */
    approve (code) { writeReq('approve-request.json', { code: String(code) }); signal('SIGUSR2') },
    /** `dotrino-vault reject <deviceId>`. */
    reject (deviceId) { writeReq('reject-request.json', { deviceId }); signal('SIGUSR2') },
    /** `dotrino-vault revoke <nonce>` — retira UN certificado (el aparato sigue en el acta). */
    revoke (nonce) { writeReq('revoke-request.json', { nonce }); signal('SIGUSR2') },
    /**
     * QUITA EL APARATO entero (por su llave): sale del acta y se le retiran todos sus
     * papeles. Es lo que hacen la TUI y la consola; `revoke(nonce)` retira un papel y deja
     * al miembro dentro, que es otra cosa.
     */
    removeDevice (sub) { writeReq('revoke-request.json', { sub }); signal('SIGUSR2') },
    /** `dotrino-vault members` → el acta tal y como la ve la CLI. */
    async members (timeoutMs = 8000) {
      const f = path.join(dir, 'acta.json')
      try { fs.rmSync(f, { force: true }) } catch (_) {}
      writeReq('dump-request.json', {})
      signal('SIGUSR2')
      const t = Date.now() + timeoutMs
      while (Date.now() < t) {
        const d = readJson(f)
        if (d?.at) return d
        await sleep(150)
      }
      throw new Error('la bóveda no volcó su acta')
    },
    /** `dotrino-vault caps <ID> …` → cambia permisos de un miembro. */
    async caps (pub, caps) {
      writeReq('caps-request.json', { pub, caps })
      signal('SIGUSR2')
      await sleep(600)
    },
    /** `dotrino-vault devices` → volcado de delegaciones. */
    async devices (timeoutMs = 8000) {
      try { fs.rmSync(path.join(dir, 'devices.json'), { force: true }) } catch (_) {}
      writeReq('dump-request.json', {})
      signal('SIGUSR2')
      const t = Date.now() + timeoutMs
      while (Date.now() < t) {
        const d = readJson(path.join(dir, 'devices.json'))
        if (d?.at) return d
        await sleep(150)
      }
      throw new Error('la bóveda no volcó sus dispositivos')
    },
    /**
     * El acta que la bóveda guarda en su disco. El archivo va CIFRADO EN REPOSO y ligado a
     * esta máquina, así que se descifra con el mismo módulo del vault — que es exactamente
     * lo que puede hacer quien esté sentado en esta máquina, y nadie más.
     */
    acta () {
      const pdir = path.join(dir, 'p', fs.readdirSync(path.join(dir, 'p'))[0])
      const raw = fs.readFileSync(path.join(pdir, 'identity.json'), 'utf8')
      const id = JSON.parse(atRest.isEncrypted(raw) ? atRest.decryptText(raw, atRest.machineKey(pdir)) : raw)
      const key = Object.keys(id || {}).find((k) => k.endsWith('.acta'))
      return key ? JSON.parse(id[key]) : null
    },
    log: () => lines.join('')
  }
}

/**
 * Servidor estático mínimo, para servir en local la consola y el iframe de identidad y
 * poder probarlos con un navegador de verdad sin salir de la máquina. Sin dependencias:
 * son cuatro tipos de archivo y una regla de respaldo para las rutas de la SPA.
 */
export async function servirEstatico (raiz, { spa = false } = {}) {
  const http = await import('node:http')
  const TIPOS = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json'
  }
  const port = await freePort()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let f = path.join(raiz, decodeURIComponent(url.pathname))
    if (!f.startsWith(raiz)) { res.writeHead(403).end(); return }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html')
    if (!fs.existsSync(f) && spa) f = path.join(raiz, 'index.html')
    if (!fs.existsSync(f)) { res.writeHead(404).end('no está'); return }
    res.writeHead(200, { 'content-type': TIPOS[path.extname(f)] || 'application/octet-stream' })
    fs.createReadStream(f).pipe(res)
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  servidores.push(server)
  return { url: `http://127.0.0.1:${port}`, port, server }
}

const servidores = []

/** Mata todo lo levantado y borra los directorios temporales. */
export async function teardown () {
  for (const { child } of procs) { try { child.kill('SIGTERM') } catch (_) {} }
  await sleep(400)
  for (const { child } of procs) { try { child.kill('SIGKILL') } catch (_) {} }
  procs.length = 0
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} }
  dirs.length = 0
  for (const s of servidores.splice(0)) { try { s.close() } catch (_) {} }
}

// ----- runner mínimo (sin dependencias: esto tiene que correr en cualquier lado) -----

const casos = []
export const escenario = (nombre, fn) => casos.push({ nombre, fn })

export async function correr () {
  let ok = 0; const fallos = []
  for (const c of casos) {
    const t0 = Date.now()
    try {
      await c.fn()
      ok++
      console.log(`  ✔ ${c.nombre} (${Date.now() - t0} ms)`)
    } catch (e) {
      fallos.push({ nombre: c.nombre, error: e })
      console.log(`  ✖ ${c.nombre}\n      ${e?.message || e}`)
    }
  }
  console.log(`\n  ${ok}/${casos.length} escenarios`)
  if (fallos.length) {
    console.log('\nDetalle:')
    for (const f of fallos) console.log(`\n[${f.nombre}]\n`, f.error?.stack || f.error)
  }
  return fallos.length === 0
}
