#!/usr/bin/env node
import { readFileSync, statSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
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

async function encodeDraco(absPath) {
  const io = await getIO()
  const doc = await io.readBinary(new Uint8Array(readFileSync(absPath)))
  doc.createExtension(KHRDracoMeshCompression)
    .setRequired(true)
    .setEncoderOptions({ method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER })
  writeFileSync(absPath, await io.writeBinary(doc))
}

function runPrep(args) {
  const res = spawnSync(process.execPath, [prepScript, ...args], { cwd: repoRoot, encoding: 'utf8' })
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim()
  if (out) console.log(out)
  return res.status
}

const SCRATCH_REL = 'scripts/.scratch_edge-collider-draco'
const scratch = path.resolve(repoRoot, SCRATCH_REL)

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const relTargets = argv.length ? argv : ['apps/tps-game/cleetus.glb', 'apps/tps-game/schwust.glb']
  const targets = relTargets.map((rel) => ({ rel, abs: path.resolve(repoRoot, rel) }))

  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  let ignored = false
  try {
    execFileSync('git', ['check-ignore', '-q', SCRATCH_REL], { cwd: repoRoot })
    ignored = true
  } catch (e) {
    ignored = false
  }
  expect(ignored, `the scratch directory ${SCRATCH_REL} is itself ignored, so a strip run can never dirty the tree even if it is interrupted`)
  try {
    const before = []
    for (const { rel, abs } of targets) {
      const scratchAbs = path.join(scratch, path.basename(rel))
      writeFileSync(scratchAbs, readFileSync(abs))
      await encodeDraco(scratchAbs)
      const bytes = readFileSync(scratchAbs)
      if (!detectDraco(bytes)) {
        expect(false, `${rel.replace(/\\/g, '/')} could not be Draco-compressed into the scratch fixture, so this witness has no compressed input to decompress`)
        continue
      }
      before.push({ rel, size: bytes.length, scratchAbs, metrics: await measure(scratchAbs) })
    }

    const redStatus = runPrep(['--check', scratch])
    expect(redStatus !== 0, `baseline prep-edge-collider-assets --check is red on the scratch fixture before the strip (exit ${redStatus})`)

    const stripStatus = runPrep([scratch])
    expect(stripStatus === 0, `prep-edge-collider-assets (strip) exits 0 (exit ${stripStatus})`)

    let rewritten = 0
    for (const entry of before) {
      const { rel, metrics, scratchAbs } = entry
      const afterSize = statSync(scratchAbs).size
      const after = await measure(scratchAbs)
      const rel2 = rel.replace(/\\/g, '/')
      const stripped = !detectDraco(readFileSync(scratchAbs))
      if (stripped) rewritten += 1
      expect(stripped, `${rel2} no longer declares KHR_draco_mesh_compression`)
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
    expect(rewritten === before.length, `the strip rewrote ${rewritten} of ${before.length} Draco GLB(s), so the counted unit did not cover every target`)

    const greenStatus = runPrep(['--check', scratch])
    expect(greenStatus === 0, `prep-edge-collider-assets --check exits 0 on the stripped scratch copy (exit ${greenStatus})`)

    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'apps'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    expect(dirty === '', `the strip rewrites only the scratch copy, so the tracked tree stays clean: git status --porcelain -- apps reads "${dirty}"`)
    let trackedDiff = ''
    try {
      execFileSync('git', ['diff', '--exit-code', '--', ...relTargets], { cwd: repoRoot, encoding: 'utf8' })
    } catch (e) {
      trackedDiff = `${e.stdout || ''}${e.stderr || ''}`.trim()
    }
    expect(trackedDiff === '', `git diff on the tracked GLB(s) is empty after a run: ${trackedDiff || 'clean'}`)
    console.log(`[edge-collider-draco-witness] ${rewritten} of ${before.length} GLB(s) rewritten under ${SCRATCH_REL}, 0 byte(s) written into the tracked tree`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  let scratchLeft = true
  try { scratchLeft = statSync(scratch).isDirectory() } catch (e) { scratchLeft = false }
  expect(!scratchLeft, `the scratch directory is deleted at the end of the run, so a gate can run this witness repeatedly`)

  console.log(`[edge-collider-draco-witness] RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s))`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('[edge-collider-draco-witness] FAILED:', err)
  console.log('[edge-collider-draco-witness] RESULT: FAIL')
  process.exitCode = 1
})
