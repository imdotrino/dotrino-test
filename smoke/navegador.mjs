/**
 * EL NAVEGADOR DE VERDAD — la consola de `vault.dotrino.com` con Playwright.
 *
 * Es el único escenario que no se puede probar sin navegador: aquí viven el **iframe de
 * identidad** en otro origen (con su IndexedDB y sus llaves NO EXTRAÍBLES, que solo existen
 * en un navegador), el `postMessage` entre orígenes, y la pantalla que ve la persona.
 *
 * Y va entero en local: la consola y el iframe se sirven desde el disco, el proxy y la
 * bóveda se levantan aquí. No toca producción y no necesita credenciales.
 *
 *   npm run smoke:navegador
 *   node smoke/navegador.mjs --verbose      (con los logs y sin ocultar el navegador)
 *
 * Requiere el build de la consola:  cd dotrino-vault/web && npm run build
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { escenario, correr, startProxy, startVault, teardown, servirEstatico, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const CONSOLA = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')

let proxy = null
let vault = null
let webConsola = null
let webIframe = null
let webApp = null
let navegador = null
let contexto = null

/**
 * La URL del iframe de identidad para las pruebas: el de disco y, dentro, el proxio de
 * aquí. `?proxy=` solo se atiende en localhost, y hace falta porque `/vault` enciende el
 * mostrador de esta bóveda sola: sin decirle a dónde, marcaría a producción, y este
 * escenario promete no tocarla. La consola lleva el mismo parámetro, por el mostrador de
 * contraseñas, que abre su propia conexión.
 */
const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

