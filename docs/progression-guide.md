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

  // Level up while the threshold is reached; overflow XP carries into the next level
  while (ps.level < 10 && ps.xp >= getXpForLevel(ps.level)) {
    ps.xp -= getXpForLevel(ps.level)
    ps.level++
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

const castAbility = (ctx, playerId, abilityId) => {
  const ps = getPlayerState(ctx, playerId)
  const ability = Object.values(ABILITIES).find(a => a.id === abilityId)

  // Validation
  if (!ability || !ps.unlockedAbilities[abilityId]) return false  // not unlocked
  if (ps.mana < ability.manaCost) return false                   // insufficient mana
  if (ps.activeCooldowns[abilityId]) return false                // on cooldown

  // Cast from the caster's server-side position, never a client-supplied one
  const origin = ctx.players.getById(playerId)?.state?.position
  if (!origin) return false

  // Apply cost and cooldown
  ps.mana -= ability.manaCost
  ps.activeCooldowns[abilityId] = ability.cooldown

  // Resolve effect (damage nearby enemies)
  const rangeSq = ability.range * ability.range
  const targets = ctx.world.query(e => !!e.custom?.enemyType && (e.position[0] - origin[0]) ** 2 + (e.position[2] - origin[2]) ** 2 <= rangeSq)
  for (const enemy of targets) damageEntity(ctx, playerId, enemy, ability.damage)

  return true
}

// ctx.world.query / getEntity return raw runtime entities: they have no destroy(),
// so kills go through ctx.world.destroy(id). Reassign custom so the change is sent to clients.
const damageEntity = (ctx, playerId, enemy, damage) => {
  const custom = enemy.custom
  const health = Math.max(0, (custom.health ?? custom.maxHealth ?? 10) - damage)
  enemy.custom = { ...custom, health, isDamaged: true }
  if (health > 0) return 0
  ctx.world.destroy(enemy.id)
  addXp(ctx, playerId, custom.xpValue ?? 10)
  updateQuestProgress(ctx, playerId, 'kill', custom.enemyType)
  return custom.xpValue ?? 10
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

Bus handlers receive an envelope `{ channel, data, meta }`; the emitter's payload is `data`:

```javascript
// On item collection (apps/gold-coin emits { playerId, coin })
ctx.bus.on('gold-coin-collected', ({ data }) => {
  if (data?.playerId == null) return
  updateQuestProgress(ctx, data.playerId, 'collect', 'gold-coin')
})

// On enemy death: only if your enemy apps emit such an event (the engine emits none)
ctx.bus.on('enemy.died', ({ data }) => {
  updateQuestProgress(ctx, data.killerId, 'kill', data.enemyType)
})

// On reach location
ctx.time.every(1, () => {
  const tower = ctx.world.getEntity('tower-base')
  if (!tower) return
  ctx.players.getAll().forEach(p => {
    const pos = p.state?.position
    if (!pos) return
    const dist = Math.hypot(pos[0] - tower.position[0], pos[2] - tower.position[2])
    if (dist < 5) {
      updateQuestProgress(ctx, p.id, 'reach', 'tower-base')
    }
  })
})
```

Kills are simplest to count where they happen: `damageEntity` above advances the killer's kill quest itself.

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

Shared XP for every player near the kill, on top of the killer's own award:

```javascript
const resolveAbilityEffect = (ctx, casterId, ability, originPos) => {
  // nearby() returns entity ids
  const nearby = ctx.world.nearby(originPos, ability.range)

  nearby.forEach(entityId => {
    const entity = ctx.world.getEntity(entityId)
    if (!entity?.custom?.enemyType) return
    const xpDrop = damageEntity(ctx, casterId, entity, ability.damage)
    if (xpDrop === 0) return
    ctx.players.getAll().forEach(p => {
      const pos = p.state?.position
      if (p.id === casterId || !pos) return
      if (Math.hypot(pos[0] - originPos[0], pos[2] - originPos[2]) < 50) addXp(ctx, p.id, xpDrop)
    })
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
ps.xp -= getXpForLevel(ps.level)     // carry overflow XP
ps.level++
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

Abilities are cast from the client via a network message. The client only names the ability; the server resolves it from the caster's own position:

```javascript
// client hooks (apps/rpg-tutorial/index.js)
const ABILITY_KEYS = { 1: 'attack', 2: 'fireball', 3: 'lightning-storm' }

onKeyDown(e, engine) {
  const abilityId = ABILITY_KEYS[e.key]
  const unlocked = engine._rpgTutorial?.progress?.unlockedAbilities
  if (e.repeat || !abilityId || !unlocked?.includes(abilityId)) return
  engine.network.send({ type: 'cast_ability', abilityId })
}
```

The engine object passed to client hooks is shared by every app. It has no `on()`, no `state` bucket and no per-app player state, so keep your own under `engine._<appName>` (here `engine._rpgTutorial`). If you need the local player's position on the client, snapshot players carry it at the top level: `player.position`, not `player.state.position`. `player.state.position` exists only on the server.

### Server-Side Message Handling

Client messages arrive in the server `onMessage(ctx, msg)` hook. `msg.senderId` is stamped by the server and is the only player id to trust:

```javascript
onMessage(ctx, msg) {
  if (msg?.type !== 'cast_ability' || msg.senderId == null) return
  castAbility(ctx, msg.senderId, msg.abilityId)
}
```

### Sending State to Clients

The engine's snapshots carry player position, rotation and health, and each entity's `custom`. Bus events (`player.levelup`, `quest.completed`) are server-side only and never reach a client. Progression therefore has to be pushed explicitly. rpg-tutorial sends one `rpg-progress` payload per player every second, and again after every change:

```javascript
ctx.players.send(playerId, {
  type: 'rpg-progress',
  level: ps.level, xp: ps.xp, xpToNext: xpToNext(ps.level),
  health: ps.health, maxHealth: ps.maxHealth, mana: ps.mana, maxMana: ps.maxMana,
  quest: ps.quest, questTitle: QUESTS[ps.quest]?.title ?? null,
  questProgress: ps.questProgress, questTarget: QUESTS[ps.quest]?.count ?? 0,
  unlockedAbilities: [...ps.unlockedAbilities], cooldowns: { ...ps.cooldowns }
})
```

and the client keeps the latest one:

```javascript
setup(engine) { engine._rpgTutorial = { progress: null } },

// every ctx.players.send / broadcast payload reaches every app's onEvent
onEvent(payload, engine) {
  if (payload?.type === 'rpg-progress') engine._rpgTutorial.progress = payload
}
```

---

## Persistence & Snapshot Model

### What Persists

`ctx.state` is the app's server-side state. It is never sent to clients. It survives a hot reload of the app, since the same object is handed to the new `setup`, and it is saved with the world snapshot (`src/sdk/WorldPersistence.js`, which records each entity's `ctx.state`).

```javascript
// In your app's setup(ctx): read-or-create, never overwrite
const progressOf = (ctx, playerId) => {
  const players = ctx.state.rpgPlayers || (ctx.state.rpgPlayers = {})
  return players[playerId] || (players[playerId] = { level: 1, xp: 0, quest: 0, questProgress: 0 })
}
```

On a restart, the saved `ctx.state` is swapped in *after* `setup` has already run. Always reach progression through `ctx.state` at use time, as `progressOf` does, rather than caching it in a closure during `setup`.

### What Clients See

Clients never see `ctx.state`. They see `ctx.entity.custom`, which is sent in snapshots, and whatever you push with `ctx.players.send`/`broadcast`. Player progression belongs to players, not to the game-controller entity, so push it per player as shown in [Sending State to Clients](#sending-state-to-clients). There is no progression inside a player's snapshot entry.

---

## Performance Best Practices

### Update Frequency

Keep expensive operations out of tight loops:

```javascript
// GOOD: run every 1 second
ctx.time.every(1, () => {
  // mana regen, cooldown decay
  ctx.players.getAll().forEach(p => { /* ... */ })
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
const nearby = ctx.world.nearby(origin, ability.range)
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
      // ... register bus handlers (ctx.bus.on) and timers (ctx.time.every)
    },
    // Client messages and player joins/leaves all arrive here; there is no ctx.onMessage
    onMessage(ctx, msg) {
      if (msg?.type === 'cast_ability' && msg.senderId != null) castAbility(ctx, msg.senderId, msg.abilityId)
    },
    update(ctx, dt) { /* ... */ },
    teardown(ctx) {}
  },
  client: {
    setup(engine) { engine._yourGame = { progress: null } },
    onEvent(payload, engine) { if (payload?.type === 'rpg-progress') engine._yourGame.progress = payload },
    onKeyDown(e, engine) { /* engine.network.send({ type: 'cast_ability', abilityId }) */ },
    onFrame(dt, engine) { /* update UI from engine._yourGame.progress */ }
  }
}
```

### Step 4: Test Progression Flow

```bash
npx spoint
# Visit http://localhost:3001/?world=your-game

# In browser console (the last progress payload your client's onEvent kept):
window.__app.engine._yourGame.progress.level  // check level
window.__app.engine._yourGame.progress.xp     // check XP
```

---

## Multiplayer Sync Details

### Player Join Flow

1. The client joins the room and receives its first snapshot.
2. The server calls every app's `onMessage(ctx, { type: 'player_join', playerId })`. A player who was already connected when `setup` ran, e.g. after a hot reload, sends no join and is only visible through `ctx.players.getAll()`.
3. The app creates or looks up progression for that player id.
4. The app pushes it with `ctx.players.send(playerId, ...)`. Pushes can land before the client has loaded the app module, and `onEvent` then drops them. Either push periodically, as rpg-tutorial does every second, or have the client's `setup` send a sync request (apps/tutorial-rpg does this).

### Level-Up Broadcast

`ctx.bus.emit` notifies other server-side apps only. To tell clients, send or broadcast explicitly:

```javascript
ctx.bus.emit('player.levelup', { playerId: id, newLevel: level, unlockedAbility: name })   // other apps
ctx.players.broadcast({ type: 'player.levelup', playerId: id, newLevel: level })            // every client's onEvent
```

### Ability Cooldown Sync

Cooldowns are tracked server-side and ride along in the pushed progress payload:

```javascript
{ type: 'rpg-progress', ..., cooldowns: { fireball: 3 } }   // seconds remaining
```

The client displays cooldown UI from `engine._<app>.progress.cooldowns`.

---

## Debugging

### Server-Side State

In the server process, e.g. under `node --inspect`:

```javascript
globalThis.__DEBUG__.server.runtime.contexts.get('rpg-tutorial').state.rpgPlayers
// { <playerId>: { level: 5, xp: 120, ... }, ... }
```

### Client-Side State

In browser console:

```javascript
window.__app.engine._rpgTutorial.progress
// the last rpg-progress payload: { level, xp, xpToNext, health, mana, questTitle, ... }

window.__app.engine.playerId
// local player ID
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
| `castAbility(ctx, playerId, abilityId)` | ctx, id, string | bool | Validate and resolve ability from the caster's server-side position |
| `damageEntity(ctx, playerId, entity, damage)` | ctx, id, Entity, number | number | Damage enemy; on a kill, `ctx.world.destroy` it, credit the killer and return its XP |
| `updateQuestProgress(ctx, playerId, objType, targetType)` | ctx, string, string, string | void | Increment quest objective |
| `completeQuest(ctx, playerId)` | ctx, string | void | Mark current quest complete, advance |

### Event Triggers

Server-side bus events (`ctx.bus.emit` / `ctx.bus.on`). Handlers receive `{ channel, data, meta }` with the payload in `data`, and no client ever sees them.

| Event | Emitted by | Payload (`data`) |
|-------|------------|------------------|
| `player.levelup` | rpg-tutorial, on level-up | `{ playerId, newLevel, unlockedAbility }` |
| `quest.completed` | rpg-tutorial, on quest completion | `{ playerId, questId, questTitle }` |
| `gold-coin-collected` | apps/gold-coin, on pickup | `{ playerId, coin }` |

Events such as `combat.damage` or `enemy.died` exist only if your own apps emit them; the engine emits neither.

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
- Keep progression in `ctx.state`: world persistence saves it, and a hot reload hands the same object to the new `setup`
- Read it through `ctx.state` at use time. On restart the saved state is swapped in after `setup`, so a reference cached during `setup` points at the discarded object.

### Client never shows progress
- Push it: `ctx.players.send(playerId, { type: 'rpg-progress', ... })`. Neither `ctx.state` nor bus events reach clients.
- Receive it in the client `onEvent(payload, engine)` hook. The engine object has no `on()`.
- Pushes sent before the client module loaded are dropped; push periodically or answer a sync request from the client's `setup`

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

const resolveAbilityEffect = (ctx, casterId, ability, origin) => {
  if (ability.id === 'healing-aura') {
    ctx.players.getAll().forEach(p => {
      const pos = p.state?.position
      if (!pos) return
      const dist = Math.hypot(pos[0] - origin[0], pos[2] - origin[2])
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
const castAbility = (ctx, playerId, abilityId) => {
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
    
    damageEntity(ctx, playerId, boss, 30)
  })
}
```

---

## See Also

- [Spoint SKILL.md](../SKILL.md) — engine API reference
- [Game FSM guide](../apps/_lib/README.md#game-fsm) — state machine framework
- [Tutorial RPG source](../apps/rpg-tutorial/index.js) — working example
