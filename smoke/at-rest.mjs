/**
 * NADA EN CLARO EN EL DISCO — y la LLAVE DE COMUNICACIÓN no recibe sobres.
 *
 * Dos preguntas del dueño (2026-09-02), las dos sobre lo mismo: qué queda escrito en el
 * disco de una bóveda y quién puede abrirlo.
 *
 * **1. Nada en claro.** Hasta 0.89 el vault cifraba en reposo sus almacenes (identidad,
 * contenido, hilos, secretos) y dejaba fuera tres cosas que nadie miraba:
 *
 *   · el CANAL LOCAL con la CLI (`state.json`, `acta.json`, `secret-request.json`…), por
 *     donde pasan la CONTRASEÑA del perfil y el VALOR de lo que se guarda
 *   · `transport.json`, con la PRIVADA del par de transporte de `@dotrino/proxy-client`
 *   · `activity.log`, el mapa entero de la cuenta — y encima creado 0664, legible por
 *     cualquier usuario de la máquina
 *
 * Este escenario levanta una bóveda de verdad, la hace trabajar (emparejar, aprobar,
 * guardar una variable) y después LE MIRA EL DISCO entero: cada archivo o va cifrado, o
 * está en una lista corta de excepciones que se justifican una por una. Y de postre busca
 * el valor y la contraseña por todos los bytes del directorio.
 *
 * **2. La llave de comunicación no recibe sobres.** Es la que firma cuando la bóveda está
 * CERRADA (`commKey.js`), así que un sobre dirigido a ella sería una forma de leer
 * secretos sin abrir el perfil. No los recibe, y aquí se comprueba que no es un accidente:
 * se crea un cajón llamado `vault` —que es su `cn`, y un nombre de cajón perfectamente
 * válido— y se afirma que su llave no aparece en ninguna envoltura.
 *
 *   node smoke/at-rest.mjs [--verbose]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { scenario, runScenarios, startProxy, startVault, teardown } from './lib/harness.js'
import * as atRest from '../../dotrino-vault/src/atrest.js'
import { sleep } from './lib/wait.js'
const { atRestFor } = atRest

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const MAGIC = 'DOTRINO-ATREST-v1.'
const SECRET = 'UNA-SECRET-QUE-NO-DEBE-VERSE-JAMAS-8f3a1c'
const PASSPHRASE = 'contrasena-de-prueba-9271'

/**
 * Lo que NO va cifrado, y por qué cada uno. La lista es corta a propósito: si algo se
 * suma aquí sin una razón, este escenario deja de servir para nada.
 */
const ALLOWED = new Map([
  // Bytes aleatorios: son el salt DEL cifrado, no pueden ir cifrados con él.
  ['atrest.salt', 'el salt del propio cifrado'],
  // Un SHA-256 del material de la máquina. Sirve para AVISAR de que estos datos los
  // escribió otra máquina; no abre nada y no se puede volver atrás.
  ['atrest.machine', 'huella para detectar un cambio de máquina'],
  // El envoltorio de la DEK cuando la clave la guarda un KMS. Sin el KMS no vale nada.
  ['atrest.kek', 'la DEK envuelta por el proveedor externo'],
  ['atrest.json', 'qué proveedor cifra (no la clave)'],
  // El candado entre procesos: pid, host y latido. Tiene que leerse ANTES de tener clave.
  ['vault.lock', 'el candado; se lee antes de poder descifrar nada'],
  // El idioma de la interfaz.
  ['prefs.json', 'preferencias de la interfaz, sin datos de nadie'],
  // De quién es esta carpeta. Es una PÚBLICA, y tiene que leerse ANTES de tener con qué
  // descifrar: es lo que evita arrancar con la identidad de otro (`keyowner.js`). Se
  // comprueba abajo que no lleve nada más que eso.
  ['key.json', 'la pública que dice de quién es la carpeta; se lee antes de poder descifrar']
])

let proxy = null
let vault = null

/** Todos los archivos del directorio de datos, con su path_ relativa. */
function filesIn (dir) {
  const out = []
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(p, r)
      else out.push({ rel, name: e.name, path_: p })
    }
  }
  walk(dir)
  return out
}

scenario('the vault works: pairing, password and a stored variable', async () => {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'at-rest', log })

  // Una contraseña de perfil: es lo que viaja por el canal local y lo que no debe quedar.
  await vault.profile('password', { password: PASSPHRASE })
  // Y una variable, que es el otro valor sensible que cruza ese canal.
  await vault.setSecret('proxy', 'TOKEN', SECRET)
  // Un cajón llamado como el `cn` de la llave de comunicación: la trampa de la pregunta 2.
  await vault.setSecret('vault', 'TOKEN', SECRET)
  await sleep(800)

  const record = await vault.members()
  assert.ok(record?.members, 'the vault dumps its record')
  log(`  members: ${record.members.length}`)
})

scenario('no file on disk is left in clear', async () => {
  const plaintext = []
  for (const f of filesIn(vault.dir)) {
    if (ALLOWED.has(f.name)) continue
    if (f.name.endsWith('.tmp')) continue
    const text = fs.readFileSync(f.path_, 'utf8')
    if (!text.trim()) continue
    // La bitácora va cifrada LÍNEA A LÍNEA (se escribe añadiendo), así que se mira la
    // primera línea, no el archivo entero.
    const head = f.name === 'activity.log' ? (text.split('\n')[0] || '') : text
    if (!head.startsWith(MAGIC)) plaintext.push(f.rel ? f.rel + '/' + f.name : f.name)
  }
  assert.deepEqual(plaintext, [], 'unjustified plaintext files: ' + plaintext.join(', '))
})

