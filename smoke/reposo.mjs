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
 *   node smoke/reposo.mjs [--verbose]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { escenario, correr, startProxy, startVault, teardown } from './lib/harness.js'
import * as atRest from '../../dotrino-vault/src/atrest.js'
const { atRestFor } = atRest

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MAGIA = 'DOTRINO-ATREST-v1.'
const CLAVE = 'UNA-CLAVE-QUE-NO-DEBE-VERSE-JAMAS-8f3a1c'
const FRASE = 'contrasena-de-prueba-9271'

/**
 * Lo que NO va cifrado, y por qué cada uno. La lista es corta a propósito: si algo se
 * suma aquí sin una razón, este escenario deja de servir para nada.
 */
const EXCEPCIONES = new Map([
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

/** Todos los archivos del directorio de datos, con su ruta relativa. */
function archivosDe (dir) {
  const out = []
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(p, r)
      else out.push({ rel, nombre: e.name, ruta: p })
    }
  }
  walk(dir)
  return out
}

escenario('la bóveda trabaja: emparejar, contraseña y una variable guardada', async () => {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'reposo', log })

  // Una contraseña de perfil: es lo que viaja por el canal local y lo que no debe quedar.
  await vault.profile('password', { password: FRASE })
  // Y una variable, que es el otro valor sensible que cruza ese canal.
  await vault.setSecret('proxy', 'TOKEN', CLAVE)
  // Un cajón llamado como el `cn` de la llave de comunicación: la trampa de la pregunta 2.
  await vault.setSecret('vault', 'TOKEN', CLAVE)
  await sleep(800)

  const acta = await vault.members()
  assert.ok(acta?.members, 'la bóveda vuelca su acta')
  log(`  miembros: ${acta.members.length}`)
})

escenario('ningún archivo del disco queda en claro', async () => {
  const enClaro = []
  for (const f of archivosDe(vault.dir)) {
    if (EXCEPCIONES.has(f.nombre)) continue
    if (f.nombre.endsWith('.tmp')) continue
    const texto = fs.readFileSync(f.ruta, 'utf8')
    if (!texto.trim()) continue
    // La bitácora va cifrada LÍNEA A LÍNEA (se escribe añadiendo), así que se mira la
    // primera línea, no el archivo entero.
    const cabeza = f.nombre === 'activity.log' ? (texto.split('\n')[0] || '') : texto
    if (!cabeza.startsWith(MAGIA)) enClaro.push(f.rel ? f.rel + '/' + f.nombre : f.nombre)
  }
  assert.deepEqual(enClaro, [], 'archivos en claro que no están justificados: ' + enClaro.join(', '))
})

escenario('la única marca en claro (`key.json`) no lleva más que una pública', async () => {
  // La excepción se justifica sola solo mientras el archivo siga siendo lo que dice ser.
  // Si un día se le cuelga un campo más, esto salta y hay que volver a decidirlo.
  for (const f of archivosDe(vault.dir).filter((x) => x.nombre === 'key.json')) {
    const o = JSON.parse(fs.readFileSync(f.ruta, 'utf8'))
    assert.deepEqual(Object.keys(o).sort(), ['at', 'pub'], `${f.rel}/key.json creció: ` + Object.keys(o).join(', '))
    assert.ok(/"key_ops":\["verify"\]/.test(o.pub), 'es una pública de verificación, no un par')
  }
})

escenario('la bitácora no la puede leer otro usuario de la máquina (0600)', async () => {
  const laxos = archivosDe(vault.dir)
    .filter((f) => (fs.statSync(f.ruta).mode & 0o077) !== 0)
    .map((f) => `${f.rel ? f.rel + '/' : ''}${f.nombre} (${(fs.statSync(f.ruta).mode & 0o777).toString(8)})`)
  assert.deepEqual(laxos, [], 'archivos legibles por otros: ' + laxos.join(', '))
})

escenario('ni el valor ni la contraseña aparecen en ningún byte del disco', async () => {
  const culpables = []
  for (const f of archivosDe(vault.dir)) {
    const bytes = fs.readFileSync(f.ruta)
    for (const [que, aguja] of [['el valor', CLAVE], ['la contraseña', FRASE]]) {
      if (bytes.includes(aguja)) culpables.push(`${que} en ${f.rel ? f.rel + '/' : ''}${f.nombre}`)
    }
  }
  assert.deepEqual(culpables, [], culpables.join(' · '))
})

