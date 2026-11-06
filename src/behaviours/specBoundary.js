function refusal(reasonCode, message, field = null) {
  const err = new TypeError(`[define-spec] ${message}`)
  err.reasonCode = reasonCode
  err.field = field
  return err
}

function matches(rule, value, partial) {
  if (rule.nullable && value === null) return true
  switch (rule.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        && (rule.min === undefined || (rule.exclusiveMin ? value > rule.min : value >= rule.min))
        && (rule.max === undefined || value <= rule.max)
    case 'boolean': return typeof value === 'boolean'
    case 'string': return typeof value === 'string' && (!rule.nonEmpty || value.length > 0)
    case 'function': return typeof value === 'function'
    case 'array': return Array.isArray(value) && (!rule.nonEmpty || value.length > 0)
    case 'custom': return rule.check(value, partial) === true
    default: return false
  }
}

export function parseDefineSpec(name, spec, schema) {
  if (!schema) throw refusal('define-spec-unknown-factory', `no spec schema is registered for ${name}`)
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw refusal('define-spec-invalid', `${name} spec must be a plain object`)
  for (const key of Object.keys(spec)) {
    if (!Object.hasOwn(schema, key)) throw refusal('define-spec-unknown-key', `${name} has no spec key "${key}"`, key)
  }
  const parsed = {}
  for (const [key, rule] of Object.entries(schema)) {
    const present = Object.hasOwn(spec, key)
    if (!present || spec[key] === undefined) {
      if (rule.required) throw refusal('define-spec-missing-field', `${name} requires spec.${key}`, key)
      const fallback = typeof rule.default === 'function' ? rule.default(parsed) : rule.default
      if (fallback !== undefined) parsed[key] = fallback
      continue
    }
    const value = spec[key]
    if (!matches(rule, value, parsed)) throw refusal('define-spec-invalid-field', `${name}.${key} failed its ${rule.type} rule`, key)
    parsed[key] = value
  }
  return Object.freeze(parsed)
}

const callback = () => ({ type: 'function' })

export const DEFINE_SPEC_SCHEMAS = Object.freeze({
  weapon: Object.freeze({
    damage: { type: 'number', min: 0, default: 25 },
    range: { type: 'number', min: 0, exclusiveMin: true, default: 100 },
    magazine: { type: 'number', min: 0, default: 0 },
    reloadMs: { type: 'number', min: 0, default: 1500 },
    fireRateMs: { type: 'number', min: 0, default: 120 },
    headshotMult: { type: 'number', min: 0, exclusiveMin: true, default: 2 },
    onFire: callback(), onHit: callback(), onKill: callback(), onReload: callback(),
  }),
  pickup: Object.freeze({
    radius: { type: 'number', min: 0, default: 1.5 },
    cooldown: { type: 'number', min: 0, default: 0 },
    oneShot: { type: 'boolean', default: false },
    onCollect: { type: 'function', required: true },
  }),
  health: Object.freeze({
    max: { type: 'number', min: 0, exclusiveMin: true, required: true },
    hp: { type: 'number', min: 0, default: partial => partial.max },
    invulnMs: { type: 'number', min: 0, default: 0 },
    onDeath: callback(), onDamage: callback(), onRespawn: callback(),
  }),
  teams: Object.freeze({
    teams: { type: 'array', nonEmpty: true, required: true },
    scoreLimit: { type: 'number', min: 0, exclusiveMin: true, nullable: true },
    autoBalance: { type: 'boolean', default: true },
    broadcast: { type: 'boolean', default: true },
    channel: { type: 'string', nonEmpty: true, default: 'scoreboard' },
    colorblindSafe: { type: 'boolean', default: false },
    onAssign: callback(), onScore: callback(), onWin: callback(),
  }),
})
