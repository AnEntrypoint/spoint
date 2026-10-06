import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const MAX_BUFFER = 16 * 1024 * 1024
const WITNESS_TIMEOUT_MS = 600000
const WITNESSES = [
  'fire-witness.mjs',
  'fire-peer-rollback-witness.mjs',
  'fire-weather-witness.mjs',
  'fire-combat-witness.mjs',
  'fire-kernel-cost-witness.mjs',
  'fire-tile-reclaim-witness.mjs',
]

function resultLineOf(stdout) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('RESULT:')) return trimmed
  }
  return null
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
  return { name, code, killed, ms: Date.now() - started, stdout, stderr, result: resultLineOf(stdout) }
}

async function main() {
  if (WITNESSES.length === 0) {
    console.error('fire-witness: no witness listed, so the gate proves nothing')
    process.exit(1)
  }
  const failures = []
  let totalMs = 0
  for (const name of WITNESSES) {
    const run = await runOne(name)
    totalMs += run.ms
    const ok = run.code === 0 && run.result !== null && run.result.startsWith('RESULT: PASS')
    console.log(`fire-witness: ${name} ${(run.ms / 1000).toFixed(1)} s, exit ${run.code}, ${run.result ?? 'no RESULT: line'}`)
    if (!ok) {
      if (run.code !== 0) failures.push(`${name} exited ${run.code}`)
      if (run.killed) failures.push(`${name} ran past the ${WITNESS_TIMEOUT_MS / 1000} s cap and was killed`)
      if (run.result === null) failures.push(`${name} printed no RESULT: line`)
      else if (!run.result.startsWith('RESULT: PASS')) failures.push(`${name} reported ${run.result}`)
      for (const line of run.stdout.split('\n')) if (line.trim()) console.log(`  out ${line}`)
      for (const line of run.stderr.split('\n')) if (line.trim()) console.log(`  err ${line}`)
    }
  }
  console.log(`fire-witness: ${WITNESSES.length} witness(es) ran in ${(totalMs / 1000).toFixed(1)} s`)
  if (failures.length > 0) {
    console.error(`fire-witness: ${failures.length} failure(s): ${failures.join('; ')}`)
    process.exit(1)
  }
}

main().catch((e) => { console.error('fire-witness: harness error:', e); process.exit(2) })
