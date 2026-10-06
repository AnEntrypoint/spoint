#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), 'true')
}
const flag = (n, d) => (ARGS.has(n) ? String(ARGS.get(n)) : String(d))
const positional = argv.filter((a) => !a.startsWith('--'))

const TOP = Number(flag('top', '25'))
const MATCH = flag('match', 'updateLOD')
const MIN_PCT = Number(flag('min-pct', '0'))

if (!positional.length) {
  console.log('usage: node scripts/perf-profile-share.mjs [--match=updateLOD] [--top=25] <profile.cpuprofile> [...]')
  process.exit(2)
}

function frameOf(node) {
  const f = node.callFrame || {}
  const file = (f.url || '').split('/').pop() || '(none)'
  return `${f.functionName || '(anonymous)'} @ ${file}:${f.lineNumber === undefined ? '?' : f.lineNumber + 1}`
}

function inclusiveMs(profile) {
  const nodes = profile.nodes || []
  const samples = profile.samples || []
  const deltas = profile.timeDeltas || []
  const parentOf = new Int32Array(nodes.length).fill(-1)
  for (let i = 0; i < nodes.length; i++) {
    const kids = nodes[i].children || []
    for (const k of kids) parentOf[k] = i
  }
  const totals = new Map()
  for (let s = 0; s < samples.length; s++) {
    const dt = deltas[s] > 0 ? deltas[s] : 0
    if (dt === 0) continue
    let n = samples[s]
    const seenFrames = new Set()
    while (n >= 0) {
      const key = frameOf(nodes[n])
      if (!seenFrames.has(key)) { seenFrames.add(key); totals.set(key, (totals.get(key) || 0) + dt) }
      n = parentOf[n]
    }
  }
  const byFrame = new Map()
  for (const [key, ms] of totals) byFrame.set(key, { fn: key, ms, hits: 0 })
  const totalMs = (profile.timeDeltas || []).reduce((s, d) => s + (d > 0 ? d : 0), 0)
  const rows = [...byFrame.values()].sort((a, b) => b.ms - a.ms)
  return { rows, totalMs }
}

let failed = false
const summaries = []
for (const p of positional) {
  const profile = JSON.parse(readFileSync(resolve(p), 'utf8'))
  const { rows, totalMs } = inclusiveMs(profile)
  const pct = (ms) => +((ms / totalMs) * 100).toFixed(2)
  const re = new RegExp(MATCH, 'i')
  const hits = rows.filter((r) => re.test(r.fn))
  const hitMs = hits.reduce((s, r) => s + r.ms, 0)
  console.log(`\n=== ${p.split(/[\\/]/).pop()}  profileTotalMs=${(totalMs / 1000).toFixed(1)}`)
  console.log(`match /${MATCH}/ -> ${hits.length} frame(s), ${(hitMs / 1000).toFixed(1)} ms inclusive = ${pct(hitMs)}% of main thread`)
  for (const h of hits) console.log(`    ${h.fn}  ${(h.ms / 1000).toFixed(1)} ms  ${pct(h.ms)}%`)
  console.log(`-- top ${TOP} inclusive frames --`)
  for (const r of rows.slice(0, TOP)) {
    if (pct(r.ms) < MIN_PCT) break
    console.log(`    ${pct(r.ms).toString().padStart(6)}%  ${(r.ms / 1000).toFixed(1).padStart(9)} ms  ${r.fn}`)
  }
  if (hits.length === 0) failed = true
  summaries.push({ profile: p.split(/[\\/]/).pop(), totalMs: +(totalMs / 1000).toFixed(1), matchMs: +(hitMs / 1000).toFixed(1), matchPct: pct(hitMs), frames: hits.length })
}

console.log('\nsummary: ' + JSON.stringify(summaries))
if (failed) { console.log('FAIL: no frame matched /' + MATCH + '/ in at least one profile -- the bundle mangled the name or the code path never ran'); process.exit(1) }
console.log('RESULT: PASS')
