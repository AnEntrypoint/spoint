#!/usr/bin/env node
// Grass LOD geometry budget pin (gpu-free).
//
// Grass's per-frame counted units are (clumps submitted) x (vertices/triangles per clump), so the
// per-clump geometry budget is half of the product and is the half a lane can silently inflate:
// bumping makeClumpGeo's segment count on one LOD raises every grass frame's vertex and triangle
// count with no visible change in Grass.js's own diff. This witness reads the two LOD call sites out
// of client/core/Grass.js, builds both geometries through the real makeClumpGeo and fails when
// either exceeds the recorded per-clump budget.
//
// It does NOT measure per-frame cost: the measured per-frame counted units come from
// scripts/grass-perframe-witness.mjs, which boots an accelerated browser and is therefore refused by
// name from the gpu-free arm of scripts/check.mjs (it is gated on SPOINT_GPU_WITNESS=1).
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClumpGeo } from '../client/core/GrassClump.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const NEAR_VERTS_MAX = 6
const NEAR_TRIS_MAX = 4
const MID_VERTS_MAX = 4
const MID_TRIS_MAX = 2

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`)
}

let source = ''
try {
  source = readFileSync(resolve(ROOT, 'client', 'core', 'Grass.js'), 'utf8')
} catch (e) {
  console.log('RESULT: FAIL client/core/Grass.js unreadable: ' + e.message)
  process.exit(1)
}

const callSite = (name) => {
  const m = new RegExp(`const ${name} = makeClumpGeo\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)`).exec(source)
  return m ? { segments: Number(m[1]), cards: Number(m[2]) } : null
}
const near = callSite('geoNear')
const mid = callSite('geoMid')
check('both grass LOD call sites read out of client/core/Grass.js', !!(near && mid), `geoNear=${JSON.stringify(near)} geoMid=${JSON.stringify(mid)}`)
if (!near || !mid) {
  console.log('RESULT: FAIL grass LOD geometry call sites not found')
  process.exit(1)
}

const measure = (spec) => {
  const g = makeClumpGeo(spec.segments, spec.cards)
  const pos = g.getAttribute('position')
  const idx = g.getIndex()
  return { verts: pos ? pos.count : 0, tris: idx ? idx.count / 3 : 0 }
}
const n = measure(near)
const m = measure(mid)
console.log(`[grass-lod-geometry] geoNear=makeClumpGeo(${near.segments}, ${near.cards}) -> ${n.verts} vert(s), ${n.tris} tri(s) per clump`)
console.log(`[grass-lod-geometry] geoMid=makeClumpGeo(${mid.segments}, ${mid.cards}) -> ${m.verts} vert(s), ${m.tris} tri(s) per clump`)

check('near LOD is indexed, so its triangle count is the indexed count', Number.isInteger(n.tris) && n.tris > 0, `tris=${n.tris}`)
check('mid LOD is indexed, so its triangle count is the indexed count', Number.isInteger(m.tris) && m.tris > 0, `tris=${m.tris}`)
check('near LOD within its per-clump vertex budget', n.verts <= NEAR_VERTS_MAX, `verts=${n.verts} max=${NEAR_VERTS_MAX}`)
check('near LOD within its per-clump triangle budget', n.tris <= NEAR_TRIS_MAX, `tris=${n.tris} max=${NEAR_TRIS_MAX}`)
check('mid LOD within its per-clump vertex budget', m.verts <= MID_VERTS_MAX, `verts=${m.verts} max=${MID_VERTS_MAX}`)
check('mid LOD within its per-clump triangle budget', m.tris <= MID_TRIS_MAX, `tris=${m.tris} max=${MID_TRIS_MAX}`)
check('the near LOD still resolves the quadratic wind bend (at least three rows along the card)', near.segments >= 2, `segments=${near.segments} rows=${near.segments + 1}`)

console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} -- grass LOD geometry budget near=${n.verts}v/${n.tris}t mid=${m.verts}v/${m.tris}t (max ${NEAR_VERTS_MAX}v/${NEAR_TRIS_MAX}t and ${MID_VERTS_MAX}v/${MID_TRIS_MAX}t)`)
process.exit(failed === 0 ? 0 : 1)
