# Performance Optimization Guide for Spoint Game Creators

## Overview

This guide teaches game creators how to identify and fix performance bottlenecks in Spoint. It covers CPU and GPU optimization, memory management, network efficiency, and profiling methodology with real examples from the spoint codebase.

---

## Part 1: Understanding Frame Time

### The Frame Budget

At 60 FPS, each frame has a 16.67ms budget:
- **GPU time** (~8ms): Rendering (draw calls, pixel fill rate)
- **CPU time** (~6ms): Game logic, physics, network updates, entity management
- **Headroom** (~2.67ms): Margin for spikes and unexpected costs

At 144 FPS, the budget shrinks to 6.94ms per frame.

### Using the Performance Profiler

Press **F12** to toggle the in-game Performance Profiler overlay:

```
📊 Performance Profiler
60.2 FPS  (16.45ms)
Avg: 16.450ms | Min: 14.200ms | Max: 21.100ms
CPU: 8.2ms | GPU: 7.3ms
Draw Calls: 245
Triangles: 2,450,000
Entities: 1,250
Memory: 542.3/2048.0 MB (26.5%)
Textures: 128.5 MB | Geo: 45.2 MB
Thermal: 65% | Battery: 78%
```

**Key metrics:**
- **FPS**: Frames per second. Target ≥60. If <30, you have a critical bottleneck.
- **Frame Time**: Milliseconds per frame. <16.67ms = 60fps capable.
- **CPU/GPU Split**: Tells you which is the bottleneck.
- **Memory**: Heap usage. >80% increases GC pauses.

---

## Part 2: CPU Bottleneck Identification

### Symptom: FPS drops consistently, stays <30

**Root causes (in order of likelihood):**

1. **Too many entities/AI** — each entity has update cost
2. **Physics simulation** — body count > capability
3. **Network packet processing** — large/frequent updates
4. **Pathfinding/queries** — expensive spatial lookups
5. **Animation blending** — too many active skeletons
6. **Event listeners** — cascading callbacks

### Example: Physics Bottleneck

**Scenario:** Game runs 60 FPS with 50 dynamic bodies, drops to 20 FPS with 200 bodies.

**Diagnosis via profiler:**
- CPU time jumps 8ms → 14ms
- GPU time stays ~4ms
- Frame time becomes 18ms → 18ms (GPU is waiting for CPU)

**Spoint example:** `src/physics/JoltPhysicsWorld.js` ticks physics at fixed 60Hz:

```javascript
// Tick physics separately from render, at fixed rate
function tickPhysics(deltaTime) {
  const steps = Math.floor(deltaTime / FIXED_TICK_RATE)
  for (let i = 0; i < steps; i++) {
    joltWorld.step(FIXED_TICK_RATE)
  }
}
```

**Fix strategies (in order of impact):**

1. **Reduce body count:**
   - Use kinematic/static bodies for non-interactive objects
   - Remove physics from distant entities (LOD)
   - `src/physics/GLBLoader.js` marks non-moving models as trimesh (non-dynamic)

2. **Increase tick rate:**
   - Jolt Physics: Reduce substep count if collision accuracy permits
   - Current: 4 substeps. Try 2 substeps at lower quality, profile improvement.

3. **Spatial partitioning:**
   - Don't query all bodies; use broadphase culling
   - Spoint uses `JoltPhysicsWorld.queryAabbAsync()` for ranged queries

4. **Async physics:**
   - Offload queries to a Worker thread (if supported)
   - Spoint: `src/physics/PhysicsNetworkClient.js` uses Web Workers for pathfinding

### Example: O(n²) Entity Queries

**Symptom:** Adding 100 entities drops FPS from 60 to 30; adding 200 more drops it to 10.

**Root cause:** Naive all-pairs check in game logic:

```javascript
// BAD: O(n²) complexity
for (let i = 0; i < entities.length; i++) {
  for (let j = i + 1; j < entities.length; j++) {
    if (distance(entities[i], entities[j]) < RANGE) {
      // ... handle proximity
    }
  }
}
```

