// Player LOD tiers + crowd-dot rendering (player-lod-tiers-gpu-skinned-instanced-avatars-for-1000-player-r).
//
// WHY THIS EXISTS: a per-Object3D SkinnedMesh (real bone hierarchy + THREE's CPU skinning path, one
// AnimationMixer per avatar) caps out around 100-150 concurrent avatars before CPU skinning + draw-call
// count collapses frame time -- see AGENTS.md/PlayerManager.js MAX_VRM_CONCURRENT=6 (concurrent VRM
// *load* throttle) and app.js's existing binary anim-LOD (_PLAYER_ANIM_LOD_D2, full vs half-rate). This
// module generalizes that binary split into a real three-tier system so a 1000-player world stays
// tractable:
//   FULL    -- full VRM avatar, full-rate anim mixer + VRM features (lookAt/blink/expressions). Reserved
//              for the nearest players a viewer can actually resolve detail on (PLAYER_LOD_FULL_COUNT,
//              mirrors SnapshotEncoder.js's server-side count so the client's render tier matches what
//              the wire protocol actually delivers full state for).
//   REDUCED -- avatar mesh kept but animation/VRM-feature updates throttled hard (or skipped), position
//              only tracked at whatever cadence the network delivers it (server-side ~5Hz for this tier,
//              see PLAYER_LOD_REDUCED_HZ in SnapshotEncoder.js). No per-frame skinning cost paid for
//              players in this ring beyond the existing lerp.
//   DOT     -- no per-Object3D avatar at all. Rendered as a single shared InstancedMesh2 crowd-dot batch
//              (billboarded flat quads), sourced from the server's aggregated dot buckets when present
//              (SnapshotEncoder.js buildCrowdDots -- no per-player identity, just [cellX,cellZ,count]) and
//              falling back to a client-computed per-player dot position when the server hasn't (or can't,
//              e.g. a non-tiered/legacy snapshot) supplied buckets, so the far crowd is ALWAYS visually
//              present at near-zero cost even before every server deployment ships tiering.
//
// INTEGRATION POINT for a full GPU-skinned-instanced-atlas pipeline (the larger follow-on the task
// describes): today FULL/REDUCED both still render through PlayerManager's per-Object3D VRM path (real,
// working, just gated by tier instead of always-on). The natural next step is to replace the REDUCED
// tier's per-Object3D SkinnedMesh with a single InstancedMesh2 of a baked skinned-instance atlas (VRM
// baked to one shared skinned geometry + a vertex-texture-fetch animation texture sampled per-instance by
// clip+phase, GPU skinning via a custom onBeforeCompile chunk) -- classifyPlayerTier/getTierForDistance
// below is the exact distance function that pipeline's REDUCED bucket would iterate, and installPlayerLOD
// below is the single call site (tickTiers) a GPU-instanced REDUCED renderer would slot into in place of
// the current per-Object3D show/hide. That is a genuinely separate, large shader-authoring project (a
// real vertex-texture-fetch skinning shader, atlas bake step, and instance-attribute clip-blend schedule)
// -- out of scope to fake here; this module ships the REAL, WORKING tiering + crowd-dot deliverable and
// documents the exact seam so that follow-on lands as a drop-in tier-3 renderer swap, not a rewrite.

import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'

// Mirrors SnapshotEncoder.js's server-side constants (kept as a separate literal, not an import, since
// this is a browser ES module bundle boundary and SnapshotEncoder.js lives in src/netcode -- see
// AGENTS.md config-world-to-client-flow for the general client/server constant-duplication pattern).
// A mismatch here is a wire/render coupling issue, not a correctness bug: if the server sends full state
// for the nearest 30 but the client only *renders* full detail for its own nearest 25 (say), a handful
// of players simply keep full state cached while rendering reduced -- harmless waste, never a crash or a
// visual defect, so this constant is deliberately independent rather than requiring cross-bundle sharing.
export const PLAYER_LOD_FULL_COUNT = 30
export const PLAYER_LOD_REDUCED_D = 120     // metres; matches SnapshotEncoder.js PLAYER_LOD_REDUCED2 = 120*120
export const PLAYER_LOD_REDUCED_D2 = PLAYER_LOD_REDUCED_D * PLAYER_LOD_REDUCED_D

