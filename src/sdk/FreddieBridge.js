export const KIND_PLACE = 'viz.place'
export const KIND_UPDATE = 'viz.update'
export const KIND_REMOVE = 'viz.remove'
export const KIND_CLEAR = 'viz.clear'
export const KIND_DATASET = 'viz.dataset'
export const KIND_CAMERA = 'viz.camera'

export const ALL_KINDS = [KIND_PLACE, KIND_UPDATE, KIND_REMOVE, KIND_CLEAR, KIND_DATASET, KIND_CAMERA]

export const PRIMITIVES = ['box', 'sphere', 'capsule', 'cylinder', 'plane', 'model']

export const LAYOUTS = ['grid', 'scatter', 'tree', 'graph', 'spiral']

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

function simpleHash(str) {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}