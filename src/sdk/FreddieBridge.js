/**
 * FreddieBridge.js -- Message protocol for freddie agent output visualization in spoint.
 *
 * This is the FIRST SLICE of spoint-as-3d-visualization-sandbox-for-freddie-agent-output.
 * It defines the message format that freddie (or any agent host) sends to a spoint
 * server to create, update, and destroy 3D visualizations of data/agent state.
 *
 * Architecture:
 *  freddie agent -> FreddieBridge message (JSON) -> spoint server HTTP/WS endpoint
 *    -> spawn/update/delete entity apps in the world -> client renders in 3D
 *
 * Message envelope (SharedEventEnvelope.js compatible):
 *  {
 *    id: string,       // ULID or UUID for deduplication
 *    ts: number,       // Unix ms timestamp
 *    source: string,   // "freddie:<agentId>" or "freddie:<pluginId>"
 *    kind: string,     // one of the FreddieBridge.KIND_* constants below
 *    payload: object,  // kind-specific payload (see below)
 *  }
 *
 * Kind: "viz.place"
 *  payload: {
 *    entityId: string,     // unique id for this visualization entity
 *    primitive: "box"|"sphere"|"capsule"|"cylinder"|"plane"|"model",
 *    model?: string,       // asset name if primitive === "model" (e.g. "aim_sillos")
 *    position: [x,y,z],    // world position
 *    scale: [sx,sy,sz],    // scale (default [1,1,1])
 *    color: number,        // hex color (default 0xffffff)
 *    emissive?: number,    // emissive hex color
 *    opacity?: number,     // 0-1 (default 1)
 *    label?: string,       // text label floating above the entity
 *    parentId?: string,    // attach to another entity
 *  }
 *
 * Kind: "viz.update"
 *  payload: {
 *    entityId: string,     // entity to update
 *    position?: [x,y,z],
 *    scale?: [sx,sy,sz],
 *    color?: number,
 *    emissive?: number,
 *    opacity?: number,
 *    label?: string,
 *  }
 *
 * Kind: "viz.remove"
 *  payload: { entityId: string }
 *
 * Kind: "viz.clear"
 *  payload: {}  // remove ALL visualization entities created by this source
 *
 * Kind: "viz.dataset"
 *  payload: {
 *    entityId: string,     // root entity for the dataset
 *    layout: "grid"|"scatter"|"tree"|"graph"|"spiral",
 *    items: [{             // array of data points
 *      id: string,         // sub-entity id
 *      label: string,
 *      value: number,      // drives size/color mapping
 *      position?: [x,y,z], // override layout position
 *      color?: number,
 *      children?: [...],   // recursive for tree layout
 *    }],
 *    config: {
 *      spacing?: number,   // distance between items (default 1)
 *      sizeRange?: [min,max], // min/max scale from value (default [0.1, 1])
 *      colorRange?: [min,max], // value range for color mapping (default [0, 1])
 *      colorLow?: number,  // hex color for low values (default 0x3366ff)
 *      colorHigh?: number, // hex color for high values (default 0xff3333)
 *    },
 *  }
 *
 * Kind: "viz.camera"
 *  payload: {
 *    position: [x,y,z],
 *    target: [x,y,z],      // look-at point
 *    transition?: number,  // seconds for smooth transition (default 0 = instant)
 *  }
 */

export const KIND_PLACE = 'viz.place'
export const KIND_UPDATE = 'viz.update'
export const KIND_REMOVE = 'viz.remove'
export const KIND_CLEAR = 'viz.clear'
export const KIND_DATASET = 'viz.dataset'
export const KIND_CAMERA = 'viz.camera'

/** @type {string[]} */
export const ALL_KINDS = [KIND_PLACE, KIND_UPDATE, KIND_REMOVE, KIND_CLEAR, KIND_DATASET, KIND_CAMERA]

/** @type {string[]} */
export const PRIMITIVES = ['box', 'sphere', 'capsule', 'cylinder', 'plane', 'model']

/** @type {string[]} */
export const LAYOUTS = ['grid', 'scatter', 'tree', 'graph', 'spiral']

/**
 * Validate a freddie bridge message. Returns { valid: true } or { valid: false, errors: [...] }.
 */
