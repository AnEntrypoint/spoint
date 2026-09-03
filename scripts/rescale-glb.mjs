#!/usr/bin/env node
// One-off: bake a uniform scale into a GLB's geometry (vertex positions), keeping
// the entity transform at [1,1,1]. Used to bring the aim_sillos stage back to its
// intended human scale (it was authored ~3x too large) without applying a <1
// entity scale. Re-saves in place; the .prog/.glb caches are content-hash keyed so
// the server re-bakes on next load.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { NodeIO } from '@gltf-transform/core'
import { KHRDracoMeshCompression, EXTTextureWebP } from '@gltf-transform/extensions'

const require = createRequire(import.meta.url)
const [, , file, factorArg] = process.argv
if (!file || !factorArg) { console.error('usage: rescale-glb.mjs <file.glb> <factor>'); process.exit(1) }
const factor = parseFloat(factorArg)

// The CS map GLBs carry EXT_texture_webp textures with no `source` and samplers
// with null mag/min filters, both of which crash gltf-transform's GLTFReader.
// Patch the GLB JSON chunk in place before handing it to the reader (same idiom
// as scripts/glb-processor.js patchTextureSources).
function patchGlb(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const jsonLen = view.getUint32(12, true)
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'))
  let changed = false
  for (const tex of json.textures || []) { if (tex.source === undefined) { tex.source = 0; changed = true } }
  for (const s of json.samplers || []) {
    if (s.magFilter == null) { s.magFilter = 9729; changed = true }
    if (s.minFilter == null) { s.minFilter = 9987; changed = true }
  }
  if (!changed) return buf
  const pjStr = JSON.stringify(json)
  const pjPad = (4 - (pjStr.length % 4)) % 4
  const pjBuf = Buffer.alloc(pjStr.length + pjPad, 0x20); Buffer.from(pjStr).copy(pjBuf)
  const binStart = 20 + jsonLen + 8
  const binLen = view.getUint32(20 + jsonLen, true)
  const binBuf = buf.slice(binStart, binStart + binLen)
  const tl = 12 + 8 + pjBuf.length + 8 + binBuf.length
  const out = Buffer.alloc(tl); let p = 0
  out.writeUInt32LE(0x46546C67, p); p+=4; out.writeUInt32LE(2, p); p+=4; out.writeUInt32LE(tl, p); p+=4
  out.writeUInt32LE(pjBuf.length, p); p+=4; out.writeUInt32LE(0x4E4F534A, p); p+=4
  pjBuf.copy(out, p); p+=pjBuf.length
  out.writeUInt32LE(binBuf.length, p); p+=4; out.writeUInt32LE(0x004E4942, p); p+=4; binBuf.copy(out, p)
  return out
}

const draco3d = require('draco3d')
const [decoderModule, encoderModule] = await Promise.all([draco3d.createDecoderModule(), draco3d.createEncoderModule()])
const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP])
  .registerDependencies({ 'draco3d.decoder': decoderModule, 'draco3d.encoder': encoderModule })

const doc = await io.readBinary(patchGlb(readFileSync(file)))
const root = doc.getRoot()

// Measure before
function bounds() {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); if (!pos) continue
      for (let i = 0; i < pos.getCount(); i++) {
        const v = pos.getElement(i, [])
        for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k] }
      }
    }
  return { size: [max[0]-min[0], max[1]-min[1], max[2]-min[2]], min, max }
}
const before = bounds()

// Scale every POSITION attribute (and bake node translations) by factor.
for (const mesh of root.listMeshes())
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'); if (!pos) continue
    const arr = pos.getArray()
    for (let i = 0; i < arr.length; i++) arr[i] *= factor
    pos.setArray(arr)
  }
// Scale node local translations so multi-node hierarchies stay aligned.
for (const node of root.listNodes()) {
  const t = node.getTranslation()
  node.setTranslation([t[0]*factor, t[1]*factor, t[2]*factor])
}

const after = bounds()
console.log('factor', factor)
console.log('before size', before.size.map(v=>+v.toFixed(2)))
console.log('after  size', after.size.map(v=>+v.toFixed(2)))

await io.write(file, doc)
console.log('wrote', file)
