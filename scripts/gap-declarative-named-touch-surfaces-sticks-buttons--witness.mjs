#!/usr/bin/env node
import { parseTouchSurfaces, TouchSurfaceSpecError } from '../client/core/TouchSurfaceSpec.js'

let failures = 0
function expect(name, ok) {
  if (ok) console.log(`ok   ${name}`)
  else { failures += 1; console.log(`FAIL ${name}`) }
}
function refusalCode(spec) {
  try { parseTouchSurfaces(spec); return null } catch (err) {
    return err instanceof TouchSurfaceSpecError ? err.reasonCode : `other:${err.message}`
  }
}

const good = { surfaces: [
  { id: 'move', kind: 'stick', anchor: 'left', x: 0.2, y: 0.8, size: 90, action: 'move' },
  { id: 'fire', kind: 'button', anchor: 'right', x: 0.9, y: 0.8, size: 56, action: 'fire' },
  { id: 'aim', kind: 'pad', anchor: 'right', x: 0.7, y: 0.5, size: 200, action: 'look' },
  { id: 'tilt', kind: 'orientation', anchor: 'left', x: 0.5, y: 0.5, size: 1, action: 'gyroAim' },
] }

const parsed = parseTouchSurfaces(good)
expect('valid spec yields four surfaces', parsed.length === 4)
expect('surfaces keep declared order and kinds', parsed.map((s) => s.kind).join(',') === 'stick,button,pad,orientation')
expect('parsed surface is frozen', Object.isFrozen(parsed[0]))
expect('empty surfaces array is accepted', parseTouchSurfaces({ surfaces: [] }).length === 0)
expect('missing surfaces array refused', refusalCode({}) === 'no-surfaces-array')
expect('null spec refused', refusalCode(null) === 'no-surfaces-array')
expect('non-object surface refused', refusalCode({ surfaces: [5] }) === 'surface-not-object')
expect('unknown kind refused', refusalCode({ surfaces: [{ ...good.surfaces[0], kind: 'dial' }] }) === 'bad-field')
expect('unknown anchor refused', refusalCode({ surfaces: [{ ...good.surfaces[0], anchor: 'top' }] }) === 'bad-field')
expect('NaN position refused', refusalCode({ surfaces: [{ ...good.surfaces[0], x: NaN }] }) === 'bad-field')
expect('string position refused (no coercion)', refusalCode({ surfaces: [{ ...good.surfaces[0], y: '0.5' }] }) === 'bad-field')
expect('position above 1 refused', refusalCode({ surfaces: [{ ...good.surfaces[0], x: 1.01 }] }) === 'bad-field')
expect('zero size refused', refusalCode({ surfaces: [{ ...good.surfaces[0], size: 0 }] }) === 'bad-field')
expect('Infinity size refused', refusalCode({ surfaces: [{ ...good.surfaces[0], size: Infinity }] }) === 'bad-field')
expect('empty action refused', refusalCode({ surfaces: [{ ...good.surfaces[0], action: '' }] }) === 'bad-field')
expect('duplicate id refused', refusalCode({ surfaces: [good.surfaces[0], good.surfaces[0]] }) === 'duplicate-id')
expect('refusal names the failing index', (() => { try { parseTouchSurfaces({ surfaces: [good.surfaces[0], { ...good.surfaces[1], size: -1 }] }); return false } catch (e) { return e.message.includes('surfaces[1].size') } })())

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failed)`)
  process.exit(1)
}
console.log('RESULT: PASS')
