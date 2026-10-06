#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeIO } from '@gltf-transform/core'
import { KHRDracoMeshCompression, EXTTextureWebP } from '@gltf-transform/extensions'
import { detectDraco } from './glb-processor.js'

const require = createRequire(import.meta.url)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const prepScript = path.join(repoRoot, 'scripts/prep-edge-collider-assets.mjs')

let failures = 0
function expect(cond, msg) {
  if (cond) {
    console.log(`[edge-collider-draco-witness] ok   ${msg}`)
    return
  }
  failures += 1
  console.log(`[edge-collider-draco-witness] FAIL ${msg}`)
}

function fnv1a(view) {
  let h = 0x811c9dc5
  for (let i = 0; i < view.length; i += 1) {
    h ^= view[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function hashArray(arr) {
  return fnv1a(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength))
}

let ioPromise = null
function getIO() {
  if (!ioPromise) {
    ioPromise = (async () => {
      const draco3d = require('draco3d')
      const [decoderModule, encoderModule] = await Promise.all([
        draco3d.createDecoderModule(),
        draco3d.createEncoderModule(),
      ])
      return new NodeIO()
        .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP])
        .registerDependencies({ 'draco3d.decoder': decoderModule, 'draco3d.encoder': encoderModule })
    })()
  }
  return ioPromise
}

async function measure(absPath) {
  const io = await getIO()
  const doc = await io.readBinary(new Uint8Array(readFileSync(absPath)))
  const root = doc.getRoot()
  const primitives = []
  let vertices = 0
  let triangles = 0
  let materials = 0
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION')
      const indices = prim.getIndices()
      const vertexCount = position ? position.getCount() : 0
      const triangleCount = indices ? Math.floor(indices.getCount() / 3) : Math.floor(vertexCount / 3)
      vertices += vertexCount
      triangles += triangleCount
      const attributes = {}
      for (const semantic of prim.listSemantics()) {
        attributes[semantic] = hashArray(prim.getAttribute(semantic).getArray())
      }
      if (indices) attributes.INDICES = hashArray(indices.getArray())
      primitives.push({ vertexCount, triangleCount, attributes })
    }
  }
  materials = root.listMaterials().length
  const textures = root.listTextures().map((tex) => {
    const bytes = tex.getImage()
    return bytes ? fnv1a(new Uint8Array(bytes)) : 'no-image'
  })
  return { vertices, triangles, materials, primitives, textures }
}

function runPrep(args) {
  const res = spawnSync(process.execPath, [prepScript, ...args], { cwd: repoRoot, encoding: 'utf8' })
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim()
  if (out) console.log(out)
  return res.status
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const relTargets = argv.length ? argv : ['apps/tps-game/cleetus.glb', 'apps/tps-game/schwust.glb']
  const targets = relTargets.map((rel) => ({ rel, abs: path.resolve(repoRoot, rel) }))

  const redStatus = runPrep(['--check'])
  expect(redStatus !== 0, `baseline prep-edge-collider-assets --check is red before the strip (exit ${redStatus})`)

  const before = []
  for (const { rel, abs } of targets) {
    const buf = readFileSync(abs)
    expect(detectDraco(buf), `${rel} is Draco-compressed before the strip`)
    before.push({ rel, abs, size: statSync(abs).size, metrics: await measure(abs) })
  }

  const stripStatus = runPrep([path.dirname(targets[0].rel)])
  expect(stripStatus === 0, `prep-edge-collider-assets (strip) exits 0 (exit ${stripStatus})`)

  for (const entry of before) {
    const { rel, abs, metrics } = entry
    const afterSize = statSync(abs).size
    const after = await measure(abs)
    const rel2 = rel.replace(/\\/g, '/')
    expect(!detectDraco(readFileSync(abs)), `${rel2} no longer declares KHR_draco_mesh_compression`)
    expect(
      after.vertices === metrics.vertices,
      `${rel2} vertex count unchanged: ${metrics.vertices} -> ${after.vertices}`
    )
    expect(
      after.triangles === metrics.triangles,
      `${rel2} triangle count unchanged: ${metrics.triangles} -> ${after.triangles}`
    )
    expect(
      after.materials === metrics.materials,
      `${rel2} material count unchanged: ${metrics.materials} -> ${after.materials}`
    )
    expect(
      after.primitives.length === metrics.primitives.length,
      `${rel2} primitive count unchanged: ${metrics.primitives.length} -> ${after.primitives.length}`
    )
    let geometryMatch = after.primitives.length === metrics.primitives.length
    for (let i = 0; i < metrics.primitives.length && geometryMatch; i += 1) {
      const a = metrics.primitives[i]
      const b = after.primitives[i]
      const aKeys = Object.keys(a.attributes).sort()
      const bKeys = Object.keys(b.attributes).sort()
      if (aKeys.join(',') !== bKeys.join(',')) geometryMatch = false
      else geometryMatch = aKeys.every((k) => a.attributes[k] === b.attributes[k])
    }
    expect(geometryMatch, `${rel2} every vertex attribute and index buffer is bit-identical after decompression`)
    const texturesMatch =
      after.textures.length === metrics.textures.length &&
      after.textures.every((h, i) => h === metrics.textures[i])
    expect(
      texturesMatch,
      `${rel2} all ${metrics.textures.length} texture payloads bit-identical (${metrics.textures.join(' ')})`
    )
    console.log(
      `[edge-collider-draco-witness] size ${rel2}: ${(entry.size / 1024).toFixed(0)}KB -> ${(afterSize / 1024).toFixed(0)}KB (${(((afterSize - entry.size) / entry.size) * 100).toFixed(1)}%), ${metrics.vertices} verts / ${metrics.triangles} tris`
    )
  }

  const greenStatus = runPrep(['--check'])
  expect(greenStatus === 0, `prep-edge-collider-assets --check exits 0 on the stripped tree (exit ${greenStatus})`)

  console.log(`[edge-collider-draco-witness] RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s))`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('[edge-collider-draco-witness] FAILED:', err)
  console.log('[edge-collider-draco-witness] RESULT: FAIL')
  process.exitCode = 1
})
