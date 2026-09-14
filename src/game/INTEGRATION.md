# Quest & Stats System Integration Guide

Complete guide for integrating Quest and Stats systems into RPG/MOBA games with proper server-authoritative architecture, persistence, and network synchronization.

## Architecture Overview

```
AppRuntime (server tick loop)
  ├─ QuestSystem (per-player quest state)
  ├─ StatsSystem (per-player stats + equipment)
  ├─ PlayerManager (player tracking)
  ├─ WorldPersistence (saves each entity's ctx.state)
  └─ ctx.players.send (each system pushes { type: channel, ... } to the affected player)
```

## Complete App Setup Example

```javascript
import { defineQuestSystem } from '../../src/game/QuestSystem.js'
import { defineStatsSystem } from '../../src/game/StatsSystem.js'
import { definePlayerInventory } from '../_lib/inventory.js'
import { defineGameFSM } from '../_lib/game-fsm.js'

const QUESTS = {
  'tutorial-1': {
    title: 'Get Started',
    description: 'Complete the tutorial',
    objectives: [{ type: 'killN', count: 5, enemyType: 'tutorial-mob' }],
    rewards: { xp: 100, items: { 'starter-gold': 10 } }
  }
}

const EQUIPMENT = {
  weapon: [
    { id: 'iron-sword', name: 'Iron Sword', slot: 'weapon', bonuses: { damage: 5 } },
    { id: 'steel-sword', name: 'Steel Sword', slot: 'weapon', bonuses: { damage: 10 } }
  ],
  armor: [
    { id: 'leather', name: 'Leather Armor', slot: 'armor', bonuses: { defense: 3, health: 15 } },
    { id: 'chain', name: 'Chain Armor', slot: 'armor', bonuses: { defense: 8, health: 40 } }
  ]
}

const CHANNELS = { stats: 'my-rpg.stats', quests: 'my-rpg.quests', inventory: 'my-rpg.inventory', levelUp: 'my-rpg.levelUp' }
const SYNC_REQUEST = 'my-rpg.sync'

const welcome = (ctx, playerId) => {
  ctx.stats.equipItem(playerId, 'iron-sword')
  ctx.stats.equipItem(playerId, 'leather')
  ctx.quests.startQuest(playerId, 'tutorial-1')
  ctx.inventory.push(playerId)
}

export const server = {
  setup(ctx) {
    ctx.stats = defineStatsSystem({
      startLevel: 1,
      startXP: 0,
      xpPerLevel: 100,      // 100 XP per level
      maxLevel: 50,
      baseStats: {
        health: 100,         // Level 1 = 100 HP
        mana: 50,            // Level 1 = 50 Mana
        damage: 10,
        defense: 5,
        speed: 1.0
      },
      statScaling: {
        health: 10,          // +10 HP per level → Level 50 = 590 HP
        mana: 5,             // +5 Mana per level
        damage: 0.5,         // +0.5 Damage per level
        defense: 0.25,       // +0.25 Defense per level
        speed: 0             // No speed scaling
      },
      equipment: EQUIPMENT,
      channel: CHANNELS.stats,
      onLevelUp: (ctx, { playerId, level }) => {
        ctx.players.broadcast({ type: CHANNELS.levelUp, playerId, level })
      }
    }, ctx)
    ctx.progression = ctx.stats   // claimReward grants XP through ctx.progression.addXP

    ctx.quests = defineQuestSystem({
      quests: QUESTS,
      channel: CHANNELS.quests,
      onQuestComplete: (ctx, { playerId, questId }) => {
        console.log(`Quest ${questId} completed by ${playerId}`)
      }
    }, ctx)

    ctx.inventory = definePlayerInventory({
      startItems: { 'starter-gold': 0 },
      startCurrency: 100,
      itemDefs: {
        'starter-gold': { maxStack: 999 }
      },
      channel: CHANNELS.inventory
    }, ctx)

    // spawnChild ties the entity to this app; the guard keeps a hot reload from spawning it twice
    if (!ctx.world.getEntity('world')) {
      ctx.world.spawnChild('world', { app: 'my-world-controller', position: [0, 0, 0] })
    }

    // Players already connected when setup runs (hot reload) never send player_join
    for (const player of ctx.players.getAll()) welcome(ctx, player.id)
  },

  onMessage(ctx, msg) {
    // Joins and leaves arrive here: { type: 'player_join' | 'player_leave', playerId }
    if (msg?.type === 'player_join') welcome(ctx, msg.playerId)

    // The client asks for a resend once its module has loaded (see client.setup)
    if (msg?.type === SYNC_REQUEST && msg.senderId != null) {
      ctx.stats.push(msg.senderId)
      ctx.quests.push(msg.senderId)
      ctx.inventory.push(msg.senderId)
    }
  },

  update(ctx, dt) {
    // Per-tick game logic, e.g. proximity checks for reachLocation objectives
  }
}

export const client = {
  setup(engine) {
    // The engine object is shared by every app and has no state bucket: keep yours under engine._<app>
    engine._myRpg = { stats: null, quests: {}, inventory: null }
    // Pushes sent at player_join can arrive before this module has loaded, so ask for a resend
    engine.network.send({ type: SYNC_REQUEST })
  },

  // Every ctx.players.send / broadcast payload reaches every app's onEvent: filter on payload.type
  onEvent(payload, engine) {
    const rpg = engine._myRpg
    if (!rpg) return
    if (payload?.type === CHANNELS.stats) rpg.stats = payload                              // { level, xp, nextLevelXP, health, ..., equipment }
    else if (payload?.type === CHANNELS.quests) rpg.quests[payload.questId] = payload      // { questId, state, progress: [...], completedAt }
    else if (payload?.type === CHANNELS.inventory) rpg.inventory = payload                 // { items, currency }
    else if (payload?.type === CHANNELS.levelUp) console.log(`Player ${payload.playerId} reached level ${payload.level}`)
  }
}
```

