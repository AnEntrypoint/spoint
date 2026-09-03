# spoint Quick Reference

## Run Commands

```bash
# Start server (default world: tps-game)
npm start
# or
npx spoint
# or
WORLD=tps-game node server.js

# Singleplayer mode (in-browser server)
# http://localhost:3001/?singleplayer

# Custom world
WORLD=matrix-construct node server.js
# http://localhost:3001/?singleplayer&world=matrix-construct

# Create new app
npx spoint-create-app my-app
npx spoint-create-app --template physics my-app

# Build for production
npm run build:client

# Static export (itch.io / GitHub Pages)
npm run static-export

# Verify
npm run check
npm test
```

## World Config Keys

```javascript
{
  port: 3001,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -9.81, 0],
  relevanceRadius: 200,
  physicsRadius: 30,
  physicsBodyBudget: 512,
  
  movement: {
    maxSpeed: 7, sprintSpeed: 12, groundAccel: 300, airAccel: 30,
    airMaxSpeed: 0.15, airSpeedCap: 16, friction: 5, stopSpeed: 1,
    jumpImpulse: 5.5, collisionRestitution: 0.2, collisionDamping: 0.25
  },
  
  player: {
    health: 100, capsuleRadius: 0.28, capsuleHalfHeight: 0.63,
    crouchHalfHeight: 0.315, mass: 120, modelScale: 1.323, feetOffset: 0.212
  },
  
  scene: {
    skyColor: 0x87ceeb, fogColor: 0x87ceeb, fogNear: 10000, fogFar: 20000,
    ambientColor: 0xfff4d6, ambientIntensity: 0.3,
    sunColor: 0xffffff, sunIntensity: 1.5, sunPosition: [21, 50, 20],
    fillColor: 0x4488ff, fillIntensity: 0.4, fillPosition: [-20, 30, -10],
    shadowMapSize: 1024, shadowBias: 0.0038, shadowNormalBias: 0.6
  },
  
  camera: {
    fov: 70, shoulderOffset: 0.35, headHeight: 1.85,
    zoomStages: [0, 2, 4, 8, 18], defaultZoomIndex: 2,
    followSpeed: 12, snapSpeed: 30, mouseSensitivity: 0.002,
    pitchRange: [-1.4, 1.4]
  },
  
  entities: [
    { id: 'terrain', app: 'terrain', config: { enabled: true, ... } },
    { id: 'map', model: './apps/maps/map.glb', position: [0,0,0], app: 'placed-model', config: { collider: 'trimesh' } },
    { id: 'game', position: [0,0,0], app: 'tps-game' }
  ],
  
  spawnPoint: [0, 2, 0],
  playerModel: './apps/tps-game/cleetus.vrm',
  trustedApps: ['terrain'],
  placeableApps: ['box-dynamic', 'destructible-box', ...]
}
```

## Physics Colliders

```javascript
ctx.physics.addColliderFromConfig({
  type: 'box',        // box | sphere | capsule | convex | trimesh | none
  size: [1, 1, 1],    // half-extents (box)
  radius: 0.5,        // sphere/capsule
  height: 1.8,        // capsule full height
  mass: 10,           // 0 = static
  dynamic: true,      // or kinematic: true
  position: [0, 1, 0], // offset from entity origin
  rotation: [0, 0, 0, 1]
})
```

**Important**: Capsule uses `height` = full height (halved internally). Trimesh = static only.

## Client Render Return

```javascript
render(ctx) {
  return {
    position: [x, y, z],
    rotation: [x, y, z, w],  // quaternion
    model: './path.glb',      // or procedural:
    custom: {
      mesh: 'box',            // box | sphere | cylinder
      color: 0xff0000,
      roughness: 0.8,
      sx: 2, sy: 2, sz: 2,    // FULL dimensions
      r: 1, seg: 16, h: 2,
      hover: 0.15, spin: 1,
      glow: true, glowColor: 0x00ff88,
      label: 'PRESS E'
    },
    ui: ctx.h('div', { class: 'btn' }, 'Click')  // HyperScript
  }
}
```

## Define* Factories

