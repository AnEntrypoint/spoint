function refusal(code, message) {
  const err = new TypeError(`[source-ledger] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function createSourceLedger(records = []) {
  if (!Array.isArray(records)) throw refusal('ledger-records-invalid', 'records must be an array')
  const rows = []
  const seen = new Set()
  let cursor = ''
  const append = ({ id, at, url }) => {
    if (typeof id !== 'string' || !id) throw refusal('ledger-id-invalid', 'id must be a non-empty string')
    if (typeof at !== 'string' || !at) throw refusal('ledger-at-invalid', 'at must be a non-empty string')
    if (typeof url !== 'string' || !url) throw refusal('ledger-url-invalid', 'url must be a non-empty string')
    const key = `${id}\u0000${at}`
    if (seen.has(key)) throw refusal('ledger-duplicate', `${id} at ${at} is already recorded`)
    if (at <= cursor) throw refusal('ledger-cursor-invalid', `at ${at} must be newer than ${cursor}`)
    seen.add(key)
    cursor = at
    rows.push({ id, at, url })
    return rows.length
  }
  for (const record of records) append(record)
  return {
    append,
    cursor: () => cursor,
    size: () => rows.length,
    rows: () => rows.map(row => ({ ...row })),
    toJSONL: () => rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''),
  }
}

export function fromJSONL(text) {
  if (typeof text !== 'string') throw refusal('ledger-text-invalid', 'text must be a string')
  const records = []
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { throw refusal('ledger-line-invalid', `line ${i + 1} is not JSON`) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw refusal('ledger-line-invalid', `line ${i + 1} is not an object`)
    records.push(parsed)
  }
  return createSourceLedger(records)
}
