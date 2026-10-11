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

export function createAbilityTree(abilityDefs = DEFAULT_ABILITIES, hotkeyMap = HOTKEY_MAP) {
  const abilities = new Map()
  const playerAbilityStates = new Map()

  const _parseCooldown = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0.1, value) : 1.0

  for (const def of abilityDefs) {
    if (!def.id || typeof def.id !== 'number') continue
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

  const hotkeys = { ...hotkeyMap }

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

  function canCastAbility(playerId, abilityId, playerLevel) {
    const refusal = castRefusal(playerId, abilityId, playerLevel)
    if (refusal === CAST_REFUSAL.LEVEL_UNPARSED) {
      return (getPlayerAbilityState(playerId).cooldowns.get(abilityId) || 0) <= 0
    }
    return refusal === null
  }

  function getAbilityCooldown(playerId, abilityId) {
    const state = getPlayerAbilityState(playerId)
    return Math.max(0, state.cooldowns.get(abilityId) || 0)
  }

  function castAbility(playerId, abilityId, playerLevel) {
    const refusal = castRefusal(playerId, abilityId, playerLevel)
    if (refusal !== null) return false

    const state = getPlayerAbilityState(playerId)
    state.cooldowns.set(abilityId, abilities.get(abilityId).cooldown)
    state.activeAbilities.add(abilityId)

    return true
  }

  function tick(dt) {
    if (!(typeof dt === 'number' && Number.isFinite(dt))) return

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
    if (refusal !== null) return false

    hotkeys[hotkeyNumber] = abilityId
    return true
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

  function applySnapshot(snapshotData) {
    if (!snapshotData || typeof snapshotData !== 'object') {
      return { ok: false, reason: 'not-an-object', hotkeys: 0, players: 0, dropped: [] }
    }

    const dropped = []
    let boundHotkeys = 0
    let restoredPlayers = 0

    if (snapshotData.hotkeys && typeof snapshotData.hotkeys === 'object') {
      for (const [slotKey, abilityId] of Object.entries(snapshotData.hotkeys)) {
        const slot = parseInt(slotKey, 10)
        if (!Number.isFinite(slot) || slot < 1 || slot > 9) {
          dropped.push({ field: `hotkeys.${slotKey}`, reason: 'slot-out-of-range' })
          continue
        }
        if (abilityId !== null && !abilities.has(abilityId)) {
          dropped.push({ field: `hotkeys.${slotKey}`, reason: 'unknown-ability' })
          continue
        }
        hotkeys[slot] = abilityId
        boundHotkeys++
      }
    }

    if (Array.isArray(snapshotData.playerStates)) {
      for (const [playerIndex, snap] of snapshotData.playerStates.entries()) {
        if (!snap || !snap.playerId) {
          dropped.push({ field: `playerStates[${playerIndex}].playerId`, reason: 'missing' })
          continue
        }
        if (!Array.isArray(snap.cooldowns)) {
          dropped.push({ field: `playerStates[${playerIndex}].cooldowns`, reason: 'not-an-array' })
          continue
        }

        const cooldowns = new Map()
        const active = new Set()
        for (const [entryIndex, entry] of snap.cooldowns.entries()) {
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
    applySnapshot,
    buildSnapshot,
    removePlayer,
    getCooldownsForNetwork,
    getPlayerAbilityInfo
  }
}
