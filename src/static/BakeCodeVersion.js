// Shared code-version-hash helper for every disk cache in the asset-bake pipeline
// (GLBTransformer.js, KTX2Extract.js, ProgressiveBake.js). A cache keyed only on the
// SOURCE file's content/mtime cannot detect that the TRANSFORM code itself changed --
// see AGENTS.md project/degenerate-triangle-threshold-is-not-a-tunable-guess and this
// file's own callers' comments for the live incident this closes: a real fix to
// packages/streaming-gltf's bake pipeline kept appearing to "not take effect" because
// on-disk .progressive-cache/.glb-cache/.ktx2-cache entries baked before the fix were
// never invalidated, since nothing in their cache key depended on the code that
// produced them. Each cache site declares the exact source files its own transform
// reads (including cross-package dependencies) and gets back a stable hash that
// changes automatically whenever any of them changes -- no version constant to
// remember to bump by hand.

import { readFileSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const _thisDir = dirname(fileURLToPath(import.meta.url))
const _cache = new Map() // cacheKey (files.join) -> version string

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

export const KTX2_EXTRACT_CODE_VERSION = bakeCodeVersion([
  './KTX2Extract.js',
  './GLBTransformer.js',
  './GLBDraco.js',
  './GLBKtx2.js',
])
