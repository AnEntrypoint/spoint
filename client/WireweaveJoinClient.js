import { pack, ensurePacked } from '/src/protocol/msgpack.js'
import { MSG } from '/src/protocol/MessageTypes.js'
import { BaseClient } from '/src/client/BaseClient.js'

export class WireweaveJoinClient extends BaseClient {
    constructor(config = {}) {
        super(config)
        this._bridge = null
        this._hostPubkey = null
        this._dc = null
        this._pendingSends = []
    }

    async connect() {
        await ensurePacked
        // p2p-mesh-initial-host-election-race-on-shared-room-code: a caller that already opened (and
        // connected) a wireweave bridge itself -- e.g. client/app.js's ?room=X host-intent boot path,
        // which must listen for a pre-existing host's announce BEFORE deciding whether to boot its own
        // BrowserServer or defer as a joiner -- passes that live bridge in via config.existingBridge
        // rather than having this class open a SECOND bridge (a second nostr identity/relay connection
        // for the same physical tab, wasteful and pointless since the first bridge already has every
        // peer-open/data event this class needs).
        if (this.config.existingBridge) {
            this._bridge = this.config.existingBridge
        } else {
            const { createWireweaveBridge } = await import('./WireweaveBridge.js')
            this._bridge = await createWireweaveBridge({
                namespace: this.config.namespace || 'spoint',
                room: this.config.room,
                displayName: this.config.displayName || 'joiner',
                relays: this.config.relays || null,
                freshKey: this.config.freshKey || false,
                // A joiner connects before any worldDef is available (it's establishing the very bridge
                // that will deliver one), so this can only come from explicit client config (e.g. a URL
                // param the host page already knows), never from worldDef.iceServers directly.
                iceServers: this.config.iceServers || null
            })
            await this._bridge.connect()
            this._bridge.roomId = this.config.room
        }
        // Expose on window.__app.wireweave same as the host path (client/app.js) so
        // client/hud/VoiceIndicator.js can find the auth+relayPool it needs to join
        // the room's voice channel from the joiner side too.
        if (typeof window !== 'undefined') { window.__app = window.__app || {}; window.__app.wireweave = this._bridge }

        // config.knownHostPubkey: the pre-existing host's pubkey, already learned from its host-announce
        // during the pre-boot grace-window listen (see waitForExistingHost in HostMigration.js) -- skips
        // the generic "first peer-open wins" race entirely and locks onto the SPECIFIC peer that is
        // actually already hosting, even if some other peer's data channel happens to open first.
        if (this.config.knownHostPubkey) {
            const pk = this.config.knownHostPubkey
            this._hostPubkey = pk
            this._dc = this._bridge.data.peers.get(pk)?.dc
            this.connected = !!(this._dc && this._dc.readyState === 'open')
            this._wireDcEvents()
            if (this.connected) {
                this.callbacks.onConnect?.()
                for (const buf of this._pendingSends) this._rawSend(buf)
                this._pendingSends = []
                return
            }
            // Not open yet (mesh connection still negotiating) -- fall through to the generic peer-open
            // wait below, but gated to this specific pubkey so a coincidentally-faster OTHER peer can
            // never hijack the connection out from under the already-decided host.
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => { reject(new Error('Known host peer did not open within 15s')) }, 15000)
                const onOpen = ({ detail }) => {
                    if (detail.peerPubkey !== pk) return
                    clearTimeout(timeout)
                    this._bridge.data.removeEventListener('peer-open', onOpen)
                    this._dc = this._bridge.data.peers.get(pk)?.dc
                    this.connected = true
                    this.callbacks.onConnect?.()
                    for (const buf of this._pendingSends) this._rawSend(buf)
                    this._pendingSends = []
                    resolve()
                }
                this._bridge.data.addEventListener('peer-open', onOpen)
            })
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { reject(new Error('No host peer found in room within 15s')) }, 15000)
            const onPeerOpen = ({ detail }) => {
                if (this._hostPubkey) return
                this._hostPubkey = detail.peerPubkey
                clearTimeout(timeout)
                this._bridge.data.removeEventListener('peer-open', onPeerOpen)
                this._dc = this._bridge.data.peers.get(this._hostPubkey)?.dc
                this.connected = true
                this._wireDcEvents()
                this.callbacks.onConnect?.()
                for (const buf of this._pendingSends) this._rawSend(buf)
                this._pendingSends = []
                resolve()
            }
            this._bridge.data.addEventListener('peer-open', onPeerOpen)
            for (const [pk, peer] of this._bridge.data.peers) {
                if (peer?.dc?.readyState === 'open') { onPeerOpen({ detail: { peerPubkey: pk } }); break }
            }
        })
    }

    _wireDcEvents() {
        const onData = ({ detail }) => {
            if (detail.peerPubkey !== this._hostPubkey) return
            const data = detail.data
            const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            this.onMessage(buf)
        }
        const onClose = ({ detail }) => {
            if (detail.peerPubkey !== this._hostPubkey) return
            const peer = this._bridge.data.peers.get(this._hostPubkey)
            if (peer?.dc?.readyState === 'open') return
            this.connected = false
            this.callbacks.onDisconnect?.()
        }
        const onOpen = ({ detail }) => {
            if (detail.peerPubkey !== this._hostPubkey) return
            const peer = this._bridge.data.peers.get(this._hostPubkey)
            if (peer?.dc) this._dc = peer.dc
            if (!this.connected) { this.connected = true; this.callbacks.onConnect?.() }
            if (this._pendingSends.length) { const q = this._pendingSends; this._pendingSends = []; for (const buf of q) this._rawSend(buf) }
        }
        this._bridge.data.addEventListener('data', onData)
        this._bridge.data.addEventListener('peer-close', onClose)
        this._bridge.data.addEventListener('peer-closed', onClose)
        this._bridge.data.addEventListener('peer-open', onOpen)
    }

    _hostDcOpen() {
        return this._bridge?.data?.peers?.get?.(this._hostPubkey)?.dc?.readyState === 'open'
    }

    _rawSend(buf) {
        if (!this._hostPubkey || !this._bridge) return
        return this._bridge.data.send(this._hostPubkey, buf)
    }

    sendInput(input) {
        const predEngine = this._msgHandler.getPredEngine()
        if (this.config.predictionEnabled && predEngine) {
            const sequence = predEngine.addInput(input)
            const redundant = predEngine.getUnackedInputs(4)
            this.send(MSG.INPUT, { input, sequence, redundant })
            return
        }
        this.send(MSG.INPUT, { input })
    }

    send(type, payload) {
        const packed = pack({ type, payload })
        const buf = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength)
        // Don't trust a stale connected flag: check the live dc, or a peer-close event strands inputs.
        if (this.connected || this._hostDcOpen()) { if (!this.connected) this.connected = true; this._rawSend(buf); return }
        this._pendingSends.push(buf)
    }

    step() {}

    disconnect() {
        if (this._bridge) { this._bridge.destroy(); this._bridge = null }
        this.connected = false
        this.callbacks.onDisconnect?.()
    }
}
