/**
 * LA INTERFAZ COMPARTIDA — `<dotrino-profile>` y `<dotrino-topbar>` en un navegador de verdad.
 *
 * Estos dos componentes salen en TODAS las apps, así que un detalle feo aquí se ve en todo
 * el ecosistema. Esta suite existe porque pasó: el modal enseñaba la pubkey en crudo
 * (`{"crv":"P-25…`), que no es un identificador sino un error de programa a la vista, y el
 * conmutador de perfiles mostraba siempre el identicon aunque hubieras subido una foto.
 *
 * Se montan con un proveedor de mentira (sin red ni identidad real): lo que se comprueba es
 * lo que se PINTA, que es donde estaban los fallos.
 *
 *   npm run smoke:ui
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { scenario, runScenarios, freePort, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const PUB = JSON.stringify({
  key_ops: ['verify'], ext: true, kty: 'EC',
  x: 'H-iGp96axcnCU_WibLDhz5woTfrTwZ90L9qjKCM9BgI',
  y: 'aOKDGCH0W4h5mvfJDzOYZku_LemsUPWoIObyy73La7k', crv: 'P-256'
})
const PUB2 = PUB.replace('H-iG', 'ZZZZ')
const PHOTO = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='

/** Sirve los repos tal cual, con un import map que resuelve los `@dotrino/*` a disco. */
function pageWith (body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>ui</title>
<script type="importmap">{"imports":{
  "@dotrino/identity/avatar":"/id/vault/avatar.js",
  "@dotrino/identity/capabilities":"/id/vault/capabilities.js",
  "@dotrino/identity/keyid":"/id/vault/keyid.js",
  "@dotrino/profile":"/prof/src/index.js",
  "@dotrino/support":"/stub-vacio.js",
  "@dotrino/nav":"/stub-nav.js"
}}</script></head><body>${body}</body></html>`
}

let server = null
let base = ''

async function serve () {
  const TYPES = { '.js': 'text/javascript;charset=utf-8', '.svg': 'image/svg+xml' }
  const port = await freePort()
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x').pathname
    if (u === '/stub-vacio.js') return res.writeHead(200, { 'content-type': TYPES['.js'] }).end('export default {}')
    if (u === '/stub-nav.js') {
      // El topbar importa el pilar de navegación; aquí solo estorba.
      return res.writeHead(200, { 'content-type': TYPES['.js'] })
        .end('export function createBackNav(){return{destroy(){}}}\nexport function getBackNav(){return{push(){},destroy(){}}}\nexport default {}')
    }
    const f = u.startsWith('/id/') ? path.join(ROOT, 'dotrino-identity', u.slice(4))
      : u.startsWith('/prof/') ? path.join(ROOT, 'dotrino-profile', u.slice(6))
        : u.startsWith('/tb/') ? path.join(ROOT, 'dotrino-topbar', u.slice(4)) : null
    if (!f || !fs.existsSync(f)) return res.writeHead(404).end('not found')
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' })
    fs.createReadStream(f).pipe(res)
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  base = `http://127.0.0.1:${port}`
}

let browser = null
let context = null

async function open (body, script) {
  const page = await context.newPage()
  page.on('pageerror', (e) => log('[error] ' + e.message))
  await page.route('**/ui', (route) => route.fulfill({ contentType: 'text/html', body: pageWith(body) }))
  await page.goto(base + '/ui')
  await page.addScriptTag({ type: 'module', content: script })
  await page.addScriptTag({ content: MEASURER })
  await page.waitForTimeout(900)
  return page
}

/**
 * Lo que se sale de la tarjeta por la derecha. Se mide contra el borde del propio
 * componente, no con `scrollWidth`: un texto recortado con puntos suspensivos «desborda»
 * según `scrollWidth` y está perfectamente bien. Lo que no puede pasar es que una caja se
 * pinte fuera de la tarjeta, que es lo que se ve feo.
 */
