/**
 * LA BÓVEDA DE LA PESTAÑA, en un Chrome de verdad.
 *
 * Desde vaultd 0.156.0 / @dotrino/vault 0.86.0 / @dotrino/identity 0.116.0 la pestaña corre
 * el MISMO núcleo que el binario (`startBrowserVault`), con el disco en IndexedDB (regla de
 * las tres versiones, `dotrino-vault/docs/three-versions.md`). Las pruebas de identity lo
 * ejecutan en Node; esto lo ejecuta donde vive: el iframe de identidad servido como en
 * `id.dotrino.com`, embebido por otra página (otro origen), con su proxio.
 *
 * Lo que se mira, por el mismo camino que usa la consola de `vault.dotrino.com`:
 *   · «este dispositivo es bóveda» arranca el núcleo;
 *   · la consola la administra por el camino local (cajones, bloquear, lista de aparatos);
 *   · abre invitaciones;
 *   · lo escrito sobrevive a recargar la página (IndexedDB).
 *
 *   npm run smoke:tab-vault
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scenario, runScenarios, startProxy, teardown, serveStatic, ROOT } from './lib/harness.js'

const { chromium } = await import('playwright')

scenario('the tab runs the binary\'s vault and the console manages it', async () => {
  const proxy = await startProxy()
  const iframe = await serveStatic(path.join(ROOT, 'dotrino-identity', 'vault'))
  // La página que embebe, en OTRO origen: es lo que hace vault.dotrino.com con id.dotrino.com.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-vault-'))
  fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><meta charset=utf-8><body>
<iframe id=f src="${iframe.url}/index.html?proxy=${proxy.url}"></iframe><script>
let n = 0; const pend = new Map()
addEventListener('message', (e) => { const m = e.data; if (m?._cci && m.type === 'response' && pend.has(m.id)) { const r = pend.get(m.id); pend.delete(m.id); m.error ? r.rej(new Error(typeof m.error === 'string' ? m.error : (m.error.message || JSON.stringify(m.error)))) : r.res(m.result) } })
window.rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++n; pend.set(id, { res, rej }); document.getElementById('f').contentWindow.postMessage({ _cci: true, type: 'request', id, method, params }, '*') })
</script>`)
  const hostPage = await serveStatic(root)

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-vault-chrome-'))
  const ctx = await chromium.launchPersistentContext(profileDir, { headless: true })
  try {
    const page = await ctx.newPage()
    const rpc = (m, p) => page.evaluate(([m, p]) => window.rpc(m, p).then((r) => ({ r }), (e) => ({ e: e.message })), [m, p])
    const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await page.waitForTimeout(300) } return false }

    await page.goto(`${hostPage.url}/index.html`)
    await page.waitForTimeout(2500)
    assert.ok((await rpc('publicMe')).r?.publickey, 'the iframe has no identity')

    await rpc('setSelfVault', { enabled: true })
    assert.ok(await until(async () => (await rpc('selfVaultStatus')).r?.running), 'the tab vault did not start')
    assert.ok(await until(async () => (await rpc('canAdminVault')).r === true), 'the tab console cannot manage it')

    const drawers = await rpc('vaultAdmin', { op: 'vars' })
    assert.ok(drawers.r?.enc, 'the drawers do not arrive over the local path: ' + drawers.e)
    const fake = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' })
    const b = await rpc('vaultAdmin', { op: 'block', sub: fake })
    assert.ok(!b.e, 'could not block: ' + b.e)
    const list = await rpc('listVaultDevices')
    assert.ok(Array.isArray(list.r?.devices), 'the device list does not come from the vault: ' + list.e)
    const inv = await rpc('selfVaultPairing', { label: 'smoke' })
    assert.ok(inv.r?.qr, 'does not open invitations: ' + inv.e)

    // LO ESCRITO SE QUEDA: recargar y seguir viéndolo (IndexedDB, uno por perfil).
    await page.reload()
    await page.waitForTimeout(2500)
    assert.ok(await until(async () => (await rpc('selfVaultStatus')).r?.running), 'does not start again after reload')
    assert.ok(await until(async () => (await rpc('canAdminVault')).r === true), 'cannot be managed after reload')
    const b2 = await rpc('vaultAdmin', { op: 'blocked' })
    assert.equal(b2.r?.items?.length, 1, 'the block did not survive the reload: ' + (b2.e || JSON.stringify(b2.r)))
  } finally {
    await ctx.close()
    fs.rmSync(profileDir, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

try { await runScenarios() } finally { await teardown() }
