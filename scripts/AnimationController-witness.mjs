// Node witness for src/animation/AnimationController.js (row witness-gap-AnimationController).
// Usage: node scripts/AnimationController-witness.mjs [modulePath] [--case=<label>]
// Drives the controller with a recording blender and with the real AnimationBlender over a
// fake mixer. Prints RESULT: PASS (exit 0) or RESULT: FAIL (exit 1). A mutant is checked by
// passing its path as modulePath. Output is create-only under .gm/witness-out/.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HONEST_MODULE = join(REPO, 'src', 'animation', 'AnimationController.js')
const BLEND_TREE = join(REPO, 'src', 'animation', 'BlendTree.js')
const OUT_DIR = join(REPO, '.gm', 'witness-out')
const WITNESS = 'AnimationController-witness'
const ROW = 'witness-gap-AnimationController'

const argv = process.argv.slice(2)
const caseArg = argv.find((a) => a.startsWith('--case='))
const caseLabel = (caseArg ? caseArg.slice('--case='.length) : 'honest').replace(/[^A-Za-z0-9_-]/g, '-')
const positional = argv.filter((a) => !a.startsWith('--'))
const modulePath = positional.length ? resolve(positional[0]) : HONEST_MODULE

// Defects confirmed live on the current tree and filed as PRD rows. They are reported,
// not asserted, so the honest tree passes; a fix moves its entry into a check.
const EXCLUDED = [
  ['X4', 'animation-controller-die-ignored-in-land', 'land has no DIE transition: setState("die") while landing is ignored'],
]

