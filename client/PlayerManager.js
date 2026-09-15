import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { createPlayerAnimator, createGLBAnimator } from './PlayerAnimator.js'
import { createFacialPlayer, ARKIT_NAMES } from './facial-animation.js'

const MAX_VRM_CONCURRENT = 6
const _lookTargetVec = new THREE.Vector3()
const AVATAR_CULL_RADIUS_MARGIN = 1.5

function playerFeetOffset(worldConfig) {
  const pc = worldConfig.player || {}
  return (pc.capsuleRadius ?? 0.4) + (pc.capsuleHalfHeight ?? 0.9)
}

const _avatarBox = new THREE.Box3(), _avatarTmpBox = new THREE.Box3(), _avatarCenter = new THREE.Vector3(), _avatarScale = new THREE.Vector3(), _avatarInv = new THREE.Matrix4()
function _applyAvatarCullBounds(root) {
  if (!root) return
  root.updateWorldMatrix(true, true)
  _avatarBox.makeEmpty()
  const meshes = []
  root.traverse(c => {
    if (!c.isMesh || !c.geometry) return
    const g = c.geometry
    if (!g.boundingBox) g.computeBoundingBox()
    if (!g.boundingBox || g.boundingBox.isEmpty()) return
    _avatarTmpBox.copy(g.boundingBox).applyMatrix4(c.matrixWorld)
    _avatarBox.union(_avatarTmpBox)
    meshes.push(c)
  })
  if (_avatarBox.isEmpty() || meshes.length === 0) return
  _avatarBox.getCenter(_avatarCenter)
  const worldRadius = _avatarBox.min.distanceTo(_avatarBox.max) * 0.5 * AVATAR_CULL_RADIUS_MARGIN
  for (const c of meshes) {
    _avatarInv.copy(c.matrixWorld).invert()
    _avatarScale.setFromMatrixScale(c.matrixWorld)
    const s = Math.max(Math.abs(_avatarScale.x), Math.abs(_avatarScale.y), Math.abs(_avatarScale.z), 1e-6)
    const sphere = c.boundingSphere && c.boundingSphere.isSphere ? c.boundingSphere : new THREE.Sphere()
    sphere.center.copy(_avatarCenter).applyMatrix4(_avatarInv)
    sphere.radius = worldRadius / s
    c.boundingSphere = sphere
    c.frustumCulled = true
  }
}