scenario('the only plaintext marker (`key.json`) holds nothing but a public key', async () => {
  // La excepción se justifica sola solo mientras el archivo siga siendo lo que dice ser.
  // Si un día se le cuelga un campo más, esto salta y hay que volver a decidirlo.
  for (const f of filesIn(vault.dir).filter((x) => x.name === 'key.json')) {
    const o = JSON.parse(fs.readFileSync(f.path_, 'utf8'))
    assert.deepEqual(Object.keys(o).sort(), ['at', 'pub'], `${f.rel}/key.json grew: ` + Object.keys(o).join(', '))
    assert.ok(/"key_ops":\["verify"\]/.test(o.pub), 'it is a verification public key, not a pair')
  }
})

scenario('no other user on the machine can read the log (0600)', async () => {
  const worldReadable = filesIn(vault.dir)
    .filter((f) => (fs.statSync(f.path_).mode & 0o077) !== 0)
    .map((f) => `${f.rel ? f.rel + '/' : ''}${f.name} (${(fs.statSync(f.path_).mode & 0o777).toString(8)})`)
  assert.deepEqual(worldReadable, [], 'files readable by others: ' + worldReadable.join(', '))
})

scenario('neither the value nor the password appears in any byte on disk', async () => {
  const offenders = []
  for (const f of filesIn(vault.dir)) {
    const bytes = fs.readFileSync(f.path_)
    for (const [what, needle] of [['the value', SECRET], ['the password', PASSPHRASE]]) {
      if (bytes.includes(needle)) offenders.push(`${what} in ${f.rel ? f.rel + '/' : ''}${f.name}`)
    }
  }
  assert.deepEqual(offenders, [], offenders.join(' · '))
})

scenario('no private key is lying around (a JWK `"d":`)', async () => {
  const offenders = []
  for (const f of filesIn(vault.dir)) {
    if (f.name === 'atrest.salt' || f.name === 'atrest.machine') continue
    const text = fs.readFileSync(f.path_, 'latin1')
    // Un JWK privado se reconoce por su `d`. Con el archivo cifrado no puede aparecer.
    if (/"d"\s*:\s*"/.test(text) || /privateJwk/.test(text)) {
      offenders.push(`${f.rel ? f.rel + '/' : ''}${f.name}`)
    }
  }
  assert.deepEqual(offenders, [], 'private key in clear: ' + offenders.join(', '))
})

scenario('the communication key is in the record with `cn: vault`, `sign` and NO encryption key', async () => {
  const record = await vault.members()
  const comm = (record.members || []).find((m) => m.cn === 'vault')
  assert.ok(comm, 'the vault put its communication key in its own record')
  assert.deepEqual(comm.caps, ['sign'], 'signs only: does not read, store or seal')
  // ESTO es la garantía de fondo: sin `encPub` no hay a dónde envolver. Un sobre se cierra
  // contra una pública de CIFRADO, y esta llave no tiene ninguna — es un par de FIRMA.
  assert.equal(comm.encPub ?? null, null, 'it has no encryption key: there is nothing to wrap to')
})

scenario('a drawer named `vault` wraps NOTHING for the communication key', async () => {
  const record = await vault.members()
  const comm = (record.members || []).find((m) => m.cn === 'vault')

  // Se abre el almacén de secretos con el mismo códec de la máquina y se miran TODAS las
  // envolturas de todos los cajones, uno por uno.
  const pdir = path.join(vault.dir, 'p', fs.readdirSync(path.join(vault.dir, 'p'))[0])
  const raw = fs.readFileSync(path.join(pdir, 'secrets.json'), 'utf8')
  const store = JSON.parse(atRest.decryptText(raw, atRest.machineKey(pdir)))

  const drawers = { ...(store.ns || {}), ...(store.dev || {}) }
  assert.ok(Object.keys(drawers).length, 'there are drawers to inspect')

  const recipients = new Set()
  for (const drawer of Object.values(drawers)) {
    for (const gen of Object.values(drawer.keyring || {})) {
      for (const pub of Object.keys(gen?.wraps || gen || {})) recipients.add(pub)
    }
  }
  log(`  drawers: ${Object.keys(drawers).join(', ')} · recipients: ${recipients.size}`)
  assert.ok(!recipients.has(comm.pub),
    'the communication key received a wrap: with it secrets could be read with the profile LOCKED')
})

/**
 * LO QUE YA ESTABA ESCRITO también se sella. Cifrar solo lo nuevo deja el disco en claro
 * durante meses: la bitácora de una bóveda que lleva un año andando no se reescribe sola.
 */
scenario('an old PLAINTEXT log gets sealed on startup', async () => {
  const pdir = path.join(vault.dir, 'p', fs.readdirSync(path.join(vault.dir, 'p'))[0])
  const f = path.join(pdir, 'activity.log')

  // Se le mete una línea como las de antes de 0.89: JSON pelado y el archivo 0664.
  const oldLine = JSON.stringify({ ts: Date.now(), op: 'enroll', device: 'AA00-BB11' })
  fs.appendFileSync(f, oldLine + '\n')
  fs.chmodSync(f, 0o664)

  // Y se reinicia la bóveda, que es cuando toca convertirla.
  await vault.restart()

  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const plaintext = lines.filter((l) => !l.startsWith(MAGIC))
  assert.deepEqual(plaintext, [], 'plaintext lines left: ' + plaintext.length)
  assert.equal(fs.statSync(f).mode & 0o077, 0, 'and no other user can read it anymore')

  // Y se sigue pudiendo leer: convertir no puede ser perder.
  const atRest = atRestFor(pdir)
  const opened = lines.map((l) => JSON.parse(atRest.decrypt(l)))
  assert.ok(opened.some((e) => e.device === 'AA00-BB11'), 'the old line is still there')
})

const ok = await runScenarios()
await teardown()
process.exit(ok ? 0 : 1)
