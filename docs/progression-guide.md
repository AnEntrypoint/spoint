# RPG Progression Framework Developer Guide

## Overview

The spoint RPG progression framework enables developers to build level-based RPG and MOBA games with XP-driven progression, quest systems, abilities that unlock over time, and persistent state across server restarts.

**Key Features:**
- XP-based leveling (levels 1-10+)
- Quest system with multiple objective types
- Ability unlocking at specific levels
- Mana and cooldown mechanics
- Multiplayer progression sync
- State persistence via snapshots
- Custom progression curves

---

## Quick Start: Tutorial RPG

The **tutorial-rpg** world demonstrates all framework features in a 20-30 minute playable game:

```bash
# Start the server
npx spoint

# Visit http://localhost:3001/?world=tutorial-rpg
```

**What it includes:**
- 5-quest tutorial chain (kill goblins → collect coins → reach tower → defeat mini-boss → defeat final boss)
- Levels 1-10 progression (100 XP to level 2, scaling exponentially)
- 3 abilities unlocking at levels 1, 5, and 10
- Enemy spawning (goblins, mini-boss, final boss)
- Mana regeneration, cooldowns
- Multiplayer-safe XP/quest tracking

---

## ProgressionSystem API

### Player State Structure

Each player maintains a progression state:

```javascript
{
  playerId,           // unique player ID (string)
  level,              // 1-10, current level
  xp,                 // XP toward next level
  health,             // current HP
  maxHealth,          // max HP (increases on level-up)
  mana,               // current mana
  maxMana,            // max mana (increases on level-up)
  quest,              // current quest index (0-4)
  questProgress,      // count toward current objective
  unlockedAbilities,  // { abilityId: true, ... }
  activeCooldowns     // { abilityId: cooldownSeconds, ... }
}
```

### Getting Player State

```javascript
// In your app's setup(ctx):
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
```

### Adding XP

```javascript
const addXp = (ctx, playerId, amount) => {
  const ps = getPlayerState(ctx, playerId)
  ps.xp += amount

  // Check if level-up threshold reached
  const nextLevelXp = getXpForLevel(ps.level)
  while (ps.xp >= nextLevelXp && ps.level < 10) {
    ps.level++
    ps.xp = 0
    ps.maxHealth += 10
    ps.health = ps.maxHealth
    ps.maxMana += 20
    ps.mana = ps.maxMana

    // Unlock ability for this level
    const ability = ABILITIES[ps.level]
    if (ability) {
      ps.unlockedAbilities[ability.id] = true
    }

    ctx.bus.emit('player.levelup', {
      playerId,
      newLevel: ps.level,
      unlockedAbility: ability ? ability.name : null
    })
  }
}
```

### Casting Abilities

Abilities are defined by level:

```javascript
const ABILITIES = {
  1: { id: 'attack', name: 'Attack', cooldown: 0, manaCost: 0, damage: 10, range: 3 },
  5: { id: 'fireball', name: 'Fireball', cooldown: 5, manaCost: 20, damage: 30, range: 20 },
  10: { id: 'lightning-storm', name: 'Lightning Storm', cooldown: 10, manaCost: 50, damage: 60, range: 15 }
}

const castAbility = (ctx, playerId, abilityId, targetPos) => {
  const ps = getPlayerState(ctx, playerId)
  const ability = Object.values(ABILITIES).find(a => a.id === abilityId)

  // Validation
  if (!ability || !ps.unlockedAbilities[abilityId]) return false  // not unlocked
  if (ps.mana < ability.manaCost) return false                   // insufficient mana
  if (ps.activeCooldowns[abilityId]) return false                // on cooldown

  // Apply cost and cooldown
  ps.mana -= ability.manaCost
  ps.activeCooldowns[abilityId] = ability.cooldown

  // Resolve effect (damage nearby enemies)
  const player = ctx.players.getById(playerId)
  const nearby = ctx.world.nearby(player.state.position, ability.range)
  
  nearby.forEach(entityId => {
    const entity = ctx.world.getEntity(entityId)
    if (entity && entity.custom?.enemyType) {
      damageEntity(entity, ability.damage)
    }
  })

  return true
}
```

### Mana Regeneration & Cooldowns

Update every frame:

