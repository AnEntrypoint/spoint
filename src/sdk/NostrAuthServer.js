// Server-side nostr auth challenge/response handler (cross-project-identity-nostr-login-flow).
//
// Flow: server generates a random challenge string, sends it to the client via NOSTR_AUTH_CHALLENGE.
// Client signs the challenge with their nostr private key and returns a signed nostr event via
// NOSTR_AUTH_RESPONSE. Server verifies the signature against the claimed pubkey using nostr-tools.
//
// Opt-in per worldDef.identity.nostrAuth (defaults to disabled). When enabled, every new connection
// must pass the challenge before being allowed to join as a player -- the connection stays in a
// "pending auth" state until a valid NOSTR_AUTH_RESPONSE arrives, and is disconnected after a
// configurable timeout.
//
// Dual-import safe: always importable, only uses nostr-tools (already a direct dependency, used by
// ServerPresence.js) -- no Node-specific APIs.

const CHALLENGE_BYTES = 32
const DEFAULT_TIMEOUT_MS = 15000
const MAX_PUBKEY_LEN = 128

// Node crypto for random bytes (dynamic import, not a top-level static -- this module is ALSO
// loaded in the browser Worker singleplayer path where `node:crypto` is unavailable).
let _nodeCrypto = null
async function _ensureNodeCrypto() {
  if (_nodeCrypto !== null) return _nodeCrypto
  try { _nodeCrypto = await import('node:crypto'); return _nodeCrypto } catch { _nodeCrypto = false; return false }
}

async function randomHex(bytes) {
  const arr = new Uint8Array(bytes)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(arr)
  } else {
    const nc = await _ensureNodeCrypto()
    if (nc && nc.randomFillSync) {
      nc.randomFillSync(arr)
    } else {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function createNostrAuthServer({ enableChallenge = false, challengeTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // transport -> { challenge, timer, pubkey }
  const _pending = new Map()

  let _enabled = enableChallenge
  let _timeoutMs = challengeTimeoutMs

  function isEnabled() { return _enabled }

  function setEnabled(v) { _enabled = !!v }

  // Generate a challenge for a new connection. Returns a promise that resolves to the challenge string.
  // The connection is registered as "pending" -- if no valid NOSTR_AUTH_RESPONSE arrives within
  // timeoutMs, the connection is disconnected.
  async function challengeConnection(transport) {
    if (!_enabled) return null
    const challenge = await randomHex(CHALLENGE_BYTES)
    const timer = setTimeout(() => {
      const entry = _pending.get(transport)
      if (entry) {
        _pending.delete(transport)
        try { transport.close() } catch {}
      }
    }, _timeoutMs)
    _pending.set(transport, { challenge, timer })
    return challenge
  }

  // Verify a client's signed response. Returns {ok:true, pubkey} on success, or {ok:false, error} on failure.
  async function verifyResponse(transport, payload) {
    if (!_enabled) return { ok: true, pubkey: null, skipped: true }
    const entry = _pending.get(transport)
    if (!entry) return { ok: false, error: 'no pending challenge for this connection' }

    const { challenge, timer } = entry
    if (timer) clearTimeout(timer)
    _pending.delete(transport)

    const pubkey = (payload?.pubkey || '').slice(0, MAX_PUBKEY_LEN)
    const sig = payload?.sig
    const id = payload?.id

    if (!pubkey || !sig || !id) {
      return { ok: false, error: 'missing pubkey, sig, or id in auth response' }
    }

    try {
      const NostrTools = await import('nostr-tools')
      // Verify the signed event: the client must have signed an event with content === challenge
      const event = {
        id,
        pubkey,
        created_at: payload?.created_at || 0,
        kind: payload?.kind || 27235, // NIP-98 HTTP Auth
        tags: payload?.tags || [],
        content: challenge,
        sig,
      }

      const valid = NostrTools.verifyEvent(event)
      if (!valid) {
        return { ok: false, error: 'invalid signature' }
      }

      // Verify the event content matches our challenge
      if (event.content !== challenge) {
        return { ok: false, error: 'signed event content does not match challenge' }
      }

      return { ok: true, pubkey }
    } catch (e) {
      return { ok: false, error: e?.message || 'signature verification failed' }
    }
  }

  // Clean up a pending challenge (connection closed before auth completed)
  function cancelChallenge(transport) {
    const entry = _pending.get(transport)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      _pending.delete(transport)
    }
  }

  function pendingCount() { return _pending.size }

  return {
    isEnabled, setEnabled,
    challengeConnection, verifyResponse, cancelChallenge,
    pendingCount,
  }
}