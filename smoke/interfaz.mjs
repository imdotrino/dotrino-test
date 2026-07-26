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
 *   npm run smoke:interfaz
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { escenario, correr, freePort, ROOT } from './lib/harness.js'

const VERBOSE = process.argv.includes('--verbose')
const log = (m) => { if (VERBOSE) console.log(m) }

const PUB = JSON.stringify({
  key_ops: ['verify'], ext: true, kty: 'EC',
  x: 'H-iGp96axcnCU_WibLDhz5woTfrTwZ90L9qjKCM9BgI',
  y: 'aOKDGCH0W4h5mvfJDzOYZku_LemsUPWoIObyy73La7k', crv: 'P-256'
})
const PUB2 = PUB.replace('H-iG', 'ZZZZ')
const FOTO = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='

/** Sirve los repos tal cual, con un import map que resuelve los `@dotrino/*` a disco. */
function paginaCon (cuerpo) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>ui</title>
<script type="importmap">{"imports":{
  "@dotrino/identity/avatar":"/id/vault/avatar.js",
  "@dotrino/identity/capabilities":"/id/vault/capabilities.js",
  "@dotrino/identity/keyid":"/id/vault/keyid.js",
  "@dotrino/profile":"/prof/src/index.js",
  "@dotrino/support":"/stub-vacio.js",
  "@dotrino/nav":"/stub-nav.js"
}}</script></head><body>${cuerpo}</body></html>`
}

let servidor = null
let base = ''

async function servir () {
  const TIPOS = { '.js': 'text/javascript;charset=utf-8', '.svg': 'image/svg+xml' }
  const port = await freePort()
  servidor = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x').pathname
    if (u === '/stub-vacio.js') return res.writeHead(200, { 'content-type': TIPOS['.js'] }).end('export default {}')
    if (u === '/stub-nav.js') {
      // El topbar importa el pilar de navegación; aquí solo estorba.
      return res.writeHead(200, { 'content-type': TIPOS['.js'] })
        .end('export function createBackNav(){return{destroy(){}}}\nexport function getBackNav(){return{push(){},destroy(){}}}\nexport default {}')
    }
    const f = u.startsWith('/id/') ? path.join(ROOT, 'dotrino-identity', u.slice(4))
      : u.startsWith('/prof/') ? path.join(ROOT, 'dotrino-profile', u.slice(6))
        : u.startsWith('/tb/') ? path.join(ROOT, 'dotrino-topbar', u.slice(4)) : null
    if (!f || !fs.existsSync(f)) return res.writeHead(404).end('no está')
    res.writeHead(200, { 'content-type': TIPOS[path.extname(f)] || 'application/octet-stream' })
    fs.createReadStream(f).pipe(res)
  })
  await new Promise((r) => servidor.listen(port, '127.0.0.1', r))
  base = `http://127.0.0.1:${port}`
}

let navegador = null
let contexto = null

async function abrir (cuerpo, guion) {
  const page = await contexto.newPage()
  page.on('pageerror', (e) => log('[error] ' + e.message))
  await page.route('**/ui', (route) => route.fulfill({ contentType: 'text/html', body: paginaCon(cuerpo) }))
  await page.goto(base + '/ui')
  await page.addScriptTag({ type: 'module', content: guion })
  await page.addScriptTag({ content: MEDIDOR })
  await page.waitForTimeout(900)
  return page
}

/**
 * Lo que se sale de la tarjeta por la derecha. Se mide contra el borde del propio
 * componente, no con `scrollWidth`: un texto recortado con puntos suspensivos «desborda»
 * según `scrollWidth` y está perfectamente bien. Lo que no puede pasar es que una caja se
 * pinte fuera de la tarjeta, que es lo que se ve feo.
 */
