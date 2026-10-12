// Leaf decimation budget: does the leaf LOD ladder actually deliver the triangle
// budget client/core/Vegetation.js asks for, and does a miss say so?
//
// Counted work units only: triangles per species per LOD tier, vertices, attribute
// bytes, and the leaf area each tier carries. No per-pass GPU timings (invalid on
// this project) and no rAF wall time (vsync-quantized).
//
// The pin is the CONTRACT, not a number: every species must either deliver at or
// under the shipped leaf triangle cap, or appear in leafCapRefusals() carrying the
// species, the target, the delivered count and a reason. A cap that is asked for,
// not delivered and not reported is the silent-no-op this witness exists to kill.
//
// The ladder is the second half: Vegetation.js asks for LOD1 = 0.30 and
// LOD2 = 0.09 of LOD0. A tier that comes back at LOD0's count has no LOD step.
//
// Fidelity is the third half: the decimation that replaces leaf cards must carry
// the same total leaf area, or the canopy thins and the triangle saving is bought
// with the picture.
import * as Module from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_URL = pathToFileURL(`${REPO}/`).href

// client/core/VegetationBuild.js imports '/src/terrain/...' by root-absolute specifier,
// which the ESM resolver reads as a path from the filesystem root. Node spells "resolve
// it against the repo root" two ways: registerHooks (>= 22.15, in-process) and register
// with a loader module (>= 20.6). CI runs node 20, so both are here; a node with
// neither cannot run this witness, and saying so beats a stack from a bare import.
const resolverUrl = new URL('./lib/src-specifier-resolver.mjs', import.meta.url)
const mapSrc = (specifier) => (specifier.startsWith('/src/') ? new URL(specifier.slice(1), REPO_URL).href : null)
if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = mapSrc(specifier)
      return url ? { url, shortCircuit: true } : nextResolve(specifier, context)
    },
  })
} else if (typeof Module.register === 'function') {
  Module.register(resolverUrl.href, import.meta.url)
} else {
  console.log('[veg-leaf-cap] RESULT: FAIL (uncaught) -- this node exposes neither module.registerHooks nor module.register, so the /src/ specifiers in client/core/VegetationBuild.js cannot be resolved')
  process.exit(1)
}

// ez-tree's module body runs THREE.TextureLoader.load, which wants
// document.createElementNS for the img element. No texture is read here.
const _el = () => ({
  style: {}, src: '', width: 1, height: 1,
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, appendChild() {}, remove() {},
  getContext: () => null,
})
globalThis.document = {
  createElementNS: () => _el(), createElement: () => _el(),
  body: _el(), head: _el(), addEventListener() {}, getElementById: () => null,
}

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.get(n) == null ? d : String(ARGS.get(n)))
const LEAF_LOD1_RATIO = Number(flag('lod1', 0.30))
const LEAF_LOD2_RATIO = Number(flag('lod2', 0.09))
const AREA_TOLERANCE = Number(flag('area-tolerance', 0.10))

function shippedLeafTriCap() {
  const src = readFileSync(resolve(REPO, 'client', 'core', 'Vegetation.js'), 'utf8')
  const m = src.match(/cfg\.leafTriCap\s*\)\s*\?\s*cfg\.leafTriCap\s*:\s*(\d+)/)
  if (!m) throw new Error('veg-leaf-cap: could not read the shipped leafTriCap default out of client/core/Vegetation.js')
  return Number(m[1])
}
const LEAF_CAP = ARGS.has('leaf-cap') ? Number(flag('leaf-cap', 1400)) : shippedLeafTriCap()

const PASSED = []
const FAILED = []
function check(label, cond, detail) {
  if (cond) { PASSED.push(label); console.log('  [PASS] ' + label) }
  else { FAILED.push(label); console.log('  [FAIL] ' + label + (detail ? ' -- ' + detail : '')) }
}

