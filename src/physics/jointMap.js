import { readVec3, readQuat } from '../shared/quat.js'

function refusal(code, message) {
  const err = new TypeError(`[joint-map] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export const JOINT_TYPES = Object.freeze(['point', 'spherical', 'swingTwist', 'hinge', 'fixed'])

export function createJointMap({ setConstraint = null, removeConstraint = null } = {}) {
  if (setConstraint !== null && typeof setConstraint !== 'function') throw refusal('joint-hook-invalid', 'setConstraint must be a function or null')
  if (removeConstraint !== null && typeof removeConstraint !== 'function') throw refusal('joint-hook-invalid', 'removeConstraint must be a function or null')
  const joints = new Map()
  const read = (id, spec) => {
    if (typeof id !== 'string' || !id) throw refusal('joint-id-invalid', 'id must be a non-empty string')
    if (!spec || typeof spec !== 'object') throw refusal('joint-spec-invalid', 'spec must be an object')
    if (typeof spec.to !== 'string' || !spec.to) throw refusal('joint-target-invalid', 'joint needs a non-empty to id')
    if (!JOINT_TYPES.includes(spec.type ?? 'point')) throw refusal('joint-type-invalid', `type must be one of ${JOINT_TYPES.join(', ')}`)
    readVec3(spec.anchor ?? [0, 0, 0], 'anchor')
    readVec3(spec.targetAnchor ?? [0, 0, 0], 'targetAnchor')
    readVec3(spec.axis ?? [0, 1, 0], 'axis')
    if (spec.target !== undefined) readQuat(spec.target, 'target')
    if (spec.strength !== undefined && (!Number.isFinite(spec.strength) || spec.strength < 0)) throw refusal('joint-strength-invalid', 'strength must be a non-negative finite number')
    return Object.freeze({
      id, to: spec.to, type: spec.type ?? 'point',
      anchor: (spec.anchor ?? [0, 0, 0]).slice(), targetAnchor: (spec.targetAnchor ?? [0, 0, 0]).slice(),
      axis: (spec.axis ?? [0, 1, 0]).slice(), target: spec.target === undefined ? null : spec.target.slice(),
      strength: spec.strength ?? 1, limits: spec.limits ?? {},
    })
  }
  return {
    set(id, spec) {
      const joint = read(id, spec)
      const firstPose = joints.get(id)?.target ?? joint.target
      const stored = joints.get(id) ? { ...joint, target: firstPose } : joint
      joints.set(id, stored)
      if (setConstraint) setConstraint(id, stored)
      return stored
    },
    retuneLimits(id, limits) {
      const joint = joints.get(id)
      if (!joint) throw refusal('joint-unknown', `no joint named ${id}`)
      if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw refusal('joint-limits-invalid', 'limits must be an object')
      const stored = { ...joint, limits: { ...limits } }
      joints.set(id, stored)
      return stored
    },
    get: (id) => joints.get(id) ?? null,
    remove(id) {
      if (!joints.delete(id)) throw refusal('joint-unknown', `no joint named ${id}`)
      if (removeConstraint) removeConstraint(id)
      return { ok: true, id }
    },
    ids: () => [...joints.keys()],
  }
}
