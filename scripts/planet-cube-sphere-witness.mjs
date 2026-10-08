import { AppRuntime } from '../src/apps/AppRuntime.js'
import { StageLoader } from '../src/stage/StageLoader.js'
import { resolveClusterConfig } from '../src/shared/clusterConfig.js'
import { resolvePlayerCell, solveCellViewer, computeRingRelevantIds, _spatialCache, _ringCache } from '../src/sdk/TickHandlerAOI.js'
import { neighborCells } from '../src/terrain/CubeSphereCells.js'

const R = 63600
const REL = 200
const CPF = Math.ceil((2 * R) / REL)
const failures = []
let checks = 0

const show = v => {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 240 ? `${s.slice(0, 240)}...` : s
}

function expect(name, got, predicate) {
  checks++
  let pass = false
  try { pass = predicate(got) === true } catch { pass = false }
  if (pass) console.log(`[PASS] ${name} -- ${show(got)}`)
  else { failures.push(name); console.log(`[FAIL] ${name} -- measured ${show(got)}`) }
}

function attempt(fn) {
  try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e.code ?? e.name, message: e.message } }
}

const unit = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const surface = (d, h = 0) => { const u = unit(d); return [u[0] * (R + h), u[1] * (R + h), u[2] * (R + h)] }
const cellCentre = c => solveCellViewer(c.cellFace ?? c.face, c.cellCx ?? c.cx, c.cellCy ?? c.cy, R, REL)
const sameCell = (a, b) => a.face === b.face && a.cx === b.cx && a.cy === b.cy

let seed = 20260704
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const randomUnit = () => { const z = 2 * rand() - 1, phi = 2 * Math.PI * rand(), s = Math.sqrt(1 - z * z); return [s * Math.cos(phi), s * Math.sin(phi), z] }

function planetStage(name, clusters = { enabled: true }) {
  const runtime = new AppRuntime({})
  const loader = new StageLoader(runtime)
  runtime.setStageLoader(loader)
  const stage = loader.loadFromDefinition(name, { name, relevanceRadius: REL, terrain: { radius: R, clusters }, entities: [] })
  return { runtime, loader, stage }
}

const VIEWERS = [
  ['face +x', [1, 0, 0]], ['face -x', [-1, 0, 0]], ['face +y', [0, 1, 0]], ['face -y', [0, -1, 0]], ['face +z', [0, 0, 1]], ['face -z', [0, 0, -1]],
  ['edge +x+z', unit([1, 0, 1])], ['edge -x-y', unit([-1, -1, 0])], ['edge +y-z', unit([0, 1, -1])], ['edge -x+y', unit([-1, 1, 0])],
  ['corner +++', unit([1, 1, 1])], ['corner ---', unit([-1, -1, -1])], ['corner +--', unit([1, -1, -1])], ['corner -+-', unit([-1, 1, -1])],
]
const ANTIPODES = VIEWERS.map(([label, d]) => [`antipode of ${label}`, [-d[0], -d[1], -d[2]]])
const ALL_VIEWERS = [...VIEWERS, ...ANTIPODES]

console.log(`planet-cube-sphere witness: R=${R} relevanceRadius=${REL} cellsPerFace=${CPF}`)

const planet = planetStage('witness-planet')
expect('planet stage takes planetRadius from enabled clusters', planet.stage.spatial.planetRadius, v => v === R)
const flat = planetStage('witness-flat', null)
expect('stage without clusters stays flat (planetRadius 0)', flat.stage.spatial.planetRadius, v => v === 0)
const declared = attempt(() => { const l = new StageLoader(new AppRuntime({})); return l.loadFromDefinition('undeclared', { name: 'undeclared', planetRadius: R, entities: [] }) })
expect('declared planetRadius without clusters is refused at load', declared, v => !v.ok && /without enabled clusters/.test(v.message))
const linkRefused = attempt(() => planetStage('link-refused', { enabled: true, linkM: 599 }))
expect('stage load surfaces cluster-link-below-relevance-ring', linkRefused, v => !v.ok && v.code === 'cluster-link-below-relevance-ring')

