/**
 * EL PANEL DE CONSOLAS DE LA PWA DE TERMINAL, con un navegador de verdad y un agente de verdad.
 *
 * Lo que prueba, de punta a punta y todo en local (proxio, bóveda, iframe de identidad, PWA):
 *   · el navegador, emparejado con la bóveda, encuentra la máquina del agente de terminal;
 *   · al conectar se engancha a una consola LIBRE si la hay (y si no, abre una);
 *   · el panel (colapsado) enseña las consolas con su número fijo y marca la de esta pestaña;
 *   · «+» abre otra y clic en un número cambia a esa, por la misma conexión;
 *   · el TAMAÑO con tres a la vez: lo tiene quien lo fija (📌) o el último que llegó; escribir no
 *     lo cambia; la pantalla fijada se sigue al redimensionarse, y al soltarla vuelve al último;
 *   · la × de la consola de esta pestaña pasa primero a otra.
 *
 *   npm run smoke:terminal-panel
 *   node smoke/terminal-panel.mjs --verbose      (con los logs y el navegador a la vista)
 *
 * Requiere los builds:  cd dotrino-vault/web && npm run build   ·   cd dotrino-terminal && npm run build
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { escenario, correr, startProxy, startVault, teardown, servirEstatico, tmpDir, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CONSOLA = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const PWA = path.join(ROOT, 'dotrino-terminal/dist')
const AGENTE = path.join(ROOT, 'dotrino-terminal/agent')

let proxy = null
let vault = null
let webConsola = null
let webIframe = null
let webPwa = null
let navegador = null
let contexto = null
let agente = null          // startAgent(): { consoles, close… }
let dirAgente = null
let pagina = null          // la PWA, abierta en la máquina

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

async function esperar (fn, { timeoutMs = 20000, que = 'la condición' } = {}) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) {
    const v = await fn()
    if (v) return v
    await sleep(150)
  }
  throw new Error('se agotó la espera de ' + que)
}

/** Lo que muestra el panel colapsado: los números y cuál está marcado. */
async function panel () {
  return pagina.evaluate(() => {
    const nums = [...document.querySelectorAll('.term-wrap:not([style*="none"]) .side .sbtn.num')]
    return { nums: nums.map((b) => b.textContent.trim()), on: nums.find((b) => b.classList.contains('on'))?.textContent.trim() || null }
  })
}

const consolas = () => agente.consoles.list()

escenario('el navegador se empareja con la bóveda (como cualquier aparato)', async () => {
  const qr = await vault.pair({ label: 'navegador' })
  const page = await contexto.newPage()
  page.on('pageerror', (e) => log('[consola!] ' + e.message))
  await page.goto(`${webConsola.url}/vault?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}#vault=${b64url(qr)}`)
  const caja = page.locator('[data-testid="pair-code"] .digits')
  await caja.waitFor({ timeout: 30000 })
  const code = (await caja.innerText()).trim()
  await vault.waitPending()
  vault.approve(code)
  await page.waitForFunction(() => !document.querySelector('[data-testid="pair-code"]'), null, { timeout: 30000 })
  await page.close()
})