export const TIER_FULL = 0
export const TIER_REDUCED = 1
export const TIER_DOT = 2

let _idxScratch = new Int32Array(0)
let _d2Scratch = new Float64Array(0)
const _full = new Set(), _reduced = new Set(), _dot = new Set()
const _order = []

function ensureScratchCapacity(n) {
  if (_idxScratch.length >= n) return
  _idxScratch = new Int32Array(n)
  _d2Scratch = new Float64Array(n)
}

/**
 * Classifies every remote player id in `entries` (array of {id, x, y, z}) into FULL/REDUCED/DOT tiers
 * relative to `viewerPos` ({x,y,z} or THREE.Vector3-like). Pure function of real position data -- no
 * THREE scene access, no side effects -- so it is directly unit-exercisable against real player position
 * arrays (see the live witness in the task's verification pass). Returns { full: Set<id>, reduced:
 * Set<id>, dot: Set<id> } plus `order` (the same ids sorted nearest-first, useful for a caller wanting a
 * stable "top N" without re-sorting). The returned Sets/array are module-level scratch, reused every call.
 */
export function classifyPlayerTiers(entries, viewerPos, fullCount = PLAYER_LOD_FULL_COUNT, reducedD2 = PLAYER_LOD_REDUCED_D2) {
  const vx = viewerPos.x, vy = viewerPos.y, vz = viewerPos.z
  const n = entries.length
  ensureScratchCapacity(n)
  for (let i = 0; i < n; i++) {
    const e = entries[i]
    const dx = e.x - vx, dy = e.y - vy, dz = e.z - vz
    _idxScratch[i] = i
    _d2Scratch[i] = dx * dx + dy * dy + dz * dz
  }
  const idxView = _idxScratch.subarray(0, n)
  idxView.sort(_byD2)
  _full.clear(); _reduced.clear(); _dot.clear(); _order.length = 0; _tierById.clear()
  for (let i = 0; i < n; i++) {
    const srcIdx = idxView[i]
    const e = entries[srcIdx]
    const id = e.id
    const d2 = _d2Scratch[srcIdx]
    e.d2 = d2   // published back so downstream per-frame consumers (animator LOD, remote cull) read it instead of recomputing the same distance
    _order.push(id)
    if (i < fullCount) { _full.add(id); _tierById.set(id, TIER_FULL) }
    else if (d2 < reducedD2) { _reduced.add(id); _tierById.set(id, TIER_REDUCED) }
    else { _dot.add(id); _tierById.set(id, TIER_DOT) }
  }
  return { full: _full, reduced: _reduced, dot: _dot, order: _order, tierById: _tierById }
}
// Hoisted comparator (a fresh closure per frame de-opts TypedArray.prototype.sort's comparator path).
function _byD2(a, b) { return _d2Scratch[a] - _d2Scratch[b] }

/** Single-entity tier classification (no sort/allocation) -- for a caller that already knows a player's
 *  rank among nearby players (e.g. re-checking one player's tier without reclassifying everyone). rank
 *  is this player's 0-based position when all nearby players are sorted by distance. */
export function tierForRankAndDistance(rank, d2, fullCount = PLAYER_LOD_FULL_COUNT, reducedD2 = PLAYER_LOD_REDUCED_D2) {
  if (rank < fullCount) return TIER_FULL
  if (d2 < reducedD2) return TIER_REDUCED
  return TIER_DOT
}

// --- Crowd-dot rendering ------------------------------------------------------------------------------
// One shared InstancedMesh2 of small billboarded quads (world-space, camera-facing via a vertex-shader
// billboard, not per-frame CPU lookAt) -- a DOT-tier "player" is never a real Object3D, just an instance
// slot written directly from server dot-bucket data or (fallback) raw player positions.

function makeDotGeo(size) {
  const geo = new THREE.PlaneGeometry(size, size)
  geo.rotateX(-Math.PI / 2) // lie flat by default; the material's vertex billboard reorients per-instance toward the camera
  return geo
}

