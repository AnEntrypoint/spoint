// Constant-time string compare for secret/token checks (EDITOR_TOKEN, X-Editor-Token header, etc).
//
// This module is imported by src/sdk/ServerHandlers.js, which BOTH the real Node server AND the
// singleplayer client's in-browser Worker (client/BrowserServer.js -> src/sdk/WorkerEntry.js -> this
// module's caller) share -- see AGENTS.md's one-server-two-client-modes-same-origin. A bare top-level
// `import { timingSafeEqual } from 'node:crypto'` (and this file's own prior `Buffer.from` usage) are
// both Node-only: a browser Worker has neither, so the ENTIRE worker module graph failed to load with
// an unhelpful `ErrorEvent` the instant this file was reached, silently hanging every singleplayer boot
// behind an indefinite "loading" state (root-caused live via `new Worker(...); w.onerror=...` +
// `page.evaluate`, catching a real `net::ERR_FAILED` on a `node:crypto` specifier fetch). Node's
// `crypto.timingSafeEqual` is dynamically imported ONLY on the real Node server path (detected via
// `typeof process !== 'undefined' && process.versions?.node`); the browser/worker path uses a manual
// constant-time XOR-accumulate compare over UTF-16 code units, which is timing-safe for the ONLY thing a
// browser Worker in this codebase actually compares (its own locally-known editor token against a value
// already inside the same trust boundary) even though it lacks the hardened guarantees a real remote-
// facing Node server needs against a network attacker.
const _isNode = typeof process !== 'undefined' && !!process.versions?.node
// Top-level await: this module's own evaluation (and therefore every caller's import of it) does not
// complete until the real Node primitive is loaded, so timingSafeTokenEqual never races an unset
// _nodeTimingSafeEqual on its first real-server call. A dynamic import (never a static top-level
// `import ... from 'node:crypto'`) is what keeps a browser/worker bundler-or-native-ESM resolver from
// ever needing to resolve the `node:` specifier at all on that path, since _isNode is false there.
const _nodeTimingSafeEqual = _isNode ? (await import('node:crypto')).timingSafeEqual : null

function _manualTimingSafeEqual(a, b) {
  // a.length === b.length is guaranteed by the caller before this runs; XOR every code unit so the
  // loop cost never depends on WHERE the first mismatch is (only on length, which the caller already
  // normalizes via the dummy same-length compare below).
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// timingSafeEqual throws on unequal-length buffers, so a naive `a.length===b.length && timingSafeEqual(a,b)`
// short-circuits on length BEFORE the safe compare runs -- an attacker can still time the length check.
// To avoid leaking length via early-return timing, always run a real timing-safe comparison: on a
// length mismatch, compare the candidate against itself (same cost, always succeeds) and then return false,
// so every call path costs one comparison regardless of whether lengths matched.
export function timingSafeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (_nodeTimingSafeEqual) {
    const bufA = Buffer.from(a, 'utf8')
    const bufB = Buffer.from(b, 'utf8')
    if (bufA.length !== bufB.length) { _nodeTimingSafeEqual(bufA, bufA); return false }
    return _nodeTimingSafeEqual(bufA, bufB)
  }
  if (a.length !== b.length) { _manualTimingSafeEqual(a, a); return false }
  return _manualTimingSafeEqual(a, b)
}
