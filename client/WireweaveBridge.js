import * as ww from 'wireweave'
import * as NostrTools from 'nostr-tools'
import * as xstate from 'xstate'

export async function createWireweaveBridge({ namespace = 'spoint', room, displayName = 'guest', relays = null, freshKey = false, iceServers = null } = {}) {
    if (!room) throw new Error('createWireweaveBridge: room required')

    const auth = ww.createAuth({ nostrTools: NostrTools, storage: freshKey ? null : localStorage })
    if (freshKey || !auth.loadFromStorage()) auth.generateKey()
    const fsm = ww.createFSM(xstate)
    const pool = ww.createRelayPool({
        relays: relays || ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.snort.social'],
        verifyEvent: NostrTools.verifyEvent
    })
    pool.connect()

    // worldDef.iceServers (threaded in by the caller, e.g. app.js's onWorldDef) overrides
    // wireweave's bundled default public TURN relay list when the world definition supplies one --
    // see AGENTS.md's warn-default-turn-credentials row: the bundled default uses shared public
    // openrelayproject credentials, unsuitable for a real hosted deployment.
    const data = ww.createDataSession({ fsm, xstate, relayPool: pool, auth, namespace, iceServers: iceServers?.length ? iceServers : null })

    return {
        auth, pool, fsm, data,
        get pubkey() { return auth.pubkey },
        async connect() { await data.connect(room, { displayName }) },
        async destroy() {
            try { await data.disconnect() } catch (_) {}
            try { pool.disconnect() } catch (_) {}
        }
    }
}

