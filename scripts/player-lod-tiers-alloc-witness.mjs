import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { materializeBase, treeUrl, sampledAllocationBytes } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const REL = 'client/core/PlayerLOD.js'
const PRE_REV = '20e9389'
const CALLS = 400
const WARM_CALLS = 3000
const SAMPLED_CALLS = 50
const POOL = 120
const REDUCED_D2 = [4, 60, 900, 14400]

function childRun(which) {
  const out = spawnSync(process.execPath, [SELF, '--child', `--lod=${which}`], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[player-lod] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[player-lod] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

function rng(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

function quant(next) { return Math.round(next() * 40) / 4 - 5 }

function sortedNumbers(values) { return [...values].sort((a, b) => a - b) }

function digestOf(tiers, entries) {
  return JSON.stringify({
    full: sortedNumbers(tiers.full),
    reduced: sortedNumbers(tiers.reduced),
    dot: sortedNumbers(tiers.dot),
    order: tiers.order.slice(),
    tierById: [...tiers.tierById.entries()].sort((a, b) => a[0] - b[0]),
    d2: entries.map(e => e.d2),
  })
}

async function runChild(which) {
  const url = which === 'base' ? materializeBase(PRE_REV, [REL])[REL] : treeUrl(REL)
  const { classifyPlayerTiers } = await import(url)
  const next = rng(20260)
  const pool = Array.from({ length: POOL }, (_, i) => i * 3 + 7)
  const hash = createHash('sha256')
  let calls = 0
  for (let s = 0; s < CALLS; s++) {
    const count = s % 90
    const shuffled = pool.slice()
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t }
    const entries = shuffled.slice(0, count).map(id => ({ id, x: quant(next), y: quant(next), z: quant(next) }))
    const viewer = { x: quant(next), y: 0, z: quant(next) }
    const tiers = classifyPlayerTiers(entries, viewer, s % 40, REDUCED_D2[s % REDUCED_D2.length])
    hash.update(digestOf(tiers, entries) + '\n')
    calls++
  }
  const warmEntries = Array.from({ length: 64 }, (_, i) => ({ id: i + 1, x: quant(next), y: 0, z: quant(next) }))
  const warmViewer = { x: 0, y: 0, z: 0 }
  for (let w = 0; w < WARM_CALLS; w++) classifyPlayerTiers(warmEntries, warmViewer, 30, 900)
  const bytes = await sampledAllocationBytes(() => { for (let c = 0; c < SAMPLED_CALLS; c++) classifyPlayerTiers(warmEntries, warmViewer, 30, 900) }, /client\/core\/PlayerLOD\.js$/)
  return { digest: hash.digest('hex'), calls, bytes }
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('lod', 'tree'))))
    return
  }
  const which = arg('lod', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const target = runs[which === 'base' ? 'base' : 'tree']
  const rows = []
  const add = (label, ok, detail) => { rows.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`) }
  if (which !== 'base') add('tiers, order, tierById and d2 equal the pre-change classifier on every call', runs.tree.digest === runs.base.digest && runs.tree.calls === runs.base.calls, `${runs.tree.calls} calls hashed, digests ${runs.tree.digest === runs.base.digest ? 'equal' : 'differ'}`)
  add('zero sampled bytes allocated by the classifier per call after warm-up', target.bytes === 0, `${which === 'base' ? 'base' : 'tree'}: ${target.bytes} sampled bytes over ${SAMPLED_CALLS} calls after ${WARM_CALLS} warm-up calls`)
  const ok = rows.every(Boolean)
  const name = which === 'base' ? 'base' : 'tree'
  console.log(ok
    ? `RESULT: PASS ${name} player LOD tiers: ${target.bytes} sampled bytes over ${SAMPLED_CALLS} calls, tiers equal the pre-change classifier`
    : `RESULT: FAIL ${name} player LOD tiers: ${target.bytes} sampled bytes over ${SAMPLED_CALLS} calls`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL player LOD witness threw'); process.exitCode = 1 })
