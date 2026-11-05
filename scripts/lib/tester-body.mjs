function refusal(code, message) {
  const err = new TypeError(`[tester-body] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export const RENDER_MODES = Object.freeze(['cpu', 'gpu', 'none'])

export function createTesterFleet({ now, maxBodies = 60 } = {}) {
  if (typeof now !== 'function') throw refusal('tester-clock-invalid', 'now must be a function')
  if (!Number.isInteger(maxBodies) || maxBodies < 1) throw refusal('tester-cap-invalid', 'maxBodies must be a positive integer')
  const bodies = new Map()

  return {
    join({ tester = 0, room, render = 'none', latencyMs = 0, ttlS = 60 } = {}) {
      if (!Number.isInteger(tester) || tester < 0) throw refusal('tester-id-invalid', 'tester must be a non-negative integer')
      if (typeof room !== 'string' || !room) throw refusal('tester-room-invalid', 'room must be a non-empty string')
      if (!RENDER_MODES.includes(render)) throw refusal('tester-render-invalid', `render must be one of ${RENDER_MODES.join(', ')}`)
      if (!Number.isFinite(latencyMs) || latencyMs < 0) throw refusal('tester-latency-invalid', 'latencyMs must be a non-negative finite number')
      if (!Number.isFinite(ttlS) || ttlS <= 0) throw refusal('tester-ttl-invalid', 'ttlS must be a positive finite number')
      if (bodies.has(tester)) throw refusal('tester-duplicate', `tester ${tester} is already standing`)
      if (bodies.size >= maxBodies) throw refusal('tester-cap-reached', `at most ${maxBodies} bodies can stand`)
      const atMs = now()
      if (!Number.isFinite(atMs)) throw refusal('tester-clock-invalid', 'now() must return a finite number')
      const body = Object.freeze({ tester, room, render, latencyMs, expiresAtMs: atMs + ttlS * 1000 })
      bodies.set(tester, body)
      return body
    },
    leave(tester) {
      if (!bodies.delete(tester)) throw refusal('tester-unknown', `tester ${tester} is not standing`)
      return { ok: true, tester }
    },
    prune() {
      const atMs = now()
      const expired = [...bodies.values()].filter(body => atMs >= body.expiresAtMs)
      for (const body of expired) bodies.delete(body.tester)
      return expired.map(body => body.tester)
    },
    active: () => [...bodies.values()],
  }
}
