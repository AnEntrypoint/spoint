// PERF-stochastic-texture-filter-1013.
//
// The technique on this row is Improved Stochastic Texture Filtering Through Sample Reuse (I3D 2025,
// doi 10.1145/3728292) together with Filtering After Shading With Stochastic Texture Filtering (I3D
// 2024, doi 10.1145/3651293). A sibling row assessed both papers against this renderer and returned
// DO NOT ADOPT on four grounds. This witness does not take that on trust: it re-derives each of the
// four on the shipped bytes, and it prices the one thing the assessment did not price -- how much
// noise the technique would actually put into a near-band pixel, against the project's own parity
// bar.
//
// The four grounds, and what measuring them here actually shows:
//
//   1. Their win comes from amortising an EXPENSIVE TEXEL DECODE. Ours is a plain RGBA8 array tapped
//      once per plane with EXPLICIT GRADIENTS, so the filter is fixed-function hardware; there is no
//      decode to amortise. Measured here: each plane tap is exactly one `texture(...).grad(...)
//      .depth(...)` call.
//   2. Their regime is MAGNIFICATION. This one is WRONG as stated and measuring it is what corrects
//      it: over the textured footprint range BOTH regimes occur. Below the fine octave's texel the
//      fragment is at LOD 0 -- MAGNIFIED -- and above it, minified. The correction makes the case
//      STRONGER, not weaker: at LOD 0 there is no filter footprint at all, so a stochastic tap there
//      does not remove filtering work, it only swaps which texel is read -- noise with no saving.
//   3. Sample reuse shares a texel across lanes via WAVE INTRINSICS. Measured here: zero subgroup
//      or wave-intrinsic use in any TSL or client source.
//   4. Filter-after-shading needs TEMPORAL ACCUMULATION. Measured here: no history buffer, no
//      reprojection, no accumulation pass.
//
//   Then the price. The estimator is unbiased: pick plane i with probability w_i and return T_i, and
//   the expected value is the three-plane blend the fragment ships today. Its per-pixel error is
//   therefore not a bug to be tuned away, it is the variance of that draw, and with three
//   independent texels it is a fixed fraction of the texture's own contrast -- a fraction this
//   witness computes from the shipped weights. The texture's contrast is measured from the shipped
//   JPEGs through the shipped deshade, so the number below is this project's texture, not a guess.
//
// gpu-free and deterministic: it reads source, builds no node graph and never touches an adapter.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERRAIN_DEFAULTS as TD, RELIEF_DESIGN_RADIUS_M } from '../packages/mapspinner/src/terrain-defaults.js'
import { PLANET_RADIUS_M } from '../packages/mapspinner/src/planet-radius.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolvePath(HERE, '..')
const LABEL = 'surface-splat-stochastic-filter'

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), 'true')
}
const flag = (n, d) => (ARGS.has(n) ? ARGS.get(n) : d)
const REGEN = ARGS.has('regen')

const SPLAT_REL = 'packages/mapspinner/src/tsl/surface-splat-tsl.js'
const DECODE_REL = 'packages/mapspinner/src/surface-texture-decode.js'
const ANALYZE_REL = 'scripts/tsl-parity/analyze.mjs'
const CONTRAST_REL = 'scripts/data/surface-texture-contrast.json'
const SPLAT_SRC = readFileSync(join(ROOT, SPLAT_REL), 'utf8')
const DECODE_SRC = readFileSync(join(ROOT, DECODE_REL), 'utf8')
const ANALYZE_SRC = readFileSync(join(ROOT, ANALYZE_REL), 'utf8')
const BACKDROP_SRC = readFileSync(join(ROOT, 'client/core/TerrainBackdrop.js'), 'utf8')

const checks = []
function expect(label, got, want) {
  const pass = Object.is(got, want) || got === want
  checks.push({ label, got, want, pass })
  return pass
}
function expectOp(label, got, op, want) {
  const pass = op === '<=' ? got <= want : op === '>=' ? got >= want : op === '>' ? got > want : got < want
  checks.push({ label, got, op, want, pass })
  return pass
}

