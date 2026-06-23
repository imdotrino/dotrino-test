import './style.css'
import '@dotrino/install' // Web Component <dotrino-install> (botón Instalar PWA, §3)
import { registerSW } from 'virtual:pwa-register'

registerSW({ immediate: true })

const TARGET = 'https://dotrino.com'

const logEl = document.getElementById('log')
function log (msg) {
  const ts = new Date().toLocaleTimeString()
  logEl.textContent = `[${ts}] ${msg}\n` + logEl.textContent
}

// ---- estado de display-mode (¿estamos dentro de la PWA?) ----
function displayMode () {
  const modes = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay']
  const active = modes.find((m) => matchMedia(`(display-mode: ${m})`).matches) || 'browser'
  const iosStandalone = window.navigator.standalone === true
  return { active, iosStandalone }
}
function refreshMode () {
  const { active, iosStandalone } = displayMode()
  const inPwa = active !== 'browser' || iosStandalone
  document.getElementById('mode').innerHTML =
    `<span class="dot ${inPwa ? 'on' : 'off'}"></span>display-mode: <b>${active}</b>${iosStandalone ? ' (iOS standalone)' : ''}`
  return inPwa
}

// ---- construcción del intent de Android ----
function intentUrl ({ pkg } = {}) {
  const u = new URL(TARGET)
  const host = u.host + u.pathname + u.search // sin el scheme
  const parts = [
    'scheme=' + u.protocol.replace(':', ''),
    'action=android.intent.action.VIEW',
    'category=android.intent.category.BROWSABLE',
  ]
  if (pkg) parts.push('package=' + pkg)
  parts.push('S.browser_fallback_url=' + encodeURIComponent(TARGET))
  return `intent://${host}#Intent;${parts.join(';')};end`
}

const methods = {
  'open-noopener' () {
    const w = window.open(TARGET, '_blank', 'noopener')
    log(`A: window.open(_blank, noopener) → devolvió ${w ? 'una ventana' : 'null'}`)
  },
  'open-blank' () {
    const w = window.open(TARGET, '_blank')
    log(`B: window.open(_blank) → devolvió ${w ? 'una ventana' : 'null'}`)
  },
  'anchor-click' () {
    const a = document.createElement('a')
    a.href = TARGET; a.target = '_blank'; a.rel = 'noopener noreferrer'
    document.body.appendChild(a); a.click(); a.remove()
    log('C: ancla target=_blank clickeada por JS')
  },
  'intent-default' () {
    const url = intentUrl()
    log('E: navegando a ' + url)
    window.location.href = url
  },
  'intent-chrome' () {
    const url = intentUrl({ pkg: 'com.android.chrome' })
    log('F: navegando a ' + url)
    window.location.href = url
  },
}

document.getElementById('methods').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-method]')
  if (!btn) return
  const fn = methods[btn.dataset.method]
  if (fn) { try { fn() } catch (err) { log('⚠ error: ' + err.message) } }
})

document.getElementById('real-link').addEventListener('click', () => log('D: ancla real (tap del usuario)'))
document.getElementById('clear').addEventListener('click', () => { logEl.textContent = '' })

document.getElementById('target').textContent = TARGET
const inPwa = refreshMode()
log(`Cargado. ${inPwa ? 'Estás dentro de la PWA ✓' : 'Estás en el navegador (instala y abre desde el icono para probar de verdad).'}`)
log('UA: ' + navigator.userAgent)
