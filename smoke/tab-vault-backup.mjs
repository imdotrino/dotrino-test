/**
 * EL RESPALDO DE LA BÓVEDA-PESTAÑA, en un Chrome de verdad (`dotrino-vault/docs/respaldo.md`).
 *
 * El iframe de identidad servido como en `id.dotrino.com`, embebido desde OTRO origen (el de
 * la consola), con su proxio. Por el mismo camino que usa la consola de `vault.dotrino.com`
 * (`selfVaultBackup*`), se mira que:
 *   · un respaldo hecho fuera (con la misma pieza que el binario) entra, cajón y perfil;
 *   · un choque sin decidir no escribe nada, y «reemplazar» lo pisa;
 *   · lo exportado sale cifrado y trae los valores de ahora;
 *   · y sobrevive a recargar la página (IndexedDB).
 *
 *   npm run smoke:respaldo-pestana
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scenario, runScenarios, startProxy, teardown, serveStatic, ROOT } from './lib/harness.js'

const { chromium } = await import('playwright')
const { sealBackup, openBackup } = await import(path.join(ROOT, 'dotrino-vault', 'lib', 'src', 'core', 'backup.js'))
const PWD = 'contraseña del respaldo de prueba'

scenario('la bóveda-pestaña exporta e importa su respaldo, con choques', async () => {
  const proxy = await startProxy()
  const iframe = await serveStatic(path.join(ROOT, 'dotrino-identity', 'vault'))
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'respaldo-pestana-'))
  fs.writeFileSync(path.join(raiz, 'index.html'), `<!doctype html><meta charset=utf-8><body>
<iframe id=f src="${iframe.url}/index.html?proxy=${proxy.url}"></iframe><script>
let n = 0; const pend = new Map()
addEventListener('message', (e) => { const m = e.data; if (m?._cci && m.type === 'response' && pend.has(m.id)) { const r = pend.get(m.id); pend.delete(m.id); m.error ? r.rej(Object.assign(new Error(typeof m.error === 'string' ? m.error : (m.error.message || JSON.stringify(m.error))), { code: m.error?.code || null })) : r.res(m.result) } })
window.rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++n; pend.set(id, { res, rej }); document.getElementById('f').contentWindow.postMessage({ _cci: true, type: 'request', id, method, params }, '*') })
</script>`)
  const pagina = await serveStatic(raiz)

  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'respaldo-pestana-chrome-'))
  const ctx = await chromium.launchPersistentContext(perfil, { headless: true })
  try {
    const page = await ctx.newPage()
    const rpc = (m, p) => page.evaluate(([m, p]) => window.rpc(m, p).then((r) => ({ r }), (e) => ({ e: e.message, code: e.code })), [m, p])
    const hasta = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await page.waitForTimeout(300) } return false }

    await page.goto(`${pagina.url}/index.html`)
    await page.waitForTimeout(2500)
    await rpc('setSelfVault', { enabled: true })
    assert.ok(await hasta(async () => (await rpc('selfVaultStatus')).r?.running), 'la bóveda de la pestaña no arrancó')

    const payload = (token) => ({
      v: 1, createdAt: 1, drawers: [
        { owner: 'ns:proxy', vars: { TOKEN: { value: token, public: false }, URL: { value: 'https://x', public: true } } },
        { owner: 'ns:@me', vars: { nickname: { value: 'santi', public: true } } }
      ]
    })
    const uno = await sealBackup(payload('uno'), PWD)
    const plan = await rpc('selfVaultBackupPlan', { file: uno, password: PWD })
    assert.equal(plan.r?.counts?.new, 3, 'el plan no ve los 3 nuevos: ' + (plan.e || JSON.stringify(plan.r)))
    const imp = await rpc('selfVaultBackupImport', { file: uno, password: PWD })
    assert.equal(imp.r?.written, 3, 'no importó: ' + (imp.e || JSON.stringify(imp.r)))

    const mala = await rpc('selfVaultBackupPlan', { file: uno, password: 'otra contraseña larga' })
    assert.match(String(mala.e), /does not open/, 'abrió con otra contraseña')

    const dos = await sealBackup(payload('dos'), PWD)
    const sin = await rpc('selfVaultBackupImport', { file: dos, password: PWD })
    assert.match(String(sin.e), /conflict/, 'importó con un choque sin decidir: ' + JSON.stringify(sin))
    const con = await rpc('selfVaultBackupImport', { file: dos, password: PWD, decisions: { 'ns:proxy TOKEN': 'replace' } })
    assert.equal(con.r?.written, 1, 'reemplazar no pisó: ' + (con.e || JSON.stringify(con.r)))

    const cajones = await rpc('selfVaultBackupDrawers')
    assert.ok(cajones.r?.some((d) => d.owner === 'ns:proxy' && d.count === 2), 'los cajones no salen: ' + (cajones.e || JSON.stringify(cajones.r)))

    // Tras recargar, lo importado sigue ahí: se exporta y se abre aquí fuera.
    await page.reload()
    await page.waitForTimeout(2500)
    assert.ok(await hasta(async () => (await rpc('selfVaultStatus')).r?.running), 'tras recargar no vuelve a arrancar')
    const exp = await rpc('selfVaultBackupExport', { password: PWD })
    assert.ok(exp.r?.file, 'no exporta: ' + exp.e)
    assert.ok(!JSON.stringify(exp.r.file).includes('dos'), 'el archivo lleva un valor en claro')
    const abierto = await openBackup(exp.r.file, PWD)
    const proxyD = abierto.drawers.find((d) => d.owner === 'ns:proxy')
    assert.equal(proxyD?.vars.TOKEN.value, 'dos')
    assert.equal(abierto.drawers.find((d) => d.owner === 'ns:@me')?.vars.nickname.value, 'santi')
  } finally {
    await ctx.close()
    fs.rmSync(perfil, { recursive: true, force: true })
    fs.rmSync(raiz, { recursive: true, force: true })
  }
})

try { await runScenarios() } finally { await teardown() }
