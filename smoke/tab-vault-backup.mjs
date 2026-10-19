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
 *   npm run smoke:tab-vault-backup
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scenario, runScenarios, startProxy, teardown, serveStatic, ROOT } from './lib/harness.js'

const { chromium } = await import('playwright')
const { sealBackup, openBackup } = await import(path.join(ROOT, 'dotrino-vault', 'lib', 'src', 'core', 'backup.js'))
const PWD = 'test backup password'

scenario('the tab vault exports and imports its backup, with conflicts', async () => {
  const proxy = await startProxy()
  const iframe = await serveStatic(path.join(ROOT, 'dotrino-identity', 'vault'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-vault-backup-'))
  fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><meta charset=utf-8><body>
<iframe id=f src="${iframe.url}/index.html?proxy=${proxy.url}"></iframe><script>
let n = 0; const pend = new Map()
addEventListener('message', (e) => { const m = e.data; if (m?._cci && m.type === 'response' && pend.has(m.id)) { const r = pend.get(m.id); pend.delete(m.id); m.error ? r.rej(Object.assign(new Error(typeof m.error === 'string' ? m.error : (m.error.message || JSON.stringify(m.error))), { code: m.error?.code || null })) : r.res(m.result) } })
window.rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++n; pend.set(id, { res, rej }); document.getElementById('f').contentWindow.postMessage({ _cci: true, type: 'request', id, method, params }, '*') })
</script>`)
  const hostPage = await serveStatic(root)

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-vault-backup-chrome-'))
  const ctx = await chromium.launchPersistentContext(profileDir, { headless: true })
  try {
    const page = await ctx.newPage()
    const rpc = (m, p) => page.evaluate(([m, p]) => window.rpc(m, p).then((r) => ({ r }), (e) => ({ e: e.message, code: e.code })), [m, p])
    const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await page.waitForTimeout(300) } return false }

    await page.goto(`${hostPage.url}/index.html`)
    await page.waitForTimeout(2500)
    await rpc('setSelfVault', { enabled: true })
    assert.ok(await until(async () => (await rpc('selfVaultStatus')).r?.running), 'the tab vault did not start')

    const payload = (token) => ({
      v: 1, createdAt: 1, drawers: [
        { owner: 'ns:proxy', vars: { TOKEN: { value: token, public: false }, URL: { value: 'https://x', public: true } } },
        { owner: 'ns:@me', vars: { nickname: { value: 'santi', public: true } } }
      ]
    })
    const one = await sealBackup(payload('uno'), PWD)
    const plan = await rpc('selfVaultBackupPlan', { file: one, password: PWD })
    assert.equal(plan.r?.counts?.new, 3, 'the plan does not see the 3 new entries: ' + (plan.e || JSON.stringify(plan.r)))
    const imp = await rpc('selfVaultBackupImport', { file: one, password: PWD })
    assert.equal(imp.r?.written, 3, 'did not import: ' + (imp.e || JSON.stringify(imp.r)))

    const wrong = await rpc('selfVaultBackupPlan', { file: one, password: 'another long password' })
    assert.match(String(wrong.e), /does not open/, 'it opened with another password')

    const two = await sealBackup(payload('dos'), PWD)
    const undecided = await rpc('selfVaultBackupImport', { file: two, password: PWD })
    assert.match(String(undecided.e), /conflict/, 'it imported with an undecided conflict: ' + JSON.stringify(undecided))
    const decided = await rpc('selfVaultBackupImport', { file: two, password: PWD, decisions: { 'ns:proxy TOKEN': 'replace' } })
    assert.equal(decided.r?.written, 1, 'replace did not overwrite: ' + (decided.e || JSON.stringify(decided.r)))

    const drawers = await rpc('selfVaultBackupDrawers')
    assert.ok(drawers.r?.some((d) => d.owner === 'ns:proxy' && d.count === 2), 'the drawers are not listed: ' + (drawers.e || JSON.stringify(drawers.r)))

    // Tras recargar, lo importado sigue ahí: se exporta y se abre aquí fuera.
    await page.reload()
    await page.waitForTimeout(2500)
    assert.ok(await until(async () => (await rpc('selfVaultStatus')).r?.running), 'does not start again after reload')
    const exp = await rpc('selfVaultBackupExport', { password: PWD })
    assert.ok(exp.r?.file, 'does not export: ' + exp.e)
    assert.ok(!JSON.stringify(exp.r.file).includes('dos'), 'the file carries a value in the clear')
    const opened = await openBackup(exp.r.file, PWD)
    const proxyD = opened.drawers.find((d) => d.owner === 'ns:proxy')
    assert.equal(proxyD?.vars.TOKEN.value, 'dos')
    assert.equal(opened.drawers.find((d) => d.owner === 'ns:@me')?.vars.nickname.value, 'santi')
  } finally {
    await ctx.close()
    fs.rmSync(profileDir, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

try { await runScenarios() } finally { await teardown() }
