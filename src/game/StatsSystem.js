import { parsePlayerId, tryParsePlayerId } from './playerId.js'

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

  const _xpForLevel = (level) => (level <= 1 ? 0 : xpPerLevel * (level - 1))

  const _levelFromXP = (totalXP) => {
    let level = 1
    while (level < maxLevel && totalXP >= _xpForLevel(level + 1)) {
      level++
    }
    return Math.min(level, maxLevel)
  }

  const _levelForXP = (totalXP, floorLevel) => {
    const floor = typeof floorLevel === 'number' && !Number.isNaN(floorLevel) ? Math.max(1, floorLevel) : 1
    return Math.min(maxLevel, Math.max(floor, _levelFromXP(totalXP)))
  }

  const _playerData = new Map()

  const _getPlayerData = (pid) => {
    const key = parsePlayerId(pid)
    let data = _playerData.get(key)
    if (!data) {
      const floor = Math.min(startLevel, maxLevel)
      const xp = Math.min(_xpForLevel(maxLevel + 1), Math.max(startXP, _xpForLevel(floor)))
      data = {
        level: _levelForXP(xp, floor),
        xp,
        equipment: new Map(),
        loadouts: new Map(),
        bonuses: new Map(),
      }
      _playerData.set(key, data)
    }
    return data
  }

  const _declaredSlot = (slot) =>
    Object.hasOwn(equipment, slot) && Array.isArray(equipment[slot])

  const _parseRestoredPlayer = (record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { ok: false, reason: 'not-an-object', player: null, dropped: [] }
    }

    // level is derived from the restored xp, the same invariant addXP keeps; the xp floor matches _getPlayerData
    const declaredXP = typeof record.xp === 'number' && !Number.isNaN(record.xp) ? record.xp : 0
    const xp = Math.min(_xpForLevel(maxLevel + 1), Math.max(_xpForLevel(Math.min(startLevel, maxLevel)), declaredXP))
    const player = {
      level: _levelFromXP(xp),
      xp,
      equipment: new Map(),
      loadouts: new Map(),
      bonuses: new Map(),
    }
    const dropped = []

    if (record.bonuses && typeof record.bonuses === 'object') {
      for (const [stat, bonus] of Object.entries(record.bonuses)) {
        if (Object.hasOwn(baseStats, stat) && typeof bonus === 'number' && Number.isFinite(bonus)) {
          player.bonuses.set(stat, bonus)
        }
      }
    }

    if (record.equipment && typeof record.equipment === 'object') {
      for (const [slot, equipmentId] of Object.entries(record.equipment)) {
        if (!_declaredSlot(slot)) {
          dropped.push({ slot, reason: 'unknown-slot' })
          continue
        }
        if (_equipmentLookup.has(equipmentId)) player.equipment.set(slot, equipmentId)
      }
    }

    if (record.loadouts && typeof record.loadouts === 'object') {
      for (const [name, loadout] of Object.entries(record.loadouts)) {
        if (!loadout || typeof loadout !== 'object') continue
        const restoredLoadout = {}
        for (const [slot, equipmentId] of Object.entries(loadout)) {
          if (!_declaredSlot(slot)) {
            dropped.push({ slot, reason: 'unknown-slot' })
            continue
          }
          if (_equipmentLookup.has(equipmentId)) restoredLoadout[slot] = equipmentId
        }
        if (Object.keys(restoredLoadout).length > 0) player.loadouts.set(name, restoredLoadout)
      }
    }

    return { ok: true, reason: null, player, dropped }
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
      return _xpForLevel(level)
    },

    _levelFromXP(totalXP) {
      return _levelFromXP(totalXP)
    },

    addXP(pid, amount) {
      if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount <= 0) return false

      const data = _getPlayerData(pid)
      const oldLevel = data.level
      data.xp = Math.min(this._xpForLevel(maxLevel + 1), data.xp + amount)
      data.level = _levelForXP(data.xp, data.level)

      if (data.level > oldLevel) {
        _fire('onLevelUp', { playerId: parsePlayerId(pid), level: data.level, stats: statsSystem.getStats(pid) })
      }

      _pushToClient(pid)
      return true
    },

    applyBonus(pid, stat, amount) {
      if (!Object.hasOwn(baseStats, stat)) return false
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

      _fire('onLoadoutSwap', { playerId: parsePlayerId(pid), loadout: data.loadouts.get(loadoutName) })
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
      if (!data || typeof data !== 'object') {
        return { ok: false, reason: 'not-an-object', players: 0, dropped: [] }
      }

      const parsedPlayers = new Map()
      const dropped = []

      for (const [pid, record] of Object.entries(data)) {
        const key = tryParsePlayerId(pid)
        if (key === null) {
          dropped.push({ playerId: pid, reason: 'invalid-player-id' })
          continue
        }
        const parsed = _parseRestoredPlayer(record)
        if (!parsed.ok) {
          dropped.push({ playerId: pid, reason: parsed.reason })
          continue
        }
        for (const entry of parsed.dropped) dropped.push({ playerId: pid, ...entry })
        parsedPlayers.set(key, parsed.player)
      }

      _playerData.clear()
      for (const [pid, player] of parsedPlayers) _playerData.set(pid, player)

      return { ok: true, reason: null, players: parsedPlayers.size, dropped }
    },
  }

  return statsSystem
}

export default defineStatsSystem
