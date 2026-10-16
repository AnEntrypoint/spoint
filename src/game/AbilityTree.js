export const DEFAULT_ABILITIES = [
  {
    id: 1,
    name: 'Fireball',
    description: 'Launch a fireball in the direction you are looking',
    manaCost: 20,
    cooldown: 2.0,
    unlockLevel: 1,
    damage: 25
  },
  {
    id: 2,
    name: 'Frost Nova',
    description: 'Freeze enemies around you in place',
    manaCost: 30,
    cooldown: 5.0,
    unlockLevel: 5,
    damage: 15
  },
  {
    id: 3,
    name: 'Lightning Strike',
    description: 'Call down lightning at target location',
    manaCost: 40,
    cooldown: 4.0,
    unlockLevel: 10,
    damage: 40
  },
  {
    id: 4,
    name: 'Teleport',
    description: 'Instantly move to target location',
    manaCost: 35,
    cooldown: 8.0,
    unlockLevel: 15,
    damage: 0
  },
  {
    id: 5,
    name: 'Meteor Shower',
    description: 'Rain meteors on an area',
    manaCost: 50,
    cooldown: 10.0,
    unlockLevel: 25,
    damage: 60
  }
]

export const HOTKEY_MAP = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: null,
  7: null,
  8: null,
  9: null
}

export const DEFINITION_REFUSAL = {
  DEFS_NOT_AN_ARRAY: 'definitions-not-an-array',
  NOT_AN_OBJECT: 'not-an-object',
  ID_MISSING: 'id-missing',
  ID_NOT_A_POSITIVE_INTEGER: 'id-not-a-positive-integer',
  DUPLICATE_ID: 'duplicate-id'
}

export function definitionRefusal(def, knownIds = null) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return DEFINITION_REFUSAL.NOT_AN_OBJECT
  if (def.id === null || def.id === undefined) return DEFINITION_REFUSAL.ID_MISSING
  if (!Number.isInteger(def.id) || def.id <= 0) return DEFINITION_REFUSAL.ID_NOT_A_POSITIVE_INTEGER
  if (knownIds !== null && knownIds.has(def.id)) return DEFINITION_REFUSAL.DUPLICATE_ID
  return null
}

