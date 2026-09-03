// Species-mesh build helpers for Vegetation.js's createVegetation: ez-tree dynamic loader, wind-sway
// shader injection, texture-decode/geometry-simplify async helpers, and per-species mesh construction
// (buildSpecies normalizes ez-tree's native scale to this project's real-world TARGET_H per species,
// applying the polygonOffset trunk-flicker fix -- see that function's own comment). Split out as
// Vegetation.js's largest stateless block -- each function here only touches its own module-scoped
// constants/caches (_ezTreeModPromise, PRESET, TARGET_H), never createVegetation's own closure state
// (camera/chunk/instance scratch objects stay in Vegetation.js, only used there).

import * as THREE from 'three'
import { MeshoptSimplifier } from 'meshoptimizer'

let _ezTreeModPromise = null
function loadEzTree() {
  if (!_ezTreeModPromise) _ezTreeModPromise = import('@dgreenheck/ez-tree')
  return _ezTreeModPromise
}
// streaming-gltf's octahedral impostor (FULL-sphere octahedron - works from any angle, incl ground
// level; the agargaro vendored lib only implemented HEMI so ground views rendered nothing). Plain
// Single canonical impostor implementation (packages/streaming-gltf/src/octahedral-impostor-ez.js,
// shared with ModelPool's OctahedralImpostorEzTier via the same package import elsewhere -- no more
// client/vendor duplicate, see AGENTS.md draw-call-audit-impostor-system-unification).
import { createOctahedralImpostorMaterial, computeObjectBoundingSphere } from 'streaming-gltf/octahedral-impostor-ez'  // full-sphere octahedron (works at ground level, unlike hemi-only variants)
import { buildSharedImpostorAtlas, createSharedImpostorMesh } from './VegImpostorTier.js'
import { placementsForChunk, VEG, SPECIES } from '/src/terrain/VegPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { dbg } from './debug-log.js'
import { RenderControls } from './RenderControls.js'

const _dbgVeg = dbg('vegetation')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)   // shared, never-rendered proxy geo for occlusion candidates
const _occBoxMat = new THREE.MeshBasicMaterial()

// species (parity wire-id contract) -> ez-tree preset names; 'Bush' has no exact preset (lib ships 'Bush 1/2/3'), mapped explicitly so a missing preset never silently diverges from the collider table
const PRESET = {
  'Oak Large': 'Oak Large', 'Pine Medium': 'Pine Medium', 'Aspen Medium': 'Aspen Medium', 'Ash Medium': 'Ash Medium', 'Bush': 'Bush 1',
  'Ash Small': 'Ash Small', 'Ash Large': 'Ash Large', 'Aspen Small': 'Aspen Small', 'Aspen Large': 'Aspen Large', 'Bush 2': 'Bush 2',
  'Bush 3': 'Bush 3', 'Oak Small': 'Oak Small', 'Oak Medium': 'Oak Medium', 'Pine Small': 'Pine Small', 'Pine Large': 'Pine Large',
}

// target real-world full-tree height (m) per species: ez-tree's native ~100-unit scale mismatches the trunk collider table, LOD cutovers, and impostor size; normalizing makes visual==collider==LOD==impostor size
const TARGET_H = {
  'Oak Large': 9, 'Pine Medium': 12, 'Aspen Medium': 9.5, 'Ash Medium': 10, 'Bush': 2.8,
  'Ash Small': 6.5, 'Ash Large': 13, 'Aspen Small': 6, 'Aspen Large': 13, 'Bush 2': 3.0,
  'Bush 3': 3.2, 'Oak Small': 5.5, 'Oak Medium': 7, 'Pine Small': 8, 'Pine Large': 16,
}

const DROP_MARGIN = 64   // metres past the ring before a chunk is dropped (hysteresis)

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _camPos = new THREE.Vector3()
const _vanMat = new THREE.Matrix4(), _vanProj = new THREE.Matrix4(), _vanFrustum = new THREE.Frustum()   // scratch for window.__vegVanishProbe

// shared wind uniform (one per veg system); advancing one .value per frame sways all LODs of all species with zero per-instance JS
function makeWindUniforms() { return { uVegTime: { value: 0 }, uVegWind: { value: 1 } } }

