const RULE_KEYS = new Set(['surface', 'key', 'equals', 'present'])

export function parseSurfaceSelector(spec) {
  if (!spec || typeof spec !== 'object' || typeof spec.fallback !== 'string' || !Array.isArray(spec.rules)) {
    throw new TypeError('surface selector needs a string fallback and a rules array')
  }
  const rules = spec.rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object') throw new TypeError(`surface selector rule ${index} is not an object`)
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) throw new TypeError(`surface selector rule ${index} has unknown key "${key}"`)
    }
    if (typeof rule.surface !== 'string' || typeof rule.key !== 'string') {
      throw new TypeError(`surface selector rule ${index} needs string surface and key`)
    }
    const hasEquals = Object.hasOwn(rule, 'equals')
    const hasPresent = Object.hasOwn(rule, 'present')
    if (hasEquals === hasPresent) throw new TypeError(`surface selector rule ${index} needs exactly one of equals or present`)
    if (hasPresent && typeof rule.present !== 'boolean') throw new TypeError(`surface selector rule ${index} present must be boolean`)
    return Object.freeze({ surface: rule.surface, key: rule.key, equals: rule.equals, present: rule.present, hasEquals })
  })
  return Object.freeze({ fallback: spec.fallback, rules: Object.freeze(rules) })
}

export function selectSurface(selector, playerState) {
  for (const rule of selector.rules) {
    const value = playerState?.[rule.key]
    const matched = rule.hasEquals ? value === rule.equals : (value != null) === rule.present
    if (matched) return rule.surface
  }
  return selector.fallback
}
