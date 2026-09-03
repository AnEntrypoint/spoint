# Navmesh Baking & Pathfinding Guide

Navmesh-based pathfinding enables NPCs, bots, and other scripted units to navigate complex multiplayer worlds intelligently, planning routes around obstacles and terrain.

## Architecture

### Pipeline

1. **Baking** (offline, pre-deploy)
   - Input: World GLB + collision geometry (placed-model instances + terrain)
   - Process: Recast-navigation geometry rasterization, region formation, polygon mesh generation
   - Output: `apps/world/<name>.navmesh.json` with vertices, polygons, and connectivity

2. **Runtime** (server-side app)
   - Load navmesh JSON at app init
   - Query pathfinding via `NavmeshQuery.findPath(from, to)`
   - Returns waypoint array for steering toward destination

3. **Movement** (steering)
   - Use existing `ctx.defineSteering()` system to follow waypoints
   - Optional local obstacle avoidance via raycast
   - Entity position updated each tick

### Data Structure

The navmesh JSON contains:

```json
{
  "version": 1,
  "config": {
    "cellSize": 0.3,
    "cellHeight": 0.2,
    "agentHeight": 1.7,
    "agentRadius": 0.4,
    "agentMaxClimb": 0.5,
    "agentMaxSlope": 45
  },
  "bounds": {
    "min": [-1000, -100, -1000],
    "max": [1000, 1000, 1000]
  },
  "vertices": [[x, y, z], ...],
  "polygons": [
    {
      "vertices": [vi0, vi1, vi2, ...],
      "flags": 0,
      "area": 0
    },
    ...
  ],
  "links": [
    {
      "polygon": 0,
      "neighbors": [1, 2, 5]
    },
    ...
  ]
}
```

## Baking Workflow

### 1. Prepare World GLB

Ensure your world GLB has proper collision geometry:
- Place models via the editor's "Add" menu or `worldDef.entities`
- Models automatically get collision (trimesh for static, convex hull for dynamic)
- Terrain provides ground collision automatically

Example world definition:
```javascript
export const worldDef = {
  terrain: { type: 'simplex', octaves: 6, scale: 300, baseHeight: 50 },
  entities: [
    { type: 'placed-model', model: 'trees/oak.glb', position: [0, 0, 10] },
    { type: 'placed-model', model: 'rocks/boulder.glb', position: [20, 0, 0] },
  ],
}
```

### 2. Run Bake CLI

```bash
npm run bake-navmesh --world=aim_sillos
```

Options:
- `--world=<name>` — World name (default: aim_sillos)
- `--verbose` — Detailed error output

Output:
- `apps/world/<name>.navmesh.json` (created if not exists)
- Console reports: vertex count, polygon count, file size, bake time

Bake time target: **<30 seconds** for typical worlds

### 3. Verify Bake

Check the generated JSON:
```bash
cat apps/world/aim_sillos.navmesh.json | jq '.polygons | length'
```

The JSON should contain:
- `vertices`: 100+ navigable positions
- `polygons`: 50+ walkable regions
- `links`: Connectivity between regions

## Runtime Integration

### Loading Navmesh

```javascript
import { NavmeshQuery } from '../../src/pathfinding/NavmeshQuery.js'

// In app setup:
const response = await fetch(`/apps/world/${worldName}.navmesh.json`)
const navmeshData = await response.json()
const navmesh = new NavmeshQuery(navmeshData)
```

### Pathfinding API

```javascript
// Find path between two points
const waypoints = navmesh.findPath(
  [10, 5, 20],    // start position
  [100, 5, 50],   // goal position
  { /* config */ }
)

if (!waypoints) {
  console.log('No path found (unreachable or outside navmesh)')
} else {
  console.log(`Path has ${waypoints.length} waypoints`)
  // Use waypoints for steering
}
```

Returns: `Array<[x, y, z]>` waypoint positions, or `null` if unreachable

### NPC Steering Example

Use the built-in `npc-navigator` app:

```javascript
// Place NPC in editor or via worldDef
ctx.world.sendToEntity(npcEntityId, {
  type: 'setTarget',
  position: [100, 5, 50]
})
```

Or in a custom app:

```javascript
setup(ctx) {
  ctx.state.navmesh = new NavmeshQuery(navmeshData)
  ctx.state.steering = ctx.defineSteering({ speed: 3, arriveRadius: 0.5 })
},

update(ctx, dt) {
  const pos = ctx.entity.position
  const target = ctx.state.currentTarget

  const waypoints = ctx.state.navmesh.findPath(pos, target)
  if (!waypoints || waypoints.length === 0) return

  const nextWaypoint = waypoints[1] || waypoints[0]
  const result = ctx.state.steering.step(pos, nextWaypoint, dt)
  ctx.entity.position = result.position
}
```

