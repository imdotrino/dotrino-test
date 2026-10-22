/**
 * EL CORREO DEL BANCO EN EXPENSES, de punta a punta: buzón IMAP → agente del PC → PWA.
 *
 * Lo que prueba, todo en local (proxio, bóveda, iframe de identidad, PWA, servidor de correo):
 *   · el navegador, emparejado con la bóveda, es un aparato más de la cuenta;
 *   · el agente de Expenses se enrola como SERVICIO con su cajón `expenses`, y él mismo guarda
 *     ahí las credenciales del buzón (la PWA no las ve nunca);
 *   · la PWA encuentra el agente encendido, enseña qué buzón lee y trae sola lo nuevo: el aviso
 *     de consumo cae en «Por confirmar» y la promoción no crea nada;
 *   · aceptarlo lo pasa al mes;
 *   · un correo nuevo, al pulsar «Traer», entra UNA vez (el cursor avanza, no se duplica).
 *
 * El buzón es GreenMail en Docker (imagen `greenmail/standalone:2.1.3`), el mismo que usa
 * `npm run test:imap` del agente. Se le meten los correos con APPEND.
 *
 *   npm run smoke:expenses-mail
 *   node smoke/expenses-mail.mjs --verbose      (con los logs y el navegador a la vista)
 *
 * Requiere los builds:  cd dotrino-vault/web && npm run build   ·   cd dotrino-expenses && npm run build
 * y las dependencias del agente:  cd dotrino-expenses-agent && npm install
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { scenario, runScenarios, startProxy, startVault, teardown, serveStatic, tmpDir, freePort, ROOT } from './lib/harness.js'
import { sleep, waitFor } from './lib/wait.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const CONSOLE = path.join(ROOT, 'dotrino-vault/web/dist')
const IFRAME = path.join(ROOT, 'dotrino-identity/vault')
const PWA = path.join(ROOT, 'dotrino-expenses/dist')
const AGENT = path.join(ROOT, 'dotrino-expenses-agent')
// El agente todavía no está publicado: se importa de su carpeta, con SUS dependencias.
const AGENT_DEPS = path.join(AGENT, 'node_modules')

const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.3'
const MAIL_USER = 'ana@example.com'
const MAIL_PASSWORD = 'pw'

let proxy = null
let vault = null
let webConsole = null
let webIframe = null
let webPwa = null
let browser = null
let context = null
let agent = null          // startExpensesAgent(): el agente corriendo en este proceso
let agentDir = null
let pwaPage = null
let mail = null           // { name, port }: el contenedor de GreenMail

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const iframeUrl = () => `${webIframe.url}/?proxy=${encodeURIComponent(proxy.url)}`

// ── El buzón ────────────────────────────────────────────────────────────────────────────

/** Un correo en crudo (RFC 5322), como lo dejaría el banco en el buzón. */
function rawMail ({ from, subject, date, body }) {
  return [
    `From: ${from}`, `To: ${MAIL_USER}`, `Subject: ${subject}`, `Date: ${date.toUTCString()}`,
    `Message-ID: <${subject.replace(/\W+/g, '-')}-${date.getTime()}@smoke>`,
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', body, '',
  ].join('\r\n')
}

async function imapClient () {
  const { ImapFlow } = await import(path.join(AGENT_DEPS, 'imapflow/dist/esm/imap-flow.js'))
  return new ImapFlow({ host: '127.0.0.1', port: mail.port, secure: false, auth: { user: MAIL_USER, pass: MAIL_PASSWORD }, logger: false })
}

/** Mete correos en el INBOX con APPEND, como si hubieran llegado. */
async function appendMails (mails) {
  const c = await imapClient()
  await c.connect()
  for (const m of mails) await c.append('INBOX', rawMail(m), [], m.date)
  await c.logout()
}

