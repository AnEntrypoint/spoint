# Prefab System User Guide

## Overview

A **prefab** (short for "prefabricated") is a reusable template of one or more entities that you can save and spawn repeatedly in your world. Instead of manually recreating the same group of objects each time you need them, you save them once as a prefab and then instantiate that prefab as many times as you want.

### What is a Prefab?

A prefab is a saved collection of entities with their properties:
- Hierarchy (parent-child relationships preserved)
- Position, rotation, and scale
- Physics properties (body type, collider settings)
- Custom properties (color, health, speed, etc.)
- References to apps or models

### When to Use Prefabs

Use prefabs when you want to:
- **Reuse complex multi-entity designs** — A campfire with flames, smoke, and glow effects
- **Create variants quickly** — A "house-red" variant based on a "house" base
- **Spawn decorations at scale** — Hundreds of trees, rocks, or flowers with one click
- **Design level layouts** — Enemy groups, level hazards, or interactive stations
- **Enable rapid iteration** — Change a prefab once, and all instances update (optional)

### Performance Benefits

- **Fast spawning** — Spawning a 10-entity prefab takes <1 second
- **Batch instantiation** — Spawn 20 prefabs in sequence with minimal overhead
- **Predictable memory** — All instances share the same prefab definition
- **Efficient hierarchy** — Parent-child relationships rebuild automatically
- **Easy cleanup** — Delete the prefab root, and all children are removed with it

---

## Saving a Prefab

### Step-by-Step

1. **Select entities in the Hierarchy panel**
   - Click the first entity you want to include
   - Hold **Shift** or **Ctrl** to multi-select related entities
   - Make sure to select the root entity and all its children

2. **Open the Prefabs panel**
   - In the editor, find the **Prefabs** section in the right-side panel
   - Click **"Save as Prefab"** button

3. **Enter a name**
   - A dialog appears asking for a prefab name
   - Use lowercase, numbers, and hyphens: `house-red`, `campfire-base`, `enemy-patrol-group`
   - Names are normalized (spaces become hyphens, special characters removed)

4. **File location**
   - Your prefab is saved to `data/prefabs/<name>.prefab.json`
   - Prefabs are stored server-side and versioned with your world

5. **(Optional) Add metadata**
   - Description: Document what this prefab is for
   - Author: Your name (for team projects)
   - Tags: Useful for organizing many prefabs

### Hierarchy Preservation

When you save a prefab, all parent-child relationships are preserved. If you save an entity with 3 children:

```
campfire (root)
├── flames (child)
├── smoke (child)
└── glow (child)
```

When you spawn the prefab, the same hierarchy is recreated automatically. All relative positions/rotations are maintained.

### Version Tracking

The prefab system tracks when a prefab was created and last updated:
- **created** — Timestamp when the prefab was first saved
- **updated** — Timestamp of the most recent modification
- **version** — Format version (currently v1, for future multi-version support)

This information is stored in the prefab's metadata for reference and debugging.

---

## Instantiating Prefabs

### Basic Spawning

1. **Open the Prefabs panel**
   - In the editor, locate the **Prefabs** list on the right

2. **Click "Instantiate"**
   - Find your prefab in the list
   - Click the **Instantiate** button next to it
   - The prefab is spawned at the world origin (0, 0, 0)

3. **Choose a position** (optional)
   - **In the viewport**: Click where you want the prefab to appear
   - **Or enter coordinates**: Type position values into the dialog box
   - The prefab's root entity moves to that position; all children move with it

4. **Confirm spawn**
   - The prefab entities appear in your scene
   - The Hierarchy panel updates to show the new entities
   - New unique IDs are assigned to each spawned entity

### Multiple Instances

You can spawn the same prefab multiple times:

```javascript
for (let x = 0; x < 5; x++) {
  for (let z = 0; z < 5; z++) {
    spawn("campfire-base", [x * 10, 0, z * 10])
  }
}
```

Each instance is independent — changes to one don't affect the others.

---

## Property Overrides

### Per-Instance Customization

When spawning a prefab, you can override properties on a per-entity basis. Instead of creating a new prefab for every color variation, save one base prefab and override color on spawn:

**Example: Spawn a house with custom color**