const MEDIDOR = `window.medirDesborde = () => {
  const host = document.querySelector('dotrino-profile')
  // El límite es el CONTENEDOR de la app, no la tarjeta: el fallo típico es justo que la
  // tarjeta crezca más que el hueco que le dieron, y entonces medida contra sí misma
  // «cabe» perfectamente mientras se sale por la derecha de la pantalla.
  const caja = document.getElementById('host') || host.parentElement
  const limite = caja.getBoundingClientRect().right
  const propio = host.getBoundingClientRect()
  const malos = propio.right > limite + 2 ? [{ clase: 'la tarjeta entera', sobra: Math.round(propio.right - limite) }] : []
  for (const n of host.shadowRoot.querySelectorAll('*')) {
    const r = n.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > limite + 2) malos.push({ clase: String(n.className || n.tagName), sobra: Math.round(r.right - limite) })
  }
  return malos
}`

/** Texto visible del shadow DOM (sin estilos, que si no se cuela el CSS entero). */
const textoDe = (page, sel) => page.evaluate((s) => {
  const sr = document.querySelector(s)?.shadowRoot
  if (!sr) return ''
  return [...sr.children].filter((n) => n.tagName !== 'STYLE')
    .map((n) => n.innerText || n.textContent || '').join('\n').replace(/\s+/g, ' ').trim()
}, sel)

escenario('el modal de perfil NUNCA enseña la pubkey en crudo', async () => {
  const page = await abrir('<div id="host"></div>', `
    import '/prof/src/index.js'
    const PUB = ${JSON.stringify(PUB)}
    const el = document.createElement('dotrino-profile')
    el.setAttribute('mode','self'); el.setAttribute('pubkey', PUB); el.setAttribute('name','Dotrino'); el.setAttribute('lang','es')
    el.provider = {
      async listProfiles(){ return [{ id:'p1', name:'Dotrino', pubkey: PUB, avatar: ${JSON.stringify(FOTO)}, current:true }] },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async getMyProfile(){ return { nickname:'Dotrino' } },
      async getMyRating(){ return null }, async getEndorsements(){ return [] }, async getCloud(){ return null }
    }
    document.getElementById('host').appendChild(el)
  `)

  const texto = await textoDe(page, 'dotrino-profile')
  assert.ok(!texto.includes('"crv"') && !texto.includes('"kty"'),
    'no puede aparecer un trozo de JWK en pantalla: ' + texto.slice(0, 160))
  assert.match(texto, /[0-9A-F]{4}-[0-9A-F]{4}/, 'muestra la huella legible de la llave')
  assert.match(texto, /Dotrino/, 'y el nombre')
  await page.close()
})

escenario('el conmutador de perfiles muestra TU foto, no el identicon, cuando la hay', async () => {
  const page = await abrir('<div id="host"></div>', `
    import '/prof/src/index.js'
    const PUB = ${JSON.stringify(PUB)}, PUB2 = ${JSON.stringify(PUB2)}
    const el = document.createElement('dotrino-profile')
    el.setAttribute('mode','self'); el.setAttribute('pubkey', PUB); el.setAttribute('name','Dotrino'); el.setAttribute('lang','es')
    el.provider = {
      async listProfiles(){ return [
        { id:'p1', name:'Dotrino', pubkey: PUB, avatar: ${JSON.stringify(FOTO)}, current:true },
        { id:'p2', name:'Trabajo', pubkey: PUB2, current:false }
      ] },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async getMyProfile(){ return { nickname:'Dotrino' } },
      async getMyRating(){ return null }, async getEndorsements(){ return [] }, async getCloud(){ return null }
    }
    document.getElementById('host').appendChild(el)
  `)

  const fuentes = await page.evaluate(() => [...document.querySelector('dotrino-profile')
    .shadowRoot.querySelectorAll('.prof-row img')].map((i) => i.getAttribute('src')))
  assert.equal(fuentes.length, 2)
  assert.equal(fuentes[0], 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'el que tiene foto la enseña')
  assert.match(fuentes[1], /^data:image\/svg/, 'el que no la tiene cae al identicon')
  await page.close()
})