console.log('-- resolveClusterConfig --')
const callCluster = (spec, opts = {}) => attempt(() => resolveClusterConfig({ enabled: true, ...spec }, { radius: R, relevanceRadius: REL, maxWeaponRangeM: 0, ...opts }))
const outcomeOf = r => r.ok ? (r.value === null ? 'null' : 'ok') : r.code
const CLUSTER_CASES = [
  ['link 599 just below relevance ring 600', { linkM: 599 }, {}, 'cluster-link-below-relevance-ring'],
  ['link 600 at relevance ring', { linkM: 600 }, {}, 'ok'],
  ['link default 1000', {}, {}, 'ok'],
  ['weapon 999 below link 1000', {}, { maxWeaponRangeM: 999 }, 'ok'],
  ['weapon 1000 equal to link', {}, { maxWeaponRangeM: 1000 }, 'ok'],
  ['weapon 1000.5 just above link', {}, { maxWeaponRangeM: 1000.5 }, 'cluster-link-below-weapon-range'],
  ['relevance 300 link 899 below ring 900', { linkM: 899 }, { relevanceRadius: 300 }, 'cluster-link-below-relevance-ring'],
  ['relevance 300 link 900 at ring', { linkM: 900 }, { relevanceRadius: 300 }, 'ok'],
  ['radius 0', {}, { radius: 0 }, 'cluster-needs-planet-radius'],
  ['hz 0.4 below band', { hz: 0.4 }, {}, 'cluster-cadence-out-of-range'],
  ['hz 10.5 above band', { hz: 10.5 }, {}, 'cluster-cadence-out-of-range'],
  ['maxWorldsPerProcess 0', { maxWorldsPerProcess: 0 }, {}, 'cluster-worlds-exceed-wasm-heap-budget'],
  ['member radius 40000 m exceeds walkable chart', { memberRadiusM: 40000 }, {}, 'cluster-radius-exceeds-walkable-chart'],
  ['disabled spec', { enabled: false }, {}, 'null'],
]
for (const [label, spec, opts, expected] of CLUSTER_CASES) {
  const r = callCluster(spec, opts)
  expect(`resolveClusterConfig: ${label}`, { outcome: outcomeOf(r), input: { spec, opts } }, v => v.outcome === expected)
}

console.log('-- resolvePlayerCell --')
for (const [label, d] of ALL_VIEWERS) {
  const p = surface(d)
  const cell = resolvePlayerCell(p, R, REL)
  expect(`cell indices canonical in [0,${CPF}): ${label}`, [cell.cellFace, cell.cellCx, cell.cellCy], v => v[0] >= 0 && v[0] < 6 && v[1] >= 0 && v[1] < CPF && v[2] >= 0 && v[2] < CPF)
  expect(`player lies within one relevance radius of its cell centre: ${label}`, dist(p, cellCentre(cell)), v => v <= REL)
}
for (const [label, d] of VIEWERS) {
  const a = resolvePlayerCell(surface(d), R, REL).cellKey
  const b = resolvePlayerCell(surface(d.map(c => -c)), R, REL).cellKey
  expect(`antipode gets a different cell key: ${label}`, [a, b], v => v[0] !== v[1])
}