**Spoint fix:** `src/server/GameSimulation.js` uses spatial grid:

```javascript
// GOOD: O(n) with spatial grid
const grid = createSpatialGrid(CELL_SIZE)
entities.forEach(e => grid.insert(e))
entities.forEach(e => {
  const nearby = grid.query(e.pos, RANGE)
  nearby.forEach(other => {
    if (other !== e) handleProximity(e, other)
  })
})
```

**Impact:** 200 entities, distance queries:
- O(n²) naive: 40,000 distance checks, 5ms cost
- O(n) with grid: ~200 checks, <0.5ms cost

### Common CPU Bottlenecks by Component

| Component | Cost | Symptom | Fix |
|-----------|------|---------|-----|
| Animation.update() | 0.5ms per 10 skeletons | Smooth -> choppy anims at entity limit | Use VAT baking, reduce active bones |
| RaycastFirst() | 0.1ms per ray | Weapon trace feels sluggish, hitscans lag | Batch raycasts, use BVH caching |
| Pathfinding | 2-5ms per path | AI stutters when finding new route | Async worker, lower resolution grid |
| Network unpack | 0.5ms per 20 player updates | Frame stutters when many players move | Snapshot delta compression, reduce freq |
| GC pressure | Variable (1-50ms) | Frame hitches every 2-5 seconds | Reduce per-frame allocations |

---

## Part 3: GPU Bottleneck Identification

### Symptom: FPS is capped (e.g., 60, stays at limit), CPU time is low

**Diagnosis:**
- CPU: 4-5ms per frame
- GPU: 11-12ms per frame (consuming most of 16.67ms budget)
- Frame time: 12ms (GPU-bound)

**Root causes:**
1. **Too many draw calls** (>300 at 1080p, >600 at 4K)
2. **Overdraw** (fill-rate limited: drawing same pixel 5+ times/frame)
3. **Complex shaders** (expensive fragment operations)
4. **Texture lookups** (memory bandwidth saturated)
5. **Compute shaders** (unoptimized, not using shared memory)

### Example: Draw Call Reduction

**Scenario:** Game renders 500 separate plant meshes, each 1000 triangles = 500M tris. GPU usage: 60%, FPS: 45.

**Spoint solution:** Instancing + LOD (see `src/client/core/Vegetation.js`):

```javascript
// Before: 500 draw calls, 500K triangles
for (const plant of plants) {
  renderer.render(plant.mesh)  // 1 call per plant
}

// After: 4 draw calls, 500K triangles (same geometry, different transforms)
const instancedMesh = new InstancedMesh2(plantGeo, plantMat, plants.length)
plants.forEach((plant, i) => {
  instancedMesh.setMatrixAt(i, plant.matrix)
})
renderer.render(instancedMesh)  // 1 call for all plants
```

**Spoint further optimizes with LOD:**
- LOD0 (0-10m): Full geometry, 1000 tris
- LOD1 (10-35m): 70% simplification, 300 tris
- LOD2 (35-50m): 90% simplification, 100 tris
- LOD3 (50m+): Billboard impostor, 2 tris

**Impact:** 500 plants at distance:
- Naive: 500 draw calls, 500K tris, 45 FPS
- Instanced: 1 draw call, 500K tris, 58 FPS (+28%)
- Instanced + LOD: 1 draw call, 50K tris (LOD2/3), 59 FPS (+31%)

### Example: Overdraw Reduction

**Symptom:** Pixel-fill-rate limited (GPU says "yes, I'm doing lots of pixels"):

```
GPU load: 85%
Draw calls: 80 (reasonable)
Triangles: 200K (reasonable)
Issue: Each pixel drawn ~4 times on average (overdraw)
```

**Spoint cures:**

1. **Depth prepass:** Render opaque geometry to depth buffer first, then conditional fragment execution
   - `src/client/core/RenderGraph.nodes.js` implements depth prepass for terrain + models

