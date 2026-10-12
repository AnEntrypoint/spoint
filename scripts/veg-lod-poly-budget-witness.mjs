#!/usr/bin/env node
// Pins the per-tier triangle budget of the branch/leaf LOD ladder that
// client/core/Vegetation.js builds at boot. Counted work units only: triangles
// per LOD tier, per species, built from the real ez-tree species geometry.
//
// The shipped cap default is read out of Vegetation.js so a change that lowers
// the budget cannot pass without this witness being re-pinned.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagNumber } from './lib/witness-args.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? String(ARGS.get(n)) : String(d))
const hasNum = (n) => ARGS.has(n)

const MIN_MID_TRIS = flagNumber(flag, 'min-mid-tris', 600, argv)
const MIN_MID_TOTAL = flagNumber(flag, 'min-mid-total', 18000, argv)
const MAX_FAR_TOTAL = flagNumber(flag, 'max-far-total', 12000, argv)
const SPECIES_CAP_OVERRIDE = hasNum('branch-tri-cap') ? flagNumber(flag, 'branch-tri-cap', 0, argv) : null

const mkEl = (tag) => ({
  tagName: String(tag).toUpperCase(), style: {}, width: 1, height: 1, src: '', crossOrigin: null,
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null },
  appendChild(c) { return c }, removeChild(c) { return c }, getContext() { return null },
  toDataURL() { return '' }, getBoundingClientRect() { return { left: 0, top: 0, width: 1, height: 1 } },
  focus() {}, blur() {}, click() {},
})
globalThis.document = globalThis.document || {
  createElementNS: (ns, t) => mkEl(t), createElement: (t) => mkEl(t), createTextNode: () => ({}),
  head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null },
  querySelector() { return null }, querySelectorAll() { return [] },
}
globalThis.window = globalThis.window || globalThis
globalThis.self = globalThis.self || globalThis
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true })
globalThis.Image = globalThis.Image || function () { return mkEl('img') }
globalThis.HTMLCanvasElement = globalThis.HTMLCanvasElement || function () {}
globalThis.AudioContext = globalThis.AudioContext || function () { return { createBuffer: () => ({}), createBufferSource: () => ({}) } }

const THREE = await import('three')
const { MeshoptSimplifier } = await import('meshoptimizer')
const { Tree } = await import('@dgreenheck/ez-tree')

// Mirrors client/core/VegetationBuild.js. Kept literal so the witness fails loudly
// if the build-side decimation contract changes rather than silently measuring nothing.
const PRESET = {
  'Oak Large': 'Oak Large', 'Pine Medium': 'Pine Medium', 'Aspen Medium': 'Aspen Medium',
  'Ash Medium': 'Ash Medium', 'Bush': 'Bush 1', 'Ash Small': 'Ash Small', 'Ash Large': 'Ash Large',
  'Aspen Small': 'Aspen Small', 'Aspen Large': 'Aspen Large', 'Bush 2': 'Bush 2', 'Bush 3': 'Bush 3',
  'Oak Small': 'Oak Small', 'Oak Medium': 'Oak Medium', 'Pine Small': 'Pine Small', 'Pine Large': 'Pine Large',
}
const TARGET_H = {
  'Oak Large': 9, 'Pine Medium': 12, 'Aspen Medium': 9.5, 'Ash Medium': 10, 'Bush': 2.8,
  'Ash Small': 6.5, 'Ash Large': 13, 'Aspen Small': 6, 'Aspen Large': 13, 'Bush 2': 3.0,
  'Bush 3': 3.2, 'Oak Small': 5.5, 'Oak Medium': 7, 'Pine Small': 8, 'Pine Large': 16,
}
const NAMES = Object.keys(PRESET)
// Ratios and caps as Vegetation.js applies them: LOD1/LOD2 decimate the CAPPED LOD0.
const BRANCH_LOD1_RATIO = 0.28
const BRANCH_LOD2_RATIO = 0.07
const LEAF_CAP = 1400
const LEAF_LOD1_RATIO = 0.30
const LEAF_LOD2_RATIO = 0.09

function shippedBranchTriCap() {
  const src = readFileSync(resolve(ROOT, 'client', 'core', 'Vegetation.js'), 'utf8')
  const m = src.match(/cfg\.branchTriCap\s*\)\s*\?\s*cfg\.branchTriCap\s*:\s*(\d+)/)
  if (!m) throw new Error('veg-lod-poly-budget: could not read the shipped branchTriCap default out of client/core/Vegetation.js')
  return Number(m[1])
}
const BRANCH_CAP = SPECIES_CAP_OVERRIDE == null ? shippedBranchTriCap() : SPECIES_CAP_OVERRIDE

await MeshoptSimplifier.ready

