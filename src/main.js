import './style.css'

// NO es PWA a propósito: sin service worker ni botón de instalar (ver index.html
// y vite.config.js). Es un sitio normal para probar el comportamiento de un
// weblink/acceso directo del navegador.

const TARGET = 'https://dotrino.com'

// ---------- i18n (es/en, tuteo neutro, sin voseo) ----------
const messages = {
  es: {
    tagline: '· sandbox Dotrino',
    h1: 'Abrir un enlace desde un weblink',
    intro: `Esta página <b>no es PWA</b> (sin manifest ni service worker). Añádela a la pantalla de inicio como <b>acceso directo</b> (weblink) y ábrela desde ahí, o pruébala en el navegador. Objetivo: ver cómo abre <code id="target">${TARGET}</code> cada método.`,
    mA_h: 'A · window.open(_blank, noopener)', mA_p: `El que pediste. <code>window.open(url, '_blank', 'noopener')</code>`, mA_b: 'Probar A',
    mB_h: 'B · window.open(_blank) sin noopener', mB_p: `<code>window.open(url, '_blank')</code>`, mB_b: 'Probar B',
    mC_h: 'C · &lt;a target="_blank"&gt; por click programático', mC_p: 'Crea un ancla y la "clickea" desde JS (gesto de usuario).', mC_b: 'Probar C',
    mD_h: 'D · &lt;a target="_blank"&gt; real (tócalo tú)', mD_p: 'Un enlace de verdad, sin JS. A veces se comporta distinto.', mD_b: 'Abrir D',
    mE_h: 'E · Intent de Android (navegador por defecto) ★', mE_p: 'La técnica clave en Android. <code>intent://…#Intent;scheme=https;action=VIEW;category=BROWSABLE;end</code>', mE_b: 'Probar E',
    mF_h: 'F · Intent forzando Chrome ★', mF_p: 'Intent con <code>package=com.android.chrome</code>. Abre Chrome sí o sí (si está instalado).', mF_b: 'Probar F',
    logHead: 'Registro', clear: 'Limpiar',
    inPwa: 'Modo standalone (no debería pasar: esto ya no es PWA).',
    inBrowser: 'Cargado como sitio/weblink en el navegador.',
    loaded: 'Cargado.', win: 'devolvió una ventana', null: 'devolvió null',
    logA: 'A: window.open(_blank, noopener) → ', logB: 'B: window.open(_blank) → ',
    logC: 'C: ancla target=_blank clickeada por JS', logD: 'D: ancla real (tap del usuario)',
    navTo: 'navegando a ', err: '⚠ error: ',
  },
  en: {
    tagline: '· Dotrino sandbox',
    h1: 'Open a link from a weblink',
    intro: `This page is <b>not a PWA</b> (no manifest, no service worker). Add it to your home screen as a <b>shortcut</b> (weblink) and open it from there, or just use the browser. Goal: see how each method opens <code id="target">${TARGET}</code>.`,
    mA_h: 'A · window.open(_blank, noopener)', mA_p: `The one you asked for. <code>window.open(url, '_blank', 'noopener')</code>`, mA_b: 'Try A',
    mB_h: 'B · window.open(_blank) without noopener', mB_p: `<code>window.open(url, '_blank')</code>`, mB_b: 'Try B',
    mC_h: 'C · &lt;a target="_blank"&gt; via programmatic click', mC_p: 'Creates an anchor and "clicks" it from JS (user gesture).', mC_b: 'Try C',
    mD_h: 'D · real &lt;a target="_blank"&gt; (tap it yourself)', mD_p: 'A real link, no JS. Sometimes behaves differently.', mD_b: 'Open D',
    mE_h: 'E · Android intent (default browser) ★', mE_p: 'The key trick on Android. <code>intent://…#Intent;scheme=https;action=VIEW;category=BROWSABLE;end</code>', mE_b: 'Try E',
    mF_h: 'F · Android intent forcing Chrome ★', mF_p: 'Intent with <code>package=com.android.chrome</code>. Opens Chrome no matter what (if installed).', mF_b: 'Try F',
    logHead: 'Log', clear: 'Clear',
    inPwa: 'Standalone mode (unexpected: this is no longer a PWA).',
    inBrowser: 'Loaded as a site/weblink in the browser.',
    loaded: 'Loaded.', win: 'returned a window', null: 'returned null',
    logA: 'A: window.open(_blank, noopener) → ', logB: 'B: window.open(_blank) → ',
    logC: 'C: anchor target=_blank clicked via JS', logD: 'D: real anchor (user tap)',
    navTo: 'navigating to ', err: '⚠ error: ',
  },
}