/** Abre la consola apuntando al iframe LOCAL (el `?vault=` solo lo acepta en localhost). */
async function abrirConsola (hash = '') {
  const page = await contexto.newPage()
  page.on('console', (m) => log('[navegador] ' + m.text()))
  page.on('pageerror', (e) => log('[navegador!] ' + e.message))
  await page.goto(`${webConsola.url}/vault?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}${hash}`)
  // Entrando CON invitación la pantalla es SOLO el emparejamiento (por diseño: llegar por
  // un QR y encontrarte la consola entera es no entender ni que estás en medio de algo ni
  // qué botón te toca), así que la lista de miembros no existe todavía. Esperarla siempre
  // dejaba estos dos escenarios en rojo sin que nada estuviera roto.
  await page.waitForSelector(hash ? '[data-testid="pair-flow"]' : '[data-testid="members"] .member', { timeout: 30000 })
  return page
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

escenario('la consola abre y muestra el acta de este navegador', async () => {
  const page = await abrirConsola()

  const miembros = await page.locator('[data-testid="members"] .member').count()
  assert.equal(miembros, 1, 'un navegador recién estrenado es su propio perfil, con un miembro')

  // El aviso de la consecuencia asumida tiene que estar a la vista, no escondido.
  const aviso = await page.locator('[data-testid="solo-warning"]').innerText()
  assert.match(aviso, /pierdes el perfil/i, 'dice en voz alta que perderlo es perder el perfil')

  // Y sus permisos salen marcados (es un dispositivo, no un servicio). Viven dentro del
  // acordeón de su fila, así que primero se abre — que es lo que haría la persona.
  await page.locator('.member .who.acc').first().click()
  const firma = page.locator('.member .cap').first()
  assert.match(await firma.innerText(), /Firma/i)
  await page.close()
})

escenario('`/d` empareja y `/vault` administra: no son la misma página', async () => {
  // Una pantalla es informativa o administrativa (CONVENCIONES §5.1), y emparejar es un
  // proceso con su propia pantalla. `/d` es la dirección corta a la que apunta el QR:
  // llegar ahí y encontrarte la consola entera es no saber ni en qué estás ni qué botón
  // te toca.
  const pair = await contexto.newPage()
  await pair.goto(`${webConsola.url}/d?vault=${encodeURIComponent(iframeUrl())}`)
  await pair.waitForSelector('[data-testid="scan"]', { timeout: 30000 })
  assert.equal(await pair.locator('[data-testid="members"]').count(), 0, '`/d` no lista dispositivos')
  assert.equal(await pair.locator('[data-testid="vault-at"]').count(), 0, '`/d` tampoco dice dónde vive tu bóveda ni la administra')
  await pair.close()

  const admin = await abrirConsola()
  assert.equal(await admin.locator('[data-testid="members"] .member').count(), 1, '`/vault` sí lista')
  await admin.close()
})

escenario('`/vault` decide sola: sin bóveda fuera, ESTE aparato es la bóveda y se pone a escuchar', async () => {
  // Lo que hay que comprobar no es que exista una casilla, es que NO haga falta: un
  // navegador que no está en ninguna bóveda es su propia bóveda, y su mostrador tiene
  // que estar atendiendo sin que nadie encienda nada.
  const page = await abrirConsola()
  const donde = page.locator('[data-testid="vault-at"]')
  assert.equal(await donde.getAttribute('data-where'), 'self', 'la bóveda de un aparato sin emparejar es él mismo')

  // Y ESCUCHA de verdad: el botón que da el código para el aparato siguiente solo se
  // habilita con el mostrador en marcha (`self.running`), o sea con el daemon conectado
  // al proxio. Es la diferencia entre decirlo en pantalla y estar haciéndolo.
  await page.waitForSelector('[data-testid="self-pair"]:not([disabled])', { timeout: 30000 })
  assert.match(await donde.innerText(), /escuchando|listening/i, 'y lo dice donde se ve')

  // Y atiende las DOS cosas que se le piden a una bóveda: aparatos y contraseñas.
  //
  // Esto miraba un `vault-code`: un código para enlazar la extensión que la pestaña
  // imprimía aparte. Se QUITÓ a propósito el 2026-08-27 —el gestor se empareja como
  // cualquier aparato y su permiso vive en el acta, en vez de tener un segundo
  // emparejamiento con su propia lista—, y la prueba se quedó esperando algo borrado.
  // Lo que se comprueba ahora es lo que sí tiene que estar: que el mostrador de
  // contraseñas está en marcha en esta misma página.
  await page.waitForSelector('[data-testid="passwords-desk"] [data-testid="ring-on"], [data-testid="passwords-desk"] [data-testid="ring-enable"]', { timeout: 30000 })
  await page.close()
})

escenario('la landing explica cómo se USA, no solo cómo se descarga', async () => {
  const page = await contexto.newPage()
  await page.goto(webConsola.url + '/')

  const uso = page.locator('[data-testid="use"]')
  await uso.waitFor({ timeout: 15000 })
  const texto = await uso.innerText()
  // Lo que de verdad hace falta saber después de instalarla.
  assert.match(texto, /[Cc]onectar un teléfono/, 'cómo conectar un aparato')
  assert.match(texto, /pierdes un aparato/i, 'qué hacer si pierdes uno')

  // §9.2: EL HOME NO DOCUMENTA. Cada cosa se cuenta en una frase y enlaza su página del
  // wiki; los comandos y las recetas viven allá. Esto se comprueba por lo que NO hay:
  // antes esta misma sección llevaba dentro los comandos y el PATH de Windows.
  assert.equal(await uso.locator('code, pre').count(), 0, 'ni un bloque de comandos en la landing')
  assert.ok(await uso.locator('a[href*="wiki.dotrino.com"]').count() > 0, 'y cada tarjeta enlaza su guía')
  await page.close()
})

escenario('la descarga ofrece las TRES formas en los TRES sistemas', async () => {
  const page = await contexto.newPage()
  await page.goto(webConsola.url + '/')

  for (const so of ['linux', 'windows', 'macos']) {
    await page.locator(`[data-testid="os-${so}"]`).click()

    // 1 · instalador: en Linux se descarga; en los otros se dice que está en camino,
    // en vez de ofrecer un archivo que no existe.
    const inst = await page.locator('[data-testid="m-installer"]').innerText()
    if (so === 'linux') assert.match(inst, /\.deb|instalador/i, `${so}: hay instalador`)
    else assert.match(inst, /en camino/i, `${so}: dice que el instalador aún no está`)

    // 2 · un comando y 3 · docker: existen en los tres sistemas, con su promesa en una
    // frase. El COMANDO en sí ya no está aquí (§9.2: el home no documenta), está en el
    // wiki — por eso lo que se comprueba es el enlace, no el `curl`.
    assert.match(await page.locator('[data-testid="m-command"]').innerText(), /comando/i, `${so}: la vía del comando`)
    assert.match(await page.locator('[data-testid="m-docker"]').innerText(), /docker/i, `${so}: la vía de Docker`)

    for (const guia of ['guide-linux', 'guide-npx', 'guide-docker']) {
      const href = await page.locator(`[data-testid="${guia}"]`).getAttribute('href')
      assert.match(href || '', /wiki\.dotrino\.com/, `${so}: ${guia} enlaza el wiki`)
    }
    assert.equal(await page.locator('#download code, #download pre').count(), 0,
      `${so}: la descarga no lleva bloques de comandos`)
  }
  await page.close()
})

escenario('el navegador se empareja con la bóveda: enseña el código y entra en el acta', async () => {
  // La bóveda abre un emparejamiento; el QR lleva el código en el #fragment, que es como
  // llega de verdad (y que nunca viaja al servidor).
  const qr = await vault.pair({ label: 'navegador' })
  const page = await abrirConsola('#vault=' + b64url(qr))

  // La consola arranca sola con el código del fragmento y muestra los 6 dígitos.
  const caja = page.locator('[data-testid="pair-code"] .digits')
  await caja.waitFor({ timeout: 30000 })
  const code = (await caja.innerText()).trim()
  assert.match(code, /^\d{6}$/, 'muestra un código de seis dígitos para teclear en la bóveda')

  // El dueño lo teclea en la bóveda.
  const deviceId = await vault.waitPending()
  log('[bóveda] pendiente: ' + deviceId)
  vault.approve(code)

  // La consola pasa a estar conectada y el navegador ya es miembro del perfil de la bóveda.
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="pair-code"]'),
    null, { timeout: 30000 }
  )
  // Al terminar queda la pantalla de «listo», que es TAMBIÉN donde se explica que el
  // aparato acabó con dos cuentas. Así que primero se lee, y luego se cierra: si no se
  // dice, aparece una entrada de más en el conmutador de perfiles y nadie sabe de dónde
  // salió.
  const aviso = page.locator('[data-testid="two-accounts"]')
  await aviso.waitFor({ timeout: 30000 })
  assert.match(await aviso.innerText(), /dos cuentas|two accounts/i, 'dice que ahora hay dos')
  // Los pasos para soltar una viven en un <details> plegado, así que hay que abrirlo —
  // `innerText` no ve lo que no se pinta. Abrirlo es lo que haría la persona.
  await aviso.locator('summary').click()
  assert.match(await aviso.innerText(), /[Bb]orrar|[Dd]elete|[Rr]emove/, 'y cómo deshacerse de una')

  // Cerrarla es parte del camino real, y ahora ADEMÁS cambia de página: `/d` empareja y
  // nada más, así que «ver mis dispositivos» lleva a `/vault`, que es donde se
  // administra. Una pantalla es informativa o administrativa, no las dos.
  await Promise.all([
    page.waitForURL(/\/vault/, { timeout: 30000 }),
    page.click('[data-testid="flow-close"]', { timeout: 30000 })
  ])
  await page.waitForSelector('[data-testid="members"] .member:nth-child(2)', { timeout: 30000 })

  // QUIÉNES TIENEN QUE ESTAR, en vez de cuántos. Esto contaba 2 y se puso rojo cuando la
  // bóveda estrenó su LLAVE DE COMUNICACIÓN (2026-08-31): desde que la maestra solo firma
  // el acta y regenera sobres, hablar por la red es de otra llave, y esa entra en el acta
  // como un miembro más con `cn:'vault'`. Un número no dice nada de eso; los papeles sí.
  const acta = vault.acta()
  const quienes = acta.members.map((m) => ({ label: m.label, cn: m.cn, caps: m.caps }))
  const detalle = ': ' + JSON.stringify(quienes)
  assert.ok(quienes.some((m) => m.label === 'navegador' && m.caps?.includes('sign')),
    'la bóveda admitió al navegador, y puede firmar por ti' + detalle)
  assert.ok(quienes.some((m) => m.cn === 'vault'),
    'y sigue estando la llave con la que la bóveda habla, que no es la maestra' + detalle)
  assert.ok(quienes.some((m) => m.caps?.includes('sealer')),
    'y quien sella el acta' + detalle)

  const enPantalla = await page.locator('[data-testid="members"] .member').count()
  assert.equal(enPantalla, acta.members.length, 'y la consola muestra a todos los del acta')

  // Y la página cambió de papel sola: ya hay bóveda fuera, así que este aparato deja de
  // hacer de mostrador y pasa a hablar con ella. Dos bóvedas para una cuenta no existen.
  assert.equal(await page.locator('[data-testid="vault-at"]').getAttribute('data-where'), 'remote',
    'con la bóveda emparejada, la de este perfil ya no es este aparato')
  assert.equal(await page.locator('[data-testid="self-pair"]').count(), 0,
    'y no ofrece conectar aparatos a un mostrador que ya no es el suyo')

  // Ahora el Master es la bóveda, no este navegador. (Se llamaba «manda» hasta que el
  // dueño fijó el término: es el Master del acta, y así se llama en el modelo, en los
  // docs y en el código — la pantalla decía una cosa y todo lo demás otra.)
  const texto = await page.locator('[data-testid="members"]').innerText()
  assert.match(texto, /Master/i, 'se ve quién es el Master')
  await page.close()

  // Y LA CUENTA QUE ESTE NAVEGADOR YA TENÍA SIGUE AHÍ. La de la bóveda entró como una
  // cuenta MÁS, con llave nueva (camino B). Antes se sobrescribía sin preguntar, que es
  // la fusión de cuentas que el modelo prohíbe.
  const p = await contexto.newPage()
  await p.goto(webIframe.url + '/')
  const perfiles = await p.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('dotrino.identity.profiles') || '[]') } catch { return [] }
  })
  await p.close()
  assert.equal(perfiles.length, 2, 'quedan las dos cuentas: la de siempre y la de la bóveda')
})

