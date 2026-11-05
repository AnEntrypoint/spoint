function refusal(code, message) {
  const err = new TypeError(`[private-body] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function redactBody(body, allowlist = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refusal('private-body-invalid', 'body must be a plain object')
  if (!Array.isArray(allowlist) || allowlist.some(key => typeof key !== 'string')) throw refusal('private-allowlist-invalid', 'allowlist must be an array of strings')
  const allowed = new Set(allowlist)
  const keys = Object.keys(body).sort()
  return {
    keys,
    dropped: keys.length,
    allowlistedKeys: keys.filter(key => allowed.has(key)),
  }
}

export function redactRawBodies(entries) {
  if (!Array.isArray(entries)) throw refusal('private-body-invalid', 'entries must be an array')
  return entries.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') throw refusal('private-entry-invalid', `entries[${i}] needs a string path`)
    return { path: entry.path, ...redactBody(entry.body ?? {}, entry.allowlist ?? []) }
  })
}