// ---- shipped numbers, read out of the source so none of them are restated here ------------------
const SURFACE_SIDE = Number((/const SZ = (\d+)/.exec(DECODE_SRC) || [])[1])
const SCALES = [...SPLAT_SRC.matchAll(/triplanarGrads\(wt, ([\d.]+)\)/g)].map((m) => Number(m[1]))
const DEFAULT_RADIUS_M = Number((/const radius = cfg\.radius \|\| (\d+)/.exec(BACKDROP_SRC) || [])[1])
const TEX_TILE_M = (DEFAULT_RADIUS_M / PLANET_RADIUS_M) * TD.texTile
const RELIEF_SCALE = DEFAULT_RADIUS_M / RELIEF_DESIGN_RADIUS_M
const BAND_LO = TEX_TILE_M / SURFACE_SIDE
const BAND_HI = TEX_TILE_M / SCALES[0]
const FINE_TEXEL_M = TEX_TILE_M / SCALES[0] / SURFACE_SIDE
const COARSE_TEXEL_M = TEX_TILE_M / SCALES[1] / SURFACE_SIDE
const TEXTURED_UNTIL_M = TD.texFar1 * RELIEF_SCALE
const PLANE_TAPS_SHIPPED = 3
const PLANE_TAPS_STOCHASTIC = 1

// ---- 1. each fetch is one hardware-filtered tap of a plain RGBA8 array --------------------------
function fnBody(src, name) {
  const at = src.indexOf(name)
  if (at < 0) return ''
  const end = src.indexOf('\n}', at)
  return end < 0 ? src.slice(at) : src.slice(at, end + 2)
}
const planeTapLine = (SPLAT_SRC.split('\n').find((l) => l.includes('const planeTap =')) || '')
const triTapBody = fnBody(SPLAT_SRC, 'function triTap(')
const triNrmBody = fnBody(SPLAT_SRC, 'function triNrm(')
const countNeedle = (s, n) => s.split(n).length - 1
const swizzlesOf = (s) => [...s.matchAll(/'(yz|xz|xy)'/g)].map((m) => m[1])