export function createAbilityTree(abilityDefs = DEFAULT_ABILITIES, hotkeyMap = HOTKEY_MAP) {
  const abilities = new Map()
  const playerAbilityStates = new Map()
  const definitionRefusals = []

  const _parseCooldown = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0.1, value) : 1.0

  if (!Array.isArray(abilityDefs)) {
    definitionRefusals.push({ index: null, field: 'definitions', reason: DEFINITION_REFUSAL.DEFS_NOT_AN_ARRAY })
  } else {
    for (const [index, def] of abilityDefs.entries()) {
      const refusal = definitionRefusal(def, abilities)
      if (refusal !== null) {
        definitionRefusals.push({ index, field: `definitions[${index}]`, reason: refusal })
        continue
      }
      abilities.set(def.id, {
        id: def.id,
        name: def.name || '',
        description: def.description || '',
        manaCost: def.manaCost || 0,
        cooldown: _parseCooldown(def.cooldown),
        unlockLevel: def.unlockLevel || 1,
        damage: def.damage || 0
      })
    }
  }

  function getPlayerAbilityState(playerId) {
    if (!playerAbilityStates.has(playerId)) {
      playerAbilityStates.set(playerId, {
        playerId,
        cooldowns: new Map(),
        activeAbilities: new Set()
      })
    }
    return playerAbilityStates.get(playerId)
  }

  function getUnlockedAbilities(playerLevel) {
    const unlocked = []
    for (const ability of abilities.values()) {
      if (ability.unlockLevel <= playerLevel) {
        unlocked.push(ability)
      }
    }
    return unlocked
  }

  const HOTKEY_SLOT_MIN = 1
  const HOTKEY_SLOT_MAX = 9

  const CAST_REFUSAL = {
    UNKNOWN_ABILITY: 'unknown-ability',
    LEVEL_UNPARSED: 'level-unparsed',
    LOCKED: 'locked',
    COOLING: 'cooling'
  }

  const BIND_REFUSAL = {
    SLOT_OUT_OF_RANGE: 'slot-out-of-range',
    UNKNOWN_ABILITY: 'unknown-ability'
  }

  function castRefusal(playerId, abilityId, playerLevel) {
    const ability = abilities.get(abilityId)
    if (!ability) return CAST_REFUSAL.UNKNOWN_ABILITY
    if (!Number.isFinite(playerLevel)) return CAST_REFUSAL.LEVEL_UNPARSED
    if (ability.unlockLevel > playerLevel) return CAST_REFUSAL.LOCKED
    if ((getPlayerAbilityState(playerId).cooldowns.get(abilityId) || 0) > 0) return CAST_REFUSAL.COOLING
    return null
  }

  function bindRefusal(hotkeyNumber, abilityId) {
    if (!Number.isInteger(hotkeyNumber) || hotkeyNumber < HOTKEY_SLOT_MIN || hotkeyNumber > HOTKEY_SLOT_MAX) return BIND_REFUSAL.SLOT_OUT_OF_RANGE
    if (abilityId !== null && !abilities.has(abilityId)) return BIND_REFUSAL.UNKNOWN_ABILITY
    return null
  }

  const hotkeys = {}
  const hotkeyRefusals = []
  for (const [slotKey, bound] of Object.entries(hotkeyMap !== null && typeof hotkeyMap === 'object' ? hotkeyMap : {})) {
    const slot = Number(slotKey)
    const abilityId = bound === undefined ? null : bound
    const refusal = bindRefusal(slot, abilityId)
    if (refusal !== null) {
      hotkeyRefusals.push({ field: `hotkeys.${slotKey}`, reason: refusal })
      if (refusal !== BIND_REFUSAL.SLOT_OUT_OF_RANGE) hotkeys[slot] = null
      continue
    }
    hotkeys[slot] = abilityId
  }

  function verdict(refusal) {
    return refusal === null ? { ok: true, reason: null } : { ok: false, reason: refusal }
  }

  function canCastAbility(playerId, abilityId, playerLevel) {
    const refusal = castRefusal(playerId, abilityId, playerLevel)
    if (refusal === CAST_REFUSAL.LEVEL_UNPARSED) {
      const cooling = (getPlayerAbilityState(playerId).cooldowns.get(abilityId) || 0) > 0
      return verdict(cooling ? CAST_REFUSAL.COOLING : null)
    }
    return verdict(refusal)
  }

  function getAbilityCooldown(playerId, abilityId) {
    const state = getPlayerAbilityState(playerId)
    return Math.max(0, state.cooldowns.get(abilityId) || 0)
  }

  function castAbility(playerId, abilityId, playerLevel) {
    const refusal = castRefusal(playerId, abilityId, playerLevel)
    if (refusal !== null) return verdict(refusal)

    const state = getPlayerAbilityState(playerId)
    state.cooldowns.set(abilityId, abilities.get(abilityId).cooldown)
    state.activeAbilities.add(abilityId)

    return verdict(null)
  }

  function tick(dt) {
    if (!(typeof dt === 'number' && Number.isFinite(dt) && dt >= 0)) return

    for (const state of playerAbilityStates.values()) {
      for (const [abilityId, cooldown] of state.cooldowns.entries()) {
        const newCooldown = Math.max(0, cooldown - dt)
        if (newCooldown <= 0) {
          state.cooldowns.delete(abilityId)
          state.activeAbilities.delete(abilityId)
        } else {
          state.cooldowns.set(abilityId, newCooldown)
        }
      }
    }
  }

  function bindHotkey(hotkeyNumber, abilityId) {
    const refusal = bindRefusal(hotkeyNumber, abilityId)
    if (refusal !== null) return verdict(refusal)

    hotkeys[hotkeyNumber] = abilityId
    return verdict(null)
  }

  function getHotkeyBinding(hotkeyNumber) {
    return hotkeys[hotkeyNumber] || null
  }

  function getAllHotkeyBindings() {
    return { ...hotkeys }
  }

  function getAbility(abilityId) {
    return abilities.get(abilityId) || null
  }

  function getAllAbilities() {
    return Array.from(abilities.values())
  }

  function getDefinitionRefusals() {
    return definitionRefusals.map(entry => ({ ...entry }))
  }

  function getHotkeyRefusals() {
    return hotkeyRefusals.map(entry => ({ ...entry }))
  }

  const SLOT_KEY_PATTERN = /^[1-9]$/

  function applySnapshot(snapshotData) {
    if (!snapshotData || typeof snapshotData !== 'object') {
      return { ok: false, reason: 'not-an-object', hotkeys: 0, players: 0, dropped: [] }
    }

    const dropped = []
    let boundHotkeys = 0
    let restoredPlayers = 0

    const hotkeysIn = snapshotData.hotkeys
    const hotkeysUsable = hotkeysIn !== undefined && hotkeysIn !== null && typeof hotkeysIn === 'object' && !Array.isArray(hotkeysIn)
    if (hotkeysIn !== undefined && hotkeysIn !== null && !hotkeysUsable) {
      dropped.push({ field: 'hotkeys', reason: 'hotkeys-not-an-object' })
    }
    if (hotkeysUsable) {
      for (const [slotKey, abilityId] of Object.entries(hotkeysIn)) {
        if (!SLOT_KEY_PATTERN.test(slotKey)) {
          dropped.push({ field: `hotkeys.${slotKey}`, reason: 'slot-out-of-range' })
          continue
        }
        if (abilityId !== null && !abilities.has(abilityId)) {
          dropped.push({ field: `hotkeys.${slotKey}`, reason: 'unknown-ability' })
          continue
        }
        hotkeys[Number(slotKey)] = abilityId
        boundHotkeys++
      }
    }

    const playerStatesIn = snapshotData.playerStates
    const playerStatesUsable = Array.isArray(playerStatesIn)
    if (playerStatesIn !== undefined && playerStatesIn !== null && !playerStatesUsable) {
      dropped.push({ field: 'playerStates', reason: 'player-states-not-an-array' })
    }
    if (playerStatesUsable) {
      const seenPlayers = new Set()
      for (const [playerIndex, snap] of playerStatesIn.entries()) {
        if (!snap || !snap.playerId) {
          dropped.push({ field: `playerStates[${playerIndex}].playerId`, reason: 'missing' })
          continue
        }
        if (seenPlayers.has(snap.playerId)) {
          dropped.push({ field: `playerStates[${playerIndex}].playerId`, reason: 'duplicate-player' })
          continue
        }
        seenPlayers.add(snap.playerId)
        if (!Array.isArray(snap.cooldowns)) {
          dropped.push({ field: `playerStates[${playerIndex}].cooldowns`, reason: 'not-an-array' })
          continue
        }

        const cooldowns = new Map()
        const active = new Set()
        for (const [entryIndex, entry] of snap.cooldowns.entries()) {
          if (!Array.isArray(entry)) {
            dropped.push({ field: `playerStates[${playerIndex}].cooldowns[${entryIndex}]`, reason: 'not-an-array' })
            continue
          }
          const abilityId = parseInt(entry[0], 10)
          if (!Number.isFinite(abilityId)) {
            dropped.push({ field: `playerStates[${playerIndex}].cooldowns[${entryIndex}].abilityId`, reason: 'not-a-number' })
            continue
          }
          if (!abilities.has(abilityId)) {
            dropped.push({ field: `playerStates[${playerIndex}].cooldowns[${entryIndex}].abilityId`, reason: 'unknown-ability' })
            continue
          }
          const remaining = entry[1]
          if (!(typeof remaining === 'number' && Number.isFinite(remaining))) {
            dropped.push({ field: `playerStates[${playerIndex}].cooldowns[${entryIndex}].cooldown`, reason: 'not-a-number' })
            continue
          }
          cooldowns.set(abilityId, remaining)
          if (remaining > 0) active.add(abilityId)
        }

        const state = getPlayerAbilityState(snap.playerId)
        state.cooldowns.clear()
        state.activeAbilities.clear()
        for (const [abilityId, remaining] of cooldowns) state.cooldowns.set(abilityId, remaining)
        for (const abilityId of active) state.activeAbilities.add(abilityId)
        restoredPlayers++
      }
    }

    return { ok: true, reason: null, hotkeys: boundHotkeys, players: restoredPlayers, dropped }
  }

  function buildSnapshot() {
    return {
      hotkeys: { ...hotkeys },
      playerStates: Array.from(playerAbilityStates.values()).map(state => ({
        playerId: state.playerId,
        cooldowns: Array.from(state.cooldowns.entries())
      }))
    }
  }

  function removePlayer(playerId) {
    playerAbilityStates.delete(playerId)
  }

  function getCooldownsForNetwork(playerId) {
    const state = playerAbilityStates.get(playerId)
    if (!state) return []

    const cooldowns = []
    for (const [abilityId, remaining] of state.cooldowns.entries()) {
      cooldowns.push({
        abilityId,
        remaining: Math.round(remaining * 1000) / 1000
      })
    }
    return cooldowns
  }

  function getPlayerAbilityInfo(playerId, playerLevel) {
    const state = getPlayerAbilityState(playerId)
    const unlockedAbilities = getUnlockedAbilities(playerLevel)

    return {
      unlockedAbilities,
      cooldowns: Array.from(state.cooldowns.entries()).map(([id, cd]) => ({
        abilityId: id,
        remaining: cd
      })),
      activeAbilities: Array.from(state.activeAbilities)
    }
  }

  return {
    getPlayerAbilityState,
    getUnlockedAbilities,
    castRefusal,
    bindRefusal,
    canCastAbility,
    getAbilityCooldown,
    castAbility,
    tick,
    bindHotkey,
    getHotkeyBinding,
    getAllHotkeyBindings,
    getAbility,
    getAllAbilities,
    getDefinitionRefusals,
    getHotkeyRefusals,
    applySnapshot,
    buildSnapshot,
    removePlayer,
    getCooldownsForNetwork,
    getPlayerAbilityInfo
  }
}
