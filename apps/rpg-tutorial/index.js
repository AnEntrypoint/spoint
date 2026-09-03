const BASE_XP_TABLE = [0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700, 3250]

const QUESTS = [
  { id: 0, title: 'Kill 3 Goblins', objectiveType: 'kill', targetType: 'goblin', count: 3, xpReward: 30 },
  { id: 1, title: 'Collect 5 Gold Coins', objectiveType: 'collect', targetType: 'gold-coin', count: 5, xpReward: 50 },
  { id: 2, title: 'Reach the Tower', objectiveType: 'reach', targetType: 'tower-base', count: 1, xpReward: 75 },
  { id: 3, title: 'Defeat the Mini-Boss', objectiveType: 'kill', targetType: 'mini-boss', count: 1, xpReward: 100 },
  { id: 4, title: 'Defeat the Final Boss', objectiveType: 'kill', targetType: 'final-boss', count: 1, xpReward: 150 }
]

const ABILITIES = {
  1: { id: 'attack', name: 'Attack', level: 1, cooldown: 0, manaCost: 0, damage: 10, range: 3 },
  5: { id: 'fireball', name: 'Fireball', level: 5, cooldown: 5, manaCost: 20, damage: 30, range: 20 },
  10: { id: 'lightning-storm', name: 'Lightning Storm', level: 10, cooldown: 10, manaCost: 50, damage: 60, range: 15 }
}

const getXpForLevel = (level) => BASE_XP_TABLE[Math.min(level, 10)]

const getPlayerState = (ctx, playerId) => {
  ctx.state.progression = ctx.state.progression || {}
  let ps = ctx.state.progression[playerId]
  if (!ps) {
    ps = {
      playerId,
      level: 1,
      xp: 0,
      health: 100,
      maxHealth: 100,
      mana: 100,
      maxMana: 100,
      quest: 0,
      questProgress: 0,
      unlockedAbilities: { attack: true },
      activeCooldowns: {}
    }
    ctx.state.progression[playerId] = ps
  }
  return ps
}

const addXp = (ctx, playerId, amount) => {
  const ps = getPlayerState(ctx, playerId)
  ps.xp += amount

  const nextLevelXp = getXpForLevel(ps.level)
  while (ps.xp >= nextLevelXp && ps.level < 10) {
    ps.level++
    ps.xp = 0
    ps.maxHealth += 10
    ps.health = ps.maxHealth
    ps.maxMana += 20
    ps.mana = ps.maxMana

    const abilityForLevel = Object.entries(ABILITIES).find(([lvl]) => parseInt(lvl) === ps.level)
    if (abilityForLevel) {
      ps.unlockedAbilities[abilityForLevel[1].id] = true
    }

    ctx.bus.emit('player.levelup', {
      playerId,
      newLevel: ps.level,
      unlockedAbility: abilityForLevel ? abilityForLevel[1].name : null
    })
  }
}

const damageEntity = (entity, damage) => {
  if (!entity.custom) entity.custom = {}
  entity.custom.health = Math.max(0, (entity.custom.health || entity.custom.maxHealth || 10) - damage)
  entity.custom.isDamaged = true

  if (entity.custom.health <= 0) {
    const xpDrop = entity.custom.xpValue || 10
    entity.destroy()
    return xpDrop
  }
  return 0
}

const castAbility = (ctx, playerId, abilityId, targetPos) => {
  const ps = getPlayerState(ctx, playerId)
  const ability = Object.values(ABILITIES).find(a => a.id === abilityId)

  if (!ability || !ps.unlockedAbilities[abilityId]) return false
  if (ps.mana < ability.manaCost) return false
  if (ps.activeCooldowns[abilityId]) return false

  ps.mana -= ability.manaCost
  ps.activeCooldowns[abilityId] = ability.cooldown

  const player = ctx.players.getById(playerId)
  if (!player) return true

  const origin = player.state.position
  const nearby = ctx.world.nearby(origin, ability.range)

  nearby.forEach(entityId => {
    const entity = ctx.world.getEntity(entityId)
    if (entity && entity.custom?.enemyType) {
      damageEntity(entity, ability.damage)
    }
  })

  return true
}

