// Baked vertex-animation-texture (VAT) GPU-skinned crowd renderer (animation-gpu-skinned-crowd-vat).
//
// WHY THIS EXISTS: PlayerLOD.js's REDUCED tier (see that file's header comment, "INTEGRATION POINT")
// keeps rendering a full per-Object3D VRM SkinnedMesh + AnimationMixer for every player in the 120m
// mid-distance ring -- real CPU skinning cost paid per player, per frame, for a silhouette that reads
// as a flat dot's worth of on-screen detail anyway at that range. This module is the real GPU-skinned
// middle tier PlayerLOD.js's doc comment calls out as the natural next step: bake ONE locomotion clip's
// per-vertex WORLD-SPACE POSITION DELTA (post-skin minus bind-pose, one row of texels per animation
// frame) into a float DataTexture, then sample that texture in a vertex shader by (vertex index, clip
// phase) to displace a shared base geometry per GPU-instance -- zero CPU AnimationMixer.update() cost,
// zero per-instance bone-matrix work, one shared InstancedMesh2 draw call for the whole REDUCED ring.
//
// SCOPE OF THIS FIRST SLICE (medium/bounded row -- see .gm/prd.yml): a real, working, live-verified bake
// + GPU crowd-render pipeline for ONE representative locomotion clip (loop-driven walk/run cycle) baked
// once per unique base mesh (keyed by geometry+skeleton identity, so all players sharing the default
// avatar share one bake). This intentionally does NOT (yet) cover: per-species/per-outfit VAT variants
// beyond the shared default mesh, or folding into the vegetation octahedral-impostor atlas mechanism
// byte-for-byte (VegImpostorTier.js's atlas is texel-tile based for STATIC billboards; VAT needs a
// genuinely different sampling scheme -- per-vertex-index rows, not a per-species tile -- since the
// payload is a moving mesh, not a flat sprite). What IS shared with the impostor precedent: the exact
// same InstancedMesh2 + initUniformsPerInstance/setUniformAt per-instance data idiom (see
// VegImpostorTier.js), so both far-tier systems are wired through one consistent mechanism rather than
// two incompatible ones, satisfying the row's "coordinate with impostor-unification, do not build a
// second incompatible mechanism" requirement at the data-flow level.
//
// MULTI-CLIP BLEND (animation-vat-multiclip-blend, follow-on to the first slice above): bakeVATMultiClip
// bakes 2 clips (idle + a move loop) sharing ONE vertex-index layout, and createVATMaterial/
// createVATCrowdRenderer sample+mix BOTH clips' delta textures in-shader by a per-instance vatBlend
// uniform (0 = idle pose held stationary, 1 = full move-loop phase-advance), driven every tick from the
// same real per-player speed value the phase-rate scaling already consumed -- so a REDUCED-tier crowd
// instance now visibly HOLDS a real idle pose when stationary (previously: same move-loop played at a
// near-zero rate floor, never a true idle) and crossfades smoothly as speed crosses the walk/run
// threshold, instead of jump-cutting. Two independent clip textures (not one shared stacked-row texture)
// -- simpler addressing, and each clip's own frameCount/duration stay independent (idle and a run loop
// are not the same length), at the cost of one extra texture bind per crowd draw call (still ONE shared
// draw call for the whole tier, so this is a fixed per-frame cost, not a per-instance one). Per-outfit
// bake variants and true impostor-atlas texel-tile fold-in remain filed as sibling PRD rows.
//
// FOLLOW-ON (animation-vat-normal-delta-lighting, landed on top of the multi-clip slice above): bakeVAT
// now ALSO bakes a per-vertex per-frame NORMAL delta (post-skin minus bind-pose, un-normalized, mirroring
// THREE's own GPU skinnormal_vertex chunk bit-for-bit -- see boneTransformNormalInto) into a second
// RGBA32F DataTexture (vatData.normalTexture), sampled in createVATMaterial's onBeforeCompile right after
// <beginnormal_vertex> and added into objectNormal BEFORE <defaultnormal_vertex> applies normalMatrix/
// instancing -- so REDUCED-tier crowd lighting now shades against the animated pose's normal, not a
// static bind-pose normal, at every point in the clip cycle (both the idle and move clips, in multi-clip
// mode -- each clip's own normalTexture is sampled/mixed the same way its position-delta texture is).
// Falls back cleanly (normalTexture stays null, lighting stays bind-pose-normal-lit exactly as before
// this follow-on) whenever the source mesh has no `normal` attribute.