```javascript
ctx.time.every(1, () => {
  ctx.players.getAll().forEach(p => {
    const ps = getPlayerState(ctx, p.id)
    
    // Regenerate mana (5 per second)
    ps.mana = Math.min(ps.mana + 5, ps.maxMana)

    // Decrement cooldowns
    Object.keys(ps.activeCooldowns).forEach(key => {
      ps.activeCooldowns[key] -= 1
      if (ps.activeCooldowns[key] <= 0) delete ps.activeCooldowns[key]
    })
  })
})
```

---

## QuestSystem API

### Quest Definition

Quests are linear and unlock with level-up gates:

```javascript
const QUESTS = [
  {
    id: 0,
    title: 'Kill 3 Goblins',
    objectiveType: 'kill',      // 'kill' | 'collect' | 'reach' | 'talk' | 'custom'
    targetType: 'goblin',       // enemy type or item type
    count: 3,                   // objective count (default 1)
    xpReward: 30,               // XP on completion
    unlocksLevel: 0             // (optional) minimum level to unlock
  },
  {
    id: 1,
    title: 'Collect 5 Gold Coins',
    objectiveType: 'collect',
    targetType: 'gold-coin',
    count: 5,
    xpReward: 50
  },
  {
    id: 2,
    title: 'Reach the Tower',
    objectiveType: 'reach',
    targetType: 'tower-base',
    count: 1,
    xpReward: 75
  }
]
```

### Quest Progress

```javascript
const updateQuestProgress = (ctx, playerId, objectiveType, targetType) => {
  const ps = getPlayerState(ctx, playerId)
  const currentQuest = QUESTS[ps.quest]
  if (!currentQuest) return

  // Check if this event matches the current quest objective
  if (currentQuest.objectiveType === objectiveType && 
      currentQuest.targetType === targetType) {
    ps.questProgress++

    if (ps.questProgress >= currentQuest.count) {
      completeQuest(ctx, playerId)
    }
  }
}

const completeQuest = (ctx, playerId) => {
  const ps = getPlayerState(ctx, playerId)
  const quest = QUESTS[ps.quest]
  if (!quest) return

  addXp(ctx, playerId, quest.xpReward)
  ctx.bus.emit('quest.completed', { 
    playerId, 
    questId: ps.quest, 
    questTitle: quest.title 
  })

  // Advance to next quest
  if (ps.quest < QUESTS.length - 1) {
    ps.quest++
    ps.questProgress = 0
  }
}
```

### Triggering Quest Events

```javascript
// On enemy death
ctx.bus.on('enemy.died', (e) => {
  ctx.players.getAll().forEach(p => {
    updateQuestProgress(ctx, p.id, 'kill', 'goblin')
  })
})

// On item collection
ctx.bus.on('gold-coin-collected', (e) => {
  updateQuestProgress(ctx, e.playerId, 'collect', 'gold-coin')
})

// On reach location
ctx.time.every(1, () => {
  ctx.players.getAll().forEach(p => {
    const tower = ctx.world.getEntity('tower-base')
    const dist = Math.hypot(
      p.state.position[0] - tower.position[0],
      p.state.position[2] - tower.position[2]
    )
    if (dist < 5) {
      updateQuestProgress(ctx, p.id, 'reach', 'tower-base')
    }
  })
})
```

---

## AbilityTree API

### Ability Definition

Abilities unlock at specific levels and cost mana:

```javascript
const ABILITIES = {
  1: {
    id: 'attack',
    name: 'Attack',
    level: 1,
    cooldown: 0,              // seconds between casts
    manaCost: 0,              // mana per cast
    damage: 10,               // damage dealt
    range: 3,                 // radius of effect
    aoe: false                // area-of-effect flag
  },
  5: {
    id: 'fireball',
    name: 'Fireball',
    level: 5,
    cooldown: 5,
    manaCost: 20,
    damage: 30,
    range: 20,
    aoe: true
  }
}
```

### Ability Validation

Before executing, check:

```javascript
const canCastAbility = (ps, abilityId) => {
  const ability = Object.values(ABILITIES).find(a => a.id === abilityId)

  if (!ability) return false                           // doesn't exist
  if (!ps.unlockedAbilities[abilityId]) return false  // not unlocked yet
  if (ps.mana < ability.manaCost) return false        // insufficient mana
  if (ps.activeCooldowns[abilityId]) return false     // on cooldown

  return true
}
```

### Ability Effect Resolution

