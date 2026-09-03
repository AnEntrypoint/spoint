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

  for (const def of abilityDefs) {
    if (!def.id || typeof def.id !== 'number') continue
    abilities.set(def.id, {
      id: def.id,
      name: def.name || '',
      description: def.description || '',
      manaCost: def.manaCost || 0,
      cooldown: Math.max(0.1, def.cooldown || 1.0),
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

  function canCastAbility(playerId, abilityId) {
    const ability = abilities.get(abilityId)
    if (!ability) return false

    const state = getPlayerAbilityState(playerId)
    const cooldown = state.cooldowns.get(abilityId) || 0

    return cooldown <= 0
  }

  function getAbilityCooldown(playerId, abilityId) {
    const state = getPlayerAbilityState(playerId)
    return Math.max(0, state.cooldowns.get(abilityId) || 0)
  }

  function castAbility(playerId, abilityId, playerLevel) {
    const ability = abilities.get(abilityId)
    if (!ability) return false

    if (ability.unlockLevel > playerLevel) return false

    const state = getPlayerAbilityState(playerId)
    const currentCooldown = state.cooldowns.get(abilityId) || 0

    if (currentCooldown > 0) return false

    state.cooldowns.set(abilityId, ability.cooldown)
    state.activeAbilities.add(abilityId)

    return true
  }

  function tick(dt) {
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
    if (hotkeyNumber < 1 || hotkeyNumber > 9) return false
    if (abilityId !== null && !abilities.has(abilityId)) return false

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
    if (!snapshotData) return

    if (snapshotData.hotkeys && typeof snapshotData.hotkeys === 'object') {
      for (const [key, value] of Object.entries(snapshotData.hotkeys)) {
        const hotkeyNum = parseInt(key, 10)
        if (!isNaN(hotkeyNum) && hotkeyNum >= 1 && hotkeyNum <= 9) {
          hotkeys[hotkeyNum] = value
        }
      }
    }

    if (Array.isArray(snapshotData.playerStates)) {
      for (const snap of snapshotData.playerStates) {
        if (!snap.playerId) continue

        const state = getPlayerAbilityState(snap.playerId)
        if (snap.cooldowns && Array.isArray(snap.cooldowns)) {
          state.cooldowns.clear()
          for (const [abilityId, cooldown] of snap.cooldowns) {
            state.cooldowns.set(parseInt(abilityId, 10), cooldown)
          }
        }
      }
    }
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
