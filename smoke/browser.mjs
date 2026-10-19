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
 *   npm run smoke:browser
 *   node smoke/browser.mjs --verbose      (con los logs y sin ocultar el navegador)
 *
 * Requiere el build de la consola:  cd dotrino-vault/web && npm run build
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scenario, runScenarios, startProxy, startVault, teardown, serveStatic, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const CONSOLE_DIST = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const STORE_DIR = path.join(ROOT, 'dotrino-store')

let proxy = null
let vault = null
let webConsole = null
let webIframe = null
let webApp = null
let webStore = null
let browser = null
let context = null

/**
 * La URL del iframe de identidad para las pruebas: el de disco y, dentro, el proxio de
 * aquí. `?proxy=` solo se atiende en localhost, y hace falta porque `/vault` enciende el
 * mostrador de esta bóveda sola: sin decirle a dónde, marcaría a producción, y este
 * escenario promete no tocarla. La consola lleva el mismo parámetro, por el mostrador de
 * contraseñas, que abre su propia conexión.
 */
const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

/** Abre la consola apuntando al iframe LOCAL (el `?vault=` solo lo acepta en localhost). */
async function openConsole (hash = '') {
  const page = await context.newPage()
  page.on('console', (m) => log('[browser] ' + m.text()))
  page.on('pageerror', (e) => log('[browser!] ' + e.message))
  await page.goto(`${webConsole.url}/vault?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}${hash}`)
  // Entrando CON invitación la pantalla es SOLO el emparejamiento (por diseño: llegar por
  // un QR y encontrarte la consola entera es no entender ni que estás en medio de algo ni
  // qué botón te toca), así que la lista de miembros no existe todavía. Esperarla siempre
  // dejaba estos dos escenarios en rojo sin que nada estuviera roto.
  await page.waitForSelector(hash ? '[data-testid="pair-flow"]' : '[data-testid="members"] .member', { timeout: 30000 })
  return page
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

scenario('the console opens and shows this browser\'s record', async () => {
  const page = await openConsole()

  const memberCount = await page.locator('[data-testid="members"] .member').count()
  assert.equal(memberCount, 1, 'a brand-new browser is its own profile, with one member')

  // El aviso de la consecuencia asumida tiene que estar a la vista, no escondido.
  const notice = await page.locator('[data-testid="solo-warning"]').innerText()
  assert.match(notice, /pierdes el perfil/i, 'it says out loud that losing it means losing the profile')

  // Y sus permisos salen marcados (es un dispositivo, no un servicio). Viven dentro del
  // acordeón de su fila, así que primero se abre — que es lo que haría la persona.
  await page.locator('.member .who.acc').first().click()
  const signCap = page.locator('.member .cap').first()
  assert.match(await signCap.innerText(), /Firma/i)
  await page.close()
})

scenario('`/d` pairs and `/vault` manages: they are not the same page', async () => {
  // Una pantalla es informativa o administrativa (CONVENCIONES §5.1), y emparejar es un
  // proceso con su propia pantalla. `/d` es la dirección corta a la que apunta el QR:
  // llegar ahí y encontrarte la consola entera es no saber ni en qué estás ni qué botón
  // te toca.
  const pair = await context.newPage()
  await pair.goto(`${webConsole.url}/d?vault=${encodeURIComponent(iframeUrl())}`)
  await pair.waitForSelector('[data-testid="scan"]', { timeout: 30000 })
  assert.equal(await pair.locator('[data-testid="members"]').count(), 0, '`/d` does not list devices')
  assert.equal(await pair.locator('[data-testid="vault-at"]').count(), 0, '`/d` does not say where your vault lives nor manage it either')
  await pair.close()

  const admin = await openConsole()
  assert.equal(await admin.locator('[data-testid="members"] .member').count(), 1, '`/vault` does list them')
  await admin.close()
})

scenario('`/vault` decides by itself: with no outside vault, THIS device is the vault and starts listening', async () => {
  // Lo que hay que comprobar no es que exista una casilla, es que NO haga falta: un
  // navegador que no está en ninguna bóveda es su propia bóveda, y su mostrador tiene
  // que estar atendiendo sin que nadie encienda nada.
  const page = await openConsole()
  const where = page.locator('[data-testid="vault-at"]')
  assert.equal(await where.getAttribute('data-where'), 'self', 'the vault of an unpaired device is the device itself')

  // Y ESCUCHA de verdad: el botón que da el código para el aparato siguiente solo se
  // habilita con el mostrador en marcha (`self.running`), o sea con el daemon conectado
  // al proxio. Es la diferencia entre decirlo en pantalla y estar haciéndolo.
  await page.waitForSelector('[data-testid="self-pair"]:not([disabled])', { timeout: 30000 })
  assert.match(await where.innerText(), /escuchando|listening/i, 'and it says so where it can be seen')

  // Y atiende las DOS cosas que se le piden a una bóveda: aparatos y contraseñas.
  //
  // Esto miraba un `vault-code`: un código para enlazar la extensión que la pestaña
  // imprimía aparte. Se QUITÓ a propósito el 2026-08-27 —el gestor se empareja como
  // cualquier aparato y su permiso vive en el acta, en vez de tener un segundo
  // emparejamiento con su propia lista—, y la prueba se quedó esperando algo borrado.
  // Lo que se comprueba ahora es lo que sí tiene que estar: que el mostrador de
  // contraseñas está en marcha en esta misma página.
  //
  // Un navegador nuevo no tiene todavía contraseña de recuperación, y en la pestaña es la
  // única llave de la bóveda: el mostrador no atiende hasta tenerla. Pero la página NO se
  // bloquea (dueño, 2026-09-24): se ve entera, con el aviso arriba y el timbre deshabilitado.
  const desk = page.locator('[data-testid="passwords-desk"]')
  await desk.locator('[data-testid="recovery-notice"]').waitFor({ timeout: 30000 })
  assert.ok(await desk.locator('[data-testid="ring-enable"]').isDisabled(), 'without a password, the doorbell is shown but disabled')
  assert.ok(await desk.locator('[data-testid="kept-count"]').isVisible(), 'and the rest of the page is shown')

  const password = 'una contraseña de prueba larga'
  await desk.locator('[data-testid="pw1"]').fill(password)
  await desk.locator('[data-testid="pw2"]').fill(password)
  await desk.locator('[data-testid="pw-go"]').click()
  await page.waitForSelector('[data-testid="passwords-desk"] [data-testid="ring-on"], [data-testid="passwords-desk"] [data-testid="ring-enable"]:not([disabled])', { timeout: 30000 })
  assert.equal(await desk.locator('[data-testid="recovery-notice"]').count(), 0, 'with the password set, the notice goes away')
  await page.close()
})

scenario('the landing explains how to USE it, not just how to download it', async () => {
  const page = await context.newPage()
  await page.goto(webConsole.url + '/')

  const usage = page.locator('[data-testid="use"]')
  await usage.waitFor({ timeout: 15000 })
  const text = await usage.innerText()
  // Lo que de verdad hace falta saber después de instalarla.
  assert.match(text, /[Cc]onectar un teléfono/, 'how to connect a device')
  assert.match(text, /pierdes un aparato/i, 'what to do if you lose one')

  // §9.2: EL HOME NO DOCUMENTA. Cada cosa se cuenta en una frase y enlaza su página del
  // wiki; los comandos y las recetas viven allá. Esto se comprueba por lo que NO hay:
  // antes esta misma sección llevaba dentro los comandos y el PATH de Windows.
  assert.equal(await usage.locator('code, pre').count(), 0, 'not a single command block on the landing')
  assert.ok(await usage.locator('a[href*="wiki.dotrino.com"]').count() > 0, 'and each card links its guide')
  await page.close()
})

scenario('the download offers the THREE ways on the THREE systems', async () => {
  const page = await context.newPage()
  await page.goto(webConsole.url + '/')

  for (const system of ['linux', 'windows', 'macos']) {
    await page.locator(`[data-testid="os-${system}"]`).click()

    // 1 · instalador: en Linux se descarga; en los otros se dice que está en camino,
    // en vez de ofrecer un archivo que no existe.
    const installer = await page.locator('[data-testid="m-installer"]').innerText()
    if (system === 'linux') assert.match(installer, /\.deb|instalador/i, `${system}: there is an installer`)
    else assert.match(installer, /en camino/i, `${system}: says the installer is not there yet`)

    // 2 · un comando y 3 · docker: existen en los tres sistemas, con su promesa en una
    // frase. El COMANDO en sí ya no está aquí (§9.2: el home no documenta), está en el
    // wiki — por eso lo que se comprueba es el enlace, no el `curl`.
    assert.match(await page.locator('[data-testid="m-command"]').innerText(), /comando/i, `${system}: the command route`)
    assert.match(await page.locator('[data-testid="m-docker"]').innerText(), /docker/i, `${system}: the Docker route`)

    for (const guide of ['guide-linux', 'guide-npx', 'guide-docker']) {
      const href = await page.locator(`[data-testid="${guide}"]`).getAttribute('href')
      assert.match(href || '', /wiki\.dotrino\.com/, `${system}: ${guide} links the wiki`)
    }
    assert.equal(await page.locator('#download code, #download pre').count(), 0,
      `${system}: the download has no command blocks`)
  }
  await page.close()
})

scenario('the browser pairs with the vault: shows the code and joins the record', async () => {
  // La bóveda abre un emparejamiento; el QR lleva el código en el #fragment, que es como
  // llega de verdad (y que nunca viaja al servidor).
  const qr = await vault.pair({ label: 'navegador' })
  const page = await openConsole('#vault=' + b64url(qr))

  // La consola arranca sola con el código del fragmento y muestra los 6 dígitos.
  const digits = page.locator('[data-testid="pair-code"] .digits')
  await digits.waitFor({ timeout: 30000 })
  const code = (await digits.innerText()).trim()
  assert.match(code, /^\d{6}$/, 'shows a six-digit code to type into the vault')

  // El dueño lo teclea en la bóveda.
  const deviceId = await vault.waitPending()
  log('[vault] pending: ' + deviceId)
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
  const notice = page.locator('[data-testid="two-accounts"]')
  await notice.waitFor({ timeout: 30000 })
  assert.match(await notice.innerText(), /dos cuentas|two accounts/i, 'says there are now two')
  // Los pasos para soltar una viven en un <details> plegado, así que hay que abrirlo —
  // `innerText` no ve lo que no se pinta. Abrirlo es lo que haría la persona.
  await notice.locator('summary').click()
  assert.match(await notice.innerText(), /[Bb]orrar|[Dd]elete|[Rr]emove/, 'and how to get rid of one')

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
  const who = acta.members.map((m) => ({ label: m.label, cn: m.cn, caps: m.caps }))
  const detail = ': ' + JSON.stringify(who)
  assert.ok(who.some((m) => m.label === 'navegador' && m.caps?.includes('sign')),
    'the vault admitted the browser, and it can sign for you' + detail)
  assert.ok(who.some((m) => m.cn === 'vault'),
    'and the key the vault talks with is still there, which is not the master' + detail)
  assert.ok(who.some((m) => m.caps?.includes('sealer')),
    'and whoever seals the record' + detail)

  const onScreen = await page.locator('[data-testid="members"] .member').count()
  assert.equal(onScreen, acta.members.length, 'and the console shows everyone in the record')

  // Y la página cambió de papel sola: ya hay bóveda fuera, así que este aparato deja de
  // hacer de mostrador y pasa a hablar con ella. Dos bóvedas para una cuenta no existen.
  assert.equal(await page.locator('[data-testid="vault-at"]').getAttribute('data-where'), 'remote',
    'with the vault paired, this profile\'s vault is no longer this device')
  assert.equal(await page.locator('[data-testid="self-pair"]').count(), 0,
    'and it does not offer to connect devices to a desk that is no longer its own')

  // Ahora el Master es la bóveda, no este navegador. (Se llamaba «manda» hasta que el
  // dueño fijó el término: es el Master del acta, y así se llama en el modelo, en los
  // docs y en el código — la pantalla decía una cosa y todo lo demás otra.)
  const text = await page.locator('[data-testid="members"]').innerText()
  assert.match(text, /Master/i, 'it shows who the Master is')
  await page.close()

  // Y LA CUENTA QUE ESTE NAVEGADOR YA TENÍA SIGUE AHÍ. La de la bóveda entró como una
  // cuenta MÁS, con llave nueva (camino B). Antes se sobrescribía sin preguntar, que es
  // la fusión de cuentas que el modelo prohíbe.
  const p = await context.newPage()
  await p.goto(webIframe.url + '/')
  const profiles = await p.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('dotrino.identity.profiles') || '[]') } catch { return [] }
  })
  await p.close()
  assert.equal(profiles.length, 2, 'both accounts remain: the usual one and the vault\'s')
})

