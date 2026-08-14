/**
 * SMOKE · EMPAREJAR y ADMINISTRAR **desde la TUI** de la bóveda.
 *
 * El resto de las suites hablan con la bóveda por su CLI (`--ctl pair` / `approve` /
 * `caps`). La TUI es código distinto —su propio canal (`vaultControl.js`), sus propias
 * pantallas y su propio estado— y era justo lo que no probaba nadie: los tres fallos del
 * 2026-08-13 (la contraseña que se volvía a pedir, «Cargando dispositivos…» eterno y el
 * código equivocado que decía «Dispositivo aprobado») vivían todos ahí.
 *
 * Aquí se pilota la TUI DE VERDAD: se abre en un terminal (pty), se le teclean las mismas
 * teclas que teclearía el dueño y se lee lo que sale en pantalla. Lo que se comprueba no es
 * el texto: es que el acta de la bóveda —el papel que dice de quién es el perfil— cambie
 * como corresponde a cada tecla.
 *
 *   node smoke/tui.mjs [--verbose]
 *
 * Necesita un pty, que Node no trae: se usa `script(1)` (util-linux, está en cualquier
 * Debian/Ubuntu y en la imagen del CI). Sin él, la suite se salta con un aviso claro en
 * vez de fallar por algo que no es del ecosistema.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { escenario, correr, startProxy, startVault, teardown, tmpDir, ROOT, VAULT_DIR } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// El cliente REAL de dispositivo: el aparato que se empareja no es una imitación.
const { enroll, requestSign } = await import(path.join(ROOT, 'dotrino-vault/src/client.js'))

let proxy = null
let vault = null
let tui = null

// ---------------------------------------------------------------------------
// El piloto: una TUI de verdad, en un terminal de verdad
// ---------------------------------------------------------------------------

/**
 * Abre la TUI en un pty y devuelve con qué manejarla.
 *
 * `script -qec` es lo que da el pty: sin él la TUI ve una tubería, no enciende el modo
 * crudo y no lee ni una tecla. El `stty` de dentro le pone tamaño al terminal (si no,
 * hereda 0×0 y la TUI dibuja «terminal muy pequeño»).
 */
