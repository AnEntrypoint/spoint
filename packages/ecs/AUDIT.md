# ECS Audit: thebird lib/ecs.js vs @spoint/ecs

Source: `C:/dev/thebird/docs/lib/ecs.js` (149 lines) vs `packages/ecs/src/world.js` (215 lines).

## API Surface Comparison

| Feature | thebird | @spoint/ecs | Status |
|---|---|---|---|
| Entity IDs | String (monotonic counter) | Number (monotonic counter) | **DIVERGENT** |
| Entity creation | `createEntity(id?)` optional id | `createEntity()` auto-id only | DIVERGENT |
| Entity destruction | `destroyEntity(id)` returns bool | `destroyEntity(id)` void, idempotent | DIVERGENT |
| Entity existence check | `entities.has(id)` | `exists(id)` | PARITY |
| All entity ids | `Array.from(entities.keys())` | `entities()` | PARITY |
| Component add | `addComponent(id, type, data)` | `addComponent(id, name, data)` | PARITY |
| Component remove | `removeComponent(id, type)` returns bool | `removeComponent(id, name)` void | DIVERGENT |
| Component get | `getComponent(id, type)` | `getComponent(id, name)` | PARITY |
| Component has | `hasComponent(id, type)` | `hasComponent(id, name)` | PARITY |
| Tag components | N/A (use `addComponent(id, type, true)`) | `addTag/removeTag/hasTag/entitiesWithTag` | **@spoint/ecs extra** |
| Query | `query(...types)` variadic, full scan | `createQuery(world, {has,hasAny,not})` | **DIVERGENT** |
| System register | `addSystem(fn, order)` returns fn | `registerSystem(name, update, priority)` returns unregister fn | DIVERGENT |
| System remove | `removeSystem(fn)` returns bool | via returned unregister fn | DIVERGENT |
| System step | `step(dt)` snapshot-ordered | `update(dt)` snapshot-ordered | PARITY |
| Serialize | `serialize()` with schemaVersion | `snapshot()` no schemaVersion | DIVERGENT |
| Deserialize | `deserialize(data)` in-place | `restore(snap)` clears first | DIVERGENT |
| Component names | N/A | `componentNames()` | @spoint/ecs extra |
| Entities with component | via `query(type)` | `entitiesWith(name)` | PARITY |
| Destroyed guard | N/A | `destroyed` getter + `destroy()` | @spoint/ecs extra |
| Entity count | `entityCount` getter | `entityCount` getter | PARITY |

## Storage Strategy

- **thebird**: Entity-major — `Map<entityId, Map<componentType, data>>`. Optimized for small-N (tens to low-hundreds of entities). O(1) per-component lookup, query is a full scan.
- **@spoint/ecs**: Component-major — `Map<componentName, Map<entityId, data>>`. Better for queries that filter by component type (no need to scan all entities). Same O(1) per-component lookup.

**Assessment**: Both are valid for small-N. The component-major layout in @spoint/ecs supports the archetype-based query system (createQuery) more naturally. The entity-major layout in thebird is simpler for serialization (one entity = one row). For a unified package, the component-major layout is the right choice — it enables the richer query API and can still serialize to the same shape.

## Extraction Surface — What to Port

### Already in @spoint/ecs (no port needed)
- Entity lifecycle (create/destroy/exists/list)
- Component CRUD (add/remove/has/get)
- System scheduling (register/update with priority)
- Archetype queries (createQuery with has/hasAny/not)
- Serialization (snapshot/restore)
- Tag components (addTag/removeTag/hasTag/entitiesWithTag)

### Features unique to thebird that need porting
1. **Optional entity ID in createEntity**: Thebird allows `createEntity(id)` to pre-assign an ID. @spoint/ecs auto-generates. This is a minor API difference — thebird's usage can be adapted to use auto-generated IDs.
2. **Prefab instantiation**: Thebird's ecs.js doesn't have a dedicated prefab system, but the PRD row mentions this as a planned feature. Needs to be designed from scratch.
3. **Reactive queries**: Thebird's ecs.js doesn't have these either — the PRD row mentions them as planned. Needs to be designed from scratch.

### Features unique to @spoint/ecs (forward-compatible)
- `destroyed` guard: prevents operations on destroyed worlds
- `componentNames()`: introspection
- `entitiesWith(name)`: single-component query without createQuery
- Tag component API: convenience wrappers for boolean flags

## Migration Path for thebird

1. **Short term**: Thebird can adopt @spoint/ecs as-is. The API is a superset of thebird's core API (createEntity, destroyEntity, addComponent, removeComponent, getComponent, hasComponent, addSystem-equivalent, step-equivalent). The main differences are:
   - Entity IDs are numbers, not strings — trivial adapter
   - `query(...types)` → `createQuery(world, {has: types})` — one-line change
   - `addSystem(fn, order)` → `registerSystem(name, fn, order)` — add a name parameter
   - `serialize()`/`deserialize()` → `snapshot()`/`restore()` — same shape, no schemaVersion

2. **Medium term**: Port thebird's optional-ID createEntity to @spoint/ecs if needed.

3. **Long term**: Design and implement prefab instantiation and reactive queries as new features in @spoint/ecs.