scenario('with the wrong code, the console does not treat anyone as connected', async () => {
  const qr = await vault.pair({ label: 'navegador-2' })
  const page = await openConsole('#vault=' + b64url(qr))

  const digits = page.locator('[data-testid="pair-code"] .digits')
  await digits.waitFor({ timeout: 30000 })
  const code = (await digits.innerText()).trim()
  const before = vault.acta().members.length

  await vault.waitPending()
  const wrong = String((Number(code) + 3) % 1000000).padStart(6, '0')
  vault.approve(wrong)
  await new Promise((r) => setTimeout(r, 2500))

  assert.equal(vault.acta().members.length, before, 'nobody joined the profile')
  assert.ok(await page.locator('[data-testid="pair-code"]').isVisible(),
    'the console keeps waiting, without claiming it is done')
  await page.close()
})

scenario('the browser key is NOT extractable (only checkable in a browser)', async () => {
  // Primero se usa la consola, para que el iframe genere su identidad…
  const consolePage = await openConsole()
  await consolePage.close()

  // …y luego se mira SU IndexedDB desde SU propio origen. Esto es lo que no se puede
  // probar en Node: que la llave privada existe pero es una CryptoKey no extraíble, así que
  // ni el propio código —ni un XSS— puede sacar sus bytes de esta máquina.
  const page = await context.newPage()
  await page.goto(webIframe.url + '/')
  await page.waitForTimeout(1500) // que el iframe termine de crear su identidad

  const r = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const q = indexedDB.open('dotrino-identity-keys', 1)
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
    })
    const stored = await new Promise((res) => {
      const q = db.transaction('keys', 'readonly').objectStore('keys').getAll()
      q.onsuccess = () => res(q.result || [])
    })
    return stored
      .filter((x) => x && x.privateKey)
      .map((x) => ({
        type: x.privateKey.type,
        algorithm: x.privateKey.algorithm?.name,
        extractable: x.privateKey.extractable
      }))
  })

  assert.ok(r.length > 0, 'the iframe keeps its private key in IndexedDB')
  for (const k of r) {
    assert.equal(k.extractable, false, `the ${k.algorithm} key can NOT be exported: ` + JSON.stringify(k))
    assert.equal(k.type, 'private')
  }

  // Y para que quede claro que no es teoría: pedirle los bytes falla.
  const attempt = await page.evaluate(async () => {
    const db = await new Promise((res) => { const q = indexedDB.open('dotrino-identity-keys', 1); q.onsuccess = () => res(q.result) })
    const all = await new Promise((res) => { const q = db.transaction('keys', 'readonly').objectStore('keys').getAll(); q.onsuccess = () => res(q.result || []) })
    const k = all.find((x) => x?.privateKey)?.privateKey
    try { await crypto.subtle.exportKey('jwk', k); return 'exported it' } catch (e) { return 'failed: ' + e.name }
  })
  assert.match(attempt, /^failed/, 'exporting it must fail, not return the key: ' + attempt)
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
const PHONE = '0999' + Math.random().toString().slice(2, 8)
const NICKNAME = 'Perfil-' + Math.random().toString(36).slice(2, 8)

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
function prepareApp () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotrino-app-'))
  fs.symlinkSync(path.join(ROOT, 'dotrino-identity/src'), path.join(dir, 'src'))
  fs.symlinkSync(IFRAME, path.join(dir, 'vault'))
  // El cliente del almacén importa `../store/core.js`: los dos, como en el paquete publicado.
  fs.symlinkSync(path.join(STORE_DIR, 'src'), path.join(dir, 'store-client'))
  fs.symlinkSync(path.join(STORE_DIR, 'store'), path.join(dir, 'store'))
  // El `<body>` explícito NO es cosmético: el cliente cuelga el iframe de `document.body`,
  // y una página que es solo un `<script type=module>` lo ejecuta antes de que exista.
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
<title>test app</title><body>
<script type="module">
  import { Identity } from '/src/index.js'
  const id = new Identity({ vaultUrl: ${JSON.stringify(iframeUrl())}, timeoutMs: 30000 })
  window.__ready = id.ready().then(() => { window.__id = id; return true })
    .catch((e) => { window.__failure = String(e?.message || e); return false })
