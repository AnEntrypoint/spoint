import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { createPlayerAnimator, createGLBAnimator } from './PlayerAnimator.js'
import { createFacialPlayer, ARKIT_NAMES } from './facial-animation.js'

const MAX_VRM_CONCURRENT = 6
const _lookTargetVec = new THREE.Vector3()

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
  // Set by app.js gateCompile: hides a just-attached avatar until shader link finishes, avoiding a first-draw stall.
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
    // vrmVersion ('0'|'1', PlayerManager.detectVrmVersion -- detected from the SOURCE FILE bytes) is
    // stashed here for any future consumer that needs it. NOT needed by the compact expression wire
    // code (client/core/ExpressionCodes.js, animation-vrm-spring-bone-lod-expression-wire): a loaded
    // vrm.expressionManager always exposes V1-canonical preset names (happy/sad/relaxed/...) regardless
    // of source file version -- three-vrm's own loader plugin remaps V0 names (joy/fun/sorrow) to their
    // V1 equivalents at load time (see ExpressionCodes.js's module comment for the live-verified proof).
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
    // skipScenePrep: the ModelPool path already ran removeUnnecessaryVertices/combineSkeletons on the shared root.
    if (!skipScenePrep) {
      VRMUtils.removeUnnecessaryVertices(vrm.scene)
      VRMUtils.combineSkeletons(vrm.scene)
    }
    vrm.scene.rotation.y = Math.PI
    // frustumCulled=false: a SkinnedMesh's bounding sphere is from the bind pose and doesn't track the live animated pose, so it can false-cull.
    vrm.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; c.frustumCulled = false } })
    vrm.scene.scale.multiplyScalar(modelScale)
    vrm.scene.position.y = -feetOffsetRatio * modelScale
    playerVrms.set(id, vrm); initVRMFeatures(id, vrm, vrmVersion)
    if (animAssets) playerAnimators.set(id, createPlayerAnimator(vrm, animAssets, vrmVersion, worldConfig.animation || {}))
    if (id === playerId && vrm.humanoid) {
      const head = vrm.humanoid.getRawBoneNode('head')
      if (head) { cam.setCameraBone(head); cam.setHeadBone(head) }
      if (cam.getMode() === 'fps' && head) head.scale.set(0, 0, 0)
    }
  }

  // Captured on every createPlayerVRM call so a later per-player model SWAP (setPlayerModel) can re-run the
  // exact same attach path (animation retarget, scale, head-bone camera bind) with a new buffer -- these three
  // are supplied by the caller (app.js), not stored elsewhere on the manager.
  let _lastVrmCtx = null
  async function createPlayerVRM(id, vrmBuffer, animAssets, worldConfig, playerId) {
    _lastVrmCtx = { animAssets, worldConfig, playerId }
    // isDynamicShadowCaster: ShadowCostProbe.js classification tag (measurement-only; see that
    // file's header) -- every player avatar is always a moving shadow caster.
    const group = new THREE.Group(); group.userData.vrmPending = true; group.userData.isDynamicShadowCaster = true; if (sceneGraph) sceneGraph.addNode(id, group, { isPlayer: true }); else scene.add(group); playerMeshes.set(id, group)
    if (!vrmBuffer) return group
    if (modelPool && playerVrmUrl && typeof modelPool.spawnVRM === 'function') {
      const vrmVersion = detectVrmVersion(vrmBuffer)
      modelPool.spawnVRM(id, playerVrmUrl, {}, (root, entity) => {
        if (!playerMeshes.has(id)) return
        const vrm = entity?.vrm
        if (!vrm) { console.warn('[vrm] pool entity has no vrm for', id); return }
        // Swap the placeholder group for the pool root once it's live.
        if (sceneGraph) { sceneGraph.removeNode(id); sceneGraph.addNode(id, root, { isPlayer: true }) }
        else { scene.remove(group) }
        root.userData.feetOffset = 0.91
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
        vrm.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; c.frustumCulled = false } })
        vrm.scene.scale.multiplyScalar(modelScale)
        vrm.scene.position.y = -feetOffsetRatio * modelScale
        group.userData.feetOffset = 0.91; group.add(vrm.scene)
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
        gs.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; c.frustumCulled = false } })
        gs.scale.multiplyScalar(modelScale); gs.position.y = -feetOffsetRatio * modelScale
        group.userData.feetOffset = 0.91; group.add(gs)
        if (_onAvatarReady) _onAvatarReady(gs)
        if (animAssets) playerAnimators.set(id, createGLBAnimator(gs, gltf.animations || [], animAssets, worldConfig.animation || {}))
      }
    } catch (e) { console.error('[vrm]', id, e.message) } finally { releaseVrmSlot() }
    return group
  }

  function updateVRMFeatures(id, dt, targetPosition, isRemote) {
    const f = playerExpressions.get(id); if (!f) return
    // springBone is NOT updated here: app.js's vrm.update(dt) already drives it; a second call would double-integrate.
    if (f.lookAt && targetPosition) { _lookTargetVec.set(targetPosition.x, targetPosition.y + 1.6, targetPosition.z); f.lookAt.lookAt(_lookTargetVec) }
    // Local automatic idle-blink timer drives the SAME 'blink' expressionManager slot the compact wire
    // code (animation-vrm-spring-bone-lod-expression-wire, EXPR_BLINK) now drives for a REMOTE player --
    // skip this local timer for remote players so the two don't fight over one shared value; a remote
    // player's blink is now driven by the wire code (the DRIVING client's own real blink state), which
    // is strictly more correct than a locally-faked random-interval blink for someone else's avatar.
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

  // Per-player appearance: tint every material on a player mesh (team/class colours) and/or set an
  // overhead nameplate. tint is a hex number (0xff4444) or null to clear; nameTag is a short string.
  // The client applies this from a broadcast appearance event so red-vs-blue / class colours are visible.
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

  // Per-player MODEL swap: replace one player's whole avatar with a different VRM/GLB fetched at runtime from
  // `url` (skins, unlockable characters, team models, a boss transforming). Disposes the current avatar and
  // rebuilds via the SAME createPlayerVRM attach path, so animation retarget / scale / head-bone camera bind all
  // just work. The player's transform state is preserved (only the mesh is torn down), so the player never blinks
  // out. Routed through the direct-load path (fetch -> parse) rather than the shared ModelPool so a per-player url
  // doesn't collide with the pool's single-url assumption. Returns a promise resolving when the new avatar attaches.
  async function setPlayerModel(id, url) {
    if (typeof url !== 'string' || !url) return false
    if (!playerStates.has(id) && !playerMeshes.has(id)) return false
    const ctx = _lastVrmCtx || {}
    // Tear down the current avatar (mesh + vrm + animator + expressions), but KEEP playerStates so the player
    // stays alive and keeps moving; createPlayerVRM re-adds a fresh mesh under the same id.
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
    // Force the direct-load path for the swap (not the pool) by parsing this specific buffer.
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
