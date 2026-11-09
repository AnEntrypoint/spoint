import { registerHooks } from 'node:module'
import { createVirtualClock, installVirtualGlobals } from './virtual-clock.mjs'
import { WebSocket } from './virtual-ws.mjs'

const VIRTUAL_WS_URL = new URL('./virtual-ws.mjs', import.meta.url).href
const rawSeed = process.env.SPOINT_VIRTUAL_SEED
const parsedSeed = rawSeed === undefined ? 0 : Number(rawSeed)
if (!Number.isInteger(parsedSeed) || parsedSeed < 0) {
  throw new Error(`[virtual-runtime] SPOINT_VIRTUAL_SEED must be a non-negative integer, got ${JSON.stringify(rawSeed)}`)
}
export const RUN_SEED = parsedSeed
export const virtualClock = createVirtualClock({ seed: RUN_SEED })
installVirtualGlobals(virtualClock)
globalThis.WebSocket = WebSocket
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'ws') return { url: VIRTUAL_WS_URL, shortCircuit: true }
    return nextResolve(specifier, context)
  }
})

export function driveVirtual(task, options) {
  return virtualClock.drive(task, options)
}
