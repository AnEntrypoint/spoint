#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Document, NodeIO } from '@gltf-transform/core'
import { KHRDracoMeshCompression, EXTTextureWebP, EXTMeshoptCompression } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'

const require = createRequire(import.meta.url)
const MIN_CLOSED_SOLID_TRIS = 4

let _readIO = null
async function getReadIO() {
  if (!_readIO) {
    const draco3d = require('draco3d')
    const decoderModule = await draco3d.createDecoderModule()
    await MeshoptDecoder.ready
    _readIO = new NodeIO()
      .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP, EXTMeshoptCompression])
      .registerDependencies({ 'draco3d.decoder': decoderModule, 'meshopt.decoder': MeshoptDecoder })
  }
  return _readIO
}

function parseArgs(argv) {
  const pos = []
  const opts = { pieces: 12, seed: 1 }
  for (const a of argv) {
    if (a.startsWith('--pieces=')) opts.pieces = Math.max(2, parseInt(a.slice(9), 10) || 12)
    else if (a.startsWith('--seed=')) opts.seed = parseInt(a.slice(7), 10) || 1
    else pos.push(a)
  }
  return { input: pos[0], output: pos[1], ...opts }
}


import { mulberry32, v3, hullAABB, scatterSeeds, setScale, fractureCell } from './fracture-geometry.mjs'

async function loadSourceVertices(inputPath) {
  const io = await getReadIO()
  const doc = await io.read(inputPath)
  const root = doc.getRoot()
  const verts = []
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION')
      if (!posAcc) continue
      const arr = posAcc.getArray()
      const count = posAcc.getCount()
      for (let i = 0; i < count; i++) verts.push([arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]])
    }
  }
  if (verts.length < 4) throw new Error(`[fracture-glb] source GLB has fewer than 4 vertices (${verts.length}) -- cannot form a volume to fracture`)
  return verts
}

async function computeHull(vertsArr) {
  const THREE = await import('three')
  const { ConvexHull } = await import('three/examples/jsm/math/ConvexHull.js')
  const points = vertsArr.map(([x, y, z]) => new THREE.Vector3(x, y, z))
  const hull = new ConvexHull().setFromPoints(points)
  const faces = []
  for (const face of hull.faces) {
    const poly = []
    let edge = face.edge
    do { poly.push([edge.head().point.x, edge.head().point.y, edge.head().point.z]); edge = edge.next } while (edge !== face.edge)
    const n = [face.normal.x, face.normal.y, face.normal.z]
    faces.push({ poly, normal: n, constant: face.constant })
  }
  return faces
}

function faceSoupToTriangles(soup) {
  const positions = [], normals = []
  for (const f of soup) {
    const poly = f.poly
    if (poly.length < 3) continue
    let nx = 0, ny = 0, nz = 0
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      nx += (a[1] - b[1]) * (a[2] + b[2])
      ny += (a[2] - b[2]) * (a[0] + b[0])
      nz += (a[0] - b[0]) * (a[1] + b[1])
    }
    const n = v3.normalize([nx, ny, nz])
    for (let k = 1; k < poly.length - 1; k++) {
      positions.push(...poly[0], ...poly[k], ...poly[k + 1])
      normals.push(...n, ...n, ...n)
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), triCount: positions.length / 9 }
}

function cellVolumeAndCentroid(soup) {
  let vol = 0, cx = 0, cy = 0, cz = 0
  for (const f of soup) {
    const poly = f.poly
    for (let k = 1; k < poly.length - 1; k++) {
      const a = poly[0], b = poly[k], c = poly[k + 1]
      const sixV = v3.dot(a, v3.cross(b, c))
      vol += sixV
      cx += (a[0] + b[0] + c[0]) * sixV
      cy += (a[1] + b[1] + c[1]) * sixV
      cz += (a[2] + b[2] + c[2]) * sixV
    }
  }
  const v = Math.abs(vol) / 6
  if (Math.abs(vol) < 1e-12) return { volume: 0, centroid: [0, 0, 0] }
  return { volume: v, centroid: [cx / (4 * vol), cy / (4 * vol), cz / (4 * vol)] }
}

