import * as THREE from 'three'
import { VRMUtils } from '@pixiv/three-vrm'
import { createPlayerAnimator, createGLBAnimator } from './PlayerAnimator.js'
import { createFacialPlayer } from './facial-animation.js'

const MAX_VRM_CONCURRENT = 6
const _ARKIT_NAMES = ['browInnerUp','browDownLeft','browDownRight','browOuterUpLeft','browOuterUpRight','eyeLookUpLeft','eyeLookUpRight','eyeLookDownLeft','eyeLookDownRight','eyeLookInLeft','eyeLookInRight','eyeLookOutLeft','eyeLookOutRight','eyeBlinkLeft','eyeBlinkRight','eyeSquintLeft','eyeSquintRight','eyeWideLeft','eyeWideRight','cheekPuff','cheekSquintLeft','cheekSquintRight','noseSneerLeft','noseSneerRight','jawOpen','jawForward','jawLeft','jawRight','mouthFunnel','mouthPucker','mouthLeft','mouthRight','mouthRollUpper','mouthRollLower','mouthShrugUpper','mouthShrugLower','mouthOpen','mouthClose','mouthSmileLeft','mouthSmileRight','mouthFrownLeft','mouthFrownRight','mouthDimpleLeft','mouthDimpleRight','mouthUpperUpLeft','mouthUpperUpRight','mouthLowerDownLeft','mouthLowerDownRight','mouthPressLeft','mouthPressRight','mouthStretchLeft','mouthStretchRight']
const _lookTargetVec = new THREE.Vector3()