## Patrol Routes

The `npc-navigator` app supports patrol behavior:

```javascript
// Define patrol route (ordered waypoints)
const patrolRoute = [
  [0, 0, 0],
  [50, 0, 0],
  [50, 0, 50],
  [0, 0, 50],
]

// Start patrol
ctx.world.sendToEntity(npcEntityId, {
  type: 'startPatrol',
  route: patrolRoute,
})

// Stop patrol
ctx.world.sendToEntity(npcEntityId, {
  type: 'stop',
})
```

## Combat Bot Integration

The combat-bot app can be enhanced to use navmesh pathfinding:

```javascript
// In combat-bot setup:
ctx.state.navmesh = new NavmeshQuery(navmeshData)

// In combat-bot update (when pursuing target):
const targetPos = target.state.position
const waypoints = ctx.state.navmesh.findPath(pos, targetPos)

if (waypoints && waypoints.length > 1) {
  // Path found: navigate around obstacles
  const nextWaypoint = waypoints[1]
  const result = ctx.state.steering.step(pos, nextWaypoint, dt)
  ctx.entity.position = result.position
} else if (los && dist <= range) {
  // No pathfinding: close range with LOS, just steer direct
  const r = ctx.state.steering.step(pos, [tp[0], pos[1], tp[2]], dt)
  ctx.entity.position = r.position
}
```

## Performance

### Baking

- Typical world (<1000 entities): 10–25 seconds
- Large world (10,000+ entities): 20–60 seconds
- Output file: 50–500 KB depending on complexity

### Pathfinding Queries

- Single query: <5ms
- 10 concurrent queries: <50ms
- LRU cache: 100 entries (reuses recent paths)

### Concurrent NPCs

- 10 NPCs pathfinding: <10% CPU overhead
- 50 NPCs pathfinding: <30% CPU overhead
- Ideal for tower-defense, wave-defense, crowd scenarios

## Troubleshooting

### "No navmesh found"

**Cause**: `apps/world/<name>.navmesh.json` doesn't exist
**Fix**: Run `npm run bake-navmesh --world=<name>`

### "Pathfinding returns null"

**Cause**: Start or goal position outside navmesh bounds or in unwalkable region
**Fix**: 
1. Verify world bounds in bake config
2. Check navmesh coverage with a visualization tool
3. Adjust walkable slope/height in bake config and re-bake

### "NPC stuck/jittering at waypoint"

**Cause**: Waypoint too close to obstacle, steering instability
**Fix**:
1. Increase `stoppingDistance` in NPC config
2. Ensure navmesh has sufficient polygon density (`detailSampleDist`)
3. Re-bake with tighter cell size

### "Bake time exceeds 30 seconds"

**Cause**: Geometry too dense or world bounds too large
**Fix**:
1. Reduce detail LOD for placed models (fewer tris)
2. Tighten world bounds to walkable area only
3. Increase `cellSize` or `regionMinSize` in bake config
4. Parallelize: bake multiple regions separately, merge JSONs

## Config Tuning

Bake config parameters (in `scripts/bake-navmesh.mjs` or app):

- `cellSize` (default 0.3): Vertical cell size. Smaller = more detail, slower bake.
- `cellHeight` (default 0.2): Horizontal cell height. Smaller = more accuracy.
- `agentHeight` (default 1.7): NPC height. Affects floor-to-ceiling clearance.
- `agentRadius` (default 0.4): NPC width. Affects corridor widths.
- `agentMaxClimb` (default 0.5): Max step height NPC can climb.
- `agentMaxSlope` (default 45): Max slope angle (degrees) NPC can walk.
- `tileSize` (default 32): Recast tile grid size. Larger = faster, less detail.
- `regionMinSize` (default 8): Min region size before merge.
- `detailSampleDist` (default 6): Detail mesh sampling distance.

**Recommended starting point:**
```javascript
{
  cellSize: 0.3,
  cellHeight: 0.2,
  agentHeight: 1.7,
  agentRadius: 0.4,
  agentMaxClimb: 0.5,
  agentMaxSlope: 45,
  tileSize: 32,
  regionMinSize: 8,
  detailSampleDist: 6,
}
```

## Future Enhancements

- [ ] Spatial acceleration (quadtree/octree for polygon lookup)
- [ ] Funnel algorithm for smooth path pulling
- [ ] Dynamic obstacle avoidance with crowd simulation
- [ ] Multi-tile navmesh for very large worlds
- [ ] Live navmesh updates when geometry changes (placed models moved)
- [ ] Navmesh visualization tool in editor
