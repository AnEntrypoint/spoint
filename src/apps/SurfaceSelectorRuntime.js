function refusal(code, message) {
  const err = new TypeError(`[surface-selector-runtime] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function createSurfaceSelectorRuntime({ labels = {}, maxSwapsPerSecond = 4, now, hideValue = null } = {}) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw refusal('selector-labels-invalid', 'labels must be an object')
  if (!Number.isFinite(maxSwapsPerSecond) || maxSwapsPerSecond <= 0) throw refusal('selector-rate-invalid', 'maxSwapsPerSecond must be a positive finite number')
  if (typeof now !== 'function') throw refusal('selector-clock-invalid', 'now must be a function')
  const swapTimes = []
  const held = new Set()
  let active = null
  const diagnostics = []
  return {
    select({ player = {}, device = {} } = {}) {
      if (!player || typeof player !== 'object' || !device || typeof device !== 'object') throw refusal('selector-context-invalid', 'player and device must be objects')
      const hasSurface = Object.hasOwn(player, 'surface') || Object.hasOwn(player, 'uiSurface')
      const script = hasSurface ? (Object.hasOwn(player, 'surface') ? player.surface : player.uiSurface) : undefined
      if (hasSurface && script === hideValue) return { name: null, hidden: true, label: null }
      const coarse = device.coarse === true
      const orientation = device.orientation === 'portrait' ? 'portrait' : 'landscape'
      const name = typeof script === 'string' && script ? script : (coarse ? `touch-${orientation}` : 'desktop')
      return { name, hidden: false, label: labels[name] ?? name }
    },
    swap(name) {
      if (typeof name !== 'string' || !name) throw refusal('selector-name-invalid', 'name must be a non-empty string')
      const atMs = now()
      if (!Number.isFinite(atMs)) throw refusal('selector-clock-invalid', 'now() must return a finite number')
      while (swapTimes.length && atMs - swapTimes[0] > 1000) swapTimes.shift()
      if (swapTimes.length >= maxSwapsPerSecond) {
        diagnostics.push(`swap-suppressed:${name}`)
        return { ok: false, reasonCode: 'selector-swap-suppressed', active }
      }
      swapTimes.push(atMs)
      const released = [...held]
      held.clear()
      active = name
      return { ok: true, reasonCode: null, active, released }
    },
    hold(pointerId) { held.add(String(pointerId)) },
    release(pointerId) { return held.delete(String(pointerId)) },
    active: () => active,
    held: () => [...held],
    diagnostics: () => diagnostics.slice(),
  }
}