console.log('-- solveCellViewer and neighbour adjacency over every boundary cell --')
const boundary = []
for (let face = 0; face < 6; face++) {
  for (let t = 0; t < CPF; t++) {
    boundary.push({ face, cx: 0, cy: t }, { face, cx: CPF - 1, cy: t }, { face, cx: t, cy: 0 }, { face, cx: t, cy: CPF - 1 })
  }
}
let maxRadiusDev = 0, farNeighbours = [], dupLists = [], asymmetric = []
for (const c of boundary) {
  const self = cellCentre(c)
  maxRadiusDev = Math.max(maxRadiusDev, Math.abs(Math.hypot(...self) - R))
  const ns = neighborCells(c.face, c.cx, c.cy, CPF)
  const seen = new Set()
  for (const n of ns) {
    const key = `${n.face}/${n.cx}/${n.cy}`
    if (seen.has(key)) dupLists.push({ from: `${c.face}/${c.cx}/${c.cy}`, repeated: key })
    seen.add(key)
    const d = dist(self, cellCentre(n))
    if (d > 2 * REL || d < 0.5 * REL) farNeighbours.push({ from: `${c.face}/${c.cx}/${c.cy}`, to: key, chordM: Math.round(d) })
    const back = neighborCells(n.face, n.cx, n.cy, CPF)
    if (!back.some(b => sameCell(b, c))) asymmetric.push({ from: `${c.face}/${c.cx}/${c.cy}`, to: key })
  }
}
expect(`solveCellViewer centres lie on the sphere over ${boundary.length} boundary cells`, maxRadiusDev, v => v < 1e-6)
if (farNeighbours.length) console.log(`  e.g. far neighbour pairs: ${show(farNeighbours.slice(0, 4))}`)
expect('every neighbour centre is adjacent (0.5 to 2 relevance radii away)', farNeighbours.length, v => v === 0)
console.log(`  info: ${dupLists.length} corner neighbour lookups alias a cell already listed (a cube corner has three faces, not four)`)
if (asymmetric.length) console.log(`  e.g. one-way neighbours: ${show(asymmetric.slice(0, 4))}`)
expect('neighbour relation is symmetric (B in N(A) iff A in N(B))', asymmetric.length, v => v === 0)

console.log('-- computeRingRelevantIds coverage of the viewer cell disc --')
function tangentBasis(n) {
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = unit(cross(ref, n))
  return [u, cross(n, u)]
}
const GRID_STEP = 30
const GRID_HALF = 240
const coverage = { required: 0, missing: 0, examples: [] }
const viewerRows = []
for (const [label, d] of ALL_VIEWERS) {
  const cell = resolvePlayerCell(surface(d), R, REL)
  const cvp = cellCentre(cell)
  const n = unit(cvp)
  const [u, v] = tangentBasis(n)
  const grid = []
  for (let a = -GRID_HALF; a <= GRID_HALF; a += GRID_STEP) {
    for (let b = -GRID_HALF; b <= GRID_HALF; b += GRID_STEP) {
      grid.push([`g:${label}:${a}:${b}`, surface([cvp[0] + a * u[0] + b * v[0], cvp[1] + a * u[1] + b * v[1], cvp[2] + a * u[2] + b * v[2]])])
    }
  }
  viewerRows.push({ label, cell, cvp, grid })
}
const allGrid = viewerRows.flatMap(r => r.grid)
for (const row of viewerRows) {
  const ring = ringOver(allGrid, row.cell)
  for (const [id, pos] of row.grid) {
    if (dist(pos, row.cvp) > REL) continue
    coverage.required++
    if (!ring.has(id)) { coverage.missing++; if (coverage.examples.length < 4) coverage.examples.push({ viewer: row.label, id, chordM: Math.round(dist(pos, row.cvp)) }) }
  }
}
function ringOver(points, cell) {
  _spatialCache.clear(); _ringCache.clear()
  const { runtime, stage } = planetStage('ring-planet')
  for (const [id, pos] of points) stage.spatial.insert(id, pos)
  return computeRingRelevantIds(cell.cellKey, cell.cellFace, cell.cellCx, cell.cellCy, cell.cellsPerFace, R, REL, runtime).relevantIds
}
if (coverage.examples.length) console.log(`  e.g. excluded entities: ${show(coverage.examples)}`)
expect(`ring keeps every entity within one relevance radius of the viewer cell centre (${coverage.required} checked)`, coverage.missing, v => v === 0)

