# Navmesh Baking & Pathfinding

Apps plan walkable routes through a world's static geometry with a navmesh baked offline by
[recast-navigation](https://github.com/isaac-mason/recast-navigation-js) and queried at runtime
through the engine's `ctx.navmesh()` capability. The same app code runs on the Node server and in
the singleplayer Worker.

## Pipeline

1. **Bake** (offline, `scripts/bake-navmesh.mjs`): reads `apps/world/<world>.js`, collects every
   entity whose `model` is a `.glb` and whose `config.collider` is `'trimesh'`, applies the entity's
   position/rotation/scale on top of the GLB node transforms, runs Recast's solo navmesh generator,
   and writes `apps/world/<world>.navmesh.json`.
2. **Load** (runtime, engine): `ctx.navmesh(worldName?)` reads that JSON (filesystem on the server,
   `fetch` in the Worker) and resolves to a `NavmeshQuery`. One query object is shared by every app
   instance in the same runtime and world.
3. **Query + move** (app): `query.findPath(from, to)` returns string-pulled waypoints; the app follows
   them with `ctx.defineSteering()`.

## Baking

```bash
npm run bake-navmesh -- --world=<world>
```

`--world` is the file stem under `apps/world/` (required). `--verbose` prints the stack on failure.
The bake fails loudly when the world has no trimesh GLB entities or Recast produces no walkable
polygons.

Measured on `apps/maps/aim_sillos.glb` (9334 triangles): 600 vertices, 278 polygons in 32 connected
regions (largest 101), 58 KB, ~250 ms.

Agent defaults (`DEFAULT_AGENT` in `src/pathfinding/RecastIntegration.js`), in world units:

| key | default | meaning |
|---|---|---|
| `cellSize` / `cellHeight` | 0.3 / 0.2 | voxel size on xz / y |
| `agentHeight` | 1.7 | floor-to-ceiling clearance |
| `agentRadius` | 0.4 | walkable area is eroded by this much from walls |
| `agentMaxClimb` | 0.5 | step height |
| `agentMaxSlope` | 45 | degrees |
| `regionMinSize` / `regionMergeSize` | 8 / 20 | voxel counts for island removal / merging |
| `maxVertsPerPoly` | 6 | |

## File format (`version: 1`)

```json
{
  "version": 1,
  "config": { "cellSize": 0.3, "cellHeight": 0.2, "agentHeight": 1.8, "agentRadius": 0.6, "agentMaxClimb": 0.4, "agentMaxSlope": 45 },
  "bounds": { "min": [x, y, z], "max": [x, y, z] },
  "vertices": [[x, y, z], ...],
  "polygons": [{ "vertices": [i0, i1, i2, ...], "flags": 0, "area": 0 }, ...],
  "links": [{ "polygon": 0, "neighbors": [1, 5] }, ...]
}
```

`config` records the voxel-rounded agent values actually used (float32, so `0.30000001`). Polygon vertex lists wind
counter-clockwise in the x/z plane (positive `sum(x_i*z_{i+1} - x_{i+1}*z_i)`); Recast emits the
opposite order, so the bake reverses it. `links` hold only real neighbours (tile-portal and null
edges are dropped) and are symmetric.

## Runtime API

```javascript
setup(ctx) {
  ctx.navmesh().then(
    nav => { ctx.state.ready = true },
    e => ctx.debug.warn(e.message)
  )
},

onMessage(ctx, msg) {
  if (msg.type !== 'goTo') return
  ctx.navmesh().then(nav => {
    const waypoints = nav.findPath([...ctx.entity.position], msg.position)
    if (waypoints) ctx.state.waypoints = waypoints
  })
}
```

- `ctx.navmesh(worldName = runtime.worldName)` returns a `Promise<NavmeshQuery>`. The world name is
  set by the engine (`WorkerEntry` from the singleplayer INIT's `worldName`; `ServerAPI.loadWorld`
  from `worldDef.name || WORLD || 'tps-game'`). It rejects with a `TypeError` for anything that is not
  a world file stem (no path separators), and with an `Error` naming the missing path/URL when the
  world has no baked navmesh. A failed load is not cached, so baking and calling again works.
- `findPath(from, to)` returns `Array<[x, y, z]>` starting at `from` and ending at `to`, or `null`
  when either point is off the navmesh or the two points are in disconnected regions. Points are
  located by x/z containment, choosing the containing polygon whose centroid height is closest to the
  point's y (multi-level maps). The corridor is A* over polygon centroids; waypoints come from a
  funnel pass over the shared edges, so every segment stays inside the walkable area. Results are
  cached per (from, to) at 1 cm resolution, 100 entries; callers receive copies.
- `locate(point)` returns the polygon index or `-1`.

Apps must not import engine modules or `node:*` themselves: `AppLoader` rejects app source
containing `import(`, and the Worker has no filesystem. `ctx.navmesh()` is the supported route.

Measured on the aim_sillos navmesh: the 58.5 m cross-map query returns 9 waypoints in about 1 ms;
200 random pairs in the largest region all resolve (max 0.7 ms), and 0 of 21 277 samples taken
every 0.25 m along the returned segments fall outside the navmesh.

## `npc-navigator` app

Messages are broadcast APP_EVENTs; `npcId` addresses one NPC, omitted means every navigator.

```javascript
client.send(MSG.APP_EVENT, { type: 'setTarget', npcId: 'npc-1', position: [19.6, -7.2, 0.5] })
client.send(MSG.APP_EVENT, { type: 'startPatrol', npcId: 'npc-1', route: [[0, 0, 0], [10, 0, 0]] })
client.send(MSG.APP_EVENT, { type: 'stop', npcId: 'npc-1' })
```

Server apps reach it with `ctx.world.sendToEntity(npcId, { type: 'setTarget', position })`. Each
found path is logged as `npc-navigator: path <from> -> <to>: N waypoints ...`; a missing navmesh or
unreachable target is logged as a warning and the NPC stays put. Editor props: `speed`,
`stoppingDistance` (steering arrive radius), `avoidanceRadius` (raycast side-step distance).

## Troubleshooting

- **`navmesh not baked for world "<name>"`**: run `npm run bake-navmesh -- --world=<name>`.
- **`findPath` returns `null`**: a point is outside the eroded walkable area (walls are inset by
  `agentRadius`) or in a different region; check `nav.locate(point)`.
- **World has no trimesh GLB entities**: the bake only reads `.glb` entities with
  `config.collider: 'trimesh'`; terrain heightfields and primitive meshes are not baked.