escenario('el agente de terminal se enrola en la bóveda y arranca', async () => {
  const { enroll } = await import(path.join(AGENTE, 'link.js'))
  const { startAgent } = await import(path.join(AGENTE, 'index.js'))
  dirAgente = tmpDir('terminal-agent')
  const qr = await vault.pair({ label: 'maquina' })
  const hecho = enroll({ qr, dir: dirAgente, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  await hecho
  agente = await startAgent({ dir: dirAgente, shell: '/bin/sh', quiet: !VERBOSE })
  assert.ok(agente.remote, 'con enlace, el agente atiende también a los otros aparatos')
})

escenario('la PWA encuentra la máquina y, sin consolas, abre una', async () => {
  pagina = await contexto.newPage()
  pagina.on('console', (m) => log('[pwa] ' + m.text()))
  pagina.on('pageerror', (e) => log('[pwa!] ' + e.message))
  await pagina.setViewportSize({ width: 900, height: 700 })
  await pagina.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  const maquina = pagina.locator('[data-testid="machine-item"]').first()
  await maquina.waitFor({ timeout: 45000 })
  await maquina.click()
  await esperar(async () => (await consolas()).length === 1, { que: 'que la PWA abra una consola' })
  await esperar(async () => (await panel()).on === '1', { que: 'que el panel marque la 1' })
})

escenario('«+» abre otra; clic en un número cambia a esa por la misma conexión', async () => {
  await pagina.locator('.side [data-act="new"]').click()
  await esperar(async () => (await consolas()).length === 2, { que: 'la segunda consola' })
  await esperar(async () => (await panel()).on === '2', { que: 'que marque la 2' })
  assert.equal((await consolas()).find((c) => c.n === 1).viewers, 0, 'la 1 quedó suelta, no se cerró')
  await pagina.locator('.side .sbtn.num', { hasText: /^1$/ }).click()
  await esperar(async () => (await panel()).on === '1', { que: 'que vuelva a la 1' })
  assert.equal((await consolas()).find((c) => c.n === 2).viewers, 0, 'y ahora la suelta es la 2')
})

escenario('el TAMAÑO con tres a la vez: lo tiene quien lo fija (📌) o el último que llegó; escribir no lo cambia', async () => {
  const { connectLocal } = await import(path.join(AGENTE, 'local.js'))
  const una = (await consolas()).find((c) => c.n === 1)
  const tam = async () => { const c = (await consolas()).find((x) => x.n === 1); return `${c.cols}x${c.rows}` }
  const tamPwa = `${una.cols}x${una.rows}`
  // Dos ventanas de la máquina se enganchan a la misma consola: la última que llega lo tiene.
  const v1 = await connectLocal(dirAgente)
  v1.send({ type: 'attach', id: una.id, cols: 160, rows: 50, tag: 'ventana-1' })
  await esperar(async () => (await tam()) === '160x50', { que: 'que la ventana 1 tome el tamaño al engancharse' })
  const v2 = await connectLocal(dirAgente)
  v2.send({ type: 'attach', id: una.id, cols: 100, rows: 30, tag: 'ventana-2' })
  await esperar(async () => (await tam()) === '100x30', { que: 'que la ventana 2 lo tome al llegar' })
  // Escribir no cambia nada, ni desde el teléfono ni desde la ventana 1.
  await pagina.locator('.xterm-helper-textarea').first().focus()
  await pagina.keyboard.type('echo hola\n')
  v1.send({ type: 'input', data: ' ' })
  await sleep(600)
  assert.equal(await tam(), '100x30', 'escribir no cambia el tamaño')
  // 📌 en la PWA: se lo queda, y las ventanas no lo cambian aunque se redimensionen.
  await pagina.locator('.side [data-act="pin"]').click()
  await esperar(async () => (await tam()) === tamPwa, { que: 'que el 📌 le dé el tamaño a la PWA' })
  await esperar(async () => pagina.locator('.side [data-act="pin"].on').count(), { que: 'que el 📌 se vea encendido' })
  v1.send({ type: 'resize', cols: 170, rows: 50 })
  await sleep(400)
  assert.equal(await tam(), tamPwa, 'con la PWA fijada, la ventana no lo cambia')
  // Girar / redimensionar el teléfono fijado: se sigue.
  await pagina.setViewportSize({ width: 600, height: 700 })
  await esperar(async () => (await tam()) !== tamPwa, { que: 'que el tamaño siga a la pantalla fijada' })
  // Soltarlo: vuelve al último que llegó (la ventana 2).
  await pagina.locator('.side [data-act="pin"]').click()
  await esperar(async () => (await tam()) === '100x30', { que: 'que al soltarlo vuelva al último que llegó' })
  v1.send({ type: 'detach' }); v1.close(); v2.send({ type: 'detach' }); v2.close()
  await pagina.setViewportSize({ width: 900, height: 700 })
})

escenario('la × de la consola de esta pestaña pasa primero a otra, y luego la cierra', async () => {
  await pagina.locator('.side [data-act="expand"]').click()
  const mia = (await consolas()).find((c) => c.n === 1)
  await pagina.locator(`.side [data-kill="${mia.id}"]`).click()
  await esperar(async () => !(await consolas()).some((c) => c.id === mia.id), { que: 'que la 1 se cierre' })
  const quedan = await consolas()
  assert.equal(quedan.length, 1, 'queda la 2')
  assert.equal(quedan[0].n, 2, 'con su número: la 2 sigue siendo la 2')
  assert.equal(quedan[0].viewers, 1, 'y la pestaña pasó a ella en vez de quedarse sin consola')
})

console.log('\nSMOKE · el panel de consolas de la PWA de terminal, todo en local\n')
for (const [dir, como] of [[CONSOLA, 'cd dotrino-vault/web && npm run build'], [PWA, 'cd dotrino-terminal && npm run build']]) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) { console.error(`Falta un build. Hazlo con:  ${como}\n`); process.exit(2) }
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'boveda', log })
  webConsola = await servirEstatico(CONSOLA, { spa: true })
  webIframe = await servirEstatico(IFRAME)
  webPwa = await servirEstatico(PWA, { spa: true })
  console.log(`  proxy  ${proxy.url}`)
  console.log(`  pwa    ${webPwa.url}/consoles\n`)
  navegador = await chromium.launch({ headless: !VERBOSE })
  contexto = await navegador.newContext({ locale: 'es-ES' })
  const ok = await correr()
  try { agente?.close() } catch (_) {}
  await contexto?.close(); await navegador?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  try { agente?.close() } catch (_) {}
  try { await contexto?.close(); await navegador?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
