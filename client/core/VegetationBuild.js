import * as THREE from 'three'
import { MeshoptSimplifier } from 'meshoptimizer'

let _ezTreeModPromise = null
function loadEzTree() {
  if (!_ezTreeModPromise) _ezTreeModPromise = import('@dgreenheck/ez-tree')
  return _ezTreeModPromise
}
import { createOctahedralImpostorMaterial, computeObjectBoundingSphere } from 'streaming-gltf/octahedral-impostor-ez'
import { buildSharedImpostorAtlas, createSharedImpostorMesh } from './VegImpostorTier.js'
import { placementsForChunk, VEG, SPECIES } from '/src/terrain/VegPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { dbg } from './debug-log.js'
import { RenderControls } from './RenderControls.js'
import { assertTreeTextureMaxPx, halvingsFor, mipChainBytes } from './TreeTextureBudget.js'

const _dbgVeg = dbg('vegetation')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)
const _occBoxMat = new THREE.MeshBasicMaterial()

const PRESET = {
  'Oak Large': 'Oak Large', 'Pine Medium': 'Pine Medium', 'Aspen Medium': 'Aspen Medium', 'Ash Medium': 'Ash Medium', 'Bush': 'Bush 1',
  'Ash Small': 'Ash Small', 'Ash Large': 'Ash Large', 'Aspen Small': 'Aspen Small', 'Aspen Large': 'Aspen Large', 'Bush 2': 'Bush 2',
  'Bush 3': 'Bush 3', 'Oak Small': 'Oak Small', 'Oak Medium': 'Oak Medium', 'Pine Small': 'Pine Small', 'Pine Large': 'Pine Large',
}

const TARGET_H = {
  'Oak Large': 9, 'Pine Medium': 12, 'Aspen Medium': 9.5, 'Ash Medium': 10, 'Bush': 2.8,
  'Ash Small': 6.5, 'Ash Large': 13, 'Aspen Small': 6, 'Aspen Large': 13, 'Bush 2': 3.0,
  'Bush 3': 3.2, 'Oak Small': 5.5, 'Oak Medium': 7, 'Pine Small': 8, 'Pine Large': 16,
}

const DROP_HYSTERESIS_MARGIN_M = 64
const TERRAIN_ZFIGHT_POLYGON_OFFSET_FACTOR = -4
const TERRAIN_ZFIGHT_POLYGON_OFFSET_UNITS = -32

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _camPos = new THREE.Vector3()
const _vanMat = new THREE.Matrix4(), _vanProj = new THREE.Matrix4(), _vanFrustum = new THREE.Frustum()

function makeWindUniforms() { return { uVegTime: { value: 0 }, uVegWind: { value: 1 } } }

function applyWind(material, wind) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uVegTime = wind.uVegTime
    shader.uniforms.uVegWind = wind.uVegWind
    shader.vertexShader = 'uniform float uVegTime;\nuniform float uVegWind;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n' +
      'float _wsway = (position.y) * 0.06;\n' +
      'float _wph = uVegTime * 1.3 + windPhase;\n' +
      'transformed.x += sin(_wph) * _wsway * uVegWind;\n' +
      'transformed.z += cos(_wph * 0.8) * _wsway * 0.6 * uVegWind;')
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\n diffuseColor.rgb *= tint;')
  }
  material.customProgramCacheKey = () => 'vegwind4'
  return material
}

async function awaitMatTextures(mats) {
  const _t0 = _now()
  try { return await _awaitMatTextures(mats) } finally { _span('await-tex', _t0) }
}

async function _awaitMatTextures(mats) {
  const texes = []
  for (const m of mats) {
    if (!m) continue
    for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'alphaMap', 'bumpMap']) {
      const t = m[k]; if (t && t.isTexture) texes.push(t)
    }
  }
  await Promise.all(texes.map((t) => _awaitOneTexture(t)))
}

