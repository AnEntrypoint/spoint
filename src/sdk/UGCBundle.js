import { createHash } from 'node:crypto'
import { canonicalJSON } from '../shared/canonicalJSON.js'

export const BUNDLE_FORMAT_VERSION = 1

export function contentHash(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function canonicalManifestJSON(manifest) {
  return canonicalJSON(manifest)
}

export function computeBundleId(manifest) {
  return contentHash(Buffer.from(canonicalManifestJSON(manifest), 'utf8'))
}

export function validateManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object') { errors.push('manifest must be an object'); return errors }
  if (manifest.formatVersion !== 1) errors.push('formatVersion must be 1')
  if (typeof manifest.name !== 'string' || !manifest.name) errors.push('name is required')
  if (manifest.author && typeof manifest.author.pubkey !== 'string') errors.push('author.pubkey must be a hex string')
  if (manifest.world) {
    if (typeof manifest.world.entry !== 'string') errors.push('world.entry must be a sha256 hex string')
    if (typeof manifest.world.name !== 'string') errors.push('world.name is required')
  }
  if (Array.isArray(manifest.apps)) {
    for (let i = 0; i < manifest.apps.length; i++) {
      const a = manifest.apps[i]
      if (typeof a.name !== 'string' || !a.name) errors.push(`apps[${i}].name is required`)
      if (typeof a.script !== 'string') errors.push(`apps[${i}].script must be a sha256 hex string`)
    }
  }
  if (manifest.assets && typeof manifest.assets === 'object') {
    for (const [hash, info] of Object.entries(manifest.assets)) {
      if (!/^[0-9a-f]{64}$/.test(hash)) errors.push(`asset key "${hash}" is not a valid sha256 hex`)
      if (info && typeof info.kind !== 'string') errors.push(`asset "${hash}" missing kind`)
    }
  }
  return errors
}

export function buildAssetIndex(manifest) {
  const index = new Map()
  if (manifest.assets) {
    for (const [hash, info] of Object.entries(manifest.assets)) {
      if (info.originalName) index.set(info.originalName, hash)
    }
  }
  return index
}