const MEASURER = `window.measureOverflow = () => {
  const host = document.querySelector('dotrino-profile')
  // El límite es el CONTENEDOR de la app, no la tarjeta: el fallo típico es justo que la
  // tarjeta crezca más que el hueco que le dieron, y entonces medida contra sí misma
  // «cabe» perfectamente mientras se sale por la derecha de la pantalla.
  const box = document.getElementById('host') || host.parentElement
  const limit = box.getBoundingClientRect().right
  const own = host.getBoundingClientRect()
  const bad = own.right > limit + 2 ? [{ cls: 'the whole card', overflow: Math.round(own.right - limit) }] : []
  for (const n of host.shadowRoot.querySelectorAll('*')) {
    const r = n.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > limit + 2) bad.push({ cls: String(n.className || n.tagName), overflow: Math.round(r.right - limit) })
  }
  return bad
}`

/** Texto visible del shadow DOM (sin estilos, que si no se cuela el CSS entero). */
const textOf = (page, sel) => page.evaluate((s) => {
  const sr = document.querySelector(s)?.shadowRoot
  if (!sr) return ''
  return [...sr.children].filter((n) => n.tagName !== 'STYLE')
    .map((n) => n.innerText || n.textContent || '').join('\n').replace(/\s+/g, ' ').trim()
}, sel)

scenario('the profile modal NEVER shows the raw pubkey', async () => {
  const page = await open('<div id="host"></div>', `
    import '/prof/src/index.js'
    const PUB = ${JSON.stringify(PUB)}
    const el = document.createElement('dotrino-profile')
    el.setAttribute('mode','self'); el.setAttribute('pubkey', PUB); el.setAttribute('name','Dotrino'); el.setAttribute('lang','es')
    el.provider = {
      async listProfiles(){ return [{ id:'p1', name:'Dotrino', pubkey: PUB, avatar: ${JSON.stringify(PHOTO)}, current:true }] },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async getMyProfile(){ return { nickname:'Dotrino' } },
      async getMyRating(){ return null }, async getEndorsements(){ return [] }, async getCloud(){ return null }
    }
    document.getElementById('host').appendChild(el)
  `)

  const text = await textOf(page, 'dotrino-profile')
  assert.ok(!text.includes('"crv"') && !text.includes('"kty"'),
    'no piece of a JWK may appear on screen: ' + text.slice(0, 160))
  assert.match(text, /[0-9A-F]{4}-[0-9A-F]{4}/, 'it shows the readable key fingerprint')
  assert.match(text, /Dotrino/, 'and the name')
  await page.close()
})

scenario('the profile switcher shows YOUR photo, not the identicon, when there is one', async () => {
  const page = await open('<div id="host"></div>', `
    import '/prof/src/index.js'
    const PUB = ${JSON.stringify(PUB)}, PUB2 = ${JSON.stringify(PUB2)}
    const el = document.createElement('dotrino-profile')
    el.setAttribute('mode','self'); el.setAttribute('pubkey', PUB); el.setAttribute('name','Dotrino'); el.setAttribute('lang','es')
    el.provider = {
      async listProfiles(){ return [
        { id:'p1', name:'Dotrino', pubkey: PUB, avatar: ${JSON.stringify(PHOTO)}, current:true },
        { id:'p2', name:'Trabajo', pubkey: PUB2, current:false }
      ] },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async getMyProfile(){ return { nickname:'Dotrino' } },
      async getMyRating(){ return null }, async getEndorsements(){ return [] }, async getCloud(){ return null }
    }
    document.getElementById('host').appendChild(el)
  `)

  const sources = await page.evaluate(() => [...document.querySelector('dotrino-profile')
    .shadowRoot.querySelectorAll('.prof-row img')].map((i) => i.getAttribute('src')))
  assert.equal(sources.length, 2)
  assert.equal(sources[0], 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'the one with a photo shows it')
  assert.match(sources[1], /^data:image\/svg/, 'the one without falls back to the identicon')
  await page.close()
})

