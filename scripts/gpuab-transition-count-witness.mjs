#!/usr/bin/env node
// Counts how many times `?gpuab=<name>` flips its global during one run, by executing the REAL
// GPU_PASS_ARM_SRC emitted by scripts/perf-run.mjs against a virtual clock and a stub renderer.
//
// The A/B writes a raw page global (`window[abName] = on|off`) on a timer. RenderControls reads
// `window['__' + key]`, so a resolution-class name (__vdrs, __dprAuto, __threeVdrs,
// __halfResWater, __bloomResolutionScale) makes the render resolution alternate between exactly two
// values for the whole run, reallocating the drawing buffer and every render target sized from it
// on every flip. This witness counts those flips -- it reports no GPU timing of any kind.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PERF_RUN = resolve(HERE, 'perf-run.mjs')

const LABEL = 'gpuab-transitions'
const fail = (m) => { console.error(`[${LABEL}] RESULT: FAIL -- ${m}`); process.exit(1) }

function flag(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const AB_NAME = flag('ab', '__vdrs')
const AB_MS = Number(flag('abms', '3000'))
const RUN_MS = Number(flag('run', '60000'))

const src = readFileSync(PERF_RUN, 'utf8')
const openAt = src.indexOf('const GPU_PASS_ARM_SRC = `')
if (openAt < 0) fail('GPU_PASS_ARM_SRC is not declared in scripts/perf-run.mjs')
const bodyStart = openAt + 'const GPU_PASS_ARM_SRC = `'.length
let end = -1
for (let i = bodyStart; i < src.length; i++) {
  if (src[i] === '`' && src[i - 1] !== '\\') { end = i; break }
}
if (end < 0) fail('GPU_PASS_ARM_SRC never closes')
// The arm lives in an untagged template literal, so the file's raw slice still carries its
// backslash escapes (\\d+ in the file is \d+ in the emitted page source). Unescaping is what node
// does when it evaluates the literal; without it ?gpuabms= never matches and abPhaseMs pins at 5000.
const ARM_SRC = src.slice(bodyStart, end).replace(/\\\\/g, '\\')
if (!ARM_SRC.includes('gpuab')) fail('extracted arm source carries no gpuab reader -- the extraction is wrong')
if (process.argv.includes('--dump-arm')) console.log('ARM@' + JSON.stringify(ARM_SRC.slice(ARM_SRC.indexOf('abPhaseMs') - 5, ARM_SRC.indexOf('abPhaseMs') + 80)))

// --- sandbox ---------------------------------------------------------------------------------
let now = 0
const timers = []
let seq = 0
function setInterval(fn, ms) { const id = ++seq; timers.push({ id, fn, ms, next: now + ms }); return id }
function clearInterval(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) }

const transitions = []
const writes = []
const target = window_proxy()
function window_proxy() {
  const backing = {}
  return new Proxy(backing, {
    get(t, k) { return t[k] },
    set(t, k, v) {
      const before = t[k]
      t[k] = v
      if (k === AB_NAME) {
        writes.push({ t: now, from: before, to: v })
        if (before !== v) transitions.push({ t: now, from: before, to: v })
      }
      return true
    },
    has(t, k) { return k in t },
  })
}

const renderer = {
  backend: {
    device: { features: new Set() },
    trackTimestamp: true,
    updateTimeStampUID() {},
  },
  resolveTimestampsAsync: async () => {},
  domElement: { width: 1280, height: 720 },
}
const W = window_proxy()
W.__app = { renderer }
const BLOCKS = flag('blocks', null)
const location = { search: `?singleplayer&gpuab=${AB_NAME}&gpuabms=${AB_MS}&gputime=1${BLOCKS ? `&gpuabblocks=${BLOCKS}` : ''}` }
const virtualDate = { now: () => now }
const virtualPerf = { now: () => now }
const quiet = { log() {}, error() {}, warn() {} }

let installed = false
try {
  const fn = new Function('window', 'location', 'setInterval', 'clearInterval', 'Date', 'performance', 'console', 'return (' + ARM_SRC + ')')
  const out = fn(W, location, setInterval, clearInterval, virtualDate, virtualPerf, quiet)
  installed = !!(out && out.ok === true)
} catch (e) {
  fail('the emitted arm source threw against the stub renderer: ' + (e && e.message || e))
}
if (!installed) fail('the emitted arm source did not return {ok:true} -- the A/B never armed, so any count would read as zero')

// --- drive the clock --------------------------------------------------------------------------
const STEP = 50
for (let t = STEP; t <= RUN_MS; t += STEP) {
  now = t
  for (const timer of [...timers]) {
    while (timer.next <= now) {
      timer.next += timer.ms
      timer.fn()
      if (!timers.includes(timer)) break
    }
  }
}

// Asserted behaviourally, not textually: if ?gpuabms= is not honoured the phase pins at 5000 ms.
const gaps = transitions.slice(1).map((x, i) => x.t - transitions[i].t)
const firstGap = gaps.length ? gaps[0] : null
console.log(`[${LABEL}] phase length observed from the flip gaps=${JSON.stringify(gaps.slice(0, 6))} (asked for abms=${AB_MS})`)
// The arm-time stamp (undefined -> false) is not a state change: the knob reads falsy either way.
// What costs a reallocation is every switch after it.
const postArm = transitions.filter((x) => x.t > 0)
const flips = transitions.length
const switchCount = postArm.length
const states = [...new Set(transitions.map((x) => String(x.to)))]
console.log(`[${LABEL}] ab=${AB_NAME} abms=${AB_MS} runMs=${RUN_MS}`)
console.log(`[${LABEL}] writes to ${AB_NAME}=${writes.length}  value-CHANGING transitions=${flips}  post-arm switches=${switchCount}`)
console.log(`[${LABEL}] distinct states=${JSON.stringify(states)}`)
for (const x of transitions.slice(0, 20)) console.log(`[${LABEL}]   @${x.t}ms ${String(x.from)} -> ${String(x.to)}`)
if (transitions.length > 20) console.log(`[${LABEL}]   ... ${transitions.length - 20} more`)

const checks = []
const expect = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.error(`[${LABEL}] FAIL ${name} -- ${detail}`) }
expect('emitted arm source carries the ?gpuab= reader', ARM_SRC.includes('gpuab'), 'gpuab absent')
expect('A/B armed against the stub renderer', installed === true, `installed=${installed}`)
expect(`the A/B wrote ${AB_NAME} at least once`, writes.length > 0, `writes=${writes.length}`)
expect(`?gpuabms=${AB_MS} is honoured (not pinned at the 5000 default)`, firstGap === AB_MS, `firstGap=${firstGap}`)
const WANT_BLOCKS = BLOCKS ? Math.max(1, Number(BLOCKS)) : 2
expect('at most ONE state switch per run', switchCount <= WANT_BLOCKS - 1, `post-arm switches=${switchCount} over ${RUN_MS}ms at abms=${AB_MS} blocks=${WANT_BLOCKS}`)
expect('both A/B states were visited', states.length === 2, `states=${JSON.stringify(states)}`)
const failing = checks.filter((c) => !c.ok)
console.log(`[${LABEL}] ${checks.length} check(s), ${failing.length} failing.`)
if (failing.length) { console.error(`[${LABEL}] RESULT: FAIL -- ${failing.map((f) => f.name).join('; ')}`); process.exit(1) }
console.log(`[${LABEL}] RESULT: PASS transitions=${flips} over ${RUN_MS}ms (abms=${AB_MS})`)