expect('the surface texture side is read from the shipped decoder', SURFACE_SIDE, 1024)
expect('the two triplanar octaves are read from the shipped fragment surface', SCALES.length, 2)
expect('a plane tap is exactly one texture fetch', countNeedle(planeTapLine, 'texture('), 1)
expect('a plane tap carries explicit gradients, so the sampler filters in fixed-function hardware', countNeedle(planeTapLine, '.grad('), 1)
expect('a plane tap selects its array layer with depth()', countNeedle(planeTapLine, '.depth('), 1)
expect('triTap is three plane taps', countNeedle(triTapBody, 'planeTap('), PLANE_TAPS_SHIPPED)
expect('triNrm is three plane taps', countNeedle(triNrmBody, 'planeTap('), PLANE_TAPS_SHIPPED)
expect('triTap taps the three distinct planar projections of one point', swizzlesOf(triTapBody).sort().join(','), 'xy,xz,yz')
expect('triNrm taps the three distinct planar projections of one point', swizzlesOf(triNrmBody).sort().join(','), 'xy,xz,yz')
expect('the surface set is built as a plain byte array, so there is no per-texel decode to amortise', /new Uint8Array\(SZ \* SZ \* 4/.test(DECODE_SRC), true)

// ---- 3 and 4. the two mechanisms the technique cannot run without -------------------------------
function walk(dir, out = []) {
  let entries = []
  try { entries = readdirSync(dir) } catch (e) { return out }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'vendor' || e.startsWith('.')) continue
    const p = join(dir, e)
    let st = null
    try { st = statSync(p) } catch (e2) { continue }
    if (st.isDirectory()) { walk(p, out); continue }
    if (/\.(js|mjs|cjs|ts|jsx|tsx)$/.test(e)) out.push(p)
  }
  return out
}
const SCAN_ROOTS = ['client', 'src', 'packages'].map((d) => join(ROOT, d))
const SCAN_FILES = SCAN_ROOTS.flatMap((d) => walk(d))
// A zero-hit scan is only evidence if the scan actually covered the renderer: an empty file list
// would answer "no wave intrinsics" just as happily.
expectOp('the source scan covered more than 100 file(s)', SCAN_FILES.length, '>', 100)
expect('the source scan covered the fragment surface that would carry the technique', SCAN_FILES.some((f) => f.replace(/\\/g, '/').endsWith('tsl/surface-splat-tsl.js')), true)
const SUBGROUP_RE = /\b(subgroup[A-Za-z]*|waveActive[A-Za-z]*|WaveReadLaneAt|QuadRead[A-Za-z]*|quadBroadcast[A-Za-z]*)\b/
const TEMPORAL_RE = /\b(TAA|temporalAccumulat[A-Za-z]*|historyBuffer|historyTexture|prevFrame(Color|Depth|Normal|Texture)|velocityBuffer|accumulationBuffer|reproject[A-Za-z]*|motionVector[A-Za-z]*)\b/
const scanHits = (re) => {
  const hits = []
  for (const f of SCAN_FILES) {
    const txt = readFileSync(f, 'utf8')
    const m = txt.match(re)
    if (m) hits.push(f.slice(ROOT.length + 1) + ' -> ' + m[0])
  }
  return hits
}
const subgroupHits = scanHits(SUBGROUP_RE)
const temporalHits = scanHits(TEMPORAL_RE)
expectOp('the TSL and client sources use no wave intrinsics, so sample reuse has no transport', subgroupHits.length, '<=', 0)
expectOp('no temporal accumulation, history buffer or reprojection exists to filter the noise', temporalHits.length, '<=', 0)

// ---- the parity bar, read out of the shipped analyzer -------------------------------------------
const K = Number((/const K = ([\d.]+)/.exec(ANALYZE_SRC) || [])[1])
const FLOOR_MIN = Number((/FLOOR_MIN = ([\d.]+)/.exec(ANALYZE_SRC) || [])[1])
const SAME_CODE_FLOOR = 0
const BAR = K * Math.max(SAME_CODE_FLOOR, FLOOR_MIN)
expect('the parity K is read from the shipped analyzer', K, 3)
expect('the parity floor minimum is read from the shipped analyzer', FLOOR_MIN, 1)
expect('the fragment is a pure function of its inputs, so the same-code floor is zero', /\b(time|random|Date\.now|performance\.now)\b/.test(SPLAT_SRC), false)

// ---- 2. which regime each footprint is in, and what the fragment pays there ---------------------
const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
const lodOf = (px, texelM) => Math.min(Math.max(Math.log2(px / texelM), 0), Math.log2(SURFACE_SIDE))
function tapsPerLayer(px, camDistM, collapse, planes) {
  const texFarFade = 1 - smoothstep(TD.texFar0 * RELIEF_SCALE, TD.texFar1 * RELIEF_SCALE, px)
  if (!(texFarFade > 0.001)) return 0
  const inBand = collapse > 0.5 && px >= BAND_LO && px <= BAND_HI
  const octFarFade = smoothstep(TD.octFar0 * RELIEF_SCALE, TD.octFar1 * RELIEF_SCALE, px)
  const texFade = 1 - smoothstep(TD.nrmFade0, TD.nrmFade1, camDistM)
  let t = planes
  if (octFarFade !== 0 && !inBand) t += planes
  if (texFade !== 0) {
    t += planes
    if (!inBand) t += planes
  }
  return t
}