scenario('creating a profile leads to its page and does not create it on the spot', async () => {
  let created = false
  const page = await open('<div id="host"></div>', `
    import '/prof/src/index.js'
    const PUB = ${JSON.stringify(PUB)}
    const el = document.createElement('dotrino-profile')
    el.setAttribute('mode','self'); el.setAttribute('pubkey', PUB); el.setAttribute('lang','es'); el.setAttribute('manage','')
    window.__created = false
    el.provider = {
      async listProfiles(){ return [{ id:'p1', name:'Dotrino', pubkey: PUB, current:true }] },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async getMyProfile(){ return { nickname:'Dotrino' } },
      async createProfile(){ window.__created = true },
      async getMyRating(){ return null }, async getEndorsements(){ return [] }, async getCloud(){ return null }
    }
    document.getElementById('host').appendChild(el)
  `)

  const link = await page.evaluate(() => {
    const a = document.querySelector('dotrino-profile').shadowRoot.querySelector('.prof-new')
    return { tag: a?.tagName, href: a?.getAttribute('href') || '' }
  })
  assert.equal(link.tag, 'A', 'it is a link, not a button that creates on the fly')
  assert.match(link.href, /profile\.dotrino\.com\/create/, 'it points to the shared creation page')
  created = await page.evaluate(() => window.__created)
  assert.equal(created, false, 'no profile was created just by opening the modal')
  await page.close()
})

scenario('the topbar opens the profile menu when the avatar is CLICKED', async () => {
  const page = await open('', `
    import '/tb/src/index.js'
    const PUB = ${JSON.stringify(PUB)}, PUB2 = ${JSON.stringify(PUB2)}
    const tb = document.createElement('dotrino-topbar')
    tb.setAttribute('profile',''); tb.setAttribute('lang','es')
    tb.identity = {
      me: { publickey: PUB },
      async getMe(){ return { avatar: null } },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async listProfiles(){ return [
        { id:'p1', name:'Dotrino', pubkey: PUB, avatar: ${JSON.stringify(PHOTO)}, current:true },
        { id:'p2', name:'Trabajo', pubkey: PUB2, current:false }
      ] },
      // En sessionStorage porque cambiar de perfil RECARGA la página (no es reactivo,
      // por diseño) y una variable suelta no sobreviviría a la recarga.
      async switchProfile(id){ sessionStorage.setItem('switched', id) }
    }
    tb.reputation = {}
    document.body.appendChild(tb)
  `)

  // El menú nace oculto: solo aparece al acercarse.
  const before = await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.prof-menu').hidden)
  assert.equal(before, true, 'it stays out of the way until asked')

  await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.profile').click())
  await page.waitForTimeout(500)

  const menu = await page.evaluate(() => {
    const m = document.querySelector('dotrino-topbar').shadowRoot.querySelector('.prof-menu')
    return { hidden: m.hidden, text: (m.innerText || m.textContent).replace(/\s+/g, ' ').trim() }
  })
  assert.equal(menu.hidden, false, 'it opens on click')
  assert.match(menu.text, /Dotrino/)
  assert.match(menu.text, /Trabajo/, 'it lists the other profiles to switch in one click')
  assert.match(menu.text, /Abrir mi perfil/, 'and offers to open your profile (on mobile it is the only way)')
  assert.match(menu.text, /Crear perfil/, 'and to create a new one')

  // Ninguna fila puede pintarse fuera del menú: el resaltado del ratón se salía por los
  // lados (width:100% + relleno sin box-sizing) y el visto del perfil activo quedaba
  // montado sobre el borde.
  const rows = await page.evaluate(() => {
    const sr = document.querySelector('dotrino-topbar').shadowRoot
    const m = sr.querySelector('.prof-menu')
    const box = m.getBoundingClientRect()
    const style = getComputedStyle(m)
    const innerLeft = box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)
    const innerRight = box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)
    return [...m.querySelectorAll('.item')].map((n) => {
      const r = n.getBoundingClientRect()
      return { cls: n.className, overLeft: +(innerLeft - r.left).toFixed(1), overRight: +(r.right - innerRight).toFixed(1) }
    })
  })
  for (const f of rows) {
    assert.ok(f.overLeft <= 0.5 && f.overRight <= 0.5,
      'a row overflows the menu: ' + JSON.stringify(f))
  }

  // El visto del activo tiene su propio hueco, no va pegado al borde.
  const check = await page.evaluate(() => {
    const sr = document.querySelector('dotrino-topbar').shadowRoot
    const mark = sr.querySelector('.prof-menu .item[aria-current] .marca')
    if (!mark) return null
    const row = mark.closest('.item').getBoundingClientRect()
    return +(row.right - mark.getBoundingClientRect().right).toFixed(1)
  })
  assert.ok(check !== null && check >= 4, 'the active profile check mark keeps away from the edge: ' + check)

  // Cambiar de perfil avisa al vault y RECARGA la app (así todo arranca con el nuevo).
  await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot
    .querySelector('[data-switch="p2"]').click())
  await page.waitForTimeout(800)
  assert.equal(await page.evaluate(() => sessionStorage.getItem('switched')), 'p2', 'it switches to the chosen profile')
  await page.close()
})

