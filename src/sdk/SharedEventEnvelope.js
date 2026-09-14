export function generateEventId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `${ts}-${rand}`
}

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

export function parseSource(source) {
  const parts = source.split(':')
  const repo = parts[0] || 'unknown'
  const component = parts[1] || 'unknown'
  const identifier = parts.slice(2).join(':') || null
  return { repo, component, identifier }
}

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