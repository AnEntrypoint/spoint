import { stopWitnessServers } from './witness-server.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const isStdio = (handle) => Number.isInteger(handle.fd) && handle.fd >= 0 && handle.fd <= 2
const referencedHandles = () => (process._getActiveHandles?.() ?? []).filter((h) => !isStdio(h) && h.hasRef?.() !== false).length

export const STOP_BOUND_MS = 5000

function boundedBy(promise, ms) {
  let timer
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, ms) })
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer))
}

export async function exitAfterQuiesce(code = 0, timeoutMs = 10000) {
  const stopBoundMs = Math.max(0, Math.min(timeoutMs, STOP_BOUND_MS))
  await boundedBy(stopWitnessServers().catch(() => {}), stopBoundMs)
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