import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { bakeVAT, bakeVATMultiClip } from './PlayerVATBake.js'

// Bake pipeline (bakeVAT/bakeVATMultiClip) lives in PlayerVATBake.js -- re-exported here for backward
// compatibility with app.js's existing single-file import.
export { bakeVAT, bakeVATMultiClip }

// --- GPU crowd material -------------------------------------------------------------------------------
// Builds a MeshLambertMaterial patched (onBeforeCompile) to displace `position` by a VAT-sampled delta
// BEFORE normal THREE lighting/shadow code runs, driven by per-instance uniforms (via InstancedMesh2
// initUniformsPerInstance, same idiom as VegImpostorTier.js's atlasTile): vatPhase (0..1 loop position,
// advanced on the CPU per-instance once per tick -- a single float write, not a skin), and, when a second
// `moveVatData` is supplied, vatBlend (0..1 crossfade weight between the idle clip held at `vatData` and
// the move clip at `moveVatData`, also a single per-instance float write). Single-clip callers (moveVatData
// omitted) get byte-identical behavior/shader cost to the pre-multiclip version -- this is additive, not a
// breaking change to the existing single-clip call sites.
// animation-vat-normal-delta-lighting follow-on: when a clip's own vatData.normalTexture exists, the SAME
// frame/f0/f1/falpha/uv computation (shared verbatim between position and normal sampling via
// `vatFrameUV()`, injected once into <common> so both call sites reuse identical GLSL, not two subtly
// divergent copies) additionally samples that clip's normal-delta texture and overwrites `objectNormal`
// right after <beginnormal_vertex> -- BEFORE <defaultnormal_vertex> applies normalMatrix/instancing, so
// the corrected pose-relative normal flows through THREE's normal, existing instancing-aware transform
// chain exactly like a bind-pose normal would have. In multi-clip mode the idle and move normal deltas
// are sampled/mixed by the same vatBlend weight as their position deltas. When there's no normal texture
// (source mesh had no `normal` attribute, or an older bake without one), this whole block is skipped and
// lighting falls back to the unmodified bind-pose normal -- the same behavior as before this follow-on,
// not a regression.
export function createVATMaterial(vatData, opts = {}) {
  const moveVatData = opts.moveVatData || null
  // No `skinning` constructor option here deliberately -- this material is never a THREE.SkinnedMesh
  // consumer (displacement is done manually in onBeforeCompile below via the VAT texture, not THREE's
  // built-in USE_SKINNING vertex chunk), and MeshLambertMaterial has no such constructor property in this
  // THREE version (passing it produced a harmless but noisy "not a property of..." console warning).
  const mat = new THREE.MeshLambertMaterial({ color: opts.color ?? 0xd8b48c })
  // hasNormalVAT: normal-delta sampling is compiled in whenever EITHER clip's own bake has a
  // normalTexture (idle-only, move-only, and both-have-it are all real reachable combinations since
  // bakeVAT's hasNormals check is per-clip/per-source-mesh) -- the shader branches per-clip via each
  // clip's own vatNormalTexture uniform below, not a single blanket toggle.
  const hasNormalVAT = !!(vatData.normalTexture || (moveVatData && moveVatData.normalTexture))
  mat._vatHasNormal = hasNormalVAT // live-verification flag, read by installPlayerVATDebug's hasNormalVAT()
  mat.customProgramCacheKey = () => `${moveVatData ? 'playerVAT-blend' : 'playerVAT'}${hasNormalVAT ? '_n' : ''}`
  mat.onBeforeCompile = shader => {
    shader.uniforms.vatTexture = { value: vatData.texture }
    shader.uniforms.vatWidth = { value: vatData.width }
    shader.uniforms.vatRowsPerFrame = { value: vatData.rowsPerFrame }
    shader.uniforms.vatFrameCount = { value: vatData.frameCount }
    shader.uniforms.vatHeight = { value: vatData.rowsPerFrame * vatData.frameCount }
    if (vatData.normalTexture) shader.uniforms.vatNormalTexture = { value: vatData.normalTexture }
    shader.vertexShader = 'attribute float vatVertexIndex;\n' + shader.vertexShader
    let uniformDecls = `#include <common>
      uniform highp sampler2D vatTexture;
      uniform float vatWidth;
      uniform float vatRowsPerFrame;
      uniform float vatFrameCount;
      uniform float vatHeight;
      ${vatData.normalTexture ? 'uniform highp sampler2D vatNormalTexture;' : ''}`
    if (moveVatData) {
      shader.uniforms.vatTexture2 = { value: moveVatData.texture }
      shader.uniforms.vatWidth2 = { value: moveVatData.width }
      shader.uniforms.vatRowsPerFrame2 = { value: moveVatData.rowsPerFrame }
      shader.uniforms.vatFrameCount2 = { value: moveVatData.frameCount }
      shader.uniforms.vatHeight2 = { value: moveVatData.rowsPerFrame * moveVatData.frameCount }
      if (moveVatData.normalTexture) shader.uniforms.vatNormalTexture2 = { value: moveVatData.normalTexture }
      uniformDecls += `
      uniform highp sampler2D vatTexture2;
      uniform float vatWidth2;
      uniform float vatRowsPerFrame2;
      uniform float vatFrameCount2;
      uniform float vatHeight2;
      ${moveVatData.normalTexture ? 'uniform highp sampler2D vatNormalTexture2;' : ''}`
    }
    // vatPhase/vatBlend arrive as plain in-scope floats: InstancedMesh2.initUniformsPerInstance below
    // declares them and splices its own texel-fetch prologue ahead of every onBeforeCompile patch (see
    // VegImpostorTier.js's identical atlasTile precedent + Uniforms.js's getUniformsVertexGLSL, which
    // replaces `void main() {` with a prologue that assigns these names before any patched body runs).
    // vatFrameUV computes the shared frame/f0/f1/falpha/uv math ONCE per (width,rowsPerFrame,frameCount,
    // height,phase) tuple -- reused by both the position sample (vatSampleClip) and the normal sample
    // below so the two texture reads for a given clip never drift out of sync on which frame they read.
    const sampleClipFn = `
      void vatFrameUV(float width, float rowsPerFrame, float frameCount, float height, float phase, out vec2 uv0, out vec2 uv1, out float falpha) {
        float frame = mod(phase, 1.0) * (frameCount - 1.0);
        float f0 = floor(frame);
        float f1 = min(f0 + 1.0, frameCount - 1.0);
        falpha = frame - f0;
        float col = mod(vatVertexIndex, width);
        float rowInFrame = floor(vatVertexIndex / width);
        float row0 = f0 * rowsPerFrame + rowInFrame;
        float row1 = f1 * rowsPerFrame + rowInFrame;
        uv0 = vec2((col + 0.5) / width, (row0 + 0.5) / height);
        uv1 = vec2((col + 0.5) / width, (row1 + 0.5) / height);
      }
      vec3 vatSampleClip(sampler2D tex, float width, float rowsPerFrame, float frameCount, float height, float phase) {
        vec2 uv0, uv1; float falpha;
        vatFrameUV(width, rowsPerFrame, frameCount, height, phase, uv0, uv1, falpha);
        vec3 d0 = texture2D(tex, uv0).xyz;
        vec3 d1 = texture2D(tex, uv1).xyz;
        return mix(d0, d1, falpha);
      }`
    shader.vertexShader = shader.vertexShader.replace('#include <common>', uniformDecls + '\n' + sampleClipFn)
    // Idle and move clips each get their OWN phase (vatPhase drives the move/run loop, vatIdlePhase
    // drives the idle loop independently) -- both are real loop-driven clips with their own authored
    // duration (an idle clip breathes/sways, it is not a literal single frozen pose), so blend=0 still
    // shows a live idle ANIMATION, just crossfaded out of the move clip entirely rather than a static hold.
    const beginVertexBody = moveVatData
      ? `#include <begin_vertex>
      {
        vec3 deltaIdle = vatSampleClip(vatTexture, vatWidth, vatRowsPerFrame, vatFrameCount, vatHeight, vatIdlePhase);
        vec3 deltaMove = vatSampleClip(vatTexture2, vatWidth2, vatRowsPerFrame2, vatFrameCount2, vatHeight2, vatPhase);
        vec3 delta = mix(deltaIdle, deltaMove, clamp(vatBlend, 0.0, 1.0));
        transformed += delta;
      }`
      : `#include <begin_vertex>
      {
        vec3 delta = vatSampleClip(vatTexture, vatWidth, vatRowsPerFrame, vatFrameCount, vatHeight, vatPhase);
        transformed += delta;
      }`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', beginVertexBody)
    // Injected right after <beginnormal_vertex> (which sets objectNormal = vec3(normal)) and BEFORE
    // <defaultnormal_vertex> (which applies normalMatrix + USE_INSTANCING correction to objectNormal) --
    // overwriting objectNormal here means the animated-pose-relative normal rides the exact same
    // downstream normalMatrix/instancing/FLIP_SIDED transform a bind-pose normal would have. Left
    // UN-NORMALIZED here on purpose, same as THREE's own USE_SKINNING skinnormal_vertex chunk (which
    // also never normalizes objectNormal after its skin-matrix transform) -- normal_fragment_begin's
    // normalize(vNormal) is still the ONLY normalize call in the whole chain either way. In blend mode,
    // each clip's normal delta is sampled only if THAT clip's own normalTexture exists (bakeVAT's
    // hasNormals check is per-source-mesh, so idle/move can independently have or lack one) and the two
    // deltas are mixed by the same vatBlend weight as the position deltas; a clip missing its normal
    // texture contributes a zero delta for its side of the mix rather than skipping the whole feature.
    if (hasNormalVAT) {
      const normalBody = moveVatData
        ? `#include <beginnormal_vertex>
        {
          vec3 nDeltaIdle = ${vatData.normalTexture ? 'vatSampleClip(vatNormalTexture, vatWidth, vatRowsPerFrame, vatFrameCount, vatHeight, vatIdlePhase)' : 'vec3(0.0)'};
          vec3 nDeltaMove = ${moveVatData.normalTexture ? 'vatSampleClip(vatNormalTexture2, vatWidth2, vatRowsPerFrame2, vatFrameCount2, vatHeight2, vatPhase)' : 'vec3(0.0)'};
          objectNormal += mix(nDeltaIdle, nDeltaMove, clamp(vatBlend, 0.0, 1.0));
        }`
        : `#include <beginnormal_vertex>
        {
          vec3 nDelta = vatSampleClip(vatNormalTexture, vatWidth, vatRowsPerFrame, vatFrameCount, vatHeight, vatPhase);
          objectNormal += nDelta;
        }`
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', normalBody)
    }
  }
  return mat
}

