class PlayerProgression {
  constructor(playerId) {
    this.playerId = playerId
    this.level = 1
    this.currentXP = 0
    this.totalXP = 0
    this.xpToLevel = 100
    this.hp = 100
    this.maxHp = 100
    this.mana = 50
    this.maxMana = 50
    this.abilities = []
    this.activeQuests = []
    this.completedQuests = []
    this.cooldowns = {}
    this.loadouts = [
      { id: 0, name: 'Build 1', gear: [] },
      { id: 1, name: 'Build 2', gear: [] },
      { id: 2, name: 'Build 3', gear: [] }
    ]
  }

  gainXP(amount, broadcastFn) {
    this.totalXP += amount
    this.currentXP += amount

    while (this.currentXP >= this.xpToLevel) {
      this.levelUp(broadcastFn)
    }
  }

  levelUp(broadcastFn) {
    this.currentXP -= this.xpToLevel
    this.level += 1

    this.xpToLevel = Math.ceil(100 * Math.pow(this.level, 1.1))

    if (broadcastFn) {
      broadcastFn('PROGRESSION_LEVEL_UP', {
        playerId: this.playerId,
        level: this.level
      })

      this.unlockAbilitiesForLevel(broadcastFn)
    }
  }

  unlockAbilitiesForLevel(broadcastFn) {
    const abilitysByLevel = {
      1: { id: 'fireball', name: 'Fireball', icon: '🔥', hotkey: 1 },
      3: { id: 'frostbolt', name: 'Frostbolt', icon: '❄️', hotkey: 2 },
      5: { id: 'lightning', name: 'Lightning', icon: '⚡', hotkey: 3 },
      7: { id: 'meteor', name: 'Meteor', icon: '☄️', hotkey: 4 }
    }

    if (abilitysByLevel[this.level]) {
      const newAbility = abilitysByLevel[this.level]
      this.abilities.push({
        ...newAbility,
        description: `Level ${this.level} ability`,
        unlocked: true
      })

      if (broadcastFn) {
        broadcastFn('PROGRESSION_UPDATE', {
          playerId: this.playerId,
          abilities: this.abilities.map(a => ({
            ...a,
            unlocked: true
          }))
        })
      }
    }
  }

  setCooldown(abilityId, cooldownMs, broadcastFn) {
    this.cooldowns[abilityId] = cooldownMs

    if (broadcastFn) {
      broadcastFn('ABILITY_COOLDOWN', {
        playerId: this.playerId,
        abilityId,
        cooldownMs
      })
    }
  }

  completeQuest(questId, broadcastFn) {
    const idx = this.activeQuests.findIndex(q => q.id === questId)
    if (idx < 0) return false

    const quest = this.activeQuests[idx]
    this.activeQuests.splice(idx, 1)
    this.completedQuests.push(quest)

    if (quest.reward && quest.reward.xp) {
      this.gainXP(quest.reward.xp, broadcastFn)
    }

    if (broadcastFn) {
      broadcastFn('QUEST_COMPLETE', {
        playerId: this.playerId,
        questId,
        reward: quest.reward
      })
    }

    return true
  }

  addQuest(quest, broadcastFn) {
    this.activeQuests.push({
      id: quest.id,
      title: quest.title,
      objectives: quest.objectives || [],
      reward: quest.reward || '0 XP'
    })

    if (broadcastFn) {
      broadcastFn('PROGRESSION_UPDATE', {
        playerId: this.playerId,
        quests: this.activeQuests
      })
    }
  }

  updateQuestProgress(questId, objectiveIndex, progress, broadcastFn) {
    const quest = this.activeQuests.find(q => q.id === questId)
    if (!quest || !quest.objectives[objectiveIndex]) return

    quest.objectives[objectiveIndex].current = progress

    if (broadcastFn) {
      broadcastFn('PROGRESSION_UPDATE', {
        playerId: this.playerId,
        quests: this.activeQuests
      })
    }
  }

  toPlayerState() {
    return {
      level: this.level,
      currentXP: this.currentXP,
      totalXP: this.totalXP,
      xpToLevel: this.xpToLevel,
      hp: this.hp,
      mana: this.mana,
      abilities: this.abilities
    }
  }
}

