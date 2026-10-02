import { defineHealth } from '../behaviours/health.js'
import { defineCombat } from '../behaviours/combat.js'
import { defineCheckpoint } from '../behaviours/checkpoint.js'
import { definePickup } from '../behaviours/pickup.js'
import { defineSteering } from '../behaviours/steering.js'
import { defineTeams } from '../behaviours/teams.js'
import { createBuffStack } from '../behaviours/buffs.js'

export const BEHAVIOUR_FACTORIES = Object.freeze({
  health: defineHealth,
  combat: defineCombat,
  checkpoint: defineCheckpoint,
  pickup: definePickup,
  steering: defineSteering,
  teams: defineTeams,
  buffs: createBuffStack
})

export const BEHAVIOUR_NAMES = Object.freeze(Object.keys(BEHAVIOUR_FACTORIES))

export function validateBehaviourSpec(spec, where) {
  if (spec === undefined || spec === null) return null
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError(`${where} must be an object mapping behaviour names to their spec`)
  for (const name of Object.keys(spec)) {
    if (!Object.hasOwn(BEHAVIOUR_FACTORIES, name)) throw new TypeError(`${where} names unknown behaviour "${name}" (known: ${BEHAVIOUR_NAMES.join(', ')})`)
  }
  return spec
}
