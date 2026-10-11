import * as THREE from 'three'

function worldDistance(from, to) {
  return from.getWorldPosition(new THREE.Vector3()).distanceTo(to.getWorldPosition(new THREE.Vector3()))
}

const DEFAULT_TOLERANCE = 0.001
const DEFAULT_RAY_DISTANCE = 10
const TWO_BONE_SOLVER = 'TwoBoneIKSolver'
const FOOT_SOLVER = 'FootIKSolver'

function describe(value) {
  if (value === null) return 'null'
  return typeof value === 'number' ? String(value) : typeof value
}

function finiteVectorOf(value, name, solver) {
  if (!value || typeof value !== 'object'
    || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) {
    throw new Error(`[${solver}] ${name} needs finite x, y and z; got ${describe(value)}`)
  }
  return new THREE.Vector3(value.x, value.y, value.z)
}

function positiveOptionOf(value, fallback, name, solver) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`[${solver}] ${name} needs a finite number greater than 0; got ${describe(value)}`)
  }
  return value
}

function booleanOptionOf(value, fallback, name, solver) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(`[${solver}] ${name} needs a boolean; got ${describe(value)}`)
  }
  return value
}

export class TwoBoneIKSolver {
  constructor(rootBone, middleBone, endBone, options = {}) {
    if (!rootBone || !middleBone || !endBone) {
      throw new Error('[TwoBoneIKSolver] needs a root, middle and end bone; got '
        + `root=${rootBone === null ? 'null' : typeof rootBone}, `
        + `middle=${middleBone === null ? 'null' : typeof middleBone}, `
        + `end=${endBone === null ? 'null' : typeof endBone}`)
    }

    this.rootBone = rootBone
    this.middleBone = middleBone
    this.endBone = endBone

    this.target = new THREE.Vector3()
    this.poleVector = new THREE.Vector3(1, 0, 0)
    this.enabled = true
    this.weight = 1.0

    this.rootLength = 0
    this.middleLength = 0

    this.tolerance = positiveOptionOf(options.tolerance, DEFAULT_TOLERANCE, 'options.tolerance', TWO_BONE_SOLVER)
    this.useWorldSpace = booleanOptionOf(options.useWorldSpace, true, 'options.useWorldSpace', TWO_BONE_SOLVER)
    this.solved = false

    this._rootWorldPos = new THREE.Vector3()
    this._middleWorldPos = new THREE.Vector3()
    this._endWorldPos = new THREE.Vector3()

    this.measureBoneLengths()
  }

  measureBoneLengths() {
    this.rootLength = worldDistance(this.rootBone, this.middleBone)
    this.middleLength = worldDistance(this.middleBone, this.endBone)
    return this
  }

  setTarget(position) {
    this.target.copy(finiteVectorOf(position, 'setTarget', TWO_BONE_SOLVER))
    return this
  }

  setPoleVector(vector) {
    const direction = finiteVectorOf(vector, 'setPoleVector', TWO_BONE_SOLVER)
    if (direction.lengthSq() === 0) {
      throw new Error(`[${TWO_BONE_SOLVER}] setPoleVector needs a direction of non-zero length; got zero`)
    }
    this.poleVector.copy(direction).normalize()
    return this
  }

  solve() {
    this.solved = false
    if (!this.enabled) return this

    const root = this.rootBone
    const middle = this.middleBone
    const end = this.endBone

    if (!root.parent) return this

    root.getWorldPosition(this._rootWorldPos)
    middle.getWorldPosition(this._middleWorldPos)
    end.getWorldPosition(this._endWorldPos)

    const rootWorld = this._rootWorldPos
    const middleWorld = this._middleWorldPos
    const endWorld = this._endWorldPos
    const a = this.rootLength
    const b = this.middleLength
    const reach = a + b

    const goal = this.target.clone()
    if (!this.useWorldSpace) {
      root.parent.updateWorldMatrix(true, false)
      goal.applyMatrix4(root.parent.matrixWorld)
    }

    const rootToGoal = goal.sub(rootWorld)
    if (rootToGoal.length() > reach) rootToGoal.normalize().multiplyScalar(reach)
    const d = rootToGoal.length()

    if (d < this.tolerance || a <= 0 || b <= 0) return this

    const rootDir = rootToGoal.clone().divideScalar(d)
    const cosAtRoot = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)))
    const sinAtRoot = Math.sqrt(1 - cosAtRoot * cosAtRoot)

    const parentQuat = root.parent.getWorldQuaternion(new THREE.Quaternion())
    const bend = this.poleVector.clone().applyQuaternion(parentQuat)
    bend.addScaledVector(rootDir, -bend.dot(rootDir))
    if (bend.lengthSq() < 1e-12) {
      const reference = Math.abs(rootDir.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
      bend.crossVectors(rootDir, reference)
    }
    bend.normalize()

    const middleGoal = rootWorld.clone()
      .addScaledVector(rootDir, a * cosAtRoot)
      .addScaledVector(bend, a * sinAtRoot)
    const endGoal = rootWorld.clone().add(rootToGoal)

    const rootQuat = root.getWorldQuaternion(new THREE.Quaternion())
    const middleQuat = middle.getWorldQuaternion(new THREE.Quaternion())

    const rootSwing = new THREE.Quaternion().setFromUnitVectors(
      middleWorld.clone().sub(rootWorld).normalize(),
      middleGoal.clone().sub(rootWorld).normalize()
    )
    const middleAfterRoot = middleWorld.clone().sub(rootWorld).applyQuaternion(rootSwing).add(rootWorld)
    const endAfterRoot = endWorld.clone().sub(rootWorld).applyQuaternion(rootSwing).add(rootWorld)

    const middleSwing = new THREE.Quaternion().setFromUnitVectors(
      endAfterRoot.clone().sub(middleAfterRoot).normalize(),
      endGoal.clone().sub(middleGoal).normalize()
    )

    const rootWorldTarget = rootSwing.clone().multiply(rootQuat)
    const middleWorldTarget = middleSwing.clone().multiply(rootSwing).multiply(middleQuat)

    root.quaternion.slerp(parentQuat.clone().invert().multiply(rootWorldTarget), this.weight)
    const rootWorldNow = parentQuat.clone().multiply(root.quaternion)
    middle.quaternion.slerp(rootWorldNow.clone().invert().multiply(middleWorldTarget), this.weight)

    this.solved = true
    return this
  }
}

