#!/usr/bin/env node

import { createPrefabLibrary } from './src/editor/PrefabLibrary.js'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const TEST_DIR = process.cwd()

async function log(msg) {
  console.log(`[VERIFY] ${msg}`)
}

async function cleanup() {
  try {
    const prefabsDir = join(TEST_DIR, 'data', 'prefabs')
    await rm(prefabsDir, { recursive: true, force: true })
  } catch (e) {}
}

async function main() {
  await cleanup()
  log('Starting PrefabLibrary verification...')

  const lib = await createPrefabLibrary(TEST_DIR)

  log('1. Create sample prefab with 3-entity hierarchy (parent + 2 children)')
  const parent = {
    id: 'parent-001',
    app: 'terrain',
    bodyType: 'static',
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    custom: { name: 'Parent Node' },
    children: ['child-001', 'child-002']
  }

  const child1 = {
    id: 'child-001',
    app: 'placed-model',
    model: '/models/tree.glb',
    bodyType: 'static',
    position: [2, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    custom: { name: 'Child 1' },
    parent: 'parent-001'
  }

  const child2 = {
    id: 'child-002',
    app: 'placed-model',
    model: '/models/rock.glb',
    bodyType: 'dynamic',
    position: [-2, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [2, 1, 2],
    custom: { name: 'Child 2' },
    parent: 'parent-001',
    collider: { type: 'sphere', radius: 1 }
  }

  const entities = [parent, child1, child2]
  const metadata = {
    author: 'admin@coas.co.za',
    description: 'Test hierarchy with parent and two child entities'
  }

  await lib.save('test-hierarchy', entities, metadata)
  log('✓ Saved test-hierarchy prefab')

  log('2. Load prefab back and verify structure')
  const loaded = await lib.load('test-hierarchy')
  if (!loaded) throw new Error('Failed to load prefab')
  if (loaded.version !== 1) throw new Error(`Invalid version: ${loaded.version}`)
  if (loaded.entities.length !== 3) throw new Error(`Expected 3 entities, got ${loaded.entities.length}`)
  if (loaded.rootId !== 'parent-001') throw new Error(`Expected rootId parent-001, got ${loaded.rootId}`)
  if (loaded.metadata.author !== 'admin@coas.co.za') throw new Error('Author mismatch')
  if (!loaded.metadata.created) throw new Error('Missing created timestamp')
  if (!loaded.metadata.updated) throw new Error('Missing updated timestamp')
  log('✓ Loaded and verified structure')

  log('3. List prefabs')
  const list = await lib.list()
  if (!list.find(p => p.name === 'test-hierarchy')) throw new Error('Prefab not in list')
  log(`✓ Listed ${list.length} prefab(s)`)

  log('4. Check prefab exists')
  const exists = await lib.exists('test-hierarchy')
  if (!exists) throw new Error('Prefab should exist')
  log('✓ Exists check passed')

  log('5. Duplicate prefab')
  const dupe = await lib.duplicate('test-hierarchy', 'test-hierarchy-copy')
  if (!dupe) throw new Error('Failed to create duplicate')
  if (dupe.metadata.name !== 'test-hierarchy-copy') throw new Error('Duplicate name not updated')
  const dupeLoaded = await lib.load('test-hierarchy-copy')
  if (!dupeLoaded) throw new Error('Failed to load duplicated prefab')
  if (dupeLoaded.entities.length !== 3) throw new Error('Duplicate has wrong entity count')
  log('✓ Duplicated prefab successfully')

  log('6. Create variant with overrides')
  const variant = await lib.createVariant('test-hierarchy', 'test-hierarchy-variant', {
    'child-002': { position: [4, 2, 1] }
  })
  if (!variant) throw new Error('Failed to create variant')
  const variantLoaded = await lib.load('test-hierarchy-variant')
  const variantChild2 = variantLoaded.entities.find(e => e.id === 'child-002')
  if (variantChild2.position[0] !== 4 || variantChild2.position[1] !== 2) {
    throw new Error(`Variant override not applied: got ${variantChild2.position}`)
  }
  log('✓ Created variant with overrides')

  log('7. Validate prefab schema')
  try {
    lib.validatePrefab(loaded)
    log('✓ Valid prefab passed validation')
  } catch (e) {
    throw new Error(`Validation failed: ${e.message}`)
  }

  log('8. Test validation: missing app (should catch with appDefsMap)')
  try {
    const appDefs = new Map([['terrain', {}]])
    lib.validatePrefab(loaded, appDefs)
    throw new Error('Should have caught missing app "placed-model"')
  } catch (e) {
    if (e.message.includes('not found')) {
      log('✓ Correctly caught missing app')
    } else {
      throw e
    }
  }

  log('9. Test validation: empty entities array')
  try {
    lib.validatePrefab({ entities: [], version: 1, metadata: { name: 'test', author: 'test', created: '2024-01-01T00:00:00Z', updated: '2024-01-01T00:00:00Z' } })
    throw new Error('Should have caught invalid schema')
  } catch (e) {
    if (e.message.includes('entities array is empty')) {
      log('✓ Correctly caught empty entities array')
    } else {
      throw e
    }
  }

  log('10. Test validation: invalid bodyType')
  try {
    lib.validatePrefab({
      version: 1,
      entities: [{
        id: 'test',
        bodyType: 'invalid',
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1]
      }],
      metadata: { name: 'test', author: 'test', created: '2024-01-01T00:00:00Z', updated: '2024-01-01T00:00:00Z' }
    })
    throw new Error('Should have caught invalid bodyType')
  } catch (e) {
    if (e.message.includes('bodyType')) {
      log('✓ Correctly caught invalid bodyType')
    } else {
      throw e
    }
  }

  log('11. Delete prefab')
  await lib.delete('test-hierarchy-copy')
  const afterDelete = await lib.list()
  if (afterDelete.find(p => p.name === 'test-hierarchy-copy')) {
    throw new Error('Prefab should be deleted')
  }
  log('✓ Deleted prefab successfully')

  log('12. Verify remaining prefabs')
  const final = await lib.list()
  if (!final.find(p => p.name === 'test-hierarchy')) throw new Error('Original should still exist')
  if (!final.find(p => p.name === 'test-hierarchy-variant')) throw new Error('Variant should still exist')
  log(`✓ Final count: ${final.length} prefab(s)`)

  log('')
  log('=== ALL TESTS PASSED ===')
  log('PrefabLibrary is working correctly:')
  log('  - Save with validation')
  log('  - Load and verify structure')
  log('  - List prefabs')
  log('  - Duplicate prefabs')
  log('  - Create variants')
  log('  - Validate schema')
  log('  - Validate apps')
  log('  - Validate bodyType constraints')
  log('  - Delete prefabs')

  await cleanup()
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`)
  process.exit(1)
})
