export const CURVE_LINEAR = 'linear'
export const CURVE_EXPONENTIAL = 'exponential'
export const CURVE_QUADRATIC = 'quadratic'

export const DEFAULT_CONFIG = {
  curve: CURVE_QUADRATIC,
  baseXpPerLevel: 100,
  curveScalar: 1.5,
  maxLevel: 100,
  xpPerKill: 10
}

export function createProgressionSystem(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const playerProgression = new Map()
  let ticksElapsed = 0

  function calculateXpThreshold(level, curve = cfg.curve) {
    if (level <= 1) return 0
    const base = cfg.baseXpPerLevel

    switch (curve) {
      case CURVE_LINEAR:
        return base * (level - 1)
      case CURVE_EXPONENTIAL:
        return Math.floor(base * Math.pow(cfg.curveScalar, level - 2))
      case CURVE_QUADRATIC:
        return Math.floor(base * (level - 1) * (level - 1))
      default:
        return base * (level - 1)
    }
  }

  function getPlayerState(playerId) {
    if (!playerProgression.has(playerId)) {
      playerProgression.set(playerId, {
        id: playerId,
        xp: 0,
        level: 1,
        totalXp: 0,
        lastLevelUpTick: 0,
        levelUpEvents: []
      })
    }
    return playerProgression.get(playerId)
  }

  function addXp(playerId, amount) {
    if (!Number.isFinite(amount) || amount < 0) return false

    const state = getPlayerState(playerId)
    const newTotalXp = state.totalXp + amount

    if (newTotalXp > 0xFFFFFFFF) {
      state.totalXp = 0xFFFFFFFF
      state.level = cfg.maxLevel
      state.xp = calculateXpThreshold(cfg.maxLevel)
      return false
    }

    state.totalXp = newTotalXp

    let leveledUp = false
    while (state.level < cfg.maxLevel) {
      const nextLevelThreshold = calculateXpThreshold(state.level + 1)
      if (state.totalXp >= nextLevelThreshold) {
        state.level++
        state.lastLevelUpTick = ticksElapsed
        state.levelUpEvents.push({
          level: state.level,
          xp: state.totalXp - calculateXpThreshold(state.level),
          totalXp: state.totalXp,
          tick: ticksElapsed
        })
        leveledUp = true
      } else {
        break
      }
    }

    const currentLevelThreshold = calculateXpThreshold(state.level)
    state.xp = state.totalXp - currentLevelThreshold

    return leveledUp
  }

  function getProgress(playerId) {
    const state = getPlayerState(playerId)
    const currentThreshold = calculateXpThreshold(state.level)
    const nextThreshold = calculateXpThreshold(state.level + 1)
    const xpForLevel = nextThreshold - currentThreshold
    const xpInLevel = state.xp
    const progressRatio = xpForLevel > 0 ? xpInLevel / xpForLevel : 0

    return {
      level: state.level,
      xp: state.xp,
      totalXp: state.totalXp,
      xpForLevel,
      xpInLevel,
      progressRatio: Math.min(1, Math.max(0, progressRatio))
    }
  }

  function getState(playerId) {
    return playerProgression.get(playerId) || null
  }

  function getAllStates() {
    return Array.from(playerProgression.values())
  }

  function applySnapshot(snapshotData) {
    if (!snapshotData || !Array.isArray(snapshotData.progressions)) return

    for (const snap of snapshotData.progressions) {
      if (!snap.id) continue
      playerProgression.set(snap.id, {
        id: snap.id,
        xp: snap.xp || 0,
        level: snap.level || 1,
        totalXp: snap.totalXp || 0,
        lastLevelUpTick: snap.lastLevelUpTick || 0,
        levelUpEvents: snap.levelUpEvents || []
      })
    }
  }

  function buildSnapshot() {
    return {
      progressions: Array.from(playerProgression.values()).map(s => ({
        id: s.id,
        xp: s.xp,
        level: s.level,
        totalXp: s.totalXp,
        lastLevelUpTick: s.lastLevelUpTick,
        levelUpEvents: s.levelUpEvents
      }))
    }
  }

  function drainLevelUpEvents(playerId) {
    const state = getPlayerState(playerId)
    const events = state.levelUpEvents
    state.levelUpEvents = []
    return events
  }

  function tick(dt) {
    ticksElapsed++
  }

  function removePlayer(playerId) {
    playerProgression.delete(playerId)
  }

  function getConfig() {
    return { ...cfg }
  }

  return {
    calculateXpThreshold,
    getPlayerState,
    addXp,
    getProgress,
    getState,
    getAllStates,
    applySnapshot,
    buildSnapshot,
    drainLevelUpEvents,
    tick,
    removePlayer,
    getConfig
  }
}

export function getStatScaling(level, baseValue, curve = CURVE_LINEAR) {
  if (curve === CURVE_LINEAR) {
    return baseValue + (level - 1) * 5
  } else if (curve === CURVE_EXPONENTIAL) {
    return Math.floor(baseValue * Math.pow(1.05, level - 1))
  } else if (curve === CURVE_QUADRATIC) {
    return Math.floor(baseValue * (1 + (level - 1) * 0.1))
  }
  return baseValue
}
