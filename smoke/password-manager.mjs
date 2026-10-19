/**
 * LA EXTENSIÓN ENLAZADA A LA BÓVEDA DE PESTAÑA.
 *
 * La extensión nace siendo su propia bóveda (DISENO §3.3.1), y esa vía está probada de
 * sobra en su repo. Lo que no lo estaba es la OTRA: enlazarla a una bóveda que vive en
 * una pestaña (§3.4) y comprobar que, con el proxio de por medio, hace lo mismo.
 *
 * Es el escenario que junta las tres piezas que ninguna prueba de un repo solo puede
 * juntar: la extensión (MV3, con su service worker), la consola de `vault.dotrino.com`
 * haciendo de bóveda, y el proxio entre las dos. Todo en local: no toca producción y no
 * necesita credenciales.
 *
 *   npm run smoke:password-manager
 *   node smoke/password-manager.mjs --verbose      (con los logs y sin ocultar el navegador)
 *
 * Requiere:  cd dotrino-vault/web && npm run build
 *            cd dotrino-passmanager/extension && node build.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { scenario, runScenarios, startProxy, teardown, serveStatic, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
// `--logs` enseña los logs SIN abrir el navegador: en una máquina sin pantalla,
// `--verbose` (que además lo destapa) no es una opción, y entonces no había forma de ver
// qué pasa por el proxio.
const LOGS = VERBOSE || process.argv.includes('--logs')
const log = (m) => { if (LOGS) console.log(m) }

const CONSOLE_DIST = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const EXT = path.join(ROOT, 'dotrino-passmanager/extension')
const SITE_DIR = path.join(ROOT, 'dotrino-passmanager/web/test')

let proxy = null
let webConsole = null
let webIframe = null
let webSite = null
let context = null
let profileDir = null
let extId = null

/** El iframe de identidad de disco, con el proxio de aquí dentro. */
const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

/** La consola en modo bóveda: sin otra fuera, `/vault` enciende su propio mostrador. */
async function openConsole () {
  const page = await context.newPage()
  // El aviso se manda por el service worker. Aquí se anota en vez de enseñarse: lo que
  // se comprueba es que la bóveda avisa, no el aspecto del globo del sistema.
  await page.addInitScript(() => {
    window.__notices = []
    const hookNotifications = () => navigator.serviceWorker?.ready?.then((reg) => {
      if (!reg || reg.__spied) return
      reg.__spied = true
      const real = reg.showNotification?.bind(reg)
      void real
      reg.showNotification = (title, opts) => {
        window.__notices.push({ title, tag: opts?.tag, body: opts?.body })
        return Promise.resolve()
      }
    }).catch(() => {})
    hookNotifications()
    window.addEventListener('load', hookNotifications)
  })
  page.on('console', (m) => { if (LOGS || m.type() === 'error') console.log('   [console] ' + m.text()) })
  page.on('pageerror', (e) => console.log('   [console!] ' + e.message))
  await page.goto(`${webConsole.url}/vault?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}`)
  await page.waitForSelector('[data-testid="vault-at"][data-where="self"]', { timeout: 40000 })
  // El mostrador tiene que estar ATENDIENDO, no solo declarado: el botón que da el código
  // solo se habilita con la conexión al proxio en marcha.
  await page.waitForSelector('[data-testid="self-pair"]:not([disabled])', { timeout: 40000 })
  return page
}

async function openPopup () {
  const page = await context.newPage()
  page.on('console', (m) => { if (LOGS || m.type() === 'error') console.log('   [popup] ' + m.text()) })
  page.on('pageerror', (e) => console.log('   [popup!] ' + e.message))
  await page.goto(`chrome-extension://${extId}/src/popup.html`)
  await page.waitForTimeout(1500)
  return page
}

const ask = (page, op, payload) => page.evaluate(([op, payload]) => new Promise((r) =>
  chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])

// Lo que se comparte entre escenarios: emparejar una vez y usarlo después.
const state = { consolePage: null, popup: null }

