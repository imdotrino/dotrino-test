import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { execSync } from 'node:child_process'

function commitMeta () {
  let hash = 'dev'
  try { hash = execSync('git rev-parse --short HEAD').toString().trim() } catch { /* sin git */ }
  return {
    name: 'commit-meta',
    transformIndexHtml: (html) => html.replace('</head>', `  <meta name="commit" content="${hash}" />\n  </head>`),
  }
}

// NO es PWA a propósito: sin VitePWA, sin manifest, sin service worker. La app
// es un sitio web normal (para probar el comportamiento de un "weblink"/acceso
// directo del navegador, no una app standalone instalable).
export default defineConfig({
  base: './',
  plugins: [
    basicSsl(),
    commitMeta(),
  ],
  server: { host: true, port: 3130, allowedHosts: ['.ts.net', '.local', 'localhost'] },
})