const _decoded = new WeakMap()
function decodeImage(img) {
  let p = _decoded.get(img)
  if (!p) {
    p = img.decode().then(() => true, () => { _decoded.delete(img); return false })
    _decoded.set(img, p)
  }
  return p
}

async function _awaitOneTexture(t) {
  const img = t.image
  if (img && typeof img.decode === 'function') {
    try { if (await decodeImage(img)) { t.needsUpdate = true; return } } catch (_) {}
  }
  for (let i = 0; i < 60; i++) {
    if (t.image && (t.image.width > 0 || t.image.videoWidth > 0)) { t.needsUpdate = true; return }
    await new Promise(r => setTimeout(r, 16))
  }
}

let _spanLabel = 'boot'
const _span = (step, t0, t1) => {
  if (typeof performance === 'undefined') return
  try { performance.measure('boot:vegetation:' + _spanLabel + ':' + step, { start: t0, end: t1 || performance.now() }) } catch (_) {}
}
const _now = () => (typeof performance !== 'undefined' ? performance.now() : 0)

const halvedBySource = new WeakMap()
const halvedOutputs = new WeakSet()
const _halveRefusals = []
const _halveCounts = {}

export function treeTextureHalveRefusals() { return _halveRefusals.slice() }

export function treeTextureStats() {
  const byKind = {}
  for (const k of Object.keys(_halveCounts)) byKind[k] = { ..._halveCounts[k] }
  return byKind
}

function halveCountsFor(kind) {
  let c = _halveCounts[kind]
  if (!c) { c = { seen: 0, halved: 0, notDecoded: 0, sourceBytes: 0, residentBytes: 0 }; _halveCounts[kind] = c }
  return c
}

function halveOnce(tex) {
  const w = tex.image.width >> 1, h = tex.image.height >> 1
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  cv.getContext('2d').drawImage(tex.image, 0, 0, w, h)
  const next = new THREE.CanvasTexture(cv)
  next.colorSpace = tex.colorSpace
  next.wrapS = tex.wrapS; next.wrapT = tex.wrapT
  next.flipY = tex.flipY
  next.anisotropy = tex.anisotropy
  next.generateMipmaps = true
  next.minFilter = THREE.LinearMipmapLinearFilter
  return next
}

function halveTexture(tex, maxPx, kind) {
  const img = tex && tex.image
  if (!img) return tex
  if (halvedOutputs.has(tex)) return tex
  const w = img.width | 0
  if (!(w > 0)) {
    // An undecoded image cannot be budgeted, and handing the full-size original
    // back is exactly the silent no-op this budget exists to remove, so the miss
    // is recorded where a witness can count it instead of passing unnoticed.
    halveCountsFor(kind).notDecoded++
    _halveRefusals.push({ reasonCode: 'texture-not-decoded', kind, maxPx })
    console.error(`[veg-tex] ${kind} texture still undecoded at halve time -- ${maxPx}px budget not applied`)
    return tex
  }
  let byMax = halvedBySource.get(img)
  if (!byMax) { byMax = new Map(); halvedBySource.set(img, byMax) }
  const cached = byMax.get(maxPx)
  if (cached) return cached
  const halvings = halvingsFor(w, maxPx)
  let cur = tex
  for (let i = 0; i < halvings; i++) cur = halveOnce(cur)
  halvedOutputs.add(cur)
  byMax.set(maxPx, cur)
  const c = halveCountsFor(kind)
  c.seen++
  if (halvings > 0) c.halved++
  c.sourceBytes += mipChainBytes(w, img.height | 0)
  c.residentBytes += mipChainBytes(cur.image.width | 0, cur.image.height | 0)
  return cur
}

export function halveTreeMaterialTextures(mat, maxPx, kind = 'tree') {
  if (!mat) return
  assertTreeTextureMaxPx(maxPx, `halveTreeMaterialTextures(${kind}) maxPx`)
  const _t0 = _now()
  try { _halveTreeMaterialTextures(mat, maxPx, kind) } finally { _span('halve-tex', _t0) }
}

