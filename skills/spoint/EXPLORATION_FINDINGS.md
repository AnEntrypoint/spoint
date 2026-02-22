# SCHWUST MODEL PLACEMENT SYSTEM - PHASE 0 EXPLORATION FINDINGS

## Wave 1: Exploration & Analysis Complete

### 1. GLB Structure Analysis
**File**: `/config/spawnpoint/apps/tps-game/schwust.glb`
- **Size**: 4.16 MB
- **Generator**: Khronos glTF Blender I/O v4.5.48
- **Version**: glTF 2.0

**Scene Graph**:
- Scene: "Scene" (root)
  - Node[3] "Dust2" (root container, no mesh)
    - Node[0] "Collider" (mesh[0], TRIANGLES, no material)
    - Node[2] "LOD" (container)
      - Node[1] "Dust2MeshLOD0" (mesh[1], TRIANGLES, material[0])

**Meshes**: 2 total
- mesh[0]: "Dust2.002" (1 primitive) - **COLLIDER GEOMETRY**
- mesh[1]: "Dust2.001" (1 primitive) - **VISUAL GEOMETRY** with material

**Materials**: 1 total
- material[0]: "material_atlas_00001_1"

**Key Finding**: 
- Node "Collider" is explicitly named for physics
- LOD structure in place but single mesh renders visually
- Separate visual/collider meshes already separated

### 2. Smart Object Patterns (Confirmed)
From `power-crate/index.js` and `physics-crate/index.js`:
- **Pattern**: ctx.world.spawn(id, config) creates entities
- **Metadata**: custom field holds render data
  - Example: `{ mesh: 'box', color: 0xff8800, sx: 1, sy: 1, sz: 1 }`
  - Example: `{ mesh: 'cylinder', r: 0.4, h: 0.1, color: 0xffd700, spin: 3 }`
- **Spawning**: Entities created at runtime, destroyed on pickup
- **Lifecycle**: Full spawn/update/destroy cycle supported

**Confirmed Capabilities**:
- ✓ Parent-child relationships (entity.parent already tracked)
- ✓ Spawn with config including position/rotation
- ✓ Custom metadata for rendering
- ✓ Full entity lifecycle

### 3. Client Hierarchy Rendering Test (PASSED)
**Validation**: Mock Three.js hierarchy test

Results:
- ✓ Simple parent-child transforms work (15 = 10 + 5)
- ✓ Deep nesting (32 levels) supported without error
- ✓ Quaternion inheritance propagates correctly
- ✓ Position accumulation works through hierarchy
- ✓ Orphan handling: parent = null treats as root
- ✓ Circular parent detection possible

**Conclusion**: Three.js Groups can safely rebuild from server entity tree.

### 4. AppRuntime Entity System (Already Exists)
From `src/apps/AppRuntime.js`:
- ✓ Hierarchy tracking: entity.parent (string ID), entity.children (Set)
- ✓ getWorldTransform(entityId) recursively computes: position, rotation, scale
- ✓ Snapshot encoding includes parent field
- ✓ reparent() safely updates parent-child references
- ✓ destroyEntity() cascades to children

**Key Code**:
```javascript
getWorldTransform(entityId) {
  const e = this.entities.get(entityId)
  const local = { position: [...e.position], rotation: [...e.rotation], scale: [...e.scale] }
  if (!e.parent) return local
  const pt = this.getWorldTransform(e.parent)
  // Multiply transforms: scale -> rotate -> translate with parent
  return { position: [...], rotation: [...], scale: [...] }
}
```

### 5. Client Entity Rendering (Current State)
From `client/app.js`:
- **Current**: loadEntityModel() loads single GLTFLoader, adds to scene
- **Hierarchy**: No Three.js Group hierarchy; all models added directly to scene
- **Data**: entityMeshes Map stores model → THREE.Mesh
- **Required Change**: Refactor to create Groups matching server parent-child

### 6. Editor Placeholder System (Design)
Based on power-crate pattern:
- Use custom metadata: `{ editorPlaceholder: true, type: 'smart-object', template: 'door' }`
- Create THREE.BoxGeometry instead of loading GLB
- Color code by type: door→blue, platform→green, trigger→yellow, hazard→red

## Unknowns Resolved

### Q: GLB structure - can we use hierarchy?
**A**: YES. Nodes already separated:
- "Collider" = physics mesh
- "Dust2MeshLOD0" = visual mesh
Can extract metadata from node names.

### Q: Smart objects - local transform spaces?
**A**: YES. Already supported via:
- Parent-child relationships (entity.parent)
- Local position/rotation/scale
- getWorldTransform() for world space

### Q: Client hierarchy rendering?
**A**: YES. Mock test passed. Requires refactoring loadEntityModel() to:
1. Create Three.js Group per entity
2. Match server parent-child tree
3. Apply local transforms per entity

### Q: Editor placeholder system?
**A**: YES. Via custom metadata flag + type-based coloring.

## Architecture Validated

✓ **Server-side**: Entity hierarchy exists, just needs to be used
✓ **Network**: Snapshot encoding supports parent field
✓ **Client-side**: Three.js Groups can match server hierarchy
✓ **Physics**: Per-entity colliders already supported
✓ **Smart objects**: Spawn pattern confirmed, ready for templates

## Next Steps: Wave 2

1. Finalize GLB metadata schema (collider mapping)
2. Design smart object templates (door, platform, trigger, hazard)
3. Design editor placeholder colors/types
4. Begin environment app refactor

No blocking issues found. Proceed to implementation.
