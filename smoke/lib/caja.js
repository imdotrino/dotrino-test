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
const IMAGEN = process.env.SMOKE_IMAGE || 'node:22-bookworm-slim'

const cajas = []

/** ¿Hay Docker usable? (existe y su daemon responde) */
export function dockerDisponible () {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

export function elegirMotor () {
  const forzado = process.env.SMOKE_BACKEND
  if (forzado) return forzado
  return dockerDisponible() ? 'docker' : 'local'
}

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })

/**
 * Crea una instancia efímera.
 * @returns {{nombre, motor, exec, lanzar, escribir, leer, destruir}}
 */
export function crearCaja (nombre, { motor = elegirMotor() } = {}) {
  const caja = motor === 'docker' ? cajaDocker(nombre) : cajaLocal(nombre)
  cajas.push(caja)
  return caja
}

function cajaDocker (nombre) {
  const id = `smoke-${nombre}-${Date.now().toString(36)}`
  // `--network host` para llegar al proxy del host sin inventar DNS; el ecosistema va
  // montado de solo lectura, así que un dispositivo no puede tocar el código ni los datos
  // de otro; `/data` es su disco, y muere con el contenedor.
  const r = sh('docker', ['run', '-d', '--rm', '--network', 'host',
    '-v', `${ECO}:/eco:ro`, '--tmpfs', '/data:exec,mode=0700',
    '-w', '/eco', '--name', id, IMAGEN, 'sleep', 'infinity'])
  if (r.status !== 0) throw new Error(`no se pudo crear la caja ${nombre}: ${r.stderr || r.stdout}`)

  return {
    nombre, motor: 'docker', id, home: '/data',
    /** Ejecuta y espera. Devuelve `{ status, stdout, stderr }`. */
    exec (cmd, { env = {} } = {}) {
      const e = Object.entries({ HOME: '/data', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      return sh('docker', ['exec', ...e, id, 'sh', '-lc', cmd])
    },
    /** Lanza algo en segundo plano y llama a `onLinea` por cada línea de salida. */
    lanzar (cmd, { env = {}, onLinea = () => {} } = {}) {
      const e = Object.entries({ HOME: '/data', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      const p = spawn('docker', ['exec', ...e, id, 'sh', '-lc', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
      let buf = ''
      const alimentar = (b) => {
        buf += String(b)
        let i
        while ((i = buf.indexOf('\n')) >= 0) { onLinea(buf.slice(0, i)); buf = buf.slice(i + 1) }
      }
      p.stdout.on('data', alimentar)
      p.stderr.on('data', alimentar)
      return p
    },
    /**
     * Escribe un archivo dentro de la caja. Se hace por `stdin` y no con `docker cp` porque
     * el disco de la caja es un tmpfs y `cp` no siempre aterriza ahí.
     */
    escribir (rutaEnCaja, contenido) {
      const dir = path.posix.dirname(rutaEnCaja)
      const r = spawnSync('docker', ['exec', '-i', id, 'sh', '-lc', `mkdir -p ${dir} && cat > ${rutaEnCaja}`],
        { input: contenido, encoding: 'utf8' })
      if (r.status !== 0) throw new Error('no se pudo escribir en la caja: ' + (r.stderr || ''))
    },
    leer (rutaEnCaja) {
      const r = sh('docker', ['exec', id, 'cat', rutaEnCaja])
      return r.status === 0 ? r.stdout : null
    },
    destruir () { sh('docker', ['rm', '-f', id], { stdio: 'ignore' }) }
  }
}

function cajaLocal (nombre) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `smoke-${nombre}-`))
  const envBase = { HOME: home, PATH: process.env.PATH }
  // Los guiones están escritos con las rutas de la caja (`/eco` y `/data`) para que sean
  // los mismos en los dos motores. Aquí se traducen a rutas reales del host.
  const tr = (t) => String(t).split('/eco').join(ECO).split('/data').join(home)
  const trEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, tr(v)]))
  return {
    nombre, motor: 'local', id: home, home,
    exec (cmd, { env = {} } = {}) {
      return sh('sh', ['-lc', tr(cmd)], { cwd: ECO, env: { ...envBase, ...trEnv(env) } })
    },
    lanzar (cmd, { env = {}, onLinea = () => {} } = {}) {
      const p = spawn('sh', ['-lc', tr(cmd)], { cwd: ECO, env: { ...envBase, ...trEnv(env) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let buf = ''
      const alimentar = (b) => {
        buf += String(b)
        let i
        while ((i = buf.indexOf('\n')) >= 0) { onLinea(buf.slice(0, i)); buf = buf.slice(i + 1) }
      }
      p.stdout.on('data', alimentar)
      p.stderr.on('data', alimentar)
      return p
    },
    escribir (ruta, contenido) {
      const dest = tr(ruta)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, tr(contenido))
    },
    leer (ruta) {
      try { return fs.readFileSync(tr(ruta), 'utf8') } catch { return null }
    },
    destruir () { try { fs.rmSync(home, { recursive: true, force: true }) } catch (_) {} }
  }
}

/** Destruye todas las cajas creadas. */
export function destruirCajas () {
  for (const c of cajas.splice(0)) { try { c.destruir() } catch (_) {} }
}
