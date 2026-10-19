/**
 * LA EXTENSIÓN CON EL VAULT DEMONIO — la tercera vía, y la que no admite peros.
 *
 * Las otras dos ya están probadas: la bóveda de dentro de la extensión (en su propio
 * repo) y la bóveda de PESTAÑA (`smoke/password-manager.mjs`). Esta es la de siempre: el daemon del
 * PC, encendido, con su bitácora y su política completa.
 *
 * **Aquí no hay timbre que valga.** El daemon es de alta disponibilidad: no hay que
 * despertarlo, no hay cola que baje después, no hay ventana en la que se pierda un
 * pedido. Si algo no contesta, es un fallo — no una limitación conocida.
 *
 * Y las aprobaciones se prueban COMO SON: el daemon no tiene pantalla, así que quien
 * aprueba es otro aparato del acta con el permiso `aprueba` — la app de Android o una
 * pestaña enrolada. Aquí es la pestaña, que es lo que se puede levantar en local.
 *
 *   npm run smoke:daemon
 *   node smoke/daemon.mjs --logs        (con los logs, sin abrir el navegador)
 *
 * Requiere:  cd dotrino-vault/web && npm run build
 *            cd dotrino-passmanager/extension && node build.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { scenario, runScenarios, startProxy, startVault, teardown, serveStatic, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const LOGS = VERBOSE || process.argv.includes('--logs')
const log = (m) => { if (LOGS) console.log(m) }

const CONSOLE_DIST = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const EXT = path.join(ROOT, 'dotrino-passmanager/extension')

let proxy = null
let vault = null
let webConsole = null
let webIframe = null
let context = null
let profileDir = null
let extId = null
// El SEGUNDO navegador: otro aparato de verdad, con su propia identidad y su propio
// enlace a la misma bóveda. Hace falta para probar que la extensión APRUEBA, porque
// nadie aprueba su propio pedido.
let context2 = null
let profileDir2 = null

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

/**
 * Una pantalla de la consola. `ruta` es `/vault` (administrar) o **`/approvals`** (solo
 * decir sí o no): son dos pantallas distintas a propósito — una es administrativa y la
 * otra es un proceso, y mezclarlas es lo que la §5.1 no quiere.
 */
