import { stopWitnessServers } from './witness-server.mjs'

export const VERDICT_RE = /^(?:\[[^\]]*\]\s*)?RESULT:\s+(PASS|FAIL)(?![A-Za-z0-9_])/
export const VERDICT_QUIET_MS_DEFAULT = 15000
export const HANG_EXIT_CODE = 1
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

export function releaseVerdictExitGuard() {
  state.quietMs = 0
  state.hardExitMs = 0
  clearTimers()
  return { ...state }
}

export function verdictExitGuardState() { return { ...state } }
