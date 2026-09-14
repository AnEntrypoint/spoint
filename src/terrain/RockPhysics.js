import { placementsForRockChunk, ROCK } from './RockPlacement.js'
import { generateRockHullData } from './RockShapes.js'
import { createColliderStreamer } from './ColliderStreamer.js'

const ROCK_BASE_SEED = 1337
const PHYS_MAX = 3.5
const BUCKETS = [2.0, 2.5, 3.0, 3.5]

function bucketOf(scale) {
  const s = Math.min(PHYS_MAX, scale)
  let bi = 0
  for (let i = BUCKETS.length - 1; i >= 0; i--) { if (s >= BUCKETS[i]) { bi = i; break } }
  return bi
}

export function createRockColliderStreamer(opts = {}) {
  const baseHulls = generateRockHullData(ROCK.TYPES, ROCK_BASE_SEED, 12)
  const hulls = baseHulls.map(h => BUCKETS.map(bs => {
    const out = new Float32Array(h.positions.length)
    for (let i = 0; i < h.positions.length; i++) out[i] = h.positions[i] * bs
    return out
  }))

  const streamer = createColliderStreamer({
    physics: opts.physics,
    getCenter: opts.getCenter,
    getCenters: opts.getCenters,
    frame: opts.frame,
    anchorField: opts.anchorField || null,
    worldSeed: opts.worldSeed | 0,
    radius: Number.isFinite(opts.radius) && opts.radius > 0 ? opts.radius : 32,
    intervalMs: opts.intervalMs,
    rebuildAt: opts.rebuildAt,
    cap: Number.isFinite(opts.cap) && opts.cap > 0 ? opts.cap : 128,
    byteBudget: opts.byteBudget,
    maxCenters: opts.maxCenters,
    bodiesPerChunk: opts.bodiesPerChunk,
    chunkSize: ROCK.CHUNK,
    idField: 'rockId',
    logTag: '[rocks]',
    placementsFor: placementsForRockChunk,
    setColliderIds: (ids) => opts.physics.setRockColliderIds(ids),
    bodyArgs: (p) => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
      const type = p.type % ROCK.TYPES, bucket = bucketOf(p.scale)
      return { shape: 'convex', args: hulls[type][bucket], position: [p.x, p.y, p.z], rotation: p.tiltQuat, shapeKey: 'rock' + type + '_' + bucket }
    },
    prewarm: (physics, cap) => {
      const perKey = Math.max(6, Math.ceil(cap / (ROCK.TYPES * BUCKETS.length)))
      for (let type = 0; type < ROCK.TYPES; type++) {
        for (let b = 0; b < BUCKETS.length; b++) {
          physics.preallocatePool('convex', hulls[type][b], 'rock' + type + '_' + b, perKey)
        }
      }
    },
  })

  return { ...streamer, _bucketOf: bucketOf }
}
