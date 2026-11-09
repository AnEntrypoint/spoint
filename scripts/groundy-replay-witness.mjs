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
const MIN_REPLAYS = 100
const SPIKE_MIN_M = 0.0008
const INPUT_CATCHUP_DEPTH = 8
const SPIKE_MAX_M = 0.0025
const INJECT_DEFAULT_M = 0.03

const args = parseArgs(process.argv.slice(2))
const CONTROL = args.control === true || args.control === 'true'
const RUNS = numericFlag(args, 'runs', CONTROL ? 1 : MIN_RUNS)
const COND = strArg(args.cond, '120/40/6')
const WORLD = strArg(args.world, 'peers')
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

const SAME_STAT_M = 1e-6
const INJECT_MATCH_M = 1e-3

const sameStat = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= SAME_STAT_M

const engineMatchingHarness = (records, mispredict) => {
  const expected = mispredict?.correctionsApplied
  if (!Number.isFinite(expected)) return null
  if (expected === 0) return []
  const jumps = mispredict?.correctionJumpM
  if (!jumps || !Number.isFinite(jumps.n)) return null
  const byEngine = new Map()
  for (const r of records) byEngine.set(r.engine, [...(byEngine.get(r.engine) || []), r])
  const matches = [...byEngine.values()].filter(rs => {
    if (rs.length !== expected || rs.length !== jumps.n) return false
    const got = rs.map(r => r.jumpM)
    const mean = got.reduce((s, x) => s + x, 0) / got.length
    return sameStat(mean, jumps.mean) && sameStat(Math.max(...got), jumps.max)
  })
  return matches.length === 1 ? matches[0] : null
}

const gapOf = r => (r.serverGroundY === null || r.predictedGroundY === null ? null : r.serverGroundY - r.predictedGroundY)

const POP_MATCH_MS = 100

const correlatePops = (records, popEvents) => {
  let matched = 0, onPeerPush = 0
  for (const p of popEvents) {
    let best = null, bestDt = Infinity
    for (const r of records) {
      const dt = Math.abs(r.t - p.t)
      if (dt < bestDt) { best = r; bestDt = dt }
    }
    if (best && bestDt <= POP_MATCH_MS) { matched++; if (best.inContact) onPeerPush++ }
  }
  return { pops: popEvents.length, matched, onPeerPush }
}