function abrirTui ({ dir, lang = 'es', cols = 120, rows = 60 } = {}) {
  const cmd = `stty rows ${rows} cols ${cols} 2>/dev/null; exec node bin/dotrino-vault-tui.js`
  const p = spawn('script', ['-q', '-e', '-c', cmd, '/dev/null'], {
    cwd: VAULT_DIR,
    env: { ...process.env, DOTRINO_VAULT_DIR: dir, DOTRINO_LANG: lang, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buf = ''
  let desde = 0
  p.stdout.on('data', (b) => { buf += String(b) })
  p.stderr.on('data', (b) => { buf += String(b) })

  // La TUI dibuja posicionando el cursor al principio de cada fila, así que ESO es el
  // salto de línea; el resto de escapes (color, borrado) se tira.
  const limpiar = (s) => s
    .replace(/\x1b\[[0-9]+;1H/g, '\n')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')

  const api = {
    proceso: p,
    /** Todo lo dibujado desde la última tecla. */
    pantalla: () => limpiar(buf.slice(desde)),
    todo: () => limpiar(buf),
    /** Teclea. A partir de aquí, `pantalla()` y `esperar()` solo miran lo nuevo. */
    teclas (s) { desde = buf.length; p.stdin.write(s); return api },
    /** Espera a que lo dibujado tras la última tecla diga esto. Devuelve la pantalla. */
    async esperar (re, ms = 20000) {
      const hasta = Date.now() + ms
      while (Date.now() < hasta) {
        const v = api.pantalla()
        if (re.test(v)) return v
        await sleep(120)
      }
      const visto = api.pantalla().split('\n').filter((l) => l.trim()).slice(-12).join('\n')
      throw new Error(`la TUI nunca dijo ${re}\n--- lo último que dibujó ---\n${visto}\n---`)
    },
    /** ¿Llegó a decir esto? (sin fallar si no) */
    async dijo (re, ms = 4000) { try { await api.esperar(re, ms); return true } catch { return false } },
    cerrar () { try { p.stdin.write('q') } catch (_) {} ; setTimeout(() => { try { p.kill('SIGKILL') } catch (_) {} }, 800) }
  }
  return api
}

const leerJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

/**
 * El QR que la TUI acaba de abrir: se lee del MISMO archivo que ella está pintando, en vez
 * de rescatar el base64 de la pantalla (que el terminal recorta al ancho de la ventana).
 * `desdeMs` descarta el del escenario anterior.
 */
async function invitacionEnPantalla (dir, desdeMs) {
  const f = path.join(dir, 'pair.json')
  const hasta = Date.now() + 15000
  while (Date.now() < hasta) {
    const d = leerJson(f)
    if (d?.qr && (d.at || 0) >= desdeMs) return d.qr
    await sleep(150)
  }
  throw new Error('la TUI no llegó a abrir un emparejamiento')
}

/**
 * Deja la TUI en la pestaña Dispositivos venga de donde venga (del QR, de permisos, o de
 * la lista de bóvedas). Cada escenario empieza desde ahí: así uno que falle no arrastra a
 * los siguientes por dejar la pantalla en otro sitio.
 */
async function aDispositivos () {
  for (let i = 0; i < 5; i++) {
    tui.teclas('\x1b')
    await sleep(600)
    const p = tui.pantalla()
    if (/▐ Dispositivos/.test(p)) return
    if (/» Bóvedas/.test(p)) { tui.teclas('\r'); await tui.esperar(/▐ Dispositivos/); return }
  }
  throw new Error('no se pudo volver a Dispositivos')
}

/** Abre un emparejamiento desde Dispositivos y devuelve la invitación. */
async function abrirEmparejamiento () {
  await aDispositivos()
  const t0 = Date.now()
  tui.teclas('p')
  await tui.esperar(/A qué cuenta|Cuenta nueva|Esta bóveda/i)
  tui.teclas('\r') // «esta bóveda»
  await tui.esperar(/Cuenta que se comparte/)
  // Al final de esa pantalla, debajo del QR, es donde se avisa de quién se conectó. El QR
  // ocupa más que el terminal, así que se baja del todo — lo mismo que hace el dueño.
  tui.teclas('\x1b[F')
  await sleep(400)
  return invitacionEnPantalla(vault.dir, t0)
}

/** Un aparato de verdad que se enrola con esa invitación y enseña su código. */
async function aparato (qr, label) {
  let code = null
  const enrolado = enroll({ qr, label, dir: tmpDir('tui-' + label), onChallenge: (c) => { code = c.code } })
  enrolado.catch(() => {}) // el rechazo se mira donde toca; aquí no queremos un unhandled
  const hasta = Date.now() + 15000
  while (!code && Date.now() < hasta) await sleep(50)
  assert.ok(code, 'el aparato enseña un código de seis dígitos')
  return { code, enrolado }
}

const miembros = () => vault.acta()?.members || []
const miembroDe = (pub) => miembros().find((m) => m.pub === pub)

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

let primero = null // el aparato del escenario 2, que administran los de más abajo

escenario('la TUI abre, entra en la bóveda y la lista sale ENTERA (con la propia bóveda)', async () => {
  await tui.esperar(/Bóveda activa/)
  const t0 = Date.now()
  tui.teclas('\r') // Enter: entrar en la bóveda seleccionada
  // Una bóveda recién hecha ya tiene un miembro: ella misma, que es la que manda.
  const p = await tui.esperar(/esta bóveda/)
  assert.match(p, /[0-9A-F]{4}-[0-9A-F]{4}/, 'con su identificador')
  // «(sin dispositivos enrolados)» AQUÍ no es una lista vacía: es que el acta no llegó —
  // exactamente lo que se veía cuando el volcado se pisaba a sí mismo.
  assert.ok(!/sin dispositivos enrolados/.test(p), 'el acta llegó, no se pinta una lista vacía')
  assert.ok(!/daemon no responde|no respondió/i.test(p), 'y sin plantón del daemon')
  // Y llega PRONTO: esperar la lista de bóvedas, que ya no viene sola, costaba seis
  // segundos por refresco (los de rendirse) con el daemon contestando en cien milisegundos.
  assert.ok(Date.now() - t0 < 6000, `la lista tarda lo que tarda el daemon (${Date.now() - t0} ms)`)
})

escenario('emparejar con P: sale el QR, el aparato se conecta y con el código entra al acta', async () => {
  const qr = await abrirEmparejamiento()
  assert.match(tui.todo(), /vault\.dotrino\.com|http/, 'enseña el enlace para pegar')
  primero = await aparato(qr, 'celular')

  await tui.esperar(/Se conectó|PENDIENTE/)
  tui.teclas('a')
  await tui.esperar(/Código que MUESTRA/)
  tui.teclas(primero.code + '\r')
  await tui.esperar(/Dispositivo aprobado/)

  const res = await primero.enrolado
  primero.pub = res.device.publickey
  assert.ok(res.cert, 'el aparato recibe su certificado')
  assert.ok(miembroDe(primero.pub), 'y entra en el acta del perfil')

  // Y LA PANTALLA LO ENSEÑA, sin tener que refrescar a mano: la lista sale del acta, y
  // aprobar solo guardaba los certificados — el aparato recién entrado no aparecía.
  const lista = await tui.esperar(/celular/, 8000)
  assert.match(lista, /[0-9A-F]{4}-[0-9A-F]{4}/, 'con su identificador legible')
})

escenario('CÓDIGO EQUIVOCADO: la TUI lo dice y NO da por aprobado a nadie', async () => {
  const antes = miembros().length
  const qr = await abrirEmparejamiento()
  const intruso = await aparato(qr, 'intruso')

  await tui.esperar(/Se conectó|PENDIENTE/)
  const malo = String((Number(intruso.code) + 7) % 1000000).padStart(6, '0')
  tui.teclas('a')
  await tui.esperar(/Código que MUESTRA/)
  tui.teclas(malo + '\r')

  // LA REGRESIÓN: esto decía «Dispositivo aprobado» y se olvidaba del pendiente, así que
  // ni entraba nadie ni se podía reintentar. Ahora se dice lo que pasó.
  const p = await tui.esperar(/no coincide|does not match/i)
  assert.ok(!/Dispositivo aprobado/.test(p), 'no canta un aprobado que no ocurrió')
  assert.equal(miembros().length, antes, 'nadie entró en el acta')

  // Y el pendiente sigue ahí: con el código bueno, entra.
  tui.teclas('a')
  await tui.esperar(/Código que MUESTRA/)
  tui.teclas(intruso.code + '\r')
  await tui.esperar(/Dispositivo aprobado/)
  const res = await intruso.enrolado
  assert.ok(res.cert, 'con el código correcto sí se emite el certificado')
  assert.equal(miembros().length, antes + 1)
})

escenario('permisos con C: administrar se PREGUNTA antes, y queda en el acta', async () => {
  assert.ok(primero?.pub, 'hace falta el aparato del escenario de emparejar')
  assert.ok(!(miembroDe(primero.pub).caps || []).includes('admin'), 'nace sin administrar')

  await aDispositivos()
  tui.teclas('\x1b[B') // ↓ : el master es la primera fila; el aparato, la siguiente
  await sleep(300)
  tui.teclas('c')
  const p = await tui.esperar(/Permisos de/)
  for (const texto of [/Firmar como tú/, /Guardar tus datos/, /Leer tus datos/, /Administrar el perfil/]) {
    assert.match(p, texto, 'los cuatro permisos, en cristiano')
  }

  // Bajar hasta «Administrar el perfil» (el cuarto) y marcarlo.
  tui.teclas('\x1b[B\x1b[B\x1b[B')
  await sleep(300)
  tui.teclas('\r')
  // Es el único que se pregunta: deja a ese aparato meter y sacar dispositivos sin venir.
  await tui.esperar(/conecte y quite dispositivos/)
  tui.teclas('y')
  await tui.esperar(/Concedido/)

  const hasta = Date.now() + 8000
  while (Date.now() < hasta && !(miembroDe(primero.pub).caps || []).includes('admin')) await sleep(200)
  assert.ok((miembroDe(primero.pub).caps || []).includes('admin'), 'el acta lo recoge')

  // Y quitarlo no se pregunta: quitar un permiso no expone nada.
  tui.teclas('\r')
  await tui.esperar(/Quitado/)
  const hasta2 = Date.now() + 8000
  while (Date.now() < hasta2 && (miembroDe(primero.pub).caps || []).includes('admin')) await sleep(200)
  assert.ok(!(miembroDe(primero.pub).caps || []).includes('admin'), 'y también lo recoge al quitarlo')
})

escenario('la bóveda no se echa a sí misma (V sobre el master)', async () => {
  await aDispositivos()
  const antes = miembros().length
  tui.teclas('\x1b[H') // Home: la primera fila es el master
  await sleep(300)
  tui.teclas('v')
  await tui.esperar(/no se quita a sí misma/)
  assert.equal(miembros().length, antes, 'y no manda la orden: el acta no cambia')
})

escenario('quitar un aparato con V: sale del acta y la bóveda deja de firmarle', async () => {
  const qr = await abrirEmparejamiento()
  const perdido = await aparato(qr, 'perdido')
  await tui.esperar(/Se conectó|PENDIENTE/)
  tui.teclas('a')
  await tui.esperar(/Código que MUESTRA/)
  tui.teclas(perdido.code + '\r')
  await tui.esperar(/Dispositivo aprobado/)
  const res = await perdido.enrolado

  // Con su certificado vigente, la bóveda le firma lo que pida.
  const firma = await requestSign({
    masterPubkey: vault.iss, proxyUrl: proxy.url, device: res.device, cert: res.cert,
    payload: { hola: 'mundo' }, dir: tmpDir('tui-firma-ok')
  })
  assert.ok(firma.signature)

  // La fila del aparato recién entrado es la última: End la selecciona.
  tui.teclas('\x1b[F')
  await sleep(400)
  tui.teclas('v')
  await tui.esperar(/Quitar .*del perfil/)
  tui.teclas('y')
  await tui.esperar(/Revocado/)

  const hasta = Date.now() + 8000
  while (Date.now() < hasta && miembroDe(res.device.publickey)) await sleep(200)
  assert.ok(!miembroDe(res.device.publickey), 'sale del acta')

  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url, device: res.device, cert: res.cert,
      payload: { hola: 'otra vez' }, dir: tmpDir('tui-firma-ko')
    }),
    /unauthorized|no autorizado/,
    'quitarlo desde la TUI le corta el acceso de verdad, no solo en pantalla'
  )
})

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

console.log('\nSMOKE · emparejar y administrar DESDE LA TUI de la bóveda\n')
if (spawnSync('script', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('Falta `script` (util-linux): sin pty no se puede pilotar una TUI. Instálalo con: sudo apt install bsdutils\n')
  process.exit(2)
}
try {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  console.log(`  proxy   ${proxy.url}`)
  console.log(`  bóveda  ${vault.state.fingerprint}  (datos en ${vault.dir})`)
  console.log('  TUI     node bin/dotrino-vault-tui.js, en un pty de 120×60\n')
  tui = abrirTui({ dir: vault.dir })

  const ok = await correr()
  tui.cerrar()
  await sleep(600)
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  try { tui?.cerrar() } catch (_) {}
  await teardown()
  process.exit(1)
}