const triCount = (g) => (g && g.index ? g.index.array.length / 3 : 0)
const vertCount = (g) => (g && g.attributes && g.attributes.position ? g.attributes.position.count : 0)
function byteCount(g) {
  if (!g || !g.attributes) return 0
  let n = 0
  for (const k of Object.keys(g.attributes)) n += g.attributes[k].array.byteLength || 0
  return n
}
// Canopy extent per world axis, plus its diagonal.
function canopyExtents(g) {
  const pos = g && g.attributes && g.attributes.position ? g.attributes.position.array : null
  if (!pos) return { ex: 0, ey: 0, ez: 0, d: 0 }
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < minX) minX = pos[i]
    if (pos[i] > maxX) maxX = pos[i]
    if (pos[i + 1] < minY) minY = pos[i + 1]
    if (pos[i + 1] > maxY) maxY = pos[i + 1]
    if (pos[i + 2] < minZ) minZ = pos[i + 2]
    if (pos[i + 2] > maxZ) maxZ = pos[i + 2]
  }
  const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ
  return { ex, ey, ez, d: Math.hypot(ex, ey, ez) }
}
// Half the longest reach from a card's own centre to one of its corners: every point
// of a merged leaf card lies within this of that card's centre, so it is the exact
// quantity that bounds how far a merged card can stick out past the cards it replaces.
function maxCardHalfDiagonal(g) {
  const pos = g && g.attributes && g.attributes.position ? g.attributes.position.array : null
  if (!pos) return 0
  let H = 0
  for (let c = 0; c + 12 <= pos.length; c += 12) {
    const cx = (pos[c] + pos[c + 3] + pos[c + 6] + pos[c + 9]) / 4
    const cy = (pos[c + 1] + pos[c + 4] + pos[c + 7] + pos[c + 10]) / 4
    const cz = (pos[c + 2] + pos[c + 5] + pos[c + 8] + pos[c + 11]) / 4
    for (let k = 0; k < 12; k += 3) {
      const r = Math.hypot(pos[c + k] - cx, pos[c + k + 1] - cy, pos[c + k + 2] - cz)
      if (r > H) H = r
    }
  }
  return H
}
function protrusionBound(source, merged) {
  const s = canopyExtents(source)
  const H = maxCardHalfDiagonal(merged)
  if (!s.d || !H) return 0
  return Math.hypot(s.ex + 2 * H, s.ey + 2 * H, s.ez + 2 * H)
}
function leafArea(g) {
  const idx = g && g.index ? g.index.array : null
  const pos = g && g.attributes && g.attributes.position ? g.attributes.position.array : null
  if (!idx || !pos) return 0
  let a = 0
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3
    const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2]
    const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2]
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    a += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz)
  }
  return a
}