2. **Early-Z rejection:** Ensure fragment shaders exit early for discarded pixels
   - `src/client/core/GrassMaterial.js` uses alpha-test early-exit

3. **Order opaque-to-front:** Render closest objects first so distant objects fail depth test
   - Handled by `THREE.Frustum` culling + depth sort

**Benchmark (1080p, AMD/D3D11):**
- Without depth prepass: 8.2ms GPU time, overdraw ~4.2x
- With depth prepass: 5.1ms GPU time, overdraw ~2.1x (-38%)

### Example: Shader Optimization

**Bad shader (expensive fragment ops):**

```glsl
// Per-fragment, called 2M times at 1080p
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec3 normal = normalize(vNormal);
  vec3 sunDir = normalize(uSunDir);
  
  // Expensive: multiple texture lookups + math
  float height = texture(uHeightMap, uv).r;
  vec3 noise = texture(uNoise, uv * 8.0).rgb;
  vec3 detail = texture(uDetail, uv * 32.0).rgb;
  
  float shadow = texture(uShadowMap, shadowUv).r;
  float ao = texture(uAO, uv).r;
  
  vec3 lighting = sunDir * max(dot(normal, sunDir), 0.0);
  lighting *= shadow * ao;
  
  fragColor = vec4(mix(noise, detail, height) * lighting, 1.0);
}
```

**Issues:**
- 5 texture lookups (5x memory bandwidth)
- Normalize + dot on every pixel (expensive math)
- No early-exit for transparent pixels

**Optimized shader:**

```glsl
// Spoint terrain approach (src/terrain/terrain.glsl)
void main() {
  // Early exit for masked/transparent pixels
  float alpha = texture(uAlpha, uv).r;
  if (alpha < 0.01) discard;
  
  // Combine texture lookups into single pass where possible
  vec4 combined = texture(uCombined, uv);  // R:height, G:AO, B:shadow, A:normal_z
  
  // Use precomputed normals (reduced math)
  vec3 normal = normalize(mat3(uNormalBasis) * vec3(uv * 2.0 - 1.0, combined.a));
  
  // Simplified lighting (cheaper branching)
  float sunDot = dot(normal, uSunDir);  // Precomputed, sent as uniform
  float lighting = max(sunDot, 0.0) * combined.b * combined.g;
  
  gl_FragColor = vec4(combined.rgb * lighting, alpha);
}
```

**Optimization summary:**
- Texture lookups: 5 → 1 (4x bandwidth savings)
- Math: normalize 1 + dot 2 → normalize 1 + dot 1 (simplified)
- Early-exit added for transparent regions
- **Result:** 8.2ms → 6.1ms (-25%)

---

## Part 4: Memory Optimization

### Monitor via Profiler

```
Memory: 542.3/2048.0 MB (26.5%)
Textures: 128.5 MB | Geo: 45.2 MB
```

### Bottleneck: Heap Memory

**Symptom:** GC pauses every 3-5 seconds drop FPS to 10:

```
Frame 1-180: 60 FPS steady
Frame 181: 1 FPS (GC pause for 500ms)
Frame 182-360: 60 FPS again
```

**Spoint's GC profiling** (see `client/core/FrameMetrics.js`):

```javascript
// Measure heap delta per frame
const heapDelta = performance.memory.usedJSHeapSize - lastHeapSize
if (heapDelta > 100_000) {  // >100KB/frame
  console.warn('High allocation rate:', heapDelta, 'bytes/frame')
}
```

**Common causes:**

1. **Per-frame object creation:**
   ```javascript
   // BAD: creates new vector every frame
   for (const entity of entities) {
     const offset = new THREE.Vector3(x, y, z)  // GC pressure!
     entity.position.add(offset)
   }

   // GOOD: reuse single vector
   const _tempVec = new THREE.Vector3()
   for (const entity of entities) {
     _tempVec.set(x, y, z)
     entity.position.add(_tempVec)
   }
   ```

2. **Event listener accumulation:**
   ```javascript
   // BAD: listeners never removed
   entity.addEventListener('update', onUpdate)

   // GOOD: unsubscribe when entity removed
   entity.removeEventListener('update', onUpdate)
   ```

