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

export function createCameraController(camera, scene) {
  let yaw = 0, pitch = 0, zoomIndex = 2, camInitialized = false
  let mode = 'tps'
  const envMeshes = []
  let rayTimer = 0, cachedClipDist = 10, cachedAimPoint = null, fpsClipDist = 0
  let cameraBone = null
  let headBone = null
  let fpsForwardOffset = 0.7
  camRaycaster.firstHitOnly = true
  aimRaycaster.firstHitOnly = true

  function setEnvironment(meshes) { envMeshes.length = 0; envMeshes.push(...meshes) }
  function setCameraBone(bone) { cameraBone = bone }
  function setHeadBone(bone) { headBone = bone }

  function setMode(m) {
    const prev = mode
    mode = m
    if (m === 'fps' && headBone) headBone.scale.set(0, 0, 0)
    if (prev === 'fps' && m !== 'fps' && headBone) headBone.scale.set(1, 1, 1)
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

  function update(localPlayer, localMesh, frameDt) {
    if (mode === 'custom' || mode === 'fixed') return
    if (!localPlayer) return
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
      const pitchExtra = pitch < 0 ? Math.abs(pitch) * 0.5 : 0
      const effectiveForward = fpsForwardOffset + pitchExtra
      if (cameraBone && localMesh) {
        localMesh.updateMatrixWorld(true)
        cameraBone.getWorldPosition(_boneWorldPos)
        _boneForward.set(fwdX, fwdY, fwdZ)
        camera.position.copy(_boneWorldPos).addScaledVector(_boneForward, effectiveForward)
        camera.position.y += 0.35
      } else {
        camera.position.copy(camTarget)
      }
      if (headBone) headBone.scale.set(0, 0, 0)
      camDir.set(fwdX, fwdY, fwdZ)
      const fpsRayRange = 2.0
      camRaycaster.set(camera.position, camDir)
      camRaycaster.far = fpsRayRange
      camRaycaster.near = 0
      const rayTargets = envMeshes.length ? envMeshes : scene.children
      const hits = camRaycaster.intersectObjects(rayTargets, true)
      let targetClip = 0
      for (const hit of hits) {
        if (localMesh && isDescendant(hit.object, localMesh)) continue
        targetClip = Math.max(0.05, fpsRayRange - hit.distance + 0.2)
        break
      }
      const sideRange = 0.35
      const sideDirs = [
        [-rightX, 0, -rightZ],
        [rightX, 0, rightZ],
        [0, 1, 0],
        [0, -1, 0]
      ]
      for (const sd of sideDirs) {
        camDir.set(sd[0], sd[1], sd[2])
        camRaycaster.set(camera.position, camDir)
        camRaycaster.far = sideRange
        camRaycaster.near = 0
        const sideHits = camRaycaster.intersectObjects(rayTargets, true)
        for (const hit of sideHits) {
          if (localMesh && isDescendant(hit.object, localMesh)) continue
          const pull = Math.max(0.05, sideRange - hit.distance + 0.1)
          targetClip = Math.max(targetClip, pull)
          break
        }
      }
      camDir.set(fwdX, fwdY, fwdZ)
      const clipSpeed = targetClip > fpsClipDist ? 40 : 8
      fpsClipDist += (targetClip - fpsClipDist) * (1 - Math.exp(-clipSpeed * frameDt))
      if (fpsClipDist < 0.001) fpsClipDist = 0
      if (fpsClipDist > 0) {
        camera.position.addScaledVector(camDir, -fpsClipDist)
      }
      camera.lookAt(camera.position.x + fwdX, camera.position.y + fwdY, camera.position.z + fwdZ)
    } else {
      if (headBone) headBone.scale.set(1, 1, 1)
      camDesired.set(
        camTarget.x - fwdX * dist + rightX * shoulderOffset,
        camTarget.y - fwdY * dist + 0.2,
        camTarget.z - fwdZ * dist + rightZ * shoulderOffset
      )
      camDir.subVectors(camDesired, camTarget).normalize()
      const fullDist = camTarget.distanceTo(camDesired)
      rayTimer += frameDt
      const doRaycast = rayTimer >= 0.05
      if (doRaycast) {
        rayTimer = 0
        camRaycaster.set(camTarget, camDir)
        camRaycaster.far = fullDist
        camRaycaster.near = 0
        const hits = camRaycaster.intersectObjects(envMeshes.length ? envMeshes : scene.children, true)
        cachedClipDist = fullDist
        for (const hit of hits) {
          if (localMesh && isDescendant(hit.object, localMesh)) continue
          if (hit.distance < cachedClipDist) cachedClipDist = hit.distance - 0.2
        }
        if (cachedClipDist < 0.3) cachedClipDist = 0.3
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
      if (doRaycast) {
        aimRaycaster.set(camera.position, aimDir)
        aimRaycaster.far = 500
        aimRaycaster.near = 0.5
        const aimHits = aimRaycaster.intersectObjects(envMeshes.length ? envMeshes : scene.children, true)
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

  return { restore, save, onMouseMove, onWheel, getAimDirection, update, setEnvironment, setCameraBone, setHeadBone, applyConfig, setMode, getMode, setPosition, setTarget, punch, setVRYaw, getVRYaw, get yaw() { return yaw }, get pitch() { return pitch }, get mode() { return mode } }
}
