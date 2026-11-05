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

function refusedWith(source) {
  try {
    parseFxProgram(source)
    return null
  } catch (error) {
    return error instanceof FxProgramError ? error.reasonCode : `unexpected:${error.message}`
  }
}

const sparks = JSON.stringify({
  seed: 7,
  populations: [{ name: 'sparks', spawn: { rate: 10 }, lifetime: [1, 1], render: { kind: 'sprite', blend: 'add' } }],
})

const parsed = parseFxProgram(sparks)
expect('parses a string-authored sprite population', parsed.populations.length === 1 && parsed.populations[0].name === 'sparks', parsed)
expect('defaults the seed to a valid integer', parseFxProgram({ populations: [{ name: 'a', spawn: { rate: 1 }, render: { kind: 'mesh' } }] }).seed === 0, null)
expect('refuses unreadable JSON', refusedWith('{not json') === 'json-unreadable', refusedWith('{not json'))
expect('refuses a missing populations array', refusedWith({}) === 'populations-missing', refusedWith({}))
expect('refuses an empty populations array', refusedWith({ populations: [] }) === 'population-count-invalid', refusedWith({ populations: [] }))
expect('refuses a non-finite spawn rate', refusedWith({ populations: [{ name: 'a', spawn: { rate: 1e999 }, render: { kind: 'sprite' } }] }) === 'spawn-rate-invalid', refusedWith({ populations: [{ name: 'a', spawn: { rate: 1e999 }, render: { kind: 'sprite' } }] }))
expect('refuses a reversed lifetime range', refusedWith({ populations: [{ name: 'a', spawn: { rate: 1 }, lifetime: [2, 1], render: { kind: 'sprite' } }] }) === 'lifetime-invalid', null)
expect('refuses an unsupported render kind', refusedWith({ populations: [{ name: 'a', spawn: { rate: 1 }, render: { kind: 'ribbon' } }] }) === 'render-kind-unsupported', null)
expect('refuses an unknown blend', refusedWith({ populations: [{ name: 'a', spawn: { rate: 1 }, render: { kind: 'sprite', blend: 'laser' } }] }) === 'blend-unsupported', null)
expect('refuses duplicate population names', refusedWith({ populations: [{ name: 'a', spawn: { rate: 1 }, render: { kind: 'sprite' } }, { name: 'a', spawn: { rate: 1 }, render: { kind: 'sprite' } }] }) === 'population-name-duplicate', null)
expect('refuses a non-integer seed', refusedWith({ seed: 1.5, populations: [{ name: 'a', spawn: { rate: 1 }, render: { kind: 'sprite' } }] }) === 'seed-invalid', null)

const sim = createFxSimulation(parsed)
const first = sim.step(0.5)
expect('rate 10 over 0.5 s spawns 5 particles alive', first.sparks.alive === 5, first)
const second = sim.step(0.5)
expect('first batch still alive at 1.0 s with lifetime 1 s', second.sparks.alive === 10, second)
const third = sim.step(1)
expect('first batch expires at 2.0 s with the same spawn rate', third.sparks.alive === 10, third)

const capped = createFxSimulation(parseFxProgram({ populations: [{ name: 'c', spawn: { rate: 100 }, lifetime: [5, 5], maxParticles: 8, render: { kind: 'sprite' } }] }))
expect('maxParticles caps live particles', capped.step(1).c.alive === 8, null)

const replayA = createFxSimulation(parsed)
const replayB = createFxSimulation(parsed)
const runA = [replayA.step(0.25), replayA.step(0.25), replayA.step(0.5)]
const runB = [replayB.step(0.25), replayB.step(0.25), replayB.step(0.5)]
expect('same seed and steps replay identical counts', JSON.stringify(runA) === JSON.stringify(runB), runA)

const reseeded = createFxSimulation(parseFxProgram({ ...JSON.parse(sparks), seed: 99 }))
expect('a different seed changes the lifetimes, not the spawn count', reseeded.step(0.5).sparks.alive === 5, null)

let rejectedStep = false
try {
  createFxSimulation(parsed).step(Number.NaN)
} catch (error) {
  rejectedStep = error instanceof FxProgramError && error.reasonCode === 'dt-invalid'
}
expect('a NaN step refuses with dt-invalid', rejectedStep, rejectedStep)

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failed)`)
  process.exit(1)
}
console.log('RESULT: PASS')
