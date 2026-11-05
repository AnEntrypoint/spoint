function refusal(code, message) {
  const err = new TypeError(`[ground-detail-reach] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export const GRAPHICS_TIERS = Object.freeze({ low: 0.35, medium: 0.6, high: 1, ultra: 1.4 })
export const DEVICE_CLASSES = Object.freeze({ phone: 0.6, tablet: 0.8, desktop: 1 })

export function resolveGroundDetailReach({ tier = 'medium', device = 'desktop', clipFar = 200, minReachM = 8, maxReachM = 400, enabled = true } = {}) {
  if (typeof enabled !== 'boolean') throw refusal('reach-enabled-invalid', 'enabled must be a boolean')
  if (!Object.hasOwn(GRAPHICS_TIERS, tier)) throw refusal('reach-tier-invalid', `tier must be one of ${Object.keys(GRAPHICS_TIERS).join(', ')}`)
  if (!Object.hasOwn(DEVICE_CLASSES, device)) throw refusal('reach-device-invalid', `device must be one of ${Object.keys(DEVICE_CLASSES).join(', ')}`)
  if (!Number.isFinite(clipFar) || clipFar <= 0) throw refusal('reach-clip-invalid', 'clipFar must be a positive finite number')
  if (!Number.isFinite(minReachM) || !Number.isFinite(maxReachM) || minReachM <= 0 || maxReachM < minReachM) throw refusal('reach-bounds-invalid', 'reach bounds must be finite with 0 < minReachM <= maxReachM')
  if (!enabled) return { enabled: false, reachM: 0, tier, device }
  const raw = clipFar * GRAPHICS_TIERS[tier] * DEVICE_CLASSES[device]
  return { enabled: true, reachM: Math.min(maxReachM, Math.max(minReachM, raw)), tier, device }
}
