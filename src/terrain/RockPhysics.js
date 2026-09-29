import {
  placementsForRockChunk, ROCK, ROCK_SCALE_TABLE, ROCK_SQUASH_TABLE, ROCK_SCALE_LEVELS as SCALE_LEVELS,
  ROCK_SQUASH_LEVELS as SQUASH_LEVELS, rockScaleLevel, rockSquashLevel,
} from './RockPlacement.js'
import { generateRockHullData, ROCK_MESH_RES } from './RockShapes.js'
import { createColliderStreamer } from './ColliderStreamer.js'

const ROCK_BASE_SEED = 1337
const VARIANTS_PER_TYPE = SCALE_LEVELS * SQUASH_LEVELS
const PREWARM_BODY_BUDGET = 540
export const ROCK_PREWARM_PER_KEY = Math.floor(PREWARM_BODY_BUDGET / (ROCK.TYPES * VARIANTS_PER_TYPE))
const PREWARM_PER_KEY = ROCK_PREWARM_PER_KEY

export function rockBodyQuat(tiltQuat, yaw) {
  const tx = tiltQuat[0], ty = tiltQuat[1], tz = tiltQuat[2], tw = tiltQuat[3]
  const s = Math.sin(yaw * 0.5), c = Math.cos(yaw * 0.5)
  return [tx * c - tz * s, tw * s + ty * c, tz * c + tx * s, tw * c - ty * s]
}

export function createRockColliderVariants() {
  return generateRockHullData(ROCK.TYPES, ROCK_BASE_SEED, ROCK_MESH_RES).map(h => {
    const variants = new Array(VARIANTS_PER_TYPE)
    const src = h.positions, indices = h.indices.slice()
    for (let si = 0; si < SCALE_LEVELS; si++) {
      const sx = ROCK_SCALE_TABLE[si]
      for (let qi = 0; qi < SQUASH_LEVELS; qi++) {
        const sy = sx * ROCK_SQUASH_TABLE[qi]
        const out = new Float32Array(src.length)
        for (let i = 0; i < src.length; i += 3) {
          out[i] = src[i] * sx
          out[i + 1] = src[i + 1] * sy
          out[i + 2] = src[i + 2] * sx
        }
        variants[si * SQUASH_LEVELS + qi] = { vertices: out, indices }
      }
    }
    return variants
  })
}

function variantShapeKey(type, si, qi) {
  return 'rock' + type + '_' + si + '_' + qi
}

export function createRockColliderStreamer(opts = {}) {
  const variants = createRockColliderVariants()

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
    latticeSpec: ROCK,
    idField: 'rockId',
    logTag: '[rocks]',
    placementsFor: placementsForRockChunk,
    setColliderIds: (ids) => opts.physics.setRockColliderIds(ids),
    bodyArgs: (p) => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
      const type = p.type % ROCK.TYPES
      const si = rockScaleLevel(p.scale), qi = rockSquashLevel(p.squash)
      return {
        shape: 'mesh',
        args: variants[type][si * SQUASH_LEVELS + qi],
        position: [p.x, p.y, p.z],
        rotation: rockBodyQuat(p.tiltQuat, p.yaw),
        shapeKey: variantShapeKey(type, si, qi),
      }
    },
    prewarm: (physics) => {
      for (let type = 0; type < ROCK.TYPES; type++) {
        for (let si = 0; si < SCALE_LEVELS; si++) {
          for (let qi = 0; qi < SQUASH_LEVELS; qi++) {
            physics.preallocatePool('mesh', variants[type][si * SQUASH_LEVELS + qi], variantShapeKey(type, si, qi), PREWARM_PER_KEY)
          }
        }
      }
    },
  })

  return Object.defineProperties(streamer, {
    _variants: { value: variants },
    _prewarmBodies: { value: ROCK.TYPES * VARIANTS_PER_TYPE * PREWARM_PER_KEY },
  })
}
