#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { baselineRefusals } from './lib/frame-time-baseline.mjs'

const GLOB = '.frame-time-baseline*.json'
const WORKFLOW_DIR = '.github/workflows'
const GATE_SCRIPT = 'scripts/frame-time-gate.mjs'
const GATE_NPM_SCRIPT = 'frame-time-gate'
const CI_RUNNABLE_RASTERIZER = 'software'
const NPM_RUN_RE = new RegExp(`npm run\\s+(?:--\\S+\\s+)*${GATE_NPM_SCRIPT}\\b`)

function trackedBaselines() {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--', GLOB], { maxBuffer: 8 * 1024 * 1024 })
  return raw.toString('utf8').split('\0').filter(Boolean)
}

function workflowFiles() {
  if (!existsSync(WORKFLOW_DIR)) return []
  return readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(WORKFLOW_DIR, f))
}

function baselineNamedBy(line) {
  const explicit = /--baseline=(\S+)/.exec(line)
  if (explicit) return explicit[1]
  const vendor = /--expect-vendor=(\S+)/.exec(line)
  if (vendor) return `.frame-time-baseline.${vendor[1]}.json`
  return null
}

function gateInvocations() {
  const found = []
  for (const file of workflowFiles()) {
    readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
      const line = raw.trim()
      if (!line.includes(GATE_SCRIPT) && !NPM_RUN_RE.test(line)) return
      found.push({ file, line: i + 1, baseline: baselineNamedBy(line) })
    })
  }
  return found
}

const files = trackedBaselines()
if (files.length === 0) {
  console.error(`${GLOB}: no baseline is committed, so the frame-time gate has nothing to compare against -- capture one with: node scripts/frame-time-gate.mjs --expect-vendor=<vendor> --update-baseline`)
  process.exit(1)
}

const failures = []
const baselines = []
for (const file of files) {
  let baseline
  try {
    baseline = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    failures.push(`${file}: unreadable (${e.message})`)
    continue
  }
  baselines.push({ file, baseline })
  const refusals = baselineRefusals(baseline)
  if (refusals.length) {
    failures.push(`${file}: ${refusals.join('; ')}`)
    continue
  }
  const covered = ['static', 'orbit'].every((arm) => Number.isFinite(baseline[arm] && baseline[arm].p50Ms) && baseline[arm].p50Ms > 0)
  if (!covered) {
    failures.push(`${file}: an arm has no positive p50Ms, so the gate's +10% limit is unenforceable`)
    continue
  }
  console.log(`check-frame-time-baselines: ${file} admissible (vendor=${baseline.vendor || 'unlabelled'} rasterizer=${baseline.rasterizer} orbit p50=${baseline.orbit.p50Ms.toFixed(2)}ms vegInstances=${baseline.vegInstances})`)
}

const invocations = gateInvocations()
const workflows = workflowFiles()
if (workflows.length === 0) {
  failures.push(`no workflow file exists under ${WORKFLOW_DIR}, so no CI run invokes ${GATE_SCRIPT} -- a p50 frame-time regression lands green`)
} else if (invocations.length === 0) {
  failures.push(`no step in ${workflows.join(', ')} invokes ${GATE_SCRIPT}, so a p50 frame-time regression lands green -- add a step running: node ${GATE_SCRIPT} --gpu=<software|accelerated|nvidia|amd> --baseline=.frame-time-baseline.<vendor>.json`)
}
for (const inv of invocations) {
  if (!inv.baseline) {
    failures.push(`${inv.file}:${inv.line} invokes the gate without --baseline= or --expect-vendor=, so the baseline it compares against is implicit`)
    continue
  }
  console.log(`check-frame-time-baselines: gate invoked by ${inv.file}:${inv.line} against ${inv.baseline}`)
  if (!files.includes(inv.baseline)) failures.push(`${inv.file}:${inv.line} compares ${inv.baseline}, which no committed baseline provides -- the gate would exit 1 with "no baseline found"`)
}

const claimed = new Set(invocations.map((i) => i.baseline).filter(Boolean))
const unclaimedOutsideCi = []
for (const { file, baseline } of baselines) {
  if (claimed.has(file)) continue
  if (baseline.rasterizer === CI_RUNNABLE_RASTERIZER) {
    failures.push(`${file} is compared by no workflow step, so this committed ${baseline.rasterizer}-class baseline is never enforced`)
  } else {
    unclaimedOutsideCi.push(`${file} (rasterizer=${baseline.rasterizer || 'unrecorded'})`)
  }
}
if (unclaimedOutsideCi.length) {
  console.log(`check-frame-time-baselines: UNCLAIMED ${unclaimedOutsideCi.join(', ')} -- no workflow step compares these, because the accelerated arm needs a GPU-capable runner; they are enforced only by a local run on hardware this repo's hosted CI does not provide`)
}

if (failures.length) {
  console.error(`check-frame-time-baselines: ${failures.length} problem(s):`)
  for (const f of failures) console.error(`  ${f}`)
  console.error('check-frame-time-baselines: delete the superseded file or re-capture it with: node scripts/frame-time-gate.mjs --expect-vendor=<vendor> --update-baseline')
  process.exit(1)
}
console.log(`check-frame-time-baselines: ${files.length} committed baseline(s) are admissible, ${claimed.size} compared by a CI step`)