// REMOVED (tree-fade-nearby-distance-dip, 2026-08-24): the dissolve-discard block this function used
// to inject at every LOD boundary crossing (_vegDistToB = min distance to ANY of D1/D2/D3, _vegFade =
// clamp(_vegDistToB/band, 0, 1), discard when dither>_vegFade) evaluated to 0 -- near-total per-pixel
// discard -- exactly AT each boundary, climbing back to 1 only band(3m) away on either side. That is
// the identical symmetric-V-shape mistake already root-caused and fixed twice in the impostor's own
// dissolve (client/core/VegImpostorTier.js, commits 2d3ea4c579 and 596d77d6e2), but here it additionally
// had no partner layer to cross-fade against: @three.ez's InstancedMesh2 LOD system is a hard geometry
// SWAP (live-confirmed via a real tree's actualBucket scan across the D1/D2 crossings -- exactly one LOD
// level ever holds the instance at a time, never two overlapping), so a discard-based "dissolve" on top
// of a hard swap has nothing underneath it to blend into -- it can only manufacture a fade-to-near-
// invisible-and-back pop at every single tier boundary a camera crosses, which is exactly the "trees
// fade out then fade back in in the nearby distance" symptom (user-reported, close range ~10-30m,
// matching the D1~14m/D2~35m boundaries this function's own lodBoundaries argument encodes). No
// structural fix salvages a discard-based cross-fade here without also duplicating both LOD levels'
// geometry for a real overlapping draw (a materially bigger change than this bug warrants) -- the
// correct, minimal fix is to stop injecting the discard at all; @three.ez's own hysteresis parameter
// (LOD_HYS, already passed to every addLOD call) already prevents the OTHER known pop failure mode
// (rapid back-and-forth re-toggling at a boundary the camera hovers near), and a clean instant geometry
// swap reads far better than a dither-fade dip to near-transparent at every crossing.
function applyWind(material, wind) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uVegTime = wind.uVegTime
    shader.uniforms.uVegWind = wind.uVegWind
    shader.vertexShader = 'uniform float uVegTime;\nuniform float uVegWind;\n' + shader.vertexShader
    // windPhase/tint are per-instance uniforms @three.ez declares; its injection runs after this base
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n' +
      'float _wsway = (position.y) * 0.06;\n' +
      'float _wph = uVegTime * 1.3 + windPhase;\n' +
      'transformed.x += sin(_wph) * _wsway * uVegWind;\n' +
      'transformed.z += cos(_wph * 0.8) * _wsway * 0.6 * uVegWind;')
    // per-instance shade: multiply the lit diffuse by the instance tint (brightness variation).
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\n diffuseColor.rgb *= tint;')
  }
  material.customProgramCacheKey = () => 'vegwind3'
  return material
}

// Must await texture decode before sampling: ez-tree loads bark/leaf maps async, so baking the impostor atlas in the same tick would sample undefined images -> blank atlas.
async function awaitMatTextures(mats) {
  const texes = []
  for (const m of mats) {
    if (!m) continue
    for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'alphaMap', 'bumpMap']) {
      const t = m[k]; if (t && t.isTexture) texes.push(t)
    }
  }
  await Promise.all(texes.map(async (t) => {
    const img = t.image
    try {
      if (img && typeof img.decode === 'function') { await img.decode(); t.needsUpdate = true; return }
    } catch (_) {}
    // fallback: poll until the image has dimensions, ~1s cap
    for (let i = 0; i < 60; i++) {
      if (t.image && (t.image.width > 0 || t.image.videoWidth > 0)) { t.needsUpdate = true; return }
      await new Promise(r => setTimeout(r, 16))
    }
  }))
}

// Caps a geometry to at most maxTris triangles (meshopt); the LOD0 budget bounding the worst near-tree.
async function capGeo(geo, maxTris) {
  try {
    const idx = geo.index ? geo.index.array : null
    if (!idx) return geo.clone()
    const tris = idx.length / 3
    if (tris <= maxTris) return geo.clone()
    return await simplifyGeo(geo, maxTris / tris, false)
  } catch (_) { return geo.clone() }
}

// Strip @three.ez/instanced-mesh's injected 'instanceIndex' claim-marker attribute (set by
// InstancedMesh2's own `set geometry` -> patchGeometry whenever a geometry becomes an
// InstancedMesh2/LOD level's live geometry). BufferGeometry.clone() deep-clones EVERY attribute
// indiscriminately, so a clone taken from an already-InstancedMesh2-bound source geometry (e.g.
// Vegetation.js's branchGeo0, patched by `new InstancedMesh2(branchGeo0, ...)` before any LOD
// derives from it) inherits the stamp -- every later addLOD/addShadowLOD call on that clone then
// sees an "already used" geometry and defensively re-clones + warns
// ("Geometry has been cloned because it was already used"), regardless of how many times the
// caller re-clones in between. Stripping here makes every clone this function returns safe by
// construction for its next InstancedMesh2 consumer, independent of the source's own history.
function _stripInstanceIndexStamp(g) {
  if (g.getAttribute && g.getAttribute('instanceIndex')) g.deleteAttribute('instanceIndex')
  return g
}

