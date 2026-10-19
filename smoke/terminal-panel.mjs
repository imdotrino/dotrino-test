/**
 * EL PANEL DE CONSOLAS DE LA PWA DE TERMINAL, con un navegador de verdad y un agente de verdad.
 *
 * Lo que prueba, de punta a punta y todo en local (proxio, bóveda, iframe de identidad, PWA):
 *   · el navegador, emparejado con la bóveda, encuentra la máquina del agente de terminal;
 *   · al conectar se engancha a una consola LIBRE si la hay (y si no, abre una);
 *   · el panel (colapsado) enseña las consolas con su número fijo y marca la de esta pestaña;
 *   · «+» abre otra y clic en un número cambia a esa, por la misma conexión;
 *   · el TAMAÑO con tres a la vez: lo tiene quien lo fija (⤢) o el último que llegó; escribir no
 *     lo cambia; la pantalla fijada se sigue al redimensionarse, y al soltarla vuelve al último;
 *   · ACTIVIDAD: el número de una consola cambia de color si está trabajando o si terminó;
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
import { scenario, runScenarios, startProxy, startVault, teardown, serveStatic, tmpDir, ROOT } from './lib/harness.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const CONSOLE = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const PWA = path.join(ROOT, 'dotrino-terminal/dist')
const AGENT = path.join(ROOT, 'dotrino-terminal/agent')

let proxy = null
let vault = null
let webConsole = null
let webIframe = null
let webPwa = null
let browser = null
let context = null
let agent = null          // startAgent(): { consoles, close… }
let agentDir = null
let pwaPage = null          // la PWA, abierta en la máquina

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

/** Lo que muestra el panel colapsado: los números y cuál está marcado. */
async function panel () {
  return pwaPage.evaluate(() => {
    const nums = [...document.querySelectorAll('.term-wrap:not([style*="none"]) .side .sbtn.num')]
    return { nums: nums.map((b) => b.textContent.trim()), on: nums.find((b) => b.classList.contains('on'))?.textContent.trim() || null }
  })
}

const consoles = () => agent.consoles.list()

scenario('the browser pairs with the vault (like any device)', async () => {
  const qr = await vault.pair({ label: 'browser' })
  const page = await context.newPage()
  page.on('pageerror', (e) => log('[console!] ' + e.message))
  await page.goto(`${webConsole.url}/vault?vault=${encodeURIComponent(iframeUrl())}&proxy=${encodeURIComponent(proxy.url)}#vault=${b64url(qr)}`)
  const box = page.locator('[data-testid="pair-code"] .digits')
  await box.waitFor({ timeout: 30000 })
  const code = (await box.innerText()).trim()
  await vault.waitPending()
  vault.approve(code)
  await page.waitForFunction(() => !document.querySelector('[data-testid="pair-code"]'), null, { timeout: 30000 })
  await page.close()
})