async function startGreenMail () {
  const port = await freePort()
  const name = `dotrino-smoke-greenmail-${process.pid}`
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:3143`,
    '-e', `GREENMAIL_OPTS=-Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=${MAIL_USER.split('@')[0]}:${MAIL_PASSWORD}@${MAIL_USER.split('@')[1]} -Dgreenmail.users.login=email`,
    GREENMAIL_IMAGE], { stdio: 'ignore' })
  mail = { name, port }
  // Arranca en unos segundos: se espera a que acepte un login.
  await waitFor(async () => {
    try { const c = await imapClient(); await c.connect(); await c.logout(); return true } catch (_) { return false }
  }, { timeoutMs: 60000, what: 'GreenMail to accept a login' })
}

function stopGreenMail () {
  if (!mail) return
  try { execFileSync('docker', ['rm', '-f', mail.name], { stdio: 'ignore' }) } catch (_) { /* ya no está */ }
  mail = null
}

// ── La PWA ──────────────────────────────────────────────────────────────────────────────

const inboxItems = () => pwaPage.locator('[data-testid="inbox-item"]')
const inboxAmounts = () => pwaPage.locator('[data-testid="inbox-amount"]').allInnerTexts()

const DAY = 86400_000
// La fecha del correo cae dentro de los 30 días que mira el agente la primera vez.
const PURCHASE = {
  from: 'Banco Pichincha <avisos@pichincha.com>',
  subject: 'Notificación de consumo',
  date: new Date(Date.now() - 2 * DAY),
  body: 'Se registró un consumo con tu Tarjeta de Débito terminada en 1234 por USD 25,40 en SUPERMAXI EL JARDIN el 20/10/2026',
}
const PROMO = {
  from: 'Tienda <promo@tienda.ec>',
  subject: 'Solo hoy: 2x1 en toda la tienda',
  date: new Date(Date.now() - 1 * DAY),
  body: 'Aprovecha nuestras ofertas de temporada. Visítanos en cualquiera de nuestros locales.',
}
const LATER = {
  from: 'Banco Pichincha <avisos@pichincha.com>',
  subject: 'Notificación de consumo 2',
  date: new Date(),
  body: 'Se registró un consumo con tu Tarjeta de Débito terminada en 1234 por USD 13,75 en FARMACIA CRUZ AZUL el 21/10/2026',
}

// ── Escenarios ──────────────────────────────────────────────────────────────────────────

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
  // ANTES DE CERRAR, que la consola termine de decidir. Al abrirse sin perfil, la consola crea
  // uno y lo hace bóveda de este navegador (`setSelfVault(true)`); al emparejarse, la siguiente
  // sincronización ve el cert y la apaga — más o menos un segundo y medio después de que se va
  // el código. Si la pestaña se cierra antes, el perfil emparejado se queda como «bóveda en
  // pestaña» y el iframe de identidad contesta `listVaultDevices` con lo local, sin acta: las
  // apps no ven a los aparatos que entren después (ver el informe de este smoke).
  const frame = page.frames().find((f) => f.url().startsWith(webIframe.url))
  await waitFor(() => frame.evaluate(() => localStorage.getItem('dotrino.self-vault.enabled') !== localStorage.getItem('dotrino.identity.current')),
    { what: 'the console to stop serving as a vault in this browser once paired' })
  await page.close()
})

scenario('the expenses agent enrolls as a service with the «expenses» drawer', async () => {
  const { enroll } = await import(path.join(AGENT_DEPS, '@dotrino/remote-agent/src/link.js'))
  const { LABEL } = await import(path.join(AGENT, 'index.js'))
  agentDir = tmpDir('expenses-agent')
  // La invitación que pide el agente (`dotrino-vault pair --service expenses --scope sign`): el
  // cajón `expenses` en el cert y `sign` en el acta. Sin `sign` el agente corre, pero no puede
  // renovar su papel (remote-agent exige vault:sign en el renovado).
  const qr = await vault.pair({ service: 'expenses', caps: ['sign'] })
  const link = await enroll({ qr, dir: agentDir, label: LABEL, ns: 'expenses', onChallenge: ({ code }) => { vault.waitPending().then(() => vault.approve(code)) } })
  assert.equal(link.ns, 'expenses', 'the link remembers its drawer')
  const scope = [].concat(link.cert?.scope || [])
  assert.ok(scope.includes('vault:secrets:expenses'), 'the cert can read the expenses drawer: ' + JSON.stringify(scope))
  assert.ok(scope.includes('vault:sign'), 'and sign, as the invitation asked: ' + JSON.stringify(scope))
})

scenario('the agent stores the mailbox credentials in its drawer (the PWA never sees them)', async () => {
  const { loadLink } = await import(path.join(AGENT_DEPS, '@dotrino/remote-agent/src/link.js'))
  const { storeVars, fetchSecrets } = await import(path.join(AGENT_DEPS, '@dotrino/vault/src/service.js'))
  const { secretsArgs } = await import(path.join(AGENT, 'index.js'))
  const { varsFromAnswers } = await import(path.join(AGENT, 'src/config.js'))
  const link = loadLink(agentDir)
  // Lo que hace `dotrino-expenses-agent setup`. Puerto != 993: sin TLS desde el primer byte.
  const vars = varsFromAnswers({ host: '127.0.0.1', port: mail.port, user: MAIL_USER, password: MAIL_PASSWORD, folder: 'INBOX' })
  const r = await storeVars({ ...secretsArgs(link), vars })
  log('  storeVars → ' + JSON.stringify(r))
  assert.ok(!r.pending, 'new keys are stored without waiting for an approval: ' + JSON.stringify(r))
  const secrets = await fetchSecrets(secretsArgs(link))
  assert.equal(secrets.IMAP_HOST, '127.0.0.1')
  assert.equal(secrets.IMAP_PORT, String(mail.port))
  assert.equal(secrets.IMAP_USER, MAIL_USER)
  assert.equal(secrets.IMAP_PASSWORD, MAIL_PASSWORD)
  assert.equal(secrets.IMAP_FOLDER, 'INBOX')
})

scenario('the agent starts and the mailbox gets a purchase notice and a promo', async () => {
  const { startExpensesAgent } = await import(path.join(AGENT, 'index.js'))
  agent = await startExpensesAgent({
    dir: agentDir, version: '0.0.0-smoke', proxyUrl: proxy.url, quiet: !VERBOSE,
    log: (m) => log('[expenses-agent] ' + m),
  })
  await appendMails([PURCHASE, PROMO])
})

scenario('the PWA finds the agent, shows the mailbox and pulls on its own: the purchase is waiting, the promo is not', async () => {
  pwaPage = await context.newPage()
  pwaPage.on('console', (m) => log('[pwa] ' + m.text()))
  pwaPage.on('pageerror', (e) => log('[pwa!] ' + e.message))
  await pwaPage.goto(`${webPwa.url}/?vault=${encodeURIComponent(iframeUrl())}`)
  await pwaPage.locator('[data-testid="tab-inbox"]').click()
  const card = pwaPage.locator('[data-testid="mailbox-card"]')
  await card.waitFor({ timeout: 30000 })
  // Lo que enseña la tarjeta si no encuentra el agente, para que el fallo diga por qué.
  const why = async () => (await card.innerText()).replace(/\s+/g, ' ')
  await pwaPage.locator('[data-testid="mailbox"]').first().waitFor({ timeout: 60000 })
    .catch(async (e) => { throw new Error(`the card did not find the agent: «${await why()}»`, { cause: e }) })
  const status = pwaPage.locator('[data-testid="mailbox-status"]')
  await status.waitFor({ timeout: 45000 })
    .catch(async (e) => { throw new Error(`no mailbox status: «${await why()}»`, { cause: e }) })
  const statusText = (await status.innerText()).replace(/\s+/g, ' ')
  log('  status: ' + statusText)
  assert.match(statusText, /an…@example\.com · INBOX/, 'it says which mailbox it reads, the user half-hidden')
  // Trae sola al abrir la pestaña.
  await waitFor(async () => (await inboxItems().count()) > 0, { timeoutMs: 60000, what: 'an inbox item' })
    .catch(async (e) => { throw new Error(`${e.message} (card: «${await why()}»)`, { cause: e }) })
  await sleep(1000)
  const amounts = await inboxAmounts()
  log('  inbox: ' + JSON.stringify(amounts))
  assert.equal(amounts.length, 1, 'only the purchase: the promo does not create an item: ' + JSON.stringify(amounts))
  assert.match(amounts[0], /25,40|25\.40/, 'with its amount')
  assert.match(await inboxItems().first().innerText(), /SUPERMAXI/i, 'and its merchant')
  assert.match(await pwaPage.locator('[data-testid="mailbox-note"]').innerText(), /1/, 'the card says how many came in')
})

scenario('accepting it moves it to the month', async () => {
  // Los botones van en la fila de debajo del aviso (hermanos, no dentro): el primer «Aceptar».
  await pwaPage.locator('[data-testid="inbox-accept"]').first().click()
  await waitFor(async () => (await inboxItems().count()) === 0, { what: 'the item to leave the inbox' })
  await pwaPage.locator('[data-testid="tab-month"]').click()
  // El movimiento es del 20/10/2026; el mes abre en el actual. Si no es octubre de 2026, se va
  // con las flechas hasta él.
  const target = new Date(2026, 9, 1)
  const now = new Date()
  const steps = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth())
  const arrow = pwaPage.locator(`[data-testid="${steps < 0 ? 'prev-month' : 'next-month'}"]`)
  for (let i = 0; i < Math.abs(steps); i++) await arrow.click()
  const movement = pwaPage.locator('[data-testid="movement"]', { hasText: /SUPERMAXI/i })
  await movement.first().waitFor({ timeout: 20000 })
  assert.match(await movement.first().locator('[data-testid="movement-amount"]').innerText(), /25,40|25\.40/)
})

scenario('a new mail and «Pull»: exactly one new item (the cursor moves, nothing is duplicated)', async () => {
  // Al volver a la pestaña la tarjeta se monta de nuevo y trae sola: con el cursor guardado en
  // el almacén no hay nada nuevo, y lo ya aceptado no vuelve.
  await pwaPage.locator('[data-testid="tab-inbox"]').click()
  const nothingNew = async () => /nada nuevo|nothing new/i.test(await pwaPage.locator('[data-testid="mailbox-note"]').innerText().catch(() => ''))
  await waitFor(nothingNew, { timeoutMs: 60000, what: 'the automatic pull on return to find nothing new' })
  assert.equal(await inboxItems().count(), 0, 'the accepted purchase does not come back')
  // Llega un correo nuevo y se pulsa «Traer».
  await appendMails([LATER])
  const pull = pwaPage.locator('[data-testid="mailbox-pull"]')
  await waitFor(async () => pull.isEnabled(), { timeoutMs: 60000, what: 'the pull button to be enabled' })
  await pull.click()
  await waitFor(async () => (await inboxItems().count()) > 0, { timeoutMs: 60000, what: 'the new item' })
    .catch(async (e) => { throw new Error(`${e.message} (card: «${(await pwaPage.locator('[data-testid="mailbox-card"]').innerText()).replace(/\s+/g, ' ')}»)`, { cause: e }) })
  await waitFor(async () => pull.isEnabled(), { timeoutMs: 60000, what: 'the pull to finish' })
  const amounts = await inboxAmounts()
  log('  inbox: ' + JSON.stringify(amounts))
  assert.equal(amounts.length, 1, 'only the new one; the accepted purchase does not come back: ' + JSON.stringify(amounts))
  assert.match(amounts[0], /13,75|13\.75/)
  // Y otra vez, sin correo nuevo: nada.
  await pull.click()
  await waitFor(nothingNew, { timeoutMs: 60000, what: 'the «nothing new» note' })
  assert.equal(await inboxItems().count(), 1, 'pulling again adds nothing')
})

console.log('\nSMOKE · bank mail into Expenses: IMAP → agent → PWA, all local\n')
for (const [dir, how] of [[CONSOLE, 'cd dotrino-vault/web && npm run build'], [PWA, 'cd dotrino-expenses && npm run build'], [AGENT_DEPS, 'cd dotrino-expenses-agent && npm install']]) {
  const probe = dir === AGENT_DEPS ? path.join(dir, 'imapflow') : path.join(dir, 'index.html')
  if (!fs.existsSync(probe)) { console.error(`Missing a build. Build it with:  ${how}\n`); process.exit(2) }
}
try {
  const { chromium } = await import('playwright')
  await startGreenMail()
  proxy = await startProxy({ log })
  vault = await startVault({ proxyUrl: proxy.url, name: 'vault', log })
  webConsole = await serveStatic(CONSOLE, { spa: true })
  webIframe = await serveStatic(IFRAME)
  webPwa = await serveStatic(PWA, { spa: true })
  console.log(`  proxy  ${proxy.url}`)
  console.log(`  imap   127.0.0.1:${mail.port}`)
  console.log(`  pwa    ${webPwa.url}/\n`)
  browser = await chromium.launch({ headless: !VERBOSE })
  context = await browser.newContext({ locale: 'es-ES' })
  const ok = await runScenarios()
  try { agent?.close() } catch (_) {}
  await context?.close(); await browser?.close()
  await teardown()
  stopGreenMail()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { agent?.close() } catch (_) {}
  try { await context?.close(); await browser?.close() } catch (_) {}
  await teardown()
  stopGreenMail()
  process.exit(1)
}
