import { pack, unpack, ensurePacked } from '/src/protocol/msgpack.js'
import { MSG } from '/src/protocol/MessageTypes.js'
import { BaseClient } from '/src/client/BaseClient.js'
import { TransformRingReader } from '/src/transport/TransformRing.js'

// Mirrors ConnectionManager.js's COALESCE_SENTINEL: a per-tick flush from WorkerEntry's ConnectionManager
// may now coalesce multiple messages (e.g. SNAPSHOT + HEARTBEAT_ACK, both unreliable) into one framed
// buffer forwarded through WorkerTransport.send(data, mt) -- for a coalesced (multi-message) frame `mt` is
// simply omitted (see WorkerTransport.send's mt param, which ConnectionManager.flushAll never passes), so
// the snapshot-specific "latest wins" rAF-batch below must not misidentify a coalesced frame as a bare
// snapshot: doing so would silently drop whichever other message shared that frame if a newer frame
// overwrites the pending one before the next rAF. Only a frame that is ALREADY exactly one un-coalesced
// SNAPSHOT message is eligible for the latest-wins fast path; anything else (including any coalesced
// frame, even one that happens to contain a SNAPSHOT) goes through the normal immediate onMessage path,
// which still correctly demultiplexes and delivers every message in it via BaseClient's frame-splitting.
function _isBareSnapshotFrame(mt, bytes) {
  if (mt !== MSG.SNAPSHOT) return false
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return u8.length === 0 || u8[0] !== 0xff // 0xff sentinel would mean coalesced despite mt (defensive; shouldn't happen)
}

const _base = import.meta.url
const _root = _base.endsWith('/client/BrowserServer.js') ? new URL('../', _base).href : new URL('./', _base).href

