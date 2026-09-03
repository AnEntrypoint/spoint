// Tutorial RPG: 5-quest progression chain with stats scaling and loadout system
// Tests: quest completion -> XP gain -> level up -> stat scaling -> equipment bonuses -> loadout save/swap

import { defineQuestSystem } from '../../src/game/QuestSystem.js'
import { defineStatsSystem } from '../../src/game/StatsSystem.js'
import { defineGameFSM } from '../_lib/game-fsm.js'
import { definePlayerInventory } from '../_lib/inventory.js'

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

export const server = {
  async setup(ctx) {
    // Initialize systems
    ctx.progression = defineStatsSystem({
      startLevel: 1,
      startXP: 0,
      xpPerLevel: 100,
      maxLevel: 50,
      baseStats: {
        health: 100,
        mana: 50,
        damage: 10,
        defense: 5,
        speed: 1.0,
      },
      statScaling: {
        // Level 1 = 100 HP, Level 50 = 100 + 49*10 = 590 HP (formula: 100 + (level-1)*10)
        health: 10,
        mana: 5,
        damage: 0.5,
        defense: 0.25,
        speed: 0,
      },
      equipment: EQUIPMENT_CATALOG,
      onLevelUp: (ctx, data) => {
        console.log(`[TutorialRPG] Player ${data.playerId} leveled up to ${data.level}!`)
        ctx.world?.sendToEntity?.('world', { type: 'levelUp', playerId: data.playerId, level: data.level })
      },
      onLoadoutSwap: (ctx, data) => {
        console.log(`[TutorialRPG] Player ${data.playerId} swapped loadout`)
      },
    }, ctx)

    ctx.quests = defineQuestSystem({
      quests: QUEST_DEFINITIONS,
      onQuestStart: (ctx, data) => {
        console.log(`[TutorialRPG] Player ${data.playerId} started quest ${data.questId}`)
      },
      onQuestComplete: (ctx, data) => {
        console.log(`[TutorialRPG] Player ${data.playerId} completed quest ${data.questId}`)
      },
      onObjectiveProgress: (ctx, data) => {
        console.log(`[TutorialRPG] Quest progress: ${data.playerId} - ${data.questId} obj[${data.objectiveIndex}]: ${data.progress}/${data.target}`)
      },
    }, ctx)

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
    }, ctx)

    // Spawn world controller entity
    ctx.world.spawn('tutorial-world', {
      app: 'tutorial-rpg-world',
      position: [0, 0, 0],
    })

    console.log('[TutorialRPG] Server setup complete')
  },

  onPlayerJoin(ctx, playerId) {
    console.log(`[TutorialRPG] Player ${playerId} joined`)

    // Give starting equipment
    ctx.progression.equipItem(playerId, 'iron-sword')
    ctx.progression.equipItem(playerId, 'leather-armor')

    // Auto-start first quest
    ctx.quests.startQuest(playerId, 'quest-1-kill-rats')

    // Send initial state
    ctx.progression.getStats(playerId)
    ctx.inventory.push(playerId)
  },
}

export const client = {
  mount(engine, options) {
    console.log('[TutorialRPG] Client mounted')

    // Listen for quest updates
    engine.on('quests', (data) => {
      console.log('[TutorialRPG] Quest update:', data)
    })

    // Listen for stats updates
    engine.on('stats', (data) => {
      console.log('[TutorialRPG] Stats update: level', data.level, 'health', data.health)
    })

    // Listen for inventory updates
    engine.on('inventory', (data) => {
      console.log('[TutorialRPG] Inventory update:', data)
    })
  },

  onMessage(engine, msg) {
    if (msg.type === 'levelUp') {
      console.log(`[TutorialRPG] Player ${msg.playerId} leveled up to ${msg.level}`)
    }
  },
}
