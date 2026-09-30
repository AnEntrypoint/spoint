import { pack, unpack, ensurePacked } from '/src/protocol/msgpack.js'
import { MSG } from '/src/protocol/MessageTypes.js'
import { BaseClient } from '/src/client/BaseClient.js'
import { TransformRingReader } from '/src/transport/TransformRing.js'

const _COALESCE_SENTINEL = 0xff
const _PEER_SIM_FRAME = /^ww(rollback|lockstep):/
function _isBareSnapshotFrame(mt, bytes) {
  if (mt !== MSG.SNAPSHOT) return false
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return u8.length === 0 || u8[0] !== _COALESCE_SENTINEL
}

const _base = import.meta.url
const _root = _base.endsWith('/client/BrowserServer.js') ? new URL('../', _base).href : new URL('./', _base).href

let _lastTodSync = null
const _deliveredWorldFingerprints = new Set()
const _MAX_WORLD_FINGERPRINTS = 8

function _canonicalKey(v) {
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? 'f' : JSON.stringify(v) ?? 'n'
  if (Array.isArray(v)) return '[' + v.map(_canonicalKey).join(',') + ']'
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + _canonicalKey(v[k])).join(',') + '}'
}

export class BrowserServer extends BaseClient {
  constructor(config = {}) {
    super(config)
    this._worker = null
    this._peerChannels = new Map()
    this._transformRingReader = null
    this._onVisibilityChange = () => {
      if (typeof document === 'undefined' || !document.hidden || !this._worker) return
      this._worker.postMessage({ type: 'SAVE_NOW' })
    }
  }

  readTransformRing() {
    return this._transformRingReader ? this._transformRingReader.readAll() : null
  }

