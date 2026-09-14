import { readFileSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const _thisDir = dirname(fileURLToPath(import.meta.url))
const _cache = new Map()

export function bakeCodeVersion(relFiles) {
  const cacheKey = relFiles.join('|')
  const cached = _cache.get(cacheKey)
  if (cached) return cached
  const h = createHash('sha1')
  for (const rel of relFiles) {
    const p = resolvePath(_thisDir, rel)
    h.update(rel)
    h.update(readFileSync(p))
  }
  const version = h.digest('hex').slice(0, 12)
  _cache.set(cacheKey, version)
  return version
}

export const GLB_TRANSFORM_CODE_VERSION = bakeCodeVersion([
  './GLBTransformer.js',
  './GLBDraco.js',
  './GLBKtx2.js',
])

export const PROGRESSIVE_BAKE_CODE_VERSION = bakeCodeVersion([
  '../../packages/streaming-gltf/tools/bake-cluster.mjs',
  '../../packages/streaming-gltf/src/meshlet-codec.js',
  '../../packages/streaming-gltf/src/degenerate-triangles.js',
  '../../packages/streaming-gltf/src/cluster-lod-mesh.js',
  '../../packages/streaming-gltf/src/material-convergence.js',
])

export const KTX2_EXTRACT_CODE_VERSION = bakeCodeVersion([
  './KTX2Extract.js',
  './GLBTransformer.js',
  './GLBDraco.js',
  './GLBKtx2.js',
])
