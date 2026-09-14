import { defineQuestSystem } from '../../src/game/QuestSystem.js'
import { defineStatsSystem } from '../../src/game/StatsSystem.js'
import { definePlayerInventory } from '../_lib/inventory.js'
import { TUTORIAL_BUS } from '../_lib/tutorial-rpg-kit.js'

const CHANNELS = { stats: 'tutorial-rpg.stats', quests: 'tutorial-rpg.quests', inventory: 'tutorial-rpg.inventory', levelUp: 'tutorial-rpg.levelUp' }
const SYNC_REQUEST = 'tutorial-rpg.sync'
const WORLD_ENTITY_ID = 'tutorial-world'
const BOSS_QUEST_ID = 'quest-5-defeat-boss'
const STARTING_GEAR = ['iron-sword', 'leather-armor']

const QUEST_DEFINITIONS = {
  'quest-1-kill-rats': {
    title: 'Kill Rats in the Tutorial Village',
    description: 'The village is being overrun by rats. Slay 5 of them to help the townsfolk.',
    objectives: [
      { type: 'killN', count: 5, enemyType: 'rat', description: 'Kill 5 rats' },
    ],
    rewards: {
      xp: 50,
      items: { 'copper-ore': 2 },
      statBonuses: { health: 5, damage: 2 },
    },
  },
  'quest-2-collect-herbs': {
    title: 'Gather Healing Herbs',
    description: 'The healer needs healing herbs. Collect 8 herbs from the forest.',
    objectives: [
      { type: 'collectX', count: 8, itemId: 'herb', description: 'Collect 8 healing herbs' },
    ],
    rewards: {
      xp: 60,
      items: { 'mana-potion': 1 },
      statBonuses: { mana: 10 },
    },
  },
  'quest-3-reach-shrine': {
    title: 'Visit the Forest Shrine',
    description: 'Travel to the ancient shrine deep in the forest and commune with its spirits.',
    objectives: [
      { type: 'reachLocation', marker: 'shrine', description: 'Reach the Forest Shrine' },
    ],
    rewards: {
      xp: 75,
      items: { 'shrine-blessing': 1 },
      statBonuses: { defense: 5, speed: 0.1 },
    },
  },
  'quest-4-talk-elder': {
    title: 'Speak with the Village Elder',
    description: 'Return to the village elder and report your findings from the shrine.',
    objectives: [
      { type: 'talkToNPC', npcId: 'elder', description: 'Talk to the Elder' },
    ],
    rewards: {
      xp: 80,
      items: { 'elder-key': 1 },
      statBonuses: { damage: 5 },
    },
  },
  'quest-5-defeat-boss': {
    title: 'Defeat the Shadow Beast',
    description: 'A dark shadow beast has emerged from the ancient crypt. Defeat it to save the village.',
    objectives: [
      { type: 'killN', count: 1, enemyType: 'shadow-beast', description: 'Defeat the Shadow Beast' },
    ],
    rewards: {
      xp: 200,
      items: { 'shadow-core': 1, 'legendary-sword': 1 },
      statBonuses: { health: 30, damage: 20, defense: 10 },
    },
  },
}

const EQUIPMENT_CATALOG = {
  weapon: [
    { id: 'iron-sword', name: 'Iron Sword', slot: 'weapon', bonuses: { damage: 5 } },
    { id: 'steel-sword', name: 'Steel Sword', slot: 'weapon', bonuses: { damage: 10 } },
    { id: 'legendary-sword', name: 'Legendary Sword', slot: 'weapon', bonuses: { damage: 25, health: 10 } },
  ],
  armor: [
    { id: 'leather-armor', name: 'Leather Armor', slot: 'armor', bonuses: { defense: 3, health: 10 } },
    { id: 'iron-armor', name: 'Iron Armor', slot: 'armor', bonuses: { defense: 8, health: 25 } },
    { id: 'mithril-armor', name: 'Mithril Armor', slot: 'armor', bonuses: { defense: 15, health: 50 } },
  ],
  accessory: [
    { id: 'copper-ring', name: 'Copper Ring', slot: 'accessory', bonuses: { defense: 1 } },
    { id: 'silver-ring', name: 'Silver Ring', slot: 'accessory', bonuses: { mana: 10 } },
    { id: 'gold-ring', name: 'Gold Ring', slot: 'accessory', bonuses: { damage: 5, mana: 15 } },
  ],
}

