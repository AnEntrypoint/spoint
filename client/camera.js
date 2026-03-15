import * as THREE from 'three'

const camTarget = new THREE.Vector3()
const camRaycaster = new THREE.Raycaster()
const camDir = new THREE.Vector3()
const camDesired = new THREE.Vector3()
const camLookTarget = new THREE.Vector3()
const aimRaycaster = new THREE.Raycaster()
const aimDir = new THREE.Vector3()
const _boneWorldPos = new THREE.Vector3()
const _boneForward = new THREE.Vector3()
const _fpsRayOrigin = new THREE.Vector3()
const _fpsRayDir = new THREE.Vector3()

function isDescendant(obj, ancestor) {
  let cur = obj
  while (cur) { if (cur === ancestor) return true; cur = cur.parent }
  return false
}

export function createCameraController(camera, scene) {
  let yaw = 0, pitch = 0, zoomIndex = 2, camInitialized = false, mode = 'tps'
  let editMode = false, editCamPos = new THREE.Vector3(0, 5, 10), editCamSpeed = 8
  let shoulderOffset = 0.35, headHeight = 0.4, camFollowSpeed = 12, camSnapSpeed = 30
  let zoomStages = [0, 1.5, 3, 5, 8], mouseSensitivity = 0.002
  let pitchMin = -1.4, pitchMax = 1.4
  let fpsRayTimer = 0, tpsRayTimer = 0, cachedClipDist = 10, cachedAimPoint = null
  let fpsPushX = 0, fpsPushY = 0, fpsPushZ = 0
  let cameraBone = null, headBone = null, headBoneHidden = false
  let fpsForwardOffset = 0.7, fpsHeadDownOffset = 0.2
  let punchYawTarget = 0, punchPitchTarget = 0, punchYaw = 0, punchPitch = 0
  const envMeshes = []
  camRaycaster.firstHitOnly = true
  aimRaycaster.firstHitOnly = true

  function updateFPS(localMesh, frameDt, fwdX, fwdY, fwdZ) {
    if (cameraBone && localMesh) {
      cameraBone.getWorldPosition(_boneWorldPos)
      _boneForward.set(fwdX, 0, fwdZ).normalize()
      camera.position.copy(_boneWorldPos).addScaledVector(_boneForward, fpsForwardOffset)
      camera.position.y += 0.35
    } else { camera.position.copy(camTarget) }
    camera.position.x += fpsPushX; camera.position.y += fpsPushY; camera.position.z += fpsPushZ
    if (headBone && !headBoneHidden) { headBone.scale.set(0, 0, 0); headBoneHidden = true }
    fpsRayTimer += frameDt
    if (fpsRayTimer >= 0.05 && envMeshes.length) {
      fpsRayTimer = 0; fpsPushX = 0; fpsPushY = 0; fpsPushZ = 0
      const wallDist = 0.35, fwdWallDist = 0.25
      _fpsRayOrigin.copy(camera.position); _fpsRayDir.set(-fwdX, -fwdY, -fwdZ)
      camRaycaster.set(_fpsRayOrigin, _fpsRayDir); camRaycaster.far = wallDist; camRaycaster.near = 0
      for (const hit of camRaycaster.intersectObjects(envMeshes, true)) {
        if (localMesh && isDescendant(hit.object, localMesh)) continue
        const push = wallDist - hit.distance
        if (push > 0) { fpsPushX += fwdX*push; fpsPushY += fwdY*push; fpsPushZ += fwdZ*push; camera.position.x += fwdX*push; camera.position.y += fwdY*push; camera.position.z += fwdZ*push }
        break
      }
      _fpsRayDir.set(fwdX, fwdY, fwdZ); camRaycaster.set(camera.position, _fpsRayDir); camRaycaster.far = fwdWallDist; camRaycaster.near = 0
      for (const hit of camRaycaster.intersectObjects(envMeshes, true)) {
        if (localMesh && isDescendant(hit.object, localMesh)) continue
        const push = fwdWallDist - hit.distance
        if (push > 0) { fpsPushX -= fwdX*push; fpsPushY -= fwdY*push; fpsPushZ -= fwdZ*push; camera.position.x -= fwdX*push; camera.position.y -= fwdY*push; camera.position.z -= fwdZ*push }
        break
      }
    }
    camera.lookAt(camera.position.x + fwdX, camera.position.y + fwdY, camera.position.z + fwdZ)
  }

  function updateTPS(dist, localMesh, frameDt, fwdX, fwdY, fwdZ, rightX, rightZ) {
    if (headBone && headBoneHidden) { headBone.scale.set(1, 1, 1); headBoneHidden = false }
    camDesired.set(camTarget.x - fwdX*dist + rightX*shoulderOffset, camTarget.y - fwdY*dist + 0.2, camTarget.z - fwdZ*dist + rightZ*shoulderOffset)
    camDir.subVectors(camDesired, camTarget).normalize()
    const fullDist = camTarget.distanceTo(camDesired)
    tpsRayTimer += frameDt
    const doRaycast = tpsRayTimer >= 0.05
    if (doRaycast) {
      tpsRayTimer = 0; camRaycaster.set(camTarget, camDir); camRaycaster.far = fullDist; camRaycaster.near = 0
      cachedClipDist = fullDist
      if (envMeshes.length) {
        for (const hit of camRaycaster.intersectObjects(envMeshes, true)) {
          if (localMesh && isDescendant(hit.object, localMesh)) continue
          if (hit.distance < cachedClipDist) cachedClipDist = hit.distance - 0.2
        }
        if (cachedClipDist < 0.3) cachedClipDist = 0.3
      }
    }
    const clippedDist = Math.min(cachedClipDist, fullDist)
    camDesired.set(camTarget.x + camDir.x*clippedDist, camTarget.y + camDir.y*clippedDist, camTarget.z + camDir.z*clippedDist)
    if (!camInitialized) { camera.position.copy(camDesired); camInitialized = true }
    else { const closer = clippedDist < camera.position.distanceTo(camTarget); camera.position.lerp(camDesired, 1 - Math.exp(-(closer ? camSnapSpeed : camFollowSpeed) * frameDt)) }
    aimDir.set(fwdX, fwdY, fwdZ)
    if (doRaycast && envMeshes.length) {
      aimRaycaster.set(camera.position, aimDir); aimRaycaster.far = 500; aimRaycaster.near = 0.5
      cachedAimPoint = null
      for (const ah of aimRaycaster.intersectObjects(envMeshes, true)) { if (localMesh && isDescendant(ah.object, localMesh)) continue; cachedAimPoint = ah.point; break }
    }
    if (cachedAimPoint) { if (!camLookTarget.lengthSq()) camLookTarget.copy(cachedAimPoint); camLookTarget.lerp(cachedAimPoint, 1 - Math.exp(-camFollowSpeed * frameDt)) }
    else { camLookTarget.set(camera.position.x + fwdX*200, camera.position.y + fwdY*200, camera.position.z + fwdZ*200) }
    camera.lookAt(camLookTarget)
  }

  function update(localPlayer, localMesh, frameDt, inputState) {
    if (mode === 'custom' || mode === 'fixed') return
    if (!localPlayer && !editMode) return
    if (editMode && inputState) {
      const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), s = editCamSpeed * frameDt
      editCamPos.x += ((inputState.forward?1:0)-(inputState.backward?1:0))*sy*s + ((inputState.right?1:0)-(inputState.left?1:0))*(-cy)*s
      editCamPos.y += ((inputState.jump?1:0)-(inputState.crouch?1:0))*s
      editCamPos.z += ((inputState.forward?1:0)-(inputState.backward?1:0))*cy*s + ((inputState.right?1:0)-(inputState.left?1:0))*sy*s
      camera.position.copy(editCamPos); camera.lookAt(editCamPos.x + sy*100, editCamPos.y + sp*100, editCamPos.z + cy*100)
      return
    }
    if (localMesh) camTarget.set(localMesh.position.x, localMesh.position.y + headHeight, localMesh.position.z)
    else camTarget.set(localPlayer.position[0], localPlayer.position[1] + headHeight, localPlayer.position[2])
    const pLerp = 1 - Math.exp(-972 * frameDt)
    punchYaw += (punchYawTarget - punchYaw) * pLerp; punchPitch += (punchPitchTarget - punchPitch) * pLerp
    punchYawTarget *= 1 - Math.min(1, 18*frameDt); punchPitchTarget *= 1 - Math.min(1, 18*frameDt)
    yaw += punchYaw * frameDt; pitch = Math.max(pitchMin, Math.min(pitchMax, pitch + punchPitch * frameDt))
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
    const fwdX = sy*cp, fwdY = sp, fwdZ = cy*cp
    const dist = mode === 'fps' ? 0 : zoomStages[zoomIndex]
    if (dist < 0.01) updateFPS(localMesh, frameDt, fwdX, fwdY, fwdZ)
    else updateTPS(dist, localMesh, frameDt, fwdX, fwdY, fwdZ, -cy, sy)
  }

  function setMode(m) {
    const prev = mode; mode = m
    if (m === 'fps' && headBone) { headBone.scale.set(0,0,0); headBone.position.y -= fpsHeadDownOffset; headBoneHidden = true }
    if (prev === 'fps' && m !== 'fps' && headBone) { headBone.scale.set(1,1,1); headBone.position.y += fpsHeadDownOffset; headBoneHidden = false }
  }

  function applyConfig(cfg) {
    if (cfg.mode != null) mode = cfg.mode
    if (cfg.shoulderOffset != null) shoulderOffset = cfg.shoulderOffset
    if (cfg.headHeight != null) headHeight = cfg.headHeight
    if (cfg.zoomStages) zoomStages = cfg.zoomStages
    if (cfg.defaultZoomIndex != null) zoomIndex = cfg.defaultZoomIndex
    if (cfg.followSpeed != null) camFollowSpeed = cfg.followSpeed
    if (cfg.snapSpeed != null) camSnapSpeed = cfg.snapSpeed
    if (cfg.mouseSensitivity != null) mouseSensitivity = cfg.mouseSensitivity
    if (cfg.pitchRange) { pitchMin = cfg.pitchRange[0]; pitchMax = cfg.pitchRange[1] }
    if (cfg.fov) { camera.fov = cfg.fov; camera.updateProjectionMatrix() }
  }

  function getAimDirection(playerPos) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
    const fwdX = sy*cp, fwdY = sp, fwdZ = cy*cp
    if (!playerPos || zoomStages[zoomIndex] < 0.01) return [fwdX, fwdY, fwdZ]
    const dist = zoomStages[zoomIndex]
    const cpx = playerPos[0] - fwdX*dist + (-cy)*shoulderOffset, cpy = playerPos[1] + headHeight - fwdY*dist + 0.2, cpz = playerPos[2] - fwdZ*dist + sy*shoulderOffset
    const dx = cpx + fwdX*200 - playerPos[0], dy = cpy + fwdY*200 - (playerPos[1]+0.9), dz = cpz + fwdZ*200 - playerPos[2]
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz)
    return len > 0.001 ? [dx/len, dy/len, dz/len] : [fwdX, fwdY, fwdZ]
  }

  return {
    update, applyConfig, getAimDirection, setMode, getMode: () => mode,
    setEnvironment: meshes => { envMeshes.length = 0; envMeshes.push(...meshes) },
    addEnvironment: meshes => { for (const m of meshes) envMeshes.push(m) },
    setCameraBone: bone => { cameraBone = bone },
    setHeadBone: bone => { headBone = bone },
    restore: saved => { if (saved) { yaw = saved.yaw||0; pitch = saved.pitch||0; zoomIndex = saved.zoomIndex??2 } },
    save: () => ({ yaw, pitch, zoomIndex }),
    onMouseMove: e => { yaw -= e.movementX * mouseSensitivity; pitch = Math.max(pitchMin, Math.min(pitchMax, pitch - e.movementY * mouseSensitivity)) },
    onWheel: e => { if (e.deltaY > 0) zoomIndex = Math.min(zoomIndex+1, zoomStages.length-1); else zoomIndex = Math.max(zoomIndex-1, 0); e.preventDefault() },
    setPosition: (x,y,z) => camera.position.set(x,y,z),
    setTarget: (x,y,z) => camera.lookAt(x,y,z),
    punch: intensity => { punchYawTarget += (Math.random()-0.5)*intensity*0.9; punchPitchTarget += (Math.random()-0.3)*intensity*0.9 },
    setVRYaw: v => { yaw = v }, getVRYaw: () => yaw,
    setVRPitch: v => { pitch = v }, getVRPitch: () => pitch,
    adjustVRPitch: delta => { pitch = Math.max(pitchMin, Math.min(pitchMax, pitch + delta)) },
    setEditMode: enabled => { if (enabled && !editMode) editCamPos.copy(camera.position); editMode = enabled },
    getEditMode: () => editMode,
    getEditCameraPosition: () => editCamPos,
    get yaw() { return yaw }, get pitch() { return pitch }, get mode() { return mode }
  }
}
