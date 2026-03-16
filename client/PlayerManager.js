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

  function tickPlayers(dt, players, localId, cam, client, lerpFactor) {
    for (const p of players) {
      const mesh = playerMeshes.get(p.id); if (!mesh) continue
      const fo = mesh.userData.feetOffset ?? 0.91
      let tx, ty, tz
      if (p.id === localId) {
        const l = client.getLocalState()
        tx = l?.position?.[0] ?? p.position[0]; ty = (l?.position?.[1] ?? p.position[1]) - fo; tz = l?.position?.[2] ?? p.position[2]
      } else {
        tx = p.position[0]; ty = p.position[1] - fo + (p.velocity?.[1]||0)*dt; tz = p.position[2]
      }
      if (!mesh.userData.initialized) { mesh.position.set(tx, ty, tz); mesh.userData.initialized = true }
      else { mesh.position.set(tx, ty, tz) }
      const pt = playerTargets.get(p.id)
      if (pt) { pt.x = tx; pt.y = ty; pt.z = tz } else playerTargets.set(p.id, { x: tx, y: ty, z: tz })
      playerStates.set(p.id, p)
      const animator = playerAnimators.get(p.id); if (!animator) continue
      animator.update(dt, p.velocity, p.onGround, p.health, p._aiming||false, p.crouch||0)
      const lookYaw = p.id === localId ? cam.yaw : p.lookYaw
      if (lookYaw !== undefined) {
        let diff = lookYaw - mesh.rotation.y
        diff -= Math.PI*2 * Math.round(diff/(Math.PI*2))
        const speed = Math.hypot(p.velocity?.[0]||0, p.velocity?.[2]||0)
        if (speed < 0.5) { mesh.rotation.y += diff * Math.min(1, 40*dt) }
        else {
          mesh.rotation.y += diff * Math.min(1, 5*dt)
          let d2 = lookYaw - mesh.rotation.y; d2 -= Math.PI*2 * Math.round(d2/(Math.PI*2))
          if (Math.abs(d2) > Math.PI*0.65) mesh.rotation.y += d2 > 0 ? d2 - Math.PI*0.65 : d2 + Math.PI*0.65
        }
        mesh.rotation.y -= Math.PI*2 * Math.round(mesh.rotation.y/(Math.PI*2))
        animator.setLookDirection?.(lookYaw - mesh.rotation.y, p.lookPitch||0, mesh.rotation.y+Math.PI, p.velocity)
      }
      if (mesh.visible) {
        animator.applyBoneOverrides?.(dt)
        playerVrms.get(p.id)?.update(dt)
      }
      updateVRMFeatures(p.id, dt, playerTargets.get(p.id))
      if (p.id !== localId && p.lookPitch !== undefined) {
        const f = playerExpressions.get(p.id)
        if (f && !f._headBone) { const vrm = playerVrms.get(p.id); if (vrm?.humanoid) f._headBone = vrm.humanoid.getNormalizedBoneNode('head') }
        if (f?._headBone) f._headBone.rotation.x = -(p.lookPitch||0)*0.6
      }
    }
  }

  return {
    playerMeshes, playerAnimators, playerVrms, playerStates, playerExpressions, playerTargets,
    createPlayerVRM, removePlayerMesh, updateVRMFeatures, setVRMExpression, applyAfanFrame,
    detectVrmVersion, getGLBExts, tickPlayers
  }
}