async function openConsole (hash = '', route = '/vault') {
  const page = await context.newPage()
  page.on('console', (m) => { if (LOGS || m.type() === 'error') console.log('   [console] ' + m.text()) })
  page.on('pageerror', (e) => console.log('   [console!] ' + e.message))
  await page.goto(`${webConsole.url}${route}?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}${hash}`)
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

/**
 * Esperar a que el daemon diga algo por su salida.
 *
 * Los permisos del acta no son inmediatos a propósito: el daemon la relee cada pocos
 * segundos y **entonces** levanta (o cierra) su mostrador de contraseñas. Esperar a que lo
 * diga es más honesto que dormir un número inventado de milisegundos.
 */
async function waitForLog (fragment, ms = 30000) {
  const t = Date.now() + ms
  while (Date.now() < t) {
    if (vault.log().includes(fragment)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`the daemon never said «${fragment}». Its output:\n` + vault.log().slice(-1500))
}

/** Los permisos de un miembro, sumando los que ya tenía: `caps` reemplaza la lista. */
async function grantPermission (pub, ...added) {
  const acta = await vault.members()
  const m = (acta.members || []).find((x) => x.pub === pub)
  const caps = new Set([...(m?.caps || []), ...added])
  await vault.caps(pub, [...caps])
  return [...caps]
}

const state = {}

scenario('a tab enrolls with the daemon and becomes a device that APPROVES', async () => {
  // El daemon no tiene pantalla: quien aprueba es otro aparato del acta con el permiso
  // `aprueba` — la app de Android, o una pestaña como esta.
  const qr = await vault.pair({ label: 'approver' })
  const page = await openConsole('#vault=' + b64url(qr))
  state.approver = page

  const digits = page.locator('[data-testid="pair-code"] .digits')
  await digits.waitFor({ timeout: 40000 })
  const code = (await digits.innerText()).trim()
  assert.match(code, /^\d{6}$/, 'the tab shows six digits to type into the vault')

  const deviceId = await vault.waitPending()
  log('[vault] pending: ' + deviceId)
  vault.approve(code)
  await page.waitForFunction(() => !document.querySelector('[data-testid="pair-code"]'),
    null, { timeout: 40000 })

  // Ya es miembro. Ahora el permiso de aprobar, que es lo que la convierte en el aparato
  // al que el daemon le va a preguntar.
  const acta = await vault.members()
  const own = (acta.members || []).find((m) => !m.isMaster && (m.label || '').includes('approver'))
    || (acta.members || []).find((m) => !m.isMaster)
  assert.ok(own, 'the tab is in the record: ' + JSON.stringify((acta.members || []).map((m) => m.label)))
  state.approverPub = own.pub
  const caps = await grantPermission(own.pub, 'approve')
  assert.ok(caps.includes('approve'), 'and it is given the approve permission: ' + caps.join(' '))
})

scenario('the extension links to the daemon', async () => {
  const qr = await vault.pair({ label: 'extension' })
  const popup = await openPopup()
  state.popup = popup

  await popup.locator('[data-testid="profile-add"]').click()
  await popup.locator('[data-testid="add-linked"]').click()
  await popup.locator('[data-testid="invite"]').fill(b64url(qr))
  await popup.locator('[data-testid="pair"]').click()

  await popup.waitForSelector('[data-testid="pair-code"]', { timeout: 40000 })
  const code = (await popup.locator('[data-testid="pair-code"]').innerText()).trim()
  const deviceId = await vault.waitPending()
  log('[vault] pending: ' + deviceId)
  vault.approve(code)

  let st = null
  for (let i = 0; i < 60; i++) {
    st = (await ask(popup, 'status'))?.result
    if (st?.profile?.kind === 'linked') break
    await popup.waitForTimeout(1000)
  }
  assert.equal(st?.profile?.kind, 'linked', 'the active profile lives in the daemon')

  // Y el permiso de pedir contraseñas, que es aparte de estar en el acta.
  const acta = await vault.members()
  const ext = (acta.members || []).find((m) => (m.label || '').includes('extension'))
  assert.ok(ext, 'the extension is in the record')
  state.extPub = ext.pub
  const caps = await grantPermission(ext.pub, 'passwords')
  assert.ok(caps.includes('passwords'), 'with the passwords permission: ' + caps.join(' '))

  // Y el daemon abre su mostrador al releer el acta: hasta entonces no hay a quién
  // responder, y una petición se quedaría sin contestar.
  await waitForLog('passwords: serving')
  assert.ok(true, 'the daemon opens its password counter')
})

scenario('save and read public data: without asking anyone', async () => {
  const { popup } = state
  const saved = await ask(popup, 'put', { entry: {
    title: 'banco.example', sites: ['banco.example'], name: 'La del banco',
    username: 'ana@ejemplo.com', secret: 'hunter2',
    fields: [
      { kind: 'tel', label: 'Teléfono', value: '0999111222' },
      { label: 'Número de socio', value: 'SOC-4471', private: true },
    ],
  } })
  assert.ok(saved?.result?.id, 'the extension writes to the daemon: ' + JSON.stringify(saved?.error || ''))
  state.id = saved.result.id

  const found = (await ask(popup, 'find', { url: 'https://banco.example/entrar' }))?.result || []
  const mine = found.find((e) => e.id === state.id)
  assert.ok(mine, 'and finds it by its domain')
  assert.equal(mine.hint, 'La del banco', 'with the name computed by whoever can open it')
  assert.equal(JSON.stringify(found).includes('hunter2'), false, 'without a single value')

  const publicField = await ask(popup, 'get', { id: state.id, keys: ['tel'] })
  assert.equal(JSON.parse(publicField.result.fields)[0].value, '0999111222',
    'a public field arrives without anyone approving anything')
})

scenario('WITH the `unattended` permission, private data arrives without asking', async () => {
  // El defecto se dio la vuelta en 0.79.0: SIN el permiso se pide aprobación. Que un
  // aparato se lleve claves privadas solo es ahora una concesión explícita, no lo que pasa
  // por omisión — antes nacía pudiendo y nadie elegía eso.
  await vault.unattended(state.extPub, true)
  const opened = await ask(state.popup, 'get', { id: state.id, keys: ['secret'] })
  assert.equal(opened?.result?.secret, 'hunter2', 'the password arrives without asking')
})

scenario('WITHOUT the permission, private data goes through the APPROVER', async () => {
  const { popup } = state

  await vault.unattended(state.extPub, false)

  // El aparato que aprueba mira su pantalla de PEDIDOS, que es otra ruta: `/vault` es para
  // administrar y `/approvals` es solo para decir sí o no.
  const requests = await openConsole('', '/approvals')
  state.requests = requests
  await requests.waitForSelector('[data-testid="apv-none"], [data-testid="apv-item"], [data-testid="apv-nocap"]',
    { timeout: 40000 })

  // Un permiso nuevo no es inmediato en el aparato, y no es un fallo: el acta se le
  // entrega al abrir la identidad y ENTONCES renueva su papel, porque quien decide qué
  // puede un aparato es el acta y no la pantalla. Hasta que llega, dice que no puede.
  await requests.waitForFunction(
    () => !document.querySelector('[data-testid="apv-nocap"]'),
    null, { timeout: 60000 })
  assert.equal(await requests.locator('[data-testid="apv-nocap"]').count(), 0,
    'this tab CAN approve: its certificate caught up with the record')

  // 1. Un NO. Va primero: la aprobación se recuerda mientras el vault siga encendido, así
  //    que después del sí ya no habría nada que probar.
  const denyCall = ask(popup, 'get', { id: state.id, keys: ['secret'] })
  const pending = requests.locator('[data-testid="apv-item"]').first()
  try {
    await pending.waitFor({ timeout: 40000 })
  } catch (e) {
    console.log('   [diag] nocap:', await requests.locator('[data-testid="apv-nocap"]').count(),
      '· empty:', await requests.locator('[data-testid="apv-none"]').count())
    throw e
  }
  assert.ok(await requests.locator('[data-testid="apv-deny"]').first().isVisible(),
    'the request shows up on the approving device, not in the daemon')
  await requests.locator('[data-testid="apv-deny"]').first().click()
  const denied = await denyCall
  assert.ok(denied?.error, 'after the no, the extension gets nothing: ' + JSON.stringify(denied))

  // 2. Y un SÍ.
  const askCall = ask(popup, 'get', { id: state.id, keys: ['secret'] })
  await requests.locator('[data-testid="apv-item"]').first().waitFor({ timeout: 40000 })
  await requests.locator('[data-testid="apv-approve"]').first().click()
  assert.equal((await askCall)?.result?.secret, 'hunter2', 'after the yes, the password arrives')

  // 3. Y de ahí en adelante ya no pregunta: lo aprobado es el APARATO (§2.0). Se mide por
  //    lo que importa —que NADIE tenga que tocar nada— y no por lo que enseñe una lista
  //    que se repinta cada cinco segundos: si hiciera falta aprobar, esto se quedaría
  //    esperando a un dedo que no va a llegar.
  const t0 = Date.now()
  const again = await ask(popup, 'get', { id: state.id, keys: ['secret'] })
  const ms = Date.now() - t0
  assert.equal(again?.result?.secret, 'hunter2', 'the second time it arrives too')
  assert.ok(ms < 3000, `and without asking again: it arrived in ${ms} ms, with nobody pressing anything`)
})

scenario('the whole password manager works against the daemon', async () => {
  const { popup } = state

  // Editar: nombre, un valor, quitar y cruzar de dominio, todo en un `patch`.
  const r = await ask(popup, 'patch', {
    id: state.id,
    changes: {
      name: 'Renombrada contra el daemon',
      fields: [{ kind: 'tel', label: 'Teléfono', value: '0988000111' }],
      sites: ['banco.example', 'bancoapp.example'],
    },
  })
  assert.ok(!r?.error, 'the patch goes through: ' + JSON.stringify(r?.error || ''))

  const found = (await ask(popup, 'find', { url: 'https://bancoapp.example/' }))?.result || []
  const mine = found.find((e) => e.id === state.id)
  assert.ok(mine, 'the entry moves to the new domain')
  assert.equal(mine.hint, 'Renombrada contra el daemon', 'with its new name')
  assert.ok(mine.privateKeys.includes('label:Número de socio'), 'and the private field is still marked')

  const sites = (await ask(popup, 'sites'))?.result || []
  assert.ok(sites.some((s) => s.site === 'banco.example'), 'the manager domains')
  const searched = (await ask(popup, 'search', { q: 'bancoapp' }))?.result || []
  assert.ok(searched.some((e) => e.id === state.id), 'and the search')

  await ask(popup, 'remove', { id: state.id, url: 'https://banco.example/' })
  const after = (await ask(popup, 'find', { url: 'https://banco.example/' }))?.result || []
  assert.equal(after.some((e) => e.id === state.id), false, 'and removing an entry removes it')
})

scenario('high availability: nothing is queued and nothing is slow', async () => {
  // El daemon está encendido siempre, así que ninguna de estas cinco tiene por qué
  // esperar a nadie. Si una tardara segundos, sería que se está encolando algo — que es
  // justo lo que aquí NO debe pasar.
  const { popup } = state
  const t0 = Date.now()
  for (let i = 0; i < 5; i++) {
    const r = await ask(popup, 'find', { url: 'https://banco.example/' })
    assert.ok(!r?.error, 'round trip ' + (i + 1) + ' answers: ' + JSON.stringify(r?.error || ''))
  }
  const ms = Date.now() - t0
  assert.ok(ms < 5000, `five full round trips in ${ms} ms, without waiting for anyone`)
  console.log(`         (five round trips through the proxy in ${ms} ms)`)
})

scenario('the EXTENSION itself can be the approving device', async () => {
  const { popup } = state

  // 1. El permiso de aprobar, también para la extensión (dueño, 2026-08-30).
  const caps = await grantPermission(state.extPub, 'approve')
  assert.ok(caps.includes('approve'), 'the extension has both permissions: ' + caps.join(' '))

  // 2. Y OTRO aparato que pida: un segundo navegador con la misma extensión, que es un
  //    aparato distinto —su propia llave, su propio papel—. Nadie aprueba lo suyo.
  const { chromium } = await import('playwright')
  profileDir2 = await mkdtemp(path.join(tmpdir(), 'smoke-daemon-2-'))
  context2 = await chromium.launchPersistentContext(profileDir2, {
    headless: false,
    locale: 'es-ES',
    args: [
      ...(VERBOSE ? [] : ['--headless=new']),
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
    ],
    viewport: { width: 900, height: 800 },
  })
  const sw2 = context2.serviceWorkers()[0] || await context2.waitForEvent('serviceworker', { timeout: 20000 })
  const extId2 = new URL(sw2.url()).host
  const popup2 = await context2.newPage()
  popup2.on('pageerror', (e) => console.log('   [popup2!] ' + e.message))
  await popup2.goto(`chrome-extension://${extId2}/src/popup.html`)
  await popup2.waitForTimeout(1500)

  const qr = await vault.pair({ label: 'second' })
  await popup2.locator('[data-testid="profile-add"]').click()
  await popup2.locator('[data-testid="add-linked"]').click()
  await popup2.locator('[data-testid="invite"]').fill(b64url(qr))
  await popup2.locator('[data-testid="pair"]').click()
  await popup2.waitForSelector('[data-testid="pair-code"]', { timeout: 40000 })
  const code = (await popup2.locator('[data-testid="pair-code"]').innerText()).trim()
  await vault.waitPending()
  vault.approve(code)
  for (let i = 0; i < 60; i++) {
    const st = (await ask(popup2, 'status'))?.result
    if (st?.profile?.kind === 'linked') break
    await popup2.waitForTimeout(1000)
  }

  const acta = await vault.members()
  const second = (acta.members || []).find((m) => (m.label || '').includes('second'))
  assert.ok(second, 'the second device is in the record')
  await grantPermission(second.pub, 'passwords')
  // Sin `unattended` lo suyo pasa por un aprobador, que es el defecto desde 0.79.0.

  // El mostrador ya estaba abierto, así que no vuelve a anunciarse: lo que cambia es la
  // lista de quién puede pedir, y esa la relee el daemon cada pocos segundos. Se insiste
  // hasta que lo reconoce en vez de dormir un número inventado.
  let newId = null
  let lastError = null
  for (let i = 0; i < 12; i++) {
    const r = await ask(popup2, 'put', { entry: {
      title: 'otro.example', sites: ['otro.example'], username: 'beto@ejemplo.com', secret: 'quetal',
    } })
    if (r?.result?.id) { newId = r.result.id; break }
    lastError = r?.error
    await popup2.waitForTimeout(2000)
  }
  assert.ok(newId, 'the second device writes to the same vault: ' + JSON.stringify(lastError))
  const askCall = ask(popup2, 'get', { id: newId, keys: ['secret'] })

  // 4. Y EL MISMO PEDIDO SALE EN LOS DOS SITIOS A LA VEZ: la pestaña de pedidos y la
  //    extensión, que son dos aparatos con el permiso de aprobar.
  await state.requests.reload()
  await state.requests.locator('[data-testid="apv-item"]').first().waitFor({ timeout: 40000 })
  // La extensión también tiene que enterarse de su permiso nuevo: su papel se pone al día
  // con el acta, igual que le pasó a la pestaña. Se insiste, recargando el popup.
  let approvals = null
  for (let i = 0; i < 20; i++) {
    approvals = (await ask(popup, 'approvals'))?.result
    if (approvals?.can && approvals.items.length) break
    await popup.waitForTimeout(3000)
    if (i % 3 === 2) await popup.reload()
  }
  assert.ok(approvals?.can, 'the extension can approve: its certificate caught up with the record')
  assert.ok(approvals.items.length, 'and sees the pending request: ' + JSON.stringify(approvals))

  await popup.reload()
  const inExtension = popup.locator('[data-testid^="popup-apv-"]').first()
  await inExtension.waitFor({ timeout: 40000 })
  assert.ok(true, 'the same request is in the tab AND in the extension')

  // 5. Se contesta DESDE LA EXTENSIÓN.
  await popup.locator('[data-testid^="popup-apv-yes-"]').first().click()
  assert.equal((await askCall)?.result?.secret, 'quetal',
    'the extension approves and the other device receives its key')

  // 6. Y el pedido desaparece de la otra pantalla: se contestó una vez, no dos.
  await state.requests.waitForFunction(
    () => !document.querySelector('[data-testid="apv-item"]'), null, { timeout: 40000 })
  assert.ok(true, 'and it disappears from the other screen, because it is already answered')
})

// ---------- arranque ----------

console.log('\nSMOKE · the extension with the DAEMON VAULT, all local\n')
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
  vault = await startVault({ proxyUrl: proxy.url, name: 'daemon', log })
  webConsole = await serveStatic(CONSOLE_DIST, { spa: true })
  webIframe = await serveStatic(IFRAME)
  console.log(`  proxy     ${proxy.url}`)
  console.log(`  daemon    pid ${vault.pid}`)
  console.log(`  console   ${webConsole.url}/vault`)

  profileDir = await mkdtemp(path.join(tmpdir(), 'smoke-daemon-'))
  context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    locale: 'es-ES',
    args: [
      ...(VERBOSE ? [] : ['--headless=new']),
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
    ],
    viewport: { width: 1100, height: 900 },
  })
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 })
  extId = new URL(sw.url()).host
  console.log(`  extension ${extId}\n`)

  const ok = await runScenarios()
  try { await context2?.close() } catch (_) {}
  if (profileDir2) await rm(profileDir2, { recursive: true, force: true }).catch(() => {})
  if (!ok) console.log('\n--- what the daemon said ---\n' + vault.log().slice(-2600))
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