scenario('the extension links to the tab vault', async () => {
  const consolePage = await openConsole()
  state.consolePage = consolePage

  // Los aparatos que ya hay, para reconocer al nuevo después.
  const before = new Set(await consolePage.locator('[data-member]').evaluateAll(
    (ns) => ns.map((n) => n.getAttribute('data-member'))))

  // 1. La bóveda emite la invitación. Es la misma cadena que codifica el QR.
  await consolePage.locator('[data-testid="self-pair"]').click()
  await consolePage.waitForSelector('[data-testid="self-invite"]', { timeout: 30000 })
  const invite = (await consolePage.locator('[data-testid="self-invite"] code.url').innerText()).trim()
  assert.ok(invite.length > 20, 'the vault gives an invite: ' + invite.slice(0, 40))

  // 2. La extensión la pega. Se llega por «añadir un perfil» → «conectar una que ya tengo»:
  //    enlazar SUMA una bóveda, no reemplaza la que ya hay (§3.3).
  const popup = await openPopup()
  state.popup = popup
  await popup.locator('[data-testid="profile-add"]').click()
  await popup.locator('[data-testid="add-linked"]').click()
  await popup.locator('[data-testid="invite"]').fill(invite)
  await popup.locator('[data-testid="pair"]').click()

  // 3. La extensión enseña SEIS caracteres. No viajan: la bóveda los aprende porque los
  //    escribe una persona, y por eso aprobar exige tener las dos pantallas delante.
  await popup.waitForSelector('[data-testid="pair-code"]', { timeout: 40000 })
  const code = (await popup.locator('[data-testid="pair-code"]').innerText()).trim()
  assert.match(code, /^[A-Za-z0-9]{4,8}$/, 'the code is short and typeable: ' + code)

  // 4. Y la bóveda ve al aparato esperando, y lo aprueba con ese código.
  await consolePage.waitForSelector('[data-testid="self-pending"]', { timeout: 40000 })
  await consolePage.locator('[data-testid="self-code"]').fill(code)
  await consolePage.locator('[data-testid="self-approve"]').click()

  // 5. El perfil de la extensión pasa a ser una bóveda CONECTADA.
  let st = null
  for (let i = 0; i < 60; i++) {
    st = (await ask(popup, 'status'))?.result
    if (st?.profile?.kind === 'linked') break
    await popup.waitForTimeout(1000)
  }
  if (st?.profile?.kind !== 'linked') {
    console.log('   [notice] the popup says:',
      JSON.stringify(await popup.locator('.error').allInnerTexts().catch(() => [])))
  }
  assert.equal(st?.profile?.kind, 'linked', 'the active profile lives outside the extension')
  assert.equal(st.profiles.length, 2, 'and its own one is still there: linking ADDS')

  // 6. Y AHORA EL PERMISO, que es un paso aparte y a propósito: emparejar mete al
  //    aparato en el acta, pero **pedir contraseñas es un permiso suyo** que da el dueño
  //    en la consola. Es lo que dice el mensaje que la extensión enseña si falta: «tu
  //    bóveda todavía no deja que este navegador pida contraseñas».
  await consolePage.waitForFunction((ya) => [...document.querySelectorAll('[data-member]')]
    .some((n) => !ya.includes(n.getAttribute('data-member'))), [...before], { timeout: 40000 })
  const newcomer = (await consolePage.locator('[data-member]').evaluateAll(
    (ns) => ns.map((n) => n.getAttribute('data-member'))))
    .find((idm) => !before.has(idm))
  assert.ok(newcomer, 'the console lists the new device in the record')

  await consolePage.locator(`[data-testid="acc-member-${newcomer}"]`).click()
  const capToggle = consolePage.locator(`[data-testid="cap-passwords-${newcomer}"]`)
  await capToggle.waitFor({ timeout: 15000 })
  assert.equal((await capToggle.getAttribute('class')).includes('on'), false,
    'the device joins WITHOUT the passwords permission: pairing is not authorizing')
  await capToggle.click()
  await consolePage.waitForTimeout(1500)

  // La consola se recarga a propósito: su mostrador de contraseñas refresca cada 5 s la
  // lista con la que decide QUIÉN puede pedir, pero la lista que se VE solo se repinta
  // cuando llega una petición. Recargando, las dos dicen lo mismo antes de seguir.
  await consolePage.reload()
  await consolePage.waitForSelector('[data-testid="vault-at"][data-where="self"]', { timeout: 40000 })
  await consolePage.locator('[data-testid="password-device"]').first().waitFor({ timeout: 40000 })
})

scenario('what the extension stores ends up in the tab vault', async () => {
  const { popup, consolePage } = state
  const entry = {
    title: 'localhost', sites: ['localhost'], name: 'La de la pestaña',
    username: 'ana@ejemplo.com', secret: 'hunter2',
    fields: [
      { kind: 'tel', label: 'Teléfono', value: '0999111222' },
      { label: 'Número de socio', value: 'SOC-4471', private: true },
    ],
  }
  const stored = await ask(popup, 'put', { entry })
  assert.ok(stored?.result?.id, 'the extension writes through the proxy: ' + JSON.stringify(stored?.error || ''))
  state.id = stored.result.id

  // Y la bóveda la tiene: lo dice su propia pantalla, que lee de su almacén, no del
  // mensaje que acaba de llegar.
  await consolePage.locator('.vault').getByText('localhost').first().waitFor({ timeout: 30000 })
  assert.match(await consolePage.locator('.vault').innerText(), /localhost/,
    'the vault shows the entry among its own, read from its own store')
})

