/**
 * End-to-end sealing for directed messages.
 *
 * The proxy routes by public key but does NOT encrypt the payload: `sendByPubkey`
 * serializes it and sends it as-is. Anything sensitive that travels this way is
 * readable by whoever runs the proxy — which is exactly what the ecosystem promises
 * does not happen.
 *
 * This is NOT new cryptography. It is `wrapForMember`/`openWrap` from
 * `@dotrino/identity/content`, the same primitives the vault uses for sealed secrets:
 * ephemeral ECDH P-256 against the recipient's encryption public key, plus AES-GCM.
 * Each message carries its own ephemeral key, so there is no shared state to keep.
 *
 * `@dotrino/identity` is a PEER dependency on purpose: bundling it here would ship a
 * second, older copy of a pillar inside every consumer.
 */

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const VERSION = 1

let primitives = null

async function crypto_ () {
  if (primitives) return primitives
  try {
    throw new Error('sin sellado en esta prueba')
  } catch (e) {
    throw new Error(
      'sealing requires @dotrino/identity (peer dependency) — install it, or pass ' +
      'your own primitives to setSealingPrimitives()')
  }
  return primitives
}

/** Inject the primitives instead of resolving `@dotrino/identity` (bundlers, tests). */
export function setSealingPrimitives (mod) {
  primitives = mod
}

/** A durable encryption keypair for this device. Its public half goes in the pairing code. */
export async function makeEncKeypair () {
  const pair = await globalThis.crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const pub = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    encPub: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }),
  }
}

export async function importEncPrivate (jwk) {
  return globalThis.crypto.subtle.importKey('jwk', jwk, ECDH, true, ['deriveBits'])
}

export async function exportEncPrivate (privateKey) {
  return globalThis.crypto.subtle.exportKey('jwk', privateKey)
}

/** Seal a message towards a peer's encryption public key. */
export async function seal (message, peerEncPub) {
  if (!peerEncPub) throw new Error('seal: missing peer encryption key')
  const { wrapForMember } = await crypto_()
  const sealed = await wrapForMember({ cek: JSON.stringify(message), memberEncPub: peerEncPub })
  return { v: VERSION, sealed }
}

/** Open a message sealed to me. Throws if it is not mine or was tampered with. */
export async function open (envelope, myEncPrivateKey) {
  if (!isSealed(envelope)) throw new Error('open: not a sealed envelope')
  if (!myEncPrivateKey) throw new Error('open: missing my encryption key')
  const { openWrap } = await crypto_()
  return JSON.parse(await openWrap({ wrap: envelope.sealed, myEncPrivateKey }))
}

export function isSealed (msg) {
  return !!msg && msg.v === VERSION && !!msg.sealed?.ct && !!msg.sealed?.epk
}
