// Two-bone (thigh/shin) foot IK adapting to terrain normal.
//
// Split off animation-blend-tree-foot-ik-aim-ik-compression-vrm-gpu-skinning (roadmap #72 piece) --
// see AGENTS.md's animation-foot-ik-terrain-normal PRD row.
//
// TERRAIN QUERY: reuses the SAME single-source-of-truth CPU height sampler every other terrain
// consumer uses (window.__terrain.frame.groundHeightLocal, PlanetFrame.js) -- no second terrain-query
// path. The normal is derived via the identical 4-tap central-difference pattern already used
// server-side by src/terrain/RockPlacement.js (nx=-dHdx, ny=1, nz=-dHdz, normalized) so a foot planted
// on a slope tilts the same way a rock resting on that slope would.
//
// COORDINATE SPACES: groundHeightLocal takes AUTHORITATIVE (unshifted) local-frame x/z, not
// render-space THREE coordinates -- see client/core/FloatingOrigin.js's header comment. Every call
// site here goes through window.__floatingOrigin.toAuthoritative() first.
//
// IK SOLVE: standard law-of-cosines two-bone IK (thigh length a, shin length b, hip-to-target
// distance c -- clamped to (a+b) so an unreachable target never produces NaN) with a pole vector
// pinned to the character's own forward direction so the knee always bends forward, never sideways or
// backward, matching a real human leg regardless of camera/character facing.
import * as THREE from 'three'

const _v0 = new THREE.Vector3()
const _v1 = new THREE.Vector3()
const _forwardWorld = new THREE.Vector3()
const _hipWorld = new THREE.Vector3()
const _footWorld = new THREE.Vector3()
const _footTarget = new THREE.Vector3()
const _auth = new THREE.Vector3()
const _poleDir = new THREE.Vector3()
const _bendAxis = new THREE.Vector3()
const _upperDir = new THREE.Vector3()
const _lowerDir = new THREE.Vector3()
const _q0 = new THREE.Quaternion()
const _q1 = new THREE.Quaternion()
const _qUpperRest = new THREE.Quaternion()
const _qLowerRest = new THREE.Quaternion()
const _qUpperIK = new THREE.Quaternion()
const _m0 = new THREE.Matrix4()
const _parentQuatInv = new THREE.Quaternion()
const _footNormal = new THREE.Vector3()
const _footUpWorld = new THREE.Vector3()
const _tiltAxis = new THREE.Vector3()
const _tiltQuat = new THREE.Quaternion()
const _footWorldQuat = new THREE.Quaternion()
const UP = new THREE.Vector3(0, 1, 0)

// Tilts a foot bone's world orientation so its local up-axis leans toward the sampled terrain normal,
// blended by `weight` (0 = untouched animation-authored ankle roll, 1 = fully aligned to the slope).
// Applied AFTER the leg IK's position solve so it doesn't fight solveLegIK's own quaternion writes --
// this only adjusts the foot bone itself, never upper/lower leg. Clamps the tilt magnitude so a noisy
// single-sample slope estimate can never snap the foot to a physically implausible angle.
const MAX_TILT_RAD = Math.PI / 4
function tiltFootToNormal(footBone, nx, ny, nz, weight) {
  if (weight <= 0.001) return
  footBone.updateMatrixWorld(true)
  _footWorldQuat.setFromRotationMatrix(_m0.extractRotation(footBone.matrixWorld))
  _footUpWorld.copy(UP).applyQuaternion(_footWorldQuat).normalize()
  _footNormal.set(nx, ny, nz).normalize()
  const dot = THREE.MathUtils.clamp(_footUpWorld.dot(_footNormal), -1, 1)
  let angle = Math.acos(dot)
  if (angle < 1e-4) return
  _tiltAxis.crossVectors(_footUpWorld, _footNormal)
  if (_tiltAxis.lengthSq() < 1e-8) return
  _tiltAxis.normalize()
  angle = Math.min(angle, MAX_TILT_RAD) * weight
  _tiltQuat.setFromAxisAngle(_tiltAxis, angle)
  // World-space delta rotation -> parent-local: newLocal = parentQuatInv * (tiltQuat * worldQuat)
  const parent = footBone.parent
  parent.updateMatrixWorld(true)
  _parentQuatInv.setFromRotationMatrix(_m0.extractRotation(parent.matrixWorld)).invert()
  _q0.copy(_footWorldQuat).premultiply(_tiltQuat)
  _q0.premultiply(_parentQuatInv)
  footBone.quaternion.copy(_q0)
}

// Central-difference tap distance for the terrain-normal estimate. Matches ROCK.SLOPE_D's role
// (src/terrain/RockPlacement.js) -- small enough to resolve foot-scale slope detail, big enough that
// the CPU fractal/patch height sampler's own noise floor doesn't dominate the derivative.
const NORMAL_TAP_D = 0.35
// Max the IK is allowed to raise/lower a foot from its animation-authored position. Beyond this the
// terrain is either a cliff edge or a sampling glitch -- clamp rather than let a leg overextend to a
// visually broken pose.
const MAX_FOOT_OFFSET = 0.5