```javascript
const overrides = {
  "house-0": { custom: { color: 0xFF0000 } },
}
spawn("house-base", [10, 0, 10], [0, 0, 0, 1], overrides)
```

### Supported Overrides

You can override any of these properties per entity:

```javascript
{
  "entity-id": {
    position: [x, y, z],
    rotation: [qx, qy, qz, qw],
    scale: [sx, sy, sz],
    bodyType: "static" | "dynamic" | "kinematic",
    custom: {
      color: 0xRRGGBB,
      health: 100,
      speed: 5.0,
    }
  }
}
```

### Syntax Examples

**Override a single entity:**
```javascript
const overrides = {
  "campfire-flames": { custom: { intensity: 0.5 } }
}
```

**Override multiple entities:**
```javascript
const overrides = {
  "house-door": { custom: { locked: true } },
  "house-roof": { custom: { color: 0x8B4513 } },
  "house-window": { custom: { tint: 0xFFFFFF } }
}
```

**Override position/rotation:**
```javascript
const overrides = {
  "tree-limb-01": { rotation: [0, 0.707, 0, 0.707] },
  "tree-limb-02": { scale: [1.2, 1.2, 1.2] }
}
```

### Cascading Updates

In a future version, you'll be able to mark certain properties as "cascading" — when you change a property in the base prefab, all instances automatically update (unless they have a local override).

---

## Prefab Variants

### Creating a Variant

A **variant** is a copy of a base prefab with permanent overrides. Use variants when you have recurring property changes:

- `house-red` (base: `house`)
- `house-blue` (base: `house`)
- `enemy-strong` (base: `enemy-default`)

**In the editor:**

1. Right-click a prefab in the Prefabs panel
2. Select **"Create Variant"**
3. Enter the variant name: `house-red`
4. Optionally override properties (color, speed, etc.)
5. The new variant is saved as a separate prefab

**Via API:**
```javascript
prefabLibrary.createVariant("house", "house-red", {
  "house-0": { custom: { color: 0xFF0000 } }
})
```

### Base Changes Propagate

If you update the base prefab, the variant automatically inherits that structure. The variant only preserves its own overrides.

**Example workflow:**

1. Save base prefab: `house` (4 entities)
2. Create variant: `house-red` (color override)
3. Edit base prefab: add a 5th entity (porch light)
4. Spawn variant: `house-red` now has 5 entities, with color override still applied

---

## Best Practices

### Naming Conventions

Use **kebab-case** for all prefab names (lowercase, hyphens, no spaces):

✅ Good:
- `campfire-base`
- `house-variant-01`
- `tower-defense-spawn-group`

❌ Avoid:
- `CampFire` (use lowercase)
- `campfire base` (no spaces)
- `campfire_v1` (use hyphens)

### Hierarchy Depth

Keep hierarchy depth **< 5 levels deep** for optimal performance:

✅ Good:
```
campfire (root)
├── flames
├── smoke
└── glow
```

### Test After Saving

Always verify a prefab works correctly:

1. Save the prefab
2. Delete the original entities from the scene
3. Spawn one instance of the prefab in a clean area
4. Check:
   - Hierarchy is correct
   - All children are present
   - Position/rotation are preserved
   - Physics properties work as expected

### Common Use Cases

**UI pieces** — Buttons, panels, menus
- Quick to spawn dozens with minor variations

**Props and decorations** — Trees, rocks, furniture
- Batch-spawn hundreds for environment filling

**Enemy groups** — Patrol units, boss + minions
- Save multi-entity combat groups

**Level decorations** — Torches, banners, statues
- Repeated visual elements with per-instance customization

---

## Performance Guidelines

### Benchmark Timings

Measured on a modern machine:

- **Saving a 10-entity prefab**: < 10 seconds
- **Spawning a single 5-entity prefab**: < 1 second
- **Batch spawning 20 prefabs (100 entities total)**: < 2 seconds
- **Loading prefab list (50 prefabs)**: < 500 ms

### Optimization Tips

**Use LOD and culling for large prefabs:**
- If a prefab has 100+ entities, only render visible ones
- Use frustum culling + distance LOD

**Batch spawn operations:**
- Spawn multiple prefabs in sequence, not nested/recursive

