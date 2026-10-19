/**
 * Esperas del smoke: UNA sola forma de «espera a que esto pase o ríndete con un error
 * legible». Antes cada smoke traía su copia (`esperar`), con el mismo cuerpo y otro plazo.
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Llama a `fn` hasta que devuelva algo verdadero y lo devuelve. Si se acaba el plazo, lanza
 * `timed out waiting for <what>`.
 *
 * @param {() => any} fn
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  plazo total
 * @param {number} [opts.every]      pausa entre intentos
 * @param {string | (() => string)} [opts.what]  qué se espera (función: se evalúa al rendirse)
 * @param {boolean} [opts.retryErrors]  un intento que lanza cuenta como «todavía no», y el
 *   último error se añade al mensaje final
 */
export async function waitFor (fn, { timeoutMs = 30000, every = 200, what = 'the condition', retryErrors = false } = {}) {
  const until = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < until) {
    if (retryErrors) {
      try { const v = await fn(); if (v) return v } catch (e) { lastError = e }
    } else {
      const v = await fn()
      if (v) return v
    }
    await sleep(every)
  }
  const label = typeof what === 'function' ? what() : what
  throw new Error('timed out waiting for ' + label + (lastError ? ' · last error: ' + lastError.message : ''))
}
