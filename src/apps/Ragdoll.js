export class RagdollSpecError extends Error {
  constructor(reasonCode, field) {
    super(`[ragdoll] ${reasonCode}: ${field}`)
    this.name = 'RagdollSpecError'
    this.reasonCode = reasonCode
    this.field = field
  }
}

const DEG = Math.PI / 180
const DEFAULT_LIMITS = Object.freeze({ cone: 60 * DEG, twist: Object.freeze([-45 * DEG, 45 * DEG]) })

function vec(value, length, field) {
  if (!Array.isArray(value) || value.length !== length || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new RagdollSpecError('vector-invalid', field)
  }
  return value.slice()
}

function limitsOf(limits, field) {
  if (limits === undefined) return DEFAULT_LIMITS
  if (limits === null || typeof limits !== 'object') throw new RagdollSpecError('limits-invalid', field)
  const cone = limits.cone ?? DEFAULT_LIMITS.cone
  if (typeof cone !== 'number' || !Number.isFinite(cone) || cone < 0 || cone > Math.PI) throw new RagdollSpecError('cone-out-of-range', field)
  const twist = limits.twist ?? DEFAULT_LIMITS.twist
  if (!Array.isArray(twist) || twist.length !== 2 || twist[0] > twist[1]) throw new RagdollSpecError('twist-invalid', field)
  return { cone, twist: [twist[0], twist[1]] }
}

export function buildRagdollPlan(spec) {
  if (!spec || typeof spec !== 'object') throw new RagdollSpecError('spec-missing', 'spec')
  if (!Array.isArray(spec.bones) || spec.bones.length === 0) throw new RagdollSpecError('bones-missing', 'bones')
  const byName = new Map()
  const bones = spec.bones.map((b, i) => {
    if (!b || typeof b.name !== 'string' || b.name.length === 0) throw new RagdollSpecError('bone-name', `bones[${i}].name`)
    if (byName.has(b.name)) throw new RagdollSpecError('bone-duplicate', `bones[${i}].name`)
    const bone = {
      name: b.name,
      parent: b.parent ?? null,
      position: vec(b.position, 3, `bones[${i}].position`),
      rotation: b.rotation === undefined ? [0, 0, 0, 1] : vec(b.rotation, 4, `bones[${i}].rotation`),
      halfExtents: vec(b.halfExtents, 3, `bones[${i}].halfExtents`),
      limits: limitsOf(b.limits, `bones[${i}].limits`),
    }
    byName.set(bone.name, bone)
    return bone
  })
  const roots = bones.filter(b => b.parent === null)
  if (roots.length !== 1) throw new RagdollSpecError('root-count', 'bones')
  for (const b of bones) {
    if (b.parent !== null && !byName.has(b.parent)) throw new RagdollSpecError('parent-unknown', `bone ${b.name}`)
  }
  const joints = bones.filter(b => b.parent !== null).map(b => ({ child: b.name, parent: b.parent, anchor: b.position, limits: b.limits }))
  if (joints.length !== bones.length - 1) throw new RagdollSpecError('joint-count', 'bones')
  return { bones, joints, rootKinematic: spec.rootKinematic === true }
}

export function mixinRagdoll(runtime) {
  runtime.activateRagdoll = function(entityId, spec) {
    const e = this.entities.get(entityId)
    if (!e || !this._physics) return null
    if (e._ragdoll) throw new RagdollSpecError('already-active', `entity ${entityId}`)
    const plan = buildRagdollPlan(spec)
    const bodyIds = new Map()
    const constraintIds = []
    for (const bone of plan.bones) {
      const motion = bone.parent === null && plan.rootKinematic ? 'kinematic' : 'dynamic'
      const id = this._physics.addBody('box', bone.halfExtents, bone.position, motion, { rotation: bone.rotation })
      if (id === undefined || id === null) throw new RagdollSpecError('body-create', `bone ${bone.name}`)
      bodyIds.set(bone.name, id)
    }
    for (const joint of plan.joints) {
      const cid = this._physics.addConstraint(bodyIds.get(joint.parent), bodyIds.get(joint.child), {
        type: 'swingTwist',
        anchorA: joint.anchor,
        anchorB: joint.anchor,
        axis: [0, 1, 0],
        limits: joint.limits,
      })
      if (cid === null) throw new RagdollSpecError('constraint-create', `joint ${joint.parent}->${joint.child}`)
      constraintIds.push(cid)
    }
    e._ragdoll = { bodyIds, constraintIds }
    return e._ragdoll
  }

  runtime.deactivateRagdoll = function(entityId) {
    const e = this.entities.get(entityId)
    if (!e?._ragdoll || !this._physics) return false
    const { bodyIds, constraintIds } = e._ragdoll
    for (const cid of constraintIds) this._physics.removeConstraint(cid)
    for (const id of bodyIds.values()) this._physics.removeBody(id)
    e._ragdoll = null
    return true
  }

  runtime.ragdollBodyIds = function(entityId) {
    const e = this.entities.get(entityId)
    return e?._ragdoll ? new Map(e._ragdoll.bodyIds) : null
  }
}