// Meshopt-simplifies to `ratio` of triangles. Must ALWAYS return a NEW distinct geometry object (never the source) -- @three.ez's addLevel reuses the LOD object when geometry===existing, so two LOD levels sharing one object alias one instanceIndex array and stomp each other's drawn slots (a tree vanishing in a band at the cutover).
async function simplifyGeo(geo, ratio, sloppy) {
  try {
    await MeshoptSimplifier.ready
    const idx = geo.index ? geo.index.array : null
    const pos = geo.attributes.position.array
    if (!idx || !pos) return _stripInstanceIndexStamp(geo.clone())
    const target = Math.max(12, Math.floor((idx.length / 3) * ratio) * 3)
    const fn = sloppy && MeshoptSimplifier.simplifySloppy ? 'simplifySloppy' : 'simplify'
    const args = sloppy ? [idx, pos, 3, target, 0.05] : [idx, pos, 3, target, 0.02, ['Sparse']]
    const [newIdx] = MeshoptSimplifier[fn](...args)
    const out = geo.clone()
    if (newIdx && newIdx.length >= 3) out.setIndex(new THREE.BufferAttribute(newIdx, 1))
    return _stripInstanceIndexStamp(out)
  } catch (_) { return _stripInstanceIndexStamp(geo.clone()) }
}

function buildSpecies(name, Tree) {
  const tree = new Tree()
  tree.loadPreset(PRESET[name] || name)
  const branchGeo = tree.branchesMesh.geometry
  const leafGeo = tree.leavesMesh.geometry
  const branchMat = tree.branchesMesh.material
  const leafMat = tree.leavesMesh.material
  branchMat.shadowSide = THREE.FrontSide
  leafMat.alphaTest = Math.max(leafMat.alphaTest || 0, 0.5)   // no-MSAA fallback (A2C needs samples)
  leafMat.transparent = false
  leafMat.side = THREE.DoubleSide
  // Apply depth bias to mesh LOD to match impostor bias, preventing flicker at LOD boundary.
  // units -8 -> -32 (2026-07-10, live A/B via GL readPixels flicker-score harness against a real
  // close-range trunk, world ~3-8m from camera): -8 was proven LIVE-INSUFFICIENT -- trunk mesh vs
  // mapspinner's independently-rendered terrain depth z-fight every single frame at that range
  // (strict alternation between trunk color and terrain color on 18-23 of 20-24 sampled frames),
  // even though occlusion/LOD-swap/per-instance-visibility were all confirmed INERT for this exact
  // symptom (occludedKeys.size===0 always, instancesCount constant, getVisibilityAt always true --
  // the flicker is a raw GPU depth-test tie-break flip, not a game-logic visibility toggle). A/B
  // tested -20/-50/-100 all fully eliminated it (0/20 frames changed, vs 18/20 baseline); -32 keeps
  // a safety margin above the smallest working value without over-biasing.
  branchMat.polygonOffset = true
  branchMat.polygonOffsetFactor = -4
  branchMat.polygonOffsetUnits = -32
  leafMat.polygonOffset = true
  leafMat.polygonOffsetFactor = -4
  leafMat.polygonOffsetUnits = -32
  // normalize to a real-world height: scale branch+leaf by the same factor so visual size agrees with the trunk collider + LOD + impostor
  branchGeo.computeBoundingBox(); leafGeo.computeBoundingBox()
  const minY = Math.min(branchGeo.boundingBox.min.y, leafGeo.boundingBox.min.y)
  const maxY = Math.max(branchGeo.boundingBox.max.y, leafGeo.boundingBox.max.y)
  const nativeH = maxY - minY
  const target = TARGET_H[name] || 9
  const s = (Number.isFinite(nativeH) && nativeH > 1e-3) ? target / nativeH : 1
  for (const g of [branchGeo, leafGeo]) {
    g.scale(s, s, s)
    g.translate(0, -minY * s, 0)   // drop base to y=0 so the trunk rests on the ground
    g.computeBoundingBox(); g.computeBoundingSphere()
  }
  const bb = branchGeo.boundingBox, lb = leafGeo.boundingBox
  const width = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, lb.max.x - lb.min.x, lb.max.z - lb.min.z) || target * 0.7
  const dims = { width, height: target }
  return { branchGeo, leafGeo, branchMat, leafMat, tree, dims }
}

// zero-area geo: the far leaf LOD swaps to this so leaf cards vanish where the impostor takes over (no double-draw)
function makeEmptyGeo() {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3))
  g.setIndex([0, 1, 2])
  return g
}

export {
  loadEzTree, makeWindUniforms, applyWind, awaitMatTextures, capGeo, simplifyGeo,
  buildSpecies, makeEmptyGeo, PRESET, TARGET_H
}
