import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BASE_REV, materializeBase, treeUrl, installAllocHooks } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const RELS = ['src/terrain/FieldLattice.js', 'src/terrain/HeightfieldStreamer.js']
const GRID = []
for (let x = -400; x <= 400; x += 25) for (let z = -400; z <= 400; z += 25) GRID.push([x, z])
const SEEDS = [[0, 0], [260, 0], [-240, 120]]

function childRun(which) {
  const out = spawnSync(process.execPath, [SELF, '--child', `--streamer=${which}`], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[streamer-coverage] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[streamer-coverage] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

function heightAt(x, z) { return 4 * Math.sin(x * 0.02) * Math.cos(z * 0.015) }

function makePhysics() {
  let nextId = 0
  return {
    liveWorldCount: 1,
    addHeightField() { return ++nextId },
    setBodyTransform() {},
    setTerrainBodyId() {},
    getTerrainBodyId() { return null },
    removeBody() {},
  }
}

async function runChild(which) {
  await installAllocHooks()
  const urls = which === 'base' ? materializeBase(BASE_REV, RELS) : Object.fromEntries(RELS.map(r => [r, treeUrl(r)]))
  const { createTerrainStreamer } = await import(urls['src/terrain/HeightfieldStreamer.js'])
  const { createFieldLattice } = await import(urls['src/terrain/FieldLattice.js'])
  const { createPlanetFrame } = await import(treeUrl('src/terrain/PlanetFrame.js'))
  const sampler = { radius: 6000, heightAt: () => 0 }
  const liveDir = [0.02, 1, 0.01]
  const liveLen = Math.hypot(...liveDir)
  const liveFrame = createPlanetFrame({ sampler, anchorDir: liveDir.map(v => v / liveLen), offsetY: 0, reliefScale: 0.01 })
  const lattice = createFieldLattice({ sampler, offsetY: 0, reliefScale: 0.01, anchor: { up: [0, 1, 0] }, liveFrame, liveHeightFn: (x, z) => 0.3 * Math.sin(x / 90) })
  const latticeCoords = GRID.map(([x, z]) => lattice.toLattice(x, z))

  const plainStreamer = createTerrainStreamer({ physics: makePhysics(), getCenters: () => [], heightFn: heightAt, extent: 510, resolution: 4, maxFields: 8, budgetMs: 1000 })
  for (const p of SEEDS) await plainStreamer.cover([p])
  const plainCovers = GRID.map(([x, z]) => plainStreamer.coversPosition(x, z))
  plainStreamer.stop()

  const calls = { toLattice: 0, toLatticeInto: 0 }
  const outs = new Set()
  const wrapper = Object.create(lattice, {
    toLattice: { value(x, z) { calls.toLattice++; return lattice.toLattice(x, z) } },
    toLatticeInto: { value(x, z, out) { calls.toLatticeInto++; outs.add(out); return lattice.toLatticeInto(x, z, out) } },
  })
  const latticeStreamer = createTerrainStreamer({ physics: makePhysics(), getCenters: () => [], heightFn: heightAt, extent: 510, resolution: 4, maxFields: 8, budgetMs: 1000 })
  latticeStreamer.setLattice(wrapper)
  for (const p of SEEDS) await latticeStreamer.cover([p])
  calls.toLattice = 0; calls.toLatticeInto = 0; outs.clear()
  const latticeCovers = GRID.map(([x, z]) => latticeStreamer.coversPosition(x, z))
  const sweep = { toLattice: calls.toLattice, toLatticeInto: calls.toLatticeInto, distinctOut: outs.size, queries: GRID.length }
  latticeStreamer.stop()

  const intoIsCallerBuffer = typeof lattice.toLatticeInto === 'function' ? (() => { const out = [0, 0]; return lattice.toLatticeInto(1, 2, out) === out })() : null
  return { plainCovers, latticeCovers, latticeCoords, sweep, intoIsCallerBuffer }
}

function checks(which, runs) {
  const rows = []
  const add = (label, ok, detail) => rows.push({ label, ok, detail })
  const tree = runs.tree
  const base = runs.base
  if (which === 'both') {
    add('coverage equals the base streamer on every probe (no lattice)', JSON.stringify(tree.plainCovers) === JSON.stringify(base.plainCovers), `tree ${tree.plainCovers.filter(Boolean).length} of ${GRID.length} covered`)
    add('coverage equals the base streamer on every probe (lattice)', JSON.stringify(tree.latticeCovers) === JSON.stringify(base.latticeCovers), `tree ${tree.latticeCovers.filter(Boolean).length} of ${GRID.length} covered`)
    add('lattice coordinates equal the base lattice on every probe', JSON.stringify(tree.latticeCoords) === JSON.stringify(base.latticeCoords), `${GRID.length} probes`)
  }
  const s = runs[which === 'both' ? 'tree' : which].sweep
  add('coverage query makes no toLattice call (array per query)', s.toLattice === 0, `toLattice calls over ${s.queries} queries = ${s.toLattice}`)
  add('coverage query reuses one caller buffer', s.toLatticeInto === s.queries && s.distinctOut === 1, `toLatticeInto calls = ${s.toLatticeInto}, distinct output buffers = ${s.distinctOut}`)
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
  const rows = checks(which === 'base' ? 'base' : 'both', runs)
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}: ${r.detail}`)
  const target = which === 'base' ? 'base' : 'tree'
  const ok = rows.every(r => r.ok)
  const s = runs[target].sweep
  console.log(ok
    ? `RESULT: PASS ${target} streamer coverage: ${s.toLattice} toLattice calls and ${s.distinctOut} caller buffer over ${s.queries} queries, coverage and lattice coordinates equal the base`
    : `RESULT: FAIL ${target} streamer coverage: ${s.toLattice} toLattice calls and ${s.distinctOut} caller buffer over ${s.queries} queries`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL streamer coverage witness threw'); process.exitCode = 1 })
