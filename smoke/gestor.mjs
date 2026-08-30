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
 *   npm run smoke:gestor
 *   node smoke/gestor.mjs --verbose      (con los logs y sin ocultar el navegador)
 *
 * Requiere:  cd dotrino-vault/web && npm run build
 *            cd dotrino-passmanager/extension && node build.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { escenario, correr, startProxy, teardown, servirEstatico, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
// `--logs` enseña los logs SIN abrir el navegador: en una máquina sin pantalla,
// `--verbose` (que además lo destapa) no es una opción, y entonces no había forma de ver
// qué pasa por el proxio.
const LOGS = VERBOSE || process.argv.includes('--logs')
const log = (m) => { if (LOGS) console.log(m) }

const CONSOLA = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const EXT = path.join(ROOT, 'dotrino-passmanager/extension')
const SITIO = path.join(ROOT, 'dotrino-passmanager/web/test')

let proxy = null
let webConsola = null
let webIframe = null
let webSitio = null
let contexto = null
let perfilDir = null
let extId = null

/** El iframe de identidad de disco, con el proxio de aquí dentro. */
const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

/** La consola en modo bóveda: sin otra fuera, `/vault` enciende su propio mostrador. */
async function abrirConsola () {
  const page = await contexto.newPage()
  page.on('console', (m) => { if (LOGS || m.type() === 'error') console.log('   [consola] ' + m.text()) })
  page.on('pageerror', (e) => console.log('   [consola!] ' + e.message))
  await page.goto(`${webConsola.url}/vault?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}`)
  await page.waitForSelector('[data-testid="vault-at"][data-where="self"]', { timeout: 40000 })
  // El mostrador tiene que estar ATENDIENDO, no solo declarado: el botón que da el código
  // solo se habilita con la conexión al proxio en marcha.
  await page.waitForSelector('[data-testid="self-pair"]:not([disabled])', { timeout: 40000 })
  return page
}

async function abrirPopup () {
  const page = await contexto.newPage()
  page.on('console', (m) => { if (LOGS || m.type() === 'error') console.log('   [popup] ' + m.text()) })
  page.on('pageerror', (e) => console.log('   [popup!] ' + e.message))
  await page.goto(`chrome-extension://${extId}/src/popup.html`)
  await page.waitForTimeout(1500)
  return page
}

const pedir = (page, op, payload) => page.evaluate(([op, payload]) => new Promise((r) =>
  chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])

// Lo que se comparte entre escenarios: emparejar una vez y usarlo después.
const estado = { consola: null, popup: null }

escenario('la extensión se enlaza a la bóveda de la pestaña', async () => {
  const consola = await abrirConsola()
  estado.consola = consola

  // Los aparatos que ya hay, para reconocer al nuevo después.
  const antes = new Set(await consola.locator('[data-member]').evaluateAll(
    (ns) => ns.map((n) => n.getAttribute('data-member'))))

  // 1. La bóveda emite la invitación. Es la misma cadena que codifica el QR.
  await consola.locator('[data-testid="self-pair"]').click()
  await consola.waitForSelector('[data-testid="self-invite"]', { timeout: 30000 })
  const invitacion = (await consola.locator('[data-testid="self-invite"] code.url').innerText()).trim()
  assert.ok(invitacion.length > 20, 'la bóveda da una invitación: ' + invitacion.slice(0, 40))

  // 2. La extensión la pega. Se llega por «añadir un perfil» → «conectar una que ya tengo»:
  //    enlazar SUMA una bóveda, no reemplaza la que ya hay (§3.3).
  const popup = await abrirPopup()
  estado.popup = popup
  await popup.locator('[data-testid="profile-add"]').click()
  await popup.locator('[data-testid="add-linked"]').click()
  await popup.locator('[data-testid="invite"]').fill(invitacion)
  await popup.locator('[data-testid="pair"]').click()

  // 3. La extensión enseña SEIS caracteres. No viajan: la bóveda los aprende porque los
  //    escribe una persona, y por eso aprobar exige tener las dos pantallas delante.
  await popup.waitForSelector('[data-testid="pair-code"]', { timeout: 40000 })
  const codigo = (await popup.locator('[data-testid="pair-code"]').innerText()).trim()
  assert.match(codigo, /^[A-Za-z0-9]{4,8}$/, 'el código es corto y se puede teclear: ' + codigo)

  // 4. Y la bóveda ve al aparato esperando, y lo aprueba con ese código.
  await consola.waitForSelector('[data-testid="self-pending"]', { timeout: 40000 })
  await consola.locator('[data-testid="self-code"]').fill(codigo)
  await consola.locator('[data-testid="self-approve"]').click()

  // 5. El perfil de la extensión pasa a ser una bóveda CONECTADA.
  let st = null
  for (let i = 0; i < 60; i++) {
    st = (await pedir(popup, 'status'))?.result
    if (st?.profile?.kind === 'linked') break
    await popup.waitForTimeout(1000)
  }
  if (st?.profile?.kind !== 'linked') {
    console.log('   [aviso] el popup dice:',
      JSON.stringify(await popup.locator('.error').allInnerTexts().catch(() => [])))
  }
  assert.equal(st?.profile?.kind, 'linked', 'el perfil activo vive fuera de la extensión')
  assert.equal(st.profiles.length, 2, 'y el propio sigue estando: enlazar SUMA')

  // 6. Y AHORA EL PERMISO, que es un paso aparte y a propósito: emparejar mete al
  //    aparato en el acta, pero **pedir contraseñas es un permiso suyo** que da el dueño
  //    en la consola. Es lo que dice el mensaje que la extensión enseña si falta: «tu
  //    bóveda todavía no deja que este navegador pida contraseñas».
  await consola.waitForFunction((ya) => [...document.querySelectorAll('[data-member]')]
    .some((n) => !ya.includes(n.getAttribute('data-member'))), [...antes], { timeout: 40000 })
  const nuevo = (await consola.locator('[data-member]').evaluateAll(
    (ns) => ns.map((n) => n.getAttribute('data-member'))))
    .find((idm) => !antes.has(idm))
  assert.ok(nuevo, 'la consola lista al aparato nuevo en el acta')

  await consola.locator(`[data-testid="acc-member-${nuevo}"]`).click()
  const permiso = consola.locator(`[data-testid="cap-passwords-${nuevo}"]`)
  await permiso.waitFor({ timeout: 15000 })
  assert.equal((await permiso.getAttribute('class')).includes('on'), false,
    'el aparato entra SIN el permiso de contraseñas: emparejar no es autorizar')
  await permiso.click()
  await consola.waitForTimeout(1500)

  // La consola se recarga a propósito: su mostrador de contraseñas refresca cada 5 s la
  // lista con la que decide QUIÉN puede pedir, pero la lista que se VE solo se repinta
  // cuando llega una petición. Recargando, las dos dicen lo mismo antes de seguir.
  await consola.reload()
  await consola.waitForSelector('[data-testid="vault-at"][data-where="self"]', { timeout: 40000 })
  await consola.locator('[data-testid="password-device"]').first().waitFor({ timeout: 40000 })
})

escenario('lo que la extensión guarda queda en la bóveda de la pestaña', async () => {
  const { popup, consola } = estado
  const entrada = {
    title: 'localhost', sites: ['localhost'], name: 'La de la pestaña',
    username: 'ana@ejemplo.com', secret: 'hunter2',
    fields: [
      { kind: 'tel', label: 'Teléfono', value: '0999111222' },
      { label: 'Número de socio', value: 'SOC-4471', private: true },
    ],
  }
  const puesta = await pedir(popup, 'put', { entry: entrada })
  assert.ok(puesta?.result?.id, 'la extensión escribe a través del proxio: ' + JSON.stringify(puesta?.error || ''))
  estado.id = puesta.result.id

  // Y la bóveda la tiene: lo dice su propia pantalla, que lee de su almacén, no del
  // mensaje que acaba de llegar.
  await consola.locator('.vault').getByText('localhost').first().waitFor({ timeout: 30000 })
  assert.match(await consola.locator('.vault').innerText(), /localhost/,
    'la bóveda enseña la entrada entre las suyas, leída de su propio almacén')
})

escenario('buscar y rellenar van por el proxio, y solo lo privado se pregunta', async () => {
  const { popup, consola } = estado

  const hay = (await pedir(popup, 'find', { url: 'https://localhost/entrar' }))?.result || []
  const mia = hay.find((e) => e.id === estado.id)
  assert.ok(mia, 'la extensión encuentra la entrada preguntando por su dominio')
  assert.equal(mia.hint, 'La de la pestaña', 'con el nombre que calculó quien SÍ puede abrirla')
  assert.ok(mia.fieldKeys.includes('tel'), 'y con los NOMBRES de lo que lleva dentro')
  assert.ok(mia.privateKeys.includes('label:Número de socio'), 'sabiendo cuáles son privados')
  assert.equal(JSON.stringify(hay).includes('hunter2'), false, 'sin un solo valor')

  // Un dato PÚBLICO no molesta a nadie: se pide por su clave y la bóveda no pregunta.
  const publico = await pedir(popup, 'get', { id: estado.id, keys: ['tel'] })
  assert.equal(JSON.parse(publico.result.fields)[0].value, '0999111222', 'el teléfono llega')
  assert.equal(await consola.locator('[data-testid="approve"]').count(), 0,
    'y la bóveda no ha preguntado nada')

  // Uno PRIVADO sí: y la pregunta sale en LA BÓVEDA, que es la otra pantalla. Esa es la
  // diferencia entera con la bóveda de dentro de la extensión.
  //
  // El orden importa y no es casual: **el no va primero**. La aprobación se recuerda por
  // APARATO (§2.0), así que en cuanto se dice que sí ya no vuelve a preguntar — probar el
  // no después sería probarlo cuando ya no puede pasar.
  const negar = pedir(popup, 'get', { id: estado.id, keys: ['secret'] })
  await consola.waitForSelector('[data-testid="deny"]', { timeout: 30000 })
  await consola.locator('[data-testid="deny"]').click()
  assert.ok((await negar)?.error, 'con el no, la extensión se queda sin nada')

  const pide = pedir(popup, 'get', { id: estado.id, keys: ['secret'] })
  await consola.waitForSelector('[data-testid="approve"]', { timeout: 30000 })
  assert.ok(true, 'y vuelve a preguntar: un no no se recuerda nunca')
  await consola.locator('[data-testid="approve"]').click()
  assert.equal((await pide)?.result?.secret, 'hunter2', 'con el sí, la contraseña llega')

  // Y de ahí en adelante NO vuelve a preguntar: lo aprobado es el aparato, no la
  // credencial. Es lo que hace que el gestor se pueda usar sin un dedo en cada campo.
  const otra = await pedir(popup, 'get', { id: estado.id, keys: ['secret'] })
  assert.equal(otra?.result?.secret, 'hunter2', 'la segunda vez llega igual')
  assert.equal(await consola.locator('[data-testid="approve"]').count(), 0,
    'y sin preguntar: la aprobación es del APARATO (§2.0)')
})

escenario('editar desde el gestor cambia lo de la bóveda, sin traerse lo privado', async () => {
  const { popup, consola } = estado

  // Es lo que hace el gestor al guardar: un `patch`, que fusiona DENTRO de la bóveda.
  const r = await pedir(popup, 'patch', {
    id: estado.id,
    changes: {
      name: 'Renombrada desde el gestor',
      fields: [{ kind: 'tel', label: 'Teléfono', value: '0988000111' }],
      sites: ['localhost', 'otro-dominio.example'],
    },
  })
  assert.ok(!r?.error, 'el patch viaja: ' + JSON.stringify(r?.error || ''))
  assert.equal(await consola.locator('[data-testid="approve"]').count(), 0,
    'y escribir NO pide autorización, ni siquiera con un privado dentro')

  const hay = (await pedir(popup, 'find', { url: 'https://otro-dominio.example/' }))?.result || []
  const mia = hay.find((e) => e.id === estado.id)
  assert.ok(mia, 'el registro cruza al dominio nuevo')
  assert.equal(mia.hint, 'Renombrada desde el gestor', 'con su nombre nuevo')
  assert.ok(mia.privateKeys.includes('label:Número de socio'),
    'y lo privado sigue marcado: el patch no lo tocó')
})

escenario('los dominios y el buscador del gestor también funcionan enlazados', async () => {
  const { popup } = estado
  const sitios = (await pedir(popup, 'sites'))?.result || []
  assert.ok(sitios.some((s) => s.site === 'localhost'), 'la bóveda dice en qué dominios hay algo')
  assert.equal(JSON.stringify(sitios).includes('hunter2'), false, 'sin un valor dentro')

  const encontrado = (await pedir(popup, 'search', { q: 'otro-dominio' }))?.result || []
  assert.ok(encontrado.some((e) => e.id === estado.id),
    'y buscar por texto llega a la entrada aunque no estés en su sitio')
})

// ---------- arranque ----------

console.log('\nSMOKE · la extensión con la bóveda de PESTAÑA, todo en local\n')
if (!fs.existsSync(path.join(CONSOLA, 'index.html'))) {
  console.error('Falta el build de la consola:  cd dotrino-vault/web && npm run build\n')
  process.exit(2)
}
if (!fs.existsSync(path.join(EXT, 'src/vendor/passmanager/index.js'))) {
  console.error('Falta el vendor de la extensión:  cd dotrino-passmanager/extension && node build.mjs\n')
  process.exit(2)
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  webConsola = await servirEstatico(CONSOLA, { spa: true })
  webIframe = await servirEstatico(IFRAME)
  webSitio = await servirEstatico(SITIO)
  console.log(`  proxy     ${proxy.url}`)
  console.log(`  consola   ${webConsola.url}/vault`)
  console.log(`  identidad ${webIframe.url}`)
  console.log(`  sitio     ${webSitio.url}\n`)

  // Una extensión solo se carga en un contexto PERSISTENTE: no hay `newContext` que la
  // acepte. Y el service worker de MV3 es lo que da su id.
  perfilDir = await mkdtemp(path.join(tmpdir(), 'smoke-gestor-'))
  contexto = await chromium.launchPersistentContext(perfilDir, {
    headless: false,
    locale: 'es-ES',
    args: [
      ...(VERBOSE ? [] : ['--headless=new']),
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
    ],
    viewport: { width: 1100, height: 900 },
  })
  const sw = contexto.serviceWorkers()[0] || await contexto.waitForEvent('serviceworker', { timeout: 20000 })
  extId = new URL(sw.url()).host
  console.log(`  extensión ${extId}\n`)

  const ok = await correr()
  await contexto?.close()
  await rm(perfilDir, { recursive: true, force: true })
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  try { await contexto?.close() } catch (_) {}
  if (perfilDir) await rm(perfilDir, { recursive: true, force: true }).catch(() => {})
  await teardown()
  process.exit(1)
}
