import { stopWitnessServers } from './witness-server.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const referencedHandles = () => (process._getActiveHandles?.() ?? []).length

export const STOP_BOUND_MS = 5000

export async function exitAfterQuiesce(code = 0, timeoutMs = 10000) {
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
