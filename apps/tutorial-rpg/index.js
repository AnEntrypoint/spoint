import { defineQuestSystem } from '../../src/game/QuestSystem.js'
import { defineStatsSystem } from '../../src/game/StatsSystem.js'
import { definePlayerInventory } from '../_lib/inventory.js'

const CHANNELS = { stats: 'tutorial-rpg.stats', quests: 'tutorial-rpg.quests', inventory: 'tutorial-rpg.inventory', levelUp: 'tutorial-rpg.levelUp' }
const SYNC_REQUEST = 'tutorial-rpg.sync'
const WORLD_ENTITY_ID = 'tutorial-world'
const FIRST_QUEST_ID = 'quest-1-kill-rats'
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
      { type: 'reachLocation', location: [100, 10, 100], radius: 10, description: 'Reach the shrine' },
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

const welcome = (ctx, playerId) => {
  for (const itemId of STARTING_GEAR) ctx.progression.equipItem(playerId, itemId)
  ctx.quests.startQuest(playerId, FIRST_QUEST_ID)
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