scenario('clicking the avatar opens NO modal and does not navigate: it opens the menu', async () => {
  const page = await open('', `
    import '/tb/src/index.js'
    const PUB = ${JSON.stringify(PUB)}
    const tb = document.createElement('dotrino-topbar')
    tb.setAttribute('profile',''); tb.setAttribute('lang','es')
    tb.identity = { me:{ publickey: PUB }, async getMe(){ return {} },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async listProfiles(){ return [{ id:'p1', name:'Dotrino', pubkey: PUB, current:true }] } }
    tb.reputation = {}
    document.body.appendChild(tb)
  `)

  const urlBefore = page.url()
  await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.profile').click())
  await page.waitForTimeout(600)

  assert.equal(page.url(), urlBefore, 'clicking does not leave the page: it opens the menu')
  const modals = await page.evaluate(() => document.querySelectorAll('dotrino-profile[modal]').length)
  assert.equal(modals, 0, 'and no profile modal appears')
  const isOpen = await page.evaluate(() => !document.querySelector('dotrino-topbar').shadowRoot.querySelector('.prof-menu').hidden)
  assert.equal(isOpen, true, 'the menu stays open')

  // Y desde ahí se llega a tu perfil, que es un enlace normal.
  const href = await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot
    .querySelector('.prof-menu a')?.getAttribute('href'))
  assert.match(href || '', /profile\.dotrino\.com/, '«Abrir mi perfil» leads to your page')

  // Un segundo clic lo cierra.
  await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.profile').click())
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.prof-menu').hidden), true, 'and another click closes it')
  await page.close()
})

scenario("another person's MODAL does not overflow on a narrow screen", async () => {
  const page = await open('<div id="host"></div>', `
    import '/prof/src/index.js'
    const PUB = ${JSON.stringify(PUB)}, PUB2 = ${JSON.stringify(PUB2)}
    const el = document.createElement('dotrino-profile')
    el.setAttribute('modal','')
    el.setAttribute('mode','edit'); el.setAttribute('pubkey', PUB2); el.setAttribute('lang','es')
    el.setAttribute('name','Una persona con un nombre larguísimo de verdad')
    el.provider = {
      async getMyRating(){ return { confianza: 4, afinidad: 3, notes: 'una nota bastante larga sobre esta persona que no debería romper la caja por ningún lado' } },
      async getEndorsements(){ return [
        { ratedBy: PUB, rating: 5, issuedAt: Date.now() },
        { ratedBy: PUB2, rating: 4, issuedAt: Date.now() }
      ] },
      async getCloud(){ return null },
      async getProfile(){ return {
        nickname: 'Nombre larguísimo sin espacios: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        email: 'un.correo.electronico.francamente.larguisimo@un-dominio-muy-largo.example.com',
        links: [{ id:'l1', type:'web', value:'https://ejemplo.com/una/ruta/absurdamente/larga/que-no-cabe/de-ninguna-manera?y=con&parametros=tambien' }],
        fields: [{ id:'f1', label:'Un campo', value:'valorlargísimosinespaciosqueesloquesuelerompersiempreelanchodelascajas' }]
      } }
    }
    document.getElementById('host').appendChild(el)
  `)

  // En un modal el límite es la PANTALLA, no un hueco de la app.
  const outside = await page.evaluate(() => {
    const sr = document.querySelector('dotrino-profile').shadowRoot
    const width = document.documentElement.clientWidth
    return [...sr.querySelectorAll('*')]
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.right > width + 2)
      .map((x) => ({ cls: String(x.n.className || x.n.tagName), overflow: Math.round(x.r.right - width) }))
      .slice(0, 8)
  })
  assert.deepEqual(outside, [], 'nothing may overflow the screen: ' + JSON.stringify(outside))
  await page.close()
})

