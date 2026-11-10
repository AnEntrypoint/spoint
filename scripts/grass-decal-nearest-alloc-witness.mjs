import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { materializeBase, treeUrl, sampledAllocationBytes } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const REL = 'src/terrain/GrassDecal.js'
const PRE_REV = '0b76d94'
const STAMPS = 300
const QUERIES = 400
const WARM_QUERIES = 3000
const SAMPLED_QUERIES = 50
const MAXES = [1, 4, 8, 16, Infinity]
const RADII = [4, 15, 40, undefined]

function childRun(which) {
  const out = spawnSync(process.execPath, [SELF, '--child', `--decal=${which}`], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[grass-decal] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[grass-decal] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

function lcg(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

async function runChild(which) {
  const url = which === 'base' ? materializeBase(PRE_REV, [REL])[REL] : treeUrl(REL)
  const { createGrassDecal } = await import(url)
  const isTree = which !== 'base'
  let clock = 1000000
  const store = createGrassDecal(null, { halfLifeS: 120, now: () => clock })
  const rnd = lcg(7)
  for (let i = 0; i < STAMPS; i++) {
    clock += 37
    store.markScorched(rnd() * 120 - 60, rnd() * 120 - 60, 1 + rnd() * 5, 0.2 + rnd() * 0.8)
  }
  const hash = createHash('sha256')
  const buf = []
  const query = (st, px, pz, max, radius) => {
    if (isTree) {
      const n = st.nearestStampsInto(buf, px, pz, max, radius)
      return buf.slice(0, n).map(s => [s.x, s.z, s.radius, s.strength])
    }
    return st.nearestStamps(px, pz, max, radius).map(s => [s.x, s.z, s.radius, s.strength])
  }
  const qrnd = lcg(11)
  for (let q = 0; q < QUERIES; q++) {
    if (q % 25 === 24) clock += 500
    const px = qrnd() * 140 - 70, pz = qrnd() * 140 - 70
    const max = MAXES[q % MAXES.length], radius = RADII[(q >> 2) % RADII.length]
    hash.update(JSON.stringify(query(store, px, pz, max, radius)) + '\n')
  }
  const live = createGrassDecal(null, { halfLifeS: 120 })
  const lrnd = lcg(13)
  for (let i = 0; i < STAMPS; i++) live.markScorched(lrnd() * 120 - 60, lrnd() * 120 - 60, 1 + lrnd() * 5, 0.2 + lrnd() * 0.8)
  const liveBuf = []
  const liveQuery = (px, pz) => {
    if (isTree) return live.nearestStampsInto(liveBuf, px, pz, 8, 20)
    return live.nearestStamps(px, pz, 8, 20).length
  }
  for (let w = 0; w < WARM_QUERIES; w++) liveQuery(w % 60 - 30, (w * 3) % 60 - 30)
  const bytes = await sampledAllocationBytes(() => { for (let r = 0; r < SAMPLED_QUERIES; r++) liveQuery(r % 60 - 30, (r * 3) % 60 - 30) }, /src\/terrain\/GrassDecal\.js$/)
  return { digest: hash.digest('hex'), queries: QUERIES, bytes }
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('decal', 'tree'))))
    return
  }
  const which = arg('decal', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const target = runs[which === 'base' ? 'base' : 'tree']
  const rows = []
  const add = (label, ok, detail) => { rows.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`) }
  if (which !== 'base') add('nearest stamps equal the pre-change query in order, values and count, over every query', runs.tree.digest === runs.base.digest, `${QUERIES} queries across max ${MAXES.join('/')} and radius ${RADII.map(String).join('/')}, digests ${runs.tree.digest === runs.base.digest ? 'equal' : 'differ'}`)
  add('zero sampled bytes allocated by the nearest-stamp query per call after warm-up', target.bytes === 0, `${which === 'base' ? 'base' : 'tree'}: ${target.bytes} sampled bytes over ${SAMPLED_QUERIES} queries after ${WARM_QUERIES} warm-up queries`)
  const ok = rows.every(Boolean)
  const name = which === 'base' ? 'base' : 'tree'
  console.log(ok
    ? `RESULT: PASS ${name} grass decal nearest stamps: ${target.bytes} sampled bytes over ${SAMPLED_QUERIES} queries, order and values equal the pre-change query`
    : `RESULT: FAIL ${name} grass decal nearest stamps: ${target.bytes} sampled bytes over ${SAMPLED_QUERIES} queries`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL grass decal witness threw'); process.exitCode = 1 })