async function main() {
  let Tree = null, TreePreset = null
  try {
    ;({ Tree, TreePreset } = await import('@dgreenheck/ez-tree'))
  } catch (e) {
    console.log('[veg-leaf-cap] RESULT: FAIL (uncaught) -- @dgreenheck/ez-tree did not import: ' + ((e && e.message) || e))
    process.exitCode = 1
    return
  }
  let VB = null
  try {
    VB = await import('../client/core/VegetationBuild.js')
  } catch (e) {
    console.log('[veg-leaf-cap] RESULT: FAIL (uncaught) -- VegetationBuild.js did not import: ' + ((e && e.message) || e))
    process.exitCode = 1
    return
  }
  const { buildSpecies, capGeo, simplifyGeo, TARGET_H } = VB
  // A missing reporter is itself a violation of the cap contract, but it must not
  // mask the row-by-row evidence: an unmet cap with nothing to report is exactly
  // the silent-no-op this witness names.
  const leafCapRefusals = typeof VB.leafCapRefusals === 'function' ? VB.leafCapRefusals : null
  if (!leafCapRefusals) {
    FAILED.push('leafCapRefusals is exported')
    console.log('  [FAIL] leafCapRefusals is exported -- VegetationBuild.js exports no leafCapRefusals(), so an unmet leaf cap cannot be reported and the cap contract is unenforceable')
  }

  const names = Object.keys(TARGET_H)
  console.log(`[veg-leaf-cap] species=${names.length} leafTriCap=${LEAF_CAP}${ARGS.has('leaf-cap') ? ' (override)' : ' (shipped default)'} lod1=${LEAF_LOD1_RATIO} lod2=${LEAF_LOD2_RATIO} areaTolerance=${AREA_TOLERANCE}`)

  // JIT warm-up: the first species a cold run builds pays for the module's compile.
  {
    const sp = buildSpecies('Aspen Small', Tree, 0, TreePreset)
    await capGeo(sp.leafGeo, LEAF_CAP)
  }

  const rows = []
  const refusals = []
  for (const name of names) {
    const sp = buildSpecies(name, Tree, 0, TreePreset)
    const rawL = triCount(sp.leafGeo)
    const rawArea = leafArea(sp.leafGeo)
    const l0 = await capGeo(sp.leafGeo, LEAF_CAP)
    const l1 = await simplifyGeo(l0, LEAF_LOD1_RATIO, false)
    const l2 = await simplifyGeo(l0, LEAF_LOD2_RATIO, true)
    rows.push({
      name,
      raw: rawL,
      l0: triCount(l0), l1: triCount(l1), l2: triCount(l2),
      v0: vertCount(l0), v1: vertCount(l1), v2: vertCount(l2),
      b0: byteCount(l0), b1: byteCount(l1), b2: byteCount(l2),
      a0: leafArea(l0), a1: leafArea(l1), a2: leafArea(l2), rawArea,
      d0: canopyExtents(l0).d, d1: canopyExtents(l1).d, d2: canopyExtents(l2).d,
      // Protrusion is bounded by the source canopy plus the merged cards' own reach:
      // a merged card's centre is the area-weighted mean of the cards it replaces, so
      // it sits inside the source canopy, and no point of it is further from that
      // centre than its own half-diagonal. Per axis each side can grow by H, so the
      // diagonal cannot exceed the root of the sum of (extent + 2H) squares.
      bound1: protrusionBound(l0, l1), bound2: protrusionBound(l0, l2),
      h1: maxCardHalfDiagonal(l1), h2: maxCardHalfDiagonal(l2),
    })
  }
  for (const r of (leafCapRefusals ? leafCapRefusals() : [])) refusals.push(r)

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
  const totals = {
    raw: sum('raw'), l0: sum('l0'), l1: sum('l1'), l2: sum('l2'),
    v0: sum('v0'), v1: sum('v1'), v2: sum('v2'),
    b0: sum('b0'), b1: sum('b1'), b2: sum('b2'),
    a0: sum('a0'), a1: sum('a1'), a2: sum('a2'),
  }
  const vertsAll = totals.v0 + totals.v1 + totals.v2
  const bytesAll = totals.b0 + totals.b1 + totals.b2

  console.log(`[veg-leaf-cap] leaf triangles  raw=${totals.raw} near(LOD0)=${totals.l0} mid(LOD1)=${totals.l1} far(LOD2)=${totals.l2}`)
  console.log(`[veg-leaf-cap] leaf vertices   near=${totals.v0} mid=${totals.v1} far=${totals.v2} all=${vertsAll}`)
  console.log(`[veg-leaf-cap] leaf attr bytes near=${totals.b0} mid=${totals.b1} far=${totals.b2} all=${bytesAll}`)
  console.log(`[veg-leaf-cap] leaf area (m2)  near=${totals.a0.toFixed(1)} mid=${totals.a1.toFixed(1)} far=${totals.a2.toFixed(1)}`)
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(14)} raw=${String(r.raw).padStart(6)} near=${String(r.l0).padStart(6)} mid=${String(r.l1).padStart(5)} far=${String(r.l2).padStart(5)}` +
      `  verts=${String(r.v0).padStart(6)}/${String(r.v1).padStart(6)}/${String(r.v2).padStart(6)}` +
      `  bytes=${String(r.b0).padStart(8)}/${String(r.b1).padStart(8)}/${String(r.b2).padStart(8)}` +
      `  area=${r.a0.toFixed(1)}/${r.a1.toFixed(1)}/${r.a2.toFixed(1)}` +
      `  canopyDiag=${r.d0.toFixed(2)}/${r.d1.toFixed(2)}/${r.d2.toFixed(2)}`)
  }

  // 1. The cap contract: met, or reported. A miss that is neither is the defect.
  const silentMisses = []
  for (const r of rows) {
    if (r.l0 <= LEAF_CAP) continue
    const rep = refusals.find((x) => x && x.target === LEAF_CAP && x.delivered === r.l0)
    if (!rep) silentMisses.push(`${r.name}: leaf LOD0 delivered ${r.l0} triangle(s) for a ${LEAF_CAP} cap and no refusal was recorded`)
  }
  check('every leaf cap miss is reported with species, target, delivered and reason', silentMisses.length === 0,
    silentMisses.slice(0, 3).join('; '))

  const met = rows.filter((r) => r.l0 <= LEAF_CAP).length
  const missed = rows.length - met
  check('recorded refusals match the species that missed the cap',
    refusals.length === missed, `${refusals.length} refusal(s) for ${missed} miss(es) over ${rows.length} species`)
  check('every refusal carries a species, a target, a delivered count and a reason',
    refusals.every((x) => x && typeof x.species === 'string' && x.species.length > 0 &&
      Number.isFinite(x.target) && Number.isFinite(x.delivered) && typeof x.reason === 'string' && x.reason.length > 0),
    JSON.stringify(refusals.find((x) => !x || !x.species || !Number.isFinite(x.target) || !Number.isFinite(x.delivered) || !x.reason) || null))
  console.log(`[veg-leaf-cap] cap met by ${met}/${rows.length} species, refused by ${missed}: ${refusals.map((r) => r.species).join(', ') || '(none)'}`)

  // 2. The ladder: each tier must be at or under the fraction Vegetation.js asks for.
  const ladderMisses = []
  for (const r of rows) {
    const want1 = Math.floor(r.l0 * LEAF_LOD1_RATIO)
    const want2 = Math.floor(r.l0 * LEAF_LOD2_RATIO)
    if (r.l1 > want1) ladderMisses.push(`${r.name}: leaf mid tier ${r.l1} > ${want1} (${LEAF_LOD1_RATIO} of ${r.l0})`)
    if (r.l2 > want2) ladderMisses.push(`${r.name}: leaf far tier ${r.l2} > ${want2} (${LEAF_LOD2_RATIO} of ${r.l0})`)
    if (r.l1 === 0 || r.l2 === 0) ladderMisses.push(`${r.name}: a leaf tier drew 0 triangle(s), so its budget proves nothing`)
  }
  check('the leaf LOD ladder reaches the tier targets Vegetation.js asks for', ladderMisses.length === 0,
    ladderMisses.slice(0, 4).join('; '))

  // 3. Fidelity: decimation must not buy triangles with leaf area.
  const areaMisses = []
  for (const r of rows) {
    if (r.a0 <= 0) { areaMisses.push(`${r.name}: leaf LOD0 carries 0 m2 of leaf area, so the area check proves nothing`); continue }
    for (const [k, tier] of [['a1', 'mid'], ['a2', 'far']]) {
      const ratio = r[k] / r.a0
      if (Math.abs(ratio - 1) > AREA_TOLERANCE) {
        areaMisses.push(`${r.name}: leaf ${tier} tier carries ${r[k].toFixed(1)} m2 against ${r.a0.toFixed(1)} m2 at LOD0 (${ratio.toFixed(3)}x)`)
      }
    }
  }
  check('the decimated leaf tiers carry the LOD0 leaf area within tolerance', areaMisses.length === 0,
    areaMisses.slice(0, 4).join('; '))

// 4. Protrusion: a merged leaf card carries the area of the cards it replaces, so it
// is a bigger flat card than any of them and it can stick out past the canopy. That is
// inherent to merging, but it is bounded: the merged card sits inside the source
// canopy and reaches at most its own half-diagonal from there. A tier that grows past
// that bound is not clustering, it is a placement or scale defect.
const growMisses = []
for (const r of rows) {
  if (!(r.d0 > 0)) { growMisses.push(`${r.name}: leaf LOD0 has no extent, so the protrusion check proves nothing`); continue }
  for (const [k, bk, tier, hk] of [['d1', 'bound1', 'mid', 'h1'], ['d2', 'bound2', 'far', 'h2']]) {
    if (r[bk] <= 0) { growMisses.push(`${r.name}: leaf ${tier} tier has no derived protrusion bound, so the check proves nothing`); continue }
    if (r[k] > r[bk]) {
      growMisses.push(`${r.name}: leaf ${tier} tier canopy diagonal ${r[k].toFixed(2)} m exceeds the ${r[bk].toFixed(2)} m the merge geometry allows (LOD0 ${r.d0.toFixed(2)} m, merged card half-diagonal ${r[hk].toFixed(2)} m)`)
    }
  }
}
check('the decimated leaf tiers stay inside the protrusion the merge geometry implies', growMisses.length === 0,
  growMisses.slice(0, 4).join('; '))
{
  let worstGrow = null, worstUse = null
  for (const r of rows) {
    if (!(r.d0 > 0)) continue
    for (const [k, bk, tier] of [['d1', 'bound1', 'mid'], ['d2', 'bound2', 'far']]) {
      if (!(r[bk] > 0)) continue
      const g = r[k] / r.d0 - 1
      if (!worstGrow || g > worstGrow.g) worstGrow = { name: r.name, tier, g }
      const use = r[k] / r[bk]
      if (!worstUse || use > worstUse.use) worstUse = { name: r.name, tier, use }
    }
  }
  if (worstGrow) {
    console.log(`[veg-leaf-cap] canopy growth: worst ${worstGrow.name} ${worstGrow.tier} tier ${worstGrow.g >= 0 ? '+' : ''}${(worstGrow.g * 100).toFixed(1)}%; ` +
      `closest to the bound ${worstUse.name} ${worstUse.tier} tier at ${(worstUse.use * 100).toFixed(1)}%`)
  }
}

  // 5. Memory: a decimated tier must not keep the whole vertex buffer behind it.
  const vMisses = []
  for (const r of rows) {
    if (r.v1 > r.v0) vMisses.push(`${r.name}: leaf mid tier keeps ${r.v1} vertice(s) against ${r.v0} at LOD0`)
    if (r.v2 > r.v0) vMisses.push(`${r.name}: leaf far tier keeps ${r.v2} vertice(s) against ${r.v0} at LOD0`)
  }
  check('no decimated leaf tier carries more vertices than its source', vMisses.length === 0,
    vMisses.slice(0, 4).join('; '))

  console.log(`[veg-leaf-cap] ${PASSED.length} passed, ${FAILED.length} failed`)
  console.log(`[veg-leaf-cap] RESULT: ${FAILED.length ? 'FAIL' : 'PASS'} -- leaf near=${totals.l0} mid=${totals.l1} far=${totals.l2} triangle(s), ` +
    `cap ${LEAF_CAP} met by ${met}/${rows.length} and refused by ${missed}, ` +
    `leaf vertices ${vertsAll}, attribute bytes ${bytesAll}, ${FAILED.length} violation(s)`)
  process.exitCode = FAILED.length ? 1 : 0
}

main().catch((e) => {
  console.error('[veg-leaf-cap] RESULT: FAIL (uncaught)')
  console.error((e && e.stack) || e)
  process.exitCode = 1
})
