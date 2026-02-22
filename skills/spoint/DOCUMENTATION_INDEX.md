# Spawnpoint App Creator Skill - Documentation Index

Quick navigation to all documentation and resources for creating Spawnpoint apps.

## Start Here

**New to Spawnpoint apps?** Start with one of these:

1. **[SKILL.md](./SKILL.md)** - 5-minute overview of the entire skill
2. **[README_SKILL.md](./README_SKILL.md)** - Comprehensive but accessible introduction
3. **[Practical Quick Start](#quick-start-5-minutes)** - Get your first app running

## Documentation Files

### Phase 1: Getting Started (15 minutes)

| File | Lines | Size | Purpose |
|------|-------|------|---------|
| [SKILL.md](./SKILL.md) | 422 | 9.4 KB | Skill overview, quick reference, common patterns |
| [README_SKILL.md](./README_SKILL.md) | ~400 | ~12 KB | Comprehensive introduction with examples |

**Best for**: Quick overview, understanding what's available, common patterns

### Phase 2: Learning (1-2 hours)

| File | Lines | Size | Purpose |
|------|-------|------|---------|
| [skill-docs/spoint-app-creator.md](./skill-docs/spoint-app-creator.md) | 473 | 11.4 KB | Quick reference guide with API overview |
| [skill-docs/spoint-app-creation.md](./skill-docs/spoint-app-creation.md) | 864 | 18.9 KB | Complete 800-line guide with full API reference |
| [EXAMPLES.md](./EXAMPLES.md) | 461 | 11.2 KB | 5+ working code examples with detailed comments |

**Best for**: Learning the complete API, understanding patterns, copying examples

### Phase 3: Reference (ongoing)

| File | Purpose |
|------|---------|
| [SKILL.md](./SKILL.md) | Quick API reference |
| [skill-docs/spoint-app-creator.md](./skill-docs/spoint-app-creator.md) | Pattern examples and API overview |
| [skill-docs/spoint-app-creation.md](./skill-docs/spoint-app-creation.md) | Detailed API reference and advanced topics |

**Best for**: Looking up specific methods, checking syntax, troubleshooting

### Project Reports

| File | Purpose |
|------|---------|
| [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) | What was created and how to use it |
| [FINAL_REPORT.md](./FINAL_REPORT.md) | Complete implementation report with metrics |

## Quick Start (5 minutes)

### 1. Create Your First App
```bash
spoint-create-app my-first-app
```

### 2. Start the Server
```bash
npm start
```

### 3. Open Browser
Visit http://localhost:3001

### 4. Spawn Your App
Create a new entity with app: `my-first-app`

### 5. Edit and Hot-Reload
Edit `apps/my-first-app/index.js` - changes reload automatically!

## CLI Command: spoint-create-app

Create new apps from templates:

```bash
# Basic app (default)
spoint-create-app my-app

# Physics-based object
spoint-create-app --template physics my-ball

# Interactive button/chest
spoint-create-app --template interactive my-chest

# Entity spawner
spoint-create-app --template spawner my-spawner

# Show help
spoint-create-app --help
```

**Location**: [bin/create-app.js](./bin/create-app.js)

## Context API Quick Reference

### Most Common (You'll use these constantly)

| Method | Usage |
|--------|-------|
| `ctx.entity.position` | Get/set entity position |
| `ctx.entity.rotation` | Get/set entity rotation |
| `ctx.state` | Persistent mutable state object |
| `ctx.time.every(seconds, fn)` | Repeat function on interval |
| `ctx.network.broadcast(msg)` | Send message to all players |
| `ctx.physics.setDynamic(true)` | Make entity dynamic (gravity) |
| `ctx.physics.addBoxCollider([x,y,z])` | Add box physics |
| `ctx.world.spawn(id, config)` | Spawn new entity |
| `ctx.players.getNearest(pos, radius)` | Find nearest player |

See [Complete API Reference](#complete-api-reference) below for all methods.

## Complete API Reference

For the full context API with all methods, see:
- **Quick overview**: [SKILL.md § Context API](./SKILL.md#context-api-reference)
- **Detailed reference**: [skill-docs/spoint-app-creator.md § Context API](./skill-docs/spoint-app-creator.md#context-api-reference)
- **Very detailed**: [skill-docs/spoint-app-creation.md § Context API](./skill-docs/spoint-app-creation.md#context-api-ctx)

Topics covered:
- Entity & Rendering
- Physics System
- World Access
- Player Interaction
- Timing & Scheduling
- Networking & Storage
- Debugging

## Lifecycle Hooks Reference

### Server Hooks

| Hook | Called When | Purpose |
|------|-------------|---------|
| `setup(ctx)` | Entity spawns | Initialize state, physics, timers |
| `update(ctx, dt)` | Every tick | Continuous logic |
| `teardown(ctx)` | Entity destroyed | Clean up resources |
| `onMessage(ctx, msg)` | Message received | Handle communication |

### Client Hooks

| Hook | Called When | Purpose |
|------|-------------|---------|
| `setup(engine)` | App loads | Initialize client |
| `onFrame(dt, engine)` | Each render frame | Animation, visual updates |
| `onInput(input, engine)` | Input received | Keyboard, gamepad |
| `onEvent(payload, engine)` | Server message | Handle server messages |
| `render(ctx)` | Each frame | Return visual data |
| `teardown(engine)` | App unloads | Cleanup |

See [Complete Lifecycle Reference](#lifecycle-documentation) below for details.

## Common Patterns

Find complete working examples in [EXAMPLES.md](./EXAMPLES.md):

1. **Health System** - Damage, healing, death mechanics
2. **Projectile System** - Collision detection, effects
3. **Loot Drops** - Item pickup mechanics
4. **Environmental Hazards** - Damage areas
5. **Interactive Objects** - Player interaction
6. **Spawners** - Create child entities
7. **Physics Bodies** - Dynamic objects
8. **Ability Triggers** - Special actions
9. **Respawn Points** - Player respawning

Each example is fully commented and ready to copy.

## Lifecycle Documentation

### Understanding the App Lifecycle

**Read**: [skill-docs/spoint-app-creation.md § App Lifecycle](./skill-docs/spoint-app-creation.md#app-lifecycle)

Topics covered:
- Server-side lifecycle (setup → update → teardown)
- Client-side lifecycle (setup → render → teardown)
- When each hook is called
- What happens at each stage
- Best practices per stage

### Detailed Hook Reference

See [skill-docs/spoint-app-creation.md § Lifecycle Hooks](./skill-docs/spoint-app-creation.md#lifecycle-hooks)

Covers:
- All server hooks with examples
- All client hooks with examples
- Common patterns per hook
- Anti-patterns to avoid

## Best Practices

**Essential reading**: [SKILL.md § Best Practices](./SKILL.md#best-practices)

Key principles:
1. Use `ctx.state` for persistence
2. Clean up on teardown
3. Use non-blocking code
4. Keep apps focused
5. Handle async messaging

Plus 7+ additional principles in the full guides.

## Troubleshooting

**Common issues**: [SKILL.md § Troubleshooting](./SKILL.md#troubleshooting)

Covers:
- App not loading
- Physics not working
- State not persisting
- Messages not arriving
- Performance issues

**Detailed guide**: [skill-docs/spoint-app-creation.md § Troubleshooting](./skill-docs/spoint-app-creation.md#troubleshooting)

More topics:
- Debugging strategies
- Using ctx.debug
- Inspecting state
- Testing locally

## Real Examples to Study

Don't miss these existing apps:

- **[apps/physics-crate](./apps/physics-crate)** - Simplest example (physics)
- **[apps/interactable](./apps/interactable)** - Interactive pattern
- **[apps/power-crate](./apps/power-crate)** - Spawner pattern
- **[apps/tps-game](./apps/tps-game)** - Complex multiplayer game

Reading existing code is one of the best ways to learn!

## Learning Path

### Beginner (1st app, 30 minutes)
1. Read [SKILL.md](./SKILL.md) - Get overview (5 min)
2. Run `spoint-create-app my-app` - Create scaffold (1 min)
3. Start server and spawn entity (2 min)
4. Read [EXAMPLES.md § Health System](./EXAMPLES.md#health-system) (10 min)
5. Copy example and modify (10 min)

### Intermediate (Complex apps, 2-4 hours)
1. Read [README_SKILL.md](./README_SKILL.md) - Full overview (30 min)
2. Study [skill-docs/spoint-app-creator.md](./skill-docs/spoint-app-creator.md) (1 hour)
3. Read [EXAMPLES.md](./EXAMPLES.md) - All examples (30 min)
4. Study [apps/physics-crate](./apps/physics-crate) and [apps/interactable](./apps/interactable) (30 min)
5. Build your own complex app (1 hour)

### Advanced (Mastery, ongoing)
1. Read [skill-docs/spoint-app-creation.md](./skill-docs/spoint-app-creation.md) (1-2 hours)
2. Study [apps/tps-game](./apps/tps-game) - Complex system (1-2 hours)
3. Build advanced systems with multiple apps
4. Reference detailed guides as needed

## File Locations

All Spawnpoint app files:

```
C:/dev/devbox/spawnpoint/
├── bin/
│   └── create-app.js                    # CLI tool
├── skill-docs/
│   ├── spoint-app-creator.md            # Quick ref
│   └── spoint-app-creation.md           # Full guide
├── SKILL.md                             # Overview
├── README_SKILL.md                      # Intro
├── EXAMPLES.md                          # Code examples
├── IMPLEMENTATION_SUMMARY.md            # Project summary
├── FINAL_REPORT.md                      # Full report
├── DOCUMENTATION_INDEX.md               # This file
├── apps/
│   ├── my-first-app/                    # Your app
│   │   └── index.js
│   ├── physics-crate/                   # Examples
│   ├── interactable/
│   ├── power-crate/
│   └── tps-game/
└── package.json                         # Updated
```

## By Role

### I'm a Designer
- Start: [SKILL.md](./SKILL.md) (understand what apps can do)
- Reference: [EXAMPLES.md § Interactive Objects](./EXAMPLES.md#interactive-object)
- Build: Interactive objects, UI, triggers

### I'm a Programmer
- Start: [README_SKILL.md](./README_SKILL.md) (complete overview)
- Learn: [skill-docs/spoint-app-creation.md](./skill-docs/spoint-app-creation.md) (full API)
- Reference: [SKILL.md](./SKILL.md) (quick lookup)
- Build: Any app type, complex systems

### I'm a Game Designer
- Start: [SKILL.md](./SKILL.md) (overview)
- Learn: [EXAMPLES.md](./EXAMPLES.md) (patterns)
- Reference: [skill-docs/spoint-app-creator.md](./skill-docs/spoint-app-creator.md)
- Build: Game systems, level design, content

### I'm Reviewing This Skill
- Read: [FINAL_REPORT.md](./FINAL_REPORT.md) (complete report)
- Summary: [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)
- Overview: [SKILL.md](./SKILL.md)

## What's Next?

1. ✓ Read this index (you're here!)
2. → Pick a starting point from [Learning Path](#learning-path)
3. → Create your first app with `spoint-create-app`
4. → Reference guides as you build
5. → Study examples and existing apps
6. → Build your own systems!

---

**Status**: Documentation complete and ready to use.

**Questions?** Check [Troubleshooting](#troubleshooting) or review the relevant section of your learning path.

**Ready to start?** Run:
```bash
spoint-create-app my-awesome-app
npm start
```

Then open http://localhost:3001 and start building!
