import { readFileSync, readdirSync } from 'node:fs'
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
    h.update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
  }
  const version = h.digest('hex').slice(0, 12)
  _cache.set(cacheKey, version)
  return version
}

export const BAKE_INPUTS_GLB_TRANSFORM = [
  './GLBTransformer.js',
  './GLBDraco.js',
  './GLBKtx2.js',
  './GLBVrmPassthrough.js',
  '../shared/fnv1a.js',
]

export const BAKE_INPUTS_KTX2_EXTRACT = [
  './KTX2Extract.js',
  './GLBTransformer.js',
  './GLBDraco.js',
  './GLBKtx2.js',
  './GLBVrmPassthrough.js',
  '../shared/fnv1a.js',
]

export const BAKE_INPUTS_PROGRESSIVE_BAKE = [
  '../../packages/streaming-gltf/tools/bake-cluster.mjs',
  '../../packages/streaming-gltf/src/meshlet-codec.js',
  '../../packages/streaming-gltf/src/degenerate-triangles.js',
  '../../packages/streaming-gltf/src/cluster-lod-mesh.js',
  '../../packages/streaming-gltf/src/material-convergence.js',
]

function presetInputs() {
  const dir = resolvePath(_thisDir, '../../src/presets')
  let names
  try { names = readdirSync(dir) } catch { return [] }
  return names.filter(n => n.endsWith('.js')).sort().map(n => `../../src/presets/${n}`)
}

export const BAKE_INPUTS_MINIMAP_BAKE = [
  '../../scripts/bake-minimap.mjs',
  '../terrain/PlanetFrame.js',
  '../shared/terrainConfig.js',
  '../shared/MinimapBiome.js',
  '../../packages/mapspinner/src/height-cpu.js',
  '../../packages/mapspinner/src/height-gen.js',
  '../../packages/mapspinner/src/shaders/terrain.glsl',
  '../../packages/mapspinner/scripts/gen-height.mjs',
  '../../packages/mapspinner/src/anchor-field.js',
  '../../packages/mapspinner/src/anchor-field-bands.js',
  '../../packages/mapspinner/src/tsl/height-spec.js',
  '../../packages/mapspinner/src/tsl/ops-js.js',
  '../../packages/mapspinner/src/tsl/ops-jsgen.js',
  '../../packages/mapspinner/src/glsl-rt.js',
  '../../packages/mapspinner/src/terrain-defaults.js',
  '../shared/canonicalJSON.js',
  '../shared/fnv1a.js',
  '../shared/worldName.js',
  '../shared/worldPresets.js',
  '../sdk/WorldLocator.js',
  ...presetInputs(),
]

export const BAKE_INPUTS_HEIGHTFIELD_BAKE = [
  '../../scripts/bake-heightfield.mjs',
  '../../scripts/lib/gpu-eval.mjs',
  '../terrain/PlanetFrame.js',
  '../sdk/WorldLocator.js',
  '../shared/terrainConfig.js',
  '../shared/canonicalJSON.js',
  '../shared/fnv1a.js',
  '../shared/worldName.js',
  '../shared/worldPresets.js',
  '../../packages/mapspinner/src/anchor-field.js',
  '../../packages/mapspinner/src/anchor-field-bands.js',
  '../../packages/mapspinner/src/glsl-rt.js',
  '../../packages/mapspinner/src/height-cpu.js',
  '../../packages/mapspinner/src/height-gen.js',
  '../../packages/mapspinner/src/shaders/terrain.glsl',
  '../../packages/mapspinner/scripts/gen-height.mjs',
  '../../packages/mapspinner/src/heightfield-codec.js',
  '../../packages/mapspinner/src/terrain-defaults.js',
  '../../packages/mapspinner/src/tsl/height-spec.js',
  '../../packages/mapspinner/src/tsl/ops-jsgen.js',
  ...presetInputs(),
]

