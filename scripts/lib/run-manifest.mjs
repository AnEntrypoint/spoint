import { createHash } from 'node:crypto'

function refusal(code, message) {
  const err = new TypeError(`[run-manifest] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function createRunManifest({ id, task, maxInflight = 8, maxSteps = 50, createdAt, workspace = null } = {}) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(id)) throw refusal('manifest-id-invalid', 'id must be a non-empty slug')
  if (typeof task !== 'string' || !task) throw refusal('manifest-task-invalid', 'task must be a non-empty string')
  if (!Number.isInteger(maxInflight) || maxInflight < 1) throw refusal('manifest-inflight-invalid', 'maxInflight must be a positive integer')
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw refusal('manifest-steps-invalid', 'maxSteps must be a positive integer')
  if (typeof createdAt !== 'string' || !createdAt) throw refusal('manifest-time-invalid', 'createdAt must be a non-empty string')
  if (workspace !== null && typeof workspace !== 'string') throw refusal('manifest-workspace-invalid', 'workspace must be a string or null')
  return Object.freeze({ id, task, maxInflight, maxSteps, createdAt, workspace })
}

export function manifestPath(root, id) {
  if (typeof root !== 'string' || typeof id !== 'string' || !id) throw refusal('manifest-path-invalid', 'root and id must be non-empty strings')
  return `${root.replace(/\/$/, '')}/runs/${id}/task.json`
}

export function manifestDigest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw refusal('manifest-invalid', 'manifest must be an object')
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}
