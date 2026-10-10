import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HONEST_MODULE = join(REPO, 'src', 'client', 'AudioMixer.js')
const OUT_DIR = join(REPO, '.gm', 'witness-out')
const WITNESS = 'AudioMixer-witness'
const ROW = 'witness-gap-AudioMixer'
const TICK_WAIT_MS = 450

const argv = process.argv.slice(2)
const caseArg = argv.find((a) => a.startsWith('--case='))
const caseLabel = (caseArg ? caseArg.slice('--case='.length) : 'honest').replace(/[^A-Za-z0-9_-]/g, '-')
const positional = argv.filter((a) => !a.startsWith('--'))
const modulePath = positional.length ? resolve(positional[0]) : HONEST_MODULE

const EXCLUDED = [
  ['X1', 'audiomixer-positional-onset-unattenuated-spoint-orch-b186-adv-audio-1238', 'a positional play on a paused element starts at its prior volume until the first 200 ms tick: src/client/AudioMixer.js:158 returns before el.play() at :168'],
  ['X2', 'audiomixer-mixer-change-drops-per-call-volume-spoint-orch-b186-adv-audio-1238', 'a mixer or handle setVolume resets playing non-positional elements to base times level, dropping the play volume option: src/client/AudioMixer.js:188'],
  ['X3', 'audiomixer-nonclient-handle-missing-dispose-spoint-orch-b186-adv-audio-1238', 'the handle returned when Audio is absent omits dispose and setPosition: src/client/AudioMixer.js:136-140'],
]

const results = []
const record = (id, what, expected, observed) => {
  const ok = JSON.stringify(expected) === JSON.stringify(observed)
  results.push({ id, what, ok, expected, observed })
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const settle = async (predicate, budgetMs = 3000) => {
  const deadline = Date.now() + budgetMs
  while (!predicate() && Date.now() < deadline) {
    await sleep(25)
  }
}
const scenario = async (id, fn) => {
  try {
    await fn()
  } catch (e) {
    record(id, 'scenario completes without throwing', 'no throw', 'threw: ' + (e && e.message))
  }
}
const activeTimers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length
const captureWarnings = (fn) => {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    fn()
  } finally {
    console.warn = original
  }
  return warnings
}

class FakeAudioElement {
  static instances = []
  constructor(src) {
    this.src = src
    this.paused = true
    this.ended = false
    this.currentTime = 0
    this.volume = 1
    this.loop = false
    this.preload = ''
    this.loadCalls = 0
    this.playCalls = 0
    FakeAudioElement.instances.push(this)
  }
  play() {
    this.playCalls += 1
    this.paused = false
    this.ended = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  load() {
    this.loadCalls += 1
  }
}
const elementFor = (src) => FakeAudioElement.instances.filter((el) => el.src === src).at(-1)

const listener = { position: { x: 0, y: 0, z: 0 } }
globalThis.window = { __camera: listener }
globalThis.Audio = FakeAudioElement

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
    'claims=stubbed Audio element state and window.__camera only; no audible output, no browser, no GPU',
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
  const found = existsSync(modulePath)
  record('M0', 'module path exists', true, found)
  if (!found) return report()
  let mod
  try {
    mod = await import(pathToFileURL(modulePath).href)
  } catch (e) {
    record('M1', 'module imports cleanly', 'imports', 'threw: ' + (e && e.message))
    return report()
  }
  const mixer = mod.AudioMixer
  const defineAudio = mod.defineAudio
  record('M1', 'module exports defineAudio as a function', 'function', typeof defineAudio)
  record('M2', 'module exports AudioMixer with setVolume and getVolume functions', ['function', 'function'], [typeof (mixer && mixer.setVolume), typeof (mixer && mixer.getVolume)])
  if (typeof defineAudio !== 'function' || !mixer) return report()

