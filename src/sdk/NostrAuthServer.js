const CHALLENGE_BYTES = 32
const DEFAULT_TIMEOUT_MS = 15000
const MAX_PUBKEY_LEN = 128
const NIP98_HTTP_AUTH_KIND = 27235

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
  const _pending = new Map()

  let _enabled = enableChallenge
  let _timeoutMs = challengeTimeoutMs

  function isEnabled() { return _enabled }

  function setEnabled(v) { _enabled = !!v }

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
      const event = {
        id,
        pubkey,
        created_at: payload?.created_at || 0,
        kind: payload?.kind || NIP98_HTTP_AUTH_KIND,
        tags: payload?.tags || [],
        content: challenge,
        sig,
      }

      const valid = NostrTools.verifyEvent(event)
      if (!valid) {
        return { ok: false, error: 'invalid signature' }
      }

      if (event.content !== challenge) {
        return { ok: false, error: 'signed event content does not match challenge' }
      }

      return { ok: true, pubkey }
    } catch (e) {
      return { ok: false, error: e?.message || 'signature verification failed' }
    }
  }

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