// --- Crowd renderer ------------------------------------------------------------------------------------
// One shared InstancedMesh2 of the baked geometry + VAT material. Each instance carries its own
// vatPhase (advanced per-tick by the caller from that player's real movement speed, so faster-moving
// remote players visibly step faster without a second bake -- vatSpeed scales the phase advance) via
// InstancedMesh2's per-instance uniform texture, the exact same mechanism VegImpostorTier.js uses for
// atlasTile, so this tier and the vegetation far-tier share one consistent per-instance-data plumbing
// pattern end to end (row's "coordinate with impostor-unification" requirement).
//
// MULTI-CLIP: when `vatData` is `{idle, move}` (the shape bakeVATMultiClip returns) instead of a single
// baked result, a SECOND per-instance uniform vatBlend (0..1) is added alongside vatPhase and the
// material samples+crossfades both clips (see createVATMaterial's moveVatData path above). A plain
// single vatData object (the pre-multiclip shape) still works unchanged -- this branch is additive.
export function createVATCrowdRenderer(scene, baseGeometry, vatData, opts = {}) {
  const capacity = opts.capacity || 64
  const isMultiClip = !!(vatData && vatData.idle && vatData.move && vatData.idle !== vatData.move)
  const idleData = isMultiClip ? vatData.idle : vatData
  const moveData = isMultiClip ? vatData.move : null
  const geo = baseGeometry.clone()
  // vatVertexIndex: one scalar per source vertex, static per-vertex geometry attribute (NOT per-instance
  // -- every instance samples the SAME shared VAT texture rows, only vatPhase/vatBlend differ per instance).
  const vCount = geo.attributes.position.count
  const idxArr = new Float32Array(vCount)
  for (let i = 0; i < vCount; i++) idxArr[i] = i
  geo.setAttribute('vatVertexIndex', new THREE.BufferAttribute(idxArr, 1))
  geo.computeBoundingSphere()
  if (geo.boundingSphere) geo.boundingSphere.radius = Math.max(geo.boundingSphere.radius, 1.2)

  const mat = createVATMaterial(idleData, { ...opts, moveVatData: moveData })
  const im = new InstancedMesh2(geo, mat, { capacity, renderer: opts.renderer })
  const uniformSpec = { vatPhase: 'float' }
  if (moveData) { uniformSpec.vatBlend = 'float'; uniformSpec.vatIdlePhase = 'float' }
  im.initUniformsPerInstance({ vertex: uniformSpec })
  im.perObjectFrustumCulled = true
  im.frustumCulled = false
  im.castShadow = opts.castShadow !== false
  im.receiveShadow = false
  scene.add(im)

  const _bySlot = new Map() // playerId -> { id (instance id), phase, blend }

  function ensureCapacity(n) {
    if (n <= im.capacity) return
    im.resizeBuffers(Math.max(n, im.capacity * 2))
  }

  /** Adds (or reuses) a crowd slot for `playerId`, returns its instance id. */
  function acquire(playerId) {
    let slot = _bySlot.get(playerId)
    if (slot) return slot.id
    ensureCapacity(_bySlot.size + 1)
    let id = -1
    im.addInstances(1, (e) => { id = e.id })
    slot = { id, phase: 0, idlePhase: 0, blend: 0 }
    _bySlot.set(playerId, slot)
    try { im.setUniformAt(id, 'vatPhase', 0) } catch (_) {}
    if (moveData) {
      try { im.setUniformAt(id, 'vatBlend', 0) } catch (_) {}
      try { im.setUniformAt(id, 'vatIdlePhase', 0) } catch (_) {}
    }
    return id
  }

  function release(playerId) {
    const slot = _bySlot.get(playerId)
    if (!slot) return
    try { im.removeInstances(slot.id) } catch (_) {}
    _bySlot.delete(playerId)
  }

  // Crossfade tuning: below blendLowSpeed the instance target-blends fully toward the idle clip (0);
  // above blendHighSpeed it target-blends fully toward the move clip (1); linear ramp between. blendRate
  // is how fast the ACTUAL per-instance vatBlend chases that target per second (a real crossfade over
  // ~0.3s, not an instant jump-cut, so a player accelerating through the threshold reads as a smooth
  // walk-to-run transition rather than a pose pop).
  const blendLowSpeed = opts.blendLowSpeed ?? 0.3
  const blendHighSpeed = opts.blendHighSpeed ?? (opts.nominalSpeed || 4.0) * 0.5
  const blendRate = opts.blendRate ?? 3.5

  /** position: {x,y,z}. rotY: yaw radians. speed: current horizontal speed (m/s). dt: frame delta seconds.
   * Single-clip mode (no moveData): identical behavior to the pre-multiclip version -- loop phase always
   * advances (with a small floor so a stationary crowd never looks frozen), scaled by speed.
   * Multi-clip mode (idle+move baked): vatBlend target-tracks speed (idle at low speed, move at high
   * speed, linear ramp between, smoothed by blendRate) and phase only advances while blend > 0 -- a
   * genuinely stationary instance HOLDS a real idle pose (phase frozen at 0) instead of a move-loop
   * played at a near-zero rate, and the move clip's own phase rate scales with speed same as before. */
  function update(playerId, position, rotY, speed, dt) {
    const id = acquire(playerId)
    const slot = _bySlot.get(playerId)
    const s = speed || 0
    if (moveData) {
      const target = blendHighSpeed > blendLowSpeed
        ? Math.max(0, Math.min(1, (s - blendLowSpeed) / (blendHighSpeed - blendLowSpeed)))
        : (s > blendLowSpeed ? 1 : 0)
      const chase = Math.min(1, blendRate * dt)
      slot.blend += (target - slot.blend) * chase
      if (Math.abs(slot.blend - target) < 0.001) slot.blend = target
      try { im.setUniformAt(id, 'vatBlend', slot.blend) } catch (_) {}
      // Idle phase advances at the idle clip's OWN natural authored rate (a real breathing/swaying idle
      // loop, always live regardless of blend weight -- both textures are sampled every frame, the shader
      // mixes them) while move phase advances at the move clip's own nominal-speed-scaled rate.
      slot.idlePhase = (slot.idlePhase + dt / idleData.duration) % 1
      try { im.setUniformAt(id, 'vatIdlePhase', slot.idlePhase) } catch (_) {}
      const nominal = opts.nominalSpeed || 4.0
      const moveRate = Math.min(1.5, s / nominal)
      slot.phase = (slot.phase + moveRate * dt / moveData.duration) % 1
    } else {
      // Loop-cycle rate: at speed=0 the loop still idles forward slowly (a fully frozen crowd silhouette
      // reads as broken/dead, not idle) via a small floor; scales up toward 1 full loop per `duration`
      // worth of clip-authored distance as speed approaches a nominal running pace.
      const nominal = opts.nominalSpeed || 4.0
      const rate = 0.15 + Math.min(1.5, s / nominal)
      slot.phase = (slot.phase + rate * dt / idleData.duration) % 1
    }
    try { im.setUniformAt(id, 'vatPhase', slot.phase) } catch (_) {}
    im.setMatrixAt(id, _composeMatrix(position, rotY))
  }

  function has(playerId) { return _bySlot.has(playerId) }
  function count() { return _bySlot.size }
  function debugSlots() { return Array.from(_bySlot.entries()).map(([id, s]) => ({ playerId: id, instanceId: s.id, phase: s.phase, idlePhase: s.idlePhase, blend: s.blend })) }

  function dispose() {
    scene.remove(im)
    geo.dispose()
    mat.dispose()
    idleData.texture.dispose()
    if (idleData.normalTexture) idleData.normalTexture.dispose()
    if (moveData) {
      moveData.texture.dispose()
      if (moveData.normalTexture) moveData.normalTexture.dispose()
    }
    _bySlot.clear()
  }

  return { mesh: im, acquire, release, update, has, count, debugSlots, dispose }
}

const _mtx = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _pos = new THREE.Vector3()
const _scale1 = new THREE.Vector3(1, 1, 1)
function _composeMatrix(position, rotY) {
  _euler.set(0, rotY || 0, 0)
  _q.setFromEuler(_euler)
  _pos.set(position.x, position.y, position.z)
  _mtx.compose(_pos, _q, _scale1)
  return _mtx
}

// Live discovery surface (mirrors RenderControls.js / PlayerLOD.js's window.__* debug convention).
export function installPlayerVATDebug(renderer) {
  if (typeof window === 'undefined') return
  window.__playerVAT = {
    stats() { return renderer ? { count: renderer.count(), capacity: renderer.mesh.capacity } : null },
    slots() { return renderer ? renderer.debugSlots() : [] },
    // animation-vat-normal-delta-lighting: confirms the normal-delta texture actually made it into the
    // live material (not silently unset because the source mesh lacked a `normal` attribute, or a stale
    // bake predating this follow-on) -- a real live-verification surface, not a guess.
    hasNormalVAT() { return renderer ? !!renderer.mesh.material._vatHasNormal : null }
  }
}