console.log('-- computeRingRelevantIds symmetry --')
const PAIRS = 200
const pairs = []
for (let i = 0; i < PAIRS; i++) {
  const a = randomUnit()
  const [t] = tangentBasis(a)
  const s = rand() * 2 * REL
  const b = unit([a[0] * Math.cos(s / R) + t[0] * Math.sin(s / R), a[1] * Math.cos(s / R) + t[1] * Math.sin(s / R), a[2] * Math.cos(s / R) + t[2] * Math.sin(s / R)])
  pairs.push({ i, a: surface(a), b: surface(b), chordM: s })
}
const symPoints = pairs.flatMap(p => [[`A${p.i}`, p.a], [`B${p.i}`, p.b]])
const symmetry = { asymmetric: 0, nearMissing: 0, minOneWayChordM: null, examples: [] }
for (const p of pairs) {
  const cellA = resolvePlayerCell(p.a, R, REL), cellB = resolvePlayerCell(p.b, R, REL)
  const inA = ringOver(symPoints, cellA).has(`B${p.i}`)
  const inB = ringOver(symPoints, cellB).has(`A${p.i}`)
  if (inA !== inB) {
    symmetry.asymmetric++
    if (symmetry.minOneWayChordM === null || p.chordM < symmetry.minOneWayChordM) symmetry.minOneWayChordM = p.chordM
    if (symmetry.examples.length < 4) symmetry.examples.push({ pair: p.i, chordM: Math.round(p.chordM), BinRingA: inA, AinRingB: inB })
  }
  if (p.chordM <= REL && (!inA || !inB)) symmetry.nearMissing++
}
if (symmetry.examples.length) console.log(`  e.g. asymmetric pairs: ${show(symmetry.examples)}`)
console.log(`  info: ${symmetry.asymmetric} of ${PAIRS} pairs are one-way, nearest one-way chord ${symmetry.minOneWayChordM === null ? 'none' : symmetry.minOneWayChordM.toFixed(1) + ' m'} (the ring is the union of the eight neighbour-cell disks, centre cell excluded)`)
expect('pairs within one relevance radius are members both ways', symmetry.nearMissing, v => v === 0)
const flatSymmetry = flatControl()
console.log(`  control (flat chart, not asserted): ${flatSymmetry.asymmetric} of ${PAIRS} pairs one-way, ${flatSymmetry.oneWayWithinRadius} within one relevance radius`)

function flatControl() {
  const out = { asymmetric: 0, oneWayWithinRadius: 0 }
  for (let i = 0; i < PAIRS; i++) {
    const ax = rand() * 4 * REL, az = rand() * 4 * REL
    const s = rand() * 2 * REL, th = rand() * 2 * Math.PI
    const a = [ax, 0, az], b = [ax + s * Math.cos(th), 0, az + s * Math.sin(th)]
    const cellA = resolvePlayerCell(a, 0, REL), cellB = resolvePlayerCell(b, 0, REL)
    const inA = flatRingOver([['A', a], ['B', b]], cellA).has('B')
    const inB = flatRingOver([['A', a], ['B', b]], cellB).has('A')
    if (inA !== inB) out.asymmetric++
    if (s <= REL && inA !== inB) out.oneWayWithinRadius++
  }
  return out
}
function flatRingOver(points, cell) {
  _spatialCache.clear(); _ringCache.clear()
  const { runtime, stage } = planetStage('flat-ring', null)
  for (const [id, pos] of points) stage.spatial.insert(id, pos)
  return computeRingRelevantIds(cell.cellKey, cell.cellFace, cell.cellCx, cell.cellCy, cell.cellsPerFace, 0, REL, runtime).relevantIds
}

console.log(failures.length === 0 ? `RESULT: PASS -- ${checks} check(s)` : `RESULT: FAIL (${failures.length} of ${checks} check(s) failed: ${failures.join(' | ')})`)
process.exit(failures.length === 0 ? 0 : 1)
