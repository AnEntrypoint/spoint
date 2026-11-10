import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { materializeBase, treeUrl, sampledAllocationBytes } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const REL = 'src/transport/TransformRing.js'
const PRE_REV = '0b76d94'
const CAP = 8
const PLAYERS = [101, 102, 103, 104]
const STEPS = 240
const WARM_READS = 3000
const SAMPLED_READS = 50
const HEADER_GEN_INDEX = 2
const CTRL_BASE_BYTES = 16

function childRun(which) {
  const out = spawnSync(process.execPath, [SELF, '--child', `--ring=${which}`], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[transform-ring] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[transform-ring] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

function snapshotLine(players) {
  const rows = [...players.entries()].sort((a, b) => a[0] - b[0]).map(([id, r]) => [id, Array.from(r.position), Array.from(r.rotation), Array.from(r.velocity), r.stale])
  return JSON.stringify(rows)
}

async function runChild(which) {
  globalThis.crossOriginIsolated = true
  const url = which === 'base' ? materializeBase(PRE_REV, [REL])[REL] : treeUrl(REL)
  const { allocateRingBuffer, TransformRingWriter, TransformRingReader, RING_HEADER_INTS } = await import(url)
  const { sab } = allocateRingBuffer(CAP)
  const writer = new TransformRingWriter(sab, CAP)
  const reader = new TransformRingReader(sab, CAP)
  const header = new Int32Array(sab, 0, RING_HEADER_INTS)
  const ctrl = new Int32Array(sab, CTRL_BASE_BYTES, CAP * 2)
  const hash = createHash('sha256')
  let lines = 0
  for (let s = 0; s < STEPS; s++) {
    for (const id of PLAYERS) {
      if (id === 103 && s % 7 === 3) { writer.release(id); continue }
      const k = s * 0.5 + id
      writer.write(id, [k, k * 0.25, -k], [0, Math.sin(k) * 0.1, 0, Math.cos(k * 0.5)], [k * 0.01, 0, -k * 0.01])
    }
    let snap
    if (s % 11 === 5) {
      const gen = Atomics.load(header, HEADER_GEN_INDEX)
      Atomics.store(header, HEADER_GEN_INDEX, gen + 1)
      snap = reader.readAll(1)
      Atomics.store(header, HEADER_GEN_INDEX, gen)
    } else if (s % 13 === 6) {
      const slotGen = Atomics.load(ctrl, 0)
      Atomics.store(ctrl, 0, slotGen + 1)
      snap = reader.readAll()
      Atomics.store(ctrl, 0, slotGen)
    } else {
      snap = reader.readAll()
    }
    hash.update(snapshotLine(snap) + '\n')
    lines++
  }
  for (let w = 0; w < WARM_READS; w++) reader.readAll()
  const bytes = await sampledAllocationBytes(() => { for (let r = 0; r < SAMPLED_READS; r++) reader.readAll() }, /src\/transport\/TransformRing\.js$/)
  return { digest: hash.digest('hex'), lines, bytes }
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('ring', 'tree'))))
    return
  }
  const which = arg('ring', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const target = runs[which === 'base' ? 'base' : 'tree']
  const rows = []
  const add = (label, ok, detail) => { rows.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`) }
  if (which !== 'base') add('reads equal the pre-change reader on every state (sorted entries, stale flags, locked header and slot reads)', runs.tree.digest === runs.base.digest && runs.tree.lines === runs.base.lines, `${runs.tree.lines} reads hashed, digests ${runs.tree.digest === runs.base.digest ? 'equal' : 'differ'}`)
  add('zero sampled bytes allocated by the reader per read after warm-up', target.bytes === 0, `${which === 'base' ? 'base' : 'tree'}: ${target.bytes} sampled bytes over ${SAMPLED_READS} reads after ${WARM_READS} warm-up reads`)
  const ok = rows.every(Boolean)
  const name = which === 'base' ? 'base' : 'tree'
  console.log(ok
    ? `RESULT: PASS ${name} transform ring reads: ${target.bytes} sampled bytes over ${SAMPLED_READS} reads, reads equal the pre-change reader`
    : `RESULT: FAIL ${name} transform ring reads: ${target.bytes} sampled bytes over ${SAMPLED_READS} reads`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL transform ring witness threw'); process.exitCode = 1 })