</script>`)
  return dir
}

/** Abre esa app: otro origen, y la identidad por el iframe, como cualquier app real. */
async function openApp () {
  const page = await context.newPage()
  page.on('console', (m) => log('[app] ' + m.text()))
  page.on('pageerror', (e) => log('[app!] ' + e.message))
  await page.goto(webApp.url + '/')
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 })
  const ready = await page.evaluate(() => window.__ready)
  if (!ready) throw new Error('the app could not open the identity: ' + await page.evaluate(() => window.__failure))

  // PONERSE EN LA CUENTA QUE ESTÁ ENLAZADA A LA BÓVEDA. Al emparejar, este navegador acaba
  // con DOS cuentas (la suya de siempre y la de la bóveda, camino B), y la activa sigue
  // siendo la primera. Sin esto el perfil se guardaba en la cuenta que no tiene bóveda
  // detrás: el empujón decía que sí —porque a su bóveda, que es este mismo aparato, sí
  // llegaba— y el cajón del daemon se quedaba vacío. Cambiar de cuenta NO es reactivo, así
  // que después hay que recargar.
  const switched = await page.evaluate(async () => {
    const ps = await window.__id.listProfiles()
    const withVault = ps.find((p) => p.vault)
    if (!withVault) return { ok: false, ps }
    if (!withVault.current) await window.__id.switchProfile(withVault.id)
    return { ok: true, reload: !withVault.current }
  })
  if (!switched.ok) throw new Error('no account in this browser is linked to the vault: ' + JSON.stringify(switched.ps))
  if (switched.reload) {
    await page.reload()
    await page.waitForFunction(() => window.__ready, null, { timeout: 30000 })
    await page.evaluate(() => window.__ready)
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
async function waitForPush (page, ms = 30000) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await page.evaluate(() => window.__id.profilePushState())
    if (last?.error) throw new Error('the push failed: ' + last.error)
    if (last?.ok === true && last.at > 0) return last
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('the profile never reached the vault: ' + JSON.stringify(last))
}

scenario('with the vault LOCKED, the app writes the profile (which was the symptom)', async () => {
  // La bóveda con candado y cerrada: su estado normal, y el que antes lo impedía.
  await vault.profile('password-set', { password: 'a-test-password' })
  await vault.profile('lock')

  const page = await openApp()
  const r = await page.evaluate(async ([nickname, phone]) => {
    try { return { ok: !!(await window.__id.updateMe({ nickname, telefono: phone })) } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }, [NICKNAME, PHONE])
  assert.ok(r.ok, 'the app could edit the profile: ' + (r.error || ''))

  await waitForPush(page)
  const diag = await page.evaluate(async () => ({
    profile: await window.__id.currentProfile(),
    membership: await window.__id.myMembership(),
    push: await window.__id.profilePushState()
  }))
  console.log('DIAG ' + JSON.stringify(diag))
  await page.close()
})

scenario('the PRIVATE part stays sealed: the phone is not on the vault\'s disk', async () => {
  const store = vault.secrets()
  const bag = store?.ns?.['@me']
  assert.ok(bag?.vars, 'the vault has the profile drawer. What is there: ' +
    JSON.stringify({ ns: Object.keys(store?.ns || {}), dev: Object.keys(store?.dev || {}), v: store?.schemaVersion }))

  const tel = bag.vars.telefono
  assert.ok(tel, 'it stored the phone')
  assert.notEqual(tel.cls, 'public', 'the phone is NOT public: it is sensitive and nobody marked it visible')
  assert.equal(tel.pub, false, 'and it is marked as not public')
  // El texto cifrado va en `e`, que es el sobre entero (`{gen, iv, ct}`) — el mismo que
  // lleva una variable de servicio. Un `ct` suelto arriba sería otra forma, y no la hay.
  assert.ok(tel.e?.ct && tel.e?.iv, 'and it is inside an envelope: ' + JSON.stringify(tel).slice(0, 300))
  assert.ok(tel.seal?.sig, 'signed by the vault that stored it')

  // LA COMPROBACIÓN QUE IMPORTA, y por eso se hace contra el archivo entero y en crudo:
  // que el número no aparezca por ningún lado. Mirar solo su entrada dejaría pasar una
  // copia en el histórico o en un índice.
  assert.ok(!vault.rawSecrets().includes(PHONE),
    'the phone does not appear in clear anywhere in the drawer')
})

scenario('the PUBLIC part stays in clear, because there is nobody to seal it for', async () => {
  const bag = vault.secrets()?.ns?.['@me']
  const nick = bag?.vars?.nickname
  assert.ok(nick, 'it stored the nickname')
  assert.equal(nick.cls, 'public', 'the nickname is public')
  assert.equal(nick.pubv, NICKNAME, 'and it is in clear: it is what someone asking without any key of yours sees')
  assert.ok(nick.seal, 'signed, so nobody can make it up in your name')
  assert.ok(!nick.ct, 'and without an envelope: sealing it would contradict what public means')
})

scenario('another start rebuilds it from the envelopes, with no local copy', async () => {
  // SE BORRA LA COPIA LOCAL. Sin esto la app leería lo suyo y el test pasaría sin que la
  // bóveda hubiera devuelto nada — que es precisamente el fallo que no queremos que pase
  // desapercibido.
  const cleanPage = await context.newPage()
  await cleanPage.goto(webIframe.url + '/')
  const removed = await cleanPage.evaluate(() => {
    // La clave lleva el PERFIL dentro (`dotrino.identity.p.<id>.me`), porque el almacén
    // está acotado por cuenta desde el multi-perfil. Buscar «identity.me» no encontraba
    // nada y el borrado no borraba: el escenario pasaba leyendo la copia local.
    const toRemove = Object.keys(localStorage).filter((k) => /^dotrino\.identity\..*\.me$/.test(k) || k === 'dotrino.identity.me')
    for (const k of toRemove) localStorage.removeItem(k)
    return toRemove.length
  })
  await cleanPage.close()
  assert.ok(removed > 0, 'there was a local copy of the profile, and it was removed')

  // Se pregunta DESDE NODE, por lo mismo que `waitForPush`: `waitForFunction` con un
  // predicado `async` recibe una promesa y la da por buena en el primer intento.
  const page = await openApp()
  let me = null
  for (const until = Date.now() + 30000; Date.now() < until;) {
    me = await page.evaluate(() => window.__id.getMe())
    if (me?.nickname) break
    await new Promise((r) => setTimeout(r, 250))
  }
  await page.close()
  assert.ok(me, 'the app rebuilt a profile')

  assert.equal(me.nickname, NICKNAME, 'the nickname came back: the public value was read')
  assert.equal(me.telefono, PHONE, 'and so did the phone: the envelope was opened with this device\'s wrap')
})

/* ══════════════════════════════════════════════════════════════════════════════════════
 * EL ALMACÉN RESPALDADO EN LA BÓVEDA (`@dotrino/store` ≥ 0.11), de punta a punta.
 *
 * Hasta 0.10.0 el almacén mandaba TODO en un mensaje y el proxio corta en 1 MB: pasado ese
 * tamaño el respaldo dejaba de llegar y nadie se enteraba. Aquí va de verdad lo que lo
 * rompía: 1,6 MB de facturas desde una app en otro origen, por el iframe de identidad
 * (que cifra), el proxio (que corta) y la bóveda (que guarda), más un borrado. Y después
 * un navegador sin copia local que tiene que recuperarlo todo — sin el borrado.
 * ══════════════════════════════════════════════════════════════════════════════════════ */

const THREAD = 'smoke.invoices'

/** Conecta el almacén en la app, con la identidad enlazada a la bóveda, y corre `fn` dentro. */
async function withStore (page, fn, arg) {
  return page.evaluate(async ([storeUrl, fnText, a]) => {
    const { Store } = await import('/store-client/index.js')
    const store = await Store.connect({ storeUrl, identity: window.__id, maxPerThread: 50000, connectTimeoutMs: 30000, timeoutMs: 30000 })
    // eslint-disable-next-line no-new-func
    return new Function('store', 'arg', `return (${fnText})(store, arg)`)(store, a)
  }, [webStore.url + '/', fn.toString(), arg])
}

scenario('the store uploads 1.6 MB to the vault in batches, deletion included', async () => {
  const page = await openApp()
  const r = await withStore(page, async (store, thread) => {
    const xml = 'x'.repeat(11000)   // lo que ocupa una factura de facturero
    await store.importThreads({ [thread]: Array.from({ length: 150 }, (_, i) => ({ id: 'f' + i, ts: i + 1, xml })) })
    await store.removeMessage(thread, 'f0')
    try { return { ok: true, state: await store.vaultSync() } }
    catch (e) { return { ok: false, code: e.code, message: e.message, state: store.vault } }
  }, THREAD)
  await page.close()
  assert.ok(r.ok, 'the sync finished: ' + JSON.stringify(r))
  assert.equal(r.state.pending, 0, 'with nothing pending')

  const threads = vault.threads()
  assert.equal(threads?.threads?.[THREAD]?.length, 149, 'the vault has the 149 remaining invoices')
  assert.ok(threads.tombs?.[THREAD]?.f0, 'and the tombstone of the deleted one, so it does not come back from another device')
  assert.ok(!threads.threads[THREAD].some((e) => e.id === 'f0'), 'the deleted one is not there')
})

scenario('a browser with no local copy recovers it from the vault, without what was deleted', async () => {
  // Desde una ruta del MISMO origen que no es la página del almacén: esa abre la base al
  // cargar, y borrarla desde ahí queda bloqueado por ella misma.
  const cleanPage = await context.newPage()
  await cleanPage.goto(webStore.url + '/limpiar')
  const deleted = await cleanPage.evaluate(() => new Promise((resolve) => {
    const q = indexedDB.deleteDatabase('cc-store')
    q.onsuccess = () => resolve('ok'); q.onerror = () => resolve('error'); q.onblocked = () => resolve('blocked')
  }))
  await cleanPage.close()
  assert.equal(deleted, 'ok', 'the local store copy was deleted')

  const page = await openApp()
  const r = await withStore(page, async (store, thread) => {
    const before = (await store.listThread(thread)).length
    try { await store.vaultSync() } catch (e) { return { ok: false, code: e.code, message: e.message } }
    const ids = (await store.listThread(thread)).map((e) => e.id)
    return { ok: true, before, total: ids.length, hasF0: ids.includes('f0'), state: store.vault }
  }, THREAD)
  await page.close()
  assert.ok(r.ok, 'it synced: ' + JSON.stringify(r))
  assert.equal(r.before, 0, 'there really was no local copy')
  assert.equal(r.total, 149, 'the 149 came down, in parts')
  assert.equal(r.hasF0, false, 'and the deleted one did not come back to life')
})

console.log('\nSMOKE · the real browser (Playwright), all local\n')
if (!fs.existsSync(path.join(CONSOLE_DIST, 'index.html'))) {
  console.error('Missing the console build. Build it with:  cd dotrino-vault/web && npm run build\n')
  process.exit(2)
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  webConsole = await serveStatic(CONSOLE_DIST, { spa: true })
  webIframe = await serveStatic(IFRAME)
  webApp = await serveStatic(prepareApp())
  webStore = await serveStatic(path.join(STORE_DIR, 'store'))
  console.log(`  proxy    ${proxy.url}`)
  console.log(`  console  ${webConsole.url}/vault`)
  console.log(`  identity ${webIframe.url}  (the iframe, on another origin)\n`)

  browser = await chromium.launch({ headless: !VERBOSE })
  // Idioma fijo: la consola es bilingüe y elige por el del navegador. Si no se fija, las
  // comprobaciones dependerían del idioma de la máquina donde corra el test.
  context = await browser.newContext({ locale: 'es-ES' })

  const ok = await runScenarios()
  await context?.close(); await browser?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { await context?.close(); await browser?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