escenario('crear un perfil lleva a su página y no lo crea de golpe', async () => {
  let creado = false
  const page = await abrir('<div id="host"></div>', `
    import '/prof/src/index.js'
    const PUB = ${JSON.stringify(PUB)}
    const el = document.createElement('dotrino-profile')
    el.setAttribute('mode','self'); el.setAttribute('pubkey', PUB); el.setAttribute('lang','es'); el.setAttribute('manage','')
    window.__creado = false
    el.provider = {
      async listProfiles(){ return [{ id:'p1', name:'Dotrino', pubkey: PUB, current:true }] },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async getMyProfile(){ return { nickname:'Dotrino' } },
      async createProfile(){ window.__creado = true },
      async getMyRating(){ return null }, async getEndorsements(){ return [] }, async getCloud(){ return null }
    }
    document.getElementById('host').appendChild(el)
  `)

  const enlace = await page.evaluate(() => {
    const a = document.querySelector('dotrino-profile').shadowRoot.querySelector('.prof-new')
    return { tag: a?.tagName, href: a?.getAttribute('href') || '' }
  })
  assert.equal(enlace.tag, 'A', 'es un enlace, no un botón que crea al vuelo')
  assert.match(enlace.href, /profile\.dotrino\.com\/create/, 'apunta a la página común de creación')
  creado = await page.evaluate(() => window.__creado)
  assert.equal(creado, false, 'no se creó ningún perfil solo por abrir el modal')
  await page.close()
})

escenario('el topbar abre el menú de perfiles al PULSAR el avatar', async () => {
  const page = await abrir('', `
    import '/tb/src/index.js'
    const PUB = ${JSON.stringify(PUB)}, PUB2 = ${JSON.stringify(PUB2)}
    const tb = document.createElement('dotrino-topbar')
    tb.setAttribute('profile',''); tb.setAttribute('lang','es')
    tb.identity = {
      me: { publickey: PUB },
      async getMe(){ return { avatar: null } },
      async currentProfile(){ return { id:'p1', name:'Dotrino', pubkey: PUB } },
      async listProfiles(){ return [
        { id:'p1', name:'Dotrino', pubkey: PUB, avatar: ${JSON.stringify(FOTO)}, current:true },
        { id:'p2', name:'Trabajo', pubkey: PUB2, current:false }
      ] },
      // En sessionStorage porque cambiar de perfil RECARGA la página (no es reactivo,
      // por diseño) y una variable suelta no sobreviviría a la recarga.
      async switchProfile(id){ sessionStorage.setItem('cambiado', id) }
    }
    tb.reputation = {}
    document.body.appendChild(tb)
  `)

  // El menú nace oculto: solo aparece al acercarse.
  const antes = await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.prof-menu').hidden)
  assert.equal(antes, true, 'no estorba hasta que lo pides')

  await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.profile').click())
  await page.waitForTimeout(500)

  const menu = await page.evaluate(() => {
    const m = document.querySelector('dotrino-topbar').shadowRoot.querySelector('.prof-menu')
    return { oculto: m.hidden, texto: (m.innerText || m.textContent).replace(/\s+/g, ' ').trim() }
  })
  assert.equal(menu.oculto, false, 'se abre al pulsar')
  assert.match(menu.texto, /Dotrino/)
  assert.match(menu.texto, /Trabajo/, 'lista los otros perfiles para cambiar de un clic')
  assert.match(menu.texto, /Abrir mi perfil/, 'y ofrece abrir tu perfil (en móvil es la única vía)')
  assert.match(menu.texto, /Crear perfil/, 'y crear uno nuevo')

  // Cambiar de perfil avisa al vault y RECARGA la app (así todo arranca con el nuevo).
  await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot
    .querySelector('[data-switch="p2"]').click())
  await page.waitForTimeout(800)
  assert.equal(await page.evaluate(() => sessionStorage.getItem('cambiado')), 'p2', 'cambia al perfil elegido')
  await page.close()
})

