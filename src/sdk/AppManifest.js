const KNOWN_EDITOR_PROP_TYPES = [
  'string', 'number', 'boolean', 'select', 'vec3', 'color',
  'textarea', 'entity-reference', 'object-select', 'range',
]

const KNOWN_TAGS = [
  'weapon', 'vehicle', 'terrain', 'editor', 'utility', 'game-mode',
  'character', 'environment', 'collectible', 'trigger', 'pickup',
  'physics', 'audio', 'hud', 'ai', 'animation', 'ui',
]

const VALID_SPDX = [
  'MIT', 'CC0-1.0', 'Apache-2.0', 'GPL-3.0', 'LGPL-3.0',
  'MPL-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'Unlicense', 'ISC',
]

export function validateManifest(manifest) {
  const errors = []

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be an object'] }
  }

  for (const f of ['name', 'version', 'title', 'description', 'license', 'entry']) {
    if (typeof manifest[f] !== 'string' || !manifest[f]) {
      errors.push(`missing or empty required field: ${f}`)
    }
  }

  if (manifest.name && !/^[a-z][a-z0-9-]*$/.test(manifest.name)) {
    errors.push(`name must be lowercase alphanumeric + hyphens: "${manifest.name}"`)
  }

  if (manifest.version && !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/.test(manifest.version)) {
    errors.push(`version must be semver: "${manifest.version}"`)
  }

  if (manifest.license && !VALID_SPDX.includes(manifest.license)) {
    errors.push(`license must be a known SPDX id: "${manifest.license}" (known: ${VALID_SPDX.join(', ')})`)
  }

  if (manifest.author !== undefined) {
    if (!manifest.author || typeof manifest.author !== 'object') {
      errors.push('author must be an object { name } or omitted')
    } else if (typeof manifest.author.name !== 'string' || !manifest.author.name) {
      errors.push('author.name is required when author is present')
    }
    if (manifest.author.nostr !== undefined && typeof manifest.author.nostr !== 'string') {
      errors.push('author.nostr must be a hex pubkey string if present')
    }
  }

  if (manifest.editorProps !== undefined) {
    if (typeof manifest.editorProps !== 'object' || Array.isArray(manifest.editorProps)) {
      errors.push('editorProps must be an object')
    } else {
      for (const [field, prop] of Object.entries(manifest.editorProps)) {
        if (!prop || typeof prop !== 'object') {
          errors.push(`editorProps.${field} must be an object`)
          continue
        }
        if (typeof prop.type !== 'string' || !KNOWN_EDITOR_PROP_TYPES.includes(prop.type)) {
          errors.push(`editorProps.${field}.type must be one of: ${KNOWN_EDITOR_PROP_TYPES.join(', ')}`)
        }
        if (typeof prop.label !== 'string' || !prop.label) {
          errors.push(`editorProps.${field}.label is required`)
        }
        if (prop.type === 'select' && (!Array.isArray(prop.options) || prop.options.length === 0)) {
          errors.push(`editorProps.${field} (select) requires a non-empty options array`)
        }
        if (prop.type === 'range' && (typeof prop.min !== 'number' || typeof prop.max !== 'number')) {
          errors.push(`editorProps.${field} (range) requires min and max numbers`)
        }
      }
    }
  }

  if (manifest.requires !== undefined) {
    if (typeof manifest.requires !== 'object' || Array.isArray(manifest.requires)) {
      errors.push('requires must be an object')
    }
  }

  if (manifest.dependencies !== undefined) {
    if (typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
      errors.push('dependencies must be an object')
    }
  }

  if (manifest.tags !== undefined) {
    if (!Array.isArray(manifest.tags)) {
      errors.push('tags must be an array of strings')
    }
  }

  if (manifest.compatibility !== undefined) {
    if (typeof manifest.compatibility !== 'object' || !manifest.compatibility.spoint) {
      errors.push('compatibility.spoint semver range is required')
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

export function createMinimalManifest(name, appModule = {}) {
  const server = appModule.server || {}
  const client = appModule.client || {}
  const editorProps = appModule.editorProps || server.editorProps || client.editorProps || {}

  return {
    name,
    version: '0.1.0',
    title: name,
    description: `${name} app`,
    license: 'MIT',
    entry: 'index.js',
    editorProps: Object.keys(editorProps).length > 0 ? editorProps : undefined,
    requires: {
      physics: !!server.setup,
      networking: !!server.setup,
      client: !!client.setup,
    },
    tags: [],
    compatibility: {
      spoint: '>=0.1.0',
    },
  }
}

export function freddieSkillToAppManifest(freddieManifest) {
  if (!freddieManifest || typeof freddieManifest !== 'object') {
    throw new Error('freddieManifest must be an object')
  }

  const skill = freddieManifest.skill || {}

  return {
    name: freddieManifest.name,
    version: freddieManifest.version,
    title: freddieManifest.title || freddieManifest.name,
    description: freddieManifest.description || `${freddieManifest.name} skill`,
    author: freddieManifest.author || undefined,
    license: freddieManifest.license || 'MIT',
    icon: freddieManifest.icon || undefined,
    entry: freddieManifest.entry || 'SKILL.md',
    kind: 'skill',
    skill: {
      hooks: skill.hooks || [],
      triggers: skill.triggers || [],
      allowedTools: skill.allowedTools || undefined,
      inputSchema: skill.inputSchema || undefined,
      outputSchema: skill.outputSchema || undefined,
    },
    dependencies: freddieManifest.dependencies || undefined,
    tags: freddieManifest.tags || [],
    compatibility: freddieManifest.compatibility || { spoint: '>=0.1.0' },
  }
}

export function appManifestToFreddieSkill(appManifest) {
  if (!appManifest || appManifest.kind !== 'skill') {
    throw new Error('appManifest must have kind="skill"')
  }

  const skill = appManifest.skill || {}

  return {
    name: appManifest.name,
    version: appManifest.version,
    title: appManifest.title,
    description: appManifest.description,
    author: appManifest.author,
    license: appManifest.license,
    icon: appManifest.icon,
    entry: appManifest.entry || 'SKILL.md',
    skill: {
      hooks: skill.hooks || [],
      triggers: skill.triggers || [],
      allowedTools: skill.allowedTools,
      inputSchema: skill.inputSchema,
      outputSchema: skill.outputSchema,
    },
    tags: appManifest.tags || [],
    compatibility: appManifest.compatibility,
    dependencies: appManifest.dependencies,
  }
}

export function isSkillManifest(manifest) {
  return manifest && manifest.kind === 'skill'
}

export function isAppManifest(manifest) {
  return manifest && (!manifest.kind || manifest.kind === 'app')
}