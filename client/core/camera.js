import * as THREE from 'three'
import { dbg } from './debug-log.js'

const _dbgCamera = dbg('camera')
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
const _smoothTarget = new THREE.Vector3()
const _targetVel = new THREE.Vector3()
const _camVel = new THREE.Vector3()
const _lookVel = new THREE.Vector3()
const _tmp = new THREE.Vector3()

function smoothDampVec3(current, target, velocity, smoothTime, dt) {
  const st = Math.max(0.0001, smoothTime)
  const omega = 2 / st
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  _tmp.subVectors(current, target)
  const cx = _tmp.x, cy = _tmp.y, cz = _tmp.z
  const tx = (velocity.x + omega * cx) * dt
  const ty = (velocity.y + omega * cy) * dt
  const tz = (velocity.z + omega * cz) * dt
  velocity.set(
    (velocity.x - omega * tx) * exp,
    (velocity.y - omega * ty) * exp,
    (velocity.z - omega * tz) * exp
  )
  current.set(
    target.x + (cx + tx) * exp,
    target.y + (cy + ty) * exp,
    target.z + (cz + tz) * exp
  )
}

function isDescendant(obj, ancestor) {
  let cur = obj
  while (cur) { if (cur === ancestor) return true; cur = cur.parent }
  return false
}

