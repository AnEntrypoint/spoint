/**
 * AppManifest.js -- Standardized app manifest schema for spoint entity apps.
 *
 * This is the ENVELOPE format for publishing spoint apps to a registry
 * (plugin-marketplace-registry-for-spoint-apps-and-freddie-skills).
 * An app manifest is a single JSON-serializable object describing the app's
 * metadata, entry point, dependencies, and editor-facing surface.
 *
 * An app DOES NOT need a manifest file to run in a spoint world -- the
 * existing apps/<name>/index.js convention (documented in apps/README.md)
 * is still the only requirement for local development. The manifest is the
 * PUBLISH-time wrapper that adds registry metadata (version, description,
 * author, icon) to the raw app module.
 *
 * Shape:
 *  {
 *    name: string,           // unique app name, matches the apps/<name>/ directory
 *    version: string,        // semver
 *    title: string,          // human-readable display name
 *    description: string,    // 1-3 sentence description
 *    author: {               // optional, defaults to placeholder
 *      name: string,         // display name
 *      nostr?: string,       // npub hex pubkey (optional, for identity)
 *    },
 *    license: string,        // SPDX identifier (e.g. "MIT", "CC0-1.0")
 *    icon?: string,          // relative path to a 256x256 PNG within the app bundle
 *    entry: string,          // relative path to the app module (default: "index.js")
 *    dependencies: {         // npm package name -> semver range
 *      [pkg: string]: string,
 *    },
 *    editorProps: {          // mirror of the app's existing editorProps shape
 *      [field: string]: {
 *        type: string,       // "string"|"number"|"boolean"|"select"|"vec3"|"color"|"textarea"|"entity-reference"|"object-select"|"range"
 *        label: string,
 *        default?: any,
 *        help?: string,
 *        options?: {label:string, value:any}[],  // for "select" type
 *        min?: number,       // for "range" type
 *        max?: number,
 *        step?: number,
 *      },
 *    },
 *    requires: {             // engine capabilities the app needs
 *      physics?: boolean,        // needs a physics body
 *      networking?: boolean,     // needs network-synced state
 *      client?: boolean,         // has a client.setup() hook
 *      voice?: boolean,          // uses voice chat
 *      persistence?: boolean,    // uses storage adapter
 *      placeable?: boolean,      // may be placed by the user (editor Add menu)
 *    },
 *    tags: string[],         // free-form tags for discovery: ["weapon","vehicle","terrain","editor","utility","game-mode","character","environment","collectible","trigger"]
 *    compatibility: {
 *      spoint: string,       // semver range for spoint engine
 *      wireweave?: string,   // semver range for wireweave (if networking)
 *    },
 *  }
 *
 * The manifest is stored alongside the app's source as `manifest.json` in the
 * app's directory (apps/<name>/manifest.json). It is separate from the app's
 * config field (which is per-entity runtime configuration, not per-app metadata).
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** @type {string[]} */
const KNOWN_EDITOR_PROP_TYPES = [
  'string', 'number', 'boolean', 'select', 'vec3', 'color',
  'textarea', 'entity-reference', 'object-select', 'range',
]

/** @type {string[]} */
const KNOWN_TAGS = [
  'weapon', 'vehicle', 'terrain', 'editor', 'utility', 'game-mode',
  'character', 'environment', 'collectible', 'trigger', 'pickup',
  'physics', 'audio', 'hud', 'ai', 'animation', 'ui',
]

/** @type {string[]} */
const VALID_SPDX = [
  'MIT', 'CC0-1.0', 'Apache-2.0', 'GPL-3.0', 'LGPL-3.0',
  'MPL-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'Unlicense', 'ISC',
]

/**
 * Validate a manifest object. Returns { valid: true } or { valid: false, errors: [...] }.
 * This is a soft-lint for the publisher; the registry may apply stricter rules.
 */