const SWEEP_N = 4000
const SWEEP = Array.from({ length: SWEEP_N }, (_, i) => 1e-3 * Math.pow(TEXTURED_UNTIL_M / 1e-3, i / (SWEEP_N - 1)))
const CAM_DIST_M = 50
let magnified = 0, inBandCount = 0, minified = 0
const buckets = new Map()
for (const px of SWEEP) {
  if (px < FINE_TEXEL_M) magnified++
  else minified++
  if (px >= BAND_LO && px <= BAND_HI) inBandCount++
  const key = tapsPerLayer(px, CAM_DIST_M, 1, PLANE_TAPS_SHIPPED) + '/' + tapsPerLayer(px, CAM_DIST_M, 1, PLANE_TAPS_STOCHASTIC)
  buckets.set(key, (buckets.get(key) || 0) + 1)
}
const atPx = (px) => ({
  px: +px.toFixed(4),
  lodFine: +lodOf(px, FINE_TEXEL_M).toFixed(3),
  lodCoarse: +lodOf(px, COARSE_TEXEL_M).toFixed(3),
  shippedPerLayer: tapsPerLayer(px, CAM_DIST_M, 1, PLANE_TAPS_SHIPPED),
  shippedTwoLayers: tapsPerLayer(px, CAM_DIST_M, 1, PLANE_TAPS_SHIPPED) * 2,
  stochasticPerLayer: tapsPerLayer(px, CAM_DIST_M, 1, PLANE_TAPS_STOCHASTIC),
  stochasticTwoLayers: tapsPerLayer(px, CAM_DIST_M, 1, PLANE_TAPS_STOCHASTIC) * 2,
})
// Inside the fine texel the fragment is at LOD 0, and the near band is the part of that which still
// blends the coarse octave; below the coarse octave's own fade-in the second octave is never read at
// all, which is the 9-tap regime the census below also names.
const CLOSEUP_PX = (TD.octFar0 * RELIEF_SCALE) / 8
const NEAR_PX = FINE_TEXEL_M / 2
const MID_PX = Math.sqrt(FINE_TEXEL_M * BAND_LO)
const FAR_PX = (BAND_LO + BAND_HI) / 2
const anchors = [CLOSEUP_PX, NEAR_PX, MID_PX, FAR_PX].map(atPx)

expect('the near band sits at LOD 0, so a stochastic tap there removes no filtering work', lodOf(NEAR_PX, FINE_TEXEL_M), 0)
expectOp('the sweep covers a magnified footprint', magnified, '>', 0)
expectOp('the sweep covers a minified footprint', minified, '>', 0)
expect('the shipped fragment drops the coarse albedo octave on a sub-fade closeup', atPx(CLOSEUP_PX).shippedPerLayer, 9)
expect('the shipped fragment pays the full plane triple per octave on a near-band footprint', atPx(NEAR_PX).shippedPerLayer, 12)
expect('the shipped fragment pays the full plane triple per octave on a mid-band footprint', atPx(MID_PX).shippedPerLayer, 12)
expect('the shipped fragment collapses to one octave inside the coincidence band', atPx(FAR_PX).shippedPerLayer, 6)
expect('the stochastic variant pays one plane per octave on a closeup footprint', atPx(CLOSEUP_PX).stochasticPerLayer, 3)
expect('the stochastic variant pays one plane per octave on a near-band footprint', atPx(NEAR_PX).stochasticPerLayer, 4)
expect('the stochastic variant pays one plane per octave on a mid-band footprint', atPx(MID_PX).stochasticPerLayer, 4)
expect('the stochastic variant pays one plane per octave inside the coincidence band', atPx(FAR_PX).stochasticPerLayer, 2)