escenario('con el código equivocado, la consola no da por conectado a nadie', async () => {
  const qr = await vault.pair({ label: 'navegador-2' })
  const page = await abrirConsola('#vault=' + b64url(qr))

  const caja = page.locator('[data-testid="pair-code"] .digits')
  await caja.waitFor({ timeout: 30000 })
  const code = (await caja.innerText()).trim()
  const antes = vault.acta().members.length

  await vault.waitPending()
  const malo = String((Number(code) + 3) % 1000000).padStart(6, '0')
  vault.approve(malo)
  await new Promise((r) => setTimeout(r, 2500))

  assert.equal(vault.acta().members.length, antes, 'nadie entró en el perfil')
  assert.ok(await page.locator('[data-testid="pair-code"]').isVisible(),
    'la consola sigue esperando, sin decir que ya está')
  await page.close()
})

escenario('la llave del navegador NO es extraíble (solo se comprueba en un navegador)', async () => {
  // Primero se usa la consola, para que el iframe genere su identidad…
  const consola = await abrirConsola()
  await consola.close()

  // …y luego se mira SU IndexedDB desde SU propio origen. Esto es lo que no se puede
  // probar en Node: que la llave privada existe pero es una CryptoKey no extraíble, así que
  // ni el propio código —ni un XSS— puede sacar sus bytes de esta máquina.
  const page = await contexto.newPage()
  await page.goto(webIframe.url + '/')
  await page.waitForTimeout(1500) // que el iframe termine de crear su identidad

  const r = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const q = indexedDB.open('dotrino-identity-keys', 1)
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
    })
    const guardadas = await new Promise((res) => {
      const q = db.transaction('keys', 'readonly').objectStore('keys').getAll()
      q.onsuccess = () => res(q.result || [])
    })
    return guardadas
      .filter((x) => x && x.privateKey)
      .map((x) => ({
        tipo: x.privateKey.type,
        algoritmo: x.privateKey.algorithm?.name,
        extraible: x.privateKey.extractable
      }))
  })

  assert.ok(r.length > 0, 'el iframe guarda su llave privada en IndexedDB')
  for (const k of r) {
    assert.equal(k.extraible, false, `la llave ${k.algoritmo} NO puede exportarse: ` + JSON.stringify(k))
    assert.equal(k.tipo, 'private')
  }

  // Y para que quede claro que no es teoría: pedirle los bytes falla.
  const intento = await page.evaluate(async () => {
    const db = await new Promise((res) => { const q = indexedDB.open('dotrino-identity-keys', 1); q.onsuccess = () => res(q.result) })
    const todo = await new Promise((res) => { const q = db.transaction('keys', 'readonly').objectStore('keys').getAll(); q.onsuccess = () => res(q.result || []) })
    const k = todo.find((x) => x?.privateKey)?.privateKey
    try { await crypto.subtle.exportKey('jwk', k); return 'la exportó' } catch (e) { return 'falló: ' + e.name }
  })
  assert.match(intento, /^falló/, 'exportarla tiene que fallar, no devolver la llave: ' + intento)
  await page.close()
})

