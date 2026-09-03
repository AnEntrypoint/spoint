import {
  createProgressionSystem,
  createAbilityTree,
  DEFAULT_ABILITIES,
  HOTKEY_MAP,
  DEFAULT_CONFIG,
  getStatScaling
} from '../../src/game/index.js'

export function defineProgression(spec = {}) {
  const progressionCfg = {
    ...DEFAULT_CONFIG,
    ...spec.progressionConfig
  }

  const progression = createProgressionSystem(progressionCfg)
  const abilityTree = createAbilityTree(spec.abilities || DEFAULT_ABILITIES, spec.hotkeys || HOTKEY_MAP)

  const system = {
    progression,
    abilityTree,

    setup(ctx) {
      ctx.progression = {
        addXp(amount) {
          const playerId = ctx.entity.id
          const leveledUp = progression.addXp(playerId, amount)
          if (leveledUp) {
            const state = progression.getState(playerId)
            ctx.world.sendToEntity(playerId, {
              type: 'progression',
              event: 'levelUp',
              level: state.level,
              xp: state.xp,
              totalXp: state.totalXp
            })
            if (spec.onLevelUp) spec.onLevelUp(ctx, state.level)
          }
          return leveledUp
        },

        getProgress() {
          const playerId = ctx.entity.id
          return progression.getProgress(playerId)
        },

        getLevel() {
          const playerId = ctx.entity.id
          const state = progression.getState(playerId)
          return state ? state.level : 1
        },

        getXp() {
          const playerId = ctx.entity.id
          const state = progression.getState(playerId)
          return state ? state.xp : 0
        },

        getTotalXp() {
          const playerId = ctx.entity.id
          const state = progression.getState(playerId)
          return state ? state.totalXp : 0
        },

        castAbility(abilityId) {
          const level = this.getLevel()
          return abilityTree.castAbility(ctx.entity.id, abilityId, level)
        },

        canCastAbility(abilityId) {
          const level = this.getLevel()
          return abilityTree.canCastAbility(ctx.entity.id, abilityId)
        },

        getAbilityCooldown(abilityId) {
          return abilityTree.getAbilityCooldown(ctx.entity.id, abilityId)
        },

        getUnlockedAbilities() {
          const level = this.getLevel()
          return abilityTree.getUnlockedAbilities(level)
        },

        getAbilityInfo() {
          const level = this.getLevel()
          return abilityTree.getPlayerAbilityInfo(ctx.entity.id, level)
        },

        bindHotkey(hotkeyNumber, abilityId) {
          return abilityTree.bindHotkey(hotkeyNumber, abilityId)
        },

        getStatScaling(baseValue) {
          const level = this.getLevel()
          return getStatScaling(level, baseValue, progressionCfg.curve)
        }
      }

      if (spec.setup) {
        spec.setup(ctx)
      }
    },

    tick(ctx, dt) {
      progression.tick(dt)
      abilityTree.tick(dt)

      const playerId = ctx.entity.id
      const levelUpEvents = progression.drainLevelUpEvents(playerId)
      for (const evt of levelUpEvents) {
        if (spec.onLevelUpTick) {
          spec.onLevelUpTick(ctx, evt.level)
        }
      }

      if (spec.tick) {
        spec.tick(ctx, dt)
      }
    },

    snapshotGameState(state) {
      state.progression = progression.buildSnapshot()
      state.abilityTree = abilityTree.buildSnapshot()
      return state
    },

    restoreGameState(state) {
      if (state.progression) {
        progression.applySnapshot(state.progression)
      }
      if (state.abilityTree) {
        abilityTree.applySnapshot(state.abilityTree)
      }
      return state
    },

    onPlayerJoin(playerId) {
      progression.getPlayerState(playerId)
      abilityTree.getPlayerAbilityState(playerId)
    },

    onPlayerLeave(playerId) {
      progression.removePlayer(playerId)
      abilityTree.removePlayer(playerId)
    },

    getNetworkState(playerId) {
      return {
        progression: progression.getProgress(playerId),
        abilityTree: {
          unlockedAbilities: abilityTree.getUnlockedAbilities(progression.getState(playerId).level),
          cooldowns: abilityTree.getCooldownsForNetwork(playerId)
        }
      }
    }
  }

  return system
}

export { DEFAULT_ABILITIES, HOTKEY_MAP, DEFAULT_CONFIG, getStatScaling }
