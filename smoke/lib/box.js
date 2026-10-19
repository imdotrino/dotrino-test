/**
 * caja.js — INSTANCIAS EFÍMERAS para el smoke: cada dispositivo en su propia caja, con su
 * propio disco y su propia identidad, y todo se destruye al terminar.
 *
 * Por qué no basta con directorios temporales: un dispositivo de verdad es una máquina
 * aparte. Metiéndolos en cajas separadas se prueba lo que de verdad importa —que cada uno
 * genera SU llave, que ninguno ve el disco de otro y que el emparejamiento funciona entre
 * máquinas— y no un montón de identidades conviviendo en el mismo proceso.
 *
 * Dos motores, misma API:
 *   · `docker` (el bueno): contenedor por dispositivo, red del host para llegar al proxy,
 *     el ecosistema montado en `/eco` **solo lectura** y disco propio en `/data`.
 *   · `local` (respaldo): un proceso con su `HOME` propio en un directorio temporal, para
 *     cuando no hay Docker (CI mínimo). Aísla los datos, no el sistema de archivos.
 *
 * El motor se elige solo, o a mano con `SMOKE_BACKEND=docker|local`.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ECO = path.resolve(new URL('../../..', import.meta.url).pathname)
const IMAGE = process.env.SMOKE_IMAGE || 'node:22-bookworm-slim'

const boxes = []

/** ¿Hay Docker usable? (existe y su daemon responde) */
export function dockerAvailable () {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

export function pickEngine () {
  const forced = process.env.SMOKE_BACKEND
  if (forced) return forced
  return dockerAvailable() ? 'docker' : 'local'
}

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })

/**
 * Crea una instancia efímera.
 * @returns {{name, engine, id, home, exec, launch, write, read, destroy}}
 */
export function createBox (name, { engine = pickEngine() } = {}) {
  const box = engine === 'docker' ? dockerBox(name) : localBox(name)
  boxes.push(box)
  return box
}

function dockerBox (name) {
  const id = `smoke-${name}-${Date.now().toString(36)}`
  // `--network host` para llegar al proxy del host sin inventar DNS; el ecosistema va
  // montado de solo lectura, así que un dispositivo no puede tocar el código ni los datos
  // de otro; `/data` es su disco, y muere con el contenedor.
  const r = sh('docker', ['run', '-d', '--rm', '--network', 'host',
    '-v', `${ECO}:/eco:ro`, '--tmpfs', '/data:exec,mode=0700',
    '-w', '/eco', '--name', id, IMAGE, 'sleep', 'infinity'])
  if (r.status !== 0) throw new Error(`could not create box ${name}: ${r.stderr || r.stdout}`)

  return {
    name, engine: 'docker', id, home: '/data',
    /** Ejecuta y espera. Devuelve `{ status, stdout, stderr }`. */
    exec (cmd, { env = {} } = {}) {
      const e = Object.entries({ HOME: '/data', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      return sh('docker', ['exec', ...e, id, 'sh', '-lc', cmd])
    },
    /** Lanza algo en segundo plano y llama a `onLinea` por cada línea de salida. */
    launch (cmd, { env = {}, onLine = () => {} } = {}) {
      const e = Object.entries({ HOME: '/data', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      const p = spawn('docker', ['exec', ...e, id, 'sh', '-lc', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
      let buf = ''
      const feed = (b) => {
        buf += String(b)
        let i
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
      }
      p.stdout.on('data', feed)
      p.stderr.on('data', feed)
      return p
    },
    /**
     * Escribe un archivo dentro de la caja. Se hace por `stdin` y no con `docker cp` porque
     * el disco de la caja es un tmpfs y `cp` no siempre aterriza ahí.
     */
    write (boxPath, content) {
      const dir = path.posix.dirname(boxPath)
      const r = spawnSync('docker', ['exec', '-i', id, 'sh', '-lc', `mkdir -p ${dir} && cat > ${boxPath}`],
        { input: content, encoding: 'utf8' })
      if (r.status !== 0) throw new Error('could not write into the box: ' + (r.stderr || ''))
    },
    read (boxPath) {
      const r = sh('docker', ['exec', id, 'cat', boxPath])
      return r.status === 0 ? r.stdout : null
    },
    destroy () { sh('docker', ['rm', '-f', id], { stdio: 'ignore' }) }
  }
}

function localBox (name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `smoke-${name}-`))
  const envBase = { HOME: home, PATH: process.env.PATH }
  // Los guiones están escritos con las rutas de la caja (`/eco` y `/data`) para que sean
  // los mismos en los dos motores. Aquí se traducen a rutas reales del host.
  const tr = (t) => String(t).split('/eco').join(ECO).split('/data').join(home)
  const trEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, tr(v)]))
  return {
    name, engine: 'local', id: home, home,
    exec (cmd, { env = {} } = {}) {
      return sh('sh', ['-lc', tr(cmd)], { cwd: ECO, env: { ...envBase, ...trEnv(env) } })
    },
    launch (cmd, { env = {}, onLine = () => {} } = {}) {
      const p = spawn('sh', ['-lc', tr(cmd)], { cwd: ECO, env: { ...envBase, ...trEnv(env) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let buf = ''
      const feed = (b) => {
        buf += String(b)
        let i
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
      }
      p.stdout.on('data', feed)
      p.stderr.on('data', feed)
      return p
    },
    write (filePath, content) {
      const dest = tr(filePath)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, tr(content))
    },
    read (filePath) {
      try { return fs.readFileSync(tr(filePath), 'utf8') } catch { return null }
    },
    destroy () { try { fs.rmSync(home, { recursive: true, force: true }) } catch (_) {} }
  }
}

/** Destruye todas las cajas creadas. */
export function destroyBoxes () {
  for (const c of boxes.splice(0)) { try { c.destroy() } catch (_) {} }
}
