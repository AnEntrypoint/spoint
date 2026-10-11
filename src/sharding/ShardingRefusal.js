export const MESSAGE_TYPE_UNKNOWN = 'message-type-unknown'
export const WORKER_NOT_INITIALIZED = 'worker-not-initialized'
export const WORKER_REFUSED = 'WORKER_REFUSED'
export const ROUTER_PLAYER_ID_MALFORMED = 'router-player-id-malformed'
export const CLIENT_CONNECT_REFUSED = 'CLIENT_CONNECT_REFUSED'
export const HANDOFF_REFUSED = 'HANDOFF_REFUSED'

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

export function routerPlayerIdRefusal(value, code = ROUTER_PLAYER_ID_MALFORMED) {
  const err = new Error(`[region-ipc] ${code}: routerPlayerId ${JSON.stringify(value ?? null)} is not a router-minted player id`)
  err.code = code
  return err
}

export class ClientConnectRefusedError extends Error {
  constructor(code, error = null) {
    super(`region worker refused the client connect: ${code}${error ? ` -- ${error}` : ''}`)
    this.name = 'ClientConnectRefusedError'
    this.code = code
    this.spointRefused = true
    this.error = error
  }
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