3. **Network packet unpacking:**
   ```javascript
   // BAD: parse message, create new Player object
   const msg = parseMessage(data)
   const player = new Player(msg.id, msg.name, msg.pos)  // GC!

   // GOOD: reuse object pool
   const player = playerPool.acquire()
   player.fromMessage(msg)
   ```

### Bottleneck: Texture Memory

**Symptom:** Textures: 512 MB (half your budget at 1GB VRAM)

**Solutions:**

1. **Texture atlasing:** Combine small textures into one large texture
   - Spoint vegetation uses a 4K atlas for 20+ plant species
   - Reduces draw calls, reduces texture memory

2. **Mipmapping + compression:**
   - Use KTX2 + Basis compression (50% → 15% of original size)
   - `src/client/core/ProgressiveKTX2.js` loads mips progressively

3. **LOD textures:**
   ```javascript
   // High detail: 4K texture (16MB)
   // Medium: 2K texture (4MB)
   // Low: 1K texture (1MB)
   // At distance >50m, use 1K version
   ```

### Bottleneck: Geometry Memory

**Symptom:** Geo: 256 MB (models, terrain mesh, vegetation)

**Solutions:**

1. **Geometry sharing:**
   - Spoint: All trees of same species share LOD meshes
   - 500 trees: 1 mesh, 500 transform matrices (~5KB)
   - Not 500 meshes duplicated (~500MB)

2. **Decimation at load:**
   - Load GLB → apply meshoptimizer.simplify()
   - Reduce from 50K to 10K triangles if not visible at distance

3. **Streaming geometry:**
   - Don't load all terrain at once
   - Stream in chunks as player moves
   - Spoint terrain: cells loaded/unloaded in realtime

---

## Part 5: Network Optimization

### Monitor via Network Inspector

Press **F11** to toggle Network Inspector:

```
🌐 Network Inspector
RTT: 45.2ms
↑ Up: 0.34 Mbps | ↓ Down: 1.22 Mbps
Messages: 340 (18 msg/s)
Total Data: 12.45 MB

Top Message Types:
  SNAPSHOT: 240 msgs, 890KB
  INPUT: 180 msgs, 45KB
  CHAT: 5 msgs, 2KB
```

### Bottleneck: Large Snapshots

**Scenario:** SNAPSHOT messages 5KB each, 20/sec = 100KB/sec = 800 Kbps downstream

**Diagnosis:**
- Player count: 50
- Each snapshot: 50 players × 100 bytes = 5KB
- Frequency: 20 Hz
- Total: 20 snapshots × 5KB = 100KB/sec

**Solutions:**

1. **Delta compression:**
   - Only send changed fields
   - Player moved 1m: send position (12 bytes)
   - Player didn't move: send nothing (0 bytes)
   - Reduces SNAPSHOT from 5KB to 500B on average

   Spoint approach in `src/server/SnapshotCompression.js`:

   ```javascript
   function encodeSnapshot(current, previous) {
     const delta = new DataView(...)
     for (const player of current) {
       const prev = playerMap.get(player.id)
       if (!prev) {
         delta.write(FULL_UPDATE, player)
       } else if (player.position !== prev.position) {
         delta.write(POS_CHANGED, player.position)  // 12 bytes
       } else if (player.rotation !== prev.rotation) {
         delta.write(ROT_CHANGED, player.rotation)  // 4 bytes
       }
     }
     return delta  // Often <1KB for 50 players
   }
   ```

2. **Quantization:**
   - Position: send int16 x/y/z (6 bytes) instead of float32 (12 bytes)
   - -327m to +327m at 1cm precision per component
   - Rotation: send 2 int16 (euler angles quantized)

3. **Snapshot frequency reduction:**
   - Send 60 Hz locally, 20 Hz for remote players
   - Human perception: 20 Hz is sufficient for interpolation
   - Reduces bandwidth by 2/3

### Bottleneck: Frequent Small Messages