```javascript
ctx.defineHealth({ max: 100, respawnTime: 3 })
ctx.defineWeapon({ type: 'hitscan', damage: 25, fireRate: 10, magazineSize: 30, reloadTime: 2000 })
ctx.defineGameMode({ lobby: 10, warmup: 5, round: 300, end: 10 })
ctx.defineBuffStack({ maxStacks: 3, duration: 10 })
ctx.defineShrinkingZone({ initialRadius: 1000, finalRadius: 10, shrinkTime: 1200 })
ctx.definePickup({ onCollect: (ctx, player) => { ... } })
ctx.defineDestructible({ health: 100, debris: 10, debrisApp: 'destructible-debris' })
ctx.defineTeams({ teams: ['red', 'blue'], maxPerTeam: 16 })
ctx.defineSteering({ maxSpeed: 5, wanderRadius: 50 })
ctx.defineCheckpoint({ respawnAt: [0, 5, 0] })
ctx.defineGameFSM({ initial: 'idle', states: { ... } })
ctx.definePlayerInventory({ capacity: 20 })
ctx.definePath([[0,0,0], [10,0,10]])
```

## Client Input Object

```javascript
onInput(input, engine) {
  input.forward      // W / Up
  input.backward     // S / Down
  input.left         // A / Left
  input.right        // D / Right
  input.jump         // Space
  input.crouch       // Ctrl / C
  input.sprint       // Shift
  input.shoot        // Left click
  input.reload       // R
  input.emoteWheelHeld  // Q (hold)
  input.emoteDigit      // 1-8 (while holding Q)
  input.mouseX       // Mouse delta X
  input.mouseY       // Mouse delta Y
}
```

## Network Messages

```javascript
// Client -> Server
engine.client.sendFire({ origin: [x,y,z], direction: [x,y,z] })
engine.client.sendReload()
engine.client.sendEmote('wave')  // code from EMOTE_CLIPS

// Server -> Client (via onEvent)
{ type: 'hit', shooter, target, damage, headshot, pos, dir, knockback }
{ type: 'world_hit', pos, normal }
{ type: 'death', victim, killer, cause, headshot, streak, killerKills, killerName }
{ type: 'respawn', position, health, ammo, invulnMs }
{ type: 'buff_applied', duration, speed, fireRate, damage }
{ type: 'buff_expired' }
{ type: 'aimpunch', intensity }
{ type: 'empty_click' }
{ type: 'hazard_damage', playerId, damage }
{ type: 'reload_start', duration }
{ type: 'reload_complete' }
```

## Editor Shortcuts

| Key | Action |
|-----|--------|
| `P` | Toggle editor |
| `G` | Translate gizmo |
| `R` | Rotate gizmo |
| `S` | Scale gizmo |
| `F` | Focus selected |
| `Del` | Delete selected |
| Drag `.glb` | Place model |

## Verified Remote Models (unpkg)

```
https://raw.githubusercontent.com/anEntrypoint/assets/main/broken_car_b6d2e66d_v1.glb
https://raw.githubusercontent.com/anEntrypoint/assets/main/crashed_car_f2b577ae_v1.glb
https://raw.githubusercontent.com/anEntrypoint/assets/main/blue_shipping_container_60b5ea93_v1.glb
https://raw.githubusercontent.com/anEntrypoint/assets/main/dumpster_b076662a_v1.glb
https://raw.githubusercontent.com/anEntrypoint/assets/main/large_rock_051293c4_v1.glb
```

## Key Files

```
server.js                      # Entry point
src/sdk/TickHandler.js         # Main loop (movement → physics → apps → snapshot)
src/sdk/World.js               # Jolt physics world
src/apps/AppRuntime.js         # Entity/app lifecycle
src/apps/AppLoader.js          # Loads apps/ (blocks require, eval, etc.)
client/app.js                  # Three.js client entry
client/core/SceneSetup.js      # Renderer, camera, lights
client/core/EntityLoader.js    # GLB/VRM loading
client/core/PlayerMesh.js      # VRM avatar + animations
client/hud/Chat.js             # Chat HUD
client/hud/EmoteWheel.js       # Emote radial menu
scripts/bundle-client.mjs      # Production build (esbuild)
scripts/static-export.mjs      # Static export
scripts/check.mjs              # Parse validation
```