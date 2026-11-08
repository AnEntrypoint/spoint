import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { numericFlag, parseArgs, strArg } from './lib/witness-args.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = resolve(SDK_ROOT, 'scripts', 'netcode-conditioner-harness.mjs')
const HOOK_URL = pathToFileURL(resolve(SDK_ROOT, 'scripts', 'lib', 'groundy-replay-hook.mjs')).href
const GROWTH_LIMIT_M = 0.01
const MIN_RUNS = 15
const INJECT_DEFAULT_M = 0.03

const args = parseArgs(process.argv.slice(2))
const CONTROL = args.control === true || args.control === 'true'
const RUNS = numericFlag(args, 'runs', CONTROL ? 1 : MIN_RUNS)
const COND = strArg(args.cond, '50/10/2')
const WORLD = strArg(args.world, 'arena')
const DURATION_MS = numericFlag(args, 'duration', 20000)
const INJECT_M = CONTROL ? numericFlag(args, 'inject', INJECT_DEFAULT_M) : 0

const runChild = (env, outPath) => new Promise(resolveRun => {
  const child = spawn(process.execPath, [
    '--import', HOOK_URL,
    HARNESS,
    `--cond=${COND}`,
    '--predict=on',
    `--world=${WORLD}`,
    `--duration=${DURATION_MS}`,
    `--out=${outPath}`
  ], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  child.on('close', code => resolveRun({ code, stderr }))
})

const summarizeRun = (records, popsPerMin) => {
  const growths = records.map(r => r.growthM)
  const gaps = records
    .filter(r => r.serverGroundY !== null && r.predictedGroundY !== null)
    .map(r => Math.abs(r.serverGroundY - r.predictedGroundY))
  return {
    replays: records.length,
    overLimit: records.filter(r => r.growthM > GROWTH_LIMIT_M).length,
    maxGrowthM: growths.length ? Math.max(...growths) : null,
    maxGroundYGapM: gaps.length ? Math.max(...gaps) : null,
    popsPerMin
  }
}

const fmtM = v => (v === null ? '-' : v.toFixed(4))

const main = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'groundy-replay-'))
  const runs = []
  const failures = []
  for (let i = 0; i < RUNS; i++) {
    const outPath = join(dir, `run-${i}.json`)
    const recordPath = join(dir, `run-${i}.groundy.json`)
    const env = { GROUNDY_RECORD: recordPath, GROUNDY_INJECT_M: String(INJECT_M) }
    const { code, stderr } = await runChild(env, outPath)
    if (code !== 0) {
      failures.push(`run ${i} exited ${code}: ${stderr.trim().split('\n').slice(-5).join(' | ')}`)
      continue
    }
    const harness = JSON.parse(await readFile(outPath, 'utf8'))
    const popsPerMin = harness.results?.[0]?.localVisual?.popsPerMin ?? null
    const records = JSON.parse(await readFile(recordPath, 'utf8'))
    const summary = summarizeRun(records, popsPerMin)
    runs.push(summary)
    console.log(`run ${i}: replays ${summary.replays} over-${GROWTH_LIMIT_M * 100}cm ${summary.overLimit} max growth ${fmtM(summary.maxGrowthM)} m max groundY gap ${fmtM(summary.maxGroundYGapM)} m local pops/min ${summary.popsPerMin ?? '-'}`)
  }
  const replays = runs.reduce((s, r) => s + r.replays, 0)
  const overLimit = runs.reduce((s, r) => s + r.overLimit, 0)
  const runsOverLimit = runs.filter(r => r.overLimit > 0).length
  const maxGrowth = runs.reduce((m, r) => (r.maxGrowthM === null ? m : Math.max(m, r.maxGrowthM)), -Infinity)
  const popRuns = runs.filter(r => r.popsPerMin > 0).length
  console.log(`totals: runs ${runs.length}/${RUNS} replays ${replays} replays over ${GROWTH_LIMIT_M * 100} cm growth ${overLimit} in ${runsOverLimit} run(s) max growth ${Number.isFinite(maxGrowth) ? maxGrowth.toFixed(4) : '-'} m runs with local pops ${popRuns}`)
  for (const f of failures) console.log(`failed: ${f}`)

  if (CONTROL) {
    const shown = overLimit > 0
    console.log(shown
      ? `control: injected ${INJECT_M} m ack error produced replay growth over ${GROWTH_LIMIT_M * 100} cm`
      : `control: injected ${INJECT_M} m ack error produced no replay growth over ${GROWTH_LIMIT_M * 100} cm, so this flat-ground case cannot test the groundY base`)
    console.log(shown && failures.length === 0
      ? `RESULT: PASS the witness sees replay growth when the ack error is injected (${overLimit} replay(s) over ${GROWTH_LIMIT_M * 100} cm, max ${maxGrowth.toFixed(4)} m)`
      : `RESULT: FAIL the injected ack error produced no replay growth over ${GROWTH_LIMIT_M * 100} cm in ${runs.length} run(s); the witness cannot show growth on this case`)
    await exitAfterQuiesce(shown && failures.length === 0 ? 0 : 1)
    return
  }

  const ruledOut = runs.length === RUNS && RUNS >= MIN_RUNS && failures.length === 0 && overLimit === 0
  console.log(ruledOut
    ? `RESULT: PASS the replay base groundY adds no growth over ${GROWTH_LIMIT_M * 100} cm in ${runs.length} runs of ${COND} (${replays} replays, max growth ${maxGrowth.toFixed(4)} m, ${popRuns} run(s) with local pops)`
    : `RESULT: FAIL replay growth over ${GROWTH_LIMIT_M * 100} cm in ${overLimit} of ${replays} replays across ${runsOverLimit} of ${runs.length} completed run(s); ${RUNS} requested, ${failures.length} failed, ${popRuns} run(s) with local pops`)
  await exitAfterQuiesce(ruledOut ? 0 : 1)
}

await main()