scenario('find and fill go through the proxy, and only private data is asked about', async () => {
  const { popup, consolePage } = state

  const found = (await ask(popup, 'find', { url: 'https://localhost/entrar' }))?.result || []
  const mine = found.find((e) => e.id === state.id)
  assert.ok(mine, 'the extension finds the entry by asking for its domain')
  assert.equal(mine.hint, 'La de la pestaña', 'with the name computed by whoever CAN open it')
  assert.ok(mine.fieldKeys.includes('tel'), 'and with the NAMES of what it holds')
  assert.ok(mine.privateKeys.includes('label:Número de socio'), 'knowing which ones are private')
  assert.equal(JSON.stringify(found).includes('hunter2'), false, 'without a single value')

  // Un dato PÚBLICO no molesta a nadie: se pide por su clave y la bóveda no pregunta.
  const publicValue = await ask(popup, 'get', { id: state.id, keys: ['tel'] })
  assert.equal(JSON.parse(publicValue.result.fields)[0].value, '0999111222', 'the phone arrives')
  assert.equal(await consolePage.locator('[data-testid="approve"]').count(), 0,
    'and the vault has not asked anything')

  // Uno PRIVADO sí: y la pregunta sale en LA BÓVEDA, que es la otra pantalla. Esa es la
  // diferencia entera con la bóveda de dentro de la extensión.
  //
  // El orden importa y no es casual: **el no va primero**. La aprobación se recuerda por
  // APARATO (§2.0), así que en cuanto se dice que sí ya no vuelve a preguntar — probar el
  // no después sería probarlo cuando ya no puede pasar.
  const denied = ask(popup, 'get', { id: state.id, keys: ['secret'] })
  await consolePage.waitForSelector('[data-testid="deny"]', { timeout: 30000 })
  await consolePage.locator('[data-testid="deny"]').click()
  assert.ok((await denied)?.error, 'with a no, the extension gets nothing')

  const asked = ask(popup, 'get', { id: state.id, keys: ['secret'] })
  await consolePage.waitForSelector('[data-testid="approve"]', { timeout: 30000 })
  assert.ok(true, 'and it asks again: a no is never remembered')
  await consolePage.locator('[data-testid="approve"]').click()
  assert.equal((await asked)?.result?.secret, 'hunter2', 'with a yes, the password arrives')

  // Y de ahí en adelante NO vuelve a preguntar: lo aprobado es el aparato, no la
  // credencial. Es lo que hace que el gestor se pueda usar sin un dedo en cada campo.
  const again = await ask(popup, 'get', { id: state.id, keys: ['secret'] })
  assert.equal(again?.result?.secret, 'hunter2', 'the second time it arrives just the same')
  assert.equal(await consolePage.locator('[data-testid="approve"]').count(), 0,
    'and without asking: approval belongs to the DEVICE (§2.0)')
})

scenario('editing from the manager changes the vault copy, without fetching private data', async () => {
  const { popup, consolePage } = state

  // Es lo que hace el gestor al guardar: un `patch`, que fusiona DENTRO de la bóveda.
  const r = await ask(popup, 'patch', {
    id: state.id,
    changes: {
      name: 'Renombrada desde el gestor',
      fields: [{ kind: 'tel', label: 'Teléfono', value: '0988000111' }],
      sites: ['localhost', 'otro-dominio.example'],
    },
  })
  assert.ok(!r?.error, 'the patch travels: ' + JSON.stringify(r?.error || ''))
  assert.equal(await consolePage.locator('[data-testid="approve"]').count(), 0,
    'and writing does NOT ask for authorization, even with a private field inside')

  const found = (await ask(popup, 'find', { url: 'https://otro-dominio.example/' }))?.result || []
  const mine = found.find((e) => e.id === state.id)
  assert.ok(mine, 'the entry crosses to the new domain')
  assert.equal(mine.hint, 'Renombrada desde el gestor', 'with its new name')
  assert.ok(mine.privateKeys.includes('label:Número de socio'),
    'and the private field is still marked: the patch did not touch it')
})