function _halveTreeMaterialTextures(mat, maxPx, kind) {
  for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'alphaMap', 'bumpMap']) {
    const t = mat[k]
    if (!t || !t.isTexture) continue
    const next = halveTexture(t, maxPx, kind)
    if (next !== t) { mat[k] = next; mat.needsUpdate = true }
  }
}

async function capGeo(geo, maxTris) {
  const _t0 = _now()
  try { return await _capGeo(geo, maxTris) } finally { _span('capgeo', _t0) }
}

async function _capGeo(geo, maxTris) {
  const idx = geo.index ? geo.index.array : null
  if (!idx) return geo.clone()
  const tris = idx.length / 3
  if (tris <= maxTris) return geo.clone()
  // LOD0 is the near band. Reaching an aggressive cap on a leaf-card cloud is only
  // possible by merging whole leaf cards into one, which is a visible change at
  // that range, so the cap is refused here rather than delivered: a budget that is
  // asked for and not delivered must say so, not hand back the source quietly.
  const out = await simplifyGeo(geo, maxTris / tris, false, false)
  const delivered = triCountOf(out)
  if (delivered <= maxTris) return out
  const cloud = leafCardCloudOf(geo)
  const mergeFactor = cloud ? cloud.cards / Math.max(1, Math.floor(maxTris / 2)) : null
  refuseCap({
    species: _currentSpecies,
    kind: cloud ? 'leaf-card-cloud' : 'mesh',
    target: maxTris,
    delivered,
    source: tris,
    cards: cloud ? cloud.cards : null,
    mergeFactor,
    reason: cloud
      ? `leaf-card cloud of ${cloud.cards} card(s): reaching ${maxTris} triangle(s) means merging ${mergeFactor.toFixed(2)} leaf card(s) into one, which is a visible change in the near band, and meshopt at strict error 0.02 stops at ${delivered}`
      : `meshopt simplify at strict error 0.02 stops at ${delivered} of ${tris} triangle(s)`,
  })
  return out
}

// A leaf cloud is a flat list of independent quads: card c owns vertices 4c..4c+3,
// and every triangle stays inside one such group. meshopt's vertex collapse cannot
// decimate it -- collapsing inside a card moves the leaf by the leaf's own size, so
// the strict 0.02 error budget refuses nearly every collapse and the call hands back
// the input. The unit of decimation for a leaf cloud is therefore the CARD, not the
// vertex: cluster cards by Morton order of their centroids and emit one card per
// cluster carrying the cluster's total leaf area, so the canopy keeps its area as
// the triangle count falls.
const LEAF_CARD_VERTICES = 4

function triCountOf(geo) { return geo && geo.index ? geo.index.array.length / 3 : 0 }

function leafCardCloudOf(geo) {
  const idx = geo && geo.index ? geo.index.array : null
  const pos = geo && geo.attributes ? geo.attributes.position : null
  if (!idx || !pos || idx.length < 3) return null
  if (!pos.count || pos.count % LEAF_CARD_VERTICES !== 0) return null
  const groups = pos.count / LEAF_CARD_VERTICES
  const live = new Uint8Array(groups)
  for (let t = 0; t < idx.length; t += 3) {
    const g = (idx[t] / LEAF_CARD_VERTICES) | 0
    if (g !== ((idx[t + 1] / LEAF_CARD_VERTICES) | 0)) return null
    if (g !== ((idx[t + 2] / LEAF_CARD_VERTICES) | 0)) return null
    live[g] = 1
  }
  let cards = 0
  for (let g = 0; g < groups; g++) if (live[g]) cards++
  return cards < 2 ? null : { live, groups, cards }
}

function mortonSpread10(v) {
  v = (v | (v << 16)) & 0x030000ff
  v = (v | (v << 8)) & 0x0300f00f
  v = (v | (v << 4)) & 0x030c30c3
  v = (v | (v << 2)) & 0x09249249
  return v
}

const _mergedLeaf = new WeakMap()

