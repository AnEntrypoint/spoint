const XP_TO_NEXT_LEVEL = [0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700, 3250]
const MAX_LEVEL = 10
const PROGRESS_EVENT = 'rpg-progress'
const CAST_MESSAGE = 'cast_ability'
const RESPAWN_POSITION = [0, 2, 25]
const TOWER_ENTITY_ID = 'tower-base'
const TOWER_REACH_RADIUS = 5
const MANA_REGEN_PER_SECOND = 5
const HEALTH_PER_LEVEL = 10
const MANA_PER_LEVEL = 20
const COIN_XP = 10
const DEFAULT_ENEMY_XP = 10
const DEFAULT_ENEMY_HEALTH = 10
const GOBLIN_CAP = 5
const COIN_CAP = 10

const QUESTS = [
  { id: 0, title: 'Kill 3 Goblins', objectiveType: 'kill', targetType: 'goblin', count: 3, xpReward: 30 },
  { id: 1, title: 'Collect 5 Gold Coins', objectiveType: 'collect', targetType: 'gold-coin', count: 5, xpReward: 50 },
  { id: 2, title: 'Reach the Tower', objectiveType: 'reach', targetType: 'tower-base', count: 1, xpReward: 75 },
  { id: 3, title: 'Defeat the Mini-Boss', objectiveType: 'kill', targetType: 'mini-boss', count: 1, xpReward: 100 },
  { id: 4, title: 'Defeat the Final Boss', objectiveType: 'kill', targetType: 'final-boss', count: 1, xpReward: 150 }
]

const ABILITIES_BY_UNLOCK_LEVEL = {
  1: { id: 'attack', name: 'Attack', cooldown: 0, manaCost: 0, damage: 10, range: 3 },
  5: { id: 'fireball', name: 'Fireball', cooldown: 5, manaCost: 20, damage: 30, range: 20 },
  10: { id: 'lightning-storm', name: 'Lightning Storm', cooldown: 10, manaCost: 50, damage: 60, range: 15 }
}
const ABILITIES = Object.values(ABILITIES_BY_UNLOCK_LEVEL)
const ABILITY_KEYS = { 1: 'attack', 2: 'fireball', 3: 'lightning-storm' }
const ABILITY_HOTKEYS = Object.fromEntries(Object.entries(ABILITY_KEYS).map(([key, id]) => [id, Number(key)]))

const xpToNext = (level) => XP_TO_NEXT_LEVEL[Math.min(level, MAX_LEVEL)]

