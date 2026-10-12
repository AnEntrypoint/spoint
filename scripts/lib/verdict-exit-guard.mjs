// A witness that prints its verdict and then never exits is a silent lane stall: it has already
// emitted every line it will ever emit, so upstream sees a complete-looking run that never
// returns, and the lane waiting on it waits for hours behind a process doing 0% CPU.
//
// Measured 2026-10-12 on scripts/terrain-three-source-height-witness.mjs: three copies idle
// 39-72 min, 4.0-4.8 CPU-seconds each, ~0.1% CPU, each holding a pending timer it never cleared.
// The verdict was printed; nothing after it ever was. Nothing upstream can tell that apart from a
// run still in progress, because the distinguishing fact (the process has stopped doing work) only
// exists inside the process.
//
// This module makes that fact observable. Arm it before the verdict is printed; it watches the
// witness's own stdio, and once a `RESULT: PASS|FAIL` line has gone out it bounds how long the
// process may stay alive afterwards without producing another line. A witness still doing work
// keeps writing, so every write pushes the bound out; only real silence trips it. On trip it
// prints a `RESULT: FAIL` line naming the verdict it already printed and the resources still
// holding the loop, then exits non-zero -- so the class is red in scripts/check.mjs
// (whose noGpuVerdict() takes the first FAIL line) instead of invisible.
//
// Use:
//   import { armVerdictExitGuard } from 'scripts/lib/verdict-exit-guard.mjs'
//   armVerdictExitGuard({ label: 'my-witness' })   // anywhere before the verdict is printed
// or, with no edit at all: node scripts/run-witness.mjs scripts/my-witness.mjs
import { stopWitnessServers } from './witness-server.mjs'

export const VERDICT_RE = /^(?:\[[^\]]*\]\s*)?RESULT:\s+(PASS|FAIL)(?![A-Za-z0-9_])/
export const VERDICT_QUIET_MS_DEFAULT = 15000
export const HANG_EXIT_CODE = 1

const state = { armed: false, label: 'witness', quietMs: VERDICT_QUIET_MS_DEFAULT, totalMs: 0, verdict: null, fired: false, quietTimer: null, totalTimer: null }

export function activeResources() {
  let info = []
  try { info = process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : [] } catch (_) { info = [] }
  const kinds = new Map()
  for (const s of info) kinds.set(s, (kinds.get(s) || 0) + 1)
  return [...kinds.entries()].sort((a, b) => b[1] - a[1])
}

function clearTimers() {
  for (const k of ['quietTimer', 'totalTimer']) {
    if (state[k]) { clearTimeout(state[k]); state[k] = null }
  }
}

async function fail(why) {
  if (state.fired) return
  state.fired = true
  clearTimers()
  const kinds = activeResources().map(([k, n]) => `${n}x ${k}`).join(', ') || 'none'
  const printed = state.verdict === null ? 'no verdict' : `the verdict ${JSON.stringify(state.verdict)}`
  const line = `RESULT: FAIL ${state.label} printed ${printed} and then ${why}: ${kinds} still holding the event loop -- a witness that prints its verdict and then never exits stalls every lane waiting on it`
  try { process.stdout.write(`${line}\n`) } catch (_) { console.log(line) }
  try { await stopWitnessServers() } catch (_) {}
  process.exit(HANG_EXIT_CODE)
}

function observe(text) {
  if (state.fired) return
  for (const raw of String(text).split('\n')) {
    const m = VERDICT_RE.exec(raw.trim())
    if (m === null) continue
    if (state.verdict === null) state.verdict = raw.trim()
    armQuiet()
    return
  }
  if (state.verdict !== null) armQuiet()
}

function armQuiet() {
  if (state.fired) return
  if (state.quietTimer) state.quietTimer.refresh ? state.quietTimer.refresh() : (clearTimeout(state.quietTimer), state.quietTimer = null)
  if (!state.quietTimer) state.quietTimer = setTimeout(() => { fail(`went quiet for ${state.quietMs} ms without exiting`) }, state.quietMs)
  if (state.quietTimer.unref) state.quietTimer.unref()
}

function patch(stream) {
  if (!stream || typeof stream.write !== 'function' || stream.__verdictGuardPatched) return
  stream.__verdictGuardPatched = true
  const real = stream.write.bind(stream)
  stream.write = function (chunk, ...rest) {
    try {
      observe(typeof chunk === 'string' ? chunk : (chunk && chunk.toString ? chunk.toString('utf8') : ''))
    } catch (_) {}
    return real(chunk, ...rest)
  }
}

export function armVerdictExitGuard(opts = {}) {
  if (typeof opts.label === 'string' && opts.label) state.label = opts.label
  if (Number.isFinite(opts.quietMs) && opts.quietMs > 0) state.quietMs = opts.quietMs
  if (Number.isFinite(opts.totalMs) && opts.totalMs > 0) state.totalMs = opts.totalMs
  if (state.armed) return state
  state.armed = true
  patch(process.stdout)
  patch(process.stderr)
  if (state.totalMs > 0 && !state.totalTimer) {
    state.totalTimer = setTimeout(() => { fail(`ran ${state.totalMs} ms without exiting`) }, state.totalMs)
    if (state.totalTimer.unref) state.totalTimer.unref()
  }
  return state
}

export function verdictExitGuardState() { return { ...state } }
