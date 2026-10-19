/**
 * ENTRAR CON USUARIO Y CONTRASEÑA desde un navegador del smoke, como hace
 * `profile.dotrino.com/login`: `Identity.connect()` y `loginWithPassword`. No se usa la página
 * de profile-app porque apunta a `id.dotrino.com` sin forma de cambiarlo; lo que se prueba es
 * el pilar, que es el mismo en las dos.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, tmpDir, serveStatic } from './harness.js'

/** Sirve la página de entrar. Devuelve `{ url }`. */
export async function serveLoginPage () {
  const identity = path.join(ROOT, 'dotrino-identity')
  const dir = tmpDir('sign-in')
  // El cliente importa `../vault/…`: se sirve el paquete tal cual, con enlaces, no una copia.
  fs.symlinkSync(path.join(identity, 'src'), path.join(dir, 'src'))
  fs.symlinkSync(path.join(identity, 'vault'), path.join(dir, 'vault'))
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
<script type="module">
  import { Identity } from './src/index.js'
  const q = new URLSearchParams(location.search)
  window.signIn = async (address, password) => {
    const id = await Identity.connect({ vaultUrl: q.get('vault'), promptUnlock: false })
    try {
      await id.loginWithPassword({ address, password, remember: true, label: 'smoke', proxyUrl: q.get('proxy') })
      return { ok: true }
    } catch (e) { return { ok: false, code: e?.code || null, message: String(e?.message || e) } }
  }
  window.ready = true
</script>`)
  return serveStatic(dir)
}

/** Entra en un contexto de navegador. Devuelve `{ ok }` o `{ ok:false, code, message }`. */
export async function signIn (context, { pageUrl, iframeUrl, proxyUrl, address, password }) {
  const p = await context.newPage()
  try {
    await p.goto(`${pageUrl}/?vault=${encodeURIComponent(iframeUrl)}&proxy=${encodeURIComponent(proxyUrl)}`)
    await p.waitForFunction(() => window.ready)
    return await p.evaluate(([a, c]) => window.signIn(a, c), [address, password])
  } finally { await p.close() }
}
