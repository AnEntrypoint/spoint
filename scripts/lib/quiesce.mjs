import { stopWitnessServers } from './witness-server.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const referencedHandles = () => (process._getActiveHandles?.() ?? []).length

export async function exitAfterQuiesce(code = 0, timeoutMs = 10000) {
  // A spoint server registered through scripts/lib/witness-server.mjs keeps the
  // handle census non-zero for as long as it lives, so draining without stopping
  // it first can only ever end in the forced process.exit() below -- which is the
  // uv_async_send-with-handles-mid-close case. Stop first, then drain.
  await stopWitnessServers()
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