```javascript
const resolveAbilityEffect = (ctx, ability, originPos, targetPos) => {
  // Find nearby entities in range
  const nearby = ctx.world.nearby(targetPos, ability.range)

  // Apply damage to each enemy
  nearby.forEach(entityId => {
    const entity = ctx.world.getEntity(entityId)
    if (entity && entity.custom?.enemyType) {
      const xpDrop = damageEntity(entity, ability.damage)
      if (xpDrop > 0) {
        // Enemy died, broadcast to all nearby players
        ctx.players.getAll().forEach(p => {
          const dist = Math.hypot(
            p.state.position[0] - originPos[0],
            p.state.position[2] - originPos[2]
          )
          if (dist < 50) {
            addXp(ctx, p.id, xpDrop)
          }
        })
      }
    }
  })
}
```

---

## Progression Curves

### XP Table (Exponential)

By default, XP requirement grows exponentially:

```javascript
const BASE_XP_TABLE = [
  0,      // level 0
  100,    // level 2 (100 XP from 1)
  250,    // level 3 (150 more)
  450,    // level 4 (200 more)
  700,    // level 5 (250 more)
  1000,   // level 6 (300 more)
  1350,   // level 7 (350 more)
  1750,   // level 8 (400 more)
  2200,   // level 9 (450 more)
  2700,   // level 10 (500 more)
  3250    // level 11+ (550 more)
]

// Get required XP for a specific level
const getXpForLevel = (level) => BASE_XP_TABLE[Math.min(level, 10)]
```

To customize, modify the table and the `getXpForLevel` function:

```javascript
// Quadratic curve: XP = 50 * level^2
const getXpForLevelQuadratic = (level) => 50 * level * level

// Linear curve: XP = 100 * level
const getXpForLevelLinear = (level) => 100 * level

// Apply it
const addXp = (ctx, playerId, amount) => {
  const ps = getPlayerState(ctx, playerId)
  ps.xp += amount

  const nextLevelXp = getXpForLevelQuadratic(ps.level)
  // ... rest of level-up logic
}
```

### Stat Scaling

On level-up, stats increase:

```javascript
ps.level++
ps.xp = 0
ps.maxHealth += 10                    // +10 HP per level
ps.health = ps.maxHealth              // fully heal on level-up
ps.maxMana += 20                      // +20 mana per level
ps.mana = ps.maxMana                  // fully restore on level-up
```

Customize by changing the increment values or using a lookup table:

```javascript
const LEVEL_UP_STATS = {
  1: { hpGain: 10, manaGain: 20 },
  2: { hpGain: 12, manaGain: 25 },
  3: { hpGain: 15, manaGain: 30 },
  // ...
}

ps.level++
const statGain = LEVEL_UP_STATS[ps.level] || { hpGain: 10, manaGain: 20 }
ps.maxHealth += statGain.hpGain
ps.maxMana += statGain.manaGain
```

---

## Network Sync Architecture

### Client-Side Ability Casting

Abilities are cast from the client via network message:

```javascript
// client/render.onKeyDown or onInput
onKeyDown(e, engine) {
  if (e.key === '1') {  // ability hotkey 1
    const players = engine.client.state?.players || []
    const myPlayer = players.find(p => p.id === engine.playerId)
    if (myPlayer) {
      const dir = engine.cam.getAimDirection(myPlayer.state.position)
      engine.network.send({
        type: 'cast_ability',
        abilityId: 'attack',
        targetPos: [
          myPlayer.state.position[0] + dir[0] * 15,
          myPlayer.state.position[1],
          myPlayer.state.position[2] + dir[2] * 15
        ]
      })
    }
  }
}
```

### Server-Side Message Handling

The server validates and resolves ability effects:

```javascript
onMessage(ctx, msg) {
  if (!msg) return
  if (msg.type === 'cast_ability') {
    castAbility(ctx, msg.playerId || msg.senderId, msg.abilityId, msg.targetPos)
  }
}
```

### Broadcasting State Changes

The engine automatically broadcasts:
- Player position/rotation/health each snapshot (~250ms)
- Ability unlocks on level-up (via `player.levelup` bus event)
- Quest completion (via `quest.completed` bus event)

No manual sync code required; `ctx.entity.custom` fields are sent in every snapshot.

---

## Persistence & Snapshot Model

### Automatic Persistence

Player progression is persisted automatically:

```javascript
// In your app's setup(ctx):
ctx.state.progression = ctx.state.progression || {}

// On every snapshot send, ctx.state fields are included
// On server restart, ctx.state is restored from the saved snapshot
```

### Custom Persistence

To save/restore specific fields:

```javascript
// Save on shutdown
ctx.entity.custom = {
  progression: ctx.state.progression,
  questLog: ctx.state.questLog
}

// Restore on startup
if (ctx.entity.custom.progression) {
  ctx.state.progression = ctx.entity.custom.progression
}
```

### Snapshot Structure

Each player entity carries their progression in `custom`:

```javascript
{
  position: [x, y, z],
  rotation: [x, y, z, w],
  custom: {
    level: 5,
    xp: 120,
    mana: 45,
    health: 95,
    quest: 2,
    questProgress: 2,
    unlockedAbilities: { attack: true, fireball: true },
    activeCooldowns: { fireball: 3.5 }
  }
}
```

On load, restore from snapshot:

```javascript
if (msg.type === 'snapshot') {
  ctx.state.progression = msg.custom.progression || ctx.state.progression
}
```

---

## Performance Best Practices

### Update Frequency

Keep expensive operations out of tight loops:

```javascript
// GOOD: run every 1 second
ctx.time.every(1, () => {
  // mana regen, cooldown decay
  ctx.players.forEach(p => { /* ... */ })
})

// AVOID: run every frame (60 Hz)
onFrame(dt, engine) {
  // Don't recalculate progression here
}
```

### Spatial Queries

Use spatial partitioning for nearby entity checks:

```javascript
// O(1) with proper spatial hash
const nearby = ctx.world.nearby(origin, radius)

// AVOID: O(n) query every frame
const all = ctx.world.query(() => true)
```

### Ability Resolution

Batch ability effects:

```javascript
// Good: find all enemies once
const nearby = ctx.world.nearby(targetPos, ability.range)
nearby.forEach(entityId => {
  // Apply damage
})

// Avoid: multiple queries for same data
const enemies = ctx.world.query(e => e.custom?.enemyType)
const inRange = enemies.filter(e => dist(e, target) < range)
```

---

## Custom Game Implementation

### Step 1: Define Progression Goals

```javascript
const QUESTS = [
  // Your 5-quest chain
]

const ABILITIES = {
  1: { /* starter ability */ },
  // Unlock at specific levels
}

const LEVELS = 10  // or higher
```

### Step 2: Create World Definition

```javascript
// apps/world/your-game.js
export default {
  port: 3001,
  tickRate: 30,
  entities: [
    { id: 'floor', app: 'box-static', config: { /* ... */ } },
    { id: 'game', app: 'your-game-app', config: {} }
  ],
  spawnPoint: [0, 2, 0]
}
```

### Step 3: Implement Game App

```javascript
// apps/your-game-app/index.js
export default {
  server: {
    setup(ctx) {
      ctx.state.progression = ctx.state.progression || {}

      // ... register quests, abilities, level-up handlers

      ctx.onMessage((ctx_msg, msg) => {
        if (msg.type === 'cast_ability') {
          castAbility(ctx, msg.playerId, msg.abilityId, msg.targetPos)
        }
      })
    },
    update(ctx, dt) { /* ... */ },
    teardown(ctx) {}
  },
  client: {
    render(ctx) { /* ... */ },
    onKeyDown(e, engine) { /* cast abilities */ },
    onFrame(dt, engine) { /* update UI */ }
  }
}
```

### Step 4: Test Progression Flow

```bash
npx spoint
# Visit http://localhost:3001/?world=your-game

# In browser console:
window.debug.client.state.players[0].custom.level  // check level
window.debug.client.state.players[0].custom.xp     // check XP
```

---

## Multiplayer Sync Details

### Player Join Flow

1. Client joins room, receives first snapshot
2. Server calls `ctx.onMessage(playerJoin)`
3. Initialize progression for this player ID
4. Sync current state in next snapshot send

### Level-Up Broadcast

```javascript
ctx.bus.emit('player.levelup', {
  playerId: id,
  newLevel: level,
  unlockedAbility: name
})

// Engine broadcasts this to all players in world
ctx.players.broadcast({ type: 'player.levelup', ... })
```

### Ability Cooldown Sync

Cooldowns are tracked server-side, sent in snapshot:

```javascript
custom: {
  activeCooldowns: {
    fireball: 3.2  // 3.2 seconds remaining
  }
}
```

Client displays cooldown UI based on this value.

---

## Debugging

### Server-Side State

In Node REPL:

```javascript
globalThis.__DEBUG__.server.getEntity('game-app').custom.progression
// { playerId1: { level: 5, xp: 120, ... }, ... }
```