escenario('pulsar el avatar NO abre ningún modal ni navega: abre el menú', async () => {
  const page = await abrir('', `
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

  const antesUrl = page.url()
  await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.profile').click())
  await page.waitForTimeout(600)

  assert.equal(page.url(), antesUrl, 'pulsar no te saca de la página: abre el menú')
  const modales = await page.evaluate(() => document.querySelectorAll('dotrino-profile[modal]').length)
  assert.equal(modales, 0, 'y no aparece ningún modal de tu perfil')
  const abierto = await page.evaluate(() => !document.querySelector('dotrino-topbar').shadowRoot.querySelector('.prof-menu').hidden)
  assert.equal(abierto, true, 'el menú queda abierto')

  // Y desde ahí se llega a tu perfil, que es un enlace normal.
  const href = await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot
    .querySelector('.prof-menu a')?.getAttribute('href'))
  assert.match(href || '', /profile\.dotrino\.com/, '«Abrir mi perfil» lleva a tu página')

  // Un segundo clic lo cierra.
  await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.profile').click())
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => document.querySelector('dotrino-topbar').shadowRoot.querySelector('.prof-menu').hidden), true, 'y otro clic lo cierra')
  await page.close()
})

escenario('el MODAL de otra persona no se desborda en una pantalla estrecha', async () => {
  const page = await abrir('<div id="host"></div>', `
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
  const fuera = await page.evaluate(() => {
    const sr = document.querySelector('dotrino-profile').shadowRoot
    const ancho = document.documentElement.clientWidth
    return [...sr.querySelectorAll('*')]
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.right > ancho + 2)
      .map((x) => ({ clase: String(x.n.className || x.n.tagName), sobra: Math.round(x.r.right - ancho) }))
      .slice(0, 8)
  })
  assert.deepEqual(fuera, [], 'nada puede salirse de la pantalla: ' + JSON.stringify(fuera))
  await page.close()
})

escenario('tu propio perfil, con el editor y varios perfiles, tampoco se desborda', async () => {
  const page = await abrir('<div id="host" style="width:360px"></div>', `
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

  const desbordes = await page.evaluate(() => medirDesborde())
  const anchos = await page.evaluate(() => {
    const host = document.getElementById('host'); const el = document.querySelector('dotrino-profile')
    const gordos = [...el.shadowRoot.querySelectorAll('*')]
      .map((n) => ({ c: String(n.className || n.tagName), w: Math.round(n.getBoundingClientRect().width) }))
      .filter((x) => x.w > host.getBoundingClientRect().width + 2).slice(0, 6)
    return { hueco: Math.round(host.getBoundingClientRect().width), tarjeta: Math.round(el.getBoundingClientRect().width), gordos }
  })
  log('anchos: ' + JSON.stringify(anchos))
  assert.ok(anchos.tarjeta <= anchos.hueco + 2,
    `la tarjeta (${anchos.tarjeta}px) no cabe en su hueco (${anchos.hueco}px): ` + JSON.stringify(anchos.gordos))
  assert.deepEqual(desbordes, [], 'nada debe salirse de su caja: ' + JSON.stringify(desbordes))
  await page.close()
})

// ---------- arranque ----------

console.log('\nSMOKE · la interfaz compartida (perfil y topbar) en un navegador\n')
try {
  const { chromium } = await import('playwright')
  await servir()
  navegador = await chromium.launch({ headless: !VERBOSE })
  // Pantalla estrecha a propósito: los desbordes se ven en el móvil, no en el escritorio.
  contexto = await navegador.newContext({ locale: 'es-ES', viewport: { width: 380, height: 820 } })
  const ok = await correr()
  await contexto?.close(); await navegador?.close(); servidor?.close()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('\nno se pudo montar el escenario:', e?.stack || e)
  try { await contexto?.close(); await navegador?.close(); servidor?.close() } catch (_) {}
  process.exit(1)
}
