import * as THREE from 'three'

const _v0 = new THREE.Vector3()
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q0 = new THREE.Quaternion()

function worldDistance(from, to) {
  return from.getWorldPosition(new THREE.Vector3()).distanceTo(to.getWorldPosition(new THREE.Vector3()))
}

export class TwoBoneIKSolver {
  constructor(rootBone, middleBone, endBone, options = {}) {
    this.rootBone = rootBone
    this.middleBone = middleBone
    this.endBone = endBone

    this.target = new THREE.Vector3()
    this.poleVector = new THREE.Vector3(1, 0, 0)
    this.enabled = true
    this.weight = 1.0

    this.rootLength = rootBone && middleBone ? worldDistance(rootBone, middleBone) : 1
    this.middleLength = middleBone && endBone ? worldDistance(middleBone, endBone) : 1

    this.tolerance = options.tolerance || 0.001
    this.maxIterations = options.maxIterations || 5
    this.useWorldSpace = options.useWorldSpace !== false

    this._rootWorldPos = new THREE.Vector3()
    this._middleWorldPos = new THREE.Vector3()
    this._endWorldPos = new THREE.Vector3()
  }

  setTarget(position) {
    this.target.copy(position)
    return this
  }

  setPoleVector(vector) {
    this.poleVector.copy(vector).normalize()
    return this
  }

  solve() {
    if (!this.enabled) return this

    if (!this.rootBone || !this.middleBone || !this.endBone) return this

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

    return this
  }
}

export class FootIKSolver {
  constructor(footBone, raycastCallback, options = {}) {
    this.footBone = footBone
    this.raycastCallback = raycastCallback
    this.enabled = true
    this.weight = 1.0
    this.rayDistance = options.rayDistance || 10
    this.upDirection = new THREE.Vector3(0, 1, 0)
  }

  solve() {
    if (!this.enabled || !this.footBone || !this.raycastCallback) return this

    const footWorld = this.footBone.getWorldPosition(new THREE.Vector3())
    const rayOrigin = footWorld.clone()
    rayOrigin.y += this.rayDistance / 2

    const rayDirection = new THREE.Vector3(0, -1, 0)

    const hitPoint = this.raycastCallback(rayOrigin, rayDirection, this.rayDistance)

    if (hitPoint) {
      const worldHeightAdjustment = (hitPoint.y - footWorld.y) * this.weight
      const localHeightAdjustment = new THREE.Vector3(0, worldHeightAdjustment, 0)
      if (this.footBone.parent) {
        const parentWorldInverse = new THREE.Matrix4().copy(this.footBone.parent.matrixWorld).invert()
        localHeightAdjustment.applyMatrix3(new THREE.Matrix3().setFromMatrix4(parentWorldInverse))
      }
      this.footBone.position.add(localHeightAdjustment)
    }

    return this
  }
}

export class IKChain {
  constructor(name = '') {
    this.name = name
    this.solvers = []
    this.enabled = true
  }

  addSolver(solver) {
    this.solvers.push(solver)
    return this
  }

  solve() {
    if (!this.enabled) return this
    for (const solver of this.solvers) {
      if (solver && typeof solver.solve === 'function') {
        solver.solve()
      }
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
