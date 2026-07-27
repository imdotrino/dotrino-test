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
let navegador = null
let contexto = null

/** Abre la consola apuntando al iframe LOCAL (el `?vault=` solo lo acepta en localhost). */
async function abrirConsola (hash = '') {
  const page = await contexto.newPage()
  page.on('console', (m) => log('[navegador] ' + m.text()))
  page.on('pageerror', (e) => log('[navegador!] ' + e.message))
  await page.goto(`${webConsola.url}/dispositivos?vault=${encodeURIComponent(webIframe.url + '/')}${hash}`)
  await page.waitForSelector('[data-testid="members"] .member', { timeout: 30000 })
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

  // Y sus permisos salen marcados (es un dispositivo, no un servicio).
  const firma = page.locator('.member .cap').first()
  assert.match(await firma.innerText(), /Firma/i)
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

  // Los comandos van APARTE, detrás de un desplegable: la promesa se lee sin saber de
  // tecnología (CONVENCIONES §9.1) y quien quiera terminal la encuentra.
  await page.locator('.use-cmds summary').click()
  assert.match(await uso.innerText(), /dotrino-vault members/, 'los comandos, para quien los quiera')

  // Y la consecuencia asumida del modelo, destacada y no escondida en una nota al pie:
  // si pierdes la máquina sin haber conectado otra bóveda, pierdes la cuenta.
  const aviso = await page.locator('[data-testid="use-warn"]').innerText()
  assert.match(aviso, /pierdes la cuenta/i, 'lo dice en voz alta')
  assert.match(aviso, /no hay|ninguna|recuperar/i, 'y que no hay rescate')
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
  await page.waitForSelector('[data-testid="members"] .member:nth-child(2)', { timeout: 30000 })

  const acta = vault.acta()
  assert.equal(acta.members.length, 2, 'la bóveda lo admitió en su acta')
  const enPantalla = await page.locator('[data-testid="members"] .member').count()
  assert.equal(enPantalla, 2, 'y la consola ya muestra los dos')

  // Ahora manda la bóveda, no este navegador.
  const texto = await page.locator('[data-testid="members"]').innerText()
  assert.match(texto, /manda/, 'se ve quién manda')

  // Y se EXPLICA que el aparato quedó con dos cuentas, con los pasos para soltar la que
  // no quieras. Si no se dice, aparece una entrada de más en el conmutador de perfiles y
  // nadie sabe de dónde salió.
  const aviso = page.locator('[data-testid="two-accounts"]')
  await aviso.waitFor({ timeout: 10000 })
  assert.match(await aviso.innerText(), /dos cuentas/i, 'dice que ahora hay dos')
  assert.match(await aviso.innerText(), /[Bb]orrar/, 'y cómo deshacerse de una')
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
  console.log(`  proxy    ${proxy.url}`)
  console.log(`  consola  ${webConsola.url}/dispositivos`)
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