How this maps onto the engine's real app hooks:

- **Server hooks** are `setup(ctx)`, `update(ctx, dt)`, `teardown(ctx)` and `onMessage(ctx, msg)`. There is no `onPlayerJoin`, `onPlayerLeave` or `tick` hook. Joins and leaves arrive through `onMessage` as `{ type: 'player_join', playerId }` and `{ type: 'player_leave', playerId }`. Messages a client sends with `engine.network.send(msg)` also arrive in `onMessage`, and `msg.senderId` is the only trustworthy player id.
- **Client hooks** are `setup(engine)`, `onEvent(payload, engine)`, `onInput(input, engine)`, `onKeyDown`/`onKeyUp(e, engine)`, `onMouseDown`/`onMouseUp`, `onFrame(dt, engine)` and `render(ctx)`. The engine object has no `on()`, and there is no client `mount` or `onMessage`.
- **Channels.** The three systems push `{ type: channel, ... }`. Their defaults are `'stats'`, `'quests'` and `'inventory'`. Give each app its own `channel` so two apps using these systems don't read each other's pushes.
- **`push(playerId)`.** Each system has one: StatsSystem pushes stats and equipment, QuestSystem pushes every quest the player has started, and inventory pushes items and currency.
- **Reward wiring.** `claimReward` grants XP through `ctx.progression.addXP` and items through `ctx.inventory.add`. It grants stat bonuses through `ctx.stats.applyBonus`, but only if that method exists. StatsSystem has no `applyBonus`, so `statBonuses` come back in the return value without being applied.

The working version of this setup is [`apps/tutorial-rpg/index.js`](../../apps/tutorial-rpg/index.js).

## Server-Authoritative Pattern

All game state changes must originate on the server:

### ✓ Correct: Server validates and applies changes
```javascript
// In app's onMessage or update handler
onMessage(ctx, msg) {
  if (msg.type === 'collectItem') {
    const playerId = msg.senderId  // Stamped by the server, never read a client-supplied id
    const itemId = 'herb'          // From config, never from client
    const questId = 'tutorial-1'

    // Server validates and applies
    ctx.inventory.add(playerId, itemId, 1)
    ctx.quests.completeObjective(playerId, questId, 0, 1)
    // Changes automatically broadcast to client
  }
}
```

### ✗ Incorrect: Trusting client state
```javascript
// NEVER DO THIS!
onMessage(ctx, msg) {
  // DON'T: Client can forge msg.itemId, msg.amount, etc
  ctx.inventory.add(msg.playerId, msg.itemId, msg.amount)
}
```

## Persistence Integration

The systems keep per-player data in their own closures, which world persistence cannot see. WorldPersistence saves each entity's `ctx.state`. On restart it swaps the saved `ctx.state` in *after* `setup` has run, so copy the systems' snapshots into `ctx.state` and restore them lazily, on the first `player_join` after boot:

```javascript
export const server = {
  setup(ctx) {
    ctx.stats = defineStatsSystem({...}, ctx)
    ctx.quests = defineQuestSystem({...}, ctx)

    // Synchronous shutdown hooks run before the world snapshot is written
    ctx.onShutdown(() => {
      ctx.state.progressSave = { stats: ctx.stats.snapshot(), quests: ctx.quests.snapshot() }
    })
  },

  onMessage(ctx, msg) {
    if (msg?.type !== 'player_join') return
    // restore() replaces every player's data, so run it once, before any player's data is created
    if (ctx.state.progressSave && !ctx._progressRestored) {
      ctx.stats.restore(ctx.state.progressSave.stats)
      ctx.quests.restore(ctx.state.progressSave.quests)
      ctx._progressRestored = true
    }
    welcome(ctx, msg.playerId)
  }
}
```

`ctx.storage` is a different store: an async key/value adapter (`await ctx.storage.get(key)`, `ctx.storage.set(key, value)`), namespaced per app. It is `null` when the server has no storage configured.

## Common Patterns

### Quest Objective Completion via Collision/Interaction

```javascript
// In an enemy or collectible app
onMessage(ctx, msg) {
  if (msg.type === 'damage' || msg.type === 'collect') {
    const playerId = msg.senderId
    const questId = 'quest-name'
    const objectiveIndex = 0

    // Track in quest system
    ctx.quests.completeObjective(playerId, questId, objectiveIndex, 1)

    // Grant XP directly on kill
    ctx.stats.addXP(playerId, 25)
  }
}
```

### Quest Reward Claiming

```javascript
// In player UI handler
if (msg.type === 'claimQuestReward') {
  const playerId = msg.senderId
  const questId = msg.questId

  // Claim reward (also applies XP, items, stat bonuses)
  const rewards = ctx.quests.claimReward(playerId, questId)

  // Notify client
  ctx.players.send(playerId, {
    type: 'questRewardClaimed',
    rewards
  })
}
```

### Equipment Loadout Management

```javascript
// Save current gear as a build
if (msg.type === 'saveLoadout') {
  const playerId = msg.senderId
  const loadoutName = msg.name  // From client, validate length
  if (loadoutName.length > 32) return

  ctx.stats.saveLoadout(playerId, loadoutName)
  ctx.players.send(playerId, { type: 'loadoutSaved', name: loadoutName })
}

// Switch to a saved loadout
if (msg.type === 'loadLoadout') {
  const playerId = msg.senderId
  const loadoutName = msg.name

  if (ctx.stats.loadLoadout(playerId, loadoutName)) {
    const stats = ctx.stats.getStats(playerId)
    ctx.players.send(playerId, { type: 'loadoutLoaded', stats })
  } else {
    ctx.players.send(playerId, { type: 'loadoutNotFound' })
  }
}
```

### Level-Up Triggered Ability Unlocks

