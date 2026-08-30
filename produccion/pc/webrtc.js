/**
 * WebRTC layer for the Dotrino proxy client.
 *
 * - One RTCPeerConnection + RTCDataChannel per remote token (lazy).
 * - Signaling (offer / answer / ICE) goes through the proxy as regular
 *   `send()` payloads tagged with `_rtc`.
 * - Once the DataChannel is open, payloads from `client.send(token, ...)`
 *   travel P2P; before that (or on failure) they fall back to the proxy.
 * - STUN-only (no TURN). Symmetric NATs will simply stay on the proxy.
 *
 * Glare resolution: the peer with the lexicographically smaller token is
 * the "polite" one (rolls back on collision).
 */

export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
]

const RTC_TAG = '__cc_rtc__'

export class WebRTCManager {
  /**
   * @param {object} opts
   * @param {() => string|null} opts.getSelfToken
   * @param {(to: string, payload: any) => void} opts.signalSend  raw proxy send
   * @param {(from: string, parsed: any, meta: any) => void} opts.deliverMessage forwards
   *        an incoming P2P payload as if it had arrived via the proxy
   * @param {(event: string, ...args: any[]) => void} opts.emit
   * @param {{iceServers?: any[]}} [opts.config]
   */
  constructor (opts) {
    this.getSelfToken = opts.getSelfToken
    this.signalSend = opts.signalSend
    this.deliverMessage = opts.deliverMessage
    this.emit = opts.emit
    this.iceServers = (opts.config && opts.config.iceServers) || DEFAULT_ICE_SERVERS
    this.peers = new Map() // remoteToken -> PeerState
  }

  /**
   * True if this is a control envelope and was consumed.
   * Otherwise the caller should keep delivering it normally.
   */
  handleIncoming (from, parsed) {
    if (!parsed || typeof parsed !== 'object' || parsed.t !== RTC_TAG) return false
    const peer = this._ensurePeer(from)
    this._handleSignal(peer, parsed).catch((e) => {
      this.emit('error', { type: 'webrtc_signal', error: e, peer: from })
    })
    return true
  }

