export function defineQuestSystem(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[quest] appCtx is required')

  const quests = (spec.quests && typeof spec.quests === 'object') ? spec.quests : {}
  const channel = spec.channel || 'quests'

  for (const [id, def] of Object.entries(quests)) {
    if (!def || typeof def !== 'object') throw new Error(`[quest] quest "${id}" must be an object`)
    if (!def.title || typeof def.title !== 'string') throw new Error(`[quest] quest "${id}" missing or invalid title`)
    if (!Array.isArray(def.objectives)) throw new Error(`[quest] quest "${id}" missing objectives array`)
    if (!def.rewards || typeof def.rewards !== 'object') throw new Error(`[quest] quest "${id}" missing rewards`)
  }

  const _playerQuests = new Map()

  const _getPlayerData = (pid) => {
    const key = String(pid)
    let data = _playerQuests.get(key)
    if (!data) {
      data = new Map()
      _playerQuests.set(key, data)
    }
    return data
  }

  const _fire = (name, arg) => {
    const fn = spec[name]
    if (typeof fn === 'function') {
      try { fn(appCtx, arg) } catch (e) {
        appCtx.debug?.warn?.('[quest] ' + name + ' threw: ' + e.message)
      }
    }
  }

  const _pushToClient = (pid, questId) => {
    const data = _getPlayerData(pid)
    const quest = data.get(questId)
    if (quest) {
      appCtx.players?.send?.(String(pid), {
        type: channel,
        questId,
        state: quest.state,
        progress: quest.progress,
        completedAt: quest.completedAt || null,
      })
    }
  }

  const questSystem = {
    startQuest(pid, questId) {
      const data = _getPlayerData(pid)
      if (!quests[questId]) return false

      const existing = data.get(questId)
      if (existing && (existing.state === 'active' || existing.state === 'completed')) {
        return false
      }

      const questDef = quests[questId]
      const progress = questDef.objectives.map(() => 0)

      data.set(questId, {
        state: 'active',
        progress,
        startedAt: Date.now(),
      })

      _fire('onQuestStart', { playerId: String(pid), questId })
      _pushToClient(pid, questId)
      return true
    },

    completeObjective(pid, questId, objectiveIndex, amount = 1) {
      const data = _getPlayerData(pid)
      const quest = data.get(questId)

      if (!quest || quest.state !== 'active') return false

      const questDef = quests[questId]
      if (!questDef || !questDef.objectives[objectiveIndex]) return false

      const objective = questDef.objectives[objectiveIndex]
      const isComplete = objective.count && quest.progress[objectiveIndex] >= objective.count

      if (isComplete) return false

      quest.progress[objectiveIndex] = Math.min(objective.count || 1, quest.progress[objectiveIndex] + amount)

      _fire('onObjectiveProgress', {
        playerId: String(pid),
        questId,
        objectiveIndex,
        progress: quest.progress[objectiveIndex],
        target: objective.count || 1,
      })

      _pushToClient(pid, questId)

      const allComplete = questDef.objectives.every((obj, i) => {
        return obj.count ? quest.progress[i] >= obj.count : quest.progress[i] > 0
      })

      if (allComplete) {
        quest.state = 'complete'
        _fire('onQuestComplete', {
          playerId: String(pid),
          questId,
          rewards: questDef.rewards,
        })
        _pushToClient(pid, questId)
      }

      return true
    },

    claimReward(pid, questId) {
      const data = _getPlayerData(pid)
      const quest = data.get(questId)

      if (!quest || quest.state !== 'complete') return null
      if (quest.state === 'claimed') return null

      const questDef = quests[questId]
      if (!questDef) return null

      const rewards = questDef.rewards
      quest.state = 'claimed'
      quest.claimedAt = Date.now()

      if (rewards.xp && appCtx.progression?.addXP) {
        appCtx.progression.addXP(pid, rewards.xp)
      }

      if (rewards.items && appCtx.inventory) {
        for (const [itemId, count] of Object.entries(rewards.items)) {
          appCtx.inventory.add(pid, itemId, count)
        }
      }

      if (rewards.statBonuses && appCtx.stats?.applyBonus) {
        for (const [stat, bonus] of Object.entries(rewards.statBonuses)) {
          appCtx.stats.applyBonus(pid, stat, bonus)
        }
      }

      _pushToClient(pid, questId)
      return { xp: rewards.xp || 0, items: rewards.items || {}, statBonuses: rewards.statBonuses || {} }
    },

    getQuestState(pid, questId) {
      const data = _getPlayerData(pid)
      const quest = data.get(questId)
      if (!quest) return null

      return {
        questId,
        state: quest.state,
        progress: [...quest.progress],
        startedAt: quest.startedAt || null,
        completedAt: quest.completedAt || null,
        claimedAt: quest.claimedAt || null,
      }
    },

    getPlayerQuests(pid) {
      const data = _getPlayerData(pid)
      const result = {}

      for (const [questId, state] of data) {
        result[questId] = {
          state: state.state,
          progress: [...state.progress],
          startedAt: state.startedAt || null,
          completedAt: state.completedAt || null,
          claimedAt: state.claimedAt || null,
        }
      }

      return result
    },

    getAllQuestProgress(pid) {
      const data = _getPlayerData(pid)
      const result = {}

      for (const [questId, questDef] of Object.entries(quests)) {
        const playerQuest = data.get(questId)
        result[questId] = {
          title: questDef.title,
          description: questDef.description,
          objectives: questDef.objectives.map((obj, i) => ({
            type: obj.type,
            description: obj.description || `${obj.type} objective`,
            progress: playerQuest ? playerQuest.progress[i] || 0 : 0,
            target: obj.count || 1,
          })),
          state: playerQuest?.state || 'available',
          rewards: questDef.rewards,
        }
      }

      return result
    },

    snapshot() {
      const data = {}
      for (const [pid, quests] of _playerQuests) {
        data[pid] = {}
        for (const [questId, quest] of quests) {
          data[pid][questId] = {
            state: quest.state,
            progress: [...quest.progress],
            startedAt: quest.startedAt,
            completedAt: quest.completedAt,
            claimedAt: quest.claimedAt,
          }
        }
      }
      return data
    },

    restore(data) {
      if (!data || typeof data !== 'object') return
      _playerQuests.clear()

      for (const [pid, playerQuests] of Object.entries(data)) {
        const questMap = new Map()
        for (const [questId, quest] of Object.entries(playerQuests)) {
          questMap.set(questId, {
            state: quest.state,
            progress: Array.isArray(quest.progress) ? [...quest.progress] : [],
            startedAt: quest.startedAt,
            completedAt: quest.completedAt,
            claimedAt: quest.claimedAt,
          })
        }
        if (questMap.size > 0) {
          _playerQuests.set(pid, questMap)
        }
      }
    },
  }

  return questSystem
}

export default defineQuestSystem
