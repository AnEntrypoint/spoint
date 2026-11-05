import * as THREE from '/node_modules/three/build/three.module.js'

const GRAVITY_MS2 = 9.81
const SPRING_RATE_PER_S2 = 40
const MAX_STEP_S = 1 / 30
const RETAIN_AT_BOUNCE_0 = 0.85
const RETAIN_AT_BOUNCE_1 = 0.995
const DEG = Math.PI / 180

const IDENTITY = new THREE.Quaternion()

function fractionOf(value, fallback, name) {
  const v = value === undefined ? fallback : value
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`[SpringBones] ${name} needs a number from 0 to 1; got ${String(v)}`)
  }
  return v
}

function limitOf(value) {
  if (value === undefined) return 180
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 180) {
    throw new Error(`[SpringBones] limit needs degrees from over 0 to 180; got ${String(value)}`)
  }
  return value
}

export class SpringBoneChain {
  constructor(bones, options = {}) {
    if (!Array.isArray(bones) || bones.length < 2 || bones.some((b) => !b || !b.isObject3D)) {
      throw new Error('[SpringBones] a chain needs at least two bones, each an Object3D')
    }
    this.bones = bones
    this.amount = fractionOf(options.amount, 0.5, 'amount')
    this.bounce = fractionOf(options.bounce, 0.5, 'bounce')
    this.gravity = fractionOf(options.gravity, 0, 'gravity')
    this.windForce = options.wind?.force ?? 0
    if (typeof this.windForce !== 'number' || !Number.isFinite(this.windForce) || this.windForce < 0) {
      throw new Error(`[SpringBones] wind.force needs a finite number of at least 0; got ${String(this.windForce)}`)
    }
    this.limitRad = limitOf(options.limit) * DEG
    this.colliders = (options.colliders ?? []).map((c) => this._colliderOf(c))

    bones[0].updateWorldMatrix(true, true)
    this.parentQuat = bones[0].parent ? bones[0].parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion()
    this.points = bones.map((b) => b.getWorldPosition(new THREE.Vector3()))
    this.prev = this.points.map((p) => p.clone())
    this.restQuat = bones.map((b) => b.getWorldQuaternion(new THREE.Quaternion()))
    this.lengths = []
    this.restDirs = []
    for (let k = 0; k < bones.length - 1; k += 1) {
      const dir = this.points[k + 1].clone().sub(this.points[k])
      const length = dir.length()
      if (!(length > 0)) throw new Error(`[SpringBones] bone ${bones[k].name || k} sits on bone ${bones[k + 1].name || k + 1}`)
      this.lengths.push(length)
      this.restDirs.push(dir.divideScalar(length))
    }
    this.rest = this.restDirs.map((d) => d.clone())
  }

  _colliderOf(spec) {
    const index = this.bones.indexOf(spec.bone)
    if (index < 0) throw new Error('[SpringBones] a collider bone must be one of the chain bones')
    if (typeof spec.radius !== 'number' || !Number.isFinite(spec.radius) || spec.radius <= 0) {
      throw new Error(`[SpringBones] collider radius needs a number greater than 0; got ${String(spec.radius)}`)
    }
    const offset = spec.offset ? new THREE.Vector3(...spec.offset) : new THREE.Vector3()
    return { index, offset, radius: spec.radius }
  }

  update(dt, windDir = null) {
    if (!(dt > 0)) return
    const step = Math.min(dt, MAX_STEP_S)
    const step2 = step * step
    const last = this.bones.length - 1
    const retain = RETAIN_AT_BOUNCE_0 + (RETAIN_AT_BOUNCE_1 - RETAIN_AT_BOUNCE_0) * this.bounce
    const pull = Math.min(1, this.amount * SPRING_RATE_PER_S2 * step2)
    const accel = new THREE.Vector3(0, -GRAVITY_MS2 * this.gravity, 0)
    if (windDir) accel.addScaledVector(windDir, this.windForce)

    this.bones[0].getWorldPosition(this.points[0])
    this.prev[0].copy(this.points[0])

    for (let k = 1; k <= last; k += 1) {
      const p = this.points[k]
      const velocity = p.clone().sub(this.prev[k]).multiplyScalar(retain)
      this.prev[k].copy(p)
      p.add(velocity).addScaledVector(accel, step2)
      const target = this.points[k - 1].clone().addScaledVector(this.rest[k - 1], this.lengths[k - 1])
      p.lerp(target, pull)
    }

    for (const c of this.colliders) {
      const center = this.points[c.index].clone().add(c.offset)
      for (let k = 1; k <= last; k += 1) {
        if (k === c.index) continue
        const d = this.points[k].clone().sub(center)
        const dist = d.length()
        if (dist > 0 && dist < c.radius) this.points[k].copy(center.addScaledVector(d, c.radius / dist))
      }
    }

    let total = new THREE.Quaternion()
    let parentWorld = this.parentQuat
    for (let k = 0; k < last; k += 1) {
      const rest = this.restDirs[k].clone().applyQuaternion(total)
      this.rest[k].copy(rest)
      const dir = this.points[k + 1].clone().sub(this.points[k])
      if (dir.lengthSq() > 0) dir.normalize()
      else dir.copy(rest)
      const bend = rest.angleTo(dir)
      if (bend > this.limitRad) {
        const clamp = new THREE.Quaternion().setFromUnitVectors(rest, dir).slerp(IDENTITY, 1 - this.limitRad / bend)
        dir.copy(rest).applyQuaternion(clamp)
      }
      this.points[k + 1].copy(this.points[k]).addScaledVector(dir, this.lengths[k])
      total = new THREE.Quaternion().setFromUnitVectors(rest, dir).multiply(total)
      const world = total.clone().multiply(this.restQuat[k])
      this.bones[k].quaternion.copy(parentWorld.clone().invert().multiply(world))
      parentWorld = world
    }
  }
}

export function springBonesOf(root, spec) {
  if (!spec) return []
  const list = Array.isArray(spec) ? spec : [spec]
  return list.map((item) => {
    if (!item || !Array.isArray(item.bones)) throw new Error('[SpringBones] a jiggle spec needs a bones list of names')
    const bones = item.bones.map((name) => {
      const bone = root.getObjectByName(name)
      if (!bone) throw new Error(`[SpringBones] no bone named ${name}`)
      return bone
    })
    const colliders = (item.colliders ?? []).map((c) => {
      const bone = root.getObjectByName(c.bone)
      if (!bone) throw new Error(`[SpringBones] no collider bone named ${c.bone}`)
      return { ...c, bone }
    })
    return new SpringBoneChain(bones, { ...item, colliders })
  })
}
