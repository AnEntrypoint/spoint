import { ROLLBACK_DEFAULTS } from './RollbackGameLoop.js'
import { LOCKSTEP_DEFAULTS } from './LockstepGameLoop.js'

const PROFILE_DEFAULTS = Object.freeze({
  authoritative: Object.freeze({}),
  rollback: ROLLBACK_DEFAULTS,
  lockstep: LOCKSTEP_DEFAULTS
})

export const NETCODE_PROFILES = Object.freeze(Object.keys(PROFILE_DEFAULTS))
export const PEER_SIMULATED_PROFILES = new Set(['rollback', 'lockstep'])
export const DEFAULT_MIN_PEERS = 2

function positiveInt(v, name, profile) {
  if (!Number.isInteger(v) || v < 0) throw new Error(`[netcode] ${profile}.${name} must be a non-negative integer, got ${JSON.stringify(v)}`)
  return v
}

export function resolveNetcodeProfile(worldDef) {
  const cfg = worldDef?.netcode || {}
  const name = cfg.profile ?? 'authoritative'
  if (!NETCODE_PROFILES.includes(name)) throw new Error(`[netcode] unknown netcode.profile '${name}' (expected one of ${NETCODE_PROFILES.join(', ')})`)
  const options = { ...PROFILE_DEFAULTS[name], ...(cfg[name] || {}) }
  for (const k of Object.keys(PROFILE_DEFAULTS[name])) positiveInt(options[k], k, name)
  const minPeers = cfg.peers ?? DEFAULT_MIN_PEERS
  return { name, options, peerSimulated: PEER_SIMULATED_PROFILES.has(name), minPeers: positiveInt(minPeers, 'peers', 'netcode') }
}