### Client-Side State

In browser console:

```javascript
window.debug.client.state.players[0]
// { id, health, position, custom: { level, xp, ... } }

window.debug.engine.playerId
// get local player ID
```

### Quest Progress

```javascript
const ps = ctx.state.progression[playerId]
console.log(`Quest ${ps.quest}: progress ${ps.questProgress}/${QUESTS[ps.quest].count}`)
```

### Ability Unlock

```javascript
const ps = ctx.state.progression[playerId]
console.log('Unlocked:', Object.keys(ps.unlockedAbilities))
```

---

## API Reference

### Core Functions

| Function | Args | Returns | Effect |
|----------|------|---------|--------|
| `getPlayerState(ctx, playerId)` | ctx, string | PlayerState | Get or create player progression |
| `addXp(ctx, playerId, amount)` | ctx, string, number | void | Add XP, trigger level-ups |
| `castAbility(ctx, playerId, abilityId, targetPos)` | ctx, string, string, [x,y,z] | bool | Validate and resolve ability |
| `damageEntity(entity, damage)` | Entity, number | number | Damage enemy, return XP if killed |
| `updateQuestProgress(ctx, playerId, objType, targetType)` | ctx, string, string, string | void | Increment quest objective |
| `completeQuest(ctx, playerId)` | ctx, string | void | Mark current quest complete, advance |

### Event Triggers

| Event | When | Payload |
|-------|------|---------|
| `player.levelup` | level-up occurs | `{ playerId, newLevel, unlockedAbility }` |
| `quest.completed` | quest finishes | `{ playerId, questId, questTitle }` |
| `gold-coin-collected` | collectible taken | `{ playerId, coin }` |
| `combat.damage` | ability hits | `{ source, target, damage, ability }` |
| `enemy.died` | health <= 0 | `{ entityId, xpDrop }` |

---

## Troubleshooting

### Players not leveling up
- Check `addXp()` is called on enemy death
- Verify XP table: `BASE_XP_TABLE[level]` is set
- Inspect `ps.xp` value in debugger

### Abilities not casting
- Verify ability is unlocked: `ps.unlockedAbilities[abilityId]`
- Check mana: `ps.mana >= ability.manaCost`
- Confirm cooldown expired: `!ps.activeCooldowns[abilityId]`

### Quests not progressing
- Ensure `updateQuestProgress()` called on objective
- Check quest ID matches: `QUESTS[ps.quest].targetType`
- Verify `questProgress` incremented

### State not persisting
- Confirm `ctx.state.progression` saved before shutdown
- Check snapshot sends before disconnect
- Verify server loads saved state on startup

---

## Example: Custom Ability Effect

```javascript
// Add custom ability that heals nearby allies
const ABILITIES = {
  7: {
    id: 'healing-aura',
    name: 'Healing Aura',
    level: 7,
    cooldown: 8,
    manaCost: 30,
    range: 15,
    healAmount: 25
  }
}

const resolveAbilityEffect = (ctx, ability, origin, target) => {
  if (ability.id === 'healing-aura') {
    const nearby = ctx.world.nearby(origin, ability.range)
    ctx.players.getAll().forEach(p => {
      const dist = Math.hypot(
        p.state.position[0] - origin[0],
        p.state.position[2] - origin[2]
      )
      if (dist < ability.range) {
        p.state.health = Math.min(
          p.state.health + ability.healAmount,
          getPlayerState(ctx, p.id).maxHealth
        )
      }
    })
  }
}
```

---

## Example: Boss Encounter Design

```javascript
// Final boss requires level 10 to damage
const castAbility = (ctx, playerId, abilityId, targetPos) => {
  const ps = getPlayerState(ctx, playerId)
  
  // Find target boss
  const bossEntities = ctx.world.query(e => e.custom?.enemyType === 'final-boss')
  bossEntities.forEach(boss => {
    // Only damage if player is level 10+
    if (ps.level < 10) {
      ctx.players.send(playerId, {
        type: 'notification',
        msg: 'You must reach level 10 to damage the final boss!'
      })
      return
    }
    
    damageEntity(boss, 30)
  })
}
```

---

## See Also

- [Spoint SKILL.md](../SKILL.md) — engine API reference
- [Game FSM guide](../apps/_lib/README.md#game-fsm) — state machine framework
- [Tutorial RPG source](../apps/rpg-tutorial/index.js) — working example
