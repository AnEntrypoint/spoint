/**
 * UGCBundle.js — Content-addressed publish format for UGC worlds/apps.
 *
 * PRD row: ugc-content-addressed-publish-loop
 * FIRST SLICE: define the content-addressed bundle format (manifest + files + hash).
 *
 * A UGC bundle is a content-addressed, self-describing package of world/app assets
 * that can be published (announced over nostr), browsed, joined, and remixed in-client.
 *
 * The BUNDLE FORMAT is deliberately independent of the execution sandbox — defining
 * the format now (this slice) means the publish UI + nostr announcement + client-side
 * fetch/verify path can be built in parallel with the sandbox tier, converging once
 * both are ready. The format itself carries zero executable code; it is a manifest of
 * asset hashes the client fetches and verifies before handing anything to the sandbox.
 *
 * The ACTUAL PUBLISHING (nostr announcement + in-client browse/join/remix) is blocked
 * on the modding sandbox tier (PRD row: modding-sandbox-untrusted-execution-tier, pending)
 * landing first — the sandbox is the architectural unlock for running untrusted UGC code
 * safely on browser hosts. This slice ships the format SPEC; the publish loop ships once
 * the sandbox gates are met.
 *
 * Bundle format (v1):
 *
 * A bundle is a directory (or a single .spointbundle tar-like archive) containing:
 *
 *   manifest.json   — the bundle descriptor (see BundleManifest below)
 *   files/          — all assets, named by their content hash
 *     <sha256>.js   — app scripts (one per app)
 *     <sha256>.glb  — models
 *     <sha256>.png  — textures / thumbnails
 *     <sha256>.json — world definitions, prefabs, any other JSON
 *
 * The manifest.json shape:
 *  {
 *    "formatVersion": 1,
 *    "id": "<hash-of-manifest>",       // content-addressed bundle identity
 *    "name": "My Map",
 *    "description": "...",
 *    "author": { "name": "...", "pubkey": "<nostr-pubkey-hex>" },
 *    "createdAt": "2026-07-24T...",
 *    "updatedAt": "2026-07-24T...",
 *    "world": {
 *      "entry": "<sha256>.json",       // world definition file
 *      "name": "tutorial",
 *      "seed": 12345,
 *      "terrain": { "radius": 8000, "reliefScale": 1.5 }
 *    },
 *    "apps": [
 *      {
 *        "name": "my-custom-app",
 *        "script": "<sha256>.js",      // app module
 *        "kind": "gameplay",           // gameplay | editor | utility
 *        "trusted": false              // false = runs in sandbox tier
 *      }
 *    ],
 *    "assets": {
 *      "<sha256>.glb": { "kind": "model", "originalName": "castle.glb" },
 *      "<sha256>.png": { "kind": "texture", "originalName": "banner.png" },
 *      "<sha256>.png": { "kind": "thumbnail", "originalName": "thumb.png" }
 *    },
 *    "remixOf": "<parent-bundle-id>",  // optional, for remix chains
 *    "signature": "<nostr-schnorr-sig>" // author's signature over the manifest hash
 *  }
 *
 * Content addressing:
 *  - Every file is named by its SHA-256 hex digest of its raw bytes
 *  - The manifest's own `id` is the SHA-256 of the canonical JSON (sorted keys, no whitespace)
 *  - The `signature` is the author's nostr Schnorr signature over the manifest id bytes
 *  - This means a bundle's identity is fully determined by its content — two bundles with
 *    identical content have identical ids, naturally enabling deduplication and caching
 *
 * Security model (deferred to sandbox tier):
 *  - The manifest is verified (hash matches id, signature verifies against author pubkey)
 *    BEFORE any file is fetched
 *  - Each file is verified (hash matches its filename) BEFORE it is handed to the sandbox
 *  - The `trusted: false` flag on an app means it runs in the sandbox tier; `trusted: true`
 *    is only allowed for bundles from an allowlisted author pubkey set
 *  - A remix chain (remixOf) is verified transitively — the parent bundle's manifest
 *    signature must also verify
 */

import { createHash } from 'node:crypto'

export const BUNDLE_FORMAT_VERSION = 1

/**
 * Compute the content hash for a buffer.
 * @param {Buffer|Uint8Array} buf
 * @returns {string} hex-encoded SHA-256
 */
export function contentHash(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Build a canonical manifest JSON string (sorted keys, no whitespace)
 * suitable for hashing as the bundle id.
 * @param {object} manifest — the manifest object WITHOUT the `id` field
 * @returns {string}
 */
export function canonicalManifestJSON(manifest) {
  return JSON.stringify(manifest, Object.keys(manifest).sort())
}

/**
 * Compute the bundle id from a manifest (without its `id` field).
 * @param {object} manifest
 * @returns {string} hex-encoded SHA-256
 */
export function computeBundleId(manifest) {
  return contentHash(Buffer.from(canonicalManifestJSON(manifest), 'utf8'))
}

/**
 * Validate a manifest object against the v1 schema.
 * Returns an array of error strings (empty = valid).
 * @param {object} manifest
 * @returns {string[]}
 */
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

/**
 * Build a file-name-to-hash index from a manifest.
 * @param {object} manifest
 * @returns {Map<string, string>} originalName -> sha256 hash
 */
export function buildAssetIndex(manifest) {
  const index = new Map()
  if (manifest.assets) {
    for (const [hash, info] of Object.entries(manifest.assets)) {
      if (info.originalName) index.set(info.originalName, hash)
    }
  }
  return index
}