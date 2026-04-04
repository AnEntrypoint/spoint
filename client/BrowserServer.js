import { pack, unpack } from '/src/protocol/msgpack.js'
import { MSG } from '/src/protocol/MessageTypes.js'
import { SnapshotProcessor } from '/src/client/SnapshotProcessor.js'
import { MessageHandler } from '/src/client/MessageHandler.js'

const _base = import.meta.url

export class BrowserServer {
  constructor(config = {}) {
    this.config = config
    this.connected = false
    this._worker = null
    this.state = { players: [], entities: [] }
    this.callbacks = {
      onConnect: config.onConnect || (() => {}), onDisconnect: config.onDisconnect || (() => {}),
      onPlayerJoined: config.onPlayerJoined || (() => {}), onPlayerLeft: config.onPlayerLeft || (() => {}),
      onEntityAdded: config.onEntityAdded || (() => {}), onEntityRemoved: config.onEntityRemoved || (() => {}),
      onSnapshot: config.onSnapshot || (() => {}), onStateUpdate: config.onStateUpdate || (() => {}),
      onWorldDef: config.onWorldDef || (() => {}), onAppModule: config.onAppModule || (() => {}),
      onAssetUpdate: config.onAssetUpdate || (() => {}), onAppEvent: config.onAppEvent || (() => {}),
      onHotReload: config.onHotReload || (() => {}), onEditorSelect: config.onEditorSelect || (() => {}),
      onMessage: config.onMessage || (() => {})
    }
    this._snapProc = new SnapshotProcessor({ callbacks: this.callbacks })
    this._msgHandler = new MessageHandler({ ...config, callbacks: this.callbacks })
  }

  get playerId() { return this._msgHandler.getPlayerId() }

  async _importModule(path) {
    const r = await fetch(new URL(path, _base))
    if (!r.ok) throw new Error(`${r.status} ${path}`)
    const src = await r.text()
    const blob = new Blob([src], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try { return await import(url) } finally { URL.revokeObjectURL(url) }
  }

  async connect() {
    const worldDef = this.config.worldDef ||
      await fetch(new URL('singleplayer-world.json', _base)).then(r => r.ok ? r.json() : null).catch(() => null) ||
      await this._importModule('../apps/world/index.js').then(m => m.default).catch(() => null) ||
      {}
    const appNames = [...new Set((worldDef.entities || []).map(e => e.app).filter(Boolean))]
    const apps = (await Promise.all(appNames.map(name =>
      fetch(new URL(`../apps/${name}/index.js`, _base)).then(r => r.ok ? r.text().then(source => ({ name, source })) : null).catch(() => null)
    ))).filter(Boolean)

    return new Promise((resolve, reject) => {
      this._worker = new Worker(new URL('src/sdk/WorkerEntry.js', _base), { type: 'module' })
      this._worker.onerror = reject
      this._worker.onmessage = ({ data }) => {
        if (data.type !== 'SEND_CLIENT') return
        try {
          const bytes = data.data instanceof ArrayBuffer ? new Uint8Array(data.data) : data.data
          const msg = unpack(bytes)
          const result = this._msgHandler.handleMessage(msg.type, msg.payload || {}, this._snapProc)
          if (msg.type === MSG.SNAPSHOT || msg.type === MSG.STATE_CORRECTION || msg.type === MSG.STATE_RECOVERY) {
            if (result) this._onSnapshot(result)
          }
          if (msg.type === MSG.WORLD_DEF && !this.connected) {
            this.connected = true
            this.callbacks.onConnect()
            resolve()
          }
        } catch (e) { console.error('[BrowserServer] parse error', e) }
      }
      this._worker.postMessage({ type: 'INIT', worldDef, apps })
    })
  }

  _onSnapshot(data) {
    const snap = this._snapProc.processSnapshot(data, data.tick || 0)
    const si = this._msgHandler.getSmoothInterp()
    if (si) si.addSnapshot(snap)
    this.state.players = Array.from(this._snapProc.getAllPlayerStates().values())
    this.state.entities = Array.from(this._snapProc.getAllEntities().values())
    this.callbacks.onSnapshot(data)
    this.callbacks.onStateUpdate(this.state)
  }

  send(type, payload) {
    if (!this._worker) return
    const packed = pack({ type, payload })
    const buf = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength)
    this._worker.postMessage({ type: 'CLIENT_MESSAGE', data: buf }, [buf])
  }

  sendInput(input) { this.send(MSG.INPUT, { input }) }
  sendFire() {}
  sendReload() {}

  getSmoothState(now) { const si = this._msgHandler.getSmoothInterp(); return si ? si.getDisplayState(now) : this.state }
  getRTT() { return 0 }
  getBufferHealth() { return 1 }
  getLocalState() { return this._snapProc.getPlayerState(this.playerId) }
  getRemoteState(id) { return this._snapProc.getPlayerState(id) }
  getAllStates() { return this._snapProc.getAllPlayerStates() }
  getEntity(id) { return this._snapProc.getEntity(id) }
  getAllEntities() { return this._snapProc.getAllEntities() }
  step() {}

  disconnect() {
    if (this._worker) { this._worker.postMessage({ type: 'CLIENT_DISCONNECT' }); this._worker.terminate(); this._worker = null }
    this.connected = false
    this.callbacks.onDisconnect()
  }
}
