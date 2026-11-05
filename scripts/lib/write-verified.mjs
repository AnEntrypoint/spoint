function refusal(code, message) {
  const err = new Error(`[write-verified] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function verified(content, expected) {
  return typeof content === 'string' && content.length > 0 && content === expected
}

export async function writeAllVerified(entries, write, read, { maxAttempts = 3 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw refusal('write-empty-batch', 'a write batch needs at least one entry')
  if (typeof write !== 'function' || typeof read !== 'function') throw refusal('write-invalid-hooks', 'write and read must be functions')
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw refusal('write-invalid-attempts', 'maxAttempts must be a positive integer')
  let pending = entries.slice()
  let retried = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await Promise.all(pending.map(entry => write(entry.path, entry.content)))
    const checks = await Promise.all(pending.map(async entry => ({ entry, content: await read(entry.path) })))
    pending = checks.filter(({ entry, content }) => !verified(content, entry.content)).map(({ entry }) => entry)
    if (pending.length === 0) return { written: entries.length, retried, attempts: attempt, failures: [] }
    retried += pending.length
  }
  const failures = pending.map(entry => entry.path)
  throw refusal('write-verification-failed', `${failures.length} output(s) stayed empty or mismatched after ${maxAttempts} attempt(s): ${failures.join(', ')}`)
}
