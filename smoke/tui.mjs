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
import { scenario, runScenarios, startProxy, startVault, teardown, tmpDir, ROOT, VAULT_DIR } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
import { sleep } from './lib/wait.js'

// El cliente REAL de dispositivo: el aparato que se empareja no es una imitación.
const { enroll, requestSign, verifyRevoke } = await import(path.join(ROOT, 'dotrino-vault/src/client.js'))
const { MSG } = await import(path.join(ROOT, 'dotrino-vault/lib/src/protocol.js'))
const { signWithDevice, pubkeyId } = await import(path.join(ROOT, 'dotrino-identity/vault/capabilities.js'))
const { WebSocketProxyClient } = await import(path.join(ROOT, 'dotrino-proxy-client/src/index.js'))

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
function openTui ({ dir, lang = 'es', cols = 120, rows = 60 } = {}) {
  const cmd = `stty rows ${rows} cols ${cols} 2>/dev/null; exec node bin/dotrino-vault-tui.js`
  const p = spawn('script', ['-q', '-e', '-c', cmd, '/dev/null'], {
    cwd: VAULT_DIR,
    env: { ...process.env, DOTRINO_VAULT_DIR: dir, DOTRINO_LANG: lang, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buf = ''
  let from = 0
  p.stdout.on('data', (b) => { buf += String(b) })
  p.stderr.on('data', (b) => { buf += String(b) })

  // La TUI dibuja posicionando el cursor al principio de cada fila, así que ESO es el
  // salto de línea; el resto de escapes (color, borrado) se tira.
  const clean = (s) => s
    .replace(/\x1b\[[0-9]+;1H/g, '\n')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')

  const api = {
    proc: p,
    /** Todo lo dibujado desde la última tecla. */
    screen: () => clean(buf.slice(from)),
    all: () => clean(buf),
    /** Teclea. A partir de aquí, `screen()` y `waitFor()` solo miran lo nuevo. */
    keys (s) { from = buf.length; p.stdin.write(s); return api },
    /** Espera a que lo dibujado tras la última tecla diga esto. Devuelve la pantalla. */
    async waitFor (re, ms = 20000) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        const v = api.screen()
        if (re.test(v)) return v
        await sleep(120)
      }
      const seen = api.screen().split('\n').filter((l) => l.trim()).slice(-12).join('\n')
      throw new Error(`the TUI never said ${re}\n--- the last thing it drew ---\n${seen}\n---`)
    },
    /** ¿Llegó a decir esto? (sin fallar si no) */
    async said (re, ms = 4000) { try { await api.waitFor(re, ms); return true } catch { return false } },
    close () { try { p.stdin.write('q') } catch (_) {} ; setTimeout(() => { try { p.kill('SIGKILL') } catch (_) {} }, 800) }
  }
  return api
}

// EL CANAL LOCAL VA CIFRADO desde vaultd 0.89 (`src/ipc.js`): leerlo con `JSON.parse` daba
// null siempre, y cada escenario que necesitaba el QR fallaba con «la TUI no llegó a abrir
// un emparejamiento» aunque la TUI lo tuviera en pantalla.
const { ipcRead } = await import(path.join(ROOT, 'dotrino-vault/src/ipc.js'))
const readJson = (f) => ipcRead(f, null)

/**
 * El QR que la TUI acaba de abrir: se lee del MISMO archivo que ella está pintando, en vez
 * de rescatar el base64 de la pantalla (que el terminal recorta al ancho de la ventana).
 * `desdeMs` descarta el del escenario anterior.
 */
async function invitationOnScreen (dir, sinceMs) {
  const f = path.join(dir, 'pair.json')
  const until = Date.now() + 15000
  while (Date.now() < until) {
    const d = readJson(f)
    if (d?.qr && (d.at || 0) >= sinceMs) return d.qr
    await sleep(150)
  }
  throw new Error('the TUI never opened a pairing')
}

/**
 * Deja la TUI en la pestaña Dispositivos venga de donde venga (del QR, de permisos, o de
 * la lista de bóvedas). Cada escenario empieza desde ahí: así uno que falle no arrastra a
 * los siguientes por dejar la pantalla en otro sitio.
 */
async function toDevices () {
  for (let i = 0; i < 5; i++) {
    tui.keys('\x1b')
    await sleep(600)
    const p = tui.screen()
    if (/▐ Dispositivos/.test(p)) return
    if (/» Bóvedas/.test(p)) { tui.keys('\r'); await tui.waitFor(/▐ Dispositivos/); return }
  }
  throw new Error('could not go back to Devices')
}

/** Abre un emparejamiento desde Dispositivos y devuelve la invitación. */
async function openPairing () {
  await toDevices()
  const t0 = Date.now()
  tui.keys('p')
  await tui.waitFor(/A qué cuenta|Cuenta nueva|Esta bóveda/i)
  await tui.waitFor(/Entrar a esta cuenta/i)
  tui.keys('\r') // «esta bóveda»
  // Y AHORA PIDE EL NOMBRE DEL APARATO. No es un fallo: es el paso que llegó con `--name`
  // («cómo se llamará el aparato que entre»), y este test es anterior — se quedaba
  // esperando el QR delante de un campo de texto que nadie rellenaba, y de ahí colgaban
  // los cuatro escenarios siguientes.
  await tui.waitFor(/se va a llamar|going to be called/i)
  tui.keys('tui\r')
  await tui.waitFor(/Cuenta que se comparte/)
  // Al final de esa pantalla, debajo del QR, es donde se avisa de quién se conectó. El QR
  // ocupa más que el terminal, así que se baja del todo — lo mismo que hace el dueño.
  tui.keys('\x1b[F')
  await sleep(400)
  return invitationOnScreen(vault.dir, t0)
}

/** Un aparato de verdad que se enrola con esa invitación y enseña su código. */
async function pairingDevice (qr, label) {
  let code = null
  const enrolled = enroll({ qr, label, dir: tmpDir('tui-' + label), onChallenge: (c) => { code = c.code } })
  enrolled.catch(() => {}) // el rechazo se mira donde toca; aquí no queremos un unhandled
  const until = Date.now() + 15000
  while (!code && Date.now() < until) await sleep(50)
  assert.ok(code, 'the device shows a six-digit code')
  return { code, enrolled }
}

/**
 * UN APARATO EXPULSADO QUE VUELVE A LLAMAR.
 *
 * La bóveda tiene que ATENDERLE —aunque su papel ya no valga— para poder mandarle el aviso
 * FIRMADO, que es lo ÚNICO que le borra la cuenta: un «unauthorized» pelado no va firmado,
 * así que el aparato tiene prohibido borrar nada con él (si no, cualquiera destruiría datos
 * ajenos con un mensaje). Si la bóveda se limitara a colgarle, el aparato se quedaría
 * enseñando una cuenta que ya no existe.
 *
 * Devuelve `{ error, aviso }`: lo que contestó y el aviso firmado, si llegó.
 */
async function expelledCalls ({ device, cert }) {
  const client = new WebSocketProxyClient({ url: proxy.url, enableWebRTC: false, autoReconnect: false })
  await client.connect()
  try {
    // Identificarse es lo que hace que el proxy le entregue lo que tuviera ENCOLADO.
    const idData = { op: 'identify', publickey: device.publickey, token: client.token, ts: Date.now() }
    const idSig = await signWithDevice({ privateJwk: device.privateJwk, data: idData })
    await client.identify({ data: idData, signature: idSig.signature, cert })

    let notice = null
    let error = null
    const off = client.on('message', (_f, p) => {
      if (p?.type === MSG.REVOKED) notice = p
      else if (p?.type === MSG.ERROR) error = p.error
    })
    const data = { op: 'sign', payload: { hello: 'still here' }, publickey: device.publickey, ts: Date.now() }
    const { signature } = await signWithDevice({ privateJwk: device.privateJwk, data })
    client.sendByPubkey(vault.iss, { type: MSG.SIGN, data, signature, cert })
    const until = Date.now() + 12000
    while (Date.now() < until && !(notice && error)) await sleep(150)
    off()
    return { error, notice }
  } finally { try { client.close() } catch (_) {} }
}

const recordMembers = () => vault.acta()?.members || []
const memberOf = (pub) => recordMembers().find((m) => m.pub === pub)

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

let first = null // el aparato del escenario 2, que administran los de más abajo
let removed = null // el que se expulsa al final, para comprobar que se le avisa

scenario('the TUI opens, enters the vault and the list comes out WHOLE (with the vault itself)', async () => {
  await tui.waitFor(/Bóveda activa/)
  const t0 = Date.now()
  tui.keys('\r') // Enter: entrar en la bóveda seleccionada
  // Una bóveda recién hecha ya tiene un miembro: ella misma, que es la que manda.
  const p = await tui.waitFor(/esta bóveda/)
  assert.match(p, /[0-9A-F]{4}-[0-9A-F]{4}/, 'with its identifier')
  // «(sin dispositivos enrolados)» AQUÍ no es una lista vacía: es que el acta no llegó —
  // exactamente lo que se veía cuando el volcado se pisaba a sí mismo.
  assert.ok(!/sin dispositivos enrolados/.test(p), 'the record arrived, no empty list is drawn')
  assert.ok(!/daemon no responde|no respondió/i.test(p), 'and the daemon did not stand us up')
  // Y llega PRONTO: esperar la lista de bóvedas, que ya no viene sola, costaba seis
  // segundos por refresco (los de rendirse) con el daemon contestando en cien milisegundos.
  assert.ok(Date.now() - t0 < 6000, `the list takes as long as the daemon (${Date.now() - t0} ms)`)
})

scenario('entering the vault ALSO loads the variables (Scopes is not blank)', async () => {
  // La variable se guarda con la TUI ya abierta: lo que ella tiene en memoria es de antes.
  await vault.setSecret('proxy', 'TURN_KEY_ID', 'k-123', true)

  // Salir a la lista de bóvedas y volver a entrar. Es el mismo camino que recorre quien
  // acaba de teclear la contraseña de una bóveda con candado — y ahí la memoria está vacía
  // a propósito, así que entrar TIENE que recargar. Antes solo se recargaba al CAMBIAR de
  // bóveda, y lo que se recargaba eran los aparatos: Scopes se quedaba en blanco hasta que
  // a alguien se le ocurriera pulsar F5.
  await toDevices()
  tui.keys('\x1b')
  await tui.waitFor(/Bóveda activa/)
  tui.keys('\r')
  await tui.waitFor(/▐ Dispositivos/)
  tui.keys('\x1b[C') // → : la pestaña de al lado
  const p = await tui.waitFor(/proxy/, 8000)
  assert.ok(!/sin scopes/.test(p), 'the variable is there without a manual refresh')
  assert.match(p, /TURN_KEY_ID/, 'with its name')

  // EL VALOR NO SALE EN LA LISTA, y esto CAMBIÓ el 2026-09-02: desde que todas las
  // variables van en sobre, «pública» dejó de significar «en claro» — dice a quién se le
  // despacha sin aprobación, nada más. Ni siquiera hay un valor suelto que enseñar: habría
  // que abrir cada sobre en cada refresco, y en un cajón con dueño la bóveda no puede.
  //
  // Este test afirmaba lo contrario y llevaba días en rojo por eso, arrastrando con él a
  // los seis escenarios de abajo. Es el patrón de siempre: una aserción que sobrevive al
  // cambio que la deroga y que nadie vuelve a leer.
  assert.ok(!/k-123/.test(p), 'the value is NOT shown in the list: it is enveloped like any other')

  // LO QUE SÍ: revelarla a demanda con «v», y sin pedir contraseña — que es exactamente lo
  // que «pública» significa ahora.
  // El cursor entra en el SCOPE, y «v» solo revela sobre una variable: hay que bajar a
  // ella. No es un rodeo del test, es cómo se usa.
  tui.keys('\x1b[B')
  tui.keys('v')
  const revealed = await tui.waitFor(/k-123/, 8000)
  assert.match(revealed, /k-123/, 'a public one is revealed without a password')
})

scenario('pair with P: the QR shows up, the device connects and with the code joins the record', async () => {
  const qr = await openPairing()
  assert.match(tui.all(), /vault\.dotrino\.com|http/, 'it shows the link to paste')
  first = await pairingDevice(qr, 'phone')

  await tui.waitFor(/Se conectó|PENDIENTE/)
  tui.keys('a')
  await tui.waitFor(/Código que MUESTRA/)
  tui.keys(first.code + '\r')
  await tui.waitFor(/Dispositivo aprobado/)

  const res = await first.enrolled
  first.pub = res.device.publickey
  assert.ok(res.cert, 'the device receives its certificate')
  assert.ok(memberOf(first.pub), 'and joins the profile record')

  // Y LA PANTALLA LO ENSEÑA, sin tener que refrescar a mano: la lista sale del acta, y
  // aprobar solo guardaba los certificados — el aparato recién entrado no aparecía.
  // Se busca por su IDENTIFICADOR y no por la etiqueta: la que se ve es la que se tecleó en
  // la bóveda al abrir el emparejamiento («tui»), que manda sobre la que trae el aparato.
  const hex = (await pubkeyId(first.pub)).slice(0, 8).toUpperCase()
  const readableId = hex.slice(0, 4) + '-' + hex.slice(4)
  await tui.waitFor(new RegExp(readableId), 8000)
})

scenario('a SERVICE pairs from the TUI, and joins the record with its cn', async () => {
  // Esto solo existía en la línea de comandos (`pair --service <ns>`): la TUI llevaba al
  // dueño hasta el QR y ahí lo dejaba, teniendo que salirse a la terminal para la única
  // clase de aparato que luego lee variables. Ahora es la tercera opción de la pregunta.
  await toDevices()
  const t0 = Date.now()
  tui.keys('p')
  await tui.waitFor(/A qué cuenta|Cuenta nueva|Esta bóveda/i)
  tui.keys('\x1b[B\x1b[B\r')            // ↓ ↓ Enter: «Conectar un servicio»
  await tui.waitFor(/Qué servicio es/i)
  tui.keys('proxy\r')

  // El QR dice QUÉ se está entregando: no es un aparato del dueño, es un papel que solo
  // sirve para leer las variables de ese ns.
  const p = await tui.waitFor(/Cuenta que se comparte/)
  assert.match(p, /SERVICIO «proxy»/, 'the screen warns that the QR is for a service')

  tui.keys('\x1b[F')
  await sleep(400)
  const qr = await invitationOnScreen(vault.dir, t0)
  const svc = await pairingDevice(qr, 'proxy-vps')

  await tui.waitFor(/Se conectó|PENDIENTE/)
  tui.keys('a')
  await tui.waitFor(/Código que MUESTRA/)
  tui.keys(svc.code + '\r')
  await tui.waitFor(/Dispositivo aprobado/)

  const res = await svc.enrolled
  assert.ok(res.cert, 'the service receives its certificate')
  const m = memberOf(res.device.publickey)
  assert.ok(m, 'and joins the record')
  // LO QUE IMPORTA: el acta lo reconoce como el servicio «proxy». Sin `cn` no puede pedir
  // sus variables (la bóveda mira el acta, no solo el scope del certificado).
  assert.equal(m.cn, 'proxy', 'the record recognises it as the «proxy» service')
})

scenario('WRONG CODE: the TUI says so and does NOT approve anyone', async () => {
  const before = recordMembers().length
  const qr = await openPairing()
  const intruder = await pairingDevice(qr, 'intruder')

  await tui.waitFor(/Se conectó|PENDIENTE/)
  const wrong = String((Number(intruder.code) + 7) % 1000000).padStart(6, '0')
  tui.keys('a')
  await tui.waitFor(/Código que MUESTRA/)
  tui.keys(wrong + '\r')

  // LA REGRESIÓN: esto decía «Dispositivo aprobado» y se olvidaba del pendiente, así que
  // ni entraba nadie ni se podía reintentar. Ahora se dice lo que pasó.
  const p = await tui.waitFor(/no coincide|does not match/i)
  assert.ok(!/Dispositivo aprobado/.test(p), 'it does not announce an approval that did not happen')
  assert.equal(recordMembers().length, before, 'nobody joined the record')

  // Y el pendiente sigue ahí: con el código bueno, entra.
  tui.keys('a')
  await tui.waitFor(/Código que MUESTRA/)
  tui.keys(intruder.code + '\r')
  await tui.waitFor(/Dispositivo aprobado/)
  const res = await intruder.enrolled
  assert.ok(res.cert, 'with the right code the certificate is issued')
  assert.equal(recordMembers().length, before + 1)
})

scenario('permissions with C: admin is ASKED first, and stays in the record', async () => {
  assert.ok(first?.pub, 'needs the device from the pairing scenario')
  assert.ok(!(memberOf(first.pub).caps || []).includes('admin'), 'it is born without admin')

  await toDevices()
  // LA FILA DEL APARATO SE BUSCA, no se supone. La lista sale del acta en su orden, y
  // «la segunda» dejó de ser el aparato cuando la llave de comunicación de la bóveda entró
  // como miembro: es un servicio, sus permisos empiezan por su cajón, y bajar tres filas
  // marcaba «lee» en vez de «administra».
  const row = recordMembers().findIndex((m) => m.pub === first.pub)
  assert.ok(row >= 0, 'the device is in the record')
  tui.keys('\x1b[H' + '\x1b[B'.repeat(row))
  await sleep(300)
  tui.keys('c')
  const p = await tui.waitFor(/Permisos de/)
  // El título de cada permiso es SU NOMBRE en la CLI (`caps <ID> +administra`), y lo que hace
  // va debajo. Antes eran frases («Firmar como tú»…), y esta prueba se quedó con ellas.
  for (const text of [/\bfirma\b/, /\bguarda\b/, /\blee\b/, /\badministra\b/]) {
    assert.match(p, text, 'the four permissions, with the name typed in the CLI')
  }

  // Bajar hasta «administra» (el cuarto) y marcarlo. Enter solo mueve el BORRADOR: se firma
  // con G, una sola acta con todo lo tocado.
  tui.keys('\x1b[B\x1b[B\x1b[B')
  await sleep(300)
  tui.keys('\r')
  await sleep(300)
  tui.keys('g')
  // Es el único que se pregunta, y al GUARDAR: deja a ese aparato meter y sacar dispositivos sin venir.
  await tui.waitFor(/conecte y quite dispositivos/)
  tui.keys('y')
  await tui.waitFor(/guardados/)

  const until = Date.now() + 8000
  while (Date.now() < until && !(memberOf(first.pub).caps || []).includes('admin')) await sleep(200)
  assert.ok((memberOf(first.pub).caps || []).includes('admin'), 'the record picks it up')

  // Y quitarlo no se pregunta: quitar un permiso no expone nada.
  tui.keys('\r')
  await sleep(300)
  tui.keys('g')
  await tui.waitFor(/guardados/)
  const until2 = Date.now() + 8000
  while (Date.now() < until2 && (memberOf(first.pub).caps || []).includes('admin')) await sleep(200)
  assert.ok(!(memberOf(first.pub).caps || []).includes('admin'), 'and also picks up its removal')
})

scenario('the vault does not remove itself (V on the master)', async () => {
  await toDevices()
  const before = recordMembers().length
  tui.keys('\x1b[H') // Home: la primera fila es el master
  await sleep(300)
  tui.keys('v')
  await tui.waitFor(/no se quita a sí misma/)
  assert.equal(recordMembers().length, before, 'and it sends no order: the record does not change')
})

scenario('removing a device with V: it leaves the record and the vault stops signing for it', async () => {
  const qr = await openPairing()
  const lost = await pairingDevice(qr, 'lost')
  await tui.waitFor(/Se conectó|PENDIENTE/)
  tui.keys('a')
  await tui.waitFor(/Código que MUESTRA/)
  tui.keys(lost.code + '\r')
  await tui.waitFor(/Dispositivo aprobado/)
  const res = await lost.enrolled

  // Con su certificado vigente, la bóveda le firma lo que pida.
  const signed = await requestSign({
    masterPubkey: vault.iss, proxyUrl: proxy.url, device: res.device, cert: res.cert,
    payload: { hello: 'world' }, dir: tmpDir('tui-sign-ok')
  })
  assert.ok(signed.signature)

  // La fila del aparato recién entrado es la última: End la selecciona.
  tui.keys('\x1b[F')
  await sleep(400)
  tui.keys('v')
  await tui.waitFor(/Quitar .*del perfil/)
  tui.keys('y')
  await tui.waitFor(/Revocado/)

  const until = Date.now() + 8000
  while (Date.now() < until && memberOf(res.device.publickey)) await sleep(200)
  assert.ok(!memberOf(res.device.publickey), 'it leaves the record')

  await assert.rejects(
    () => requestSign({
      masterPubkey: vault.iss, proxyUrl: proxy.url, device: res.device, cert: res.cert,
      payload: { hello: 'again' }, dir: tmpDir('tui-sign-ko')
    }),
    /unauthorized|no autorizado/,
    'removing it from the TUI really cuts its access, not just on screen'
  )

  removed = res
})

scenario('an expelled device that calls again is ANSWERED, so it can get the signed notice', async () => {
  assert.ok(removed, 'needs the device removed in the previous scenario')
  // Que la bóveda NO firme ya está probado arriba. Lo que se prueba aquí es lo contrario y
  // es igual de importante: que no le cuelgue. Un aparato que fue tuyo tiene que poder
  // llegar hasta la bóveda precisamente para que se le pueda mandar a paseo — el aviso
  // firmado es lo único que le borra la cuenta, y si estaba apagado cuando lo quitaste,
  // la única forma de dárselo es cuando vuelve.
  const { error, notice } = await expelledCalls(removed)
  assert.match(String(error || ''), /unauthorized/, 'it gets an answer, it is not ignored')
  assert.ok(notice, 'and it gets the expulsion notice, not just the error')
  assert.equal(
    await verifyRevoke({ body: notice.body, signature: notice.signature, master: vault.iss, devicePubkey: removed.device.publickey }),
    true,
    'SIGNED by the master key and for THIS device: the only thing that can erase its account'
  )
})

/**
 * UNA SEGUNDA BÓVEDA ENTRA EN LA CUENTA DE ESTA, DESDE SU TUI (tecla `j`).
 *
 * Hasta vaultd 0.117 esto solo se podía con `dotrino-vault join <invitación>` en la otra
 * máquina. Lo que se prueba es el camino entero con dos daemons de verdad: la invitación se
 * pega en la TUI de B, B enseña el código, A lo aprueba, y B acaba con la cuenta de A como
 * bóveda activa.
 *
 * Y una cosa que ningún test de un proceso ve: MIENTRAS B espera el código, su daemon sigue
 * contestando. Antes el `join` se esperaba dentro del bucle que atiende las peticiones, así
 * que durante esos minutos la TUI de B recibía «el daemon no respondió» a todo.
 */
scenario('j: another vault pastes the invitation in ITS TUI and joins the account', async () => {
  const { encodeInvite } = await import(path.join(ROOT, 'dotrino-vault/lib/src/invite.js'))
  const b = await startVault({ proxyUrl: proxy.url, name: 'vault-b', log })
  const tuiB = openTui({ dir: b.dir })
  try {
    await tuiB.waitFor(/Bóveda activa/)
    const before = (await vault.members()).members.length

    const qr = await vault.pair()
    tuiB.keys('j')
    await tuiB.waitFor(/Invitación de la otra bóveda/)
    tuiB.keys(encodeInvite(qr) + '\r')
    await tuiB.waitFor(/Cómo se llamará aquí/)
    tuiB.keys('Cuenta A\r')
    const withCode = await tuiB.waitFor(/approve \d{6}/)
    const code = withCode.match(/approve (\d{6})/)[1]
    log('[test] B shows the code ' + code)

    // B está esperando a una persona: su daemon tiene que seguir atendiendo igual.
    const t0 = Date.now()
    await b.members(5000)
    assert.ok(Date.now() - t0 < 5000, 'B\'s daemon answers while it waits for the code')

    vault.approve(code)
    const done = await tuiB.waitFor(/acta #\d+/, 30000)
    assert.match(done, /contraseña/, 'and it warns to set a password before granting «sella»')

    const recordA = await vault.members()
    assert.equal(recordA.members.length, before + 1, 'B joins A\'s record')
    const recordB = await b.members()
    if (recordA.profileId || recordB.profileId) assert.equal(recordB.profileId, recordA.profileId, 'and B has THE SAME account, not a copy')

    tuiB.keys('\r')
    const list = await tuiB.waitFor(/Cuenta A/)
    assert.match(list, /Bóveda activa: ● Cuenta A/, 'the new account is the active one')
  } finally {
    tuiB.close()
  }
})

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

console.log('\nSMOKE · pair and manage FROM THE vault TUI\n')
if (spawnSync('script', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('Missing `script` (util-linux): without a pty a TUI cannot be driven. Install it with: sudo apt install bsdutils\n')
  process.exit(2)
}
try {
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  console.log(`  proxy   ${proxy.url}`)
  console.log(`  vault   ${vault.state.fingerprint}  (data in ${vault.dir})`)
  console.log('  TUI     node bin/dotrino-vault-tui.js, in a 120×60 pty\n')
  tui = openTui({ dir: vault.dir })

  const ok = await runScenarios()
  tui.close()
  await sleep(600)
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { tui?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
