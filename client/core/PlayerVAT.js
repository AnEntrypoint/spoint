import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { bakeVAT, bakeVATMultiClip } from './PlayerVATBake.js'

export { bakeVAT, bakeVATMultiClip }

export function createVATMaterial(vatData, opts = {}) {
  const moveVatData = opts.moveVatData || null
  const mat = new THREE.MeshLambertMaterial({ color: opts.color ?? 0xd8b48c })
  const hasNormalVAT = !!(vatData.normalTexture || (moveVatData && moveVatData.normalTexture))
  mat._vatHasNormal = hasNormalVAT
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

export function createVATCrowdRenderer(scene, baseGeometry, vatData, opts = {}) {
  const capacity = opts.capacity || 64
  const isMultiClip = !!(vatData && vatData.idle && vatData.move && vatData.idle !== vatData.move)
  const idleData = isMultiClip ? vatData.idle : vatData
  const moveData = isMultiClip ? vatData.move : null
  const geo = baseGeometry.clone()
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

  const _bySlot = new Map()

  function ensureCapacity(n) {
    if (n <= im.capacity) return
    im.resizeBuffers(Math.max(n, im.capacity * 2))
  }

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

  const blendLowSpeed = opts.blendLowSpeed ?? 0.3
  const blendHighSpeed = opts.blendHighSpeed ?? (opts.nominalSpeed || 4.0) * 0.5
  const blendRate = opts.blendRate ?? 3.5

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
      slot.idlePhase = (slot.idlePhase + dt / idleData.duration) % 1
      try { im.setUniformAt(id, 'vatIdlePhase', slot.idlePhase) } catch (_) {}
      const nominal = opts.nominalSpeed || 4.0
      const moveRate = Math.min(1.5, s / nominal)
      slot.phase = (slot.phase + moveRate * dt / moveData.duration) % 1
    } else {
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

export function installPlayerVATDebug(renderer) {
  if (typeof window === 'undefined') return
  window.__playerVAT = {
    stats() { return renderer ? { count: renderer.count(), capacity: renderer.mesh.capacity } : null },
    slots() { return renderer ? renderer.debugSlots() : [] },
    hasNormalVAT() { return renderer ? !!renderer.mesh.material._vatHasNormal : null }
  }
}
