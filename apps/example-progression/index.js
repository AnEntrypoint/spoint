import { defineProgression, DEFAULT_ABILITIES, DEFAULT_CONFIG } from '../../apps/_lib/progression.js'

const customAbilities = [
  {
    id: 1,
    name: 'Slash',
    description: 'Quick melee attack',
    manaCost: 0,
    cooldown: 0.5,
    unlockLevel: 1,
    damage: 10
  },
  {
    id: 2,
    name: 'Power Strike',
    description: 'Heavy attack',
    manaCost: 15,
    cooldown: 3.0,
    unlockLevel: 5,
    damage: 30
  },
  {
    id: 3,
    name: 'Whirlwind',
    description: 'Spin attack hitting all nearby',
    manaCost: 25,
    cooldown: 5.0,
    unlockLevel: 15,
    damage: 40
  }
]

const progressionDef = defineProgression({
  progressionConfig: {
    curve: 'quadratic',
    baseXpPerLevel: 100,
    maxLevel: 50
  },
  abilities: customAbilities,

  onLevelUp(ctx, level) {
    ctx.world.sendToEntity(ctx.entity.id, {
      type: 'progression',
      event: 'levelUp',
      level,
      hp: getPlayerHp(level)
    })
  },

  setup(ctx) {
    ctx.state.maxHealth = getPlayerHp(1)
    ctx.state.currentHealth = ctx.state.maxHealth
    ctx.state.mana = 100
    ctx.state.maxMana = 100
  },

  tick(ctx, dt) {
    if (ctx.state.currentHealth < ctx.state.maxHealth) {
      ctx.state.currentHealth = Math.min(
        ctx.state.currentHealth + 5 * dt,
        ctx.state.maxHealth
      )
    }

    if (ctx.state.mana < ctx.state.maxMana) {
      ctx.state.mana = Math.min(
        ctx.state.mana + 30 * dt,
        ctx.state.maxMana
      )
    }
  }
})

function getPlayerHp(level) {
  return 100 + (level - 1) * 10
}

function getPlayerDamage(level) {
  return 10 + (level - 1) * 2
}

function canCastAbility(ctx, abilityId) {
  const ability = ctx.progression.abilityTree.getAbility(abilityId)
  if (!ability) return false
  if (ability.unlockLevel > ctx.progression.getLevel()) return false
  if (ctx.state.mana < ability.manaCost) return false
  if (!ctx.progression.abilityTree.canCastAbility(ctx.entity.id, abilityId)) return false
  return true
}

export default {
  name: 'example-progression',

  server: {
    setup: progressionDef.setup,

    tick: progressionDef.tick,

    onMessage(ctx, msg) {
      if (msg.type === 'attack') {
        const abilityId = msg.abilityId || 1

        if (!canCastAbility(ctx, abilityId)) {
          return
        }

        const ability = ctx.progression.abilityTree.getAbility(abilityId)
        ctx.state.mana -= ability.manaCost

        if (ctx.progression.abilityTree.castAbility(ctx.entity.id, abilityId, ctx.progression.getLevel())) {
          const baseDamage = getPlayerDamage(ctx.progression.getLevel())
          const totalDamage = baseDamage + ability.damage

          ctx.world.sendToEntity(ctx.entity.id, {
            type: 'combat',
            event: 'abilityCast',
            abilityId,
            damage: totalDamage
          })

          ctx.physics.addForce([0, 2, 0])
        }
      }

      if (msg.type === 'gainXp') {
        if (ctx.progression.addXp(msg.amount || 10)) {
          const progress = ctx.progression.getProgress()
          const newMaxHp = getPlayerHp(progress.level)
          ctx.state.maxHealth = newMaxHp
          ctx.state.currentHealth = newMaxHp

          ctx.world.sendToEntity(ctx.entity.id, {
            type: 'progression',
            event: 'levelUp',
            level: progress.level,
            hp: newMaxHp
          })
        }
      }

      if (msg.type === 'takeDamage') {
        ctx.state.currentHealth = Math.max(0, ctx.state.currentHealth - msg.damage)

        if (ctx.state.currentHealth <= 0) {
          ctx.world.destroy(ctx.entity.id)
        }
      }
    },

    onCollision(ctx, other, contacts) {
      if (other.custom?.isEnemy && ctx.state.currentHealth > 0) {
        ctx.world.sendToEntity(ctx.entity.id, {
          type: 'combat',
          event: 'enemyNear',
          enemyId: other.id
        })
      }
    }
  },

  client: {
    render(ctx, renderCtx, input) {
      if (!ctx.progression) return

      const progress = ctx.progression.getProgress()
      const abilityInfo = ctx.progression.getAbilityInfo()

      ctx.network.sendMessage({
        type: 'ui_update',
        level: progress.level,
        xp: progress.xp,
        maxXp: progress.xpForLevel,
        progress: progress.progressRatio,
        unlockedCount: abilityInfo.unlockedAbilities.length,
        abilities: abilityInfo.unlockedAbilities.map(a => ({
          id: a.id,
          name: a.name,
          cooldown: abilityInfo.cooldowns.find(c => c.abilityId === a.id)?.remaining || 0
        }))
      })
    },

    onInput(input) {
      if (!input.keys) return
      for (let i = 1; i <= 9; i++) {
        if (input.keys[String(i)]) {
          const abilityId = ctx.progression.abilityTree.getHotkeyBinding(i)
          if (abilityId) {
            ctx.network.sendMessage({
              type: 'attack',
              abilityId
            })
          }
        }
      }

      if (input.keys.e) {
        ctx.network.sendMessage({
          type: 'gainXp',
          amount: 50
        })
      }
    }
  }
}