export async function _debugInternals() { return { loadSourceVertices, computeHull, scatterSeeds, fractureCell, faceSoupToTriangles, cellVolumeAndCentroid, mulberry32, hullAABB, setScale } }

async function main() {
  const { input, output, pieces, seed } = parseArgs(process.argv.slice(2))
  if (!input || !output) {
    console.error('Usage: node scripts/fracture-glb.mjs <input.glb> <output.glb> [--pieces=12] [--seed=1]')
    process.exit(1)
  }

  console.log(`[fracture-glb] loading ${input}`)
  const srcVerts = await loadSourceVertices(input)
  console.log(`[fracture-glb] ${srcVerts.length} source vertices`)

  console.log('[fracture-glb] computing convex hull')
  const hullFaces = await computeHull(srcVerts)
  console.log(`[fracture-glb] hull has ${hullFaces.length} faces`)

  const { min: aabbMin, max: aabbMax } = hullAABB(hullFaces)
  const diagonal = Math.hypot(aabbMax[0] - aabbMin[0], aabbMax[1] - aabbMin[1], aabbMax[2] - aabbMin[2])
  setScale(diagonal)
  console.log(`[fracture-glb] hull bounding diagonal = ${diagonal.toFixed(3)} units (tolerances scaled accordingly)`)

  const rng = mulberry32(seed)
  console.log(`[fracture-glb] scattering ${pieces} seeds (seed=${seed})`)
  const seeds = scatterSeeds(hullFaces, pieces, rng)
  console.log(`[fracture-glb] placed ${seeds.length} seeds`)

  const doc = new Document()
  const buffer = doc.createBuffer()
  const rootNode = doc.createNode('fractured_root')
  const scene = doc.createScene('fracture')
  scene.addChild(rootNode)

  const piecesMeta = []
  let totalVolume = 0, emptyCells = 0, degenerateCells = 0

  for (let i = 0; i < seeds.length; i++) {
    let soup
    try {
      soup = fractureCell(hullFaces, seeds, i)
    } catch (e) {
      console.warn(`[fracture-glb] cell ${i} dropped: ${e.message}`)
      degenerateCells++
      continue
    }
    if (!soup.length) { emptyCells++; continue }
    const { positions, normals, triCount } = faceSoupToTriangles(soup)
    if (triCount < MIN_CLOSED_SOLID_TRIS) { emptyCells++; continue }
    const { volume, centroid } = cellVolumeAndCentroid(soup)
    totalVolume += volume

    const posAcc = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer)
    const normAcc = doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer)
    const prim = doc.createPrimitive().setAttribute('POSITION', posAcc).setAttribute('NORMAL', normAcc)
    const mesh = doc.createMesh(`piece_${i}`).addPrimitive(prim)
    const node = doc.createNode(`piece_${i}`).setMesh(mesh).setTranslation([0, 0, 0])
    node.setExtras({ EP_fracture_piece: { index: i, centroid, volume, triCount, seed: seeds[i] } })
    rootNode.addChild(node)

    piecesMeta.push({ index: i, centroid, volume, triCount, vertexCount: positions.length / 3 })
  }

  doc.getRoot().setDefaultScene(scene)
  doc.getRoot().setExtras({
    EP_fracture: {
      version: 1,
      sourceFile: input,
      pieceCount: piecesMeta.length,
      requestedPieces: pieces,
      emptyCells,
      degenerateCells,
      seedRng: seed,
      totalVolume
    }
  })

  const io = new NodeIO()
  const outBytes = await io.writeBinary(doc)
  writeFileSync(output, outBytes)
  writeFileSync(output.replace(/\.glb$/i, '') + '.pieces.json', JSON.stringify({ pieceCount: piecesMeta.length, emptyCells, degenerateCells, totalVolume, pieces: piecesMeta }, null, 2))

  console.log(`[fracture-glb] wrote ${output} (${piecesMeta.length} pieces, ${emptyCells} empty cells, ${degenerateCells} degenerate/unrepairable cells dropped, totalVolume=${totalVolume.toFixed(4)})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[fracture-glb] FAILED:', e.stack || e.message); process.exit(1) })
}