**Avoid deep hierarchies:**
- Flatten unnecessary parent-child relationships

---

## Troubleshooting

### "App not found" error

**Problem:** Prefab save fails with "app X not found"

**Solution:**
1. Check that any apps referenced in the prefab are registered in `placeableApps`
2. Verify app names match exactly (case-sensitive)
3. If the app was just added, restart the server

### "Prefab failed to save" — invalid name

**Problem:** Save dialog rejects your prefab name

**Solution:**
- Names must contain only: `a-z`, `0-9`, hyphens `-`
- No spaces, underscores, or special characters
- Try: `my-prefab-1` instead of `my_prefab@1`

### "Entity disappeared after spawn"

**Problem:** You spawn a prefab, but entities vanish or fall through the world

**Solution:**
1. **Check physics collisions:**
   - Verify the prefab's bodyType is set correctly
   - Check that collider shapes aren't inverted

2. **Check position validity:**
   - Spawn position might be underground or in solid terrain
   - Use a ground-raycast to find a safe spawn point

3. **Check parent entity:**
   - If a prefab is spawned as a child of another entity, verify the parent exists

### "Hierarchy broken" — parent not found

**Problem:** After spawn, some entities appear unparented

**Solution:**
1. The prefab's parent entity may have been deleted externally
2. Re-save the prefab to refresh parent references
3. If parent is missing in the save, manually re-parent and re-save

---

## API Reference

### PrefabLibrary (Server-side)

#### `load(prefabName)`
Loads a prefab from disk.

```javascript
const prefab = await prefabLibrary.load("campfire-base")
```

#### `save(prefabName, entityTree, metadata)`
Saves a new prefab to disk.

```javascript
await prefabLibrary.save("campfire-base", [flamesEntity, smokeEntity], {
  description: "Base campfire with flames and smoke"
})
```

#### `list()`
Lists all available prefabs.

```javascript
const prefabs = await prefabLibrary.list()
```

#### `delete(prefabName)`
Deletes a prefab.

```javascript
await prefabLibrary.delete("old-prefab")
```

#### `createVariant(baseName, variantName, overrides)`
Creates a variant of a base prefab.

```javascript
const variant = await prefabLibrary.createVariant("house", "house-red", {
  "house-0": { custom: { color: 0xFF0000 } }
})
```

### PrefabSpawner (Server-side)

#### `spawnPrefab(prefab, position, rotation, overrides)`
Spawns a prefab at a given position/rotation.

```javascript
const result = prefabSpawner.spawnPrefab(
  prefab,
  [10, 0, 20],
  [0, 0, 0, 1],
  { "campfire-flames": { custom: { intensity: 0.8 } } }
)
```

---

## Examples

### Example 1: Save a 3-Entity Campfire

**Setup:**
- Parent entity: `campfire` (empty group)
- Child 1: `flames` (VRM model)
- Child 2: `smoke` (particle effect)

**Steps:**
1. In the editor Hierarchy, select `campfire`, `flames`, and `smoke`
2. Click **"Save as Prefab"**
3. Name it: `campfire-base`
4. Click **Save**

### Example 2: Spawn 5 Campfires in a Grid

```javascript
const prefab = await prefabLibrary.load("campfire-base")

for (let x = 0; x < 5; x++) {
  for (let z = 0; z < 5; z++) {
    const position = [x * 10, 0, z * 10]
    prefabSpawner.spawnPrefab(prefab, position, [0, 0, 0, 1])
  }
}
```

### Example 3: Create Ice and Lava Tower Variants

```javascript
await prefabLibrary.createVariant("tower-default", "tower-ice", {
  "tower-0": { custom: { color: 0x87CEEB, temperature: "cold" } }
})

await prefabLibrary.createVariant("tower-default", "tower-lava", {
  "tower-0": { custom: { color: 0xFF4500, temperature: "hot" } }
})
```

---

## Summary

Prefabs are a powerful tool for rapid level design and efficient entity management. Start by saving a complex entity group, then spawn it as many times as you need. Use variants for common customizations, and overrides for truly unique instances. Always test prefabs after saving, and keep hierarchies shallow for best performance.

Happy prefabbing!
