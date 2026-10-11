export function defineStatsSystem(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[stats] appCtx is required')

  const startLevel = (typeof spec.startLevel === 'number' && spec.startLevel > 0) ? spec.startLevel : 1
  const startXP = (typeof spec.startXP === 'number' && spec.startXP >= 0) ? spec.startXP : 0
  const xpPerLevel = (typeof spec.xpPerLevel === 'number' && spec.xpPerLevel > 0) ? spec.xpPerLevel : 100
  const maxLevel = (typeof spec.maxLevel === 'number' && spec.maxLevel > 0) ? spec.maxLevel : 50
  const baseStats = spec.baseStats && typeof spec.baseStats === 'object' ? spec.baseStats : {
    health: 100,
    mana: 50,
    damage: 10,
    defense: 5,
    speed: 1.0,
  }
  const statScaling = spec.statScaling && typeof spec.statScaling === 'object' ? spec.statScaling : {
    health: 10,
    mana: 5,
    damage: 0.5,
    defense: 0.25,
    speed: 0,
  }
  const equipment = spec.equipment && typeof spec.equipment === 'object' ? spec.equipment : {}
  const channel = spec.channel || 'stats'

  const _equipmentLookup = new Map()
  for (const [slot, items] of Object.entries(equipment)) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (item && item.id) {
        _equipmentLookup.set(item.id, { ...item, slot })
      }
    }
  }

  const _playerData = new Map()

  const _getPlayerData = (pid) => {
    const key = String(pid)
    let data = _playerData.get(key)
    if (!data) {
      data = {
        level: startLevel,
        xp: startXP,
        equipment: new Map(),
        loadouts: new Map(),
        bonuses: new Map(),
      }
      _playerData.set(key, data)
    }
    return data
  }

  const _fire = (name, arg) => {
    const fn = spec[name]
    if (typeof fn === 'function') {
      try { fn(appCtx, arg) } catch (e) {
        appCtx.debug?.warn?.('[stats] ' + name + ' threw: ' + e.message)
      }
    }
  }

  const _pushToClient = (pid) => {
    const stats = statsSystem.getStats(pid)
    const equipment = statsSystem.getEquipment(pid)
    appCtx.players?.send?.(pid, {
      type: channel,
      level: stats.level,
      xp: stats.xp,
      nextLevelXP: statsSystem._xpForLevel(stats.level + 1),
      health: stats.health,
      mana: stats.mana,
      damage: stats.damage,
      defense: stats.defense,
      speed: stats.speed,
      equipment,
      bonuses: statsSystem.getBonuses(pid),
    })
  }

  const statsSystem = {
    _xpForLevel(level) {
      if (level <= 1) return 0
      return xpPerLevel * (level - 1)
    },

    _levelFromXP(totalXP) {
      let level = 1
      while (level < maxLevel && totalXP >= this._xpForLevel(level + 1)) {
        level++
      }
      return Math.min(level, maxLevel)
    },

    addXP(pid, amount) {
      if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount <= 0) return false

      const data = _getPlayerData(pid)
      const oldLevel = data.level
      data.xp = Math.min(this._xpForLevel(maxLevel + 1), data.xp + amount)
      data.level = this._levelFromXP(data.xp)

      if (data.level > oldLevel) {
        _fire('onLevelUp', { playerId: String(pid), level: data.level, stats: statsSystem.getStats(pid) })
      }

      _pushToClient(pid)
      return true
    },

    applyBonus(pid, stat, amount) {
      if (!Object.prototype.hasOwnProperty.call(baseStats, stat)) return false
      if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount === 0) return false

      const bonuses = _getPlayerData(pid).bonuses
      bonuses.set(stat, (bonuses.get(stat) || 0) + amount)

      _pushToClient(pid)
      return true
    },

    getBonuses(pid) {
      return Object.fromEntries(_getPlayerData(pid).bonuses)
    },

    getLevel(pid) {
      return _getPlayerData(pid).level
    },

    push(pid) {
      _pushToClient(pid)
    },

    getStats(pid) {
      const data = _getPlayerData(pid)
      const level = data.level

      const stats = {}
      for (const [stat, base] of Object.entries(baseStats)) {
        const scale = statScaling[stat] || 0
        stats[stat] = base + (level - 1) * scale
      }

      for (const equipmentId of data.equipment.values()) {
        const item = _equipmentLookup.get(equipmentId)
        if (item && item.bonuses) {
          for (const [stat, bonus] of Object.entries(item.bonuses)) {
            stats[stat] = (stats[stat] || 0) + bonus
          }
        }
      }

      for (const [stat, bonus] of data.bonuses) {
        stats[stat] = (stats[stat] || 0) + bonus
      }

      return {
        level,
        xp: data.xp,
        ...stats,
      }
    },

    getEquipment(pid) {
      const data = _getPlayerData(pid)
      const result = {}

      for (const [slot, equipmentId] of data.equipment) {
        const item = _equipmentLookup.get(equipmentId)
        if (item) {
          result[slot] = {
            id: item.id,
            name: item.name,
            bonuses: item.bonuses || {},
          }
        }
      }

      return result
    },

    equipItem(pid, equipmentId) {
      const item = _equipmentLookup.get(equipmentId)
      if (!item) return false

      const data = _getPlayerData(pid)
      data.equipment.set(item.slot, equipmentId)

      _pushToClient(pid)
      return true
    },

    unequipSlot(pid, slot) {
      const data = _getPlayerData(pid)
      const had = data.equipment.has(slot)
      data.equipment.delete(slot)

      if (had) {
        _pushToClient(pid)
      }

      return had
    },

    getLoadout(pid) {
      const equipment = {}
      for (const [slot, equipmentId] of _getPlayerData(pid).equipment) {
        equipment[slot] = equipmentId
      }
      return equipment
    },

    saveLoadout(pid, loadoutName) {
      if (typeof loadoutName !== 'string' || !loadoutName.trim()) return false

      const data = _getPlayerData(pid)
      const loadout = {}

      for (const [slot, equipmentId] of data.equipment) {
        loadout[slot] = equipmentId
      }

      data.loadouts.set(loadoutName, loadout)
      return true
    },

    loadLoadout(pid, loadoutName) {
      const data = _getPlayerData(pid)
      const loadout = data.loadouts.get(loadoutName)

      if (!loadout) return false

      data.equipment.clear()
      for (const [slot, equipmentId] of Object.entries(loadout)) {
        const item = _equipmentLookup.get(equipmentId)
        if (item) {
          data.equipment.set(slot, equipmentId)
        }
      }

      _fire('onLoadoutSwap', { playerId: String(pid), loadout: data.loadouts.get(loadoutName) })
      _pushToClient(pid)
      return true
    },

    getLoadouts(pid) {
      const data = _getPlayerData(pid)
      const result = {}

      for (const [name, loadout] of data.loadouts) {
        result[name] = { ...loadout }
      }

      return result
    },

    snapshot() {
      const data = {}
      for (const [pid, playerData] of _playerData) {
        data[pid] = {
          level: playerData.level,
          xp: playerData.xp,
          equipment: Object.fromEntries(playerData.equipment),
          bonuses: Object.fromEntries(playerData.bonuses),
          loadouts: Object.fromEntries(
            [...playerData.loadouts].map(([name, loadout]) => [name, { ...loadout }])
          ),
        }
      }
      return data
    },

    restore(data) {
      if (!data || typeof data !== 'object') return
      _playerData.clear()

      for (const [pid, playerData] of Object.entries(data)) {
        const restored = {
          level: Math.min(maxLevel, Math.max(1, playerData.level || startLevel)),
          xp: Math.max(0, playerData.xp || 0),
          equipment: new Map(),
          loadouts: new Map(),
          bonuses: new Map(),
        }

        if (playerData.bonuses && typeof playerData.bonuses === 'object') {
          for (const [stat, bonus] of Object.entries(playerData.bonuses)) {
            if (Object.prototype.hasOwnProperty.call(baseStats, stat) && typeof bonus === 'number' && Number.isFinite(bonus)) {
              restored.bonuses.set(stat, bonus)
            }
          }
        }

        if (playerData.equipment && typeof playerData.equipment === 'object') {
          for (const [slot, equipmentId] of Object.entries(playerData.equipment)) {
            if (_equipmentLookup.has(equipmentId)) {
              restored.equipment.set(slot, equipmentId)
            }
          }
        }

        if (playerData.loadouts && typeof playerData.loadouts === 'object') {
          for (const [name, loadout] of Object.entries(playerData.loadouts)) {
            if (loadout && typeof loadout === 'object') {
              const restoredLoadout = {}
              for (const [slot, equipmentId] of Object.entries(loadout)) {
                if (_equipmentLookup.has(equipmentId)) {
                  restoredLoadout[slot] = equipmentId
                }
              }
              if (Object.keys(restoredLoadout).length > 0) {
                restored.loadouts.set(name, restoredLoadout)
              }
            }
          }
        }

        _playerData.set(pid, restored)
      }
    },
  }

  return statsSystem
}

export default defineStatsSystem