function mergedLeafCloud(geo, targetTris) {
  const cloud = leafCardCloudOf(geo)
  if (!cloud) return null
  const { live, groups, cards } = cloud
  const keep = Math.max(1, Math.floor(targetTris / 2))
  if (keep >= cards) return null
  const nameList = []
  for (const n of Object.keys(geo.attributes)) {
    const a = geo.attributes[n]
    if (!a || !a.array || a.isInterleavedBufferAttribute) return null
    if (n === 'instanceIndex') continue
    nameList.push(n)
  }
  const cached = _mergedLeaf.get(geo)
  if (cached && cached.keep === keep) return cached.out

  const src = geo.attributes.position.array
  const cardOf = new Uint32Array(cards)
  let n = 0
  for (let g = 0; g < groups; g++) if (live[g]) cardOf[n++] = g
  const cent = new Float64Array(cards * 3)
  const nrm = new Float64Array(cards * 3)
  const area = new Float64Array(cards)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let areaBefore = 0
  for (let i = 0; i < cards; i++) {
    const v0 = cardOf[i] * LEAF_CARD_VERTICES, v1 = v0 + 1, v3 = v0 + 3
    const ax = src[v0 * 3], ay = src[v0 * 3 + 1], az = src[v0 * 3 + 2]
    const ux = src[v1 * 3] - ax, uy = src[v1 * 3 + 1] - ay, uz = src[v1 * 3 + 2] - az
    const wx = src[v3 * 3] - ax, wy = src[v3 * 3 + 1] - ay, wz = src[v3 * 3 + 2] - az
    let gx = uy * wz - uz * wy, gy = uz * wx - ux * wz, gz = ux * wy - uy * wx
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz)
    if (gl > 1e-12) { gx /= gl; gy /= gl; gz /= gl } else { gx = 0; gy = 1; gz = 0 }
    area[i] = gl
    areaBefore += gl
    nrm[i * 3] = gx; nrm[i * 3 + 1] = gy; nrm[i * 3 + 2] = gz
    const mx = ax + 0.5 * ux + 0.5 * wx, my = ay + 0.5 * uy + 0.5 * wy, mz = az + 0.5 * uz + 0.5 * wz
    cent[i * 3] = mx; cent[i * 3 + 1] = my; cent[i * 3 + 2] = mz
    if (mx < minX) minX = mx
    if (my < minY) minY = my
    if (mz < minZ) minZ = mz
    if (mx > maxX) maxX = mx
    if (my > maxY) maxY = my
    if (mz > maxZ) maxZ = mz
  }
  const sx = 1023 / Math.max(1e-6, maxX - minX)
  const sy = 1023 / Math.max(1e-6, maxY - minY)
  const sz = 1023 / Math.max(1e-6, maxZ - minZ)
  const keys = new Float64Array(cards)
  for (let i = 0; i < cards; i++) {
    const qx = mortonSpread10(Math.max(0, Math.min(1023, Math.floor((cent[i * 3] - minX) * sx))))
    const qy = mortonSpread10(Math.max(0, Math.min(1023, Math.floor((cent[i * 3 + 1] - minY) * sy))))
    const qz = mortonSpread10(Math.max(0, Math.min(1023, Math.floor((cent[i * 3 + 2] - minZ) * sz))))
    keys[i] = qx * 4 + qy * 2 + qz
  }
  const ord = new Array(cards)
  for (let i = 0; i < cards; i++) ord[i] = i
  ord.sort((a, b) => keys[a] - keys[b])

  const srcAttrs = nameList.map((k) => geo.attributes[k])
  const outAttrs = srcAttrs.map((a) => new a.array.constructor(keep * LEAF_CARD_VERTICES * a.itemSize))
  const posSlot = nameList.indexOf('position')
  const nrmSlot = nameList.indexOf('normal')
  const posOut = outAttrs[posSlot]
  const nrmOut = nrmSlot >= 0 ? outAttrs[nrmSlot] : null
  const run = cards / keep
  for (let j = 0; j < keep; j++) {
    const s0 = Math.floor(j * run)
    const s1 = Math.max(s0 + 1, Math.min(cards, Math.floor((j + 1) * run)))
    let sumA = 0, cX = 0, cY = 0, cZ = 0, nX = 0, nY = 0, nZ = 0, best = -1, bestA = -1
    for (let s = s0; s < s1; s++) {
      const i = ord[s]
      const a = area[i]
      sumA += a
      cX += cent[i * 3] * a; cY += cent[i * 3 + 1] * a; cZ += cent[i * 3 + 2] * a
      nX += nrm[i * 3] * a; nY += nrm[i * 3 + 1] * a; nZ += nrm[i * 3 + 2] * a
      if (a > bestA) { bestA = a; best = i }
    }
    const inv = sumA > 1e-12 ? 1 / sumA : 0
    cX *= inv; cY *= inv; cZ *= inv
    nX *= inv; nY *= inv; nZ *= inv
    let nl = Math.sqrt(nX * nX + nY * nY + nZ * nZ)
    if (!(nl > 1e-9)) { nX = nrm[best * 3]; nY = nrm[best * 3 + 1]; nZ = nrm[best * 3 + 2]; nl = 1 }
    nX /= nl; nY /= nl; nZ /= nl
    const b0 = cardOf[best] * LEAF_CARD_VERTICES, b1 = b0 + 1
    let tx = src[b1 * 3] - src[b0 * 3], ty = src[b1 * 3 + 1] - src[b0 * 3 + 1], tz = src[b1 * 3 + 2] - src[b0 * 3 + 2]
    const d = tx * nX + ty * nY + tz * nZ
    tx -= d * nX; ty -= d * nY; tz -= d * nZ
    let tl = Math.sqrt(tx * tx + ty * ty + tz * tz)
    if (!(tl > 1e-9)) {
      tx = Math.abs(nY) < 0.9 ? 0 : 1; ty = Math.abs(nY) < 0.9 ? 1 : 0; tz = 0
      const d2 = tx * nX + ty * nY + tz * nZ
      tx -= d2 * nX; ty -= d2 * nY; tz -= d2 * nZ
      tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1
    }
    tx /= tl; ty /= tl; tz /= tl
    const bx = nY * tz - nZ * ty, by = nZ * tx - nX * tz, bz = nX * ty - nY * tx
    const half = Math.sqrt(sumA) / 2
    for (let k = 0; k < LEAF_CARD_VERTICES; k++) {
      const su = (k === 1 || k === 2) ? half : -half
      const sv = (k === 2 || k === 3) ? half : -half
      const v = j * LEAF_CARD_VERTICES + k
      posOut[v * 3] = cX + su * tx + sv * bx
      posOut[v * 3 + 1] = cY + su * ty + sv * by
      posOut[v * 3 + 2] = cZ + su * tz + sv * bz
      if (nrmOut) { nrmOut[v * 3] = nX; nrmOut[v * 3 + 1] = nY; nrmOut[v * 3 + 2] = nZ }
      for (let ai = 0; ai < srcAttrs.length; ai++) {
        if (ai === posSlot || (nrmOut && ai === nrmSlot)) continue
        const a = srcAttrs[ai]
        const from = (b0 + k) * a.itemSize, to = v * a.itemSize
        for (let e = 0; e < a.itemSize; e++) outAttrs[ai][to + e] = a.array[from + e]
      }
    }
  }
  const out = new THREE.BufferGeometry()
  for (let i = 0; i < nameList.length; i++) out.setAttribute(nameList[i], new THREE.BufferAttribute(outAttrs[i], srcAttrs[i].itemSize))
  const idxCtor = keep * LEAF_CARD_VERTICES > 65535 ? Uint32Array : Uint16Array
  const newIdx = new (idxCtor)(keep * 6)
  for (let j = 0; j < keep; j++) {
    const v = j * LEAF_CARD_VERTICES, b = j * 6
    newIdx[b] = v; newIdx[b + 1] = v + 1; newIdx[b + 2] = v + 2
    newIdx[b + 3] = v; newIdx[b + 4] = v + 2; newIdx[b + 5] = v + 3
  }
  out.setIndex(new THREE.BufferAttribute(newIdx, 1))
  const result = { geometry: out, delivered: keep * 2, cards, keep, mergeFactor: cards / keep, areaBefore }
  _mergedLeaf.set(geo, { keep, out: result })
  return result
}

