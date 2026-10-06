const sleep = ms => new Promise(r => setTimeout(r, ms))

const referencedHandles = () => (process._getActiveHandles?.() ?? []).length

export async function exitAfterQuiesce(code = 0, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let pending = referencedHandles()
  while (pending > 0 && Date.now() < deadline) {
    await sleep(20)
    pending = referencedHandles()
  }
  if (pending > 0) process.exit(code)
  process.exitCode = code
  return pending
}
