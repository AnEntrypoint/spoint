import { pack, unpack, ensurePacked } from '/src/protocol/msgpack.js'
import { MSG } from '/src/protocol/MessageTypes.js'
import { BaseClient } from '/src/client/BaseClient.js'
import { TransformRingReader } from '/src/transport/TransformRing.js'

const _COALESCE_SENTINEL = 0xff
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
        _sourcesReady.then(({ worldDef, apps }) => this._worker.postMessage({ type: 'INIT', worldDef, apps, migrationSnapshot: this.config.migrationSnapshot || null, localPubkey: this.config.localPubkey || null, timeOfDaySeed: _lastTodSync })).catch(reject)
      }
      this._worker.onerror = reject
      this._worker.onmessage = ({ data }) => {
        if (data.type === 'WORKER_READY') { _workerReady = true; _tryInit(); return }
        if (data.type === 'INIT_ERROR') { reject(new Error(data.error + '\n' + data.stack)); return }
        if (data.type === 'TRANSFORM_RING') {
          try { this._transformRingReader = new TransformRingReader(data.sab, data.capacity) } catch (_) { this._transformRingReader = null }
          return
        }
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

  sendInput(input) {
    const predEngine = this._msgHandler.getPredEngine()
    if (this.config.predictionEnabled && predEngine) predEngine.addInput(input)
    this.send(MSG.INPUT, { input })
  }

  send(type, payload) {
    if (!this._worker) return
    const packed = pack({ type, payload })
    const buf = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength)
    this._worker.postMessage({ type: 'CLIENT_MESSAGE', data: buf }, [buf])
  }

  step() {}

  disconnect() {
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