const QUEST_ORDER = Object.keys(QUEST_DEFINITIONS)

const OBJECTIVE_MATCHERS = {
  kill: (enemyType) => (objective) => objective.type === 'killN' && objective.enemyType === enemyType,
  collect: (itemId) => (objective) => objective.type === 'collectX' && objective.itemId === itemId,
  talk: (npcId) => (objective) => objective.type === 'talkToNPC' && objective.npcId === npcId,
  reach: (marker) => (objective) => objective.type === 'reachLocation' && objective.marker === marker,
}

const questState = (ctx, playerId, questId) => ctx.quests.getQuestState(playerId, questId)?.state ?? null

const bossWanted = (ctx) => ctx.players.getAll().some(p => questState(ctx, p.id, BOSS_QUEST_ID) === 'active')

const turnInIfComplete = (ctx, playerId, questId) => {
  if (questState(ctx, playerId, questId) !== 'complete') return
  for (const objective of QUEST_DEFINITIONS[questId].objectives) {
    if (objective.type === 'collectX') ctx.inventory.remove(playerId, objective.itemId, objective.count)
  }
  ctx.quests.claimReward(playerId, questId)
  const nextQuestId = QUEST_ORDER[QUEST_ORDER.indexOf(questId) + 1]
  if (nextQuestId) beginQuest(ctx, playerId, nextQuestId)
}

const beginQuest = (ctx, playerId, questId) => {
  if (!ctx.quests.startQuest(playerId, questId)) return
  QUEST_DEFINITIONS[questId].objectives.forEach((objective, index) => {
    if (objective.type !== 'collectX') return
    const held = Math.min(ctx.inventory.count(playerId, objective.itemId), objective.count)
    if (held > 0) ctx.quests.completeObjective(playerId, questId, index, held)
  })
  if (questId === BOSS_QUEST_ID) ctx.bus.emit(TUTORIAL_BUS.bossState, { awake: true })
  turnInIfComplete(ctx, playerId, questId)
}

const creditActiveQuests = (ctx, playerId, matches) => {
  const activeQuestIds = QUEST_ORDER.filter(questId => questState(ctx, playerId, questId) === 'active')
  for (const questId of activeQuestIds) {
    QUEST_DEFINITIONS[questId].objectives.forEach((objective, index) => {
      if (matches(objective)) ctx.quests.completeObjective(playerId, questId, index, 1)
    })
    turnInIfComplete(ctx, playerId, questId)
  }
}

const wireObjectiveSources = (ctx) => {
  ctx.bus.on(TUTORIAL_BUS.strike, ({ data }) => {
    if (data?.playerId == null || data.targetId == null) return
    const amount = ctx.progression.getStats(data.playerId).damage
    ctx.bus.emit(TUTORIAL_BUS.hit, { targetId: data.targetId, playerId: data.playerId, amount })
  })
  ctx.bus.on(TUTORIAL_BUS.kill, ({ data }) => {
    for (const playerId of data?.playerIds ?? []) creditActiveQuests(ctx, playerId, OBJECTIVE_MATCHERS.kill(data.enemyType))
  })
  ctx.bus.on(TUTORIAL_BUS.collect, ({ data }) => {
    if (data?.playerId == null) return
    ctx.inventory.add(data.playerId, data.itemId, 1)
    creditActiveQuests(ctx, data.playerId, OBJECTIVE_MATCHERS.collect(data.itemId))
  })
  ctx.bus.on(TUTORIAL_BUS.talk, ({ data }) => {
    if (data?.playerId != null) creditActiveQuests(ctx, data.playerId, OBJECTIVE_MATCHERS.talk(data.npcId))
  })
  ctx.bus.on(TUTORIAL_BUS.reach, ({ data }) => {
    if (data?.playerId != null) creditActiveQuests(ctx, data.playerId, OBJECTIVE_MATCHERS.reach(data.marker))
  })
  ctx.bus.on(TUTORIAL_BUS.bossQuery, () => ctx.bus.emit(TUTORIAL_BUS.bossState, { awake: bossWanted(ctx) }))
}