// ---------- arranque ----------

/* ══════════════════════════════════════════════════════════════════════════════════════
 * EL PERFIL EN SOBRES, de punta a punta (`dotrino-vault/docs/datos-del-perfil.md`).
 *
 * Es la prueba del síntoma que abrió todo esto: **«edito el perfil y no funciona»**. La
 * causa era que el perfil se guardaba en claro, así que escribirlo exigía la bóveda
 * ABIERTA — y la bóveda vive cerrada, que es para lo que está el candado.
 *
 * Aquí se comprueba lo que ningún test unitario puede: una app de verdad, en otro origen,
 * hablando por el iframe de identidad con una bóveda CERRADA al otro lado del proxio.
 * Cuatro cosas, y son las cuatro del diseño:
 *
 *   1. se escribe con la bóveda cerrada;
 *   2. lo privado queda SELLADO —el valor no aparece en el disco de la bóveda—;
 *   3. lo público queda EN CLARO, porque no hay a quién sellárselo;
 *   4. y otro arranque lo reconstruye desde los sobres, sin copia local que le ayude.
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/** Un valor que no se parece a nada más, para poder buscarlo en el disco sin falsos. */
const TELEFONO = '0999' + Math.random().toString().slice(2, 8)
const APODO = 'Perfil-' + Math.random().toString(36).slice(2, 8)