export function setupProgressionHandlers(app, network) {
  const playerProgress = new Map()

  network.on('player-join', (playerId) => {
    if (!playerProgress.has(playerId)) {
      playerProgress.set(playerId, new PlayerProgression(playerId))
    }

    const prog = playerProgress.get(playerId)

    network.broadcastTo(playerId, 'PROGRESSION_UPDATE', {
      ...prog.toPlayerState(),
      quests: prog.activeQuests,
      completedQuests: prog.completedQuests,
      abilities: prog.abilities
    })
  })

  network.on('LOAD_LOADOUT', (data, playerId) => {
    const prog = playerProgress.get(playerId)
    if (!prog || !Number.isFinite(data.buildId)) return

    const build = prog.loadouts[data.buildId]
    if (!build) return

    network.broadcastTo(playerId, 'PROGRESSION_UPDATE', {
      hp: prog.hp,
      mana: prog.mana,
      abilities: prog.abilities
    })
  })

  network.on('SAVE_LOADOUT', (data, playerId) => {
    const prog = playerProgress.get(playerId)
    if (!prog || !Number.isFinite(data.buildId)) return

    const build = prog.loadouts[data.buildId]
    if (!build) return

  })

  network.on('TEST_LEVEL_UP', (data, playerId) => {
    const prog = playerProgress.get(playerId)
    if (!prog) return

    prog.levelUp((type, msg) => {
      network.broadcast(type, { ...msg, playerId })
    })
  })

  network.on('TEST_COMPLETE_QUEST', (data, playerId) => {
    const prog = playerProgress.get(playerId)
    if (!prog || !data.questId) return

    prog.completeQuest(data.questId, (type, msg) => {
      network.broadcast(type, { ...msg, playerId })
    })
  })

  return {
    getPlayerProgress(playerId) {
      return playerProgress.get(playerId)
    },
    removePlayer(playerId) {
      playerProgress.delete(playerId)
    }
  }
}

export function onEnemyDefeated(player, enemy, network, progressionManager) {
  const prog = progressionManager.getPlayerProgress(player.id)
  if (!prog) return

  const xpReward = enemy.xpValue || 50

  prog.gainXP(xpReward, (type, msg) => {
    network.broadcast(type, { ...msg, playerId: player.id })
  })

  prog.activeQuests.forEach((quest, qIdx) => {
    if (quest.id === 'kill-enemies-quest') {
      const obj = quest.objectives[0]
      if (obj) {
        obj.current = Math.min(obj.current + 1, obj.target)

        if (obj.current >= obj.target) {
          prog.completeQuest(quest.id, (type, msg) => {
            network.broadcast(type, { ...msg, playerId: player.id })
          })
        } else {
          network.broadcast('PROGRESSION_UPDATE', {
            playerId: player.id,
            quests: prog.activeQuests
          })
        }
      }
    }
  })
}

export function onAbilityUsed(player, abilityId, network, progressionManager) {
  const prog = progressionManager.getPlayerProgress(player.id)
  if (!prog) return

  const cooldownMs = 3000

  prog.setCooldown(abilityId, cooldownMs, (type, msg) => {
    network.broadcast(type, { ...msg, playerId: player.id })
  })

  const decayInterval = setInterval(() => {
    const cd = prog.cooldowns[abilityId]
    if (!cd || cd <= 0) {
      clearInterval(decayInterval)
      return
    }

    prog.cooldowns[abilityId] = Math.max(0, cd - 100)

    if (prog.cooldowns[abilityId] === 0) {
      network.broadcast('ABILITY_COOLDOWN', {
        playerId: player.id,
        abilityId,
        cooldownMs: 0
      })
      clearInterval(decayInterval)
    }
  }, 100)
}

async function savePlayerProgress(playerId, progress, db) {
  await db.collection('player-progression').updateOne(
    { playerId },
    {
      $set: {
        level: progress.level,
        totalXP: progress.totalXP,
        currentXP: progress.currentXP,
        completedQuests: progress.completedQuests,
        loadouts: progress.loadouts,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  )
}

async function loadPlayerProgress(playerId, db) {
  const doc = await db.collection('player-progression').findOne({ playerId })
  if (!doc) return new PlayerProgression(playerId)

  const prog = new PlayerProgression(playerId)
  prog.level = doc.level
  prog.totalXP = doc.totalXP
  prog.currentXP = doc.currentXP
  prog.completedQuests = doc.completedQuests || []
  prog.loadouts = doc.loadouts || prog.loadouts
  return prog
}