scenario('the manager\'s domains and search also work when linked', async () => {
  const { popup } = state
  const sites = (await ask(popup, 'sites'))?.result || []
  assert.ok(sites.some((s) => s.site === 'localhost'), 'the vault says which domains have something')
  assert.equal(JSON.stringify(sites).includes('hunter2'), false, 'without a value inside')

  const matches = (await ask(popup, 'search', { q: 'otro-dominio' }))?.result || []
  assert.ok(matches.some((e) => e.id === state.id),
    'and text search reaches the entry even when you are not on its site')
})

scenario('with the tab in the background, the vault NOTIFIES instead of staying silent', async () => {
  const { popup, consolePage } = state

  // El interruptor está a la vista, y no se pide el permiso solo al abrir: un navegador
  // que pregunta sin que hayas pulsado nada es un navegador que molesta.
  assert.equal(await consolePage.locator('[data-testid="ring-enable"], [data-testid="ring-on"]').count(), 1,
    'the vault offers to turn on notifications')

  // La aprobación se recuerda por APARATO (§2.0) y ya se dijo que sí, así que no
  // volvería a preguntar. Se recarga la consola: la puerta vive en memoria, y apagar la
  // bóveda retira lo aprobado — eso es el diseño, no un atajo del test.
  await consolePage.reload()
  await consolePage.waitForSelector('[data-testid="vault-at"][data-where="self"]', { timeout: 40000 })
  await consolePage.locator('[data-testid="password-device"]').first().waitFor({ timeout: 40000 })
  await consolePage.evaluate(() => { window.__notices.length = 0 })

  // Y la pestaña deja de estar delante. En `--headless=new` TODAS se declaran visibles,
  // así que la condición se fuerza: lo que se prueba es qué hace la bóveda cuando nadie
  // la mira, no si Chrome sabe decirlo sin escritorio.
  await popup.bringToFront()
  await consolePage.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  })

  const asked = ask(popup, 'get', { id: state.id, keys: ['secret'] })
  await consolePage.waitForFunction(() => (window.__notices || []).length > 0, null, { timeout: 30000 })
  const notices = await consolePage.evaluate(() => window.__notices)
  assert.ok(notices.some((a) => a.tag === 'dotrino-vault-ask'),
    'it notifies that something is waiting: ' + JSON.stringify(notices))

  // Y la pregunta sigue en su sitio: el aviso llama, no decide.
  await consolePage.bringToFront()
  await consolePage.locator('[data-testid="approve"]').click()
  assert.equal((await asked)?.result?.secret, 'hunter2', 'and on coming back, it is answered from the screen')
})

// ---------- arranque ----------

console.log('\nSMOKE · the extension with the TAB vault, all local\n')
if (!fs.existsSync(path.join(CONSOLE_DIST, 'index.html'))) {
  console.error('Missing the console build:  cd dotrino-vault/web && npm run build\n')
  process.exit(2)
}
if (!fs.existsSync(path.join(EXT, 'src/vendor/passmanager/index.js'))) {
  console.error('Missing the extension vendor:  cd dotrino-passmanager/extension && node build.mjs\n')
  process.exit(2)
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  webConsole = await serveStatic(CONSOLE_DIST, { spa: true })
  webIframe = await serveStatic(IFRAME)
  webSite = await serveStatic(SITE_DIR)
  console.log(`  proxy     ${proxy.url}`)
  console.log(`  console   ${webConsole.url}/vault`)
  console.log(`  identity  ${webIframe.url}`)
  console.log(`  site      ${webSite.url}\n`)

  // Una extensión solo se carga en un contexto PERSISTENTE: no hay `newContext` que la
  // acepte. Y el service worker de MV3 es lo que da su id.
  profileDir = await mkdtemp(path.join(tmpdir(), 'smoke-password-manager-'))
  context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    locale: 'es-ES',
    args: [
      ...(VERBOSE ? [] : ['--headless=new']),
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
    ],
    viewport: { width: 1100, height: 900 },
  })
  // Los avisos, concedidos de entrada: es lo que hace el usuario al pulsar el botón, y
  // concederlos a mitad de camino obliga a recargar la consola en medio de la prueba.
  await context.grantPermissions(['notifications'])

  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 })
  extId = new URL(sw.url()).host
  console.log(`  extension ${extId}\n`)

  const ok = await runScenarios()
  await context?.close()
  await rm(profileDir, { recursive: true, force: true })
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { await context?.close() } catch (_) {}
  if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  await teardown()
  process.exit(1)
}