function sampleGround(frame, floatingOrigin, renderX, renderY, renderZ) {
  _auth.set(renderX, renderY, renderZ)
  if (floatingOrigin) floatingOrigin.toAuthoritative(_auth, _auth)
  const x = _auth.x, z = _auth.z
  const h = frame.groundHeightLocal(x, z)
  if (!Number.isFinite(h)) return null
  const D = NORMAL_TAP_D
  const hx1 = frame.groundHeightLocal(x + D, z), hx0 = frame.groundHeightLocal(x - D, z)
  const hz1 = frame.groundHeightLocal(x, z + D), hz0 = frame.groundHeightLocal(x, z - D)
  if (!Number.isFinite(hx1) || !Number.isFinite(hx0) || !Number.isFinite(hz1) || !Number.isFinite(hz0)) return { height: h, nx: 0, ny: 1, nz: 0 }
  const dHdx = (hx1 - hx0) / (2 * D), dHdz = (hz1 - hz0) / (2 * D)
  let nx = -dHdx, ny = 1, nz = -dHdz
  const nl = Math.hypot(nx, ny, nz) || 1
  nx /= nl; ny /= nl; nz /= nl
  return { height: h, nx, ny, nz }
}

// Solves one leg's two-bone IK in place, writing local quaternions onto upperBone/lowerBone (foot
// orientation is left to the animation clip's own foot track -- only the leg's plant HEIGHT and
// hip/knee bend are IK-driven, which reads correctly for a game camera and avoids fighting whatever
// ankle-roll the clip already authored). Returns true if it actually adjusted the pose.
function solveLegIK(upperBone, lowerBone, hipWorldPos, targetWorldPos, forwardWorld, weight) {
  if (!upperBone || !lowerBone) return false
  _qUpperRest.copy(upperBone.quaternion)
  _qLowerRest.copy(lowerBone.quaternion)
  upperBone.updateMatrixWorld(true)
  const a = _v0.setFromMatrixPosition(upperBone.matrixWorld).distanceTo(_v1.setFromMatrixPosition(lowerBone.matrixWorld))
  lowerBone.updateMatrixWorld(true)
  let footBoneLen = 0
  if (lowerBone.children && lowerBone.children[0]) {
    footBoneLen = _v0.setFromMatrixPosition(lowerBone.matrixWorld).distanceTo(_v1.setFromMatrixPosition(lowerBone.children[0].matrixWorld))
  }
  const b = footBoneLen > 0.01 ? footBoneLen : a
  if (a < 1e-4 || b < 1e-4) return false

  const toTarget = _v0.copy(targetWorldPos).sub(hipWorldPos)
  let c = toTarget.length()
  const maxReach = (a + b) * 0.999
  if (c > maxReach) { c = maxReach; toTarget.setLength(c) }
  if (c < 1e-4) return false

  // Interior angle at the hip (between thigh direction and hip->target), law of cosines.
  const cosHip = THREE.MathUtils.clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1)
  const hipAngle = Math.acos(cosHip)
  // Interior angle at the knee (between thigh and shin), law of cosines.
  const cosKnee = THREE.MathUtils.clamp((a * a + b * b - c * c) / (2 * a * b), -1, 1)
  const kneeAngle = Math.acos(cosKnee)

  // Pole vector: project the character's forward direction to be perpendicular to the hip->target
  // axis, so the knee bend plane always faces forward regardless of hip->target direction.
  const aimDir = _v1.copy(toTarget).normalize()
  _poleDir.copy(forwardWorld)
  const fwdDot = _poleDir.dot(aimDir)
  _poleDir.addScaledVector(aimDir, -fwdDot)
  if (_poleDir.lengthSq() < 1e-6) _poleDir.set(0, 0, 1).addScaledVector(aimDir, -aimDir.z).normalize()
  else _poleDir.normalize()
  _bendAxis.crossVectors(aimDir, _poleDir).normalize()
  if (_bendAxis.lengthSq() < 1e-6) return false

  // Rotate aimDir by +hipAngle around bendAxis (toward the pole) to get the thigh direction.
  _q0.setFromAxisAngle(_bendAxis, hipAngle)
  _upperDir.copy(aimDir).applyQuaternion(_q0)

  // Apply thigh direction to the upper bone: rotate the bone's rest-pose down-axis onto _upperDir,
  // expressed in the bone's PARENT local space (bone.quaternion is parent-local).
  const parent = upperBone.parent
  parent.updateMatrixWorld(true)
  _parentQuatInv.setFromRotationMatrix(_m0.extractRotation(parent.matrixWorld)).invert()
  const localUpperDir = _v0.copy(_upperDir).applyQuaternion(_parentQuatInv).normalize()
  // Rest-pose bone direction in the bone's OWN local space is whatever axis currently points at its
  // child at identity local rotation -- approximate with the current parent-local direction to the
  // lower bone before any IK write this frame (captured once per call via hipWorldPos->targetWorldPos
  // is unnecessary here; use the bone's existing local offset direction, which three-vrm normalized
  // rigs keep purely along one axis).
  const restLocalDir = _v1.copy(lowerBone.position).normalize()
  if (restLocalDir.lengthSq() < 1e-6) return false
  _q1.setFromUnitVectors(restLocalDir, localUpperDir)
  _qUpperIK.copy(_q1)
  upperBone.quaternion.copy(_q1)
  upperBone.updateMatrixWorld(true)

  // Knee: the shin direction is aimDir rotated by -(PI - kneeAngle) around bendAxis from thigh dir
  // (interior knee angle -> exterior bend from straight-leg baseline).
  const kneeBend = Math.PI - kneeAngle
  _lowerDir.copy(_upperDir).applyQuaternion(_q0.setFromAxisAngle(_bendAxis, -kneeBend))
  const upperQuatInv = _q0.copy(upperBone.quaternion).invert()
  const localLowerDir = _v0.copy(_lowerDir).applyQuaternion(_parentQuatInv).applyQuaternion(upperQuatInv).normalize()
  const restLocalLowerDir = footBoneLen > 0.01 ? _v1.copy(lowerBone.children[0].position).normalize() : _v1.set(0, -1, 0)
  upperBone.quaternion.copy(_qUpperRest).slerp(_qUpperIK, weight)
  if (restLocalLowerDir.lengthSq() < 1e-6) {
    upperBone.updateMatrixWorld(true)
    return true
  }
  _q1.setFromUnitVectors(restLocalLowerDir, localLowerDir)
  lowerBone.quaternion.copy(_qLowerRest).slerp(_q1, weight)
  upperBone.updateMatrixWorld(true)
  lowerBone.updateMatrixWorld(true)
  return true
}

