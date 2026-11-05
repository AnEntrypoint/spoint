import { parseFxProgram, createFxSimulation, FxProgramError } from '../src/effects/fxProgram.js'

let failures = 0

function expect(label, condition, got) {
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label} got=${JSON.stringify(got)}`)
  }
}

function refusedWith(doc) {
  try {
    parseFxProgram(doc)
    return null
  } catch (error) {
    return error instanceof FxProgramError ? error.reasonCode : `unexpected:${error.message}`
  }
}

const population = (extra) => ({ name: 'p', spawn: { rate: 0 }, lifetime: [5, 5], render: { kind: 'sprite' }, ...extra })
const program = (pop) => ({ populations: [pop] })

expect('refuses a cone wider than 180 degrees', refusedWith(program(population({ velocity: { speed: [1, 2], coneDeg: 200 } }))) === 'velocity-invalid', null)
expect('refuses a reversed speed range', refusedWith(program(population({ velocity: { speed: [5, 1] } }))) === 'velocity-invalid', null)
expect('refuses a negative drag', refusedWith(program(population({ accelerate: { drag: -1 } }))) === 'accelerate-invalid', null)
expect('refuses a non-vector gravity', refusedWith(program(population({ accelerate: { gravity: [0, 'g', 0] } }))) === 'accelerate-invalid', null)
expect('refuses a fractional burst', refusedWith(program(population({ spawn: { rate: 0, burst: 2.5 } }))) === 'spawn-burst-invalid', null)

const burstSim = createFxSimulation(parseFxProgram(program(population({ spawn: { rate: 0, burst: 12 } }))))
expect('burst emits its count on the first step', burstSim.step(0.1).p.alive === 12, null)
expect('burst does not repeat on later steps', burstSim.step(0.1).p.alive === 12, null)

const expiring = createFxSimulation(parseFxProgram(program(population({ spawn: { rate: 0, burst: 4 }, lifetime: [1, 1] }))))
expiring.step(0.5)
expect('burst particles live through their lifetime', expiring.step(0.25).p.alive === 4, null)
expect('burst particles expire past their lifetime', expiring.step(1).p.alive === 0, null)

const coned = createFxSimulation(parseFxProgram(program(population({ spawn: { rate: 0, burst: 300 }, velocity: { speed: [4, 4], coneDeg: 30 } }))))
const conePlaced = coned.step(0.01).p.particles
const halfAngleCos = Math.cos((30 * Math.PI) / 180)
expect('cone keeps every velocity inside its half angle', conePlaced.every((q) => q.vel[1] >= 4 * halfAngleCos - 1e-9), null)
expect('cone velocities keep the requested speed', conePlaced.every((q) => Math.abs(Math.hypot(...q.vel) - 4) < 1e-9), null)
expect('cone spreads particles off the axis', conePlaced.some((q) => Math.hypot(q.vel[0], q.vel[2]) > 0.5), null)

const falling = createFxSimulation(parseFxProgram(program(population({ spawn: { rate: 0, burst: 1 }, accelerate: { gravity: [0, -10, 0] } }))))
falling.step(0.1)
const fallen = falling.step(0.1).p.particles[0]
expect('gravity accelerates the particle by g * dt per step', Math.abs(fallen.vel[1] + 1) < 1e-9, fallen)

const dragged = createFxSimulation(parseFxProgram(program(population({ spawn: { rate: 0, burst: 1 }, velocity: { speed: [10, 10] }, accelerate: { drag: 1 } }))))
dragged.step(0.1)
const slowed = dragged.step(0.1).p.particles[0]
expect('drag scales velocity by 1 - drag * dt', Math.abs(slowed.vel[1] - 9) < 1e-9, slowed)
expect('position integrates the damped velocity', Math.abs(slowed.pos[1] - 9 * 0.1) < 1e-9, slowed)

const rated = createFxSimulation(parseFxProgram(program(population({ spawn: { rate: 10, burst: 3 }, velocity: { speed: [1, 2], coneDeg: 45 }, lifetime: [9, 9] }))))
const ratedFirst = rated.step(0.5).p.alive
expect('burst and rate spawn together on one step', ratedFirst === 8, ratedFirst)

const capped = createFxSimulation(parseFxProgram(program(population({ spawn: { rate: 0, burst: 50 }, maxParticles: 10 }))))
expect('maxParticles caps a burst', capped.step(0.1).p.alive === 10, null)

const replayA = createFxSimulation(parseFxProgram(program(population({ spawn: { rate: 5, burst: 6 }, velocity: { speed: [1, 3], coneDeg: 60 }, accelerate: { gravity: [0, -9.8, 0], drag: 0.3 } }))))
const replayB = createFxSimulation(parseFxProgram(program(population({ spawn: { rate: 5, burst: 6 }, velocity: { speed: [1, 3], coneDeg: 60 }, accelerate: { gravity: [0, -9.8, 0], drag: 0.3 } }))))
const runA = [replayA.step(0.2), replayA.step(0.2), replayA.step(0.3)]
const runB = [replayB.step(0.2), replayB.step(0.2), replayB.step(0.3)]
expect('same program replays identical particle state', JSON.stringify(runA) === JSON.stringify(runB), null)

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failed)`)
  process.exit(1)
}
console.log('RESULT: PASS')
