import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
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

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [
    basicSsl(),
    commitMeta(),
    VitePWA({
      selfDestroying: command === 'serve',
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Test · Dotrino',
        short_name: 'Test',
        description: 'App sandbox de pruebas del ecosistema Dotrino.',
        lang: 'es',
        theme_color: '#0e1116',
        background_color: '#0e1116',
        display: 'standalone',
        start_url: './',
        scope: './',
        launch_handler: { client_mode: 'focus-existing' },
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallback: null,
      },
    }),
  ],
  server: { host: true, port: 3130, allowedHosts: ['.ts.net', '.local', 'localhost'] },
}))
