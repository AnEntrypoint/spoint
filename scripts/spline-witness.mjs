import assert from 'node:assert/strict'
import { createSplineRegistry } from '../src/behaviours/spline.js'

const EPS = 1e-6
const FRAME_KEYS = ['lateral', 'normal', 'position', 'rotation', 'tangent']

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const approx = (a, b, msg, tol = EPS) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`)
const arrEq = (a, b, msg, tol = EPS) => assert.ok(Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol), `${msg}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)

function rotate(q, v) {
  const [x, y, z, w] = q
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])]
  return [
    v[0] + w * t[0] + y * t[2] - z * t[1],
    v[1] + w * t[1] + z * t[0] - x * t[2],
    v[2] + w * t[2] + x * t[1] - y * t[0],
  ]
}

let refusals = 0
const refuses = (fn, code) => {
  refusals++
  assert.throws(fn, (e) => e && e.reasonCode === code, `expected refusal code ${code}`)
}

function checkFrame(f, msg) {
  assert.deepEqual(Object.keys(f).sort(), FRAME_KEYS, `${msg}: frame keys`)
  approx(Math.hypot(...f.tangent), 1, `${msg}: unit tangent`)
  approx(Math.hypot(...f.normal), 1, `${msg}: unit normal`)
  approx(Math.hypot(...f.lateral), 1, `${msg}: unit lateral`)
  approx(Math.hypot(...f.rotation), 1, `${msg}: unit rotation`)
  approx(dot(f.tangent, f.normal), 0, `${msg}: tangent orthogonal to normal`)
  approx(dot(f.tangent, f.lateral), 0, `${msg}: tangent orthogonal to lateral`)
  approx(dot(f.normal, f.lateral), 0, `${msg}: normal orthogonal to lateral`)
  arrEq(cross(f.tangent, f.normal), f.lateral, `${msg}: right-handed frame`)
  arrEq(rotate(f.rotation, [1, 0, 0]), f.tangent, `${msg}: rotation carries local +X to tangent`)
  arrEq(rotate(f.rotation, [0, 1, 0]), f.normal, `${msg}: rotation carries local +Y to normal`)
  arrEq(rotate(f.rotation, [0, 0, 1]), f.lateral, `${msg}: rotation carries local +Z to lateral`)
}

const registry = createSplineRegistry()
for (const name of ['add', 'get', 'sample', 'length', 'project', 'frameAt', 'remove']) {
  assert.equal(typeof registry[name], 'function', `registry missing ${name}`)
}

const linePoints = [[0, 0, 0], [10, 0, 0], [20, 0, 0]]
const lineInfo = registry.add('line', linePoints)
assert.deepEqual(Object.keys(lineInfo).sort(), ['closed', 'id', 'length', 'points', 'samplesPerSegment', 'segments', 'tangentAxis'])
assert.equal(lineInfo.id, 'line')
assert.equal(lineInfo.closed, false)
assert.equal(lineInfo.tangentAxis, 'x')
assert.equal(lineInfo.segments, 2)
approx(lineInfo.length, 20, 'open line length')
approx(registry.length('line'), 20, 'open line length()')
arrEq(registry.get('line').points[1], [10, 0, 0], 'get returns points')
const copied = registry.get('line')
copied.points[1][0] = 999
arrEq(registry.get('line').points[1], [10, 0, 0], 'get returns fresh point arrays')

const start = registry.sample('line', 0)
const quarter = registry.sample('line', 0.25)
const middle = registry.sample('line', 0.5)
const end = registry.sample('line', 1)
checkFrame(start, 'open start')
checkFrame(quarter, 'open quarter')
checkFrame(middle, 'open middle')
checkFrame(end, 'open end')
arrEq(start.position, [0, 0, 0], 'open sample(0)')
arrEq(quarter.position, [5, 0, 0], 'open sample(0.25)')
arrEq(middle.position, [10, 0, 0], 'open sample(0.5)')
arrEq(end.position, [20, 0, 0], 'open sample(1)')
arrEq(start.tangent, [1, 0, 0], 'open tangent +X')
arrEq(start.normal, [0, 1, 0], 'open normal +Y')
arrEq(start.lateral, [0, 0, 1], 'open lateral +Z')
arrEq(start.rotation, [0, 0, 0, 1], 'open rotation identity')
arrEq(registry.frameAt('line', 5).position, [5, 0, 0], 'open frameAt(5)')
checkFrame(registry.frameAt('line', 5), 'open frameAt(5)')
arrEq(registry.frameAt('line', 20).position, [20, 0, 0], 'open frameAt(length)')

