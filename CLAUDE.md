# Technical Caveats

## Jolt Physics WASM Memory

Jolt getter methods (GetLinearVelocity, GetPosition, GetRotation) return WASM objects that MUST be destroyed with `Jolt.destroy()` after reading values. Failing to destroy causes unbounded WASM heap growth (~30MB/5min).

Jolt setter methods: reuse pre-allocated Vec3/RVec3 via `.Set()` instead of `new`. World.js stores `_tmpVec3` and `_tmpRVec3` for this.

## CharacterVirtual Gravity

Jolt's `CharacterVirtual.ExtendedUpdate()` does NOT apply gravity to velocity internally. The manual gravity in `PhysicsIntegration.js` is the ONLY gravity source. Removing it causes zero gravity.

## Three.js Shadow Corner Lines

Bright lines appear at geometry seam corners with default shadow rendering. Fix: set `material.shadowSide = THREE.BackSide` on environment meshes. This renders back faces into the shadow map, eliminating edge artifacts. VSMShadowMap causes blurred cutout artifacts - use PCFSoftShadowMap.

## Snapshot Encoding at 0 Players

TickHandler must skip snapshot creation/broadcast when 0 players are connected. Otherwise msgpackr encoding runs 128x/sec for nobody.

## LagCompensator Ring Buffer

Uses fixed-size ring buffer (128 slots) instead of array + shift(). Array.shift() is O(n) and caused GC pressure at 128 TPS.

## Network Protocol Binary Format

Message types: 1=player_assigned, 2=world_state, 3=input, 4=interact, 5=disconnect, 6=snapshot. Player array: `[id, px, py, pz, rx, ry, rz, rw, vx, vy, vz, onGround, health, inputSeq]`. Changing field order breaks all clients.

## App Hot Reload

`ctx.state` survives hot reload. All other app state is destroyed. Apps must store persistent data in `ctx.state` or it will be lost on file change.

## Entry Points

Server: `node server.js` (port 8080, 128 TPS). World config: `apps/world/index.js`. Apps: `apps/<name>/index.js` with `server` and `client` exports.