scenario('your own profile, with the editor and several profiles, does not overflow either', async () => {
  const page = await open('<div id="host" style="width:360px"></div>', `
    import '/prof/src/index.js'
    const PUB = ${JSON.stringify(PUB)}, PUB2 = ${JSON.stringify(PUB2)}
    const el = document.createElement('dotrino-profile')
    el.setAttribute('mode','self'); el.setAttribute('pubkey', PUB); el.setAttribute('lang','es')
    el.setAttribute('manage',''); el.setAttribute('allow-edit','')
    el.setAttribute('name','Un nombre bastante largo para la caja')
    el.provider = {
      async listProfiles(){ return [
        { id:'p1', name:'Un nombre de perfil larguísimo que no cabe ni de broma', pubkey: PUB, current:true },
        { id:'p2', name:'Trabajo', pubkey: PUB2, current:false }
      ] },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async getMyProfile(){ return {
        nickname: 'Dotrino',
        email: 'un.correo.electronico.francamente.larguisimo@un-dominio-muy-largo.example.com',
        direccion: 'Una dirección larga de esas que no terminan nunca, con número, referencia y todo lo demás',
        links: [{ id:'l1', type:'web', value:'https://ejemplo.com/una/ruta/absurdamente/larga/que-no-cabe?y=con&parametros' }],
        fields: [{ id:'f1', label:'Campo', value:'valorlarguísimosinespaciosqueesloquerompelascajas' }]
      } },
      async getMyRating(){ return null }, async getEndorsements(){ return [] }, async getCloud(){ return null }
    }
    document.getElementById('host').appendChild(el)
  `)

  const overflows = await page.evaluate(() => window.measureOverflow())
  const widths = await page.evaluate(() => {
    const host = document.getElementById('host'); const el = document.querySelector('dotrino-profile')
    const wide = [...el.shadowRoot.querySelectorAll('*')]
      .map((n) => ({ c: String(n.className || n.tagName), w: Math.round(n.getBoundingClientRect().width) }))
      .filter((x) => x.w > host.getBoundingClientRect().width + 2).slice(0, 6)
    return { slot: Math.round(host.getBoundingClientRect().width), card: Math.round(el.getBoundingClientRect().width), wide }
  })
  log('widths: ' + JSON.stringify(widths))
  assert.ok(widths.card <= widths.slot + 2,
    `the card (${widths.card}px) does not fit its slot (${widths.slot}px): ` + JSON.stringify(widths.wide))
  assert.deepEqual(overflows, [], 'nothing may overflow its box: ' + JSON.stringify(overflows))
  await page.close()
})

// ---------- arranque ----------

console.log('\nSMOKE · the shared UI (profile and topbar) in a browser\n')
try {
  const { chromium } = await import('playwright')
  await serve()
  browser = await chromium.launch({ headless: !VERBOSE })
  // Pantalla estrecha a propósito: los desbordes se ven en el móvil, no en el escritorio.
  context = await browser.newContext({ locale: 'es-ES', viewport: { width: 380, height: 820 } })
  const ok = await runScenarios()
  await context?.close(); await browser?.close(); server?.close()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\ncould not set up the scenario:', e?.stack || e)
  try { await context?.close(); await browser?.close(); server?.close() } catch (_) {}
  process.exit(1)
}
