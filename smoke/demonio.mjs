/**
 * LA EXTENSIÓN CON EL VAULT DEMONIO — la tercera vía, y la que no admite peros.
 *
 * Las otras dos ya están probadas: la bóveda de dentro de la extensión (en su propio
 * repo) y la bóveda de PESTAÑA (`smoke/gestor.mjs`). Esta es la de siempre: el daemon del
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
 *   npm run smoke:demonio
 *   node smoke/demonio.mjs --logs        (con los logs, sin abrir el navegador)
 *
 * Requiere:  cd dotrino-vault/web && npm run build
 *            cd dotrino-passmanager/extension && node build.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { escenario, correr, startProxy, startVault, teardown, servirEstatico, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const LOGS = VERBOSE || process.argv.includes('--logs')
const log = (m) => { if (LOGS) console.log(m) }

const CONSOLA = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const EXT = path.join(ROOT, 'dotrino-passmanager/extension')

let proxy = null
let vault = null
let webConsola = null
let webIframe = null
let contexto = null
let perfilDir = null
let extId = null
// El SEGUNDO navegador: otro aparato de verdad, con su propia identidad y su propio
// enlace a la misma bóveda. Hace falta para probar que la extensión APRUEBA, porque
// nadie aprueba su propio pedido.
let contexto2 = null
let perfilDir2 = null

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

/**
 * Una pantalla de la consola. `ruta` es `/vault` (administrar) o **`/approvals`** (solo
 * decir sí o no): son dos pantallas distintas a propósito — una es administrativa y la
 * otra es un proceso, y mezclarlas es lo que la §5.1 no quiere.
 */
