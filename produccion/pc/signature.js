/**
 * ECDSA P-256 keypair management using SubtleCrypto.
 *
 * Persisted in localStorage as JWK where it exists. Where it does NOT — a service
 * worker, which is where a browser extension keeps its background logic — the pair
 * used to be regenerated on every call and never stored, so the identity changed
 * every time the worker went to sleep. Any peer that knows a device by its public
 * key would see a stranger each time. IndexedDB is the fallback there: it is
 * available in workers, and it can store the CryptoKey itself, so the private key
 * stays non-extractable instead of being written out as a JWK.
 *
 * Public key in JWK form is what the proxy expects in `channel.data.publickey`.
 */
import { canonicalStringify } from './canonical.js'

const STORAGE_KEY = 'dotrino.proxy-client.keypair'
const DB_NAME = 'dotrino.proxy-client'
const DB_STORE = 'keypair'

let cachedKeypair = null
let injectedStore = null
let injectedExtractable = false

/**
 * Override where the keypair is kept. Takes `{ get(), set(pair) }` handling
 * `{ privateKey, publicKey, publicJwk }`. Rarely needed: the defaults already cover
 * pages (localStorage) and workers (IndexedDB).
 *
 * `extractable` matters: a store that keeps CryptoKeys as-is (IndexedDB) does not
 * need it and is safer without, but a store that serializes to disk or to text has
 * to export the private key as a JWK, and that throws on a non-extractable key. Pass
 * `{ extractable: true }` for those.
 */
export function setKeypairStore (store, { extractable = false } = {}) {
  injectedStore = store
  injectedExtractable = !!extractable
  cachedKeypair = null
}

function idb () {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbRequest (db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode)
    const req = fn(tx.objectStore(DB_STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const indexedDbStore = {
  async get () {
    const db = await idb()
    try { return await idbRequest(db, 'readonly', s => s.get(STORAGE_KEY)) } finally { db.close() }
  },
  async set (pair) {
    const db = await idb()
    try { await idbRequest(db, 'readwrite', s => s.put(pair, STORAGE_KEY)) } finally { db.close() }
  },
}

/**
 * Is there a WORKING localStorage? Not "is it defined" — Node >= 22 exposes one that
 * throws unless started with `--localstorage-file`, so checking for existence alone
 * sends the keypair down a path that fails. Anything headless without a shim would
 * crash instead of quietly falling back.
 */
function localStorageWorks () {
  try {
    if (typeof localStorage === 'undefined') return false
    const probe = STORAGE_KEY + '.probe'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch (e) {
    return false
  }
}

function fallbackStore () {
  if (injectedStore) return injectedStore
  if (!localStorageWorks() && typeof indexedDB !== 'undefined') return indexedDbStore
  return null
}

async function loadOrCreate () {
  if (cachedKeypair) return cachedKeypair

  const store = fallbackStore()
  if (store) {
    try {
      const saved = await store.get()
      if (saved?.privateKey && saved?.publicKey) {
        cachedKeypair = {
          privateKey: saved.privateKey,
          publicKey: saved.publicKey,
          publicJwk: saved.publicJwk || await crypto.subtle.exportKey('jwk', saved.publicKey),
        }
        return cachedKeypair
      }
    } catch (e) {
      // unreadable entry, regenerate below
    }

    // Non-extractable by default: nothing here needs to export the private key, and
    // a CryptoKey survives structured clone, so with IndexedDB it never has to leave
    // as a JWK. A store that serializes has to opt in via `setKeypairStore`.
    const extractable = store === indexedDbStore ? false : injectedExtractable
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      extractable, ['sign', 'verify']
    )
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const entry = { privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk }
    try {
      await store.set(entry)
    } catch (e) {
      // Loud on purpose. If this fails the identity is regenerated on every start,
      // and every peer that knows this device by its public key stops recognising
      // it — the exact failure this whole path exists to prevent. A silent catch
      // here means finding out days later, from the other side.
      console.error('[proxy-client] could not persist the keypair: %s', e?.message || e)
      console.error('[proxy-client] identity will NOT survive a restart. If the store serializes, pass { extractable: true } to setKeypairStore.')
    }
    cachedKeypair = entry
    return cachedKeypair
  }

  if (localStorageWorks()) {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const { privateJwk, publicJwk } = JSON.parse(raw)
        const privateKey = await crypto.subtle.importKey(
          'jwk', privateJwk,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true, ['sign']
        )
        const publicKey = await crypto.subtle.importKey(
          'jwk', publicJwk,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true, ['verify']
        )
        cachedKeypair = { privateKey, publicKey, publicJwk }
        return cachedKeypair
      } catch (e) {
        // corrupt entry, regenerate
      }
    }
  }

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']
  )
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  if (localStorageWorks()) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ privateJwk, publicJwk }))
  }
  cachedKeypair = { privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk }
  return cachedKeypair
}

/**
 * Returns the public key as a JWK string (what the proxy stores in data.publickey).
 */
export async function getPublicKeyJwk () {
  const { publicJwk } = await loadOrCreate()
  return JSON.stringify(publicJwk)
}

/**
 * Sign the canonical JSON of `data` and return base64 signature.
 */
export async function signData (data) {
  const { privateKey } = await loadOrCreate()
  const encoder = new TextEncoder()
  const bytes = encoder.encode(canonicalStringify(data))
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    bytes
  )
  return bufferToBase64(new Uint8Array(signature))
}

function bufferToBase64 (bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Build the {data, signature} envelope for a channel name.
 */
export async function buildSignedChannel (channelName, extraData = {}) {
  const publickey = await getPublicKeyJwk()
  // `name` (clave del canal) y `publickey` son AUTORITATIVOS: van DESPUÉS del
  // spread para que extraData no pueda pisarlos. extraData es solo metadata
  // (p.ej. nickname, roomName, gameType); si trae `name` no debe cambiar el
  // canal bajo el que se publica/lista (era un bug que rompía el descubrimiento
  // del lobby, que publica con { name: <roomName> } como extra).
  const data = { ...extraData, name: channelName, publickey }
  const signature = await signData(data)
  return { data, signature }
}
