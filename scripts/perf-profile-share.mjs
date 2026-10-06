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
    for (const k of kids) if (k >= 0 && k < nodes.length && k !== i) parentOf[k] = i
  }
  const keyIds = new Map()
  const nodeKey = new Int32Array(nodes.length)
  const keyNames = []
  for (let i = 0; i < nodes.length; i++) {
    const key = frameOf(nodes[i])
    let id = keyIds.get(key)
    if (id === undefined) { id = keyNames.length; keyIds.set(key, id); keyNames.push(key) }
    nodeKey[i] = id
  }
  const seenAt = new Int32Array(keyNames.length).fill(-1)
  const totals = new Float64Array(keyNames.length)
  for (let s = 0; s < samples.length; s++) {
    const dt = deltas[s] > 0 ? deltas[s] : 0
    if (dt === 0) continue
    let n = samples[s]
    let steps = 0
    while (n >= 0 && steps <= nodes.length) {
      const id = nodeKey[n]
      if (seenAt[id] !== s) { seenAt[id] = s; totals[id] += dt }
      n = parentOf[n]
      steps++
    }
  }
  const totalMs = deltas.reduce((s, d) => s + (d > 0 ? d : 0), 0)
  const rows = []
  for (let i = 0; i < keyNames.length; i++) if (totals[i] > 0) rows.push({ fn: keyNames[i], ms: totals[i] })
  rows.sort((a, b) => b.ms - a.ms)
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
