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

