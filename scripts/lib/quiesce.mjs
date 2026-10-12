import { stopWitnessServers } from './witness-server.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const referencedHandles = () => (process._getActiveHandles?.() ?? []).length

// The stop gets its own slice of the drain window. A registered server whose
// stop() never settles would otherwise eat the whole budget and still leave its
// handles behind; whatever survives the slice is killed synchronously by the
// registry's process-exit hook, so the process leaves through the exit below
// instead of idling past the bound.
export const STOP_BOUND_MS = 5000

export async function exitAfterQuiesce(code = 0, timeoutMs = 10000) {
  // A spoint server registered through scripts/lib/witness-server.mjs keeps the
  // handle census non-zero for as long as it lives, so draining without stopping
  // it first can only ever end in the forced process.exit() below -- which is the
  // uv_async_send-with-handles-mid-close case. Stop first, then drain.
  //
  // That covers both shapes of registered server: an in-process one whose stop()
  // releases the listen socket and tick timers, and a `node server.js` child this
  // process spawned, which is signalled and then reaped.
  const stopBoundMs = Math.max(0, Math.min(timeoutMs, STOP_BOUND_MS))
  await Promise.race([stopWitnessServers().catch(() => {}), sleep(stopBoundMs)])
  const deadline = Date.now() + timeoutMs
  let pending = referencedHandles()
  while (pending > 0 && Date.now() < deadline) {
    await sleep(20)
    pending = referencedHandles()
  }
  if (pending > 0) process.exit(code)
  process.exitCode = code
  setTimeout(() => process.exit(code), 2000).unref()
  return pending
}
