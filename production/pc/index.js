export { WebSocketProxyClient } from './client.js'
export { canonicalStringify } from './canonical.js'
export { getPublicKeyJwk, signData, buildSignedChannel, setKeypairStore } from './signature.js'
export {
  seal, open, isSealed, makeEncKeypair, importEncPrivate, exportEncPrivate,
  setSealingPrimitives,
} from './sealing.js'

import { WebSocketProxyClient } from './client.js'

let _singleton = null
/**
 * Singleton helper. Returns the same instance across calls.
 * Useful in apps that want a single global client.
 */
export function getWebSocketProxyClient (options) {
  if (!_singleton) _singleton = new WebSocketProxyClient(options)
  else if (options) _singleton.updateConfig(options)
  return _singleton
}