export function validateMessage(msg) {
  const errors = []

  if (!msg || typeof msg !== 'object') {
    return { valid: false, errors: ['message must be an object'] }
  }

  if (typeof msg.id !== 'string' || !msg.id) errors.push('id is required (string)')
  if (typeof msg.ts !== 'number') errors.push('ts is required (number, unix ms)')
  if (typeof msg.source !== 'string' || !msg.source) errors.push('source is required (string)')
  if (!ALL_KINDS.includes(msg.kind)) errors.push(`kind must be one of: ${ALL_KINDS.join(', ')}`)
  if (!msg.payload || typeof msg.payload !== 'object') errors.push('payload is required (object)')

  if (msg.kind === KIND_PLACE) {
    const p = msg.payload
    if (typeof p.entityId !== 'string' || !p.entityId) errors.push('payload.entityId is required')
    if (!PRIMITIVES.includes(p.primitive)) errors.push(`payload.primitive must be one of: ${PRIMITIVES.join(', ')}`)
    if (p.primitive === 'model' && typeof p.model !== 'string') errors.push('payload.model is required when primitive is "model"')
    if (p.primitive === 'model' && typeof p.model === 'string' && (!p.model || p.model.split(/[\\/]/).includes('..') || /^[a-zA-Z]:[\\/]/.test(p.model) || p.model.startsWith('/') || p.model.startsWith('\\'))) errors.push('payload.model must be a non-empty relative path with no ".." segments and no drive-absolute or root-absolute prefix')
    if (p.position && (!Array.isArray(p.position) || p.position.length !== 3)) errors.push('payload.position must be [x,y,z]')
    if (p.scale && (!Array.isArray(p.scale) || p.scale.length !== 3)) errors.push('payload.scale must be [sx,sy,sz]')
  }

  if (msg.kind === KIND_UPDATE || msg.kind === KIND_REMOVE) {
    if (typeof msg.payload.entityId !== 'string' || !msg.payload.entityId) {
      errors.push('payload.entityId is required')
    }
  }

  if (msg.kind === KIND_DATASET) {
    const p = msg.payload
    if (typeof p.entityId !== 'string' || !p.entityId) errors.push('payload.entityId is required')
    if (!LAYOUTS.includes(p.layout)) errors.push(`payload.layout must be one of: ${LAYOUTS.join(', ')}`)
    if (!Array.isArray(p.items)) errors.push('payload.items must be an array')
  }

  if (msg.kind === KIND_CAMERA) {
    const p = msg.payload
    if (!Array.isArray(p.position) || p.position.length !== 3) errors.push('payload.position must be [x,y,z]')
    if (!Array.isArray(p.target) || p.target.length !== 3) errors.push('payload.target must be [x,y,z]')
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

/**
 * Compute layout positions for a dataset's items.
 * Returns a Map of item id -> [x,y,z] position.
 * Pure function, no side effects.
 */
export function computeLayout(items, layout, config = {}) {
  const spacing = config.spacing || 1
  const positions = new Map()

  if (layout === 'grid') {
    const cols = Math.ceil(Math.sqrt(items.length))
    items.forEach((item, i) => {
      const row = Math.floor(i / cols)
      const col = i % cols
      positions.set(item.id, [
        (col - (cols - 1) / 2) * spacing,
        0,
        (row - (Math.floor((items.length - 1) / cols)) / 2) * spacing,
      ])
    })
  } else if (layout === 'scatter') {
    // Simple hash-based scatter (deterministic, not random)
    items.forEach((item, i) => {
      const h = simpleHash(item.id + 'x') / 0xffffffff
      const h2 = simpleHash(item.id + 'z') / 0xffffffff
      positions.set(item.id, [
        (h - 0.5) * spacing * items.length * 0.5,
        (h2 - 0.5) * spacing * items.length * 0.5 * 0.3,
        (h2 - 0.5) * spacing * items.length * 0.5,
      ])
    })
  } else if (layout === 'tree') {
    function placeRecursive(node, x, y, depth) {
      positions.set(node.id, [x * spacing, -depth * spacing * 1.5, y * spacing])
      if (node.children && node.children.length > 0) {
        const total = node.children.length
        const startX = x - (total - 1) / 2
        node.children.forEach((child, i) => {
          placeRecursive(child, startX + i, y, depth + 1)
        })
      }
    }
    if (items.length > 0) placeRecursive(items[0], 0, 0, 0)
  } else if (layout === 'spiral') {
    items.forEach((item, i) => {
      const angle = i * 0.5
      const radius = spacing * (1 + i * 0.3)
      positions.set(item.id, [
        Math.cos(angle) * radius,
        0,
        Math.sin(angle) * radius,
      ])
    })
  }

  return positions
}

/**
 * Deterministic simple hash (FNV-1a 32-bit) for scatter layout.
 */
function simpleHash(str) {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}