function sim(geo, ratio, sloppy) {
  const idx = geo.index ? geo.index.array : null
  const pos = geo.attributes.position.array
  if (!idx || !pos) return geo.clone()
  const target = Math.max(12, Math.floor((idx.length / 3) * ratio) * 3)
  const fn = sloppy && MeshoptSimplifier.simplifySloppy ? 'simplifySloppy' : 'simplify'
  const args = sloppy ? [idx, pos, 3, null, target, 0.05] : [idx, pos, 3, target, 0.02, ['Sparse']]
  const ni = MeshoptSimplifier[fn](...args)[0]
  const out = geo.clone()
  if (ni && ni.length >= 3) out.setIndex(new THREE.BufferAttribute(ni, 1))
  return out
}
function cap(geo, maxTris) {
  const idx = geo.index ? geo.index.array : null
  if (!idx) return geo.clone()
  const tris = idx.length / 3
  return tris <= maxTris ? geo.clone() : sim(geo, maxTris / tris, false)
}
const trisOf = (g) => (g.index ? g.index.array.length / 3 : 0)

function generateSpecies(name) {
  const tree = new Tree()
  tree.loadPreset(PRESET[name] || name)
  const branchGeo = tree.branchesMesh.geometry
  const leafGeo = tree.leavesMesh.geometry
  branchGeo.computeBoundingBox(); leafGeo.computeBoundingBox()
  const minY = Math.min(branchGeo.boundingBox.min.y, leafGeo.boundingBox.min.y)
  const maxY = Math.max(branchGeo.boundingBox.max.y, leafGeo.boundingBox.max.y)
  const hs = (TARGET_H[name] || 9) / (maxY - minY)
  for (const g of [branchGeo, leafGeo]) { g.scale(hs, hs, hs); g.translate(0, -minY * hs, 0) }
  return { branchGeo, leafGeo }
}

const failures = []
const rows = []
let bTotal = { l0: 0, l1: 0, l2: 0 }
let lTotal = { l0: 0, l1: 0, l2: 0 }
for (const name of NAMES) {
  const { branchGeo, leafGeo } = generateSpecies(name)
  const rawB = trisOf(branchGeo), rawL = trisOf(leafGeo)
  const b0 = cap(branchGeo, BRANCH_CAP)
  const l0 = cap(leafGeo, LEAF_CAP)
  const b1 = sim(b0, BRANCH_LOD1_RATIO, false)
  const b2 = sim(b0, BRANCH_LOD2_RATIO, true)
  const l1 = sim(l0, LEAF_LOD1_RATIO, false)
  const l2 = sim(l0, LEAF_LOD2_RATIO, true)
  const r = { name, rawB, b0: trisOf(b0), b1: trisOf(b1), b2: trisOf(b2), rawL, l0: trisOf(l0), l1: trisOf(l1), l2: trisOf(l2) }
  rows.push(r)
  bTotal.l0 += r.b0; bTotal.l1 += r.b1; bTotal.l2 += r.b2
  lTotal.l0 += r.l0; lTotal.l1 += r.l1; lTotal.l2 += r.l2
  if (r.b1 < MIN_MID_TRIS) failures.push(`${name}: branch mid tier (LOD1, 14-35m) is ${r.b1} triangle(s), below the ${MIN_MID_TRIS} floor`)
  if (r.b2 > r.b1) failures.push(`${name}: branch far tier ${r.b2} exceeds its mid tier ${r.b1}, so the ladder has no middle step`)
  if (r.b1 > r.b0) failures.push(`${name}: branch mid tier ${r.b1} exceeds the near tier ${r.b0}`)
  if (r.b1 === 0) failures.push(`${name}: branch mid tier drew 0 triangle(s), so the mid-tier floor proves nothing`)
}
if (bTotal.l1 < MIN_MID_TOTAL) failures.push(`branch mid tier totals ${bTotal.l1} triangle(s) over ${NAMES.length} species, below the ${MIN_MID_TOTAL} floor`)
if (bTotal.l2 > MAX_FAR_TOTAL) failures.push(`branch far tier totals ${bTotal.l2} triangle(s), above the ${MAX_FAR_TOTAL} ceiling`)

console.log(`branchTriCap=${BRANCH_CAP}${SPECIES_CAP_OVERRIDE == null ? ' (shipped default)' : ' (override)'} leafTriCap=${LEAF_CAP}`)
console.log(`branch  near(LOD0)=${bTotal.l0}  mid(LOD1,14-35m)=${bTotal.l1}  far(LOD2,35m+)=${bTotal.l2}`)
console.log(`leaf    near(LOD0)=${lTotal.l0}  mid(LOD1,14-35m)=${lTotal.l1}  far(LOD2,35m+)=${lTotal.l2}`)
for (const r of rows) {
  console.log(`  ${r.name.padEnd(14)} branch raw=${String(r.rawB).padStart(6)} near=${String(r.b0).padStart(6)} mid=${String(r.b1).padStart(5)} far=${String(r.b2).padStart(5)}   leaf raw=${String(r.rawL).padStart(6)} near=${String(r.l0).padStart(5)} mid=${String(r.l1).padStart(5)} far=${String(r.l2).padStart(5)}`)
}
for (const f of failures) console.log('FAIL: ' + f)
console.log(`RESULT: ${failures.length ? 'FAIL' : 'PASS'} -- ${NAMES.length} species at branchTriCap=${BRANCH_CAP}, branch mid tier ${bTotal.l1} far ${bTotal.l2}, ${failures.length} violation(s)`)
process.exitCode = failures.length ? 1 : 0
