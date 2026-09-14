import { placementsForChunk, VEG, SPECIES } from './VegPlacement.js'
import { createColliderStreamer } from './ColliderStreamer.js'

export const TRUNK = Object.freeze([
  { r: 0.35, h: 3.2 },
  { r: 0.28, h: 4.0 },
  { r: 0.30, h: 3.4 },
  { r: 0.33, h: 3.6 },
  { r: 0.22, h: 1.2 },
  { r: 0.24, h: 2.6 },
  { r: 0.40, h: 4.4 },
  { r: 0.22, h: 2.4 },
  { r: 0.38, h: 4.6 },
  { r: 0.24, h: 1.3 },
  { r: 0.26, h: 1.4 },
  { r: 0.26, h: 2.2 },
  { r: 0.30, h: 2.7 },
  { r: 0.22, h: 2.8 },
  { r: 0.34, h: 5.2 },
])

export const TRUNK_SCALE_BUCKETS = Object.freeze([0.8, 0.9, 1.0, 1.1, 1.2])
export function trunkScaleBucket(scale) {
  let bi = 0, best = Infinity
  for (let i = 0; i < TRUNK_SCALE_BUCKETS.length; i++) { const d = Math.abs(TRUNK_SCALE_BUCKETS[i] - scale); if (d < best) { best = d; bi = i } }
  return bi
}
export function trunkShapeKey(species, bucket) { return 'tk' + species + '_' + bucket }

export function createTrunkColliderStreamer(opts = {}) {
  return createColliderStreamer({
    physics: opts.physics,
    getCenter: opts.getCenter,
    getCenters: opts.getCenters,
    frame: opts.frame,
    anchorField: opts.anchorField || null,
    worldSeed: opts.worldSeed | 0,
    radius: Number.isFinite(opts.radius) && opts.radius > 0 ? opts.radius : 64,
    intervalMs: opts.intervalMs,
    rebuildAt: opts.rebuildAt,
    cap: Number.isFinite(opts.cap) && opts.cap > 0 ? opts.cap : 384,
    byteBudget: opts.byteBudget,
    maxCenters: opts.maxCenters,
    bodiesPerChunk: opts.bodiesPerChunk,
    chunkSize: VEG.CHUNK,
    idField: 'trunkId',
    logTag: '[veg]',
    placementsFor: placementsForChunk,
    setColliderIds: (ids) => opts.physics.setTrunkColliderIds(ids),
    bodyArgs: (p) => {
      const t = TRUNK[p.species] || TRUNK[0]
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
      const bi = trunkScaleBucket(p.scale), bs = TRUNK_SCALE_BUCKETS[bi]
      const r = t.r * bs, halfH = (t.h * bs) / 2
      return { shape: 'box', args: [r, halfH, r], position: [p.x, p.y + halfH, p.z], rotation: p.tiltQuat, shapeKey: trunkShapeKey(p.species, bi) }
    },
    prewarm: (physics, cap) => {
      const perKey = Math.max(8, Math.ceil(cap / (SPECIES.length * TRUNK_SCALE_BUCKETS.length)))
      for (let s = 0; s < SPECIES.length; s++) {
        const t = TRUNK[s] || TRUNK[0]
        for (let bi = 0; bi < TRUNK_SCALE_BUCKETS.length; bi++) {
          const bs = TRUNK_SCALE_BUCKETS[bi]
          physics.preallocatePool('box', [t.r * bs, (t.h * bs) / 2, t.r * bs], trunkShapeKey(s, bi), perKey)
        }
      }
    },
  })
}