export function validateManifest(manifest) {
  const errors = []

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be an object'] }
  }

  // Required string fields
  for (const f of ['name', 'version', 'title', 'description', 'license', 'entry']) {
    if (typeof manifest[f] !== 'string' || !manifest[f]) {
      errors.push(`missing or empty required field: ${f}`)
    }
  }

  // name: must match the directory convention (alphanumeric + hyphens only)
  if (manifest.name && !/^[a-z][a-z0-9-]*$/.test(manifest.name)) {
    errors.push(`name must be lowercase alphanumeric + hyphens: "${manifest.name}"`)
  }

  // version: must be valid semver (loose check)
  if (manifest.version && !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/.test(manifest.version)) {
    errors.push(`version must be semver: "${manifest.version}"`)
  }

  // license: must be a known SPDX id
  if (manifest.license && !VALID_SPDX.includes(manifest.license)) {
    errors.push(`license must be a known SPDX id: "${manifest.license}" (known: ${VALID_SPDX.join(', ')})`)
  }

  // author
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

  // editorProps
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

  // requires
  if (manifest.requires !== undefined) {
    if (typeof manifest.requires !== 'object' || Array.isArray(manifest.requires)) {
      errors.push('requires must be an object')
    }
  }

  // dependencies
  if (manifest.dependencies !== undefined) {
    if (typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
      errors.push('dependencies must be an object')
    }
  }

  // tags
  if (manifest.tags !== undefined) {
    if (!Array.isArray(manifest.tags)) {
      errors.push('tags must be an array of strings')
    }
  }

  // compatibility
  if (manifest.compatibility !== undefined) {
    if (typeof manifest.compatibility !== 'object' || !manifest.compatibility.spoint) {
      errors.push('compatibility.spoint semver range is required')
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

/**
 * Create a minimal manifest from an app's existing metadata.
 * Reads the app's index.js for editorProps (if exported) and fills in defaults.
 * This is the bridge between the existing apps/ convention and the manifest format.
 *
 * @param {string} name - app name (directory name)
 * @param {object} appModule - the app's default export (or a subset)
 * @returns {object} a minimal valid manifest
 */
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

// ---------------------------------------------------------------------------
// Freddie skill manifest alignment
// ---------------------------------------------------------------------------

/**
 * Freddie skill manifest shape (as defined by the freddie SKILLS-only registry
 * resolved in freddie-adapter-conformance-approval-ux-thebird-marketplace-orchestration-guardrails).
 *
 * A freddie skill manifest shares the same core metadata fields as AppManifest
 * but adds freddie-specific fields like `skill` (the skill's hook/capability shape)
 * and `triggers` (when the skill activates).
 *
 * Shape (freddie-specific fields):
 *  {
 *    name: string,          // skill name (matches the SKILL.md filename)
 *    version: string,       // semver
 *    title: string,         // human-readable display name
 *    description: string,   // 1-3 sentence description
 *    author: { name, nostr? },
 *    license: string,       // SPDX
 *    icon?: string,
 *    tags: string[],
 *    compatibility: { spoint, wireweave? },
 *
 *    // Freddie-specific:
 *    kind: "skill",                   // always "skill" for freddie entries
 *    skill: {                         // skill capability shape
 *      hooks: string[],               // lifecycle hooks: ["setup","update","teardown"]
 *      triggers: string[],            // when to activate: ["onMessage","onTick","onEvent"]
 *      allowedTools?: string[],       // tools the skill can use
 *      inputSchema?: object,          // JSON Schema for skill input
 *      outputSchema?: object,         // JSON Schema for skill output (optional)
 *    },
 *    entry: string,                   // relative path to the skill module (default: "SKILL.md")
 *    dependencies: { [pkg: string]: string },
 *  }
 */

/**
 * Convert a freddie skill manifest to a spoint AppManifest.
 * This is the unification bridge: a freddie skill published to the marketplace
 * can be discovered and installed by spoint tooling as if it were an app.
 *
 * The conversion:
 *  - Preserves all shared metadata fields
 *  - Adds `kind: "skill"` so consumers can distinguish skill entries from app entries
 *  - Wraps freddie-specific fields under `skill: { hooks, triggers, allowedTools, inputSchema, outputSchema }`
 *  - Sets `entry` to the skill's main file (default "SKILL.md")
 *
 * @param {object} freddieManifest - a freddie skill manifest
 * @returns {object} a spoint AppManifest with kind="skill"
 */
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

/**
 * Convert a spoint AppManifest back to a freddie skill manifest.
 * Inverse of freddieSkillToAppManifest. Only works for manifests with kind="skill".
 *
 * @param {object} appManifest - a spoint AppManifest with kind="skill"
 * @returns {object} a freddie skill manifest
 */
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

/**
 * Check if a manifest is a freddie skill (kind === "skill").
 * @param {object} manifest
 * @returns {boolean}
 */
export function isSkillManifest(manifest) {
  return manifest && manifest.kind === 'skill'
}

/**
 * Check if a manifest is a spoint entity app (kind is absent or "app").
 * @param {object} manifest
 * @returns {boolean}
 */
export function isAppManifest(manifest) {
  return manifest && (!manifest.kind || manifest.kind === 'app')
}