async function abrirConsola (hash = '', ruta = '/vault') {
  const page = await contexto.newPage()
  page.on('console', (m) => { if (LOGS || m.type() === 'error') console.log('   [consola] ' + m.text()) })
  page.on('pageerror', (e) => console.log('   [consola!] ' + e.message))
  await page.goto(`${webConsola.url}${ruta}?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}${hash}`)
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

/**
 * Esperar a que el daemon diga algo por su salida.
 *
 * Los permisos del acta no son inmediatos a propósito: el daemon la relee cada pocos
 * segundos y **entonces** levanta (o cierra) su mostrador de contraseñas. Esperar a que lo
 * diga es más honesto que dormir un número inventado de milisegundos.
 */
async function esperarLog (trozo, ms = 30000) {
  const t = Date.now() + ms
  while (Date.now() < t) {
    if (vault.log().includes(trozo)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`el daemon nunca dijo «${trozo}». Su salida:\n` + vault.log().slice(-1500))
}

/** Los permisos de un miembro, sumando los que ya tenía: `caps` reemplaza la lista. */
async function darPermiso (pub, ...nuevos) {
  const acta = await vault.members()
  const m = (acta.members || []).find((x) => x.pub === pub)
  const caps = new Set([...(m?.caps || []), ...nuevos])
  await vault.caps(pub, [...caps])
  return [...caps]
}

const estado = {}

escenario('una pestaña se enrola en el demonio y queda como aparato que APRUEBA', async () => {
  // El daemon no tiene pantalla: quien aprueba es otro aparato del acta con el permiso
  // `aprueba` — la app de Android, o una pestaña como esta.
  const qr = await vault.pair({ label: 'aprobador' })
  const page = await abrirConsola('#vault=' + b64url(qr))
  estado.aprobador = page

  const caja = page.locator('[data-testid="pair-code"] .digits')
  await caja.waitFor({ timeout: 40000 })
  const code = (await caja.innerText()).trim()
  assert.match(code, /^\d{6}$/, 'la pestaña enseña seis dígitos para teclear en la bóveda')

  const deviceId = await vault.waitPending()
  log('[bóveda] pendiente: ' + deviceId)
  vault.approve(code)
  await page.waitForFunction(() => !document.querySelector('[data-testid="pair-code"]'),
    null, { timeout: 40000 })

  // Ya es miembro. Ahora el permiso de aprobar, que es lo que la convierte en el aparato
  // al que el daemon le va a preguntar.
  const acta = await vault.members()
  const suyo = (acta.members || []).find((m) => !m.isMaster && (m.label || '').includes('aprobador'))
    || (acta.members || []).find((m) => !m.isMaster)
  assert.ok(suyo, 'la pestaña está en el acta: ' + JSON.stringify((acta.members || []).map((m) => m.label)))
  estado.aprobadorPub = suyo.pub
  const caps = await darPermiso(suyo.pub, 'approve')
  assert.ok(caps.includes('approve'), 'y se le da el permiso de aprobar: ' + caps.join(' '))
})

escenario('la extensión se enlaza al demonio', async () => {
  const qr = await vault.pair({ label: 'extension' })
  const popup = await abrirPopup()
  estado.popup = popup

  await popup.locator('[data-testid="profile-add"]').click()
  await popup.locator('[data-testid="add-linked"]').click()
  await popup.locator('[data-testid="invite"]').fill(b64url(qr))
  await popup.locator('[data-testid="pair"]').click()

  await popup.waitForSelector('[data-testid="pair-code"]', { timeout: 40000 })
  const code = (await popup.locator('[data-testid="pair-code"]').innerText()).trim()
  const deviceId = await vault.waitPending()
  log('[bóveda] pendiente: ' + deviceId)
  vault.approve(code)

  let st = null
  for (let i = 0; i < 60; i++) {
    st = (await pedir(popup, 'status'))?.result
    if (st?.profile?.kind === 'linked') break
    await popup.waitForTimeout(1000)
  }
  assert.equal(st?.profile?.kind, 'linked', 'el perfil activo vive en el daemon')

  // Y el permiso de pedir contraseñas, que es aparte de estar en el acta.
  const acta = await vault.members()
  const ext = (acta.members || []).find((m) => (m.label || '').includes('extension'))
  assert.ok(ext, 'la extensión está en el acta')
  estado.extPub = ext.pub
  const caps = await darPermiso(ext.pub, 'passwords')
  assert.ok(caps.includes('passwords'), 'con el permiso de contraseñas: ' + caps.join(' '))

  // Y el daemon abre su mostrador al releer el acta: hasta entonces no hay a quién
  // responder, y una petición se quedaría sin contestar.
  await esperarLog('passwords: serving')
  assert.ok(true, 'el daemon abre su mostrador de contraseñas')
})

escenario('guardar y leer lo público: sin preguntarle a nadie', async () => {
  const { popup } = estado
  const puesta = await pedir(popup, 'put', { entry: {
    title: 'banco.example', sites: ['banco.example'], name: 'La del banco',
    username: 'ana@ejemplo.com', secret: 'hunter2',
    fields: [
      { kind: 'tel', label: 'Teléfono', value: '0999111222' },
      { label: 'Número de socio', value: 'SOC-4471', private: true },
    ],
  } })
  assert.ok(puesta?.result?.id, 'la extensión escribe en el daemon: ' + JSON.stringify(puesta?.error || ''))
  estado.id = puesta.result.id

  const hay = (await pedir(popup, 'find', { url: 'https://banco.example/entrar' }))?.result || []
  const mia = hay.find((e) => e.id === estado.id)
  assert.ok(mia, 'y la encuentra por su dominio')
  assert.equal(mia.hint, 'La del banco', 'con el nombre que calculó quien puede abrirla')
  assert.equal(JSON.stringify(hay).includes('hunter2'), false, 'sin un solo valor')

  const publico = await pedir(popup, 'get', { id: estado.id, keys: ['tel'] })
  assert.equal(JSON.parse(publico.result.fields)[0].value, '0999111222',
    'un dato público llega sin que nadie apruebe nada')
})

escenario('CON el permiso `unattended`, lo privado llega sin preguntar', async () => {
  // El defecto se dio la vuelta en 0.79.0: SIN el permiso se pide aprobación. Que un
  // aparato se lleve claves privadas solo es ahora una concesión explícita, no lo que pasa
  // por omisión — antes nacía pudiendo y nadie elegía eso.
  await vault.unattended(estado.extPub, true)
  const abierta = await pedir(estado.popup, 'get', { id: estado.id, keys: ['secret'] })
  assert.equal(abierta?.result?.secret, 'hunter2', 'la contraseña llega sin preguntar')
})

escenario('SIN el permiso, lo privado pasa por el APROBADOR', async () => {
  const { popup } = estado

  await vault.unattended(estado.extPub, false)

  // El aparato que aprueba mira su pantalla de PEDIDOS, que es otra ruta: `/vault` es para
  // administrar y `/approvals` es solo para decir sí o no.
  const pedidos = await abrirConsola('', '/approvals')
  estado.pedidos = pedidos
  await pedidos.waitForSelector('[data-testid="apv-none"], [data-testid="apv-item"], [data-testid="apv-nocap"]',
    { timeout: 40000 })

  // Un permiso nuevo no es inmediato en el aparato, y no es un fallo: el acta se le
  // entrega al abrir la identidad y ENTONCES renueva su papel, porque quien decide qué
  // puede un aparato es el acta y no la pantalla. Hasta que llega, dice que no puede.
  await pedidos.waitForFunction(
    () => !document.querySelector('[data-testid="apv-nocap"]'),
    null, { timeout: 60000 })
  assert.equal(await pedidos.locator('[data-testid="apv-nocap"]').count(), 0,
    'esta pestaña SÍ puede aprobar: el papel se puso al día con el acta')

  // 1. Un NO. Va primero: la aprobación se recuerda mientras el vault siga encendido, así
  //    que después del sí ya no habría nada que probar.
  const negar = pedir(popup, 'get', { id: estado.id, keys: ['secret'] })
  const pendiente = pedidos.locator('[data-testid="apv-item"]').first()
  try {
    await pendiente.waitFor({ timeout: 40000 })
  } catch (e) {
    console.log('   [diag] nocap:', await aprobador.locator('[data-testid="apv-nocap"]').count(),
      '· vacío:', await aprobador.locator('[data-testid="apv-none"]').count())
    throw e
  }
  assert.ok(await pedidos.locator('[data-testid="apv-deny"]').first().isVisible(),
    'el pedido sale en el aparato que aprueba, no en el daemon')
  await pedidos.locator('[data-testid="apv-deny"]').first().click()
  const negado = await negar
  assert.ok(negado?.error, 'con el no, la extensión se queda sin nada: ' + JSON.stringify(negado))

  // 2. Y un SÍ.
  const pide = pedir(popup, 'get', { id: estado.id, keys: ['secret'] })
  await pedidos.locator('[data-testid="apv-item"]').first().waitFor({ timeout: 40000 })
  await pedidos.locator('[data-testid="apv-approve"]').first().click()
  assert.equal((await pide)?.result?.secret, 'hunter2', 'con el sí, la contraseña llega')

  // 3. Y de ahí en adelante ya no pregunta: lo aprobado es el APARATO (§2.0). Se mide por
  //    lo que importa —que NADIE tenga que tocar nada— y no por lo que enseñe una lista
  //    que se repinta cada cinco segundos: si hiciera falta aprobar, esto se quedaría
  //    esperando a un dedo que no va a llegar.
  const t0 = Date.now()
  const otra = await pedir(popup, 'get', { id: estado.id, keys: ['secret'] })
  const ms = Date.now() - t0
  assert.equal(otra?.result?.secret, 'hunter2', 'la segunda vez llega igual')
  assert.ok(ms < 3000, `y sin volver a preguntar: llegó en ${ms} ms, sin que nadie pulsara nada`)
})

escenario('el gestor entero funciona contra el daemon', async () => {
  const { popup } = estado

  // Editar: nombre, un valor, quitar y cruzar de dominio, todo en un `patch`.
  const r = await pedir(popup, 'patch', {
    id: estado.id,
    changes: {
      name: 'Renombrada contra el daemon',
      fields: [{ kind: 'tel', label: 'Teléfono', value: '0988000111' }],
      sites: ['banco.example', 'bancoapp.example'],
    },
  })
  assert.ok(!r?.error, 'el patch viaja: ' + JSON.stringify(r?.error || ''))

  const hay = (await pedir(popup, 'find', { url: 'https://bancoapp.example/' }))?.result || []
  const mia = hay.find((e) => e.id === estado.id)
  assert.ok(mia, 'el registro cruza al dominio nuevo')
  assert.equal(mia.hint, 'Renombrada contra el daemon', 'con su nombre nuevo')
  assert.ok(mia.privateKeys.includes('label:Número de socio'), 'y lo privado sigue marcado')

  const sitios = (await pedir(popup, 'sites'))?.result || []
  assert.ok(sitios.some((s) => s.site === 'banco.example'), 'los dominios del gestor')
  const buscado = (await pedir(popup, 'search', { q: 'bancoapp' }))?.result || []
  assert.ok(buscado.some((e) => e.id === estado.id), 'y el buscador')

  await pedir(popup, 'remove', { id: estado.id, url: 'https://banco.example/' })
  const tras = (await pedir(popup, 'find', { url: 'https://banco.example/' }))?.result || []
  assert.equal(tras.some((e) => e.id === estado.id), false, 'y quitar una entrada la quita')
})

escenario('alta disponibilidad: nada se encola y nada tarda', async () => {
  // El daemon está encendido siempre, así que ninguna de estas cinco tiene por qué
  // esperar a nadie. Si una tardara segundos, sería que se está encolando algo — que es
  // justo lo que aquí NO debe pasar.
  const { popup } = estado
  const t0 = Date.now()
  for (let i = 0; i < 5; i++) {
    const r = await pedir(popup, 'find', { url: 'https://banco.example/' })
    assert.ok(!r?.error, 'la vuelta ' + (i + 1) + ' contesta: ' + JSON.stringify(r?.error || ''))
  }
  const ms = Date.now() - t0
  assert.ok(ms < 5000, `cinco vueltas completas en ${ms} ms, sin esperar a nadie`)
  console.log(`         (cinco idas y vueltas por el proxio en ${ms} ms)`)
})

escenario('la propia EXTENSIÓN puede ser el aparato que aprueba', async () => {
  const { popup } = estado

  // 1. El permiso de aprobar, también para la extensión (dueño, 2026-08-30).
  const caps = await darPermiso(estado.extPub, 'approve')
  assert.ok(caps.includes('approve'), 'la extensión lleva los dos permisos: ' + caps.join(' '))

  // 2. Y OTRO aparato que pida: un segundo navegador con la misma extensión, que es un
  //    aparato distinto —su propia llave, su propio papel—. Nadie aprueba lo suyo.
  const { chromium } = await import('playwright')
  perfilDir2 = await mkdtemp(path.join(tmpdir(), 'smoke-demonio-2-'))
  contexto2 = await chromium.launchPersistentContext(perfilDir2, {
    headless: false,
    locale: 'es-ES',
    args: [
      ...(VERBOSE ? [] : ['--headless=new']),
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
    ],
    viewport: { width: 900, height: 800 },
  })
  const sw2 = contexto2.serviceWorkers()[0] || await contexto2.waitForEvent('serviceworker', { timeout: 20000 })
  const extId2 = new URL(sw2.url()).host
  const popup2 = await contexto2.newPage()
  popup2.on('pageerror', (e) => console.log('   [popup2!] ' + e.message))
  await popup2.goto(`chrome-extension://${extId2}/src/popup.html`)
  await popup2.waitForTimeout(1500)

  const qr = await vault.pair({ label: 'segundo' })
  await popup2.locator('[data-testid="profile-add"]').click()
  await popup2.locator('[data-testid="add-linked"]').click()
  await popup2.locator('[data-testid="invite"]').fill(b64url(qr))
  await popup2.locator('[data-testid="pair"]').click()
  await popup2.waitForSelector('[data-testid="pair-code"]', { timeout: 40000 })
  const code = (await popup2.locator('[data-testid="pair-code"]').innerText()).trim()
  await vault.waitPending()
  vault.approve(code)
  for (let i = 0; i < 60; i++) {
    const st = (await pedir(popup2, 'status'))?.result
    if (st?.profile?.kind === 'linked') break
    await popup2.waitForTimeout(1000)
  }

  const acta = await vault.members()
  const dos = (acta.members || []).find((m) => (m.label || '').includes('segundo'))
  assert.ok(dos, 'el segundo aparato está en el acta')
  await darPermiso(dos.pub, 'passwords')
  // Sin `unattended` lo suyo pasa por un aprobador, que es el defecto desde 0.79.0.

  // El mostrador ya estaba abierto, así que no vuelve a anunciarse: lo que cambia es la
  // lista de quién puede pedir, y esa la relee el daemon cada pocos segundos. Se insiste
  // hasta que lo reconoce en vez de dormir un número inventado.
  let idNuevo = null
  let ultimo = null
  for (let i = 0; i < 12; i++) {
    const r = await pedir(popup2, 'put', { entry: {
      title: 'otro.example', sites: ['otro.example'], username: 'beto@ejemplo.com', secret: 'quetal',
    } })
    if (r?.result?.id) { idNuevo = r.result.id; break }
    ultimo = r?.error
    await popup2.waitForTimeout(2000)
  }
  assert.ok(idNuevo, 'el segundo aparato escribe en la misma bóveda: ' + JSON.stringify(ultimo))
  const pide = pedir(popup2, 'get', { id: idNuevo, keys: ['secret'] })

  // 4. Y EL MISMO PEDIDO SALE EN LOS DOS SITIOS A LA VEZ: la pestaña de pedidos y la
  //    extensión, que son dos aparatos con el permiso de aprobar.
  await estado.pedidos.reload()
  await estado.pedidos.locator('[data-testid="apv-item"]').first().waitFor({ timeout: 40000 })
  // La extensión también tiene que enterarse de su permiso nuevo: su papel se pone al día
  // con el acta, igual que le pasó a la pestaña. Se insiste, recargando el popup.
  let puede = null
  for (let i = 0; i < 20; i++) {
    puede = (await pedir(popup, 'approvals'))?.result
    if (puede?.can && puede.items.length) break
    await popup.waitForTimeout(3000)
    if (i % 3 === 2) await popup.reload()
  }
  assert.ok(puede?.can, 'la extensión puede aprobar: su papel se puso al día con el acta')
  assert.ok(puede.items.length, 'y ve el pedido que espera: ' + JSON.stringify(puede))

  await popup.reload()
  const enLaExtension = popup.locator('[data-testid^="popup-apv-"]').first()
  await enLaExtension.waitFor({ timeout: 40000 })
  assert.ok(true, 'el mismo pedido está en la pestaña Y en la extensión')

  // 5. Se contesta DESDE LA EXTENSIÓN.
  await popup.locator('[data-testid^="popup-apv-yes-"]').first().click()
  assert.equal((await pide)?.result?.secret, 'quetal',
    'la extensión aprueba y el otro aparato recibe su llave')

  // 6. Y el pedido desaparece de la otra pantalla: se contestó una vez, no dos.
  await estado.pedidos.waitForFunction(
    () => !document.querySelector('[data-testid="apv-item"]'), null, { timeout: 40000 })
  assert.ok(true, 'y se cae de la otra pantalla, porque ya está contestado')
})

// ---------- arranque ----------

console.log('\nSMOKE · la extensión con el VAULT DEMONIO, todo en local\n')
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
  vault = await startVault({ proxyUrl: proxy.url, name: 'daemon', log })
  webConsola = await servirEstatico(CONSOLA, { spa: true })
  webIframe = await servirEstatico(IFRAME)
  console.log(`  proxy     ${proxy.url}`)
  console.log(`  daemon    pid ${vault.pid}`)
  console.log(`  consola   ${webConsola.url}/vault`)

  perfilDir = await mkdtemp(path.join(tmpdir(), 'smoke-demonio-'))
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
  try { await contexto2?.close() } catch (_) {}
  if (perfilDir2) await rm(perfilDir2, { recursive: true, force: true }).catch(() => {})
  if (!ok) console.log('\n--- lo que dijo el daemon ---\n' + vault.log().slice(-2600))
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
