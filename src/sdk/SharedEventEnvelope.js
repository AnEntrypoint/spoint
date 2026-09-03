/**
 * SharedEventEnvelope.js -- Unified event envelope schema for cross-repo observability.
 *
 * FIRST SLICE of cross-project-identity-eventbus-shared-ecs-flagship-demo.
 *
 * Defines ONE event envelope shape (id, ts, source, kind, payload) that unifies:
 *  - spoint's src/apps/EventBus.js (channel + data + meta)
 *  - thebird's event-chain (event stream)
 *  - freddie's hook events (plugin lifecycle)
 *  - wireweave's data-channel events (peer messages)
 *
 * This is a SCHEMA ONLY -- no runtime dependency between repos. Each repo
 * adopts the envelope shape at its own boundary. The benefit is that a single
 * observability tool (logging, tracing, replay) can consume events from any
 * repo without repo-specific parsing.
 *
 * Envelope shape:
 *  {
 *    id: string,       // ULID (sortable, unique) -- or UUID v4
 *    ts: number,       // Unix milliseconds timestamp (Date.now())
 *    source: string,   // "repo:component" e.g. "spoint:EventBus", "freddie:plugin-loader", "thebird:window-manager", "wireweave:data-session"
 *    kind: string,     // dot-separated event kind e.g. "entity.spawn", "player.connect", "window.open", "peer.join"
 *    payload: any,     // kind-specific data (JSON-serializable)
 *  }
 *
 * Mapping to spoint's existing EventBus (src/apps/EventBus.js):
 *  EventBus.emit(channel, data, meta) produces:
 *    {
 *      id: ULID or meta.correlationId || generateId(),
 *      ts: meta.timestamp || Date.now(),
 *      source: meta.source || `spoint:entity:${meta.sourceEntity || 'unknown'}`,
 *      kind: channel,  // e.g. "player.spawn", "entity.destroy", "system.handover"
 *      payload: data,
 *    }
 *
 * Mapping to wireweave data-session events:
 *  wireweave's DataSession 'data' event (peer, bytes) produces:
 *    {
 *      id: ULID from the message itself,
 *      ts: received timestamp,
 *      source: `wireweave:peer:${peer.pubkey.slice(0,12)}`,
 *      kind: `data.message`,
 *      payload: { peer: peer.pubkey, size: bytes.byteLength },
 *    }
 */

/**
 * Generate a ULID-like sortable id. Uses crypto.randomUUID() when available,
 * falling back to a timestamp + random suffix.
 */
export function generateEventId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback: timestamp + random hex
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `${ts}-${rand}`
}

/**
 * Wrap an existing spoint EventBus emit into a SharedEventEnvelope.
 * Returns the envelope (not the EventBus event object).
 *
 * @param {import('../apps/EventBus.js').EventBus} bus - the spoint EventBus instance
 * @param {string} channel - event channel
 * @param {*} data - event payload
 * @param {object} [meta] - optional metadata
 * @returns {object} the envelope
 */
export function emitEnvelope(bus, channel, data, meta = {}) {
  const event = bus.emit(channel, data, meta)
  return {
    id: generateEventId(),
    ts: event.meta.timestamp,
    source: meta.source || `spoint:entity:${meta.sourceEntity || 'unknown'}`,
    kind: channel,
    payload: data,
  }
}

/**
 * Create a proxy over an EventBus that automatically wraps every emit
 * in the shared envelope shape and returns the envelope.
 *
 * @param {import('../apps/EventBus.js').EventBus} bus
 * @returns {object} { on, off, once, emit, scope, ... } with emit returning envelopes
 */
export function wrapEventBus(bus) {
  return {
    on: bus.on.bind(bus),
    off: bus.off.bind(bus),
    once: bus.once.bind(bus),
    emit: (channel, data, meta = {}) => emitEnvelope(bus, channel, data, meta),
    emitRaw: bus.emit.bind(bus),
    scope: bus.scope.bind(bus),
    destroyScope: bus.destroyScope.bind(bus),
    clear: bus.clear.bind(bus),
  }
}

/**
 * Given a source string like "spoint:entity:player-abc", parse it into
 * structured components. Used by observability tooling for filtering/grouping.
 */
export function parseSource(source) {
  const parts = source.split(':')
  const repo = parts[0] || 'unknown'
  const component = parts[1] || 'unknown'
  const identifier = parts.slice(2).join(':') || null
  return { repo, component, identifier }
}

/**
 * Validate an envelope. Returns { valid: true } or { valid: false, errors: [...] }.
 */
export function validateEnvelope(env) {
  const errors = []
  if (!env || typeof env !== 'object') return { valid: false, errors: ['envelope must be an object'] }
  if (typeof env.id !== 'string' || !env.id) errors.push('id is required (string)')
  if (typeof env.ts !== 'number') errors.push('ts is required (number)')
  if (typeof env.source !== 'string' || !env.source) errors.push('source is required (string)')
  if (typeof env.kind !== 'string' || !env.kind) errors.push('kind is required (string)')
  if (!('payload' in env)) errors.push('payload is required')
  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}