export const BAKE_INPUTS_COLLISION_GRID = [
  '../apps/AppRuntimeTick.js',
  '../apps/AppRuntimeStaticMotion.js',
]

export const BAKE_INPUTS_SNAPSHOT_ENCODE = [
  '../apps/AppRuntime.js',
  '../apps/EcsEntityMap.js',
]

export const BAKE_INPUTS_SNAPSHOT_ENTITY_ENC = [
  '../netcode/SnapshotBinFormat.js',
  '../netcode/SnapshotEncoder.js',
  '../shared/fnv1a.js',
  '../protocol/ComponentSchema.js',
  '../shared/groundNormalWire.js',
  '../shared/wallPlaneWire.js',
]

export const COLLISION_GRID_CODE_VERSION_SOURCE = bakeCodeVersion(BAKE_INPUTS_COLLISION_GRID)

export const SNAPSHOT_ENCODE_CODE_VERSION_SOURCE = bakeCodeVersion(BAKE_INPUTS_SNAPSHOT_ENCODE)

export const SNAPSHOT_ENTITY_ENC_CODE_VERSION_SOURCE = bakeCodeVersion(BAKE_INPUTS_SNAPSHOT_ENTITY_ENC)

export const GLB_TRANSFORM_CODE_VERSION = bakeCodeVersion(BAKE_INPUTS_GLB_TRANSFORM)

export const PROGRESSIVE_BAKE_CODE_VERSION = bakeCodeVersion(BAKE_INPUTS_PROGRESSIVE_BAKE)

export const KTX2_EXTRACT_CODE_VERSION = bakeCodeVersion(BAKE_INPUTS_KTX2_EXTRACT)

export const MINIMAP_BAKE_CODE_VERSION = bakeCodeVersion(BAKE_INPUTS_MINIMAP_BAKE)

export const HEIGHTFIELD_BAKE_CODE_VERSION = bakeCodeVersion(BAKE_INPUTS_HEIGHTFIELD_BAKE)

export const BAKE_TRANSFORMS = [
  { name: 'GLB_TRANSFORM', entries: ['./GLBTransformer.js'], inputs: BAKE_INPUTS_GLB_TRANSFORM, version: GLB_TRANSFORM_CODE_VERSION },
  { name: 'KTX2_EXTRACT', entries: ['./KTX2Extract.js'], inputs: BAKE_INPUTS_KTX2_EXTRACT, version: KTX2_EXTRACT_CODE_VERSION },
  { name: 'PROGRESSIVE_BAKE', entries: ['../../packages/streaming-gltf/tools/bake-cluster.mjs'], inputs: BAKE_INPUTS_PROGRESSIVE_BAKE, version: PROGRESSIVE_BAKE_CODE_VERSION },
  { name: 'MINIMAP_BAKE', entries: ['../../scripts/bake-minimap.mjs'], inputs: BAKE_INPUTS_MINIMAP_BAKE, version: MINIMAP_BAKE_CODE_VERSION },
  { name: 'HEIGHTFIELD_BAKE', entries: ['../../scripts/bake-heightfield.mjs'], inputs: BAKE_INPUTS_HEIGHTFIELD_BAKE, version: HEIGHTFIELD_BAKE_CODE_VERSION },
  { name: 'COLLISION_GRID', entries: ['../apps/AppRuntimeTick.js'], inputs: BAKE_INPUTS_COLLISION_GRID, version: COLLISION_GRID_CODE_VERSION_SOURCE },
  { name: 'SNAPSHOT_ENCODE', entries: ['../apps/EcsEntityMap.js'], inputs: BAKE_INPUTS_SNAPSHOT_ENCODE, version: SNAPSHOT_ENCODE_CODE_VERSION_SOURCE },
  { name: 'SNAPSHOT_ENTITY_ENC', entries: ['../netcode/SnapshotEncoder.js'], inputs: BAKE_INPUTS_SNAPSHOT_ENTITY_ENC, version: SNAPSHOT_ENTITY_ENC_CODE_VERSION_SOURCE }
]
