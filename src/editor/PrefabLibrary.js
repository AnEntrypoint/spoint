// Prefab library: storage and validation for reusable entity group presets.
// Node-only (real fs) with browser stubs for Worker/singleplayer context.
// Follows WorldPersistence.js serialization pattern + EditorHandlers.js error messaging.

const isNode = typeof process !== 'undefined' && process.versions?.node
let readFile, writeFile, unlink, readdir, mkdir, join, dirname, fsRename

if (isNode) {
  const fsModule = await import('node:fs/promises')
  const pathModule = await import('node:path')
  readFile = fsModule.readFile
  writeFile = fsModule.writeFile
  unlink = fsModule.unlink
  readdir = fsModule.readdir
  mkdir = fsModule.mkdir
  fsRename = fsModule.rename
  join = pathModule.join
  dirname = pathModule.dirname
}

const PREFAB_FORMAT_VERSION = 1
const PREFAB_DIR = 'data/prefabs'

class PrefabLibrary {
  constructor(baseDir = process.cwd?.() || '.') {
    this.baseDir = baseDir
    this._ready = false
  }

  async _ensureDir() {
    if (this._ready || !isNode) return
    try {
      await mkdir(join(this.baseDir, PREFAB_DIR), { recursive: true })
      this._ready = true
    } catch (e) {
      console.error('[prefab] mkdir error:', e.message)
      this._ready = true
    }
  }

  _prefabPath(name) {
    const safe = name.replace(/[^a-z0-9._-]/g, '_')
    return join(this.baseDir, PREFAB_DIR, `${safe}.prefab.json`)
  }

  async exists(prefabName) {
    if (!isNode) return false
    try {
      const path = this._prefabPath(prefabName)
      await readFile(path, 'utf-8')
      return true
    } catch { return false }
  }

  async list() {
    if (!isNode) return []
    try {
      await this._ensureDir()
      const dir = join(this.baseDir, PREFAB_DIR)
      const files = await readdir(dir)
      return files
        .filter(f => f.endsWith('.prefab.json'))
        .map(f => {
          const name = f.slice(0, -12)
          return { name }
        })
    } catch { return [] }
  }

  async load(prefabName) {
    if (!isNode) return null
    try {
      const path = this._prefabPath(prefabName)
      const data = await readFile(path, 'utf-8')
      const prefab = JSON.parse(data)
      this._validateSchema(prefab)
      return prefab
    } catch (e) {
      throw new Error(`[prefab] load error for "${prefabName}": ${e.message}`)
    }
  }

