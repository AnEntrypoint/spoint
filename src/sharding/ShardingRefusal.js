export const MESSAGE_TYPE_UNKNOWN = 'message-type-unknown'
export const WORKER_NOT_INITIALIZED = 'worker-not-initialized'
export const WORKER_REFUSED = 'WORKER_REFUSED'

export function messageRefusal(code, detail) {
  return { ok: false, code, detail }
}

export function messageTable(entries) {
  return new Map(entries)
}

export function dispatchMessage(table, msg, arg) {
  const handler = table.get(msg?.type)
  if (handler === undefined) return messageRefusal(MESSAGE_TYPE_UNKNOWN, { type: msg?.type ?? null })
  return { ok: true, value: handler(msg, arg) }
}

export function errorRefusal(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : null,
    error: String(error?.message ?? error ?? ''),
  }
}

export function refusalText(refusal) {
  return `${refusal?.name ?? 'Error'} ${refusal?.code ?? '(no code)'}: ${refusal?.error ?? ''}`
}

export class RegionWorkerRefusedError extends Error {
  constructor(regionId, refusal) {
    super(`region worker ${regionId} refused to boot: ${refusalText(refusal)}`)
    this.name = 'RegionWorkerRefusedError'
    this.code = 'region-worker-refused'
    this.spointRefused = true
    this.regionId = regionId
    this.refusal = { ...refusal }
  }
}

export class RegionSiblingRefusedError extends Error {
  constructor(regionId, refusedRegionId) {
    super(`region worker ${regionId} aborted: sibling region ${refusedRegionId} refused to boot`)
    this.name = 'RegionSiblingRefusedError'
    this.code = 'region-sibling-refused'
    this.spointRefused = false
    this.regionId = regionId
    this.refusedRegionId = refusedRegionId
  }
}
