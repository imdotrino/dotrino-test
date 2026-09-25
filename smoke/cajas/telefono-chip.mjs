// EL TELÉFONO CON SU LLAVE EN EL CHIP, dentro de una caja (smoke:llave-del-chip).
//
// El núcleo de identidad es el del iframe (`vault/core.js`) y el almacén de llaves va
// envuelto con `withExternalKeys`, como en la app de Android. El «chip» es una llave de
// software detrás del mismo protocolo que habla la app (create/open/sign/deriveBits/save/
// remove): la privada nunca pasa al núcleo. Habla por stdout con líneas `ETIQUETA:json`.
import { createIdentityCore } from '/eco/dotrino-identity/vault/core.js'
import { withExternalKeys } from '/eco/dotrino-identity/vault/externalKeys.js'

if (!globalThis.localStorage) {
  const m = new Map()
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }
}
const say = (tag, v) => console.log(tag + ':' + JSON.stringify(v))
const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64')
const pubStr = ({ kty, crv, x, y }) => JSON.stringify({ kty, crv, x, y })

const llaves = new Map()
let guardada = null
const chip = {
  async call (method, p) {
    if (method === 'create') {
      const kid = 'chip-' + llaves.size
      const s = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      const e = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
      llaves.set(kid, { s, e, publickey: pubStr(await crypto.subtle.exportKey('jwk', s.publicKey)), encPub: pubStr(await crypto.subtle.exportKey('jwk', e.publicKey)) })
      return { kid, publickey: llaves.get(kid).publickey, encPub: llaves.get(kid).encPub }
    }
    const k = llaves.get(p.kid)
    if (!k) throw Object.assign(new Error('that key is not on this phone'), { code: 'native-key-gone' })
    if (method === 'open') return { kid: p.kid, publickey: k.publickey, encPub: k.encPub }
    if (method === 'sign') return { signature: b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.s.privateKey, Buffer.from(p.data, 'base64'))) }
    if (method === 'deriveBits') {
      const peer = await crypto.subtle.importKey('jwk', JSON.parse(p.peer), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      return { bits: b64(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, k.e.privateKey, 256)) }
    }
    if (method === 'save') { guardada = p; say('GUARDADA', { kid: p.kid, vault: !!p.vault, cert: !!p.cert, name: p.name }); return { deviceId: p.deviceId } }
    if (method === 'remove') { llaves.delete(p.kid); return { ok: true } }
    throw new Error('unknown ' + method)
  }
}

const mem = new Map(); const idb = new Map(); let peers = {}
const core = await createIdentityCore({
  kv: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
  keyStore: withExternalKeys({ get: async (n) => idb.get(n) || null, set: async (n, v) => { idb.set(n, v) }, remove: async (n) => { idb.delete(n) } }, chip),
  peers: { async initPeerStorage () {}, loadPeers: () => peers, savePeers: (m) => { peers = m }, setPeersDirect: (m) => { peers = m || {} }, upsertPeer: (pub, patch) => { peers[pub] = { ...(peers[pub] || {}), ...patch, publickey: pub }; return peers[pub] }, onDirty () {}, setProfile () {} },
  makeSync: null
})
core.onVaultEvent((e) => { if (e.phase === 'challenge') say('CODE', e.code); if (e.phase === 'native-account') say('NATIVA', e) })

const me0 = await core.handlers.getMe()
say('PUB', me0.publickey)
say('PRIVADAS_EN_IDB', [...idb.values()].filter((r) => r.privateKey).length)
const r = await core.handlers.vaultPair({ qr: JSON.parse(process.env.QR), label: 'telefono-chip', join: 'new' })
say('EMPAREJADO', { deviceId: r.deviceId, joined: r.join?.joined, pub: (await core.handlers.getMe()).publickey })

let me = null
for (let i = 0; i < 40; i++) {
  me = await core.handlers.getMe()
  if (me?.nickname && me?.avatar) break
  await new Promise((res) => setTimeout(res, 500))
}
say('ME', { nickname: me?.nickname, avatar: !!me?.avatar, email: me?.email ?? null })

// Aprobar con la MISMA llave: espera a que el dueño le dé +aprueba en la bóveda.
for (let i = 0; i < 120; i++) {
  const a = await core.handlers.vaultApprovals({ op: 'approvals' }).catch((e) => ({ error: e.message, code: e.code }))
  if (Array.isArray(a?.items)) { say('APRUEBA', { items: a.items.length }); break }
  if (i % 10 === 0) say('ESPERA', a)
  await new Promise((res) => setTimeout(res, 1000))
}
setTimeout(() => process.exit(0), 300)