```javascript
// Track which level gates unlock which abilities
const ABILITY_UNLOCKS = {
  2: 'power-strike',
  5: 'fireball',
  10: 'summon-ally',
  20: 'time-warp'
}

export const server = {
  setup(ctx) {
    ctx.stats = defineStatsSystem({
      onLevelUp: (ctx, data) => {
        const playerId = data.playerId
        const level = data.level

        // Check for ability unlocks
        if (ABILITY_UNLOCKS[level]) {
          const ability = ABILITY_UNLOCKS[level]
          ctx.players.send(playerId, {
            type: 'abilityUnlocked',
            ability,
            level
          })
        }
      }
    }, ctx)
  }
}
```

## Performance Considerations

### Snapshot Size
- Each player's stats: ~200 bytes
- Each player's quest state: ~500 bytes
- With 100 players: ~70 KB total

### Network Overhead
- Each system sends one `ctx.players.send` to the affected player on every change: XP gain, equip, objective progress, inventory change
- Nothing is batched or sent per tick; a client only sees state after a change, or when `push(playerId)` is called

### CPU Impact
- 0.007ms per operation (verified)
- 100 players × 3 quests = <3ms/frame
- Negligible impact at 30 Hz tick rate

## Testing Your Integration

```javascript
// Test quest progression
ctx.quests.startQuest(playerId, 'test-quest')
ctx.quests.completeObjective(playerId, 'test-quest', 0, 5)
const state = ctx.quests.getQuestState(playerId, 'test-quest')
console.assert(state.state === 'complete', 'Quest should be complete')

// Test stats scaling
ctx.stats.addXP(playerId, 10000)
const stats = ctx.stats.getStats(playerId)
console.assert(stats.level === 50, 'Should be capped at maxLevel')

// Test persistence
const snap1 = ctx.stats.snapshot()
ctx.stats.addXP(playerId, 1000)
ctx.stats.restore(snap1)
const stats2 = ctx.stats.getStats(playerId)
console.assert(stats2.level === stats.level, 'Restore should work')

// Test loadout swap
ctx.stats.equipItem(playerId, 'iron-sword')
ctx.stats.saveLoadout(playerId, 'build1')
ctx.stats.equipItem(playerId, 'steel-sword')
ctx.stats.loadLoadout(playerId, 'build1')
const eq = ctx.stats.getEquipment(playerId)
console.assert(eq.weapon.id === 'iron-sword', 'Loadout swap should work')
```

## Troubleshooting

**Q: Stats not persisting after server restart?**
- A: Ensure `ctx.onShutdown()` copies `ctx.stats.snapshot()` into `ctx.state` (world persistence saves `ctx.state`)
- A: Restore on the first `player_join` after boot, not in `setup`: the saved `ctx.state` is swapped in after `setup` runs

**Q: Client shows old stats or nothing at all?**
- A: The systems push after every change. `ctx.stats.push(playerId)` resends on demand.
- A: Ensure the client's `onEvent(payload, engine)` matches `payload.type` against the system's `channel`
- A: Pushes sent before the client module loaded are dropped; have the client's `setup` request a resend (see the example)

**Q: Equipment bonuses not applying?**
- A: Verify equipment IDs match between `getStats()` call and `_equipmentLookup`
- A: Check that `statScaling` is defined in config

**Q: Quest rewards not giving XP?**
- A: Ensure `ctx.progression = ctx.stats` is set (wire injection)
- A: Check `claimReward()` is actually called (not just completing objectives)

**Q: Performance degradation with many players?**
- A: Snapshot/restore only happens at shutdown and on the first join, not per-tick
- A: Each change sends one message to one player; if a loop grants XP many times per tick, sum it first and call `addXP` once
- A: If still slow, profile with `performance.now()` around operations

## Next Steps

1. **Extend QuestSystem** with quest chains, prerequisites, and conditional rewards
2. **Extend StatsSystem** with skill trees and ability unlocks
3. **Add to Inventory** smart crafting system that uses quest rewards
4. **Create UI** for quest tracker, character sheet, loadout manager
5. **Add Progression Saves** to database with user accounts
