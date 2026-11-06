import { RAGDOLL_JOINTS } from './RagdollPose.js'

export class RagdollActivationError extends Error {
  constructor(reasonCode, detail) {
    super(`[ragdoll-activation] ${reasonCode}: ${detail}`)
    this.name = 'RagdollActivationError'
    this.reasonCode = reasonCode
  }
}

export function parseRagdollActivation(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new RagdollActivationError('spec-invalid', 'spec must be an object')
  const bones = spec.bones ?? {}
  if (bones === null || typeof bones !== 'object' || Array.isArray(bones)) throw new RagdollActivationError('bones-invalid', 'bones must be an object keyed by joint name')
  const all = spec.all === undefined ? 1 : spec.all
  if (typeof all !== 'number' || !Number.isFinite(all) || all < 0 || all > 1) throw new RagdollActivationError('strength-invalid', 'all must be a number in [0, 1]')
  const strengths = new Map(RAGDOLL_JOINTS.map(name => [name, all]))
  for (const [name, entry] of Object.entries(bones)) {
    if (!RAGDOLL_JOINTS.includes(name)) throw new RagdollActivationError('unknown-bone', `${name} is not a ragdoll joint`)
    const value = typeof entry === 'number' ? entry : entry?.strength
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new RagdollActivationError('strength-invalid', `${name} strength must be a number in [0, 1]`)
    strengths.set(name, value)
  }
  return Object.freeze({ strengths: Object.freeze(Object.fromEntries(strengths)), explicit: Object.freeze(Object.keys(bones)), active: spec.active !== false })
}

export function checkRagdollPlan(plan) {
  if (!plan || typeof plan !== 'object' || plan.strengths === null || typeof plan.strengths !== 'object' || !Array.isArray(plan.explicit)) return 'plan-invalid'
  for (const [name, value] of Object.entries(plan.strengths)) {
    if (!RAGDOLL_JOINTS.includes(name)) return 'unknown-bone'
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return 'strength-invalid'
  }
  return null
}

export function applyRagdollActivation(pose, plan) {
  const refusal = checkRagdollPlan(plan)
  if (refusal) throw new RagdollActivationError(refusal, 'plan must come from parseRagdollActivation')
  if (!plan.active) return pose.setAll(0)
  for (const [name, value] of Object.entries(plan.strengths)) {
    if (!plan.explicit.includes(name) && pose.byName && !pose.byName.has(name)) continue
    pose.setStrength(name, value)
  }
  return pose
}