export function createPlayerManager(scene, gltfLoader, cam, ktx2Loader, sceneGraph, modelPool = null, playerVrmUrl = null) {
  function setPlayerVrmUrl(url) { playerVrmUrl = url }
  const _vrmLoader = new GLTFLoader()
  _vrmLoader.register(parser => new VRMLoaderPlugin(parser))
  if (ktx2Loader) _vrmLoader.setKTX2Loader(ktx2Loader)
  const playerMeshes = new Map()
  const playerAnimators = new Map()
  const playerVrms = new Map()
  const playerStates = new Map()
  const playerExpressions = new Map()
  const _afanPlayers = new Map()
  let _onAvatarReady = null
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

  function initVRMFeatures(id, vrm, vrmVersion) {
    const f = { vrm, vrmVersion: vrmVersion || '1', expressions: null, lookAt: null, springBone: null, blinkTimer: 0, nextBlink: Math.random() * 2 + 2 }
    if (vrm.expressionManager) { f.expressions = vrm.expressionManager; f.expressions.setValue('blink', 0) }
    if (vrm.lookAt) { f.lookAt = vrm.lookAt; f.lookAt.smoothFactor = 0.1 }
    if (vrm.springBoneManager) f.springBone = vrm.springBoneManager
    playerExpressions.set(id, f)
  }

  function _attachVrmFeatures(id, vrm, animAssets, worldConfig, playerId, vrmVersion, skipScenePrep) {
    const pc = worldConfig.player || {}
    const modelScale = pc.modelScale || 1.323
    const feetOffsetRatio = pc.feetOffset || 0.212
    if (!skipScenePrep) {
      VRMUtils.removeUnnecessaryVertices(vrm.scene)
      VRMUtils.combineSkeletons(vrm.scene)
    }
    vrm.scene.rotation.y = Math.PI
    vrm.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false } })
    vrm.scene.scale.multiplyScalar(modelScale)
    vrm.scene.position.y = -feetOffsetRatio * modelScale
    _applyAvatarCullBounds(vrm.scene)
    playerVrms.set(id, vrm); initVRMFeatures(id, vrm, vrmVersion)
    if (animAssets) playerAnimators.set(id, createPlayerAnimator(vrm, animAssets, vrmVersion, worldConfig.animation || {}))
    if (id === playerId && vrm.humanoid) {
      const head = vrm.humanoid.getRawBoneNode('head')
      if (head) { cam.setCameraBone(head); cam.setHeadBone(head) }
      if (cam.getMode() === 'fps' && head) head.scale.set(0, 0, 0)
    }
  }

  let _lastVrmCtx = null
  async function createPlayerVRM(id, vrmBuffer, animAssets, worldConfig, playerId) {
    _lastVrmCtx = { animAssets, worldConfig, playerId }
    const feetOffset = playerFeetOffset(worldConfig)
    const group = new THREE.Group(); group.userData.vrmPending = true; group.userData.isDynamicShadowCaster = true; if (sceneGraph) sceneGraph.addNode(id, group, { isPlayer: true, feetOffset }); else scene.add(group); playerMeshes.set(id, group)
    if (!vrmBuffer) return group
    if (modelPool && playerVrmUrl && typeof modelPool.spawnVRM === 'function') {
      const vrmVersion = detectVrmVersion(vrmBuffer)
      modelPool.spawnVRM(id, playerVrmUrl, {}, (root, entity) => {
        if (!playerMeshes.has(id)) return
        const vrm = entity?.vrm
        if (!vrm) { console.warn('[vrm] pool entity has no vrm for', id); return }
        if (sceneGraph) { sceneGraph.removeNode(id); sceneGraph.addNode(id, root, { isPlayer: true, feetOffset }) }
        else { scene.remove(group) }
        root.userData.isDynamicShadowCaster = true
        playerMeshes.set(id, root)
        _attachVrmFeatures(id, vrm, animAssets, worldConfig, playerId, vrmVersion, true)
        if (_onAvatarReady) _onAvatarReady(root)
      })
      return group
    }
    await acquireVrmSlot()
    if (!playerMeshes.has(id)) { releaseVrmSlot(); return group }
    try {
      const gltf = await _vrmLoader.parseAsync(vrmBuffer.buffer.slice(vrmBuffer.byteOffset, vrmBuffer.byteOffset + vrmBuffer.byteLength), '')
      const vrm = gltf.userData.vrm
      const pc = worldConfig.player || {}
      const modelScale = pc.modelScale || 1.323
      const feetOffsetRatio = pc.feetOffset || 0.212
      if (vrm) {
        VRMUtils.removeUnnecessaryVertices(vrm.scene)
        VRMUtils.combineSkeletons(vrm.scene)
        const vrmVersion = detectVrmVersion(vrmBuffer)
        vrm.scene.rotation.y = Math.PI
        vrm.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false } })
        vrm.scene.scale.multiplyScalar(modelScale)
        vrm.scene.position.y = -feetOffsetRatio * modelScale
        _applyAvatarCullBounds(vrm.scene)
        group.add(vrm.scene)
        if (_onAvatarReady) _onAvatarReady(vrm.scene)
        playerVrms.set(id, vrm); initVRMFeatures(id, vrm, vrmVersion)
        if (animAssets) playerAnimators.set(id, createPlayerAnimator(vrm, animAssets, vrmVersion, worldConfig.animation || {}))
        if (id === playerId && vrm.humanoid) {
          const head = vrm.humanoid.getRawBoneNode('head')
          if (head) { cam.setCameraBone(head); cam.setHeadBone(head) }
          if (cam.getMode() === 'fps' && head) head.scale.set(0, 0, 0)
        }
      } else {
        const gs = gltf.scene; gs.rotation.y = Math.PI
        gs.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false } })
        gs.scale.multiplyScalar(modelScale); gs.position.y = -feetOffsetRatio * modelScale
        _applyAvatarCullBounds(gs)
        group.add(gs)
        if (_onAvatarReady) _onAvatarReady(gs)
        if (animAssets) playerAnimators.set(id, createGLBAnimator(gs, gltf.animations || [], animAssets, worldConfig.animation || {}))
      }
    } catch (e) { console.error('[vrm]', id, e.message) } finally { releaseVrmSlot() }
    return group
  }

  function updateVRMFeatures(id, dt, targetPosition, isRemote) {
    const f = playerExpressions.get(id); if (!f) return
    if (f.lookAt && targetPosition) { _lookTargetVec.set(targetPosition.x, targetPosition.y + 1.6, targetPosition.z); f.lookAt.lookAt(_lookTargetVec) }
    if (f.expressions && !isRemote) {
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

  function setPlayerAppearance(id, { tint, nameTag } = {}) {
    const mesh = playerMeshes.get(id); if (!mesh) return
    if (tint !== undefined) {
      mesh.traverse(c => {
        if (!c.isMesh || !c.material) return
        const mats = Array.isArray(c.material) ? c.material : [c.material]
        for (const m of mats) {
          if (tint === null) { if (m.userData._baseColor && m.color) m.color.setHex(m.userData._baseColor); }
          else if (m.color) { if (m.userData._baseColor === undefined) m.userData._baseColor = m.color.getHex(); m.color.setHex(tint) }
        }
      })
    }
    if (nameTag !== undefined) _setPlayerNameplate(id, mesh, nameTag)
  }
  function _setPlayerNameplate(id, mesh, text) {
    let sprite = mesh.userData._nameplate
    if (!text) { if (sprite) { mesh.remove(sprite); sprite.material?.map?.dispose?.(); sprite.material?.dispose?.(); mesh.userData._nameplate = null } return }
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64
    const ctx2d = canvas.getContext('2d'); ctx2d.font = 'bold 32px sans-serif'; ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle'
    ctx2d.fillStyle = 'rgba(0,0,0,0.5)'; ctx2d.fillRect(0, 0, 256, 64); ctx2d.fillStyle = '#fff'; ctx2d.fillText(String(text).slice(0, 16), 128, 32)
    const tex = new THREE.CanvasTexture(canvas)
    if (sprite) { sprite.material.map?.dispose?.(); sprite.material.map = tex; sprite.material.needsUpdate = true }
    else { sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })); sprite.scale.set(1.2, 0.3, 1); sprite.position.set(0, 2.1, 0); sprite.renderOrder = 999; mesh.add(sprite); mesh.userData._nameplate = sprite }
  }

  async function setPlayerModel(id, url) {
    if (typeof url !== 'string' || !url) return false
    if (!playerStates.has(id) && !playerMeshes.has(id)) return false
    const ctx = _lastVrmCtx || {}
    const mesh = playerMeshes.get(id)
    if (mesh) {
      if (modelPool && typeof modelPool.has === 'function' && modelPool.has(id)) { try { modelPool.remove(id) } catch (_) {} }
      else { if (sceneGraph) sceneGraph.removeNode(id); else scene.remove(mesh); mesh.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) { const ms = Array.isArray(c.material) ? c.material : [c.material]; for (const m of ms) m.dispose() } }) }
    }
    playerAnimators.get(id)?.dispose?.(); playerAnimators.delete(id)
    const oldVrm = playerVrms.get(id); if (oldVrm) VRMUtils.deepDispose(oldVrm.scene)
    playerVrms.delete(id); playerExpressions.delete(id); _afanPlayers.delete(id); playerMeshes.delete(id)
    let buffer
    try {
      const resp = await fetch(url); if (!resp.ok) { console.warn('[vrm] setPlayerModel fetch failed', id, url, resp.status); return false }
      buffer = new Uint8Array(await resp.arrayBuffer())
    } catch (e) { console.warn('[vrm] setPlayerModel fetch error', id, e.message); return false }
    const savedUrl = playerVrmUrl; playerVrmUrl = null
    try { await createPlayerVRM(id, buffer, ctx.animAssets, ctx.worldConfig, ctx.playerId) }
    finally { playerVrmUrl = savedUrl }
    return true
  }

  function removePlayerMesh(id) {
    const mesh = playerMeshes.get(id); if (!mesh) return
    if (modelPool && typeof modelPool.has === 'function' && modelPool.has(id)) {
      try { modelPool.remove(id) } catch (_) {}
      playerAnimators.get(id)?.dispose?.(); playerAnimators.delete(id)
      playerVrms.delete(id); playerMeshes.delete(id); playerStates.delete(id)
      if (sceneGraph) sceneGraph.removeNode(id); playerExpressions.delete(id); _afanPlayers.delete(id)
      return
    }
    scene.remove(mesh)
    const animator = playerAnimators.get(id); if (animator) animator.dispose()
    playerAnimators.delete(id)
    const vrm = playerVrms.get(id); if (vrm) VRMUtils.deepDispose(vrm.scene)
    playerVrms.delete(id)
    mesh.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose() })
    playerMeshes.delete(id); playerStates.delete(id); if (sceneGraph) sceneGraph.removeNode(id); playerExpressions.delete(id); _afanPlayers.delete(id)
  }

  function applyAfanFrame(playerId, data) {
    const vrm = playerVrms?.get(playerId); if (!vrm?.expressionManager) return
    const arr = data instanceof Uint8Array ? data : new Uint8Array(data)
    const bs = {}
    for (let i = 0; i < ARKIT_NAMES.length && i < arr.length; i++) bs[ARKIT_NAMES[i]] = arr[i] / 255
    let player = _afanPlayers.get(playerId)
    if (!player || player.vrm !== vrm) { player = createFacialPlayer(vrm); _afanPlayers.set(playerId, player) }
    player.applyFrame(bs)
  }

  return {
    playerMeshes, playerAnimators, playerVrms, playerStates, playerExpressions,
    createPlayerVRM, removePlayerMesh, updateVRMFeatures, setVRMExpression, setPlayerAppearance, setPlayerModel, applyAfanFrame,
    detectVrmVersion, setPlayerVrmUrl, set onAvatarReady(fn) { _onAvatarReady = fn }
  }
}