  await scenario('A', () => {
    record('A1', 'default mixer levels are 1', [1, 1, 1], [mixer.getVolume('master'), mixer.getVolume('sfx'), mixer.getVolume('music')])
    mixer.setVolume('sfx', 0.4)
    record('A2', 'setVolume stores an in-range level', 0.4, mixer.getVolume('sfx'))
    mixer.setVolume('sfx', 2.5)
    record('A3', 'a level above 1 clamps to 1', 1, mixer.getVolume('sfx'))
    mixer.setVolume('sfx', -3)
    record('A4', 'a level below 0 clamps to 0', 0, mixer.getVolume('sfx'))
    mixer.setVolume('sfx', 0.6)
    mixer.setVolume('sfx', 'loud')
    record('A5', 'a non-number level keeps the previous level', 0.6, mixer.getVolume('sfx'))
    mixer.setVolume('sfx', Number.NaN)
    record('A5', 'a NaN level keeps the previous level', 0.6, mixer.getVolume('sfx'))
    const warnings = captureWarnings(() => mixer.setVolume('ambient', 0.2))
    record('A6', 'an unknown category warns once with its name', ["[audio] setMixerVolume: unknown category 'ambient'"], warnings)
    record('A7', 'an unknown category reads back as 1 and changes no level', [1, 0.6], [mixer.getVolume('ambient'), mixer.getVolume('sfx')])
    mixer.setVolume('sfx', 1)
  })

  await scenario('B', () => {
    const sfx = defineAudio({ category: 'sfx', base: '/audio/', tracks: { shot: 'shot.ogg', loop: 'loop.ogg' }, volume: 0.8 })
    record('B1', 'has reports declared tracks and nothing else', [true, false], [sfx.has('shot'), sfx.has('nope')])
    sfx.preload('shot')
    const shot = elementFor('/audio/shot.ogg')
    record('B2', 'preload creates the element with auto preloading and loads it paused', ['/audio/shot.ogg', 'auto', 1, true], [shot && shot.src, shot && shot.preload, shot && shot.loadCalls, shot && shot.paused])
    const returned = sfx.play('shot')
    record('B3', 'play returns the element and starts it', [true, false, 1], [returned === shot, shot.paused, shot.playCalls])
    record('B3', 'play sets base volume times category level', 0.8, shot.volume)
    record('B4', 'isPlaying is true while the element plays', true, sfx.isPlaying('shot'))
    sfx.play('loop', { loop: true })
    record('B5', 'play sets loop from its option', true, elementFor('/audio/loop.ogg').loop)
    sfx.play('shot')
    record('B5', 'a play without loop clears the flag', false, shot.loop)
    shot.currentTime = 1.5
    const playsBefore = shot.playCalls
    sfx.play('shot')
    record('B6', 'a play on a playing element without restart leaves it running', [1.5, playsBefore], [shot.currentTime, shot.playCalls])
    sfx.play('shot', { restart: true })
    record('B6', 'restart rewinds the element and plays it again', [0, playsBefore + 1], [shot.currentTime, shot.playCalls])
    sfx.stop('shot')
    record('B7', 'stop pauses and rewinds', [true, 0, false], [shot.paused, shot.currentTime, sfx.isPlaying('shot')])
    sfx.play('shot', { volume: 0.5 })
    record('B7', 'the play volume multiplies the base volume', 0.4, shot.volume)
    record('B8', 'before stopAll both sounds play', [true, true], [sfx.isPlaying('shot'), sfx.isPlaying('loop')])
    sfx.stopAll()
    record('B8', 'stopAll pauses every element', [false, false], [sfx.isPlaying('shot'), sfx.isPlaying('loop')])
    sfx.setVolume(0.5)
    record('B9', 'handle setVolume rescales every element', 0.5, shot.volume)
    mixer.setVolume('sfx', 0.5)
    record('B10', 'the sfx mixer level multiplies into the element volume', 0.25, shot.volume)
    mixer.setVolume('sfx', 1)
    mixer.setVolume('master', 0.5)
    record('B11', 'the master level multiplies into sfx elements', 0.25, shot.volume)
    mixer.setVolume('master', 1)
    const ping = defineAudio({ base: '/audio/', tracks: { ping: 'ping.ogg' }, volume: 1 })
    ping.play('ping')
    mixer.setVolume('sfx', 0.1)
    record('B12', 'a master-category handle ignores the sfx level', 1, elementFor('/audio/ping.ogg').volume)
    mixer.setVolume('sfx', 1)
    const doomed = defineAudio({ base: '/audio/', tracks: { hum: 'doomed.ogg' }, volume: 0.9 })
    doomed.play('hum')
    const doomedEl = elementFor('/audio/doomed.ogg')
    doomed.dispose()
    mixer.setVolume('master', 0.3)
    record('B13', 'dispose pauses the element and detaches it from mixer changes', [true, false, 0.9], [doomedEl.paused, doomed.isPlaying('hum'), doomedEl.volume])
    mixer.setVolume('master', 1)
    const malformed = defineAudio({ base: '/audio/', tracks: { v: 'v.ogg', broken: 5 }, volume: 'loud' })
    malformed.play('v')
    record('B14', 'a non-numeric spec volume falls back to 1', 1, elementFor('/audio/v.ogg').volume)
    record('B14', 'a non-string track yields no element', null, malformed.play('broken'))
    sfx.dispose()
    ping.dispose()
    malformed.dispose()
  })