/**
 * Monta una app del ecosistema en un directorio aparte y devuelve su raíz.
 *
 * SE SIRVE DE VERDAD, no se inventa la respuesta con `page.route`. Una página sintética no
 * tiene dirección de red, así que Chrome la trata como pública y le prohíbe pedirle nada a
 * la red local: el iframe no cargaba y el error que se veía era «Vault did not respond»,
 * que apunta al otro lado (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`).
 *
 * Los enlaces simbólicos a `src/` y `vault/` son para que los `import` resuelvan igual que
 * en una app instalada, sin copiar el repo ni dejar nada dentro de él.
 */
function prepararApp () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotrino-app-'))
  fs.symlinkSync(path.join(ROOT, 'dotrino-identity/src'), path.join(dir, 'src'))
  fs.symlinkSync(IFRAME, path.join(dir, 'vault'))
  // El `<body>` explícito NO es cosmético: el cliente cuelga el iframe de `document.body`,
  // y una página que es solo un `<script type=module>` lo ejecuta antes de que exista.
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
<title>app de prueba</title><body>
<script type="module">
  import { Identity } from '/src/index.js'
  const id = new Identity({ vaultUrl: ${JSON.stringify(iframeUrl())}, timeoutMs: 30000 })
  window.__lista = id.ready().then(() => { window.__id = id; return true })
    .catch((e) => { window.__fallo = String(e?.message || e); return false })