  /**
   * Try to send the given JSON payload over a DataChannel.
   * Returns true if it was sent P2P; false if the caller should fall back
   * to the proxy. Also opportunistically starts the connection negotiation.
   */
  trySend (to, payloadString) {
    const peer = this._ensurePeer(to)
    if (peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(payloadString)
        return true
      } catch (_) {
        return false
      }
    }
    if (!peer.negotiating && !peer.failed) this._startNegotiation(peer).catch(() => {})
    return false
  }

  /** Optional: explicitly preconnect to a peer. */
  connect (to) {
    const peer = this._ensurePeer(to)
    if (peer.dc && peer.dc.readyState === 'open') return Promise.resolve()
    if (!peer.negotiating) this._startNegotiation(peer).catch(() => {})
    return new Promise((resolve, reject) => {
      peer.openWaiters.push({ resolve, reject })
    })
  }

  closePeer (to) {
    const peer = this.peers.get(to)
    if (!peer) return
    try { if (peer.dc) peer.dc.close() } catch (_) {}
    try { if (peer.pc) peer.pc.close() } catch (_) {}
    this.peers.delete(to)
  }

  closeAll () {
    for (const t of Array.from(this.peers.keys())) this.closePeer(t)
  }

  /**
   * Reemplaza la lista de ICE servers para las PRÓXIMAS conexiones (los peers
   * ya negociados conservan la suya). Lo usa `client.enableTurn()` para
   * inyectar las credenciales TURN temporales del proxy.
   */
  setIceServers (list) {
    if (Array.isArray(list) && list.length) this.iceServers = list
  }

  isOpen (to) {
    const p = this.peers.get(to)
    return !!(p && p.dc && p.dc.readyState === 'open')
  }

  // ---------- internals ----------

  _ensurePeer (remoteToken) {
    let peer = this.peers.get(remoteToken)
    if (peer) return peer
    peer = {
      remote: remoteToken,
      pc: null,
      dc: null,
      makingOffer: false,
      ignoreOffer: false,
      negotiating: false,
      failed: false,
      polite: this._isPolite(remoteToken),
      pendingCandidates: [],
      openWaiters: []
    }
    this.peers.set(remoteToken, peer)
    return peer
  }

  _isPolite (remoteToken) {
    const self = this.getSelfToken()
    if (!self) return false
    return self < remoteToken
  }

  _createPC (peer) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    peer.pc = pc
    peer.polite = this._isPolite(peer.remote)

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this._signal(peer, { kind: 'ice', candidate: ev.candidate })
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._failPeer(peer)
      }
    }
    pc.ondatachannel = (ev) => this._attachDC(peer, ev.channel)
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true
        await pc.setLocalDescription()
        this._signal(peer, { kind: 'sdp', sdp: pc.localDescription })
      } catch (e) {
        this.emit('error', { type: 'webrtc_negotiate', error: e, peer: peer.remote })
      } finally {
        peer.makingOffer = false
      }
    }
    return pc
  }

  async _startNegotiation (peer) {
    if (peer.negotiating) return
    peer.negotiating = true
    try {
      if (!peer.pc) this._createPC(peer)
      // Caller side creates the data channel; the other end gets it via
      // `ondatachannel`. The token comparison decides who initiates.
      const self = this.getSelfToken()
      if (self && self > peer.remote && !peer.dc) {
        const dc = peer.pc.createDataChannel('cc', { ordered: true })
        this._attachDC(peer, dc)
      }
    } catch (e) {
      this.emit('error', { type: 'webrtc_start', error: e, peer: peer.remote })
      this._failPeer(peer)
    }
  }

  _attachDC (peer, dc) {
    peer.dc = dc
    dc.onopen = () => {
      this.emit('webrtc_open', peer.remote)
      const waiters = peer.openWaiters
      peer.openWaiters = []
      for (const w of waiters) w.resolve()
    }
    dc.onclose = () => {
      this.emit('webrtc_close', peer.remote)
    }
    dc.onerror = (err) => {
      this.emit('error', { type: 'webrtc_dc', error: err, peer: peer.remote })
    }
    dc.onmessage = (ev) => {
      let parsed = null
      const raw = ev.data
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw) } catch (_) { parsed = null }
      }
      this.deliverMessage(peer.remote, parsed ?? raw, { raw, timestamp: Date.now(), via: 'webrtc' })
    }
  }

  _failPeer (peer) {
    peer.failed = true
    peer.negotiating = false
    const waiters = peer.openWaiters
    peer.openWaiters = []
    const err = new Error('WebRTC failed')
    for (const w of waiters) w.reject(err)
  }

  _signal (peer, body) {
    this.signalSend(peer.remote, { t: RTC_TAG, ...body })
  }

  async _handleSignal (peer, msg) {
    if (!peer.pc) this._createPC(peer)
    const pc = peer.pc

    if (msg.kind === 'sdp' && msg.sdp) {
      const offerCollision = msg.sdp.type === 'offer' &&
        (peer.makingOffer || pc.signalingState !== 'stable')
      peer.ignoreOffer = !peer.polite && offerCollision
      if (peer.ignoreOffer) return
      await pc.setRemoteDescription(msg.sdp)
      // flush any queued candidates
      for (const c of peer.pendingCandidates) {
        try { await pc.addIceCandidate(c) } catch (_) {}
      }
      peer.pendingCandidates = []
      if (msg.sdp.type === 'offer') {
        await pc.setLocalDescription()
        this._signal(peer, { kind: 'sdp', sdp: pc.localDescription })
      }
    } else if (msg.kind === 'ice' && msg.candidate) {
      try {
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          peer.pendingCandidates.push(msg.candidate)
        } else {
          await pc.addIceCandidate(msg.candidate)
        }
      } catch (e) {
        if (!peer.ignoreOffer) throw e
      }
    }
  }
}

export { RTC_TAG }