  _colliderRequest(message, timeoutMs) {
    if (!this._worker) return Promise.resolve({ hit: false, error: 'no worker' })
    this._colliderReqSeq = (this._colliderReqSeq || 0) + 1
    const reqId = this._colliderReqSeq
    this._colliderPending = this._colliderPending || new Map()
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._colliderPending.delete(reqId); resolve({ hit: false, error: 'timeout' }) }, timeoutMs)
      this._colliderPending.set(reqId, (r) => { clearTimeout(t); resolve(r) })
      this._worker.postMessage({ ...message, reqId })
    })
  }

  queryColliderHeight(x, z, timeoutMs = 5000) {
    return this._colliderRequest({ type: 'DEBUG_COLLIDER_QUERY', x, z }, timeoutMs)
  }

  queryColliderRays(rays, { includeRockBodies = false, probePoints, timeoutMs = 10000 } = {}) {
    return this._colliderRequest({ type: 'DEBUG_COLLIDER_RAYS', rays, includeRockBodies, probePoints }, timeoutMs)
  }

  _hmrRequest(message, timeoutMs = 15000) {
    if (!this._worker) return Promise.resolve(false)
    this._hmrSeq = (this._hmrSeq || 0) + 1
    const reqId = this._hmrSeq
    this._hmrPending = this._hmrPending || new Map()
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._hmrPending.delete(reqId); resolve(false) }, timeoutMs)
      this._hmrPending.set(reqId, (ok) => { clearTimeout(t); resolve(ok) })
      this._worker.postMessage({ ...message, reqId })
    })
  }

  async hotReloadApp(name) {
    const indexUrl = new URL(`apps/${name}/index.js`, _root)
    const r = await fetch(indexUrl, { cache: 'no-cache', signal: AbortSignal.timeout(10000) }).catch(() => null)
    if (!r?.ok) return false
    const source = await r.text()
    const deps = await Promise.race([_resolveRelativeDeps(source, indexUrl), new Promise(resolve => setTimeout(() => resolve(null), 10000))])
    if (!deps) return false
    return this._hmrRequest({ type: 'HMR_APP', name, source, deps })
  }

  hotReloadTickHandler(v) {
    return this._hmrRequest({ type: 'HMR_TICK_HANDLER', v })
  }

  async _importModule(path) {
    const r = await fetch(new URL(path, _root))
    if (!r.ok) throw new Error(`${r.status} ${path}`)
    const src = await r.text()
    const blob = new Blob([src], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try { return await import(url) } finally { URL.revokeObjectURL(url) }
  }

  async connect() {
    await ensurePacked
    const workerUrl = new URL('src/sdk/WorkerEntry.js', _root)
    this._worker = new Worker(workerUrl, { type: 'module' })
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibilityChange)
    if (this.config.peerSession) this._relayPeerFrames(this.config.peerSession)

    const _sourcesReady = (async () => {
      const _manifestPromise = fetch(new URL('apps-manifest.json', _root)).then(r => r.ok ? r.json() : null).catch(() => null)
      const worldDef = this.config.worldDef
      if (!worldDef) throw new Error('[BrowserServer] no worldDef supplied -- the world module failed to load, so there is no world to run')
      const appNames = [...new Set([
        ...((worldDef.entities || []).map(e => e.app).filter(Boolean)),
        ...((worldDef.placeableApps || [])),
        ...((worldDef.trustedApps || []))
      ])]
      const manifest = await _manifestPromise
      const byName = new Map((manifest && Array.isArray(manifest.apps) ? manifest.apps : []).filter(a => a && a.name && typeof a.source === 'string').map(a => [a.name, a]))
      const seen = new Map()
      const apps = (await Promise.all(appNames.map(async name => {
        const fromManifest = byName.get(name)
        if (fromManifest) return { name, source: fromManifest.source, deps: fromManifest.deps || {} }
        const indexUrl = new URL(`apps/${name}/index.js`, _root)
        const r = await fetch(indexUrl).catch(() => null)
        if (!r?.ok) return null
        const source = await r.text()
        const deps = await _resolveRelativeDeps(source, indexUrl, seen)
        return { name, source, deps }
      }))).filter(Boolean)
      return { worldDef, apps }
    })()

    return new Promise((resolve, reject) => {
      let _workerReady = false
      const _tryInit = () => {
        if (!_workerReady) return
        const ps = this.config.peerSession
        _sourcesReady.then(({ worldDef, apps }) => this._worker.postMessage({ type: 'INIT', worldDef, worldName: this.config.worldName || null, apps, migrationSnapshot: this.config.migrationSnapshot || null, localPubkey: this.config.localPubkey || null, timeOfDaySeed: _lastTodSync, peerSession: ps ? { roster: [...ps.roster], localPubkey: ps.localPubkey } : null })).catch(reject)
      }
      this._worker.onerror = reject
      this._worker.onmessage = ({ data }) => {
        if (data.type === 'WORKER_READY') { _workerReady = true; _tryInit(); return }
        if (data.type === 'INIT_ERROR') { reject(new Error(data.error + '\n' + data.stack)); return }
        if (data.type === 'TRANSFORM_RING') {
          try { this._transformRingReader = new TransformRingReader(data.sab, data.capacity) } catch (_) { this._transformRingReader = null }
          return
        }
        if (data.type === 'HMR_RESULT') {
          const done = this._hmrPending && this._hmrPending.get(data.reqId)
          if (done) { this._hmrPending.delete(data.reqId); done(!!data.ok) }
          return
        }
        if (data.type === 'DEBUG_COLLIDER_RESULT') {
          const resolve = this._colliderPending && this._colliderPending.get(data.reqId)
          if (resolve) { this._colliderPending.delete(data.reqId); resolve(data) }
          return
        }
        if (data.type === 'BRIDGE_BROADCAST') { this.config.peerSession?.bridge.data.broadcast(data.data); return }
        if (data.type === 'BRIDGE_SEND') { this.config.peerSession?.bridge.data.send(data.to, data.data); return }
        if (data.type === 'PEER_STATS') { this.peerStats = data.stats; return }
        if (data.type === 'PEER_SEND') {
          const ch = this._peerChannels.get(data.peerId)
          if (ch?.readyState === 'open') ch.send(data.data)
          if (this.onPeerSnapshot && _isBareSnapshotFrame(data.mt, data.data)) this.onPeerSnapshot(data.peerId, data.data)
          return
        }
        if (data.type !== 'SEND_CLIENT') return
        if (data.mt === MSG.TIME_OF_DAY_SYNC) {
          try { const m = unpack(data.data); if (m && m.payload && Number.isFinite(m.payload.t)) _lastTodSync = { t: m.payload.t, dayLengthSec: m.payload.dayLengthSec, atMs: Date.now() } } catch (_) {}
        } else if (data.mt === MSG.WORLD_DEF) {
          try {
            const m = unpack(data.data)
            const key = m && m.payload ? _canonicalKey({ ...m.payload, terrain: m.payload.terrain ? { ...m.payload.terrain, timeOfDay: m.payload.terrain.timeOfDay ? { ...m.payload.terrain.timeOfDay, seed: undefined } : m.payload.terrain.timeOfDay } : m.payload.terrain }) : ''
            if (key && _deliveredWorldFingerprints.has(key)) return
            if (key) {
              if (_deliveredWorldFingerprints.size >= _MAX_WORLD_FINGERPRINTS) _deliveredWorldFingerprints.delete(_deliveredWorldFingerprints.values().next().value)
              _deliveredWorldFingerprints.add(key)
            }
          } catch (_) {}
        }
        if (_isBareSnapshotFrame(data.mt, data.data) && this.connected) {
          this._pendingSnap = data.data
          if (!this._snapScheduled) {
            this._snapScheduled = true
            const flush = () => {
              this._snapScheduled = false
              const s = this._pendingSnap; this._pendingSnap = null
              if (s != null && this._worker) this.onMessage(s)
            }
            setTimeout(flush, 0)
          }
          return
        }
        this.onMessage(data.data)
        if (!this.connected && this._msgHandler.getPlayerId()) {
          this.connected = true
          this.callbacks.onConnect()
          resolve()
        }
      }
    })
  }

  _relayPeerFrames({ bridge, roster, delay = null }) {
    const members = new Set(roster)
    let orderedAt = 0
    const toWorker = msg => {
      if (!delay) { this._worker?.postMessage(msg); return }
      const at = Math.max(orderedAt, performance.now() + delay())
      orderedAt = at
      setTimeout(() => this._worker?.postMessage(msg), Math.max(0, at - performance.now()))
    }
    bridge.data.addEventListener('data', ({ detail }) => {
      const frame = detail?.data
      if (typeof frame !== 'string' || !members.has(detail.peerPubkey) || !_PEER_SIM_FRAME.test(frame)) return
      toWorker({ type: 'PEER_FRAME', from: detail.peerPubkey, data: frame })
    })
    const onClose = ({ detail }) => { if (members.has(detail?.peerPubkey)) toWorker({ type: 'PEER_LEFT', pubkey: detail.peerPubkey }) }
    bridge.data.addEventListener('peer-close', onClose)
    bridge.data.addEventListener('peer-closed', onClose)
  }

  attachWireweavePeer(peerId, dc) {
    if (!this._worker) return
    this._peerChannels.set(peerId, dc)
    this._worker.postMessage({ type: 'PEER_CONNECT', peerId })
    dc.addEventListener('message', ({ data }) => {
      const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      this._worker.postMessage({ type: 'PEER_MESSAGE', peerId, data: buf }, [buf])
    })
    dc.addEventListener('close', () => {
      this._peerChannels.delete(peerId)
      this._worker.postMessage({ type: 'PEER_DISCONNECT', peerId })
    })
  }

  async addPeer(offer, iceServers) {
    const peerId = Math.random().toString(36).slice(2)
    const pc = new RTCPeerConnection({ iceServers: iceServers?.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }] })
    pc.addEventListener('datachannel', ({ channel }) => {
      if (channel.label !== 'reliable') return
      channel.binaryType = 'arraybuffer'
      this._peerChannels.set(peerId, channel)
      this._worker.postMessage({ type: 'PEER_CONNECT', peerId })
      channel.addEventListener('message', ({ data }) => {
        const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        this._worker.postMessage({ type: 'PEER_MESSAGE', peerId, data: buf }, [buf])
      })
      channel.addEventListener('close', () => {
        this._peerChannels.delete(peerId)
        this._worker.postMessage({ type: 'PEER_DISCONNECT', peerId })
        pc.close()
      })
    })
    await pc.setRemoteDescription(new RTCSessionDescription(offer))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await _waitIce(pc)
    return { answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }, candidates: [] }
  }

  send(type, payload) {
    if (!this._worker) return
    const packed = pack({ type, payload })
    const buf = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength)
    this._worker.postMessage({ type: 'CLIENT_MESSAGE', data: buf }, [buf])
  }

  step() {}

  disconnect() {
    this.stopInputLoop()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibilityChange)
    if (this._worker) { this._worker.postMessage({ type: 'CLIENT_DISCONNECT' }); this._worker.terminate(); this._worker = null }
    this.connected = false
    this.callbacks.onDisconnect()
  }
}

async function _resolveRelativeDeps(source, baseUrl, seen = new Map()) {
  const re = /(?:from|import)\s*['"](\.[^'"]+|\/[^'"]+)['"]/g
  const out = {}
  const tasks = []
  let m
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]
    if (out[spec] !== undefined) continue
    out[spec] = ''
    tasks.push((async () => {
      const u = new URL(spec, baseUrl)
      let entryPromise = seen.get(u.href)
      if (!entryPromise) {
        entryPromise = (async () => {
          const r = await fetch(u).catch(() => null)
          if (!r?.ok) return null
          const src = await r.text()
          const deps = await _resolveRelativeDeps(src, u, seen)
          return { source: src, deps }
        })()
        seen.set(u.href, entryPromise)
      }
      const entry = await entryPromise
      out[spec] = entry ? { source: entry.source, deps: entry.deps } : null
    })())
  }
  await Promise.all(tasks)
  return out
}

function _waitIce(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve()
    pc.addEventListener('icegatheringstatechange', function h() {
      if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', h); resolve() }
    })
    setTimeout(resolve, 3000)
  })
}
