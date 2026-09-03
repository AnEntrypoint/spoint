export async function createWireweaveClient({ namespace = 'spoint', room, displayName = 'Guest', voice = false, relays = null } = {}) {
  if (!room) throw new Error('createWireweaveClient: room required')
  const NostrTools = await import('nostr-tools')
  const xstate = await import('xstate')
  const ww = await import('wireweave')

  const auth = new ww.NostrAuth({ nostrTools: NostrTools })
  if (!auth.loadFromStorage()) auth.generateKey()
  const fsm = ww.createFSM(xstate)
  const pool = relays
    ? new ww.RelayPool({ relays, verifyEvent: NostrTools.verifyEvent })
    : new ww.RelayPool({ verifyEvent: NostrTools.verifyEvent })
  pool.connect()

  const data = ww.createDataSession({ fsm, xstate, relayPool: pool, auth, namespace })
  await data.connect(room, { displayName })

  let voiceSession = null
  if (voice) {
    voiceSession = ww.createVoiceSession({ fsm, xstate, relayPool: pool, auth, mediaDevices: navigator.mediaDevices, serverId: namespace })
    await voiceSession.connect(room, { displayName })
  }

  return {
    auth, pool, fsm, data, voice: voiceSession,
    pubkey: auth.pubkey,
    async destroy() {
      try { await data.disconnect() } catch {}
      try { await voiceSession?.disconnect() } catch {}
      pool.disconnect()
    }
  }
}

export function getRoomFromHash(prefix = 'room=') {
  if (typeof location === 'undefined') return null
  const h = location.hash.replace(/^#/, '')
  if (!h) return null
  if (h.startsWith(prefix)) return h.slice(prefix.length)
  return h
}
