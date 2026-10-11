import { createRequire as __gmCreateRequire } from 'node:module'

const require = __gmCreateRequire(process.cwd() + '/')

const { dirToLocalXZ, resolveTarget, latLonToDir } = await import('file:///C:/dev/spoint/src/shared/relocation.js')

const { createPlanetFrame } = await import('file:///C:/dev/spoint/src/terrain/PlanetFrame.js')

const { teleportPlayer } = await import('file:///C:/dev/spoint/src/sdk/Relocation.js')

const fails = []

let count = 0

const eq = (label, got, want) => {
  count++
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) fails.push(label + ': got ' + g + ' want ' + w)
}

const near = (label, got, want, tol) => {
  count++
  if (!(Math.abs(got - want) <= tol)) fails.push(label + ': got ' + got + ' want ' + want + ' tol ' + tol)
}

const throwsHas = (label, fn, needle) => {
  count++
  try { const r = fn(); fails.push(label + ': did not throw, got ' + JSON.stringify(r)) }
  catch (e) { const m = String((e && e.message) || e); if (m.indexOf(needle) < 0) fails.push(label + ': threw ' + JSON.stringify(m) + ' want ' + JSON.stringify(needle)) }
}

const ok = (label, cond, detail) => { count++; if (!cond) fails.push(label + ': ' + detail) }

const RADIUS = 6371000

const TRUE_HEIGHT_M = 4000

const frame = createPlanetFrame({ sampler: { radius: RADIUS, hashVersion: 1, heightAt: () => 0 } })

const heightAt = () => TRUE_HEIGHT_M

const dir = latLonToDir(80, 25)

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const de = dot(dir, frame.east), dn = dot(dir, frame.north)

const missM = (x, z) => {
  const p = frame.localToDir(x, z, TRUE_HEIGHT_M)
  return RADIUS * Math.hypot(p[0] - dir[0], p[1] - dir[1], p[2] - dir[2])
}

const seedPair = [RADIUS * de, RADIUS * dn]

const seedMissM = missM(seedPair[0], seedPair[1])

const refined = dirToLocalXZ(frame, dir, heightAt)

ok('refined-pair-returned', Array.isArray(refined) && refined.length === 2, 'got ' + JSON.stringify(refined))

const refinedMissM = missM(refined[0], refined[1])

const gapM = Math.hypot(refined[0] - seedPair[0], refined[1] - seedPair[1])

console.log('INFO anchor-elevation=0 true-height=' + TRUE_HEIGHT_M + ' dir-angle-from-anchor=' + (Math.acos(Math.min(1, dot(dir, frame.up))) * 180 / Math.PI).toFixed(2) + 'deg')

console.log('INFO unrefined-seed-pair=' + JSON.stringify(seedPair.map((v) => Math.round(v * 1000) / 1000)) + ' ray-miss=' + seedMissM.toFixed(1) + 'm')

console.log('INFO refined-pair=' + JSON.stringify(refined.map((v) => Math.round(v * 1000) / 1000)) + ' ray-miss=' + refinedMissM.toFixed(4) + 'm gap-from-seed=' + gapM.toFixed(1) + 'm')

ok('refined-ray-passes-through-dir', refinedMissM < 1, 'refined ray miss ' + refinedMissM + 'm')

ok('unrefined-seed-is-not-a-hit', seedMissM > 1000, 'unrefined seed ray miss ' + seedMissM + 'm')

ok('seed-vs-refined-gap-is-large', gapM > 1000, 'gap ' + gapM + 'm')

throwsHas('missing-heightAt-refused', () => dirToLocalXZ(frame, dir), 'heightAt')

throwsHas('null-heightAt-refused', () => dirToLocalXZ(frame, dir, null), 'heightAt')

throwsHas('non-function-heightAt-refused', () => dirToLocalXZ(frame, dir, 7), 'heightAt')

throwsHas('resolveTarget-latlon-without-heightAt-refused', () => resolveTarget({ lat: 80, lon: 25 }, { frame }), 'heightAt')

throwsHas('resolveTarget-dir-without-heightAt-refused', () => resolveTarget({ dir }, { frame }), 'heightAt')

throwsHas('zero-dir-still-refused-by-name', () => dirToLocalXZ(frame, [0, 0, 0], heightAt), 'must name a direction')

eq('beyond-frame-dir-still-null', dirToLocalXZ(frame, latLonToDir(2, 0), heightAt), null)

const viaLatLon = resolveTarget({ lat: 80, lon: 25 }, { frame, heightAt })

near('latlon-with-sampler-matches-dirToLocalXZ-x', viaLatLon.x, refined[0], 1e-9)

near('latlon-with-sampler-matches-dirToLocalXZ-z', viaLatLon.z, refined[1], 1e-9)

const viaDir = resolveTarget({ dir }, { frame, heightAt })

near('dir-with-sampler-matches-dirToLocalXZ-x', viaDir.x, refined[0], 1e-9)

near('dir-with-sampler-matches-dirToLocalXZ-z', viaDir.z, refined[1], 1e-9)

eq('x-z-spec-needs-no-sampler', resolveTarget({ x: 1, z: 2 }), { x: 1, y: null, z: 2, clearance: 2, snap: 'terrain', standNearY: null })

const FLOOR = 10

const raycast = (o, d, l) => (d[0] === 0 && d[2] === 0 && d[1] === -1 && FLOOR <= o[1] && o[1] - FLOOR <= l)
  ? { hit: true, position: [o[0], FLOOR, o[2]], normal: [0, 1, 0], distance: o[1] - FLOOR }
  : { hit: false }

const players = new Map()

const ctx = {
  physics: { raycast, _planetFrame: frame },
  physicsIntegration: { standingCentreY: (y) => y + 1, config: { capsuleRadius: 0 }, playerBodies: new Map(), setPlayerPosition: () => {} },
  playerManager: { getPlayer: (id) => players.get(id), clearInputs: () => {} },
  lagCompensator: { clearPlayerHistory: () => {} },
  appRuntime: { broadcastMessage: () => {}, _pendingTrimeshBuilds: new Set(), _pendingTrimeshEntities: new Map() },
  tickSystem: { currentTick: 77 },
}

const addPlayer = (id, position) => {
  const p = { state: { position: [...position], velocity: [0, 0, 0], onGround: false, swimming: false }, lastInput: null, teleportHold: null }
  players.set(id, p)
  return p
}

const p4 = addPlayer('p4', [0, 0, 0])

throwsHas('consumer-dir-spec-without-sampler-refused', () => teleportPlayer(ctx, 'p4', { dir }), 'heightAt')

eq('consumer-refusal-moves-nobody', p4.state.position, [0, 0, 0])

for (const f of fails) console.log('FAIL ' + f)

console.log('checks=' + count + ' failed=' + fails.length)

console.log(fails.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')

if (fails.length !== 0) process.exitCode = 1