function _stripInstanceIndexStamp(g) {
  if (g.getAttribute && g.getAttribute('instanceIndex')) g.deleteAttribute('instanceIndex')
  return g
}

let _currentSpecies = 'unknown'
const _capRefusals = []

export function leafCapRefusals() { return _capRefusals.slice() }

function refuseCap(row) {
  _capRefusals.push(row)
  console.error(`[veg-cap] cap unmet: species=${row.species} kind=${row.kind} target=${row.target} tri delivered=${row.delivered} of ${row.source} -- ${row.reason}`)
}

async function simplifyGeo(geo, ratio, sloppy, leafMerge = true) {
  const _t0 = _now()
  try { return await _simplifyGeo(geo, ratio, sloppy, leafMerge) } finally { _span('simplifygeo', _t0) }
}

const _simplifiedIndex = new WeakMap()

async function _simplifyGeo(geo, ratio, sloppy, leafMerge) {
  try {
    await MeshoptSimplifier.ready
    const idx = geo.index ? geo.index.array : null
    const pos = geo.attributes.position.array
    if (!idx || !pos) return _stripInstanceIndexStamp(geo.clone())
    const variant = ratio + ':' + (sloppy ? 'sloppy' : 'strict') + ':' + (leafMerge ? 'merge' : 'nomerge')
    let byVariant = _simplifiedIndex.get(geo)
    if (!byVariant) { byVariant = new Map(); _simplifiedIndex.set(geo, byVariant) }
    let newIdx = byVariant.get(variant)
    if (!newIdx) {
      const target = Math.max(12, Math.floor((idx.length / 3) * ratio) * 3)
      const fn = sloppy && MeshoptSimplifier.simplifySloppy ? 'simplifySloppy' : 'simplify'
      const args = sloppy ? [idx, pos, 3, null, target, 0.05] : [idx, pos, 3, target, 0.02, ['Sparse']]
      newIdx = MeshoptSimplifier[fn](...args)[0]
      byVariant.set(variant, newIdx)
    }
    const out = geo.clone()
    if (newIdx && newIdx.length >= 3) out.setIndex(new THREE.BufferAttribute(newIdx, 1))
    const meshoptOut = _stripInstanceIndexStamp(out)
    if (!leafMerge) return meshoptOut
    const targetTris = Math.floor((idx.length / 3) * ratio)
    if (triCountOf(meshoptOut) <= targetTris) return meshoptOut
    const merged = mergedLeafCloud(geo, targetTris)
    if (merged && merged.delivered < triCountOf(meshoptOut)) return merged.geometry
    return meshoptOut
  } catch (_) { return _stripInstanceIndexStamp(geo.clone()) }
}