  async save(prefabName, entityTree, metadata = {}) {
    if (!isNode) return false
    await this._ensureDir()

    const name = (prefabName || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
    if (!name) throw new Error('[prefab] invalid prefab name (use a-z 0-9 -)')

    // Normalize entityTree: if single entity, wrap it; if array, use as-is
    const entities = Array.isArray(entityTree) ? entityTree : [entityTree]
    if (!entities.length) throw new Error('[prefab] empty entity tree')

    // Find root: first entity with no parent, or use first entity
    const rootId = entities.find(e => !e.parent)?.id || entities[0].id

    const now = new Date().toISOString()
    const prefab = {
      version: PREFAB_FORMAT_VERSION,
      entities: entities.map(e => this._normalizeEntity(e)),
      rootId,
      metadata: {
        name,
        author: metadata.author || 'unknown',
        created: metadata.created || now,
        updated: now,
        description: metadata.description || ''
      }
    }

    this._validateSchema(prefab)

    try {
      const path = this._prefabPath(name)
      const tmp = path + '.tmp'
      await writeFile(tmp, JSON.stringify(prefab, null, 2), 'utf-8')
      if (fsRename) await fsRename(tmp, path)
      return true
    } catch (e) {
      throw new Error(`[prefab] save error: ${e.message}`)
    }
  }

  async delete(prefabName) {
    if (!isNode) return false
    try {
      const path = this._prefabPath(prefabName)
      await unlink(path)
      return true
    } catch (e) {
      throw new Error(`[prefab] delete error for "${prefabName}": ${e.message}`)
    }
  }

  async duplicate(fromName, toName) {
    if (!isNode) return null
    const source = await this.load(fromName)
    if (!source) throw new Error(`[prefab] source prefab "${fromName}" not found`)

    const now = new Date().toISOString()
    const copy = {
      ...source,
      metadata: {
        ...source.metadata,
        name: toName,
        created: now,
        updated: now
      }
    }

    await this.save(toName, copy.entities, copy.metadata)
    return copy
  }

  async createVariant(baseName, variantName, overrides = {}) {
    if (!isNode) return null
    const base = await this.load(baseName)
    if (!base) throw new Error(`[prefab] base prefab "${baseName}" not found`)

    const now = new Date().toISOString()
    const variantEntities = base.entities.map(e => ({
      ...e,
      ...(overrides[e.id] || {})
    }))

    const variant = {
      version: PREFAB_FORMAT_VERSION,
      entities: variantEntities,
      rootId: base.rootId,
      metadata: {
        name: variantName,
        author: overrides.author || base.metadata.author,
        created: now,
        updated: now,
        description: `Variant of ${baseName}${overrides.description ? ': ' + overrides.description : ''}`
      }
    }

    this._validateSchema(variant)
    await this.save(variantName, variant.entities, variant.metadata)
    return variant
  }

  _normalizeEntity(e) {
    return {
      id: e.id || '',
      app: e.app || '',
      model: e.model || '',
      bodyType: e.bodyType || 'static',
      position: e.position || [0, 0, 0],
      rotation: e.rotation || [0, 0, 0, 1],
      scale: e.scale || [1, 1, 1],
      custom: e.custom ? { ...e.custom } : {},
      children: Array.isArray(e.children) ? [...e.children] : [],
      ...(e.parent ? { parent: e.parent } : {}),
      ...(e.collider ? { collider: e.collider } : {})
    }
  }

  _validateSchema(prefab) {
    if (!prefab || typeof prefab !== 'object') throw new Error('prefab must be an object')
    if (prefab.version !== PREFAB_FORMAT_VERSION) throw new Error(`unsupported version ${prefab.version}`)
    if (!Array.isArray(prefab.entities)) throw new Error('entities must be an array')
    if (!prefab.entities.length) throw new Error('entities array is empty')
    if (!prefab.metadata || typeof prefab.metadata !== 'object') throw new Error('metadata must be an object')

    const { metadata } = prefab
    if (typeof metadata.name !== 'string' || !metadata.name) throw new Error('metadata.name must be a non-empty string')
    if (typeof metadata.author !== 'string') throw new Error('metadata.author must be a string')
    if (typeof metadata.created !== 'string') throw new Error('metadata.created must be a string')
    if (typeof metadata.updated !== 'string') throw new Error('metadata.updated must be a string')

    for (let i = 0; i < prefab.entities.length; i++) {
      const e = prefab.entities[i]
      if (typeof e.id !== 'string' || !e.id) throw new Error(`entity[${i}].id must be a non-empty string`)
      if (!Array.isArray(e.position) || e.position.length !== 3) throw new Error(`entity[${i}].position must be [x,y,z]`)
      if (!Array.isArray(e.rotation) || e.rotation.length !== 4) throw new Error(`entity[${i}].rotation must be [x,y,z,w]`)
      if (!Array.isArray(e.scale) || e.scale.length !== 3) throw new Error(`entity[${i}].scale must be [x,y,z]`)
      if (e.bodyType && !['static', 'dynamic', 'kinematic'].includes(e.bodyType)) {
        throw new Error(`entity[${i}].bodyType must be static|dynamic|kinematic, got ${e.bodyType}`)
      }
      if (e.collider && e.collider.type && !['box', 'sphere', 'capsule', 'trimesh', 'convex', 'none'].includes(e.collider.type)) {
        throw new Error(`entity[${i}].collider.type must be valid, got ${e.collider.type}`)
      }
    }

    if (prefab.rootId && !prefab.entities.some(e => e.id === prefab.rootId)) {
      throw new Error(`rootId "${prefab.rootId}" not found in entities`)
    }
  }

  validatePrefab(prefab, appDefsMap = null) {
    this._validateSchema(prefab)

    if (appDefsMap) {
      for (const e of prefab.entities) {
        if (e.app && !appDefsMap.has(e.app)) {
          throw new Error(`entity "${e.id}": app "${e.app}" not found`)
        }
      }
    }
  }
}

export async function createPrefabLibrary(baseDir = process.cwd?.() || '.') {
  if (!isNode) {
    return {
      exists: async () => false,
      list: async () => [],
      load: async () => null,
      save: async () => { throw new Error('[prefab] not available in browser context') },
      delete: async () => { throw new Error('[prefab] not available in browser context') },
      duplicate: async () => { throw new Error('[prefab] not available in browser context') },
      createVariant: async () => { throw new Error('[prefab] not available in browser context') },
      validatePrefab: () => { throw new Error('[prefab] not available in browser context') }
    }
  }
  return new PrefabLibrary(baseDir)
}

export { PrefabLibrary }