// Page-lineage state for in-page server rebuilds (app.js's visibilitychange stall recovery creates a
// fresh BrowserServer in the SAME page; HostMigration.js does the same on host election). Module-level
// on purpose: each fresh instance is otherwise a blank slate and its worker boots as if the world had
// never run, which was live-witnessed as two user-visible defects on every rebuild:
//   (1) the fresh ServerTimeOfDay reset to startFraction, throwing the day/night cycle BACKWARD to
//       noon (sun/sky snap) -- `_lastTodSync` records the last TIME_OF_DAY_SYNC the previous server
//       actually delivered, and is threaded into INIT as timeOfDaySeed so the rebuilt clock
//       reconstructs elapsed time (frozen through the throttle stall, never skipped, never reset).
//   (2) the fresh worker's join-time WORLD_DEF re-fired the page's onWorldDef, whose world-reload
//       branch disposes EntityLoader + modelPool -- every loaded model lost its textures and
//       re-streamed from scratch, the exact "models correctly lit but flat solid color, no texture"
//       report. A WORLD_DEF whose canonical content the page ALREADY received in this lineage is a
//       same-world server reboot, not a world switch: EntityLoader.loadEntityModel is idempotent per
//       entity id, so the post-reconnect snapshot re-registers existing meshes harmlessly, and a
//       genuinely different world (reseed, edit) fingerprints differently and still delivers.
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
    // SharedArrayBuffer transform-ring hot path (physics-dedicated-worker-transform-offload): set once
    // the worker posts TRANSFORM_RING (only happens when it could allocate one -- see WorkerEntry.js's
    // isRingAvailable gate). null whenever unavailable (no COOP/COEP -> no crossOriginIsolated -> no
    // SharedArrayBuffer); every consumer of this must null-check and fall back to the existing
    // postMessage-decoded player state (this.getAllStates()) which keeps working unchanged either way.
    this._transformRingReader = null
    // server-scale-worldpersistence-workerentry-graceful-shutdown-save: bound once so disconnect() can
    // removeEventListener the SAME reference -- an inline arrow in connect() would leak a listener per
    // BrowserServer instance (host-migration creates a fresh instance without a page reload, see
    // client/HostMigration.js's `new BrowserServer(...)` call), each still firing on every future
    // visibilitychange after its own worker is long torn down.
    this._onVisibilityChange = () => {
      if (typeof document === 'undefined' || !document.hidden || !this._worker) return
      // Candidate (a) from this row's own PRD detail, chosen over (b) accepting periodic-only cadence:
      // visibilitychange fires reliably BEFORE beforeunload/pagehide in every major engine (tab switch,
      // minimize, mobile app-switch, and the actual tab-close sequence itself) while the page/Worker are
      // still fully alive -- unlike beforeunload, there is no risk of the page tearing down mid-write.
      // Fire-and-forget: the page staying open (the common tab-switch case) needs no round trip, and even
      // on an actual close the Worker keeps running independently of the main thread's own lifecycle until
      // the browser actually reclaims it, so this in-flight indexedDB write gets a real chance to land.
      this._worker.postMessage({ type: 'SAVE_NOW' })
    }
  }

  // Best-effort zero-postMessage-round-trip read of the freshest player transforms. Returns null when
  // the ring isn't available (see constructor comment) -- callers MUST handle null and fall back to
  // this.getAllStates() (the existing postMessage/SnapshotProcessor-decoded path), which is authoritative
  // regardless. Only meaningful for the in-Worker singleplayer/host BrowserServer path this class is;
  // WebSocketClientTransport-backed clients (real multiplayer) have no worker and never populate this.
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
    // Spawn worker first so its module/WASM warm overlaps the source fetches below; INIT waits for both.
    const workerUrl = new URL('src/sdk/WorkerEntry.js', _root)
    this._worker = new Worker(workerUrl, { type: 'module' })
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibilityChange)

    const _sourcesReady = (async () => {
      const worldDef = this.config.worldDef ||
        await fetch(new URL('singleplayer-world.json', _root)).then(r => r.ok ? r.json() : null).catch(() => null) ||
        {}
      const appNames = [...new Set([
        ...((worldDef.entities || []).map(e => e.app).filter(Boolean)),
        ...((worldDef.placeableApps || [])),
        ...((worldDef.trustedApps || []))
      ])]
      const apps = (await Promise.all(appNames.map(async name => {
        const indexUrl = new URL(`apps/${name}/index.js`, _root)
        const r = await fetch(indexUrl).catch(() => null)
        if (!r?.ok) return null
        const source = await r.text()
        const deps = await _resolveRelativeDeps(source, indexUrl)
        return { name, source, deps }
      }))).filter(Boolean)
      return { worldDef, apps }
    })()

    return new Promise((resolve, reject) => {
      let _workerReady = false
      const _tryInit = () => {
        if (!_workerReady) return
        // migrationSnapshot/localPubkey: only set when this BrowserServer is being booted by
        // client/HostMigration.js as the newly-elected host, not on an ordinary singleplayer/host boot
        // (both undefined -- WorkerEntry.js's init() already defaults migrationSnapshot to null).
        _sourcesReady.then(({ worldDef, apps }) => this._worker.postMessage({ type: 'INIT', worldDef, apps, migrationSnapshot: this.config.migrationSnapshot || null, localPubkey: this.config.localPubkey || null, timeOfDaySeed: _lastTodSync })).catch(reject)
      }
      this._worker.onerror = reject
      this._worker.onmessage = ({ data }) => {
        if (data.type === 'WORKER_READY') { _workerReady = true; _tryInit(); return }
        if (data.type === 'INIT_ERROR') { reject(new Error(data.error + '\n' + data.stack)); return }
        if (data.type === 'TRANSFORM_RING') {
          // data.sab arrives by reference (SharedArrayBuffer postMessage shares, never transfers) --
          // safe to wrap immediately, no transfer-list handshake needed unlike a transferred ArrayBuffer.
          try { this._transformRingReader = new TransformRingReader(data.sab, data.capacity) } catch (_) { this._transformRingReader = null }
          return
        }
        if (data.type === 'PEER_SEND') {
          const ch = this._peerChannels.get(data.peerId)
          if (ch?.readyState === 'open') ch.send(data.data)
          // Tap the raw bytes of every bare (un-coalesced -- see _isBareSnapshotFrame's own header
          // comment) per-peer SNAPSHOT send for client/SnapshotRelay.js's host-side installer, which
          // keeps only the latest one per peer to hand to a healthy relayer if this peer's own direct
          // edge later looks degraded. Optional hook (this.onPeerSnapshot), unset unless
          // installSnapshotRelayHost wired it -- see client/app.js's host bridge setup.
          if (this.onPeerSnapshot && _isBareSnapshotFrame(data.mt, data.data)) this.onPeerSnapshot(data.peerId, data.data)
          return
        }
        if (data.type !== 'SEND_CLIENT') return
        // Same-page server-reboot boundary (see the module-level _lastTodSync/_deliveredWorldFingerprints
        // block): tap the two messages whose re-delivery after a rebuild was live-witnessed breaking the
        // page -- TIME_OF_DAY_SYNC (recorded for the next boot's timeOfDaySeed) and a duplicate
        // same-content WORLD_DEF (dropped so the page never tears down a fully-loaded world for a
        // server that merely rebooted underneath it). A WORLD_DEF with different content always passes.
        if (data.mt === MSG.TIME_OF_DAY_SYNC) {
          try { const m = unpack(data.data); if (m && m.payload && Number.isFinite(m.payload.t)) _lastTodSync = { t: m.payload.t, dayLengthSec: m.payload.dayLengthSec, atMs: Date.now() } } catch (_) {}
        } else if (data.mt === MSG.WORLD_DEF) {
          try {
            const m = unpack(data.data)
            // timeOfDay.seed is injected by WorkerEntry only on rebuild boots (see timeOfDaySeed) --
            // excluded from the key so the rebuilt server's WORLD_DEF still fingerprints identically
            // to the first boot's. Everything else (entities, terrain, reseeded seeds, edits) compares.
            const key = m && m.payload ? _canonicalKey({ ...m.payload, terrain: m.payload.terrain ? { ...m.payload.terrain, timeOfDay: m.payload.terrain.timeOfDay ? { ...m.payload.terrain.timeOfDay, seed: undefined } : m.payload.terrain.timeOfDay } : m.payload.terrain }) : ''
            if (key && _deliveredWorldFingerprints.has(key)) return
            if (key) {
              if (_deliveredWorldFingerprints.size >= _MAX_WORLD_FINGERPRINTS) _deliveredWorldFingerprints.delete(_deliveredWorldFingerprints.values().next().value)
              _deliveredWorldFingerprints.add(key)
            }
          } catch (_) {}
        }
        // Coalesce snapshots post-connect (idempotent, latest wins) so a slow main thread doesn't OOM the postMessage queue.
        if (_isBareSnapshotFrame(data.mt, data.data) && this.connected) {
          this._pendingSnap = data.data
          if (!this._snapScheduled) {
            this._snapScheduled = true
            const flush = () => {
              this._snapScheduled = false
              const s = this._pendingSnap; this._pendingSnap = null
              // Guard against a flush firing after disconnect() already tore this instance down.
              if (s != null && this._worker) this.onMessage(s)
            }
            // webgpu-veg-placement-decouple-from-raf-for-backgrounded-tab: requestAnimationFrame fully
            // halts on an OS-backgrounded tab (proven live via a rAF-counter probe staying at literal 0
            // across multi-minute real windows) -- this "flush at most once per paint, latest wins"
            // coalesce is a real throttle (avoid re-running onMessage's decode/apply for every incoming
            // snapshot on a fast connection) but was never *required* to be paint-synchronized; it only
            // needs SOME bound on flush frequency. setTimeout(0) here still fires roughly once per macro-
            // task/message-batch on a foreground tab (this._pendingSnap keeps collapsing to "latest wins"
            // for anything that arrives before the timer fires) and, critically, setTimeout keeps firing
            // (throttled to ~1x/sec by the browser, but never fully halted like rAF -- confirmed live via
            // a parallel setInterval probe on this exact backgrounded tab: 11 fires over ~6 real minutes
            // vs 0 rAF fires) while backgrounded, so a singleplayer/host tab's snapshot pipeline -- and
            // everything downstream of it (terrain config, vegetation/rocks construction, _terrainCfg) --
            // keeps advancing instead of permanently stalling the instant the tab loses focus.
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

// Matches relative ('./x', '../x') AND root-absolute ('/x') import specifiers: the gh-pages deploy's
// path-patch step (gh-pages.yml "Patch paths for gh-pages") absolutizes deep relative src imports
// (apps/**/*.js climbing out via '../../src/...') into '/spoint/src/...' at build time, so a shipped
// app's own source can carry either form depending on how many directories deep it lives.
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
      if (seen.has(u.href)) { out[spec] = seen.get(u.href).source; return }
      const r = await fetch(u).catch(() => null)
      if (!r?.ok) { out[spec] = null; return }
      const src = await r.text()
      const entry = { source: src, deps: {} }
      seen.set(u.href, entry)
      out[spec] = src
      entry.deps = await _resolveRelativeDeps(src, u, seen)
      out[spec] = { source: src, deps: entry.deps }
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
