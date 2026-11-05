import { createHash } from 'node:crypto'

const MAX_INLINE_BYTES = 4.5 * 1024 * 1024

function refusal(code, message) {
  const err = new TypeError(`[asset-registry] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function assetName(value, ext, content) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw refusal('asset-value-invalid', 'value must be an alphanumeric slug')
  if (typeof ext !== 'string' || !/^[a-zA-Z0-9]+$/.test(ext)) throw refusal('asset-ext-invalid', 'ext must be an alphanumeric extension')
  if (typeof content !== 'string' && !(content instanceof Uint8Array)) throw refusal('asset-content-invalid', 'content must be a string or Uint8Array')
  const digest = createHash('sha256').update(content).digest('hex')
  return `${value}.${digest}.${ext}`
}

export function uploadPlan({ name, sizeBytes, maxInlineBytes = MAX_INLINE_BYTES } = {}) {
  if (typeof name !== 'string' || !name) throw refusal('asset-name-invalid', 'name must be a non-empty string')
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) throw refusal('asset-size-invalid', 'sizeBytes must be a non-negative integer')
  if (!Number.isFinite(maxInlineBytes) || maxInlineBytes <= 0) throw refusal('asset-threshold-invalid', 'maxInlineBytes must be a positive finite number')
  if (sizeBytes <= maxInlineBytes) return { mode: 'inline', path: `/assets/${name}`, sizeBytes }
  return { mode: 'upload-target', path: '/assets/upload-target', name, sizeBytes, reason: 'exceeds-inline-threshold' }
}