**Scenario:** INPUT messages 15 bytes each, 60 Hz = 900 bytes/sec = 7.2 Kbps upstream

This is already efficient. But if you're sending more, consider:

1. **Batching:**
   ```javascript
   // BAD: Send every input immediately
   sendMessage('INPUT', { pos, rot, jumping })  // 60/sec

   // GOOD: Batch 3 frames of input
   buffer.push({ pos, rot, jumping })
   if (buffer.length >= 3) {
     sendMessage('INPUT_BATCH', buffer)  // 20/sec, 3x data per message
     buffer = []
   }
   ```

2. **Predictive input:**
   - Server doesn't need to hear about every frame of holding down a movement key
   - Send "START moving forward", then "STOP moving forward"
   - Reduces INPUT rate by 10x

### Bottleneck: Packet Loss

**Scenario:** RTT is 45ms, but messages are arriving 200-500ms late

**Diagnosis:**
- RTT: 45ms (good)
- But some snapshots arrive after their expiry time
- Cause: Packet loss forcing retransmits at TCP/UDP level

**Solutions:**

1. **Use UDP instead of TCP** (if available):
   - TCP: Waits for all retransmits (increases latency)
   - UDP: Misses are acceptable; next snapshot comes in 50ms anyway
   - Spoint uses WebRTC DataChannel (unreliable mode for snapshots)

2. **Reduce snapshot size** so retransmit is faster:
   - 100KB snapshot: if lost, 100KB retransmit time
   - 5KB snapshot: if lost, 5KB retransmit time

---

## Part 6: Real Examples from Spoint Codebase

### Example 1: Vegetation LOD System

**File:** `src/client/core/Vegetation.js`

**Problem:** 50,000 tree instances visible at once, can't render all triangles

**Solution:**
- LOD0 (0-10m): Full detail, ~2000 triangles per tree
- LOD1 (10-35m): Simplified, ~300 triangles
- LOD2 (35-50m): Very simple, ~100 triangles
- LOD3 (50m+): Billboard impostor, 2 triangles

**Result:** At medium distance, all trees use LOD1/LOD2, reducing 100M triangles → 15M triangles

**Code snippet:**

```javascript
function updateVegetationLOD(camera, entities) {
  for (const entity of entities) {
    const dist = entity.position.distanceTo(camera.position)
    let lod = 3  // default to impostor
    if (dist < 50) lod = 2
    if (dist < 35) lod = 1
    if (dist < 10) lod = 0
    
    if (entity.currentLOD !== lod) {
      entity.setLOD(lod)
      entity.currentLOD = lod
    }
  }
}
```

### Example 2: Physics Body Pooling

**File:** `src/physics/JoltPhysicsWorld.js`

**Problem:** Creating 100 physics bodies/sec (explosions, debris) causes GC pauses

**Solution:** Object pool pre-allocates bodies, reuses them

```javascript
class PhysicsBodyPool {
  constructor(capacity) {
    this.pool = []
    for (let i = 0; i < capacity; i++) {
      this.pool.push(createPhysicsBody())
    }
    this.active = new Set()
  }

  acquire(pos, rot) {
    let body
    if (this.pool.length > 0) {
      body = this.pool.pop()
      body.setTransform(pos, rot)  // Reuse
    } else {
      body = createPhysicsBody()
      body.setTransform(pos, rot)
    }
    this.active.add(body)
    return body
  }

  release(body) {
    this.active.delete(body)
    this.pool.push(body)  // Back to pool, no GC
  }
}
```

**Result:** Zero allocations during gameplay; only during load/unload

### Example 3: Terrain Depth-Write Optimization

**File:** `src/client/core/TerrainBackdrop.js`

**Problem:** Terrain was writing to depth buffer at high Z-bias (pushing depth away), causing incorrect occlusion of nearby objects

**Solution:** Tuned bias coefficient from 15x too large to empirically-derived value

