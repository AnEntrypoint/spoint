import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = resolve(SDK_ROOT, 'scripts', 'netcode-conditioner-harness.mjs')
const RUNTIME_URL = pathToFileURL(resolve(SDK_ROOT, 'scripts', 'lib', 'virtual-runtime.mjs')).href
const DURATION_MS = 4000

const runHarness = (seed, outPath) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(process.execPath, [
    '--import', RUNTIME_URL,
    HARNESS,
    '--cond=120/40/6',
    '--predict=on',
    '--world=peers',
    `--duration=${DURATION_MS}`,
    `--out=${outPath}`
  ], { env: { ...process.env, SPOINT_VIRTUAL_SEED: String(seed) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  child.on('close', async code => {
    if (code !== 0) { rejectRun(new Error(`harness seed ${seed} exited ${code}: ${stderr.trim()}`)); return }
    resolveRun(await readFile(outPath, 'utf8'))
  })
})

const firstDifference = (a, b, path = '$') => {
  if (a === b) return null
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const found = firstDifference(a[key], b[key], `${path}.${key}`)
    if (found) return found
  }
  return `${path}: differs in order or content`
}

const dir = await mkdtemp(join(tmpdir(), 'netcode-virtual-'))
const first = await runHarness(0, join(dir, 'seed0-a.json'))
const second = await runHarness(0, join(dir, 'seed0-b.json'))
const other = await runHarness(1, join(dir, 'seed1.json'))

const sameBytes = first === second
const seedChangesRun = first !== other
const diffPath = sameBytes ? null : firstDifference(JSON.parse(first), JSON.parse(second))
const failures = []
if (!sameBytes) failures.push(`two runs at seed 0 differ: ${diffPath}`)
if (!seedChangesRun) failures.push('seed 1 gave the same output as seed 0, so the seed does not reach the run')

console.log(`determinism: seed 0 run A and run B bytes ${sameBytes ? 'identical' : 'differ'} (${first.length} and ${second.length} bytes); seed 1 ${seedChangesRun ? 'differs from seed 0' : 'matches seed 0'}`)
if (failures.length) {
  console.log(`RESULT: FAIL ${failures.join('; ')}`)
  process.exitCode = 1
} else {
  console.log(`RESULT: PASS the 120/40/6 peers harness gives byte-identical output for the same seed across two runs, and seed 1 changes it (${DURATION_MS} ms virtual)`)
}
