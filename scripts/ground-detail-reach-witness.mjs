import assert from 'node:assert/strict'
import { resolveGroundDetailReach, GRAPHICS_TIERS, DEVICE_CLASSES } from '../src/terrain/groundDetailReach.js'

const base = resolveGroundDetailReach({ tier: 'medium', device: 'desktop', clipFar: 200 })
assert.equal(base.enabled, true)
assert.ok(Math.abs(base.reachM - 120) < 1e-9)
assert.ok(resolveGroundDetailReach({ tier: 'low', device: 'desktop', clipFar: 200 }).reachM < base.reachM)
assert.ok(resolveGroundDetailReach({ tier: 'ultra', device: 'desktop', clipFar: 200 }).reachM > base.reachM)
assert.ok(resolveGroundDetailReach({ tier: 'high', device: 'phone', clipFar: 200 }).reachM < resolveGroundDetailReach({ tier: 'high', device: 'desktop', clipFar: 200 }).reachM)
assert.equal(resolveGroundDetailReach({ tier: 'ultra', device: 'desktop', clipFar: 100000, maxReachM: 400 }).reachM, 400)
assert.equal(resolveGroundDetailReach({ tier: 'low', device: 'phone', clipFar: 1, minReachM: 8 }).reachM, 8)
assert.deepEqual(resolveGroundDetailReach({ tier: 'high', device: 'desktop', enabled: false }), { enabled: false, reachM: 0, tier: 'high', device: 'desktop' })
assert.equal(Object.keys(GRAPHICS_TIERS).length, 4)
assert.equal(Object.keys(DEVICE_CLASSES).length, 3)

for (const [call, code] of [
  [() => resolveGroundDetailReach({ tier: 'cinematic' }), 'reach-tier-invalid'],
  [() => resolveGroundDetailReach({ device: 'watch' }), 'reach-device-invalid'],
  [() => resolveGroundDetailReach({ clipFar: NaN }), 'reach-clip-invalid'],
  [() => resolveGroundDetailReach({ minReachM: 10, maxReachM: 5 }), 'reach-bounds-invalid'],
  [() => resolveGroundDetailReach({ enabled: 'yes' }), 'reach-enabled-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS ground-detail reach scales by graphics tier and device, clamps to bounds, and refuses by code')
