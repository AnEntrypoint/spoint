#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { baselineRefusals } from './lib/frame-time-baseline.mjs'

const GLOB = '.frame-time-baseline*.json'

function trackedBaselines() {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--', GLOB], { maxBuffer: 8 * 1024 * 1024 })
  return raw.toString('utf8').split('\0').filter(Boolean)
}

const files = trackedBaselines()
if (files.length === 0) {
  console.error(`${GLOB}: no baseline is committed, so the frame-time gate has nothing to compare against -- capture one with: node scripts/frame-time-gate.mjs --expect-vendor=<vendor> --update-baseline`)
  process.exit(1)
}

const failures = []
for (const file of files) {
  let baseline
  try {
    baseline = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    failures.push(`${file}: unreadable (${e.message})`)
    continue
  }
  const refusals = baselineRefusals(baseline)
  if (refusals.length) {
    failures.push(`${file}: ${refusals.join('; ')}`)
    continue
  }
  const covered = ['static', 'orbit'].every((arm) => Number.isFinite(baseline[arm] && baseline[arm].p50Ms) && baseline[arm].p50Ms > 0)
  if (!covered) failures.push(`${file}: an arm has no positive p50Ms, so the gate's +10% limit is unenforceable`)
  console.log(`check-frame-time-baselines: ${file} admissible (vendor=${baseline.vendor || 'unlabelled'} rasterizer=${baseline.rasterizer} orbit p50=${baseline.orbit.p50Ms.toFixed(2)}ms vegInstances=${baseline.vegInstances})`)
}

if (failures.length) {
  console.error(`check-frame-time-baselines: ${failures.length} baseline(s) fail:`)
  for (const f of failures) console.error(`  ${f}`)
  console.error('check-frame-time-baselines: delete the superseded file or re-capture it with: node scripts/frame-time-gate.mjs --expect-vendor=<vendor> --update-baseline')
  process.exit(1)
}
console.log(`check-frame-time-baselines: ${files.length} committed baseline(s) are admissible`)