escenario('ninguna llave privada anda suelta (`"d":` de un JWK)', async () => {
  const culpables = []
  for (const f of archivosDe(vault.dir)) {
    if (f.nombre === 'atrest.salt' || f.nombre === 'atrest.machine') continue
    const texto = fs.readFileSync(f.ruta, 'latin1')
    // Un JWK privado se reconoce por su `d`. Con el archivo cifrado no puede aparecer.
    if (/"d"\s*:\s*"/.test(texto) || /privateJwk/.test(texto)) {
      culpables.push(`${f.rel ? f.rel + '/' : ''}${f.nombre}`)
    }
  }
  assert.deepEqual(culpables, [], 'llave privada en claro: ' + culpables.join(', '))
})

escenario('la llave de comunicación está en el acta con `cn: vault`, `sign` y SIN llave de cifrado', async () => {
  const acta = await vault.members()
  const comm = (acta.members || []).find((m) => m.cn === 'vault')
  assert.ok(comm, 'la bóveda metió su llave de comunicación en su propia acta')
  assert.deepEqual(comm.caps, ['sign'], 'solo firma: ni lee, ni guarda, ni sella')
  // ESTO es la garantía de fondo: sin `encPub` no hay a dónde envolver. Un sobre se cierra
  // contra una pública de CIFRADO, y esta llave no tiene ninguna — es un par de FIRMA.
  assert.equal(comm.encPub ?? null, null, 'no tiene llave de cifrado: no hay a dónde envolverle nada')
})

escenario('un cajón llamado `vault` NO le envuelve nada a la llave de comunicación', async () => {
  const acta = await vault.members()
  const comm = (acta.members || []).find((m) => m.cn === 'vault')

  // Se abre el almacén de secretos con el mismo códec de la máquina y se miran TODAS las
  // envolturas de todos los cajones, una por una.
  const pdir = path.join(vault.dir, 'p', fs.readdirSync(path.join(vault.dir, 'p'))[0])
  const crudo = fs.readFileSync(path.join(pdir, 'secrets.json'), 'utf8')
  const store = JSON.parse(atRest.decryptText(crudo, atRest.machineKey(pdir)))

  const cajones = { ...(store.ns || {}), ...(store.dev || {}) }
  assert.ok(Object.keys(cajones).length, 'hay cajones que mirar')

  const destinatarios = new Set()
  for (const cajon of Object.values(cajones)) {
    for (const gen of Object.values(cajon.keyring || {})) {
      for (const pub of Object.keys(gen?.wraps || gen || {})) destinatarios.add(pub)
    }
  }
  log(`  cajones: ${Object.keys(cajones).join(', ')} · destinatarios: ${destinatarios.size}`)
  assert.ok(!destinatarios.has(comm.pub),
    'la llave de comunicación recibió una envoltura: con ella se leerían secretos con el perfil CERRADO')
})

/**
 * LO QUE YA ESTABA ESCRITO también se sella. Cifrar solo lo nuevo deja el disco en claro
 * durante meses: la bitácora de una bóveda que lleva un año andando no se reescribe sola.
 */
escenario('una bitácora vieja EN CLARO queda sellada al arrancar', async () => {
  const pdir = path.join(vault.dir, 'p', fs.readdirSync(path.join(vault.dir, 'p'))[0])
  const f = path.join(pdir, 'activity.log')

  // Se le mete una línea como las de antes de 0.89: JSON pelado y el archivo 0664.
  const vieja = JSON.stringify({ ts: Date.now(), op: 'enroll', device: 'AA00-BB11' })
  fs.appendFileSync(f, vieja + '\n')
  fs.chmodSync(f, 0o664)

  // Y se reinicia la bóveda, que es cuando toca convertirla.
  await vault.restart()

  const lineas = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const enClaro = lineas.filter((l) => !l.startsWith(MAGIA))
  assert.deepEqual(enClaro, [], 'quedaron líneas en claro: ' + enClaro.length)
  assert.equal(fs.statSync(f).mode & 0o077, 0, 'y ya no la puede leer otro usuario')

  // Y se sigue pudiendo leer: convertir no puede ser perder.
  const atRest = atRestFor(pdir)
  const abiertas = lineas.map((l) => JSON.parse(atRest.decrypt(l)))
  assert.ok(abiertas.some((e) => e.device === 'AA00-BB11'), 'la línea vieja sigue ahí')
})

const ok = await correr()
await teardown()
process.exit(ok ? 0 : 1)
