// Runs one witness under a verdict-exit bound, so "printed its verdict and then never exited"
// is a red result instead of an idle process.
//
// A witness run as `node scripts/foo.mjs` has no bound at all: scripts/check.mjs applies one
// (NO_GPU_WITNESS_TIMEOUT_MS / SLOW_WITNESS_TIMEOUT_MS) but only to witnesses it lists, and a lane
// running a witness directly gets nothing. This runner gives every witness the bound with no edit
// to the witness, from outside its process:
//
//   - once a `RESULT: PASS|FAIL` line has been seen, the child may not go quiet for longer than
//     --quiet-ms without exiting. Real work writes, so the bound is a silence bound, not a
//     lifetime bound: a witness still measuring never trips it.
//   - --total-ms (off by default, because legitimate witnesses run for minutes) bounds the whole
//     run including the part before any verdict.
//
// Usage: node scripts/run-witness.mjs [--quiet-ms=15000] [--total-ms=0] [--] scripts/foo.mjs [args...]
import { spawn } from 'node:child_process'
import { VERDICT_RE } from './lib/verdict-exit-guard.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3))
}
const quietMs = flag('quiet-ms', 15000)
const totalMs = flag('total-ms', 0)
const rest = argv.filter(a => !/^--(quiet-ms|total-ms)=/.test(a))
const target = rest.find(a => !a.startsWith('-'))
if (!target) {
  console.error('run-witness: no witness given -- usage: node scripts/run-witness.mjs [--quiet-ms=15000] [--total-ms=0] scripts/foo.mjs [args...]')
  process.exit(2)
}
const passthrough = rest.slice(rest.indexOf(target) + 1)

const started = Date.now()
const label = target.split(/[\\/]/).pop()
let verdict = null
let lastOutputAt = Date.now()
let finished = false

const child = spawn(process.execPath, [target, ...passthrough], { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true })

const watch = (stream, sink) => {
  stream.setEncoding('utf8')
  stream.on('data', text => {
    lastOutputAt = Date.now()
    sink.write(text)
    for (const line of text.split('\n')) {
      const m = VERDICT_RE.exec(line.trim())
      if (m !== null && verdict === null) verdict = line.trim()
    }
  })
}
watch(child.stdout, process.stdout)
watch(child.stderr, process.stderr)

function stop(why) {
  if (finished) return
  finished = true
  clearInterval(poll)
  try { child.kill('SIGTERM') } catch (_) {}
  const printed = verdict === null ? 'no verdict' : `the verdict ${JSON.stringify(verdict)}`
  const line = `RESULT: FAIL ${label} printed ${printed} and then ${why} -- a witness that prints its verdict and then never exits stalls every lane waiting on it`
  process.stdout.write(`${line}\n`)
  // Not unref'd: once the child is gone the loop may be empty, and an unref'd timer would let the
  // process fall out with the default code 0 instead of the failure this is reporting.
  setTimeout(() => process.exit(1), 250)
}

const poll = setInterval(() => {
  if (finished) return
  const now = Date.now()
  if (totalMs > 0 && now - started > totalMs) { stop(`ran ${((now - started) / 1000).toFixed(1)} s past the ${totalMs / 1000} s total bound`); return }
  if (verdict !== null && now - lastOutputAt > quietMs) stop(`went quiet for ${((now - lastOutputAt) / 1000).toFixed(1)} s without exiting`)
}, 200)

child.on('error', e => {
  if (finished) return
  finished = true
  clearInterval(poll)
  console.error(`run-witness: ${target} could not be spawned: ${e && e.message}`)
  process.exit(2)
})
child.on('close', (code, signal) => {
  if (finished) return
  finished = true
  clearInterval(poll)
  const ms = Date.now() - started
  console.log(`run-witness: ${label} exited ${code === null ? `on ${signal}` : code} after ${(ms / 1000).toFixed(1)} s`)
  process.exit(code === null ? 1 : code)
})