const VARIANT_LEAF_TINT_BIAS = [[1, 1, 1], [1.06, 1.0, 0.90], [0.92, 1.04, 1.0]]

function nameHash(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
  return h
}

function variantRng(name, variant) {
  let a = nameHash(name) ^ Math.imul(variant, 0x9e3779b1)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function biasHexTint(hex, bias) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * bias[0]))
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * bias[1]))
  const b = Math.min(255, Math.round((hex & 255) * bias[2]))
  return (r << 16) | (g << 8) | b
}

function perturbPreset(json, name, variant) {
  const rnd = variantRng(name, variant)
  const span = (c) => 1 + (rnd() * 2 - 1) * c
  const o = json
  o.seed = (Math.imul(o.seed | 0, 31) + Math.floor(rnd() * 1e6) + variant) | 0
  for (const l of [1, 2, 3]) {
    if (o.branch.angle[l] != null) o.branch.angle[l] *= span(0.22)
    if (o.branch.length[l] != null) o.branch.length[l] *= span(0.2)
  }
  for (const l of [0, 1, 2]) if (o.branch.children[l] != null) o.branch.children[l] = Math.max(1, Math.round(o.branch.children[l] * span(0.25)))
  for (const l of [0, 1, 2, 3]) if (o.branch.gnarliness[l] != null) o.branch.gnarliness[l] *= span(0.5)
  o.branch.length[0] *= span(0.15)
  o.branch.force.strength *= span(0.5)
  o.leaves.size *= span(0.2)
  o.leaves.angle *= span(0.3)
  o.leaves.count = Math.max(1, Math.round(o.leaves.count * span(0.2)))
  o.leaves.tint = biasHexTint(o.leaves.tint, VARIANT_LEAF_TINT_BIAS[variant % VARIANT_LEAF_TINT_BIAS.length])
  return o
}