const segmentHit = registry.project(5, 3, 0)
assert.deepEqual(Object.keys(segmentHit).sort(), ['distance', 'id', 'point', 't'])
assert.equal(segmentHit.id, 'line')
approx(segmentHit.t, 0.25, 'segment projection t', 0.01)
approx(segmentHit.distance, 3, 'segment projection distance', 0.01)
arrEq(segmentHit.point, [5, 0, 0], 'segment projection point', 0.01)
arrEq(registry.sample(segmentHit.id, segmentHit.t).position, segmentHit.point, 'sample(projection.t) matches projection.point', 0.01)
const onLine = registry.project(5, 0, 0)
approx(onLine.distance, 0, 'on-spline projection distance', 0.01)
approx(onLine.t, 0.25, 'on-spline projection t', 0.01)
const pastEnd = registry.project(25, 0, 0)
approx(pastEnd.distance, 5, 'past-end projection distance', 0.01)
approx(pastEnd.t, 1, 'past-end projection t', 0.01)
arrEq(pastEnd.point, [20, 0, 0], 'past-end projection point', 0.01)

registry.add('uneven', [[0, 0, 0], [10, 0, 0], [20, 0, 0], [60, 0, 0]])
const unevenLength = registry.length('uneven')
approx(unevenLength, 60, 'uneven arc length', 0.1)
const half = registry.sample('uneven', 0.5)
checkFrame(half, 'uneven midpoint')
approx(half.position[0], 30, 'arc-length midpoint is 30 m along the curve', 0.5)
assert.ok(half.position[0] > 25, 'arc-length midpoint is not the uniform-parameter midpoint')
const halfByDistance = registry.frameAt('uneven', unevenLength / 2)
arrEq(halfByDistance.position, half.position, 'sample(0.5) equals frameAt(length/2)', 0.01)
checkFrame(halfByDistance, 'uneven frameAt(length/2)')
const nearestSpline = registry.project(30, 2, 0)
assert.equal(nearestSpline.id, 'uneven', 'project picks the nearest registered spline')
approx(nearestSpline.distance, 2, 'nearest spline distance', 0.02)
approx(nearestSpline.t, 0.5, 'nearest spline t', 0.02)
arrEq(nearestSpline.point, [30, 0, 0], 'nearest spline point', 0.1)
arrEq(registry.sample(nearestSpline.id, nearestSpline.t).position, nearestSpline.point, 'sample(projection.t) matches projection.point on uneven', 0.2)

const closedReg = createSplineRegistry()
const square = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]]
const loopInfo = closedReg.add('loop', square, { closed: true })
assert.equal(loopInfo.closed, true)
assert.equal(loopInfo.segments, 4)
assert.ok(closedReg.length('loop') > 30, 'closed loop has positive length')
const loopStart = closedReg.sample('loop', 0)
const loopEnd = closedReg.sample('loop', 1)
checkFrame(loopStart, 'closed start')
checkFrame(loopEnd, 'closed end')
arrEq(loopStart.position, [0, 0, 0], 'closed sample(0) at first point', 0.01)
arrEq(loopEnd.position, [0, 0, 0], 'closed sample(1) wraps to first point', 0.01)
arrEq(loopStart.tangent, loopEnd.tangent, 'closed tangent is continuous across the seam', 0.01)
arrEq(closedReg.frameAt('loop', closedReg.length('loop')).position, [0, 0, 0], 'closed frameAt(length) wraps to first point', 0.01)
const loopHit = closedReg.project(10, 2, 5)
assert.equal(loopHit.id, 'loop')
assert.ok(loopHit.t >= 0 && loopHit.t <= 1, 'closed projection t in [0,1]')
approx(loopHit.distance, 2, 'closed projection distance', 0.6)
arrEq(closedReg.sample('loop', loopHit.t).position, loopHit.point, 'closed sample(projection.t) matches projection.point', 0.2)
assert.equal(closedReg.remove('loop'), true)
refuses(() => closedReg.get('loop'), 'spline-unknown-id')

const vertical = createSplineRegistry()
vertical.add('up', [[0, 0, 0], [0, 10, 0], [0, 20, 0]])
const upFrame = vertical.sample('up', 0.5)
checkFrame(upFrame, 'vertical tangent')
arrEq(upFrame.tangent, [0, 1, 0], 'vertical tangent +Y')

const zTangent = createSplineRegistry()
zTangent.add('zline', [[0, 0, 0], [0, 0, 10], [0, 0, 20]], { tangentAxis: 'z' })
const zFrame = zTangent.sample('zline', 0.5)
arrEq(zFrame.tangent, [0, 0, 1], 'z-axis tangent +Z')
arrEq(zFrame.rotation, [0, 0, 0, 1], 'z-axis tangent rotation identity')
arrEq(rotate(zFrame.rotation, [0, 0, 1]), zFrame.tangent, 'z-axis rotation carries local +Z to tangent')
arrEq(rotate(zFrame.rotation, [1, 0, 0]), cross(zFrame.normal, zFrame.tangent), 'z-axis rotation carries local +X to -lateral')

