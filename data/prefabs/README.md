# Prefab Library

Prefabs are reusable entity group templates stored as JSON documents in `data/prefabs/`.

## Format

Each prefab is a versioned document containing:
- **version**: Format version (currently 1)
- **entities**: Array of entity definitions with full hierarchy
- **rootId**: ID of the root/parent entity
- **metadata**: Creation info, author, description, timestamps

## Usage

```javascript
import { createPrefabLibrary } from 'src/editor/PrefabLibrary.js'

const lib = await createPrefabLibrary()

// Save a prefab
await lib.save('my-prefab', [entity1, entity2, entity3], {
  author: 'user@example.com',
  description: 'A useful prefab'
})

// Load a prefab
const prefab = await lib.load('my-prefab')

// List all prefabs
const all = await lib.list()

// Check existence
const exists = await lib.exists('my-prefab')

// Duplicate a prefab
await lib.duplicate('my-prefab', 'my-prefab-copy')

// Create a variant with overrides
await lib.createVariant('my-prefab', 'variant-v2', {
  'entity-id': { position: [1, 2, 3] }
})

// Delete a prefab
await lib.delete('my-prefab')

// Validate a prefab document
lib.validatePrefab(doc)
```

## Validation

- Schema validation: required fields, types, vector dimensions
- App existence checks (when appDefsMap provided)
- BodyType constraints: static|dynamic|kinematic
- Collider type validation
- RootId integrity

## Browser Context

In browser/Worker/singleplayer contexts (no fs), all methods either return null/empty or throw a
"not available in browser context" error. This matches the pattern from EditorHandlers.js.