let lang = (() => {
  const saved = localStorage.getItem('test.lang')
  if (saved === 'es' || saved === 'en') return saved
  return (navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es'
})()
const t = (k) => (messages[lang] || messages.es)[k] ?? k

function applyI18n () {
  document.documentElement.lang = lang
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.dataset.i18n) })
  document.querySelectorAll('dotrino-support').forEach((el) => el.setAttribute('lang', lang))
  document.querySelectorAll('.lang-selector button').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang))
  refreshMode()
}
function setLang (l) { lang = l; localStorage.setItem('test.lang', l); applyI18n() }

// ---------- estado de display-mode ----------
function refreshMode () {
  const modes = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay']
  const active = modes.find((m) => matchMedia(`(display-mode: ${m})`).matches) || 'browser'
  const iosStandalone = window.navigator.standalone === true
  const inPwa = active !== 'browser' || iosStandalone
  document.getElementById('mode').innerHTML =
    `<span class="dot ${inPwa ? 'on' : 'off'}"></span>display-mode: <b>${active}</b>${iosStandalone ? ' (iOS standalone)' : ''}`
  return inPwa
}

// ---------- intent de Android ----------
function intentUrl ({ pkg } = {}) {
  const u = new URL(TARGET)
  const host = u.host + u.pathname + u.search
  const parts = ['scheme=' + u.protocol.replace(':', ''), 'action=android.intent.action.VIEW', 'category=android.intent.category.BROWSABLE']
  if (pkg) parts.push('package=' + pkg)
  parts.push('S.browser_fallback_url=' + encodeURIComponent(TARGET))
  return `intent://${host}#Intent;${parts.join(';')};end`
}

const logEl = document.getElementById('log')
function log (msg) { logEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + logEl.textContent }

const methods = {
  'open-noopener' () { const w = window.open(TARGET, '_blank', 'noopener'); log(t('logA') + (w ? t('win') : t('null'))) },
  'open-blank' () { const w = window.open(TARGET, '_blank'); log(t('logB') + (w ? t('win') : t('null'))) },
  'anchor-click' () {
    const a = document.createElement('a')
    a.href = TARGET; a.target = '_blank'; a.rel = 'noopener noreferrer'
    document.body.appendChild(a); a.click(); a.remove()
    log(t('logC'))
  },
  'intent-default' () { const url = intentUrl(); log(t('navTo') + url); window.location.href = url },
  'intent-chrome' () { const url = intentUrl({ pkg: 'com.android.chrome' }); log(t('navTo') + url); window.location.href = url },
}

document.getElementById('methods').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-method]')
  if (!btn) return
  const fn = methods[btn.dataset.method]
  if (fn) { try { fn() } catch (err) { log(t('err') + err.message) } }
})
document.getElementById('real-link').addEventListener('click', () => log(t('logD')))
document.getElementById('clear').addEventListener('click', () => { logEl.textContent = '' })
document.querySelector('.lang-selector').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]'); if (b) setLang(b.dataset.lang)
})

applyI18n()
const inPwa = refreshMode()
log(`${t('loaded')} ${inPwa ? t('inPwa') : t('inBrowser')}`)
log('UA: ' + navigator.userAgent)