// ---- the price: how much noise one plane instead of three puts into a pixel ---------------------
// The unbiased estimator draws plane i with probability w_i and returns T_i. With three independent
// texels of standard deviation s, Var(T_i - Tbar) = s^2 (1 - 2 w_i + sum_j w_j^2), so
//   E|T_i - Tbar| = sqrt(2/pi) s sqrt(1 - 2 w_i + sum_j w_j^2)
// and the region mean this project's analyzer would read is sum_i w_i of that, per channel.
const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI)
function transferOf(w) {
  const s2 = w.reduce((a, v) => a + v * v, 0)
  return w.reduce((a, wi) => a + wi * SQRT_2_OVER_PI * Math.sqrt(Math.max(0, 1 - 2 * wi + s2)), 0)
}
const triSharp = TD.triSharp
function weightsOf(n) {
  const t = [Math.pow(Math.abs(n[0]), triSharp), Math.pow(Math.abs(n[1]), triSharp), Math.pow(Math.abs(n[2]), triSharp)]
  const s = t[0] + t[1] + t[2] || 1
  return [t[0] / s, t[1] / s, t[2] / s]
}
const normalAtSlopeDeg = (deg) => {
  const a = (deg * Math.PI) / 180
  return [Math.sin(a), Math.cos(a), 0]
}
const NORMALS = (() => {
  const out = []
  const N = 2000
  for (let i = 0; i < N; i++) {
    const y = 1 - (i + 0.5) / N
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const phi = (i + 0.5) * 2.399963229728653
    out.push([r * Math.cos(phi), y, r * Math.sin(phi)])
  }
  return out
})()
const transfers = NORMALS.map((n) => transferOf(weightsOf(n)))
const transferMean = transfers.reduce((a, v) => a + v, 0) / transfers.length
const transferMax = Math.max(...transfers)
// Slopes, not weights, are what a terrain renderer actually shows: a perfectly axis-aligned normal
// degenerates to a deterministic pick, so the honest question is where the crossover sits.
const SLOPE_CLASSES = [[0, 15, 'gentle'], [15, 35, 'moderate'], [35, 60, 'steep'], [60, 90, 'near-vertical']]
const slopeClasses = SLOPE_CLASSES.map(([lo, hi, name]) => {
  const vals = []
  for (let d = lo; d <= hi; d += 0.5) vals.push(transferOf(weightsOf(normalAtSlopeDeg(d))))
  return { name, lo, hi, transfer: +(vals.reduce((a, v) => a + v, 0) / vals.length).toFixed(4) }
})
const transferModerate = slopeClasses.find((c) => c.name === 'moderate').transfer
const transferSteep = slopeClasses.find((c) => c.name === 'steep').transfer
const CEILING_MEAN = BAR / transferMean
// The slope range over which the estimator's error sits above the parity bar, found rather than
// asserted. Both ends are real: an axis-aligned normal degenerates to a deterministic pick, so the
// error rises out of the bar as the surface tilts off the axis and falls back into it only as the
// normal approaches the next axis -- a measure-zero pose, not a regime a cliff presents.
function barBand(sd255) {
  const over = []
  for (let d = 0; d <= 90; d += 0.25) {
    if (transferOf(weightsOf(normalAtSlopeDeg(d))) * sd255 > BAR) over.push(d)
  }
  if (!over.length) return { loDeg: null, hiDeg: null, frac: 0 }
  return { loDeg: Math.min(...over), hiDeg: Math.max(...over), frac: +(over.length / 361).toFixed(3) }
}

// ---- the texture's own contrast, measured from the shipped JPEGs through the shipped deshade ----
const MATS = ['grass', 'rock', 'sand', 'snow']
const NRM_JPGS = ['grass-normals.jpg', 'ground-normals.jpg', 'sand-normals.jpg', 'snow-normals.jpg']
const G = 32
const DESHADE_GAIN_EXPONENT = 0.8, DESHADE_GAIN_MIN = 0.4, DESHADE_GAIN_MAX = 2.5, FINE_CONTRAST_STRETCH = 1.35
const LIN8 = new Float32Array(256)
for (let v = 0; v < 256; v++) LIN8[v] = Math.pow(v / 255, 2.2)
const DELIN_T = (() => {
  const T = new Float64Array(256)
  const orc = (x) => Math.min(255, Math.max(0, Math.round(Math.pow(x, 1 / 2.2) * 255)))
  for (let k = 1; k <= 255; k++) {
    let lo = 0, hi = 2
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (orc(mid) >= k) hi = mid; else lo = mid }
    T[k] = hi
  }
  return T
})()
const delin8 = (x) => { let lo = 1, hi = 255, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (DELIN_T[m] <= x) { r = m; lo = m + 1 } else hi = m - 1 } return r }
const sdOf = (arr, ch, stride) => {
  let s = 0, s2 = 0, n = 0
  for (let i = 0; i < arr.length; i += stride) { const v = arr[i + ch]; s += v; s2 += v * v; n++ }
  const mu = s / n
  return +Math.sqrt(Math.max(0, s2 / n - mu * mu)).toFixed(2)
}