export function createPlayerManager(scene, gltfLoader, cam) {
  const playerMeshes = new Map()
  const playerAnimators = new Map()
  const playerVrms = new Map()
  const playerStates = new Map()
  const playerExpressions = new Map()
  const playerTargets = new Map()
  const _afanPlayers = new Map()
  let _vrmActive = 0
  const _vrmQueue = []

  function _vrmSlot() {
    if (_vrmActive >= MAX_VRM_CONCURRENT || _vrmQueue.length === 0) return
    _vrmActive++; _vrmQueue.shift()()
  }
  function acquireVrmSlot() { return new Promise(r => { _vrmQueue.push(r); _vrmSlot() }) }
  function releaseVrmSlot() { _vrmActive--; _vrmSlot() }

  function detectVrmVersion(buffer) {
    try {
      const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer
      const dv = new DataView(ab); const jl = dv.getUint32(12, true)
      const j = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, jl)))
      if (j.extensions?.VRM) return '0'
    } catch (e) { }
    return '1'
  }

  function getGLBExts(buf) {
    try { const av = buf instanceof ArrayBuffer ? buf : buf.buffer; const dv = new DataView(av); const jl = dv.getUint32(12, true); const j = JSON.parse(new TextDecoder().decode(new Uint8Array(av, 20, jl))); return j.extensions || {} } catch { return {} }
  }

  function initVRMFeatures(id, vrm) {
    const f = { vrm, expressions: null, lookAt: null, springBone: null, blinkTimer: 0, nextBlink: Math.random() * 2 + 2 }
    if (vrm.expressionManager) { f.expressions = vrm.expressionManager; f.expressions.setValue('blink', 0) }
    if (vrm.lookAt) { f.lookAt = vrm.lookAt; f.lookAt.smoothFactor = 0.1 }
    if (vrm.springBoneManager) f.springBone = vrm.springBoneManager
    playerExpressions.set(id, f)
  }

  async function createPlayerVRM(id, vrmBuffer, animAssets, worldConfig, playerId) {
    const group = new THREE.Group(); scene.add(group); playerMeshes.set(id, group)
    if (!vrmBuffer) return group
    await acquireVrmSlot()
    if (!playerMeshes.has(id)) { releaseVrmSlot(); return group }
    try {
      const gltf = await gltfLoader.parseAsync(vrmBuffer.buffer.slice(0), '')
      const vrm = gltf.userData.vrm
      const pc = worldConfig.player || {}
      const modelScale = pc.modelScale || 1.323
      const feetOffsetRatio = pc.feetOffset || 0.212
      if (vrm) {
        VRMUtils.removeUnnecessaryVertices(vrm.scene)
        VRMUtils.combineSkeletons(vrm.scene)
        const vrmVersion = detectVrmVersion(vrmBuffer)
        vrm.scene.rotation.y = Math.PI
        vrm.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
        vrm.scene.scale.multiplyScalar(modelScale)
        vrm.scene.position.y = -feetOffsetRatio * modelScale
        group.userData.feetOffset = 0.91; group.add(vrm.scene)
        playerVrms.set(id, vrm); initVRMFeatures(id, vrm)
        if (animAssets) playerAnimators.set(id, createPlayerAnimator(vrm, animAssets, vrmVersion, worldConfig.animation || {}))
        if (id === playerId && vrm.humanoid) {
          const head = vrm.humanoid.getRawBoneNode('head')
          if (head) { cam.setCameraBone(head); cam.setHeadBone(head) }
          if (cam.getMode() === 'fps' && head) head.scale.set(0, 0, 0)
        }
      } else {
        const gs = gltf.scene; gs.rotation.y = Math.PI
        gs.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
        gs.scale.multiplyScalar(modelScale); gs.position.y = -feetOffsetRatio * modelScale
        group.userData.feetOffset = 0.91; group.add(gs)
        if (animAssets) playerAnimators.set(id, createGLBAnimator(gs, gltf.animations || [], animAssets, worldConfig.animation || {}))
      }
    } catch (e) { console.error('[vrm]', id, e.message) } finally { releaseVrmSlot() }
    return group
  }

  function updateVRMFeatures(id, dt, targetPosition) {
    const f = playerExpressions.get(id); if (!f) return
    if (f.springBone) f.springBone.update(dt)
    if (f.lookAt && targetPosition) { _lookTargetVec.set(targetPosition.x, targetPosition.y + 1.6, targetPosition.z); f.lookAt.lookAt(_lookTargetVec) }
    if (f.expressions) {
      f.blinkTimer += dt
      if (f.blinkTimer >= f.nextBlink) {
        f.expressions.setValue('blink', 1)
        if (f.blinkTimer >= f.nextBlink + 0.15) { f.expressions.setValue('blink', 0); f.blinkTimer = 0; f.nextBlink = Math.random() * 3 + 2 }
      }
    }
  }

  function setVRMExpression(id, expressionName, value) {
    const f = playerExpressions.get(id); if (f?.expressions) f.expressions.setValue(expressionName, value)
  }

  function removePlayerMesh(id) {
    const mesh = playerMeshes.get(id); if (!mesh) return
    scene.remove(mesh)
    const animator = playerAnimators.get(id); if (animator) animator.dispose()
    playerAnimators.delete(id)
    const vrm = playerVrms.get(id); if (vrm) VRMUtils.deepDispose(vrm.scene)
    playerVrms.delete(id)
    mesh.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose() })
    playerMeshes.delete(id); playerTargets.delete(id); playerStates.delete(id); playerExpressions.delete(id); _afanPlayers.delete(id)
  }

  function applyAfanFrame(playerId, data) {
    const vrm = playerVrms?.get(playerId); if (!vrm?.expressionManager) return
    const arr = data instanceof Uint8Array ? data : new Uint8Array(data)
    const bs = {}
    for (let i = 0; i < _ARKIT_NAMES.length && i < arr.length; i++) bs[_ARKIT_NAMES[i]] = arr[i] / 255
    let player = _afanPlayers.get(playerId)
    if (!player || player.vrm !== vrm) { player = createFacialPlayer(vrm); _afanPlayers.set(playerId, player) }
    player.applyFrame(bs)
  }

  return {
    playerMeshes, playerAnimators, playerVrms, playerStates, playerExpressions, playerTargets,
    createPlayerVRM, removePlayerMesh, updateVRMFeatures, setVRMExpression, applyAfanFrame,
    detectVrmVersion, getGLBExts
  }
}
