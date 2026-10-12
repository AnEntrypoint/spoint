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
// Two bounds, armed together at the verdict:
//
//   quietMs    silence bound. Refreshed by every write, so a witness that is still working never
//              trips it. Tripping it is a FAILURE: the verdict was printed and then nothing
//              happened, which is the stall this module exists to catch.
//   hardExitMs hard exit bound. Armed ONCE at the verdict and never refreshed, so a leaked
//              handle -- a server nobody stopped, a socket nobody closed -- cannot keep the
//              process alive past it. Tripping it is not a failure: the witness already said
//              what it concluded, so this exits with the verdict's own code after stopping every
//              registered server, and prints a line saying it did.
//
// The hard bound is the one that makes the exit path unconditional: a witness that boots a server
// and forgets every shutdown call still leaves, because scripts/lib/witness-server.mjs arms this
// guard when it registers one (quietMs 0, so it does not fabricate a FAIL -- only the bound).
//
// Use:
//   import { armVerdictExitGuard } from 'scripts/lib/verdict-exit-guard.mjs'
//   armVerdictExitGuard({ label: 'my-witness' })   // anywhere before the verdict is printed
// or, with no edit at all: node scripts/run-witness.mjs scripts/my-witness.mjs
import { stopWitnessServers } from './witness-server.mjs'

export const VERDICT_RE = /^(?:\[[^\]]*\]\s*)?RESULT:\s+(PASS|FAIL)(?![A-Za-z0-9_])/
export const VERDICT_QUIET_MS_DEFAULT = 15000
export const HANG_EXIT_CODE = 1
// The drain half of the hard bound: scripts/lib/quiesce.mjs's own default. A verdict followed by
// a drain that takes longer than this has already failed to empty, so the bound is what ends it.
export const DRAIN_BOUND_MS = 10000

const state = {
  armed: false, label: 'witness', quietMs: VERDICT_QUIET_MS_DEFAULT, hardExitMs: null,
  totalMs: 0, verdict: null, fired: false,
  quietTimer: null, totalTimer: null, hardTimer: null,
}

export function activeResources() {
  let info = []
  try { info = process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : [] } catch (_) { info = [] }
  const kinds = new Map()
  for (const s of info) kinds.set(s, (kinds.get(s) || 0) + 1)
  return [...kinds.entries()].sort((a, b) => b[1] - a[1])
}

function clearTimers() {
  for (const k of ['quietTimer', 'totalTimer', 'hardTimer']) {
    if (state[k]) { clearTimeout(state[k]); state[k] = null }
  }
}

function verdictExitCode() {
  return /RESULT:\s+PASS/.test(String(state.verdict)) ? 0 : HANG_EXIT_CODE
}

function emit(line) {
  try { process.stdout.write(`${line}\n`) } catch (_) { console.log(line) }
}

async function fail(why) {
  if (state.fired) return
  state.fired = true
  clearTimers()
  const kinds = activeResources().map(([k, n]) => `${n}x ${k}`).join(', ') || 'none'
  const printed = state.verdict === null ? 'no verdict' : `the verdict ${JSON.stringify(state.verdict)}`
  const line = `RESULT: FAIL ${state.label} printed ${printed} and then ${why}: ${kinds} still holding the event loop -- a witness that prints its verdict and then never exits stalls every lane waiting on it`
  emit(line)
  try { await stopWitnessServers() } catch (_) {}
  process.exit(HANG_EXIT_CODE)
}

// Not a failure: the witness already reached a verdict, so it leaves with that verdict's own
// code. The only thing this reports is that the exit did not happen on its own.
async function hardExit(why) {
  if (state.fired) return
  state.fired = true
  clearTimers()
  const code = verdictExitCode()
  const kinds = activeResources().map(([k, n]) => `${n}x ${k}`).join(', ') || 'none'
  emit(`[verdict-exit-guard] ${state.label} ${why}: exiting ${code} with ${JSON.stringify(state.verdict)} after stopping every registered server -- ${kinds} were still holding the event loop, so this witness would never have exited on its own`)
  try { await stopWitnessServers() } catch (_) {}
  process.exit(code)
}

function hardBoundMs() {
  if (typeof state.hardExitMs === 'number') return state.hardExitMs
  return state.quietMs + DRAIN_BOUND_MS
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
  if (state.quietMs > 0) {
    if (state.quietTimer) state.quietTimer.refresh ? state.quietTimer.refresh() : (clearTimeout(state.quietTimer), state.quietTimer = null)
    if (!state.quietTimer) state.quietTimer = setTimeout(() => { fail(`went quiet for ${state.quietMs} ms without exiting`) }, state.quietMs)
    if (state.quietTimer.unref) state.quietTimer.unref()
  }
  armHard()
}

// Armed once, at the verdict, and deliberately NOT refreshed by later writes: a
// witness that keeps writing while holding a leaked handle is exactly the case
// the quiet bound cannot see and the hard bound must end.
function armHard() {
  if (state.fired) return
  if (state.verdict === null) return
  const ms = hardBoundMs()
  if (!(ms > 0)) return
  if (state.hardTimer) return
  state.hardTimer = setTimeout(() => { hardExit(`hit the ${ms} ms hard exit bound after its verdict`) }, ms)
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
  if (Number.isFinite(opts.quietMs) && opts.quietMs >= 0) state.quietMs = opts.quietMs
  if (typeof opts.hardExitMs === 'number') state.hardExitMs = opts.hardExitMs
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

// For a witness that legitimately keeps working after its verdict: disarms both
// post-verdict bounds. Call it only when the witness owns its own exit path.
export function releaseVerdictExitGuard() {
  state.quietMs = 0
  state.hardExitMs = 0
  clearTimers()
  return { ...state }
}

export function verdictExitGuardState() { return { ...state } }