</script>`)
  return dir
}

/** Abre esa app: otro origen, y la identidad por el iframe, como cualquier app real. */
async function abrirApp () {
  const page = await contexto.newPage()
  page.on('console', (m) => log('[app] ' + m.text()))
  page.on('pageerror', (e) => log('[app!] ' + e.message))
  await page.goto(webApp.url + '/')
  await page.waitForFunction(() => window.__lista, null, { timeout: 30000 })
  const lista = await page.evaluate(() => window.__lista)
  if (!lista) throw new Error('la app no pudo abrir la identidad: ' + await page.evaluate(() => window.__fallo))

  // PONERSE EN LA CUENTA QUE ESTÁ ENLAZADA A LA BÓVEDA. Al emparejar, este navegador acaba
  // con DOS cuentas (la suya de siempre y la de la bóveda, camino B), y la activa sigue
  // siendo la primera. Sin esto el perfil se guardaba en la cuenta que no tiene bóveda
  // detrás: el empujón decía que sí —porque a su bóveda, que es este mismo aparato, sí
  // llegaba— y el cajón del daemon se quedaba vacío. Cambiar de cuenta NO es reactivo, así
  // que después hay que recargar.
  const cambio = await page.evaluate(async () => {
    const ps = await window.__id.listProfiles()
    const conBoveda = ps.find((p) => p.vault)
    if (!conBoveda) return { ok: false, ps }
    if (!conBoveda.current) await window.__id.switchProfile(conBoveda.id)
    return { ok: true, recargar: !conBoveda.current }
  })
  if (!cambio.ok) throw new Error('ninguna cuenta de este navegador está enlazada a la bóveda: ' + JSON.stringify(cambio.ps))
  if (cambio.recargar) {
    await page.reload()
    await page.waitForFunction(() => window.__lista, null, { timeout: 30000 })
    await page.evaluate(() => window.__lista)
  }
  return page
}

/**
 * Espera a que el empujón del perfil haya llegado de verdad, y explota diciendo por qué.
 *
 * `at > 0` NO es un detalle: «todavía no se ha empujado nada» tiene que contar como no
 * llegado. Mientras el estado inicial fue `{ ok: true }`, esta espera pasaba sin que la
 * bóveda hubiera recibido una sola cosa.
 *
 * Y se pregunta DESDE NODE, no con `waitForFunction`: ese awaita el predicado, pero uno
 * `async` le devuelve una promesa —siempre cierta— y la espera terminaba en el primer
 * intento sin haber mirado nada. Costó una vuelta entera: los escenarios de después
 * fallaban buscando en el disco un cajón que aún no se había escrito.
 */
async function esperarEmpujon (page, ms = 30000) {
  const hasta = Date.now() + ms
  let ultimo = null
  while (Date.now() < hasta) {
    ultimo = await page.evaluate(() => window.__id.profilePushState())
    if (ultimo?.error) throw new Error('el empujón falló: ' + ultimo.error)
    if (ultimo?.ok === true && ultimo.at > 0) return ultimo
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('el perfil no llegó a la bóveda: ' + JSON.stringify(ultimo))
}

escenario('con la bóveda CERRADA, la app escribe el perfil (que era el síntoma)', async () => {
  // La bóveda con candado y cerrada: su estado normal, y el que antes lo impedía.
  await vault.profile('password-set', { password: 'una-contraseña-de-prueba' })
  await vault.profile('lock')

  const page = await abrirApp()
  const r = await page.evaluate(async ([apodo, telefono]) => {
    try { return { ok: !!(await window.__id.updateMe({ nickname: apodo, telefono })) } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }, [APODO, TELEFONO])
  assert.ok(r.ok, 'la app pudo editar el perfil: ' + (r.error || ''))

  await esperarEmpujon(page)
  const diag = await page.evaluate(async () => ({
    perfil: await window.__id.currentProfile(),
    soy: await window.__id.myMembership(),
    empujon: await window.__id.profilePushState()
  }))
  console.log('DIAG ' + JSON.stringify(diag))
  await page.close()
})

escenario('lo PRIVADO queda sellado: el teléfono no está en el disco de la bóveda', async () => {
  const store = vault.secretos()
  const bag = store?.ns?.['@me']
  assert.ok(bag?.vars, 'la bóveda tiene el cajón del perfil. Lo que hay: ' +
    JSON.stringify({ ns: Object.keys(store?.ns || {}), dev: Object.keys(store?.dev || {}), v: store?.schemaVersion }))

  const tel = bag.vars.telefono
  assert.ok(tel, 'guardó el teléfono')
  assert.notEqual(tel.cls, 'public', 'el teléfono NO es público: es sensible y nadie lo marcó visible')
  assert.equal(tel.pub, false, 'y está marcado como no público')
  // El texto cifrado va en `e`, que es el sobre entero (`{gen, iv, ct}`) — el mismo que
  // lleva una variable de servicio. Un `ct` suelto arriba sería otra forma, y no la hay.
  assert.ok(tel.e?.ct && tel.e?.iv, 'y va dentro de un sobre: ' + JSON.stringify(tel).slice(0, 300))
  assert.ok(tel.seal?.sig, 'firmado por la bóveda que lo guardó')

  // LA COMPROBACIÓN QUE IMPORTA, y por eso se hace contra el archivo entero y en crudo:
  // que el número no aparezca por ningún lado. Mirar solo su entrada dejaría pasar una
  // copia en el histórico o en un índice.
  assert.ok(!vault.secretosCrudos().includes(TELEFONO),
    'el teléfono no aparece en claro en ninguna parte del cajón')
})

escenario('lo PÚBLICO queda en claro, porque no hay a quién sellárselo', async () => {
  const bag = vault.secretos()?.ns?.['@me']
  const nick = bag?.vars?.nickname
  assert.ok(nick, 'guardó el apodo')
  assert.equal(nick.cls, 'public', 'el apodo es público')
  assert.equal(nick.pubv, APODO, 'y está en claro: es lo que ve quien pregunta sin tener ninguna llave tuya')
  assert.ok(nick.seal, 'firmado, para que nadie lo invente en tu nombre')
  assert.ok(!nick.ct, 'y sin sobre: sellarlo sería contradecir lo que significa público')
})

escenario('otro arranque lo reconstruye desde los sobres, sin copia local', async () => {
  // SE BORRA LA COPIA LOCAL. Sin esto la app leería lo suyo y el test pasaría sin que la
  // bóveda hubiera devuelto nada — que es precisamente el fallo que no queremos que pase
  // desapercibido.
  const limpia = await contexto.newPage()
  await limpia.goto(webIframe.url + '/')
  const borradas = await limpia.evaluate(() => {
    // La clave lleva el PERFIL dentro (`dotrino.identity.p.<id>.me`), porque el almacén
    // está acotado por cuenta desde el multi-perfil. Buscar «identity.me» no encontraba
    // nada y el borrado no borraba: el escenario pasaba leyendo la copia local.
    const fuera = Object.keys(localStorage).filter((k) => /^dotrino\.identity\..*\.me$/.test(k) || k === 'dotrino.identity.me')
    for (const k of fuera) localStorage.removeItem(k)
    return fuera.length
  })
  await limpia.close()
  assert.ok(borradas > 0, 'había una copia local del perfil, y se quitó')

  // Se pregunta DESDE NODE, por lo mismo que `esperarEmpujon`: `waitForFunction` con un
  // predicado `async` recibe una promesa y la da por buena en el primer intento.
  const page = await abrirApp()
  let me = null
  for (const hasta = Date.now() + 30000; Date.now() < hasta;) {
    me = await page.evaluate(() => window.__id.getMe())
    if (me?.nickname) break
    await new Promise((r) => setTimeout(r, 250))
  }
  await page.close()
  assert.ok(me, 'la app reconstruyó un perfil')

  assert.equal(me.nickname, APODO, 'el apodo volvió: se leyó el dato público')
  assert.equal(me.telefono, TELEFONO, 'y el teléfono también: se abrió el sobre con la envoltura de este aparato')
})

console.log('\nSMOKE · el navegador de verdad (Playwright), todo en local\n')
if (!fs.existsSync(path.join(CONSOLA, 'index.html'))) {
  console.error('Falta el build de la consola. Hazlo con:  cd dotrino-vault/web && npm run build\n')
  process.exit(2)
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  webConsola = await servirEstatico(CONSOLA, { spa: true })
  webIframe = await servirEstatico(IFRAME)
  webApp = await servirEstatico(prepararApp())
  console.log(`  proxy    ${proxy.url}`)
  console.log(`  consola  ${webConsola.url}/vault`)
  console.log(`  identidad ${webIframe.url}  (el iframe, en otro origen)\n`)

  navegador = await chromium.launch({ headless: !VERBOSE })
  // Idioma fijo: la consola es bilingüe y elige por el del navegador. Si no se fija, las
  // comprobaciones dependerían del idioma de la máquina donde corra el test.
  contexto = await navegador.newContext({ locale: 'es-ES' })

  const ok = await correr()
  await contexto?.close(); await navegador?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  try { await contexto?.close(); await navegador?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