export function createCameraController(camera, scene) {
  let yaw = 0, pitch = 0, zoomIndex = 2, camInitialized = false, mode = 'tps'
  let editMode = false, editCamPos = new THREE.Vector3(0, 5, 10), editCamSpeed = 8
  const editVel = new THREE.Vector3()
  const editAccelHz = 5, editBoostRate = 1.6, editBoostMax = 6
  let editBoost = 1
  const ALT_SPEED_MIN = 1, ALT_SPEED_MAX = 40, ALT_SPEED_K = 2.2
  let _lastAltSampleX = Infinity, _lastAltSampleZ = Infinity, _cachedAltMul = ALT_SPEED_MIN
  const ALT_SAMPLE_EPS2 = 4
  function _editAltitudeSpeedMul(x, y, z) {
    const dx = x - _lastAltSampleX, dz = z - _lastAltSampleZ
    if (dx * dx + dz * dz > ALT_SAMPLE_EPS2) {
      _lastAltSampleX = x; _lastAltSampleZ = z
      let ground = 0
      try {
        const f = typeof window !== 'undefined' && window.__terrain && window.__terrain.frame
        if (f) {
          const fo = typeof window !== 'undefined' && window.__floatingOrigin
          const ax = fo ? x + fo.getShift().x : x, az = fo ? z + fo.getShift().z : z
          ground = f.groundHeightLocal(ax, az)
        }
      } catch (e) { _dbgCamera('groundHeightLocal sample failed:', e?.message || e) }
      const alt = Math.max(0, y - ground)
      _cachedAltMul = Math.max(ALT_SPEED_MIN, Math.min(ALT_SPEED_MAX, ALT_SPEED_K * Math.sqrt(alt)))
    }
    return _cachedAltMul
  }
  let _gameplayCam = null
  let _onCameraInHead = null
  let shoulderOffset = 0.35, headHeight = 0.4
  let zoomStages = [0, 1.5, 3, 5, 8], shoulderOffsets = null, mouseSensitivity = 0.002
  let invertY = false
  let pitchMin = -1.4, pitchMax = 1.4
  let fpsRayTimer = 0, tpsRayTimer = 0, cachedClipDist = 10, cachedAimPoint = null
  let targetSmoothTime = 0.02, cameraSmoothTime = 0.03, lookSmoothTime = 0.025
  let clipInSmoothTime = 0.02, clipOutSmoothTime = 0.10, tpsRayInterval = 0
  let inputYawDelta = 0, inputPitchDelta = 0, inputSmoothHz = 28
  let fpsPushX = 0, fpsPushY = 0, fpsPushZ = 0
  let cameraBone = null, headBone = null, headBoneHidden = false
  let fpsForwardOffset = 0.7, fpsHeadDownOffset = 0.2
  let punchYawTarget = 0, punchPitchTarget = 0, punchYaw = 0, punchPitch = 0
  const envMeshes = []
  const _bvhMeshes = []
  let _bvhDirty = true, _bvhPending = false
  let _bvhChanged = false, _bvhLastRefresh = 0
  function refreshBvhMeshes() {
    const prevCount = _bvhMeshes.length
    _bvhMeshes.length = 0; _bvhPending = false
    for (const m of envMeshes) {
      if (m.geometry?.boundsTree) _bvhMeshes.push(m)
      else _bvhPending = true
    }
    _bvhDirty = false
    _bvhLastRefresh = performance.now()
    if (_bvhMeshes.length !== prevCount) _bvhChanged = true
  }
  function ensureBvhMeshes() {
    if (_bvhDirty || (_bvhPending && performance.now() - _bvhLastRefresh > 500)) refreshBvhMeshes()
  }
  const _camWorldSphere = new THREE.Sphere()
  if (typeof window !== 'undefined') {
    window.__camEnvMeshes = () => ({ env: envMeshes.length, bvh: _bvhMeshes.length })
  }
  camRaycaster.firstHitOnly = true
  aimRaycaster.firstHitOnly = true

  const _bvhRaySet = []
  const _lastRayTarget = new THREE.Vector3(Infinity, 0, 0)
  const _lastRayEnd = new THREE.Vector3()
  const _lastRayCamPos = new THREE.Vector3()
  const _lastRayAimDir = new THREE.Vector3()
  const RAY_MOVE_EPS2 = 1e-4
  const RAY_DIR_EPS2 = 1e-6
  const RAY_IDLE_INTERVAL = 0.5
  if (typeof window !== 'undefined') window.__camRayCasts = 0
  function bvhMeshesAlongRay(origin, dir, far) {
    if (typeof window !== 'undefined') window.__camRayCasts++
    _bvhRaySet.length = 0
    for (let i = 0; i < _bvhMeshes.length; i++) {
      const m = _bvhMeshes[i]
      const gs = m.geometry.boundingSphere
      if (!gs) { _bvhRaySet.push(m); continue }
      _camWorldSphere.copy(gs).applyMatrix4(m.matrixWorld)
      const ocx = _camWorldSphere.center.x - origin.x, ocy = _camWorldSphere.center.y - origin.y, ocz = _camWorldSphere.center.z - origin.z
      let t = ocx * dir.x + ocy * dir.y + ocz * dir.z
      if (t < 0) t = 0; else if (t > far) t = far
      const px = origin.x + dir.x * t - _camWorldSphere.center.x
      const py = origin.y + dir.y * t - _camWorldSphere.center.y
      const pz = origin.z + dir.z * t - _camWorldSphere.center.z
      const r = _camWorldSphere.radius
      if (px * px + py * py + pz * pz <= r * r) _bvhRaySet.push(m)
    }
    return _bvhRaySet
  }

  function updateFPS(localMesh, frameDt, fwdX, fwdY, fwdZ) {
    if (cameraBone && localMesh) {
      cameraBone.getWorldPosition(_boneWorldPos)
      _boneForward.set(fwdX, 0, fwdZ).normalize()
      camera.position.copy(_boneWorldPos).addScaledVector(_boneForward, fpsForwardOffset)
      camera.position.y += 0.35
    } else { camera.position.copy(camTarget) }
    camera.position.x += fpsPushX; camera.position.y += fpsPushY; camera.position.z += fpsPushZ
    fpsRayTimer += frameDt
    if (fpsRayTimer >= 0.05 && envMeshes.length) {
      fpsRayTimer = 0; fpsPushX = 0; fpsPushY = 0; fpsPushZ = 0
      const wallDist = 0.35, fwdWallDist = 0.25
      ensureBvhMeshes()
      if (_bvhMeshes.length) {
        _fpsRayOrigin.copy(camera.position); _fpsRayDir.set(-fwdX, -fwdY, -fwdZ)
        camRaycaster.set(_fpsRayOrigin, _fpsRayDir); camRaycaster.far = wallDist; camRaycaster.near = 0
        const backSet = bvhMeshesAlongRay(_fpsRayOrigin, _fpsRayDir, wallDist)
        for (const hit of camRaycaster.intersectObjects(backSet, false)) {
          if (localMesh && isDescendant(hit.object, localMesh)) continue
          const push = wallDist - hit.distance
          if (push > 0) { fpsPushX += fwdX*push; fpsPushY += fwdY*push; fpsPushZ += fwdZ*push; camera.position.x += fwdX*push; camera.position.y += fwdY*push; camera.position.z += fwdZ*push }
          break
        }
        _fpsRayOrigin.copy(camera.position); _fpsRayDir.set(fwdX, fwdY, fwdZ); camRaycaster.set(camera.position, _fpsRayDir); camRaycaster.far = fwdWallDist; camRaycaster.near = 0
        const fwdSet = bvhMeshesAlongRay(_fpsRayOrigin, _fpsRayDir, fwdWallDist)
        for (const hit of camRaycaster.intersectObjects(fwdSet, false)) {
          if (localMesh && isDescendant(hit.object, localMesh)) continue
          const push = fwdWallDist - hit.distance
          if (push > 0) { fpsPushX -= fwdX*push; fpsPushY -= fwdY*push; fpsPushZ -= fwdZ*push; camera.position.x -= fwdX*push; camera.position.y -= fwdY*push; camera.position.z -= fwdZ*push }
          break
        }
      }
    }
    camera.lookAt(camera.position.x + fwdX, camera.position.y + fwdY, camera.position.z + fwdZ)
  }

  function updateTPS(dist, localMesh, frameDt, fwdX, fwdY, fwdZ, rightX, rightZ) {
    if (headBone && headBoneHidden) { headBone.scale.set(1, 1, 1); headBoneHidden = false }
    const so = shoulderOffsets ? (shoulderOffsets[zoomIndex] ?? shoulderOffset) : shoulderOffset
    const _maxZoom = zoomStages.length ? zoomStages[zoomStages.length - 1] : 8
    const PROX_TIGHT = 0.35
    const proximityScale = PROX_TIGHT + (1 - PROX_TIGHT) * Math.max(0, Math.min(1, dist / Math.max(0.0001, _maxZoom)))
    const tgtST = targetSmoothTime * proximityScale
    const camST = cameraSmoothTime * proximityScale
    const lookST = lookSmoothTime * proximityScale
    if (!camInitialized) _smoothTarget.copy(camTarget)
    smoothDampVec3(_smoothTarget, camTarget, _targetVel, tgtST, frameDt)
    camDesired.set(_smoothTarget.x - fwdX*dist + rightX*so, _smoothTarget.y - fwdY*dist + 0.2, _smoothTarget.z - fwdZ*dist + rightZ*so)
    camDir.subVectors(camDesired, _smoothTarget).normalize()
    const fullDist = _smoothTarget.distanceTo(camDesired)
    tpsRayTimer += frameDt
    if (envMeshes.length) ensureBvhMeshes()
    const _rayMoved = _bvhChanged
      || _lastRayTarget.distanceToSquared(_smoothTarget) > RAY_MOVE_EPS2
      || _lastRayEnd.distanceToSquared(camDesired) > RAY_MOVE_EPS2
      || _lastRayCamPos.distanceToSquared(camera.position) > RAY_MOVE_EPS2
      || _lastRayAimDir.distanceToSquared(aimDir.set(fwdX, fwdY, fwdZ)) > RAY_DIR_EPS2
    const doRaycast = tpsRayTimer >= (_rayMoved ? tpsRayInterval : RAY_IDLE_INTERVAL)
    if (doRaycast) {
      const rayDt = Math.max(frameDt, Math.min(tpsRayTimer, RAY_IDLE_INTERVAL))
      tpsRayTimer = 0; _bvhChanged = false
      _lastRayTarget.copy(_smoothTarget); _lastRayEnd.copy(camDesired)
      _lastRayCamPos.copy(camera.position); _lastRayAimDir.copy(aimDir)
      camRaycaster.set(_smoothTarget, camDir); camRaycaster.far = fullDist; camRaycaster.near = 0
      let targetClipDist = fullDist
      if (envMeshes.length) {
        ensureBvhMeshes()
        if (_bvhMeshes.length) {
          const clipSet = bvhMeshesAlongRay(_smoothTarget, camDir, fullDist)
          for (const hit of camRaycaster.intersectObjects(clipSet, false)) {
            if (localMesh && isDescendant(hit.object, localMesh)) continue
            if (hit.distance < targetClipDist) targetClipDist = hit.distance - 0.2
          }
          if (targetClipDist < 0.3) targetClipDist = 0.3
        }
      }
      const clipT = 1 - Math.exp(-(targetClipDist < cachedClipDist ? 1 / clipInSmoothTime : 1 / clipOutSmoothTime) * rayDt)
      cachedClipDist += (targetClipDist - cachedClipDist) * clipT
    }
    const clippedDist = Math.min(cachedClipDist, fullDist)
    camDesired.set(_smoothTarget.x + camDir.x*clippedDist, _smoothTarget.y + camDir.y*clippedDist, _smoothTarget.z + camDir.z*clippedDist)
    if (!camInitialized) { camera.position.copy(camDesired); _smoothTarget.copy(camTarget); camInitialized = true }
    else smoothDampVec3(camera.position, camDesired, _camVel, camST, frameDt)
    aimDir.set(fwdX, fwdY, fwdZ)
    if (doRaycast && envMeshes.length) {
      ensureBvhMeshes()
      if (_bvhMeshes.length) {
        aimRaycaster.set(camera.position, aimDir); aimRaycaster.far = 500; aimRaycaster.near = 0.5
        cachedAimPoint = null
        const aimSet = bvhMeshesAlongRay(camera.position, aimDir, 500)
        for (const ah of aimRaycaster.intersectObjects(aimSet, false)) { if (localMesh && isDescendant(ah.object, localMesh)) continue; cachedAimPoint = ah.point; break }
      }
    }
    if (cachedAimPoint) { if (!camLookTarget.lengthSq()) camLookTarget.copy(cachedAimPoint); smoothDampVec3(camLookTarget, cachedAimPoint, _lookVel, lookST, frameDt) }
    else { camLookTarget.set(camera.position.x + fwdX*200, camera.position.y + fwdY*200, camera.position.z + fwdZ*200) }
    camera.lookAt(camLookTarget)
  }

  function applyLookInput(dt) {
    const t = 1 - Math.exp(-inputSmoothHz * dt)
    yaw -= inputYawDelta * t
    pitch = Math.max(pitchMin, Math.min(pitchMax, pitch - inputPitchDelta * t))
    const decay = 1 - Math.min(1, inputSmoothHz * dt)
    inputYawDelta *= decay
    inputPitchDelta *= decay
  }

  function updateEditFlyCam(frameDt, inputState) {
    applyLookInput(frameDt)
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
    const fwd = (inputState.forward?1:0)-(inputState.backward?1:0)
    const strafe = (inputState.right?1:0)-(inputState.left?1:0)
    const up = (inputState.jump?1:0)-(inputState.crouch?1:0)
    const moving = (fwd || strafe || up) ? 1 : 0
    editBoost = moving ? Math.min(editBoostMax, editBoost + editBoostRate * frameDt) : 1
    const altMul = _editAltitudeSpeedMul(editCamPos.x, editCamPos.y, editCamPos.z)
    const maxV = editCamSpeed * editBoost * altMul
    const wishX = (fwd*sy + strafe*(-cy)) * maxV, wishY = up * maxV, wishZ = (fwd*cy + strafe*sy) * maxV
    const aT = 1 - Math.exp(-editAccelHz * frameDt)
    editVel.x += (wishX - editVel.x) * aT; editVel.y += (wishY - editVel.y) * aT; editVel.z += (wishZ - editVel.z) * aT
    editCamPos.x += editVel.x * frameDt; editCamPos.y += editVel.y * frameDt; editCamPos.z += editVel.z * frameDt
    camera.position.copy(editCamPos); camera.lookAt(editCamPos.x + sy*cp*100, editCamPos.y + sp*100, editCamPos.z + cy*cp*100)
  }

  function updateHeadBoneVisibility(inHead) {
    if (!headBone || inHead === headBoneHidden) return
    if (inHead) { headBone.scale.set(0, 0, 0); headBone.position.y -= fpsHeadDownOffset }
    else { headBone.scale.set(1, 1, 1); headBone.position.y += fpsHeadDownOffset }
    headBoneHidden = inHead
    if (_onCameraInHead) try { _onCameraInHead(inHead) } catch (_) {}
  }

  function update(localPlayer, localMesh, frameDt, inputState) {
    if (mode === 'custom' || mode === 'fixed') return
    if (!localPlayer && !editMode) return
    if (editMode && inputState) { updateEditFlyCam(frameDt, inputState); return }
    if (localMesh) camTarget.set(localMesh.position.x, localMesh.position.y + headHeight, localMesh.position.z)
    else camTarget.set(localPlayer.position[0], localPlayer.position[1] + headHeight, localPlayer.position[2])
    applyLookInput(frameDt)
    const pLerp = 1 - Math.exp(-972 * frameDt)
    punchYaw += (punchYawTarget - punchYaw) * pLerp; punchPitch += (punchPitchTarget - punchPitch) * pLerp
    punchYawTarget *= 1 - Math.min(1, 18*frameDt); punchPitchTarget *= 1 - Math.min(1, 18*frameDt)
    yaw += punchYaw * frameDt; pitch = Math.max(pitchMin, Math.min(pitchMax, pitch + punchPitch * frameDt))
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
    const fwdX = sy*cp, fwdY = sp, fwdZ = cy*cp
    const dist = mode === 'fps' ? 0 : zoomStages[zoomIndex]
    updateHeadBoneVisibility(dist < 0.01)
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
    if (cfg.shoulderOffsets) shoulderOffsets = cfg.shoulderOffsets
    if (cfg.defaultZoomIndex != null) zoomIndex = cfg.defaultZoomIndex
    if (cfg.followSpeed != null && cfg.followSpeed > 0) cameraSmoothTime = Math.max(0.01, 1 / cfg.followSpeed)
    if (cfg.snapSpeed != null && cfg.snapSpeed > 0) clipInSmoothTime = Math.max(0.01, 1 / cfg.snapSpeed)
    if (cfg.targetSmoothTime != null) targetSmoothTime = cfg.targetSmoothTime
    if (cfg.cameraSmoothTime != null) cameraSmoothTime = cfg.cameraSmoothTime
    if (cfg.lookSmoothTime != null) lookSmoothTime = cfg.lookSmoothTime
    if (cfg.clipInSmoothTime != null) clipInSmoothTime = cfg.clipInSmoothTime
    if (cfg.clipOutSmoothTime != null) clipOutSmoothTime = cfg.clipOutSmoothTime
    if (cfg.tpsRayInterval != null) tpsRayInterval = Math.max(0, cfg.tpsRayInterval)
    if (cfg.inputSmoothHz != null) inputSmoothHz = Math.max(0, cfg.inputSmoothHz)
    if (cfg.mouseSensitivity != null) mouseSensitivity = cfg.mouseSensitivity
    if (cfg.invertY != null) invertY = !!cfg.invertY
    if (cfg.pitchRange) { pitchMin = cfg.pitchRange[0]; pitchMax = cfg.pitchRange[1] }
    if (cfg.fov || cfg.near != null || cfg.far != null) { if (cfg.fov) camera.fov = cfg.fov; if (cfg.near != null) camera.near = cfg.near; if (cfg.far != null) camera.far = cfg.far; camera.updateProjectionMatrix() }
    if (cfg.yaw != null) yaw = cfg.yaw
  }

  function getAimDirection(playerPos) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
    const fwdX = sy*cp, fwdY = sp, fwdZ = cy*cp
    if (!playerPos || zoomStages[zoomIndex] < 0.01) return [fwdX, fwdY, fwdZ]
    const dist = zoomStages[zoomIndex]
    const so = shoulderOffsets ? (shoulderOffsets[zoomIndex] ?? shoulderOffset) : shoulderOffset
    const cpx = playerPos[0] - fwdX*dist + (-cy)*so, cpy = playerPos[1] + headHeight - fwdY*dist + 0.2, cpz = playerPos[2] - fwdZ*dist + sy*so
    const dx = cpx + fwdX*200 - playerPos[0], dy = cpy + fwdY*200 - (playerPos[1]+0.9), dz = cpz + fwdZ*200 - playerPos[2]
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz)
    return len > 0.001 ? [dx/len, dy/len, dz/len] : [fwdX, fwdY, fwdZ]
  }

  function setEditMode(enabled, localMesh) {
    if (enabled && !editMode) {
      _gameplayCam = { yaw, pitch, zoomIndex }
      const px = localMesh ? localMesh.position.x : camera.position.x
      const py = localMesh ? localMesh.position.y : camera.position.y
      const pz = localMesh ? localMesh.position.z : camera.position.z
      const sy = Math.sin(yaw), cy = Math.cos(yaw)
      editCamPos.set(px - sy * 8, py + 5, pz - cy * 8)
      pitch = -0.35
      editVel.set(0, 0, 0); editBoost = 1
    } else if (!enabled && editMode && _gameplayCam) {
      yaw = _gameplayCam.yaw; pitch = _gameplayCam.pitch; zoomIndex = _gameplayCam.zoomIndex
      _gameplayCam = null
    }
    editMode = enabled
  }

  return {
    update, applyConfig, getAimDirection, setMode, getMode: () => mode,
    setEnvironment: meshes => { envMeshes.length = 0; envMeshes.push(...meshes); _bvhDirty = true },
    addEnvironment: meshes => { for (const m of meshes) envMeshes.push(m); _bvhDirty = true },
    removeEnvironment: meshes => { const s = new Set(meshes); for (let i = envMeshes.length - 1; i >= 0; i--) { if (s.has(envMeshes[i])) envMeshes.splice(i, 1) } _bvhDirty = true },
    setCameraBone: bone => { cameraBone = bone },
    setHeadBone: bone => { headBone = bone },
    restore: saved => { if (saved) { yaw = saved.yaw||0; pitch = saved.pitch||0; zoomIndex = saved.zoomIndex??2 } },
    save: () => ({ yaw, pitch, zoomIndex }),
    onMouseMove: e => { inputYawDelta += e.movementX * mouseSensitivity; inputPitchDelta += e.movementY * mouseSensitivity * (invertY ? -1 : 1) },
    getInvertY: () => invertY, setInvertY: v => { invertY = !!v },
    editLook: (dx, dy) => { inputYawDelta += dx * mouseSensitivity; inputPitchDelta += dy * mouseSensitivity },
    onWheel: e => { if (e.deltaY > 0) zoomIndex = Math.min(zoomIndex+1, zoomStages.length-1); else zoomIndex = Math.max(zoomIndex-1, 0); e.preventDefault() },
    setPosition: (x,y,z) => { camera.position.set(x,y,z); editCamPos.set(x,y,z); editVel.set(0,0,0) },
    setTarget: (x,y,z) => camera.lookAt(x,y,z),
    shiftFloatingOrigin: (dx, dy, dz) => { editCamPos.x += dx; editCamPos.y += dy; editCamPos.z += dz },
    punch: intensity => { punchYawTarget += (Math.random()-0.5)*intensity*0.9; punchPitchTarget += (Math.random()-0.3)*intensity*0.9 },
    setVRYaw: v => { yaw = v }, getVRYaw: () => yaw,
    setVRPitch: v => { pitch = v }, getVRPitch: () => pitch,
    adjustVRPitch: delta => { pitch = Math.max(pitchMin, Math.min(pitchMax, pitch + delta)) },
    setEditMode,
    getEditMode: () => editMode,
    getEditCameraPosition: () => editCamPos,
    setEditCameraPosition: (x, y, z) => { editCamPos.set(x, y, z); editVel.set(0, 0, 0); editBoost = 1; _lastAltSampleX = Infinity; _lastAltSampleZ = Infinity },
    getEditAltitudeSpeedMul: () => _cachedAltMul,
    onCameraInHead: fn => { _onCameraInHead = fn },
    getZoomIndex: () => zoomIndex,
    get yaw() { return yaw }, get pitch() { return pitch }, get mode() { return mode }
  }
}