const PLANT_RELEASE_DIST = 0.03

export function applyFootIK(ctx, weight, dt) {
  if (weight <= 0.001) return
  const win = typeof window !== 'undefined' ? window : null
  const terrain = win && win.__terrain
  const frame = terrain && terrain.frame
  if (!frame || !frame.groundHeightLocal) return
  const { root, legL, legR, hipBone, bodyYaw } = ctx
  if (!legL && !legR) return
  const floatingOrigin = win.__floatingOrigin || null

  const sinY = Math.sin(bodyYaw || 0), cosY = Math.cos(bodyYaw || 0)
  const forwardWorld = _forwardWorld.set(-sinY, 0, -cosY)

  for (const leg of [legL, legR]) {
    if (!leg || !leg.upper || !leg.lower || !leg.foot) continue
    leg.foot.updateMatrixWorld(true)
    _footWorld.setFromMatrixPosition(leg.foot.matrixWorld)
    const prevX = leg.plantX, prevZ = leg.plantZ
    const moved = prevX === undefined ? Infinity : Math.hypot(_footWorld.x - prevX, _footWorld.z - prevZ)
    const planted = moved <= PLANT_RELEASE_DIST
    const sampleX = planted ? prevX : _footWorld.x
    const sampleZ = planted ? prevZ : _footWorld.z

    let targetY = leg.plantTargetY
    let nx = leg.plantNx, ny = leg.plantNy, nz = leg.plantNz
    if (!planted || targetY === undefined) {
      const ground = sampleGround(frame, floatingOrigin, sampleX, _footWorld.y, sampleZ)
      if (!ground) continue
      leg.plantX = sampleX; leg.plantZ = sampleZ
      _auth.copy(_footWorld)
      if (floatingOrigin) floatingOrigin.toAuthoritative(_auth, _auth)
      targetY = THREE.MathUtils.clamp(ground.height, _auth.y - MAX_FOOT_OFFSET, _auth.y + MAX_FOOT_OFFSET)
      leg.plantTargetY = targetY
      nx = leg.plantNx = ground.nx; ny = leg.plantNy = ground.ny; nz = leg.plantNz = ground.nz
    }

    _auth.copy(_footWorld)
    if (floatingOrigin) floatingOrigin.toAuthoritative(_auth, _auth)
    _auth.y = targetY
    if (floatingOrigin) floatingOrigin.toRender(_auth, _auth)

    leg.upper.updateMatrixWorld(true)
    _hipWorld.setFromMatrixPosition(leg.upper.matrixWorld)
    _footTarget.copy(_footWorld)
    _footTarget.y = _auth.y
    solveLegIK(leg.upper, leg.lower, _hipWorld, _footTarget, forwardWorld, weight)
    tiltFootToNormal(leg.foot, nx, ny, nz, weight)
  }
}

// Resolves the {upper,lower,foot} bone triples for both legs from a VRM humanoid, once at animator
// creation time (bones are stable for the lifetime of the character).
export function buildLegChains(getBone) {
  const legL = { upper: getBone('leftUpperLeg'), lower: getBone('leftLowerLeg'), foot: getBone('leftFoot') }
  const legR = { upper: getBone('rightUpperLeg'), lower: getBone('rightLowerLeg'), foot: getBone('rightFoot') }
  const validL = legL.upper && legL.lower && legL.foot
  const validR = legR.upper && legR.lower && legR.foot
  return { legL: validL ? legL : null, legR: validR ? legR : null }
}