let contrast = null
if (REGEN) {
  const sharp = (await import('sharp')).default
  const cell = SURFACE_SIDE / G
  contrast = { generatedBy: 'scripts/' + 'surface-splat-stochastic-filter-witness.mjs --regen', ts: new Date().toISOString(), sz: SURFACE_SIDE, layers: {} }
  for (let m = 0; m < MATS.length; m++) {
    const albBuf = readFileSync(join(ROOT, 'packages/mapspinner/textures', MATS[m] + '-color.jpg'))
    const c = new Uint8Array((await sharp(albBuf).resize(SURFACE_SIDE, SURFACE_SIDE, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data)
    const grid = new Float32Array(G * G * 3), cnt = cell * cell
    for (let y = 0; y < SURFACE_SIDE; y++) for (let x = 0; x < SURFACE_SIDE; x++) {
      const i = (y * SURFACE_SIDE + x) * 4, g = (((y / cell) | 0) * G + ((x / cell) | 0)) * 3
      grid[g] += LIN8[c[i]]; grid[g + 1] += LIN8[c[i + 1]]; grid[g + 2] += LIN8[c[i + 2]]
    }
    const gMean = [0, 0, 0]
    for (let g = 0; g < G * G; g++) for (let ch = 0; ch < 3; ch++) { grid[g * 3 + ch] /= cnt; gMean[ch] += grid[g * 3 + ch] }
    for (let ch = 0; ch < 3; ch++) gMean[ch] /= G * G
    for (let y = 0; y < SURFACE_SIDE; y++) for (let x = 0; x < SURFACE_SIDE; x++) {
      const gx = x / cell - 0.5, gy = y / cell - 0.5
      const x0 = (Math.floor(gx) + G) % G, y0 = (Math.floor(gy) + G) % G
      const x1 = (x0 + 1) % G, y1 = (y0 + 1) % G
      const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy)
      const i = (y * SURFACE_SIDE + x) * 4
      for (let ch = 0; ch < 3; ch++) {
        const blur = (grid[(y0 * G + x0) * 3 + ch] * (1 - fx) + grid[(y0 * G + x1) * 3 + ch] * fx) * (1 - fy)
          + (grid[(y1 * G + x0) * 3 + ch] * (1 - fx) + grid[(y1 * G + x1) * 3 + ch] * fx) * fy
        const s = Math.min(DESHADE_GAIN_MAX, Math.max(DESHADE_GAIN_MIN, Math.pow(gMean[ch] / Math.max(blur, 1e-4), DESHADE_GAIN_EXPONENT)))
        const v = LIN8[c[i + ch]] * s
        c[i + ch] = delin8(Math.max(0, gMean[ch] + (v - gMean[ch]) * FINE_CONTRAST_STRETCH))
      }
    }
    const nrmBuf = readFileSync(join(ROOT, 'packages/mapspinner/textures', NRM_JPGS[m]))
    const n = new Uint8Array((await sharp(nrmBuf).resize(SURFACE_SIDE, SURFACE_SIDE, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data)
    contrast.layers[MATS[m]] = {
      albSd255: [0, 1, 2].map((ch) => sdOf(c, ch, 4)),
      nrmSd255: [0, 1].map((ch) => sdOf(n, ch, 4)),
    }
  }
  mkdirSync(join(ROOT, 'scripts/data'), { recursive: true })
  writeFileSync(join(ROOT, CONTRAST_REL), JSON.stringify(contrast, null, 1))
  console.log(`[${LABEL}] regenerated ${CONTRAST_REL}`)
} else {
  try { contrast = JSON.parse(readFileSync(join(ROOT, CONTRAST_REL), 'utf8')) } catch (e) { contrast = null }
}
if (!contrast) {
  console.error(`RESULT: FAIL ${LABEL} -- ${CONTRAST_REL} is absent or unreadable, so the shipped surface texture contrast is unmeasured and the noise price cannot be stated (rebuild it with --regen)`)
  process.exit(1)
}
expect('the recorded contrast was measured at the shipped texture side', contrast.sz, SURFACE_SIDE)

const layerRows = []
for (const m of MATS) {
  const L = contrast.layers[m]
  const sdMean = (L.albSd255[0] + L.albSd255[1] + L.albSd255[2]) / 3
  layerRows.push({
    mat: m,
    albSd255: L.albSd255,
    albSdMean255: +sdMean.toFixed(2),
    meanAbs255: +(transferMean * sdMean).toFixed(2),
    bySlope255: Object.fromEntries(slopeClasses.map((c) => [c.name, +(c.transfer * sdMean).toFixed(2)])),
    barBand: barBand(sdMean),
    nrmSd255: L.nrmSd255,
    nrmTangentSd: +(2 * ((L.nrmSd255[0] + L.nrmSd255[1]) / 2) / 255).toFixed(4),
  })
}
const GRASS = layerRows.find((r) => r.mat === 'grass')
const ROCK = layerRows.find((r) => r.mat === 'rock')

// ---- verdict ------------------------------------------------------------------------------------
expect('the fraction of the textured footprint range that is in the coincidence band is under a half', inBandCount / SWEEP_N < 0.5, true)
expectOp('the mean transfer from texture contrast to per-pixel error is a real fraction', transferMean, '>', 0.1)
expectOp('the grass layer contrast exceeds the ceiling the parity bar allows', GRASS.albSdMean255, '>', CEILING_MEAN)
expectOp('the rock layer contrast exceeds the ceiling the parity bar allows', ROCK.albSdMean255, '>', CEILING_MEAN)
expectOp('the stochastic estimator puts more than the parity bar into a grass pixel', GRASS.meanAbs255, '>', BAR)
expectOp('the stochastic estimator puts more than the parity bar into a grass pixel on a moderate slope', GRASS.bySlope255.moderate, '>', BAR)
expectOp('the stochastic estimator puts more than the parity bar into a rock pixel on a moderate slope', ROCK.bySlope255.moderate, '>', BAR)
expectOp('the grass layer is over the parity bar by the time a slope reaches 45 deg', GRASS.barBand.loDeg, '<', 45)
expectOp('the grass layer is over the parity bar across most of the slope range', GRASS.barBand.frac, '>', 0.5)
expectOp('the rock layer is over the parity bar across most of the slope range', ROCK.barBand.frac, '>', 0.5)
expectOp('every layer but the near-flat sand one crosses the parity bar on a steep slope', layerRows.filter((r) => r.mat !== 'sand' && r.bySlope255.steep > BAR).length, '>=', MATS.length - 1)

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.label}: got ${JSON.stringify(c.got)} want ${c.op || ''}${JSON.stringify(c.want)}`)

console.log(`[${LABEL}] footprint model: radius ${DEFAULT_RADIUS_M} m, reliefScale ${RELIEF_SCALE}, tile ${TEX_TILE_M} m, fine texel ${FINE_TEXEL_M.toFixed(4)} m, coarse texel ${COARSE_TEXEL_M.toFixed(4)} m`)
console.log(`[${LABEL}] coincidence band ${BAND_LO.toFixed(4)}..${BAND_HI.toFixed(4)} m/px; textured until ${TEXTURED_UNTIL_M.toFixed(3)} m/px; ${magnified}/${SWEEP_N} sweep footprint(s) magnified, ${minified} minified, ${inBandCount} in band`)
console.log(`[${LABEL}] taps per pixel by footprint (two layers): ${anchors.map((a) => `px=${a.px} lod=${a.lodFine}/${a.lodCoarse} shipped=${a.shippedTwoLayers} stochastic=${a.stochasticTwoLayers}`).join(' | ')}`)
console.log(`[${LABEL}] sweep tap census (shipped per layer / stochastic per layer -> footprint count): ${[...buckets.entries()].sort().map(([k, v]) => `${k}->${v}`).join(', ')}`)
console.log(`[${LABEL}] parity: K=${K} floorMin=${FLOOR_MIN} same-code floor=${SAME_CODE_FLOOR} -> bar ${BAR}/255`)
console.log(`[${LABEL}] estimator transfer (meanAbs per unit of texture contrast): hemisphere mean ${transferMean.toFixed(4)}, worst ${transferMax.toFixed(4)}, by slope ${slopeClasses.map((c) => `${c.name} ${c.lo}-${c.hi}deg ${c.transfer}`).join(', ')}`)
console.log(`[${LABEL}] contrast ceiling the bar allows: ${CEILING_MEAN.toFixed(2)}/255 at the hemisphere-mean weight`)
for (const r of layerRows) {
  console.log(`[${LABEL}] ${r.mat}: texture sd ${JSON.stringify(r.albSd255)}/255 -> meanAbs ${r.meanAbs255} (${slopeClasses.map((c) => `${c.name} ${r.bySlope255[c.name]}`).join(', ')})/255 against a ${BAR}/255 bar; over the bar from ${r.barBand.loDeg === null ? 'nowhere' : r.barBand.loDeg + ' deg to ' + r.barBand.hiDeg + ' deg (' + (100 * r.barBand.frac).toFixed(1) + '% of the slope range)'}; normal sd ${JSON.stringify(r.nrmSd255)}/255 -> tangent sd ${r.nrmTangentSd}`)
}
console.log(`[${LABEL}] subgroup/wave-intrinsic hit(s) across ${SCAN_FILES.length} scanned source file(s): ${subgroupHits.length}${subgroupHits.length ? ' -- ' + subgroupHits.slice(0, 6).join('; ') : ''}`)
console.log(`[${LABEL}] temporal-accumulation hit(s) across ${SCAN_FILES.length} scanned source file(s): ${temporalHits.length}${temporalHits.length ? ' -- ' + temporalHits.slice(0, 6).join('; ') : ''}`)

if (failed.length > 0) {
  console.log(`RESULT: FAIL ${failed.length} of ${checks.length} check(s) failed label=${LABEL}`)
  process.exit(1)
}
console.log(`MEASURED ${LABEL}: shipped ${atPx(NEAR_PX).shippedPerLayer} triplanar fetch(es) per layer on a near-band footprint at lod ${atPx(NEAR_PX).lodFine} (${atPx(NEAR_PX).shippedTwoLayers} with two layers), ${atPx(FAR_PX).shippedPerLayer} inside the coincidence band; stochastic variant ${atPx(NEAR_PX).stochasticPerLayer}/${atPx(FAR_PX).stochasticPerLayer}; grass meanAbs ${GRASS.meanAbs255}/255 against a ${BAR}/255 bar (x${(GRASS.meanAbs255 / BAR).toFixed(2)}, over the bar from ${GRASS.barBand.loDeg} deg), rock ${ROCK.meanAbs255}/255 (x${(ROCK.meanAbs255 / BAR).toFixed(2)}); subgroup hit(s) ${subgroupHits.length}, temporal hit(s) ${temporalHits.length}; ${checks.length} check(s) passed`)
console.log(`RESULT: PASS ${checks.length} check(s) label=${LABEL} adopted=false`)