export class FootIKSolver {
  constructor(footBone, raycastCallback, options = {}) {
    if (!footBone || typeof footBone.getWorldPosition !== 'function') {
      throw new Error(`[${FOOT_SOLVER}] needs a foot bone with getWorldPosition(); got ${describe(footBone)}`)
    }
    if (typeof raycastCallback !== 'function') {
      throw new Error(`[${FOOT_SOLVER}] needs a raycast callback function; got ${describe(raycastCallback)}`)
    }
    this.footBone = footBone
    this.raycastCallback = raycastCallback
    this.enabled = true
    this.weight = 1.0
    this.rayDistance = positiveOptionOf(options.rayDistance, DEFAULT_RAY_DISTANCE, 'options.rayDistance', FOOT_SOLVER)
    this.solved = false
  }

  solve() {
    this.solved = false
    if (!this.enabled) return this

    const footWorld = this.footBone.getWorldPosition(new THREE.Vector3())
    const rayOrigin = footWorld.clone()
    rayOrigin.y += this.rayDistance / 2

    const rayDirection = new THREE.Vector3(0, -1, 0)

    const hitPoint = this.raycastCallback(rayOrigin, rayDirection, this.rayDistance)

    if (!hitPoint || !Number.isFinite(hitPoint.y)) return this

    const worldHeightAdjustment = (hitPoint.y - footWorld.y) * this.weight
    const localHeightAdjustment = new THREE.Vector3(0, worldHeightAdjustment, 0)
    if (this.footBone.parent) {
      const parentWorldInverse = new THREE.Matrix4().copy(this.footBone.parent.matrixWorld).invert()
      localHeightAdjustment.applyMatrix3(new THREE.Matrix3().setFromMatrix4(parentWorldInverse))
    }
    this.footBone.position.add(localHeightAdjustment)

    this.solved = true
    return this
  }
}

export class IKChain {
  constructor(name = '') {
    this.name = name
    this.solvers = []
    this.refusals = []
    this.enabled = true
  }

  addSolver(solver) {
    if (!solver || typeof solver.solve !== 'function') {
      this.refusals.push(solver)
      return this
    }
    this.solvers.push(solver)
    return this
  }

  solve() {
    if (!this.enabled) return this
    for (const solver of this.solvers) {
      solver.solve()
    }
    return this
  }

  enable() {
    this.enabled = true
    return this
  }

  disable() {
    this.enabled = false
    return this
  }
}

export class IKRig {
  constructor(skeleton) {
    this.skeleton = skeleton
    this.chains = new Map()
    this.enabled = true
  }

  createChain(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`[IKRig] createChain needs a non-empty chain name; got ${describe(name)}`)
    }
    if (this.chains.has(name)) {
      throw new Error(`[IKRig] createChain cannot replace the chain already named "${name}"`)
    }
    const chain = new IKChain(name)
    this.chains.set(name, chain)
    return chain
  }

  getChain(name) {
    return this.chains.get(name)
  }

  update() {
    if (!this.enabled) return
    for (const chain of this.chains.values()) {
      chain.solve()
    }
  }

  enable() {
    this.enabled = true
    return this
  }

  disable() {
    this.enabled = false
    return this
  }
}

export default { TwoBoneIKSolver, FootIKSolver, IKChain, IKRig }