const welcome = (ctx, playerId) => {
  for (const itemId of STARTING_GEAR) ctx.progression.equipItem(playerId, itemId)
  beginQuest(ctx, playerId, QUEST_ORDER[0])
  ctx.inventory.push(playerId)
}

const pushAll = (ctx, playerId) => {
  ctx.progression.push(playerId)
  ctx.quests.push(playerId)
  ctx.inventory.push(playerId)
}

export const server = {
  setup(ctx) {
    ctx.progression = defineStatsSystem({
      startLevel: 1,
      startXP: 0,
      xpPerLevel: 100,
      maxLevel: 50,
      baseStats: { health: 100, mana: 50, damage: 10, defense: 5, speed: 1.0 },
      statScaling: { health: 10, mana: 5, damage: 0.5, defense: 0.25, speed: 0 },
      equipment: EQUIPMENT_CATALOG,
      channel: CHANNELS.stats,
      onLevelUp: (appCtx, { playerId, level }) => appCtx.players.send(playerId, { type: CHANNELS.levelUp, playerId, level }),
    }, ctx)

    ctx.quests = defineQuestSystem({ quests: QUEST_DEFINITIONS, channel: CHANNELS.quests }, ctx)

    ctx.inventory = definePlayerInventory({
      startItems: { herb: 0, 'copper-ore': 0 },
      startCurrency: 100,
      itemDefs: {
        herb: { maxStack: 20 },
        'copper-ore': { maxStack: 30 },
        'mana-potion': { maxStack: 10 },
        'shrine-blessing': { maxStack: 1 },
        'elder-key': { maxStack: 1 },
        'shadow-core': { maxStack: 1 },
        'legendary-sword': { maxStack: 1 },
      },
      channel: CHANNELS.inventory,
    }, ctx)

    wireObjectiveSources(ctx)
    if (!ctx.world.getEntity(WORLD_ENTITY_ID)) ctx.world.spawnChild(WORLD_ENTITY_ID, { app: 'tutorial-rpg-world', position: [0, 0, 0] })
    for (const player of ctx.players.getAll()) welcome(ctx, player.id)
  },

  onMessage(ctx, msg) {
    if (msg?.type === 'player_join' && msg.playerId != null) welcome(ctx, msg.playerId)
    else if (msg?.type === SYNC_REQUEST && msg.senderId != null) pushAll(ctx, msg.senderId)
  },
}

const CLIENT_SLOT_BY_CHANNEL = { [CHANNELS.stats]: 'stats', [CHANNELS.inventory]: 'inventory', [CHANNELS.levelUp]: 'lastLevelUp' }

export const client = {
  setup(engine) {
    engine._tutorialRpg = { stats: null, inventory: null, lastLevelUp: null, quests: {} }
    engine.network.send({ type: SYNC_REQUEST })
  },

  onEvent(payload, engine) {
    const rpg = engine._tutorialRpg
    if (!rpg || typeof payload?.type !== 'string') return
    if (payload.type === CHANNELS.quests) { rpg.quests[payload.questId] = payload; return }
    const slot = CLIENT_SLOT_BY_CHANNEL[payload.type]
    if (slot) rpg[slot] = payload
  },
}