const _speciesTemplates = new Map()

function buildSpecies(name, Tree, variant = 0, TreePreset = null) {
  const key = name + '#' + variant
  _spanLabel = key
  _currentSpecies = key
  let t = _speciesTemplates.get(key)
  if (!t) {
    const _g = _now()
    t = generateSpecies(name, Tree, variant, TreePreset)
    _span('generate-species', _g)
    _speciesTemplates.set(key, t)
  }
  const _c = _now()
  const out = { branchGeo: t.branchGeo.clone(), leafGeo: t.leafGeo.clone(), branchMat: t.branchMat.clone(), leafMat: t.leafMat.clone(), tree: t.tree, dims: { ...t.dims } }
  _span('clone-species', _c)
  return out
}

function generateSpecies(name, Tree, variant, TreePreset) {
  const _t0 = _now()
  const tree = new Tree()
  const presetName = PRESET[name] || name
  const _t1 = _now()
  if (variant > 0 && TreePreset && TreePreset[presetName]) tree.loadFromJson(perturbPreset(structuredClone(TreePreset[presetName]), name, variant))
  else tree.loadPreset(presetName)
  const _t2 = _now()
  const branchGeo = tree.branchesMesh.geometry
  const leafGeo = tree.leavesMesh.geometry
  const branchMat = tree.branchesMesh.material
  const leafMat = tree.leavesMesh.material
  branchMat.shadowSide = THREE.FrontSide
  leafMat.alphaTest = Math.max(leafMat.alphaTest || 0, 0.5)
  leafMat.transparent = false
  leafMat.side = THREE.DoubleSide
  branchMat.polygonOffset = true
  branchMat.polygonOffsetFactor = TERRAIN_ZFIGHT_POLYGON_OFFSET_FACTOR
  branchMat.polygonOffsetUnits = TERRAIN_ZFIGHT_POLYGON_OFFSET_UNITS
  leafMat.polygonOffset = true
  leafMat.polygonOffsetFactor = TERRAIN_ZFIGHT_POLYGON_OFFSET_FACTOR
  leafMat.polygonOffsetUnits = TERRAIN_ZFIGHT_POLYGON_OFFSET_UNITS
  branchGeo.computeBoundingBox(); leafGeo.computeBoundingBox()
  const minY = Math.min(branchGeo.boundingBox.min.y, leafGeo.boundingBox.min.y)
  const maxY = Math.max(branchGeo.boundingBox.max.y, leafGeo.boundingBox.max.y)
  const nativeH = maxY - minY
  const target = TARGET_H[name] || 9
  const heightScale = (Number.isFinite(nativeH) && nativeH > 1e-3) ? target / nativeH : 1
  for (const g of [branchGeo, leafGeo]) {
    g.boundingBox = null
    g.boundingSphere = null
    g.scale(heightScale, heightScale, heightScale)
    g.translate(0, -minY * heightScale, 0)
    g.computeBoundingBox(); g.computeBoundingSphere()
  }
  const bb = branchGeo.boundingBox, lb = leafGeo.boundingBox
  const width = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, lb.max.x - lb.min.x, lb.max.z - lb.min.z) || target * 0.7
  const dims = { width, height: target }
  _span('tree-new', _t0, _t1)
  _span('tree-preset', _t1, _t2)
  _span('geo-scale', _t2)
  return { branchGeo, leafGeo, branchMat, leafMat, tree, dims }
}

