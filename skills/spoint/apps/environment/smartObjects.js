// Smart Object Templates
// Define behavior, physics, and visual properties for environment entities

export const SMART_OBJECT_TEMPLATES = {
  door: {
    displayName: 'Door',
    model: null,
    collider: { type: 'box', size: [1.5, 2.5, 0.1] },
    physics: 'kinematic',
    editorPlaceholder: { color: 0x0066ff, dims: [1.5, 2.5, 0.1] },
    config: {
      open: false,
      openTime: 0.5,
      closeTime: 0.5,
      openAngle: Math.PI / 2
    }
  },

  platform: {
    displayName: 'Moving Platform',
    model: null,
    collider: { type: 'box', size: [4, 0.5, 4] },
    physics: 'kinematic',
    editorPlaceholder: { color: 0x00cc00, dims: [4, 0.5, 4] },
    config: {
      waypoints: [[0, 0, 0]],
      speed: 5,
      waitTime: 1
    }
  },

  trigger: {
    displayName: 'Trigger Volume',
    model: null,
    collider: { type: 'box', size: [2, 3, 2] },
    physics: 'trigger',
    editorPlaceholder: { color: 0xffff00, dims: [2, 3, 2] },
    config: {
      eventName: 'trigger',
      oneshot: false
    }
  },

  hazard: {
    displayName: 'Hazard Zone',
    model: null,
    collider: { type: 'sphere', radius: 2 },
    physics: 'trigger',
    editorPlaceholder: { color: 0xff0000, dims: [2, 2, 2] },
    config: {
      damage: 10,
      damageInterval: 0.5
    }
  },

  lootBox: {
    displayName: 'Loot Box',
    model: null,
    collider: { type: 'box', size: [1, 1.5, 1] },
    physics: 'dynamic',
    editorPlaceholder: { color: 0x885533, dims: [1, 1.5, 1] },
    config: {
      lootType: 'ammo',
      quantity: 30,
      openSound: 'open'
    }
  },

  pillar: {
    displayName: 'Pillar/Column',
    model: null,
    collider: { type: 'capsule', radius: 0.5, halfHeight: 2 },
    physics: 'static',
    editorPlaceholder: { color: 0x888888, dims: [1, 4, 1] },
    config: {
      decorative: true
    }
  }
}

// Editor placeholder color mapping
export const PLACEHOLDER_COLORS = {
  door: 0x0066ff,      // Blue
  platform: 0x00cc00,  // Green
  trigger: 0xffff00,   // Yellow
  hazard: 0xff0000,    // Red
  lootBox: 0x885533,   // Brown
  pillar: 0x888888,    // Gray
  unknown: 0xcccccc    // Light gray
}

// Get placeholder color for a template
export function getPlaceholderColor(templateName) {
  return PLACEHOLDER_COLORS[templateName] || PLACEHOLDER_COLORS.unknown
}

// Get placeholder dimensions for a template
export function getPlaceholderDimensions(templateName) {
  const template = SMART_OBJECT_TEMPLATES[templateName]
  if (!template || !template.editorPlaceholder) {
    return [1, 1, 1]
  }
  return template.editorPlaceholder.dims
}

// Validate template exists and is accessible
export function isValidTemplate(templateName) {
  return templateName in SMART_OBJECT_TEMPLATES
}

// Get template definition
export function getTemplate(templateName) {
  return SMART_OBJECT_TEMPLATES[templateName] || null
}
