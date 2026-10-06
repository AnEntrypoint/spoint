process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const href = p => pathToFileURL(p).href
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const GRID = Number(args.grid ?? 32)
const CELLS = args.cells ? String(args.cells).split(',').map(Number) : null
const EXPERIMENTS = args.experiment ? String(args.experiment).split(',') : ['identical', 'baseline', 'sharedRange', 'blockSize1']

const log = (...a) => { process.stdout.write(a.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ') + '\n') }

const { loadWorldModule } = await import(href(resolve(ROOT, 'src/sdk/WorldLocator.js')))
const { PhysicsWorld } = await import(href(resolve(ROOT, 'src/physics/World.js')))
const { loadPlanetSampler, planetSamplerOptsOf } = await import(href(resolve(ROOT, 'src/terrain/TerrainPhysics.js')))
const { createPlanetFrame } = await import(href(resolve(ROOT, 'src/terrain/PlanetFrame.js')))
const { sampleTerrainGridChunked } = await import(href(resolve(ROOT, 'src/terrain/HeightfieldStreamer.js')))

const loaded = await loadWorldModule(resolve(ROOT, 'apps/world/tps-game.js'))
const tcfg = { ...loaded.terrain, bakedHeightfield: undefined, vegetation: { ...(loaded.terrain.vegetation || {}), colliders: false, rockColliders: false } }
const tphys = tcfg.physics || {}
const extent = tphys.extent || 510
const resolution = tphys.resolution || 4
let N = Math.max(2, Math.round(extent / resolution)); if (N % 2 !== 0) N += 1
const spacing = extent / (N - 1)
const half = extent / 2
const snapCorner = c => Math.round((c - half) / spacing) * spacing

const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const heightFn = (x, z, guess) => frame.groundHeightLocal(x, z, guess)

log('CONFIG', JSON.stringify({ world: 'tps-game', extent, resolution, N, spacing: +spacing.toFixed(4), half, radius: tcfg.radius, reliefScale: tcfg.reliefScale }))

const physics = new PhysicsWorld({ gravity: [0, -18, 0] })
await physics.init()
const J = physics.Jolt

const stats = arr => {
  let min = Infinity, max = -Infinity
  for (const v of arr) { if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v } }
  return { min, max, range: max - min }
}

function addFieldWith(samples, cornerX, cornerZ, opts = {}) {
  const settings = new J.HeightFieldShapeSettings()
  const offset = new J.Vec3(0, 0, 0); settings.set_mOffset(offset); J.destroy(offset)
  const sv = new J.Vec3(spacing, 1, spacing); settings.set_mScale(sv); J.destroy(sv)
  settings.set_mSampleCount(N)
  if (typeof settings.set_mBlockSize === 'function') settings.set_mBlockSize(opts.blockSize ?? 2)
  if (opts.min != null && opts.max != null) {
    if (typeof settings.set_mMinHeightValue === 'function') settings.set_mMinHeightValue(opts.min)
    if (typeof settings.set_mMaxHeightValue === 'function') settings.set_mMaxHeightValue(opts.max)
  }
  const heights = settings.get_mHeightSamples()
  heights.resize(samples.length)
  const ref = heights.data(), ptr = J.getPointer(ref)
  J.HEAPF32.set(samples instanceof Float32Array ? samples : Float32Array.from(samples), ptr >> 2)
  const sr = settings.Create()
  if (!sr.IsValid()) { console.error('[heightfield] shape invalid:', sr.GetError().c_str()); J.destroy(settings); J.destroy(sr); return null }
  const shape = sr.Get()
  const id = physics._addBody(shape, [cornerX, 0, cornerZ], J.EMotionType_Static, 0, { meta: { type: 'static', shape: 'heightfield' } })
  J.destroy(settings); J.destroy(sr)
  return id
}

const sampleCache = new Map()
async function samplesAt(cornerX, cornerZ) {
  const k = `${cornerX}|${cornerZ}`
  if (sampleCache.has(k)) return sampleCache.get(k)
  const g = await sampleTerrainGridChunked({ heightFn, N, spacing, cornerX, cornerZ, budgetMs: 2, isAborted: () => false })
  const rec = { samples: g.samples, ...stats(g.samples) }
  sampleCache.set(k, rec)
  return rec
}

async function seamProbe(cellsOffset, experiment) {
  const cz = snapCorner(0)
  const cax = snapCorner(0)
  const cbx = experiment === 'identical' ? cax : cax + cellsOffset * spacing
  const SA = await samplesAt(cax, cz)
  const SB = await samplesAt(cbx, cz)
  const sharedRange = experiment === 'sharedRange'
  const rangeMin = sharedRange ? Math.min(SA.min, SB.min) : null
  const rangeMax = sharedRange ? Math.max(SA.max, SB.max) : null
  const blockSize = experiment === 'blockSize1' ? 1 : 2
  const bodyA = addFieldWith(SA.samples, cax, cz, { min: rangeMin, max: rangeMax, blockSize })
  const bodyB = addFieldWith(SB.samples, cbx, cz, { min: rangeMin, max: rangeMax, blockSize })
  physics.step(1 / 60)

  const x0 = Math.max(cax, cbx) + 2, x1 = Math.min(cax, cbx) + (N - 1) * spacing - 2
  const z0 = cz + 2, z1 = cz + (N - 1) * spacing - 2
  const topY = Math.max(SA.max, SB.max), lowY = Math.min(SA.min, SB.min)
  const originY = topY + 50, rayLen = (topY - lowY) + 120

  let sharedSampleMaxDiff = 0
  const dx = Math.round((cbx - cax) / spacing)
  for (let j = 0; j < N; j++) for (let i = Math.max(0, dx); i < N; i++) {
    const d = Math.abs(SA.samples[j * N + i] - SB.samples[j * N + i - dx])
    if (Number.isFinite(d) && d > sharedSampleMaxDiff) sharedSampleMaxDiff = d
  }

  let maxDiff = 0, sumDiff = 0, n = 0, worst = null
  const diffs = []
  for (let jj = 0; jj < GRID; jj++) {
    const z = z0 + (z1 - z0) * (jj / (GRID - 1))
    for (let ii = 0; ii < GRID; ii++) {
      const x = x0 + (x1 - x0) * (ii / (GRID - 1))
      const origin = [x, originY, z]
      const rA = physics.raycast(origin, [0, -1, 0], rayLen, bodyB)
      const rB = physics.raycast(origin, [0, -1, 0], rayLen, bodyA)
      const yA = rA.hit ? rA.position[1] : NaN
      const yB = rB.hit ? rB.position[1] : NaN
      if (!Number.isFinite(yA) || !Number.isFinite(yB)) continue
      const d = Math.abs(yA - yB)
      diffs.push(d); n++; sumDiff += d
      if (d > maxDiff) { maxDiff = d; worst = { x: +x.toFixed(2), z: +z.toFixed(2), yA: +yA.toFixed(5), yB: +yB.toFixed(5) } }
    }
  }
  diffs.sort((a, b) => a - b)
  const p95 = diffs.length ? diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * 0.95))] : 0
  const basis = sharedRange ? rangeMax - rangeMin : null
  log('SEAM', JSON.stringify({
    experiment, cellsOffset, parity: cellsOffset % 2 === 0 ? 'even' : 'odd',
    points: n,
    rangeA: +SA.range.toFixed(4), rangeB: +SB.range.toFixed(4),
    quantStepA: +(SA.range / 65535).toFixed(7), quantStepB: +(SB.range / 65535).toFixed(7),
    sharedBasis: basis === null ? null : +(basis / 65535).toFixed(7),
    sharedSampleMaxDiffM: +sharedSampleMaxDiff.toFixed(6),
    seamMaxDiffM: +maxDiff.toFixed(6),
    seamMeanDiffM: +(n ? sumDiff / n : 0).toFixed(6),
    seamP95DiffM: +p95.toFixed(6),
    worst,
  }))
  physics.removeBody(bodyA); physics.removeBody(bodyB)
  return { experiment, cellsOffset, maxDiff, meanDiff: n ? sumDiff / n : 0 }
}

const offsets = CELLS || (extent <= 300 ? [110, 111, 112, 113, 114, 115, 116] : [112, 113, 114, 115])
const results = []
for (const exp of EXPERIMENTS) {
  for (const off of offsets) {
    if (exp === 'identical' && off !== offsets[0]) continue
    results.push(await seamProbe(off, exp))
  }
}
for (const exp of EXPERIMENTS) {
  const rows = results.filter(r => r.experiment === exp)
  const mx = Math.max(...rows.map(r => r.maxDiff))
  const mn = rows.reduce((a, r) => a + r.meanDiff, 0) / rows.length
  log('SUMMARY', JSON.stringify({ experiment: exp, probes: rows.length, worstMaxDiffM: +mx.toFixed(6), meanOfMeanDiffM: +mn.toFixed(6) }))
}
physics.destroy()
process.exit(0)