const xOnZ = createSplineRegistry()
xOnZ.add('xline', [[0, 0, 0], [0, 0, 10], [0, 0, 20]])
const xFrame = xOnZ.sample('xline', 0.5)
arrEq(xFrame.rotation, [0, -Math.SQRT1_2, 0, Math.SQRT1_2], 'default tangentAxis rotates local +X onto +Z')
arrEq(rotate(xFrame.rotation, [1, 0, 0]), xFrame.tangent, 'default tangentAxis rotation carries local +X to tangent')

const r = createSplineRegistry()
refuses(() => r.add('', [[0, 0, 0], [1, 0, 0]]), 'spline-id-invalid')
refuses(() => r.add(7, [[0, 0, 0], [1, 0, 0]]), 'spline-id-invalid')
refuses(() => r.add('few', []), 'spline-too-few-points')
refuses(() => r.add('few', [[0, 0, 0]]), 'spline-too-few-points')
refuses(() => r.add('few', 'nope'), 'spline-too-few-points')
refuses(() => r.add('few', [[0, 0, 0], [1, 0, 0]], { closed: true }), 'spline-too-few-points')
refuses(() => r.add('nan', [[0, 0, 0], [NaN, 1, 2]]), 'spline-point-non-finite')
refuses(() => r.add('inf', [[0, 0, 0], [1, Infinity, 2]]), 'spline-point-non-finite')
refuses(() => r.add('big', [[0, 0, 0], [1e999, 0, 0]]), 'spline-point-non-finite')
refuses(() => r.add('obj', [[0, 0, 0], { x: 1, y: NaN, z: 2 }]), 'spline-point-non-finite')
refuses(() => r.add('shape', [[0, 0, 0], [1, 2]]), 'spline-point-invalid')
refuses(() => r.add('stringpoint', [[0, 0, 0], 'x']), 'spline-point-invalid')
refuses(() => r.add('opts', [[0, 0, 0], [1, 0, 0]], 5), 'spline-options-invalid')
refuses(() => r.add('opts', [[0, 0, 0], [1, 0, 0]], { closed: 'yes' }), 'spline-closed-invalid')
refuses(() => r.add('opts', [[0, 0, 0], [1, 0, 0]], { tangentAxis: 'y' }), 'spline-tangent-axis-invalid')
refuses(() => r.add('opts', [[0, 0, 0], [1, 0, 0]], { samplesPerSegment: 0 }), 'spline-samples-invalid')
refuses(() => r.add('degenerate', [[1, 1, 1], [1, 1, 1]]), 'spline-degenerate')
refuses(() => r.get('missing'), 'spline-unknown-id')
refuses(() => r.sample('missing', 0.5), 'spline-unknown-id')
refuses(() => r.length('missing'), 'spline-unknown-id')
refuses(() => r.frameAt('missing', 1), 'spline-unknown-id')
refuses(() => r.remove('missing'), 'spline-unknown-id')
refuses(() => r.project(0, 0, 0), 'spline-no-splines')
const objectPoints = r.add('ok', [{ x: 0, y: 0, z: 0 }, { x: 10, y: 1, z: 0 }, { x: 20, y: 2, z: 0 }])
assert.equal(objectPoints.segments, 2)
approx(r.length('ok'), 20 * Math.hypot(1, 0.1), 'object points carry y', 0.2)
checkFrame(r.sample('ok', 0.5), 'object points frame')
refuses(() => r.sample('ok', NaN), 'spline-t-invalid')
refuses(() => r.sample('ok', Infinity), 'spline-t-invalid')
refuses(() => r.sample('ok', -0.1), 'spline-t-invalid')
refuses(() => r.sample('ok', 1.1), 'spline-t-invalid')
refuses(() => r.sample('ok', '0.5'), 'spline-t-invalid')
refuses(() => r.frameAt('ok', NaN), 'spline-distance-invalid')
refuses(() => r.frameAt('ok', -1), 'spline-distance-invalid')
refuses(() => r.frameAt('ok', r.length('ok') + 1), 'spline-distance-invalid')
refuses(() => r.project(NaN, 0, 0), 'spline-query-non-finite')
refuses(() => r.project(0, 'z', 0), 'spline-query-non-finite')
refuses(() => r.project(0, 0, Infinity), 'spline-query-non-finite')
assert.equal(r.remove('ok'), true)
refuses(() => r.get('ok'), 'spline-unknown-id')

console.log(`RESULT: PASS open+closed Catmull-Rom splines, arc-length framing, segment and multi-spline projection, rotation frames, ${refusals} coded refusals`)
