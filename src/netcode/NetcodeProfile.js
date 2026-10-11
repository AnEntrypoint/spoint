import { ROLLBACK_DEFAULTS } from './RollbackGameLoop.js'
import { LOCKSTEP_DEFAULTS } from './LockstepGameLoop.js'
import { PEER_SIMULATED_PROFILES } from './peerLoops.js'

const PROFILE_DEFAULTS = Object.freeze({
  authoritative: Object.freeze({}),
  rollback: ROLLBACK_DEFAULTS,
  lockstep: LOCKSTEP_DEFAULTS
})

export const NETCODE_PROFILES = Object.freeze([...Object.keys(PROFILE_DEFAULTS), ...[...PEER_SIMULATED_PROFILES].filter(n => !(n in PROFILE_DEFAULTS))])
export { PEER_SIMULATED_PROFILES }
export const DEFAULT_MIN_PEERS = 2

function positiveInt(v, name, profile) {
  if (!Number.isInteger(v) || v < 0) throw new Error(`[netcode] ${profile}.${name} must be a non-negative integer, got ${JSON.stringify(v)}`)
  return v
}

export function resolveNetcodeProfile(worldDef) {
  const cfg = worldDef?.netcode || {}
  const name = cfg.profile ?? 'authoritative'
  if (!NETCODE_PROFILES.includes(name)) throw new Error(`[netcode] unknown netcode.profile '${name}' (expected one of ${NETCODE_PROFILES.join(', ')})`)
  const defaults = PROFILE_DEFAULTS[name] || {}
  const options = { ...defaults, ...(cfg[name] || {}) }
  for (const k of Object.keys(defaults)) positiveInt(options[k], k, name)
  const minPeers = cfg.peers ?? DEFAULT_MIN_PEERS
  return { name, options, peerSimulated: PEER_SIMULATED_PROFILES.has(name), minPeers: positiveInt(minPeers, 'peers', 'netcode') }
}
