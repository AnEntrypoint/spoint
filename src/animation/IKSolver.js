import * as THREE from 'three'

const _v0 = new THREE.Vector3()
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q0 = new THREE.Quaternion()

export class TwoBoneIKSolver {
  constructor(rootBone, middleBone, endBone, options = {}) {
    this.rootBone = rootBone
    this.middleBone = middleBone
    this.endBone = endBone

    this.target = new THREE.Vector3()
    this.poleVector = new THREE.Vector3(1, 0, 0)
    this.enabled = true
    this.weight = 1.0

    this.rootLength = rootBone ? rootBone.position.distanceTo(middleBone.position) : 1
    this.middleLength = middleBone ? middleBone.position.distanceTo(endBone.position) : 1

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

    root.updateWorldMatrix(true, false)
    middle.updateWorldMatrix(true, false)
    end.updateWorldMatrix(true, false)

    root.getWorldPosition(this._rootWorldPos)
    middle.getWorldPosition(this._middleWorldPos)
    end.getWorldPosition(this._endWorldPos)

    const target = this.target.clone()
    if (!this.useWorldSpace) {
      if (root.parent) {
        root.parent.updateWorldMatrix(true, false)
        root.parent.getWorldPosition(_v0)
        target.sub(_v0)
      }
    }

    const rootToEnd = _v0.subVectors(target, this._rootWorldPos)
    const distance = rootToEnd.length()

    if (distance > this.rootLength + this.middleLength) {
      const direction = rootToEnd.normalize()
      target.copy(this._rootWorldPos).addScaledVector(direction, this.rootLength + this.middleLength)
    }

    const rootToTarget = target.clone().sub(this._rootWorldPos)
    const d = rootToTarget.length()

    if (d < this.tolerance) return this

    const a = this.rootLength
    const b = this.middleLength
    const c = Math.min(d, a + b)

    const cosAngleAtRoot = (a * a + c * c - b * b) / (2 * a * c)
    const angleAtRoot = Math.acos(Math.max(-1, Math.min(1, cosAngleAtRoot)))

    const cosAngleAtMiddle = (a * a + b * b - c * c) / (2 * a * b)
    const angleAtMiddle = Math.acos(Math.max(-1, Math.min(1, cosAngleAtMiddle)))

    const rootDir = rootToTarget.clone().normalize()

    const poleDir = this.poleVector.clone()
    if (root.parent) {
      root.parent.updateWorldMatrix(true, false)
      const parentQuat = new THREE.Quaternion()
      root.parent.getWorldQuaternion(parentQuat)
      poleDir.applyQuaternion(parentQuat)
    }

    const rightVector = new THREE.Vector3().crossVectors(rootDir, poleDir).normalize()
    const upVector = new THREE.Vector3().crossVectors(rightVector, rootDir).normalize()

    const middleWorldDir = new THREE.Vector3()
      .copy(upVector)
      .multiplyScalar(Math.cos(angleAtRoot))
      .addScaledVector(rootDir, Math.sin(angleAtRoot))

    const endTargetWorldPos = new THREE.Vector3()
      .copy(this._middleWorldPos)
      .addScaledVector(middleWorldDir, b)

    if (root.parent) {
      const parentInverse = new THREE.Matrix4()
      root.parent.updateWorldMatrix(true, false)
      parentInverse.copy(root.parent.matrixWorld).invert()

      this._rootWorldPos.applyMatrix4(parentInverse)
      const middleLocalTarget = target.clone().applyMatrix4(parentInverse)
      this._middleWorldPos.applyMatrix4(parentInverse)
      endTargetWorldPos.applyMatrix4(parentInverse)

      const rootToMiddle = middleLocalTarget.clone().sub(this._rootWorldPos)
      const rootQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        rootToMiddle.normalize()
      )
      root.quaternion.slerpQuaternions(root.quaternion, rootQuat, this.weight)

      const middleToEnd = endTargetWorldPos.clone().sub(this._middleWorldPos)
      const middleQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        middleToEnd.normalize()
      )
      middle.quaternion.slerpQuaternions(middle.quaternion, middleQuat, this.weight)
    }

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

    const rayOrigin = this.footBone.getWorldPosition(new THREE.Vector3())
    rayOrigin.y += this.rayDistance / 2

    const rayDirection = new THREE.Vector3(0, -1, 0)

    const hitPoint = this.raycastCallback(rayOrigin, rayDirection, this.rayDistance)

    if (hitPoint) {
      const targetHeight = hitPoint.y
      const currentHeight = this.footBone.position.y

      const heightAdjustment = targetHeight - currentHeight
      this.footBone.position.y += heightAdjustment * this.weight
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
