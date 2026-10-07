import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const MAX_BUFFER = 16 * 1024 * 1024
const WITNESS_TIMEOUT_MS = 300000
const ECHO_TAIL_LINES = 8
const WITNESSES = [
  'fire-weather-witness.mjs',
  'fire-combat-witness.mjs',
  'fire-wind-coupling-witness.mjs',
  'fire-smoke-los-witness.mjs',
  'fire-kernel-cost-witness.mjs',
  'fire-witness.mjs',
  'fire-tile-reclaim-witness.mjs',
  'fire-peer-rollback-witness.mjs',
  'fire-rain-coupling-witness.mjs',
  'fire-tps-game-witness.mjs',
]

const VERDICT_RE = /^RESULT:\s+(PASS|FAIL)(?![A-Za-z0-9_])/

function verdictOf(stdout) {
  let failing = null
  let passing = null
  for (const line of stdout.split('\n')) {
    const m = VERDICT_RE.exec(line.trim())
    if (m === null) continue
    if (m[1] === 'FAIL') { if (failing === null) failing = line.trim() }
    else if (passing === null) passing = line.trim()
  }
  if (failing !== null) return { verdict: 'FAIL', line: failing }
  if (passing !== null) return { verdict: 'PASS', line: passing }
  return { verdict: null, line: null }
}

function tailOf(text, count) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '')
  return lines.slice(Math.max(0, lines.length - count))
}

async function runOne(name) {
  const started = Date.now()
  let stdout = '', stderr = '', code = 0, killed = false
  try {
    const done = await execFileAsync(process.execPath, [join(SCRIPTS_DIR, name)], { maxBuffer: MAX_BUFFER, timeout: WITNESS_TIMEOUT_MS })
    stdout = done.stdout
    stderr = done.stderr
  } catch (e) {
    stdout = e.stdout ?? ''
    stderr = e.stderr ?? ''
    code = Number.isInteger(e.code) ? e.code : 1
    killed = e.killed === true
  }
  return { name, code, killed, ms: Date.now() - started, stdout, stderr, ...verdictOf(stdout) }
}

function echo(name, run) {
  for (const line of tailOf(run.stdout, ECHO_TAIL_LINES)) console.log(`  ${name} out ${line}`)
  for (const line of tailOf(run.stderr, ECHO_TAIL_LINES)) console.log(`  ${name} err ${line}`)
}

async function main() {
  if (WITNESSES.length === 0) {
    console.error('fire-witness: no witness listed, so the gate proves nothing')
    process.exit(1)
  }
  let totalMs = 0
  for (const name of WITNESSES) {
    const run = await runOne(name)
    totalMs += run.ms
    console.log(`fire-witness: ${name} ${(run.ms / 1000).toFixed(1)} s, exit ${run.code}, ${run.line ?? 'no RESULT: line'}`)
    echo(name, run)
    const failures = []
    if (run.code !== 0) failures.push(`${name} exited ${run.code}`)
    if (run.killed) failures.push(`${name} ran past the ${WITNESS_TIMEOUT_MS / 1000} s cap and was killed`)
    if (run.verdict === null) failures.push(`${name} printed no RESULT: line`)
    else if (run.verdict === 'FAIL') failures.push(`${name} reported ${run.line}`)
    if (failures.length > 0) {
      console.error(`fire-witness: ${failures.length} failure(s): ${failures.join('; ')}`)
      console.error(`fire-witness: stopped at the first failing witness after ${(totalMs / 1000).toFixed(1)} s of ${WITNESSES.length} witness(es)`)
      process.exit(1)
    }
  }
  console.log(`fire-witness: ${WITNESSES.length} witness(es) ran in ${(totalMs / 1000).toFixed(1)} s`)
}

main().catch((e) => { console.error('fire-witness: harness error:', e); process.exit(2) })