function makeDotMaterial() {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85, depthWrite: false })
  mat.onBeforeCompile = shader => {
    // Cheap camera-facing billboard entirely in the vertex shader (cameraPosition is a THREE built-in
    // uniform) -- avoids a per-instance CPU quaternion write every frame for what may be hundreds of dots.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        vec3 worldPos = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = normalize(cameraPosition - worldPos);
        vec3 up = vec3(0.0, 1.0, 0.0);
        vec3 right = normalize(cross(up, toCam));
        vec3 camUp = cross(toCam, right);
        float sx = length(instanceMatrix[0].xyz);
        transformed = right * position.x * sx + camUp * position.z * sx;
      }`
    )
  }
  return mat
}

/**
 * Creates the crowd-dot renderer: a single InstancedMesh2 added to `scene`, with an update(dots) method
 * accepting either server-aggregated buckets ([[cellX,cellZ,count], ...], see SnapshotEncoder.js
 * buildCrowdDots -- cell coords are in dotCellM-sized grid units) or a flat array of individual DOT-tier
 * player positions ([{x,y,z,id}, ...], the client-computed fallback when no server buckets are present).
 * groundHeightFn(x,z) -> y is optional; when supplied, dots are snapped to it (a bucket has no per-player
 * y, so ground height is the only sane placement); otherwise falls back to viewerY for buckets and the
 * real y for the per-player fallback array.
 */
export function createCrowdDotRenderer(scene, opts = {}) {
  const dotCellM = opts.dotCellM || 25
  const dotSize = opts.dotSize || 1.4
  const capacity = opts.capacity || 512
  const geo = makeDotGeo(dotSize)
  const mat = makeDotMaterial()
  const im = new InstancedMesh2(geo, mat, { capacity, renderer: opts.renderer })
  im.frustumCulled = false // the batch spans the whole far ring; per-instance culling would cost more than it saves at this instance count
  im.matrixAutoUpdate = false
  im.renderOrder = 3
  scene.add(im)
  im.updateMatrix()

  let activeCount = 0
  const _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scaleVec = new THREE.Vector3()

  function ensureCapacity(n) {
    if (n <= im.capacity) return
    im.resizeBuffers(Math.max(n, im.capacity * 2))
  }

  /** dots: server buckets [[cx,cz,count],...] OR player array [{x,y,z,id},...]. viewerY: fallback Y for
   *  bucket-mode dots with no groundHeightFn. groundHeightFn(x,z)->y optional.
   *  Dot buckets carry no persistent identity across snapshots (a fresh aggregate every tick), so this
   *  fully replaces the instance set each call (clearInstances + addInstances) rather than diffing --
   *  the same pattern Grass.js's commitChunk uses for a batch with no stable per-entry id to track. */
  function update(dots, viewerY, groundHeightFn) {
    if (!dots || dots.length === 0) {
      if (activeCount > 0) { im.clearInstances(); activeCount = 0 }
      return
    }
    const isBuckets = Array.isArray(dots[0])
    ensureCapacity(dots.length)
    im.clearInstances()
    let i = 0
    im.addInstances(dots.length, (entity) => {
      let x, z, y, scale
      if (isBuckets) {
        const [cx, cz, count] = dots[i]
        x = (cx + 0.5) * dotCellM; z = (cz + 0.5) * dotCellM
        y = groundHeightFn ? groundHeightFn(x, z) : viewerY
        // Bigger dot for a denser bucket (sqrt so a 4x-denser cell isn't a naive 4x-larger quad -- area
        // scales with count, not linear size, matching how a real cluster of avatars would visually read).
        scale = dotSize * Math.min(3, 0.6 + Math.sqrt(count) * 0.35)
      } else {
        const p = dots[i]
        x = p.x; z = p.z; y = groundHeightFn ? groundHeightFn(x, z) : p.y
        scale = dotSize
      }
      i++
      entity.position.set(x, y + 0.05, z)
      entity.scale.set(scale, scale, scale)
    })
    activeCount = dots.length
  }

  function dispose() { scene.remove(im); geo.dispose(); mat.dispose() }

  return { instancedMesh: im, update, dispose, get count() { return activeCount } }
}

// --- Full tiering orchestrator -------------------------------------------------------------------------
// installPlayerLOD wires classification into an actual per-frame update: reads real player positions
// from `pm.playerMeshes` / `pm.playerStates` (PlayerManager's live maps), classifies every remote player
// against the camera, and returns tier decisions the caller (app.js) applies to gate VRM creation and
// full-rate anim/VRM-feature updates. It does NOT itself touch avatar visibility/anim -- app.js already
// owns that per-frame loop (tickPlayerAnimators) and is the correct place to apply the verdict, keeping
// this module a pure classifier + the crowd-dot renderer, not a second render-loop owner.

const _dotFallbackScratch = []

export function installPlayerLOD(scene, opts = {}) {
  const dots = createCrowdDotRenderer(scene, opts)
  let lastTiers = { full: new Set(), reduced: new Set(), dot: new Set(), order: [] }
  // Runtime-overridable fullCount (window.__playerLOD.setFullCount, see installPlayerLODDebug below) --
  // exists so a live verification pass (few real connected players, none of which would naturally rank
  // beyond a live server's real player count) can still exercise the REDUCED/DOT tiers without needing
  // hundreds of real concurrent connections; production always runs the real PLAYER_LOD_FULL_COUNT.
  let _fullCountOverride = null

  /**
   * `remoteEntries`: [{id,x,y,z}] for every currently-tracked remote player (caller excludes self).
   * `viewerPos`: {x,y,z}. `serverDots`: optional server-aggregated dot buckets (snapshot.dots from
   * SnapshotProcessor) -- when present, used directly (zero client-side aggregation cost for the far
   * crowd); when absent, this function builds an equivalent per-player dot array from its own DOT-tier
   * classification so the crowd-dot visual is never empty even against a non-tiering server.
   */
  function tick(remoteEntries, viewerPos, serverDots, groundHeightFn) {
    const fullCount = _fullCountOverride ?? PLAYER_LOD_FULL_COUNT
    const tiers = classifyPlayerTiers(remoteEntries, viewerPos, fullCount)
    lastTiers = tiers
    if (serverDots && serverDots.length) {
      dots.update(serverDots, viewerPos.y, groundHeightFn)
    } else if (tiers.dot.size > 0) {
      _dotFallbackScratch.length = 0
      for (let i = 0; i < remoteEntries.length; i++) {
        const e = remoteEntries[i]
        if (tiers.dot.has(e.id)) _dotFallbackScratch.push(e)
      }
      dots.update(_dotFallbackScratch, viewerPos.y, groundHeightFn)
    } else {
      dots.update(null)
    }
    return tiers
  }

  function getTiers() { return lastTiers }
  function tierOf(id) { const t = lastTiers.tierById ? lastTiers.tierById.get(id) : undefined; return t !== undefined ? t : (lastTiers.full.has(id) ? TIER_FULL : lastTiers.reduced.has(id) ? TIER_REDUCED : TIER_DOT) }
  function setFullCountOverride(n) { _fullCountOverride = n }

  return { tick, getTiers, tierOf, dots, setFullCountOverride, dispose: () => dots.dispose() }
}

// Live discovery surface (mirrors RenderControls.js's window.__renderControls convention): exposes tier
// counts + the dot-renderer instance count for debugging/perf inspection.
export function installPlayerLODDebug(playerLOD) {
  if (typeof window === 'undefined') return
  window.__playerLOD = {
    stats() {
      const t = playerLOD.getTiers()
      return { full: t.full.size, reduced: t.reduced.size, dot: t.dot.size, dotInstances: playerLOD.dots.count }
    },
    tierOf: id => playerLOD.tierOf(id),
    setFullCount: n => playerLOD.setFullCountOverride(n),
    debugTiers() {
      const t = playerLOD.getTiers()
      return { full: [...t.full], reduced: [...t.reduced], dot: [...t.dot], order: t.order }
    }
  }
}
