import * as THREE from 'three'

const camTarget = new THREE.Vector3()
const camRaycaster = new THREE.Raycaster()
const camDir = new THREE.Vector3()
const camDesired = new THREE.Vector3()
const camLookTarget = new THREE.Vector3()
const aimRaycaster = new THREE.Raycaster()
const aimDir = new THREE.Vector3()
let shoulderOffset = 0.35
let headHeight = 0.4
let camFollowSpeed = 12.0
let camSnapSpeed = 30.0
let zoomStages = [0, 1.5, 3, 5, 8]
let mouseSensitivity = 0.002
let pitchMin = -1.4, pitchMax = 1.4

function isDescendant(obj, ancestor) {
  let cur = obj
  while (cur) {
    if (cur === ancestor) return true
    cur = cur.parent
  }
  return false
}

const _boneWorldPos = new THREE.Vector3()
const _boneForward = new THREE.Vector3()
const _fpsRayOrigin = new THREE.Vector3()
const _fpsRayDir = new THREE.Vector3()

export function createCameraController(camera, scene) {
  let yaw = 0, pitch = 0, zoomIndex = 2, camInitialized = false
  let mode = 'tps'
  let editMode = false
  let editCamPos = new THREE.Vector3(0, 5, 10)
  let editCamSpeed = 8
  const envMeshes = []
  let fpsRayTimer = 0, tpsRayTimer = 0, cachedClipDist = 10, cachedAimPoint = null
  let cameraBone = null
  let headBone = null
  let headBoneHidden = false
  let fpsForwardOffset = 0.7
  let fpsHeadDownOffset = 0.2
  camRaycaster.firstHitOnly = true
  aimRaycaster.firstHitOnly = true

  function setEnvironment(meshes) { envMeshes.length = 0; envMeshes.push(...meshes) }
  function setCameraBone(bone) { cameraBone = bone }
  function setHeadBone(bone) { headBone = bone }

  function setMode(m) {
    const prev = mode
    mode = m
    if (m === 'fps' && headBone) {
      headBone.scale.set(0, 0, 0)
      headBone.position.y -= fpsHeadDownOffset
      headBoneHidden = true
    }
    if (prev === 'fps' && m !== 'fps' && headBone) {
      headBone.scale.set(1, 1, 1)
      headBone.position.y += fpsHeadDownOffset
      headBoneHidden = false
    }
  }
  function getMode() { return mode }

  function setPosition(x, y, z) { camera.position.set(x, y, z) }
  function setTarget(x, y, z) { camera.lookAt(x, y, z) }

  function restore(saved) {
    if (saved) { yaw = saved.yaw || 0; pitch = saved.pitch || 0; zoomIndex = saved.zoomIndex ?? 2 }
  }

  function save() { return { yaw, pitch, zoomIndex } }

  function onMouseMove(e) {
    yaw -= e.movementX * mouseSensitivity
    pitch -= e.movementY * mouseSensitivity
    pitch = Math.max(pitchMin, Math.min(pitchMax, pitch))
  }

  function onWheel(e) {
    if (e.deltaY > 0) zoomIndex = Math.min(zoomIndex + 1, zoomStages.length - 1)
    else zoomIndex = Math.max(zoomIndex - 1, 0)
    e.preventDefault()
  }

  function getAimDirection(playerPos) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw)
    const sp = Math.sin(pitch), cp = Math.cos(pitch)
    const fwdX = sy * cp, fwdY = sp, fwdZ = cy * cp
    if (!playerPos || zoomStages[zoomIndex] < 0.01) return [fwdX, fwdY, fwdZ]
    const dist = zoomStages[zoomIndex]
    const rightX = -cy, rightZ = sy
    const cpx = playerPos[0] - fwdX * dist + rightX * shoulderOffset
    const cpy = playerPos[1] + headHeight - fwdY * dist + 0.2
    const cpz = playerPos[2] - fwdZ * dist + rightZ * shoulderOffset
    const tx = cpx + fwdX * 200, ty = cpy + fwdY * 200, tz = cpz + fwdZ * 200
    const ox = playerPos[0], oy = playerPos[1] + 0.9, oz = playerPos[2]
    const dx = tx - ox, dy = ty - oy, dz = tz - oz
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    return len > 0.001 ? [dx / len, dy / len, dz / len] : [fwdX, fwdY, fwdZ]
  }

  function update(localPlayer, localMesh, frameDt, inputState) {
    if (mode === 'custom' || mode === 'fixed') return
    if (!localPlayer && !editMode) return

    if (editMode && inputState) {
      const sy = Math.sin(yaw), cy = Math.cos(yaw)
      const fwdX = sy, fwdZ = cy
      const rightX = -cy, rightZ = sy
      const moveForward = (inputState.forward ? 1 : 0) - (inputState.backward ? 1 : 0)
      const moveRight = (inputState.right ? 1 : 0) - (inputState.left ? 1 : 0)
      const moveUp = (inputState.jump ? 1 : 0) - (inputState.crouch ? 1 : 0)
      const speed = editCamSpeed * frameDt
      editCamPos.x += (moveForward * fwdX + moveRight * rightX) * speed
      editCamPos.y += moveUp * speed
      editCamPos.z += (moveForward * fwdZ + moveRight * rightZ) * speed
      camera.position.copy(editCamPos)
      const sp = Math.sin(pitch), cp = Math.cos(pitch)
      camera.lookAt(
        camera.position.x + fwdX * 100,
        camera.position.y + sp * 100,
        camera.position.z + fwdZ * 100
      )
      return
    }

    const dist = mode === 'fps' ? 0 : zoomStages[zoomIndex]
    camTarget.set(localPlayer.position[0], localPlayer.position[1] + headHeight, localPlayer.position[2])
    const punchLerp = 1 - Math.exp(-972 * frameDt)
    punchYaw += (punchYawTarget - punchYaw) * punchLerp
    punchPitch += (punchPitchTarget - punchPitch) * punchLerp
    punchYawTarget *= 1 - Math.min(1, 18 * frameDt)
    punchPitchTarget *= 1 - Math.min(1, 18 * frameDt)
    yaw += punchYaw * frameDt
    pitch = Math.max(pitchMin, Math.min(pitchMax, pitch + punchPitch * frameDt))
    const sy = Math.sin(yaw), cy = Math.cos(yaw)
    const sp = Math.sin(pitch), cp = Math.cos(pitch)
    const fwdX = sy * cp, fwdY = sp, fwdZ = cy * cp
    const rightX = -cy, rightZ = sy
    if (dist < 0.01) {
      if (cameraBone && localMesh) {
        cameraBone.getWorldPosition(_boneWorldPos)
        _boneForward.set(fwdX, 0, fwdZ).normalize()
        camera.position.copy(_boneWorldPos).addScaledVector(_boneForward, fpsForwardOffset)
        camera.position.y += 0.35
      } else {
        camera.position.copy(camTarget)
      }
      if (headBone && !headBoneHidden) { headBone.scale.set(0, 0, 0); headBoneHidden = true }
      const wallDist = 0.35
      const fwdWallDist = 0.25
      fpsRayTimer += frameDt
      if (fpsRayTimer >= 0.05 && envMeshes.length) {
        fpsRayTimer = 0
        _fpsRayOrigin.copy(camera.position)
        _fpsRayDir.set(-fwdX, -fwdY, -fwdZ)
        camRaycaster.set(_fpsRayOrigin, _fpsRayDir)
        camRaycaster.far = wallDist
        camRaycaster.near = 0
        const hits = camRaycaster.intersectObjects(envMeshes, true)
        for (const hit of hits) {
          if (localMesh && isDescendant(hit.object, localMesh)) continue
          const push = wallDist - hit.distance
          if (push > 0) {
            camera.position.x += fwdX * push
            camera.position.y += fwdY * push
            camera.position.z += fwdZ * push
          }
          break
        }
        _fpsRayDir.set(fwdX, fwdY, fwdZ)
        camRaycaster.set(camera.position, _fpsRayDir)
        camRaycaster.far = fwdWallDist
        camRaycaster.near = 0
        const fwdHits = camRaycaster.intersectObjects(envMeshes, true)
        for (const hit of fwdHits) {
          if (localMesh && isDescendant(hit.object, localMesh)) continue
          const push = fwdWallDist - hit.distance
          if (push > 0) {
            camera.position.x -= fwdX * push
            camera.position.y -= fwdY * push
            camera.position.z -= fwdZ * push
          }
          break
        }
      }
      camera.lookAt(camera.position.x + fwdX, camera.position.y + fwdY, camera.position.z + fwdZ)
    } else {
      if (headBone && headBoneHidden) { headBone.scale.set(1, 1, 1); headBoneHidden = false }
      camDesired.set(
        camTarget.x - fwdX * dist + rightX * shoulderOffset,
        camTarget.y - fwdY * dist + 0.2,
        camTarget.z - fwdZ * dist + rightZ * shoulderOffset
      )
      camDir.subVectors(camDesired, camTarget).normalize()
      const fullDist = camTarget.distanceTo(camDesired)
      tpsRayTimer += frameDt
      const doRaycast = tpsRayTimer >= 0.05
      if (doRaycast) {
        tpsRayTimer = 0
        camRaycaster.set(camTarget, camDir)
        camRaycaster.far = fullDist
        camRaycaster.near = 0
        if (envMeshes.length) {
          const hits = camRaycaster.intersectObjects(envMeshes, true)
          cachedClipDist = fullDist
          for (const hit of hits) {
            if (localMesh && isDescendant(hit.object, localMesh)) continue
            if (hit.distance < cachedClipDist) cachedClipDist = hit.distance - 0.2
          }
          if (cachedClipDist < 0.3) cachedClipDist = 0.3
        } else {
          cachedClipDist = fullDist
        }
      }
      const clippedDist = Math.min(cachedClipDist, fullDist)
      camDesired.set(
        camTarget.x + camDir.x * clippedDist,
        camTarget.y + camDir.y * clippedDist,
        camTarget.z + camDir.z * clippedDist
      )
      if (!camInitialized) { camera.position.copy(camDesired); camInitialized = true }
      else {
        const closer = clippedDist < camera.position.distanceTo(camTarget)
        const speed = closer ? camSnapSpeed : camFollowSpeed
        camera.position.lerp(camDesired, 1.0 - Math.exp(-speed * frameDt))
      }
      aimDir.set(fwdX, fwdY, fwdZ)
      if (doRaycast && envMeshes.length) {
        aimRaycaster.set(camera.position, aimDir)
        aimRaycaster.far = 500
        aimRaycaster.near = 0.5
        const aimHits = aimRaycaster.intersectObjects(envMeshes, true)
        cachedAimPoint = null
        for (const ah of aimHits) {
          if (localMesh && isDescendant(ah.object, localMesh)) continue
          cachedAimPoint = ah.point; break
        }
      }
      if (cachedAimPoint) {
        const aimPoint = cachedAimPoint
        if (!camLookTarget.lengthSq()) camLookTarget.copy(aimPoint)
        camLookTarget.lerp(aimPoint, 1.0 - Math.exp(-camFollowSpeed * frameDt))
      } else {
        camLookTarget.set(camera.position.x + fwdX * 200, camera.position.y + fwdY * 200, camera.position.z + fwdZ * 200)
      }
      camera.lookAt(camLookTarget)
    }
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

  let punchYawTarget = 0, punchPitchTarget = 0, punchYaw = 0, punchPitch = 0
  function punch(intensity) {
    punchYawTarget += (Math.random() - 0.5) * intensity * 0.9
    punchPitchTarget += (Math.random() - 0.3) * intensity * 0.9
  }

function setVRYaw(vrYaw) { yaw = vrYaw }
function getVRYaw() { return yaw }
function setVRPitch(vrPitch) { pitch = vrPitch }
function getVRPitch() { return pitch }
function adjustVRPitch(delta) {
  pitch = Math.max(pitchMin, Math.min(pitchMax, pitch + delta))
}

function setEditMode(enabled) {
  if (enabled && !editMode) {
    editCamPos.copy(camera.position)
  }
  editMode = enabled
}
function getEditMode() { return editMode }
function getEditCameraPosition() { return editCamPos }

return { restore, save, onMouseMove, onWheel, getAimDirection, update, setEnvironment, setCameraBone, setHeadBone, applyConfig, setMode, getMode, setPosition, setTarget, punch, setVRYaw, getVRYaw, setVRPitch, getVRPitch, adjustVRPitch, setEditMode, getEditMode, getEditCameraPosition, get yaw() { return yaw }, get pitch() { return pitch }, get mode() { return mode } }
}
