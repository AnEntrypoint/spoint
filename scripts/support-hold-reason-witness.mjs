import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { AppRuntime } = await import('../src/apps/AppRuntime.js')
const { stepTeleportHold } = await import('../src/netcode/TeleportHold.js')
const { SPAWN_HOLD_REASON } = await import('../src/sdk/Relocation.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const P = [5, 0, 5]
const FIELD_NOT_LANDED = 'heightfield-collider-not-landed'
const RAY_MISSED = 'ray-missed-ground'
check('the support-hold reason names match the Relocation spawn-hold reasons', SPAWN_HOLD_REASON.HEIGHTFIELD_NOT_LANDED === FIELD_NOT_LANDED && SPAWN_HOLD_REASON.RAY_MISSED_GROUND === RAY_MISSED, `${SPAWN_HOLD_REASON.HEIGHTFIELD_NOT_LANDED}, ${SPAWN_HOLD_REASON.RAY_MISSED_GROUND}`)

const missing = () => ({ hit: false })
const floorAt = (y) => ({ hit: true, position: [0, y, 0], normal: [0, 1, 0] })

function holdThenRelease({ covered, raycast }) {
  const runtime = new AppRuntime()
  let calls = 0
  runtime._physics = {
    raycast: (origin, direction, length) => raycast(++calls, origin, direction, length),
    terrainHeightAt: () => 0,
    _terrainStreamer: { coversPosition: () => covered },
  }
  const player = { id: 'witness-player', state: { position: [...P], velocity: [0, 0, 0], onGround: false } }
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    runtime._holdPlayerOverUnloadedGround(player, P)
    const hold = player.teleportHold
    if (!hold) return { held: false, warnings }
    const probed = hold.probeGroundY()
    hold.deadline = Date.now() - 1
    stepTeleportHold(player, { physicsWorld: {} })
    return { held: true, probed, warnings }
  } finally {
    console.warn = warn
  }
}

const notLanded = holdThenRelease({ covered: false, raycast: () => missing() })
check('an uncovered hold is created and its probe still returns null', notLanded.held && notLanded.probed === null, JSON.stringify({ held: notLanded.held, probed: notLanded.probed }))
const notLandedRelease = notLanded.warnings.find((w) => w.includes('released player'))
check('the uncovered release names heightfield-collider-not-landed', notLandedRelease !== undefined && notLandedRelease.includes(FIELD_NOT_LANDED), notLandedRelease ? notLandedRelease.slice(0, 200) : 'no release line')

const missed = holdThenRelease({ covered: true, raycast: () => missing() })
check('a covered hold whose ray misses still returns null from its probe', missed.held && missed.probed === null, JSON.stringify({ held: missed.held, probed: missed.probed }))
const missedRelease = missed.warnings.find((w) => w.includes('released player'))
check('the missed-ray release names ray-missed-ground', missedRelease !== undefined && missedRelease.includes(RAY_MISSED), missedRelease ? missedRelease.slice(0, 200) : 'no release line')

const found = holdThenRelease({ covered: true, raycast: (n) => (n === 1 ? missing() : floorAt(-0.5)) })
check('a covered hold whose ray finds ground returns the height from its probe', found.held && found.probed === -0.5, JSON.stringify({ held: found.held, probed: found.probed }))
check('a release with ground logs no no-ground warning', found.warnings.every((w) => !w.includes('released player')), found.warnings.length)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS the support-hold probe still returns null for the two groundless outcomes, and each release names its reason')
  await exitAfterQuiesce(0)
}