const results = []
const record = (id, what, expected, observed) => {
  const ok = JSON.stringify(expected) === JSON.stringify(observed)
  results.push({ id, what, ok, expected, observed })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const scenario = async (id, fn) => {
  try {
    await fn()
  } catch (e) {
    record(id, 'scenario completes without throwing', 'no throw', 'threw: ' + (e && e.message))
  }
}

function recordingBlender(clipDuration = 0.8) {
  const calls = []
  return {
    calls,
    playClip(name, fade) { calls.push(['playClip', name, fade]) },
    getClipDuration(name) { calls.push(['getClipDuration', name]); return clipDuration },
    updateBlend(dt) { calls.push(['updateBlend', dt]) },
    stop() { calls.push(['stop']) },
  }
}
const plays = (b) => b.calls.filter((c) => c[0] === 'playClip')
const lastPlay = (b) => plays(b).at(-1)

function fakeMixer() {
  return {
    timeScale: 1,
    lastDt: null,
    clipAction() {
      return { clampWhenFinished: false, reset() {}, fadeIn() {}, fadeOut() {}, play() {}, stop() {}, isRunning() { return true } }
    },
    update(dt) { this.lastDt = dt },
  }
}

function report() {
  const failed = results.filter((r) => !r.ok)
  const verdict = results.length > 0 && failed.length === 0 ? 'PASS' : 'FAIL'
  const resultLine = `RESULT: ${verdict} -- checks=${results.length} failed=${failed.length} excluded=${EXCLUDED.length}`
  const moduleSha = existsSync(modulePath) ? createHash('sha256').update(readFileSync(modulePath)).digest('hex') : 'none'
  const utc = new Date().toISOString()
  const stamp = utc.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const name = `${WITNESS}-${caseLabel}-${stamp}-${randomBytes(3).toString('hex')}.txt`
  const outRel = `.gm/witness-out/${name}`
  const body = [
    `witness=${WITNESS}`,
    `row=${ROW}`,
    `case=${caseLabel}`,
    `module=${modulePath}`,
    `module_sha256=${moduleSha}`,
    `node=${process.version}`,
    `utc=${utc}`,
    '--- checks',
    ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.id} ${r.what} | expected=${JSON.stringify(r.expected)} observed=${JSON.stringify(r.observed)}`),
    '--- excluded (defects on the current tree, reported not asserted)',
    ...EXCLUDED.map(([id, row, note]) => `EXCLUDED ${id} ${row}: ${note}`),
    '--- verdict',
    resultLine,
    '',
  ].join('\n')
  mkdirSync(OUT_DIR, { recursive: true })
  const fd = openSync(join(OUT_DIR, name), 'wx')
  try {
    writeSync(fd, body)
  } finally {
    closeSync(fd)
  }
  for (const r of failed) console.log(`FAIL ${r.id} ${r.what} | expected=${JSON.stringify(r.expected)} observed=${JSON.stringify(r.observed)}`)
  console.log(`out=${outRel}`)
  console.log(`module_sha256=${moduleSha}`)
  console.log(resultLine)
  return verdict === 'PASS' ? 0 : 1
}

async function main() {
  const created = []
  let createAnimationController = null
  const found = existsSync(modulePath)
  record('M0', 'module path exists', true, found)
  if (found) {
    try {
      const mod = await import(pathToFileURL(modulePath).href)
      createAnimationController = mod.createAnimationController
      record('M1', 'module exports createAnimationController as a function', 'function', typeof createAnimationController)
      record('M2', 'default export is the same factory', true, mod.default === createAnimationController)
    } catch (e) {
      record('M1', 'module imports cleanly', 'imports', 'threw: ' + (e && e.message))
    }
  }
  const make = (blender, options) => {
    const c = createAnimationController(blender, options)
    created.push(c)
    return c
  }

  await scenario('S1', () => {
    const b = recordingBlender()
    const c = make(b)
    record('S1', 'controller surface keys', ['blender', 'config', 'dispose', 'fsm', 'getState', 'onStateChange', 'setState', 'update'], Object.keys(c).sort())
    record('S1', 'initial state is idle', 'idle', c.getState())
    record('S1', 'idle entry plays Idle with 0.3 fade', ['playClip', 'Idle', 0.3], lastPlay(b))
  })
  await scenario('S2', () => {
    const c = make(recordingBlender())
    const expected = { idleClip: 'Idle', walkClip: 'WalkLoop', runClip: 'RunLoop', sprintClip: 'SprintLoop', jumpClip: 'JumpStart', landClip: 'Land', attackClip: 'Attack', dieClip: 'Die', walkSpeed: 1.5, runSpeed: 5, sprintSpeed: 10 }
    record('S2', 'default clip names and speed thresholds', expected, Object.fromEntries(Object.keys(expected).map((k) => [k, c.config[k]])))
  })
  await scenario('S3', () => {
    const b = recordingBlender()
    const c = make(b, { idleClip: 'IdleX', walkSpeed: 2 })
    record('S3', 'options override defaults and leave the rest', { idleClip: 'IdleX', walkSpeed: 2, runSpeed: 5 }, { idleClip: c.config.idleClip, walkSpeed: c.config.walkSpeed, runSpeed: c.config.runSpeed })
    record('S3', 'overridden idle clip plays on entry', ['playClip', 'IdleX', 0.3], lastPlay(b))
  })

  await scenario('L1', () => {
    const b = recordingBlender()
    const c = make(b)
    const steps = [[1.0, 'idle'], [3, 'walk'], [7, 'run'], [7, 'run'], [11, 'sprint'], [11, 'sprint'], [0, 'run'], [0, 'idle']]
    const seen = steps.map(([speed]) => { c.update(0.016, { speed }); return c.getState() })
    record('L1', 'speed ladder idle->walk->run->sprint and back', steps.map((s) => s[1]), seen)
    record('L1', 'each state entry plays its clip with its fade', [['playClip', 'Idle', 0.3], ['playClip', 'WalkLoop', 0.3], ['playClip', 'RunLoop', 0.3], ['playClip', 'SprintLoop', 0.2], ['playClip', 'RunLoop', 0.3], ['playClip', 'Idle', 0.3]], plays(b))
  })
  await scenario('L2', () => {
    const c = make(recordingBlender())
    c.update(0.016, { speed: 7 })
    record('L2', 'idle at speed 7 (above runSpeed) goes to run', 'run', c.getState())
  })
  await scenario('L3', () => {
    const c = make(recordingBlender())
    c.update(0.016, { speed: 3 })
    record('L3', 'idle at speed 3 goes to walk', 'walk', c.getState())
  })
  await scenario('L4', () => {
    const c = make(recordingBlender())
    c.update(0.016, { speed: 1.0 })
    record('L4', 'idle at speed 1.0 (below walkSpeed) stays idle', 'idle', c.getState())
  })
  await scenario('W1', () => {
    const c = make(recordingBlender())
    c.setState('walk')
    c.update(0.016, { speed: 0.05 })
    record('W1', 'walk at speed 0.05 goes to idle', 'idle', c.getState())
  })
  await scenario('W2', () => {
    const c = make(recordingBlender())
    c.setState('walk')
    c.update(0.016, { speed: 7 })
    record('W2', 'walk at speed 7 goes to run', 'run', c.getState())
  })
  await scenario('W3', () => {
    const c = make(recordingBlender())
    c.setState('walk')
    c.update(0.016, { speed: 3 })
    record('W3', 'walk at speed 3 stays walk', 'walk', c.getState())
  })

  await scenario('A1', () => {
    const b = recordingBlender()
    const c = make(b)
    c.update(0.016, { speed: 0, isGrounded: false })
    record('A1', 'idle while airborne goes to jump and plays JumpStart 0.1', ['jump', ['playClip', 'JumpStart', 0.1]], [c.getState(), lastPlay(b)])
  })
  await scenario('A2', () => {
    const b = recordingBlender()
    const c = make(b)
    c.setState('jump')
    c.update(0.016, { speed: 0, isGrounded: true, verticalVelocity: 5 })
    record('A2', 'jump while rising (verticalVelocity > 0) stays jump', 'jump', c.getState())
    c.update(0.016, { speed: 0, isGrounded: true, verticalVelocity: 0 })
    record('A3', 'grounded jump with verticalVelocity 0 goes to land and plays Land 0.15', ['land', ['playClip', 'Land', 0.15]], [c.getState(), lastPlay(b)])
  })
  await scenario('A4', async () => {
    const c = make(recordingBlender())
    c.setState('jump')
    c.update(0.016, { speed: 7, isGrounded: true, verticalVelocity: 0 })
    const landed = c.getState()
    const t0 = Date.now()
    let leftAt = null
    while (Date.now() - t0 < 1500) {
      c.update(0.016, { speed: 7, isGrounded: true, verticalVelocity: 0 })
      if (c.getState() !== 'land') {
        leftAt = Date.now() - t0
        break
      }
      await sleep(5)
    }
    record('A4', 'land at speed above runSpeed leaves for run', ['land', 'run'], [landed, c.getState()])
    record('A4', 'land exit comes from the 500 ms after timer (window 400..1500 ms)', true, leftAt !== null && leftAt >= 400 && leftAt <= 1500)
  })
  for (const name of ['idle', 'walk', 'run']) {
    await scenario(`A5.${name}`, () => {
      const c = make(recordingBlender())
      c.setState('jump')
      c.update(0.016, { speed: 0, isGrounded: true, verticalVelocity: 0 })
      c.setState(name)
      record(`A5.${name}`, `land accepts an explicit ${name} event`, name, c.getState())
    })
  }

  await scenario('K1', () => {
    const b = recordingBlender()
    const c = make(b)
    c.setState('attack')
    record('K1', 'attack entered from idle plays Attack 0.1', ['attack', ['playClip', 'Attack', 0.1]], [c.getState(), lastPlay(b)])
  })
  await scenario('K2', () => {
    const c = make(recordingBlender())
    c.setState('walk')
    c.setState('attack')
    record('K2', 'attack entered from walk', 'attack', c.getState())
  })
  await scenario('K3', () => {
    const c = make(recordingBlender())
    c.setState('attack')
    c.setState('die')
    record('K3', 'DIE from attack reaches die', 'die', c.getState())
  })

  await scenario('D1', () => {
    const b = recordingBlender()
    const c = make(b)
    c.setState('die')
    record('D1', 'DIE from idle reaches die and plays Die 0.3', ['die', ['playClip', 'Die', 0.3]], [c.getState(), lastPlay(b)])
    const before = plays(b).length
    c.update(0.016, { speed: 7 })
    record('D2', 'die is final: update keeps state die and plays nothing more', ['die', before], [c.getState(), plays(b).length])
  })

  await scenario('P1', () => {
    const c = make(recordingBlender())
    const returnsSelf = c.setState('nonsense') === c
    record('P1', 'setState returns the controller and ignores unknown names', [true, 'idle'], [returnsSelf, c.getState()])
  })
  await scenario('P2', () => {
    const c = make(recordingBlender())
    const seen = []
    const off = c.onStateChange((s) => seen.push(s))
    c.setState('walk')
    off()
    c.setState('idle')
    record('P2', 'onStateChange reports changes until unsubscribed', ['walk'], seen)
    record('P2', 'onStateChange returns an unsubscribe function', 'function', typeof off)
  })
  await scenario('P3', () => {
    const b = recordingBlender()
    const c = make(b)
    c.update(0.016, {})
    c.update(0.02, {})
    c.update(0.5, {})
    record('P3', 'update forwards each dt once to blender.updateBlend', [0.016, 0.02, 0.5], b.calls.filter((x) => x[0] === 'updateBlend').map((x) => x[1]))
  })
  await scenario('P4', () => {
    const c = make(recordingBlender())
    c.update(0.016, { speed: 4, isGrounded: false, verticalVelocity: -3 })
    const ctx = c.fsm.context
    record('P4', 'update copies speed, isGrounded and verticalVelocity into context', [4, false, -3], [ctx.speed, ctx.isGrounded, ctx.verticalVelocity])
  })
  await scenario('P5', () => {
    const c = make(recordingBlender())
    c.update(0.016, { direction: [1, 0, 0] })
    record('P5', 'array direction is copied into context.direction', [1, 0, 0], Array.from(c.fsm.context.direction))
  })
  await scenario('P6', () => {
    const b = recordingBlender()
    const c = make(b)
    c.dispose()
    c.setState('walk')
    record('P6', 'dispose stops the blender once and later setState is ignored', [[['stop']], 'idle'], [b.calls.filter((x) => x[0] === 'stop'), c.getState()])
  })

  await scenario('R1', async () => {
    const { AnimationBlender } = await import(pathToFileURL(BLEND_TREE).href)
    const mixer = fakeMixer()
    const clips = ['Idle', 'WalkLoop', 'RunLoop', 'SprintLoop', 'JumpStart', 'Fall', 'Land', 'Attack', 'Die'].map((name) => ({ name, duration: name === 'Attack' ? 0.8 : 1.0 }))
    const rb = new AnimationBlender(mixer, clips)
    const c = make(rb)
    c.setState('walk')
    const afterWalk = [c.getState(), rb.currentBlend]
    c.update(0.016, { speed: 7 })
    record('R1', 'controller drives the real AnimationBlender: walk then run', [['walk', 'WalkLoop'], ['run', 'RunLoop', 0.016]], [afterWalk, [c.getState(), rb.currentBlend, mixer.lastDt]])
  })

  await scenario('X1', async () => {
    const c = make(recordingBlender())
    c.setState('jump')
    c.update(0.016, { speed: 0, isGrounded: true, verticalVelocity: 0 })
    const landed = c.getState()
    const t0 = Date.now()
    while (Date.now() - t0 < 700 && c.getState() === 'land') {
      c.update(0.016, { speed: 0, isGrounded: true, verticalVelocity: 0 })
      await sleep(5)
    }
    record('X1', 'land at speed 0 reaches idle within 700 ms', ['land', 'idle'], [landed, c.getState()])
  })
  await scenario('X2', async () => {
    const c = make(recordingBlender())
    c.setState('attack')
    await sleep(1000)
    c.update(0.016, { speed: 0 })
    record('X2', 'attack at speed 0 ends in idle once the clip has elapsed', 'idle', c.getState())
  })
  await scenario('X3', async () => {
    const { AnimationBlender } = await import(pathToFileURL(BLEND_TREE).href)
    const clips = ['Idle', 'WalkLoop', 'RunLoop', 'SprintLoop', 'JumpStart', 'Fall', 'Land', 'Attack', 'Die'].map((name) => ({ name, duration: name === 'Attack' ? 0.8 : 1.0 }))
    const c = make(new AnimationBlender(fakeMixer(), clips))
    const t0 = Date.now()
    c.setState('attack')
    let exitedAt = null
    while (Date.now() - t0 < 3000) {
      c.update(0.016, { speed: 7 })
      if (c.getState() !== 'attack') {
        exitedAt = Date.now() - t0
        break
      }
      await sleep(5)
    }
    const timing = exitedAt === null ? 'still attack after 3000 ms' : exitedAt >= 800 ? 'ok' : `exit after ${exitedAt} ms`
    record('X3', 'attack at speed 7 exits no earlier than the 0.8 s clip after entry (real AnimationBlender)', 'ok', timing)
    record('X3', 'attack at speed 7 exits to run', 'run', c.getState())
  })

  for (const c of created) {
    try {
      c.dispose()
    } catch (_) {
      // already stopped
    }
  }
  return report()
}

main().then(
  (code) => { process.exitCode = code },
  (e) => { console.log('RESULT: FAIL -- witness crashed: ' + (e && e.message)); process.exitCode = 1 },
)