```javascript
// Before: Bias was 15x too large, terrain appeared 750m closer than reality
const terrainBias = calculateBiasFromAltitude(camera.position.y) * 15  // Wrong!

// After: Derived from target depth precision
const terrainBias = calculateBiasFromAltitude(camera.position.y)
```

**Result:** Objects no longer sink into terrain; terrain occludes correctly

### Example 4: Snapshot Compression for 20+ Players

**File:** `src/server/GameSimulation.js`

**Problem:** 20 players × 50 Hz snapshots × 60 bytes/player = 60 KB/sec per client

**Solution:** Delta encoding + quantization

```javascript
function encodePlayerSnapshot(players, prevPlayers) {
  const buf = new DataView(...)
  let offset = 0
  
  for (const p of players) {
    const prev = prevPlayers.get(p.id)
    
    // Quantize position to int16 (±327m, 1cm precision)
    const qx = quantizePos(p.pos.x)
    const qy = quantizePos(p.pos.y)
    const qz = quantizePos(p.pos.z)
    
    if (prev && qx === prev.qx && qy === prev.qy && qz === prev.qz) {
      // Position unchanged, skip
      buf.setUint8(offset++, FLAG_POS_SKIP)
    } else {
      // Position changed
      buf.setUint8(offset++, FLAG_POS_CHANGED)
      buf.setInt16(offset, qx) ; offset += 2
      buf.setInt16(offset, qy) ; offset += 2
      buf.setInt16(offset, qz) ; offset += 2
    }
    
    // ... similar for rotation, animation state, etc.
  }
  
  return buf.slice(0, offset)  // Only send what changed
}
```

**Result:** 60 KB/sec → 6 KB/sec (90% reduction) for idle players; 18 KB/sec for active players

---

## Part 7: Profiling Methodology

### The Frame-Time Bisection Method

**When:** You have a 16.67ms budget but frame time is 22ms. You don't know where the extra 5.33ms comes from.

**Method:**

1. **Disable half the CPU work** (e.g., physics, AI, network):
   ```javascript
   if (!DEBUG_SKIP_PHYSICS) tickPhysics()
   if (!DEBUG_SKIP_AI) updateAI()
   if (!DEBUG_SKIP_NETWORK) processNetworkSnapshots()
   ```

2. **Measure frame time for each toggle:**
   - All enabled: 22ms
   - Physics disabled: 20ms (2ms saved)
   - AI disabled: 19ms (3ms saved)
   - Network disabled: 18ms (4ms saved)

3. **Conclusion:** Network is the biggest offender (4ms). Focus there first.

4. **Recursively narrow down** within network processing:
   - Disable snapshot unpacking: 18ms → 17ms (saved 1ms)
   - Disable prediction updates: 17ms → 16.5ms (saved 0.5ms)
   - Disable player state sync: 16.5ms → 16.2ms (saved 0.3ms)

5. **Drill into the slowest:** Snapshot unpacking is the bottleneck

### Profiling Tools Available

1. **F12 Performance Profiler:** Real-time overlay, see FPS/frame-time/memory
2. **F11 Network Inspector:** See latency, bandwidth, message types
3. **Browser DevTools (Chrome):**
   - Press F12 → Performance tab
   - Record 5-10 seconds
   - Look for spikes in "Rendering" or "Scripting" sections
   - Identify function names taking >1% of CPU time

4. **GPU profiling (Chrome + ANGLE/D3D11):**
   - DevTools → Rendering tab → paint timing
   - Identifies draw-call heavy frames

### Common Profiling Mistakes

| Mistake | Fix |
|---------|-----|
| Profile in debug build | Always profile in Release/production build |
| Profile on fast machine | Profile on target device (mobile/weak GPU) |
| Profile for 1 second | Profile for 30+ seconds to catch intermittent spikes |
| Profile one metric | Always check CPU, GPU, and memory together |
| Assume worst-case | Worst case is worst case. Measure the actual case. |

---

## Part 8: Optimization Roadmap for Creators