// A species' LOD chain is a pure function of (name, variant, branch cap, leaf cap): the same input
// bytes produce the same geometry every time. A landscape change rebuilds every species, and the
// rebuild used to pay the whole meshopt simplification again for identical input, which is the
// main-thread block a landscape change is felt as. The finished chain is kept here, next to the
// template cache it already shares a key shape with, so a rebuild clones it and the work stops
// existing instead of being retimed. Materials are never cached: they are cloned per consumer
// because a consumer mutates its own (wind, tint, texture budget).
const _speciesLodCache = new Map()
const LOD_CHAIN_KEYS = ['branchGeo0', 'leafGeo0', 'b1', 'b2', 'l1', 'l2', 'b2shadow']
function _cloneLodChain(e) {
  const out = { treeBox: e.treeBox.clone(), treeSph: e.treeSph.clone() }
  for (const k of LOD_CHAIN_KEYS) out[k] = e[k].clone()
  return out
}
async function _buildLodChain(sp, branchCap, leafCap) {
  const branchGeo0 = await capGeo(sp.branchGeo, branchCap)
  const leafGeo0 = await capGeo(sp.leafGeo, leafCap)
  branchGeo0.computeBoundingBox(); leafGeo0.computeBoundingBox()
  const treeBox = branchGeo0.boundingBox.clone().union(leafGeo0.boundingBox)
  const treeSph = treeBox.getBoundingSphere(new THREE.Sphere())
  branchGeo0.boundingBox = treeBox.clone(); leafGeo0.boundingBox = treeBox.clone()
  branchGeo0.boundingSphere = treeSph.clone(); leafGeo0.boundingSphere = treeSph.clone()
  const b1 = await simplifyGeo(branchGeo0, 0.28, false), b2 = await simplifyGeo(branchGeo0, 0.07, true)
  const l1 = await simplifyGeo(leafGeo0, 0.30, false), l2 = await simplifyGeo(leafGeo0, 0.09, true)
  const b2shadow = await simplifyGeo(branchGeo0, 0.07, true)
  for (const g of [b1, b2, l1, l2, b2shadow]) { g.boundingBox = treeBox.clone(); g.boundingSphere = treeSph.clone() }
  return { branchGeo0, leafGeo0, b1, b2, l1, l2, b2shadow, treeBox, treeSph }
}

async function speciesLodChain(name, variant = 0, Tree = null, TreePreset = null, branchCap = 6000, leafCap = 1400) {
  const sp = buildSpecies(name, Tree, variant, TreePreset)
  const key = name + '#' + variant + '#' + branchCap + '#' + leafCap
  const hit = _speciesLodCache.get(key)
  if (!hit) {
    const built = await _buildLodChain(sp, branchCap, leafCap)
    _speciesLodCache.set(key, built)
    return { ..._cloneLodChain(built), branchMat: sp.branchMat, leafMat: sp.leafMat, tree: sp.tree, dims: sp.dims }
  }
  const _c = _now()
  const out = { ..._cloneLodChain(hit), branchMat: sp.branchMat, leafMat: sp.leafMat, tree: sp.tree, dims: sp.dims }
  _span('clone-lod-chain', _c)
  return out
}

function makeEmptyGeo() {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3))
  g.setIndex([0, 1, 2])
  return g
}

export {
  loadEzTree, makeWindUniforms, applyWind, awaitMatTextures, capGeo, simplifyGeo,
  buildSpecies, speciesLodChain, makeEmptyGeo, PRESET, TARGET_H
}