const summarizeRun = (records, popsPerMin, popEvents) => {
  const growths = records.map(r => r.growthM)
  const gaps = records.map(gapOf).filter(g => g !== null).map(Math.abs)
  const over = records.filter(r => r.growthM > GROWTH_LIMIT_M)
  const injected = records.filter(r => INJECT_M > 0 && gapOf(r) !== null && Math.abs(Math.abs(gapOf(r)) - INJECT_M) <= INJECT_MATCH_M)
  const pops = correlatePops(records, popEvents)
  return {
    replays: records.length,
    overLimit: over.length,
    overLimitWithGroundYGap: over.filter(r => gapOf(r) !== null && Math.abs(gapOf(r)) > SAME_STAT_M).length,
    overLimitInContact: over.filter(r => r.inContact).length,
    inContactReplays: records.filter(r => r.inContact).length,
    maxGrowthM: growths.length ? Math.max(...growths) : null,
    maxGroundYGapM: gaps.length ? Math.max(...gaps) : null,
    injectedReplays: injected.length,
    injectedOverLimit: injected.filter(r => r.growthM > GROWTH_LIMIT_M).length,
    popsPerMin,
    pops
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
    const popEvents = harness.results?.[0]?.localVisual?.popEvents ?? []
    const records = JSON.parse(await readFile(recordPath, 'utf8'))
    const corrections = records.filter(r => r.kind === 'correction')
    const resyncs = records.filter(r => r.kind === 'resync').length
    const spikes = records.filter(r => r.kind === 'spike').length
    const deepQueue = corrections.filter(r => r.serverQueueDepth > INPUT_CATCHUP_DEPTH).length
    const overDeepQueue = corrections.filter(r => r.serverQueueDepth > INPUT_CATCHUP_DEPTH && r.growthM > GROWTH_LIMIT_M).length
    if (!engineMatchingHarness(corrections, harness.results?.[0]?.mispredict)) {
      failures.push(`run ${i}: no engine's corrections match the harness's ${harness.results?.[0]?.mispredict?.correctionsApplied ?? '-'} applied corrections, so the hook missed a correction`)
      continue
    }
    const engines = new Set(corrections.map(r => r.engine)).size
    const summary = { ...summarizeRun(corrections, popsPerMin, popEvents), engines, resyncs, spikes, deepQueue, overDeepQueue }
    runs.push(summary)
    console.log(`run ${i} [world ${WORLD} cond ${COND}]: replays ${summary.replays} across ${engines} engine(s) (${resyncs} resync replay(s) carry no ack error and are not measured for growth) over-${GROWTH_LIMIT_M * 100}cm ${summary.overLimit} (in peer contact ${summary.overLimitInContact} of ${summary.inContactReplays} contact replays; with groundY gap ${summary.overLimitWithGroundYGap}) max growth ${fmtM(summary.maxGrowthM)} m max groundY gap ${fmtM(summary.maxGroundYGapM)} m injected replays ${summary.injectedReplays} (over limit ${summary.injectedOverLimit}) local pops/min ${summary.popsPerMin ?? '-'} pops ${summary.pops.pops} matched to a correction within ${POP_MATCH_MS} ms ${summary.pops.matched} (in peer contact ${summary.pops.onPeerPush}) mirror spikes ${summary.spikes}`)
  }
  const replays = runs.reduce((s, r) => s + r.replays, 0)
  const overLimit = runs.reduce((s, r) => s + r.overLimit, 0)
  const runsOverLimit = runs.filter(r => r.overLimit > 0).length
  const maxGrowth = runs.reduce((m, r) => (r.maxGrowthM === null ? m : Math.max(m, r.maxGrowthM)), -Infinity)
  const popRuns = runs.filter(r => r.popsPerMin > 0).length
  const withGap = runs.reduce((s, r) => s + r.overLimitWithGroundYGap, 0)
  const injectedReplays = runs.reduce((s, r) => s + r.injectedReplays, 0)
  const injectedOver = runs.reduce((s, r) => s + r.injectedOverLimit, 0)
  const overInContact = runs.reduce((s, r) => s + r.overLimitInContact, 0)
  const inContactReplays = runs.reduce((s, r) => s + r.inContactReplays, 0)
  const popTotal = runs.reduce((s, r) => s + r.pops.pops, 0)
  const spikeTotal = runs.reduce((s, r) => s + r.spikes, 0)
  const deepQueueTotal = runs.reduce((s, r) => s + r.deepQueue, 0)
  const overDeepQueueTotal = runs.reduce((s, r) => s + r.overDeepQueue, 0)
  const popMatched = runs.reduce((s, r) => s + r.pops.matched, 0)
  const popOnPeer = runs.reduce((s, r) => s + r.pops.onPeerPush, 0)
  const popsPerMinMax = runs.reduce((m, r) => (r.popsPerMin === null ? m : Math.max(m, r.popsPerMin)), -Infinity)
  console.log(`totals: runs ${runs.length}/${RUNS} replays ${replays} replays over ${GROWTH_LIMIT_M * 100} cm growth ${overLimit} (in peer contact ${overInContact} of ${inContactReplays} contact replays; with a groundY gap ${withGap}) in ${runsOverLimit} run(s) max growth ${Number.isFinite(maxGrowth) ? maxGrowth.toFixed(4) : '-'} m injected replays ${injectedReplays} (over limit ${injectedOver}) runs with local pops ${popRuns} max pops/min ${Number.isFinite(popsPerMinMax) ? popsPerMinMax.toFixed(2) : '-'} pops ${popTotal} matched ${popMatched} in peer contact ${popOnPeer} mirror spikes ${spikeTotal} corrections with server queue above ${INPUT_CATCHUP_DEPTH} ${deepQueueTotal} of which over ${GROWTH_LIMIT_M * 100} cm ${overDeepQueueTotal}`)
  for (const f of failures) console.log(`failed: ${f}`)

  if (CONTROL) {
    const shown = injectedReplays > 0 && injectedOver > 0
    console.log(`control: ${injectedReplays} mover replay(s) carried the injected ${INJECT_M} m groundY gap, ${injectedOver} of them over ${GROWTH_LIMIT_M * 100} cm growth`)
    console.log(shown && failures.length === 0
      ? `RESULT: PASS the injected ${INJECT_M} m ack error reaches the replay base and shows replay growth over ${GROWTH_LIMIT_M * 100} cm (${injectedOver} of ${injectedReplays} injected replays)`
      : `RESULT: FAIL the injected ${INJECT_M} m ack error did not show replay growth over ${GROWTH_LIMIT_M * 100} cm in the replays that carry it (${injectedReplays} carried it, ${injectedOver} grew, ${failures.length} run(s) failed)`)
    await exitAfterQuiesce(shown && failures.length === 0 ? 0 : 1)
    return
  }

  const ruledOut = runs.length === RUNS && RUNS >= MIN_RUNS && failures.length === 0 && overLimit === 0 && replays >= MIN_REPLAYS && spikeTotal === 0
  const reasons = [
    ...(failures.length ? [`${failures.length} of ${RUNS} run(s) failed`] : []),
    ...(replays < MIN_REPLAYS ? [`underpowered: ${replays} correction replay(s), below the ${MIN_REPLAYS} needed to gate replay growth`] : []),
    ...(overLimit > 0 ? [`replay growth over ${GROWTH_LIMIT_M * 100} cm in ${overLimit} of ${replays} replays across ${runsOverLimit} of ${runs.length} completed run(s)`] : []),
    ...(spikeTotal > 0 ? [`${spikeTotal} mirror one-tick spike(s) of ${SPIKE_MIN_M * 1000}-${SPIKE_MAX_M * 1000} mm across ${runs.filter(r => r.spikes > 0).length} of ${runs.length} run(s)`] : [])
  ]
  console.log(ruledOut
    ? `RESULT: PASS the replay base groundY adds no growth over ${GROWTH_LIMIT_M * 100} cm in ${runs.length} runs of ${COND} (${replays} replays, max growth ${Number.isFinite(maxGrowth) ? maxGrowth.toFixed(4) : '-'} m, ${popRuns} run(s) with local pops)`
    : `RESULT: FAIL world ${WORLD} cond ${COND}: ${reasons.join('; ')}; ${RUNS} requested, ${popRuns} run(s) with local pops`)
  await exitAfterQuiesce(ruledOut ? 0 : 1)
}

await main()