  await scenario('C', async () => {
    const world = defineAudio({ category: 'sfx', base: '/audio/', tracks: { hum: 'hum.ogg' }, volume: 1 })
    world.play('hum', { position: [10, 0, 0] })
    const hum = elementFor('/audio/hum.ogg')
    await settle(() => hum.volume === 0.75)
    record('C1', 'positional gain falls off linearly with distance from __camera (10 of 40 m)', 0.75, hum.volume)
    listener.position.x = 30
    await settle(() => hum.volume === 0.5)
    record('C2', 'moving the listener updates the gain on the next tick (20 of 40 m)', 0.5, hum.volume)
    world.setPosition('hum', [60, 0, 0])
    await settle(() => hum.volume === 0.25)
    record('C3', 'setPosition moves the emitter for the next tick (30 of 40 m)', 0.25, hum.volume)
    world.setPosition('hum', [Number.NaN, 0, 0])
    world.setPosition('hum', [1, 2])
    await sleep(TICK_WAIT_MS)
    record('C4', 'a malformed position leaves the emitter where it was', 0.25, hum.volume)
    world.setPosition('hum', [100, 0, 0])
    await settle(() => hum.volume === 0)
    record('C5', 'an emitter beyond audibleRange is silent', 0, hum.volume)
    window.__camera = null
    await settle(() => hum.volume === 1)
    record('C6', 'with no camera the positional voice is not attenuated', 1, hum.volume)
    window.__camera = listener
    listener.position.x = 0

    const emitter = defineAudio({ base: '/audio/', tracks: { beep: 'beep.ogg' } })
    const beforeTimers = activeTimers()
    emitter.play('beep', { position: [1, 0, 0] })
    const duringTimers = activeTimers()
    emitter.stop('beep')
    const afterStopTimers = activeTimers()
    record('C7', 'a positional play owns one interval until stop', [beforeTimers + 1, beforeTimers], [duringTimers, afterStopTimers])
    emitter.play('beep', { position: [1, 0, 0] })
    const beforeDispose = activeTimers()
    emitter.dispose()
    record('C8', 'dispose clears the positional interval', beforeDispose - 1, activeTimers())

    const ranged = defineAudio({ base: '/audio/', tracks: { near: 'near.ogg' }, audibleRange: 20 })
    ranged.play('near', { position: [10, 0, 0] })
    const near = elementFor('/audio/near.ogg')
    await settle(() => near.volume === 0.5)
    record('C9', 'spec.audibleRange sets the falloff distance (10 of 20 m)', 0.5, near.volume)
    ranged.dispose()

    const defaultRange = defineAudio({ base: '/audio/', tracks: { far: 'far.ogg' }, audibleRange: -5 })
    defaultRange.play('far', { position: [10, 0, 0] })
    const far = elementFor('/audio/far.ogg')
    await settle(() => far.volume === 0.75)
    record('C10', 'a non-positive audibleRange falls back to 40 m (10 of 40 m)', 0.75, far.volume)
    defaultRange.dispose()
    world.dispose()
  })

  await scenario('D', () => {
    const bare = defineAudio()
    record('D1', 'defineAudio without a spec exposes the public handle surface', ['dispose', 'has', 'isPlaying', 'play', 'preload', 'setPosition', 'setVolume', 'stop', 'stopAll'], Object.keys(bare).filter((k) => !k.startsWith('_')).sort())
    record('D2', 'an empty handle reports no declared track and no playing sound', [false, false], [bare.has('anything'), bare.isPlaying('anything')])
    bare.dispose()
  })

  await scenario('E', async () => {
    const saved = { window: globalThis.window, Audio: globalThis.Audio }
    delete globalThis.window
    delete globalThis.Audio
    try {
      const headless = await import(pathToFileURL(modulePath).href + '?no-audio')
      const h = headless.defineAudio({ tracks: { x: 'x.ogg' } })
      record('E1', 'without Audio the handle plays nothing and reports its declared tracks', [null, true, false], [h.play('x'), h.has('x'), h.isPlaying('x')])
    } finally {
      globalThis.window = saved.window
      globalThis.Audio = saved.Audio
    }
  })

  return report()
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    console.log(`RESULT: FAIL -- witness crashed: ${e && e.message}`)
    process.exitCode = 1
  },
)
