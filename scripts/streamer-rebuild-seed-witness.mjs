import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BASE_REV, materializeBase, treeUrl, installAllocHooks } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const RELS = ['src/terrain/HeightfieldStreamer.js']
const SEEDS = [[0, 0], [260, 0], [-240, 120]]
const EXTENT = 510
const RESOLUTION = 4

function childRun(which) {
  const out = spawnSync(process.execPath, [SELF, '--child', `--streamer=${which}`], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[streamer-rebuild] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[streamer-rebuild] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

function heightAt(x, z) { return 4 * Math.sin(x * 0.02) * Math.cos(z * 0.015) }

function installSingleArgCounters() {
  const tally = { Float32Array: 0, Uint8Array: 0 }
  const counted = (Base, name) => class extends Base {
    constructor(...a) {
      super(...a)
      if (a.length === 1 && typeof a[0] === 'number') tally[name]++
    }
  }
  globalThis.Float32Array = counted(Float32Array, 'Float32Array')
  globalThis.Uint8Array = counted(Uint8Array, 'Uint8Array')
  return tally
}

async function runChild(which) {
  await installAllocHooks()
  const tally = installSingleArgCounters()
  const urls = which === 'base' ? materializeBase(BASE_REV, RELS) : Object.fromEntries(RELS.map(r => [r, treeUrl(r)]))
  const { createTerrainStreamer } = await import(urls['src/terrain/HeightfieldStreamer.js'])
  const bodies = []
  let nextId = 0
  const physics = {
    liveWorldCount: 1,
    addHeightField(samples, N) {
      const digest = createHash('sha256').update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)).digest('hex')
      bodies.push({ N, digest })
      return ++nextId
    },
    setBodyTransform() {},
    setTerrainBodyId() {},
    getTerrainBodyId() { return null },
    removeBody() {},
  }
  let hCalls = 0
  const heightFn = (x, z) => { hCalls++; return heightAt(x, z) }
  const streamer = createTerrainStreamer({ physics, getCenters: () => [], heightFn, extent: EXTENT, resolution: RESOLUTION, maxFields: 8, budgetMs: 1000 })
  const builds = []
  for (const p of SEEDS) {
    hCalls = 0
    tally.Float32Array = 0; tally.Uint8Array = 0
    const before = bodies.length
    await streamer.cover([p])
    const gridN = bodies.length > before ? bodies[bodies.length - 1].N : 0
    builds.push({ point: p, built: bodies.length - before, N: gridN, heightCalls: hCalls, float32Allocs: tally.Float32Array, uint8Allocs: tally.Uint8Array })
  }
  streamer.stop()
  return { builds, digests: bodies.map(b => b.digest) }
}

function checks(which, runs) {
  const rows = []
  const add = (label, ok, detail) => rows.push({ label, ok, detail })
  const target = runs[which === 'base' ? 'base' : 'tree']
  const seeded = target.builds.slice(1)
  if (which !== 'base') {
    add('seeded fields equal the base streamer, field by field', JSON.stringify(runs.tree.digests) === JSON.stringify(runs.base.digests), `${runs.tree.digests.length} fields hashed (sha256 of samples)`)
    add('heightFn calls per build equal the base streamer', JSON.stringify(runs.tree.builds.map(b => b.heightCalls)) === JSON.stringify(runs.base.builds.map(b => b.heightCalls)), `tree ${runs.tree.builds.map(b => b.heightCalls).join(',')} vs base ${runs.base.builds.map(b => b.heightCalls).join(',')}`)
  }
  const full = seeded.map(b => b.N * b.N)
  add('seeded builds reuse samples (fewer heightFn calls than cells)', seeded.length > 0 && seeded.every((b, i) => b.built === 1 && b.heightCalls < full[i]), `heightFn calls ${seeded.map(b => `${b.heightCalls}/${full[seeded.indexOf(b)]}`).join(', ')}`)
  const last = target.builds.at(-1)
  add('a seeded rebuild allocates no seed sample or mask buffer', last.uint8Allocs === 0 && last.float32Allocs === 1, `last seeded build: Float32Array constructions ${last.float32Allocs} (sampler output only), Uint8Array constructions ${last.uint8Allocs}`)
  return rows
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('streamer', 'tree'))))
    return
  }
  const which = arg('streamer', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const rows = checks(which, runs)
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}: ${r.detail}`)
  const target = which === 'base' ? 'base' : 'tree'
  const ok = rows.every(r => r.ok)
  const last = runs[target].builds.at(-1)
  console.log(ok
    ? `RESULT: PASS ${target} seeded streamer rebuild: fields equal the base, last seeded build ${last.uint8Allocs} mask and ${last.float32Allocs} float array allocations`
    : `RESULT: FAIL ${target} seeded streamer rebuild: last seeded build ${last.uint8Allocs} mask and ${last.float32Allocs} float array allocations`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL streamer rebuild witness threw'); process.exitCode = 1 })