scenario('the terminal agent enrolls in the vault and starts', async () => {
  const { enroll } = await import(path.join(AGENT, 'link.js'))
  const { startAgent } = await import(path.join(AGENT, 'index.js'))
  agentDir = tmpDir('terminal-agent')
  const qr = await vault.pair({ label: 'machine' })
  const enrolled = enroll({ qr, dir: agentDir, onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  await enrolled
  agent = await startAgent({ dir: agentDir, shell: '/bin/sh', quiet: !VERBOSE })
  assert.ok(agent.remote, 'with a link, the agent also serves the other devices')
})

scenario('the PWA finds the machine and, with no consoles, opens one', async () => {
  pwaPage = await context.newPage()
  pwaPage.on('console', (m) => log('[pwa] ' + m.text()))
  pwaPage.on('pageerror', (e) => log('[pwa!] ' + e.message))
  await pwaPage.setViewportSize({ width: 900, height: 700 })
  await pwaPage.goto(`${webPwa.url}/consoles?vault=${encodeURIComponent(iframeUrl())}`)
  const machine = pwaPage.locator('[data-testid="machine-item"]').first()
  await machine.waitFor({ timeout: 45000 })
  await machine.click()
  await waitFor(async () => (await consoles()).length === 1, { what: 'the PWA to open a console' })
  await waitFor(async () => (await panel()).on === '1', { what: 'the panel to mark 1' })
  // La consola usa toda la ventana, no una tarjeta estrecha.
  const box = await pwaPage.locator('.term-wrap').first().boundingBox()
  assert.ok(box.width > 900 * 0.9, `the console fills the width (${box.width} of 900)`)
  assert.ok(box.height > 700 * 0.6, `and the height (${box.height} of 700)`)
})

scenario('«+» opens another; clicking a number switches to it over the same connection', async () => {
  await pwaPage.locator('.side [data-act="new"]').click()
  await waitFor(async () => (await consoles()).length === 2, { what: 'the second console' })
  await waitFor(async () => (await panel()).on === '2', { what: 'it to mark 2' })
  assert.equal((await consoles()).find((c) => c.n === 1).viewers, 0, '1 was left detached, not closed')
  await pwaPage.locator('.side .sbtn.num', { hasText: /^1$/ }).click()
  await waitFor(async () => (await panel()).on === '1', { what: 'it to go back to 1' })
  assert.equal((await consoles()).find((c) => c.n === 2).viewers, 0, 'and now the detached one is 2')
  // SMOKE_SHOT=<ruta.png>: una captura de la pantalla de consolas, para mirarla.
  if (process.env.SMOKE_SHOT) await pwaPage.screenshot({ path: process.env.SMOKE_SHOT })
})

// SIEMPRE EL CAMINO MÁS DIRECTO (CLAUDE.md, regla del transporte). El saludo sale por el
// proxio, que es lo que hay; a partir de ahí lo de la consola va por el canal directo. Se
// mide en la página con las estadísticas del pilar, que cuentan los bytes por el camino por
// el que pasaron de verdad.
scenario('console traffic goes over the direct channel, not the proxy', async () => {
  const measure = () => pwaPage.evaluate(async () => {
    const out = []
    for (const c of globalThis[Symbol.for('dotrino.transports')] || []) {
      for (const p of (await c.stats()).peers) out.push({ route: p.route, bytesIn: p.bytesIn, bytesOut: p.bytesOut })
    }
    return out
  })
  const sum = (ps, dir, route) => ps.reduce((n, p) => n + (p[dir][route] || 0), 0)
  await waitFor(async () => (await measure()).some((p) => p.route === 'direct'), { timeoutMs: 30000, what: 'the direct channel to the agent to open' })
  const before = await measure()
  await pwaPage.locator('.xterm-helper-textarea').first().focus()
  await pwaPage.keyboard.type('seq 1 400\n')
  await waitFor(async () => sum(await measure(), 'bytesIn', 'direct') > sum(before, 'bytesIn', 'direct') + 1000, { what: 'the console output to arrive over the direct channel' })
  const after = await measure()
  log('  before  ' + JSON.stringify(before))
  log('  after   ' + JSON.stringify(after))
  assert.ok(sum(after, 'bytesOut', 'direct') > sum(before, 'bytesOut', 'direct'), 'typed input goes out over the direct channel')
  assert.equal(sum(after, 'bytesOut', 'proxy'), sum(before, 'bytesOut', 'proxy'), 'and none of it goes out through the proxy')
  assert.equal(sum(after, 'bytesIn', 'proxy'), sum(before, 'bytesIn', 'proxy'), 'nor comes in through it')
})

scenario('ACTIVITY: the panel shows which console is working and which finished', async () => {
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const two = (await consoles()).find((c) => c.n === 2)
  // Otra pantalla lanza en la 2 algo que se comporta como un agente: su título cambia cada
  // segundo mientras trabaja y después se queda quieto. El agente no lee qué dice: solo que cambia.
  const v = await connectLocal(agentDir)
  v.send({ type: 'attach', id: two.id, cols: 80, rows: 24, tag: 'other' })
  await sleep(400)
  v.send({ type: 'input', data: "for i in 1 2 3 4 5 6; do printf '\\033]0;step %s\\007' $i; sleep 1; done\r" })
  const twoBtn = pwaPage.locator('.side .sbtn.num', { hasText: /^2$/ })
  await waitFor(async () => (await twoBtn.getAttribute('class')).includes('busy'), { what: '2 to show as busy' })
  if (process.env.SMOKE_SHOT) await pwaPage.screenshot({ path: process.env.SMOKE_SHOT.replace(/\.png$/, '-activity.png') })
  await waitFor(async () => (await twoBtn.getAttribute('class')).includes('done'), { what: '2 to show as done', timeoutMs: 30000 })
  // Atenderla (teclear en ella) apaga el aviso.
  v.send({ type: 'input', data: ' ' })
  await waitFor(async () => !/busy|done/.test(await twoBtn.getAttribute('class')), { what: 'the mark to clear once attended' })
  v.send({ type: 'detach' }); v.close()
  await waitFor(async () => (await consoles()).find((c) => c.n === 2).viewers === 0, { what: '2 to be detached' })
})

scenario('SIZE with three at once: it belongs to whoever pins it (⤢) or the last to arrive; typing does not change it', async () => {
  const { connectLocal } = await import(path.join(AGENT, 'local.js'))
  const one = (await consoles()).find((c) => c.n === 1)
  const size = async () => { const c = (await consoles()).find((x) => x.n === 1); return `${c.cols}x${c.rows}` }
  // El tamaño de la PWA: el que tiene ahora que es la única mirando (ya con el panel puesto).
  await sleep(500)
  const pwaSize = await size()
  // Dos ventanas de la máquina se enganchan a la misma consola: la última que llega lo tiene.
  const v1 = await connectLocal(agentDir)
  v1.send({ type: 'attach', id: one.id, cols: 160, rows: 50, tag: 'window-1' })
  await waitFor(async () => (await size()) === '160x50', { what: 'window 1 to take the size on attach' })
  const v2 = await connectLocal(agentDir)
  v2.send({ type: 'attach', id: one.id, cols: 100, rows: 30, tag: 'window-2' })
  await waitFor(async () => (await size()) === '100x30', { what: 'window 2 to take it on arrival' })
  // Escribir no cambia nada, ni desde el teléfono ni desde la ventana 1.
  await pwaPage.locator('.xterm-helper-textarea').first().focus()
  await pwaPage.keyboard.type('echo hello\n')
  v1.send({ type: 'input', data: ' ' })
  await sleep(600)
  assert.equal(await size(), '100x30', 'typing does not change the size')
  // ⤢ en la PWA: se lo queda, y las ventanas no lo cambian aunque se redimensionen.
  assert.equal(await pwaPage.locator('.side [data-act="pin"]').getAttribute('title'), 'Usar el tamaño de esta pantalla en la consola 1', 'the ⤢ says which console it affects')
  await pwaPage.locator('.side [data-act="pin"]').click()
  await waitFor(async () => (await size()) === pwaSize, { what: 'the ⤢ to give the size to the PWA' })
  assert.match(await pwaPage.locator('#hint').innerText(), /Consola 1: usa el tamaño de esta pantalla/, 'and the status line says so')
  await waitFor(async () => pwaPage.locator('.side [data-act="pin"].on').count(), { what: 'the ⤢ to show as on' })
  v1.send({ type: 'resize', cols: 170, rows: 50 })
  await sleep(400)
  assert.equal(await size(), pwaSize, 'with the PWA pinned, the window does not change it')
  // Girar / redimensionar el teléfono fijado: se sigue.
  await pwaPage.setViewportSize({ width: 600, height: 700 })
  await waitFor(async () => (await size()) !== pwaSize, { what: 'the size to follow the pinned screen' })
  // Pasar a otra consola y volver: la elección es de esta pantalla, no de la conexión.
  await pwaPage.locator('.side .sbtn.num', { hasText: /^2$/ }).click()
  await waitFor(async () => (await panel()).on === '2', { what: 'it to switch to 2' })
  await waitFor(async () => (await size()) === '100x30', { what: 'window 2 to rule without it' })
  await pwaPage.locator('.side .sbtn.num', { hasText: /^1$/ }).click()
  await waitFor(async () => (await panel()).on === '1', { what: 'it to go back to 1' })
  await waitFor(async () => (await size()) !== '100x30', { what: 'the chosen size to come back on return' })
  await waitFor(async () => pwaPage.locator('.side [data-act="pin"].on').count(), { what: 'the ⤢ to stay on' })
  // Soltarlo: manda el último que llegó, que ahora es esta pestaña (acaba de volver); la ventana
  // 2 se lo queda si se engancha de nuevo.
  await pwaPage.locator('.side [data-act="pin"]').click()
  await waitFor(async () => !(await consoles()).find((c) => c.n === 1).sizeBy.pinned, { what: 'it to be unpinned after release' })
  v2.send({ type: 'attach', id: one.id, cols: 100, rows: 30, tag: 'window-2' })
  await waitFor(async () => (await size()) === '100x30', { what: 'the last arrival to rule with no pin' })
  v1.send({ type: 'detach' }); v1.close(); v2.send({ type: 'detach' }); v2.close()
  await pwaPage.setViewportSize({ width: 900, height: 700 })
})

scenario('the × on this tab\'s console first moves to another, then closes it', async () => {
  await pwaPage.locator('.side [data-act="expand"]').click()
  const mine = (await consoles()).find((c) => c.n === 1)
  await pwaPage.locator(`.side [data-kill="${mine.id}"]`).click()
  await waitFor(async () => !(await consoles()).some((c) => c.id === mine.id), { what: '1 to close' })
  const left = await consoles()
  assert.equal(left.length, 1, '2 remains')
  assert.equal(left[0].n, 2, 'with its number: 2 is still 2')
  assert.equal(left[0].viewers, 1, 'and the tab moved to it instead of being left without a console')
})

scenario('without the agent, the page says it cannot connect and links the guide; no tab is left hanging', async () => {
  agent.close(); agent = null
  await pwaPage.reload()
  // La pestaña que había se reabre sola al recargar; al no conectar, se quita y se dice.
  await waitFor(async () => (await pwaPage.locator('#hint a[href*="wiki.dotrino.com"]').count()) > 0, { timeoutMs: 60000, what: 'the could-not-connect notice, with its link' })
  assert.equal(await pwaPage.locator('.term-wrap').count(), 0, 'no tab is left without a connection')
  // Y la lista de máquinas no documenta nada: un aviso y el enlace al wiki (§5.1, §9.2).
  await waitFor(async () => pwaPage.locator('[data-testid="no-machines"]').count(), { timeoutMs: 45000, what: 'the no-machines notice' })
  assert.ok(await pwaPage.locator('[data-testid="no-machines"] a[href*="wiki.dotrino.com"]').count(), 'with the link to the guide')
  assert.equal(await pwaPage.locator('#machines pre, #machines code').count(), 0, 'without command blocks')
})

console.log('\nSMOKE · the console panel of the terminal PWA, all local\n')
for (const [dir, how] of [[CONSOLE, 'cd dotrino-vault/web && npm run build'], [PWA, 'cd dotrino-terminal && npm run build']]) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) { console.error(`Missing a build. Build it with:  ${how}\n`); process.exit(2) }
}
try {
  const { chromium } = await import('playwright')
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  webConsole = await serveStatic(CONSOLE, { spa: true })
  webIframe = await serveStatic(IFRAME)
  webPwa = await serveStatic(PWA, { spa: true })
  console.log(`  proxy  ${proxy.url}`)
  console.log(`  pwa    ${webPwa.url}/consoles\n`)
  browser = await chromium.launch({ headless: !VERBOSE })
  context = await browser.newContext({ locale: 'es-ES' })
  const ok = await runScenarios()
  try { agent?.close() } catch (_) {}
  await context?.close(); await browser?.close()
  await teardown()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { agent?.close() } catch (_) {}
  try { await context?.close(); await browser?.close() } catch (_) {}
  await teardown()
  process.exit(1)
}