const updateQuestProgress = (ctx, playerId, objectiveType, targetType) => {
  const ps = getPlayerState(ctx, playerId)
  const currentQuest = QUESTS[ps.quest]
  if (!currentQuest) return

  if (currentQuest.objectiveType === objectiveType && currentQuest.targetType === targetType) {
    ps.questProgress++

    if (ps.questProgress >= (currentQuest.count || 1)) {
      completeQuest(ctx, playerId)
    }
  }
}

const completeQuest = (ctx, playerId) => {
  const ps = getPlayerState(ctx, playerId)
  const quest = QUESTS[ps.quest]
  if (!quest) return

  addXp(ctx, playerId, quest.xpReward)
  ctx.bus.emit('quest.completed', { playerId, questId: ps.quest, questTitle: quest.title })

  if (ps.quest < QUESTS.length - 1) {
    ps.quest++
    ps.questProgress = 0
  }
}

export default {
  server: {
    setup(ctx) {
      ctx.state.progression = ctx.state.progression || {}
      ctx.state.spawnedMini = ctx.state.spawnedMini || false
      ctx.state.spawnedFinal = ctx.state.spawnedFinal || false

      ctx.bus.on('gold-coin-collected', (e) => {
        updateQuestProgress(ctx, e.playerId, 'collect', 'gold-coin')
        addXp(ctx, e.playerId, 10)
      })

      ctx.time.every(1, () => {
        ctx.players.getAll().forEach(p => {
          const ps = getPlayerState(ctx, p.id)
          ps.mana = Math.min(ps.mana + 5, ps.maxMana)

          Object.keys(ps.activeCooldowns).forEach(key => {
            ps.activeCooldowns[key] -= 1
            if (ps.activeCooldowns[key] <= 0) delete ps.activeCooldowns[key]
          })

          p.state.health = ps.health
          if (p.state.health <= 0) {
            ps.health = ps.maxHealth
            ctx.players.setPosition(p.id, [0, 2, 25])
          }
        })
      })

      ctx.time.every(5, () => {
        const goblins = ctx.world.query(e => e.custom?.enemyType === 'goblin')
        if (goblins.length < 5) {
          const angle = Math.random() * Math.PI * 2
          const dist = 15 + Math.random() * 20
          ctx.world.spawn(null, {
            position: [Math.cos(angle) * dist, 1, Math.sin(angle) * dist],
            app: 'goblin',
            config: {}
          })
        }
      })

      ctx.time.every(8, () => {
        const coins = ctx.world.query(e => e.custom?.itemType === 'gold-coin')
        if (coins.length < 10) {
          const angle = Math.random() * Math.PI * 2
          const dist = 15 + Math.random() * 30
          ctx.world.spawn(null, {
            position: [Math.cos(angle) * dist, 0.5, Math.sin(angle) * dist],
            app: 'gold-coin',
            config: {}
          })
        }
      })

      ctx.time.every(1, () => {
        ctx.players.getAll().forEach(p => {
          const ps = getPlayerState(ctx, p.id)
          const tower = ctx.world.getEntity('tower-base')
          if (tower) {
            const dist = Math.hypot(p.state.position[0] - tower.position[0], p.state.position[2] - tower.position[2])
            if (dist < 5) {
              updateQuestProgress(ctx, p.id, 'reach', 'tower-base')
            }
          }
        })
      })

      ctx.time.every(15, () => {
        if (!ctx.state.spawnedMini) {
          const miniCount = ctx.world.query(e => e.custom?.enemyType === 'mini-boss').length
          if (miniCount === 0) {
            ctx.world.spawn('mini-boss-1', {
              position: [25, 1, -25],
              app: 'mini-boss',
              config: {}
            })
            ctx.state.spawnedMini = true
          }
        }
      })

      ctx.time.every(20, () => {
        if (!ctx.state.spawnedFinal) {
          ctx.players.getAll().forEach(p => {
            const ps = getPlayerState(ctx, p.id)
            if (ps.quest >= 4) {
              const bossCount = ctx.world.query(e => e.custom?.enemyType === 'final-boss').length
              if (bossCount === 0) {
                ctx.world.spawn('final-boss-1', {
                  position: [0, 1, -40],
                  app: 'final-boss',
                  config: {}
                })
                ctx.state.spawnedFinal = true
              }
            }
          })
        }
      })

      ctx.onMessage((ctx_msg, msg) => {
        if (!msg) return
        if (msg.type === 'player_join') {
          const playerId = msg.playerId || msg.senderId
          getPlayerState(ctx, playerId)
        }
        if (msg.type === 'cast_ability') {
          castAbility(ctx, msg.playerId || msg.senderId, msg.abilityId, msg.targetPos || [0, 0, 0])
        }
      })

      ctx.bus.on('system.playerAdded', (e) => {
        getPlayerState(ctx, e.playerId)
      })
    },

    update(ctx, dt) {
      const progression = ctx.state.progression || {}
      const player = ctx.players.getById(ctx.entity.id)
      if (player && progression[player.id]) {
        const ps = progression[player.id]
        player.state.health = ps.health
      }
    },

    onMessage(ctx, msg) {
      if (!msg) return
      if (msg.type === 'cast_ability') {
        castAbility(ctx, msg.playerId || msg.senderId, msg.abilityId, msg.targetPos || [0, 0, 0])
      }
    },

    teardown(ctx) {}
  },

  client: {
    setup(engine) {
      engine.playerState = {
        level: 1,
        xp: 0,
        maxXp: 100,
        health: 100,
        maxHealth: 100,
        mana: 100,
        maxMana: 100,
        quest: 0,
        questProgress: 0,
        questTarget: 3,
        unlockedAbilities: ['attack']
      }

      engine.on('onEvent', (msg) => {
        if (msg.type === 'player.levelup') {
          engine.playerState.level = msg.newLevel
          engine.playerState.xp = 0
          if (msg.unlockedAbility) {
            engine.playerState.unlockedAbilities.push(msg.unlockedAbility)
          }
        } else if (msg.type === 'quest.completed') {
          engine.playerState.quest++
          engine.playerState.questProgress = 0
        }
      })
    },

    render(ctx) {
      const s = ctx.entity.custom || {}
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: s
      }
    },

    onInput(input, engine) {
      if (input.shoot && input.shoot.length > 0) {
        const ability = input.shoot[0]
        const dir = engine.cam.getAimDirection(engine.players[0]?.state.position || [0, 0, 0])
        engine.network.send({
          type: 'cast_ability',
          abilityId: 'attack',
          targetPos: [
            engine.players[0]?.state.position[0] + dir[0] * 10,
            engine.players[0]?.state.position[1],
            engine.players[0]?.state.position[2] + dir[2] * 10
          ]
        })
      }

      const numKeys = Object.keys(input).filter(k => /^\d+$/.test(k))
      numKeys.forEach(key => {
        if (input[key]) {
          const abilityMap = { '1': 'attack', '2': 'fireball', '3': 'lightning-storm' }
          const ability = abilityMap[key]
          if (ability && engine.playerState.unlockedAbilities.includes(ability)) {
            const dir = engine.cam.getAimDirection(engine.players[0]?.state.position || [0, 0, 0])
            engine.network.send({
              type: 'cast_ability',
              abilityId: ability,
              targetPos: [
                engine.players[0]?.state.position[0] + dir[0] * 15,
                engine.players[0]?.state.position[1],
                engine.players[0]?.state.position[2] + dir[2] * 15
              ]
            })
          }
        }
      })
    },

    onKeyDown(e, engine) {
      const key = e.key.toLowerCase()
      const abilityMap = { '1': 'attack', '2': 'fireball', '3': 'lightning-storm' }
      const ability = abilityMap[key]

      if (ability && engine.playerState.unlockedAbilities.includes(ability)) {
        const players = engine.client.state?.players || []
        const myPlayer = players.find(p => p.id === engine.playerId)
        if (myPlayer) {
          const dir = engine.cam.getAimDirection(myPlayer.state.position)
          engine.network.send({
            type: 'cast_ability',
            abilityId: ability,
            targetPos: [
              myPlayer.state.position[0] + dir[0] * 15,
              myPlayer.state.position[1],
              myPlayer.state.position[2] + dir[2] * 15
            ]
          })
        }
      }
    },

    onFrame(dt, engine) {
      const players = engine.client.state?.players || []
      const myPlayer = players.find(p => p.id === engine.playerId)

      if (myPlayer) {
        engine.playerState.health = myPlayer.state.health
      }
    }
  }
}