const horizontalDistSq = (a, b) => (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2

const progressOf = (ctx, playerId) => {
  const players = ctx.state.rpgPlayers || (ctx.state.rpgPlayers = {})
  return players[playerId] || (players[playerId] = {
    level: 1, xp: 0, health: 100, maxHealth: 100, mana: 100, maxMana: 100,
    quest: 0, questProgress: 0, unlockedAbilities: ['attack'], cooldowns: {}
  })
}

const sendProgress = (ctx, playerId) => {
  const ps = progressOf(ctx, playerId)
  const quest = QUESTS[ps.quest]
  ctx.players.send(playerId, {
    type: PROGRESS_EVENT,
    level: ps.level,
    xp: ps.xp,
    xpToNext: xpToNext(ps.level),
    health: ps.health,
    maxHealth: ps.maxHealth,
    mana: ps.mana,
    maxMana: ps.maxMana,
    quest: ps.quest,
    questTitle: quest?.title ?? null,
    questProgress: ps.questProgress,
    questTarget: quest?.count ?? 0,
    unlockedAbilities: [...ps.unlockedAbilities],
    cooldowns: { ...ps.cooldowns }
  })
}

const addXp = (ctx, playerId, amount) => {
  const ps = progressOf(ctx, playerId)
  ps.xp += amount
  while (ps.level < MAX_LEVEL && ps.xp >= xpToNext(ps.level)) {
    ps.xp -= xpToNext(ps.level)
    ps.level++
    ps.maxHealth += HEALTH_PER_LEVEL
    ps.health = ps.maxHealth
    ps.maxMana += MANA_PER_LEVEL
    ps.mana = ps.maxMana
    const player = ctx.players.getById(playerId)
    if (player?.state) player.state.health = ps.health
    const unlocked = ABILITIES_BY_UNLOCK_LEVEL[ps.level]
    if (unlocked) ps.unlockedAbilities.push(unlocked.id)
    ctx.bus.emit('player.levelup', { playerId, newLevel: ps.level, unlockedAbility: unlocked?.name ?? null })
  }
}

const advanceQuest = (ctx, playerId, objectiveType, targetType) => {
  const ps = progressOf(ctx, playerId)
  const quest = QUESTS[ps.quest]
  if (!quest || quest.objectiveType !== objectiveType || quest.targetType !== targetType) return
  ps.questProgress++
  if (ps.questProgress < quest.count) return
  ctx.bus.emit('quest.completed', { playerId, questId: quest.id, questTitle: quest.title })
  ps.quest++
  ps.questProgress = 0
  addXp(ctx, playerId, quest.xpReward)
}

const damageEnemy = (ctx, playerId, enemy, damage) => {
  const custom = enemy.custom
  const health = Math.max(0, (custom.health ?? custom.maxHealth ?? DEFAULT_ENEMY_HEALTH) - damage)
  enemy.custom = { ...custom, health, isDamaged: true }
  if (health > 0) return
  ctx.world.destroy(enemy.id)
  addXp(ctx, playerId, custom.xpValue ?? DEFAULT_ENEMY_XP)
  advanceQuest(ctx, playerId, 'kill', custom.enemyType)
}

const castAbility = (ctx, playerId, abilityId) => {
  const ps = progressOf(ctx, playerId)
  const ability = ABILITIES.find(a => a.id === abilityId)
  if (!ability || !ps.unlockedAbilities.includes(abilityId)) return
  if (ps.mana < ability.manaCost || ps.cooldowns[abilityId]) return
  const origin = ctx.players.getById(playerId)?.state?.position
  if (!origin) return
  ps.mana -= ability.manaCost
  if (ability.cooldown > 0) ps.cooldowns[abilityId] = ability.cooldown
  const rangeSq = ability.range * ability.range
  const targets = ctx.world.query(e => !!e.custom?.enemyType && !!e.position && horizontalDistSq(e.position, origin) <= rangeSq)
  for (const enemy of targets) damageEnemy(ctx, playerId, enemy, ability.damage)
  sendProgress(ctx, playerId)
}

const spawnAround = (ctx, app, minDist, spread, y) => {
  const angle = Math.random() * Math.PI * 2
  const dist = minDist + Math.random() * spread
  ctx.world.spawn(null, { position: [Math.cos(angle) * dist, y, Math.sin(angle) * dist], app, config: {} })
}

const tickPlayers = (ctx) => {
  const tower = ctx.world.getEntity(TOWER_ENTITY_ID)
  const reachSq = TOWER_REACH_RADIUS * TOWER_REACH_RADIUS
  for (const p of ctx.players.getAll()) {
    const ps = progressOf(ctx, p.id)
    ps.mana = Math.min(ps.mana + MANA_REGEN_PER_SECOND, ps.maxMana)
    for (const id of Object.keys(ps.cooldowns)) if (--ps.cooldowns[id] <= 0) delete ps.cooldowns[id]
    if (Number.isFinite(p.state?.health)) ps.health = Math.min(p.state.health, ps.maxHealth)
    if (ps.health <= 0) {
      ps.health = ps.maxHealth
      p.state.health = ps.maxHealth
      ctx.players.setPosition(p.id, RESPAWN_POSITION)
    }
    const pos = p.state?.position
    if (tower && pos && horizontalDistSq(pos, tower.position) < reachSq) advanceQuest(ctx, p.id, 'reach', TOWER_ENTITY_ID)
    sendProgress(ctx, p.id)
  }
}

export default {
  server: {
    setup(ctx) {
      ctx.state.spawnedMini = ctx.state.spawnedMini || false
      ctx.state.spawnedFinal = ctx.state.spawnedFinal || false

      ctx.bus.on('gold-coin-collected', ({ data }) => {
        if (data?.playerId == null) return
        addXp(ctx, data.playerId, COIN_XP)
        advanceQuest(ctx, data.playerId, 'collect', 'gold-coin')
        sendProgress(ctx, data.playerId)
      })

      ctx.time.every(1, () => tickPlayers(ctx))

      ctx.time.every(5, () => {
        if (ctx.world.query(e => e.custom?.enemyType === 'goblin').length < GOBLIN_CAP) spawnAround(ctx, 'goblin', 15, 20, 1)
      })

      ctx.time.every(8, () => {
        if (ctx.world.query(e => e.custom?.itemType === 'gold-coin').length < COIN_CAP) spawnAround(ctx, 'gold-coin', 15, 30, 0.5)
      })

      ctx.time.every(15, () => {
        if (ctx.state.spawnedMini || ctx.world.query(e => e.custom?.enemyType === 'mini-boss').length > 0) return
        ctx.world.spawn('mini-boss-1', { position: [25, 1, -25], app: 'mini-boss', config: {} })
        ctx.state.spawnedMini = true
      })

      ctx.time.every(20, () => {
        if (ctx.state.spawnedFinal) return
        const someoneOnFinalQuest = ctx.players.getAll().some(p => QUESTS[progressOf(ctx, p.id).quest]?.targetType === 'final-boss')
        if (!someoneOnFinalQuest || ctx.world.query(e => e.custom?.enemyType === 'final-boss').length > 0) return
        ctx.world.spawn('final-boss-1', { position: [0, 1, -40], app: 'final-boss', config: {} })
        ctx.state.spawnedFinal = true
      })
    },

    onMessage(ctx, msg) {
      if (msg?.type !== CAST_MESSAGE || msg.senderId == null) return
      castAbility(ctx, msg.senderId, msg.abilityId)
    }
  },

  client: {
    setup(engine) {
      engine._rpgTutorial = { progress: null, shootHeld: false }
    },

    onEvent(payload, engine) {
      if (payload?.type !== PROGRESS_EVENT) return
      const rpg = engine._rpgTutorial
      if (rpg) rpg.progress = payload
    },

    onInput(input, engine) {
      const rpg = engine._rpgTutorial
      if (!rpg?.progress) return
      const shooting = !!input.shoot
      if (shooting && !rpg.shootHeld) engine.network.send({ type: CAST_MESSAGE, abilityId: 'attack' })
      rpg.shootHeld = shooting
    },

    onKeyDown(e, engine) {
      const abilityId = ABILITY_KEYS[e.key]
      const unlocked = engine._rpgTutorial?.progress?.unlockedAbilities
      if (e.repeat || !abilityId || !unlocked?.includes(abilityId)) return
      engine.network.send({ type: CAST_MESSAGE, abilityId })
    },

    onFrame(dt, engine) {
      const progress = engine._rpgTutorial?.progress
      const render = engine.kit?.renderRpgProgressHud
      if (!progress || !render) return
      render({
        level: progress.level,
        xp: progress.xp,
        xpToNext: progress.xpToNext,
        health: progress.health,
        maxHealth: progress.maxHealth,
        mana: progress.mana,
        maxMana: progress.maxMana,
        questTitle: progress.questTitle,
        questProgress: progress.questProgress,
        questTarget: progress.questTarget,
        abilities: ABILITIES.map(a => ({
          id: a.id,
          name: a.name,
          hotkey: ABILITY_HOTKEYS[a.id],
          unlocked: progress.unlockedAbilities?.includes(a.id) ?? false,
          cooldownRemaining: progress.cooldowns?.[a.id] ?? 0,
          cooldownMax: a.cooldown
        }))
      })
    }
  }
}