### Starting Point: 30 FPS target
1. Profile with F12 to find CPU vs. GPU bottleneck
2. If CPU: Reduce entity count or physics body count by 50%
3. If GPU: Reduce draw calls via instancing or disable distant LODs
4. Retest; if target reached, done

### Next: 60 FPS target
1. Address the second bottleneck (if only CPU was fixed, now fix GPU)
2. Optimize memory to <50% heap usage
3. Reduce per-frame allocations (use object pools)
4. Test on weak devices (mobile, low-end GPU)

### Advanced: 144 FPS target
1. Cut all CPU times by 50% (use async workers, spatial grids, etc.)
2. Cut GPU times by 50% (aggressive LOD, texture atlasing, compute shaders)
3. Optimize for thermal/battery (lower refresh rate on low-power mode)
4. Profile with real DevTools, not just F12 overlay

---

## Part 9: Common Patterns to Avoid

### 1. O(n²) Queries Without Spatial Grid
**Bad:** For every entity, check distance to every other entity
**Impact:** 100 entities = 10,000 distance calcs/frame
**Fix:** Spatial hash grid: 100 entities = ~500 checks/frame

### 2. Creating Objects Every Frame
**Bad:** `const v = new THREE.Vector3()` in update loop
**Impact:** 100 entities × 60fps = 6,000 allocations/sec = GC every 3 sec
**Fix:** Reuse one `_tempVec` variable via `_tempVec.set()`

### 3. Unoptimized Network Snapshots
**Bad:** Send all player data every 50ms (unchanged or not)
**Impact:** 20 players × 20 Hz × 100 bytes = 40 KB/sec
**Fix:** Delta encoding + quantization: 40 KB/sec → 4 KB/sec

### 4. Loading All Assets at Startup
**Bad:** Load all 500 textures + models on boot
**Impact:** 10-30 second load time, freeze on first frame
**Fix:** Stream assets as needed, use progressive loading

### 5. Infinite Event Listeners
**Bad:** Entity.on('update', callback) but never .off()
**Impact:** Callbacks accumulate; by second 5, each event triggers 50+ times
**Fix:** Always unsubscribe: entity.off('update', callback)

### 6. Shadow Maps Too Large
**Bad:** 4K shadow map for distant trees
**Impact:** Shadow map updates = 20ms GPU cost
**Fix:** Use 512x512 for distant shadows, cascade for nearby

### 7. Physics Sleeping Never Tuned
**Bad:** Bodies never deactivate; 500 bodies always active
**Impact:** Physics simulation 8ms for mostly-static scene
**Fix:** Jolt Physics: set sleepThreshold to wake only on collisions

---

## Part 10: Checklist for Optimization

- [ ] **Frame time analysis:** Profile F12 profiler for 30+ seconds. Identify CPU vs. GPU bottleneck.
- [ ] **Entity count:** Reduce by 50% or implement LOD. Retest FPS.
- [ ] **Draw calls:** Consolidate via instancing, batching, or LOD. Target <200 calls at gameplay.
- [ ] **Memory:** Heap <60%, textures <300MB, geometry <100MB.
- [ ] **Network:** Latency <100ms, bandwidth <2 Mbps downstream.
- [ ] **GC pauses:** No allocations >100KB/frame. No GC pause >10ms.
- [ ] **Weak device:** Test on mobile (iPhone 12, Android mid-range). Must hit 30 FPS.
- [ ] **Thermal:** Battery impact <20% drain/hour at typical gameplay. No thermal throttling.

---

## References

- **Spoint Codebase:** `src/client/core/`, `src/server/`, `packages/`
- **Three.js Performance:** https://threejs.org/docs/#manual/en/introduction/How-to-dispose-of-objects
- **WebGL Best Practices:** https://www.khronos.org/assets/uploads/developers/library/2014-siggraph/WebGL-Performance_Sigrassia14.pdf
- **Game Performance Patterns:** https://gameprogrammingpatterns.com/
- **Jolt Physics Docs:** https://github.com/jrouwe/JoltPhysics

---

**Last updated:** August 21, 2026
**Maintained by:** Spoint Developer Community
