#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bakeNavmesh } from '../src/pathfinding/RecastIntegration.js'
import { extractAllMeshesFromGLBAsync } from '../src/physics/GLBLoader.js'
import { mat4TRS, applyTransformMatrix } from '../src/physics/GLBMath.js'
import { isWorldName } from '../src/shared/worldName.js'

const sdkRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = process.cwd()
const args = process.argv.slice(2)
const worldName = args.find(a => a.startsWith('--world='))?.slice('--world='.length) || process.env.npm_config_world
const verbose = args.includes('--verbose')

function resolveModel(model) {
  const rel = model.replace(/^\.?\//, '')
  for (const root of [projectRoot, sdkRoot]) { const fp = path.resolve(root, rel); if (fs.existsSync(fp)) return fp }
  throw new Error(`model ${model} not found under ${projectRoot} or ${sdkRoot}`)
}

function worldFile(name) {
  for (const root of [projectRoot, sdkRoot]) { const fp = path.resolve(root, 'apps', 'world', `${name}.js`); if (fs.existsSync(fp)) return fp }
  throw new Error(`world apps/world/${name}.js not found under ${projectRoot} or ${sdkRoot}`)
}

async function collectWalkableGeometry(worldDef) {
  const sources = (worldDef.entities || []).filter(e => typeof e.model === 'string' && /\.glb$/i.test(e.model) && e.config?.collider === 'trimesh')
  if (!sources.length) throw new Error('world has no entities with a .glb model and config.collider "trimesh" -- nothing to bake a navmesh from')
  const parts = []
  let vertexCount = 0, indexCount = 0
  for (const e of sources) {
    const mesh = await extractAllMeshesFromGLBAsync(resolveModel(e.model))
    const m = mat4TRS(e.position || [0, 0, 0], e.rotation || [0, 0, 0, 1], e.scale || [1, 1, 1])
    parts.push({ id: e.id, positions: applyTransformMatrix(mesh.vertices, m), indices: mesh.indices, base: vertexCount })
    vertexCount += mesh.vertexCount
    indexCount += mesh.indices.length
  }
  const positions = new Float32Array(vertexCount * 3), indices = new Uint32Array(indexCount)
  let io = 0
  for (const p of parts) {
    positions.set(p.positions, p.base * 3)
    for (let i = 0; i < p.indices.length; i++) indices[io++] = p.indices[i] + p.base
  }
  return { positions, indices, sources: parts.map(p => `${p.id}: ${p.indices.length / 3} tris`) }
}

async function main() {
  if (!isWorldName(worldName)) throw new Error(`usage: npm run bake-navmesh -- --world=<apps/world file stem>, got ${JSON.stringify(worldName)}`)
  const inputPath = worldFile(worldName)
  const outputPath = path.resolve(projectRoot, 'apps', 'world', `${worldName}.navmesh.json`)
  const worldDef = (await import(pathToFileURL(inputPath).href)).default || {}
  const t0 = performance.now()
  const { positions, indices, sources } = await collectWalkableGeometry(worldDef)
  console.log(`Baking navmesh for ${worldName} from ${sources.join(', ')}`)
  const navmesh = await bakeNavmesh({ positions, indices })
  if (!navmesh.polygons.length) throw new Error('recast produced 0 walkable polygons -- check agent size/slope against the geometry scale')
  fs.writeFileSync(outputPath, JSON.stringify(navmesh))
  const linked = navmesh.links.reduce((n, l) => n + l.neighbors.length, 0)
  console.log(`Wrote ${outputPath}: ${navmesh.vertices.length} vertices, ${navmesh.polygons.length} polygons, ${linked} neighbour links, ${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB, ${Math.round(performance.now() - t0)} ms`)
}

main().catch(e => { console.error(`Navmesh bake failed: ${e.message}`); if (verbose) console.error(e.stack); process.exit(1) })
