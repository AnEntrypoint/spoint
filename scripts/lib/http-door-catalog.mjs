function refusal(code, message) {
  const err = new TypeError(`[http-door-catalog] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export function createDoorCatalog(doors) {
  if (!Array.isArray(doors) || doors.length === 0) throw refusal('door-doors-invalid', 'doors must be a non-empty array')
  const rows = doors.map((door, i) => {
    if (!door || typeof door !== 'object') throw refusal('door-entry-invalid', `doors[${i}] must be an object`)
    const { path, method, auth = null, exercised = false, writes = false } = door
    if (typeof path !== 'string' || !path.startsWith('/')) throw refusal('door-path-invalid', `doors[${i}].path must start with /`)
    if (!METHODS.includes(method)) throw refusal('door-method-invalid', `doors[${i}].method must be one of ${METHODS.join(', ')}`)
    if (auth !== null && typeof auth !== 'string') throw refusal('door-auth-invalid', `doors[${i}].auth must be a string or null`)
    if (typeof exercised !== 'boolean' || typeof writes !== 'boolean') throw refusal('door-flags-invalid', `doors[${i}] flags must be booleans`)
    return { path, method, auth, exercised, writes }
  })
  return {
    rows: () => rows.map(row => ({ ...row })),
    unexercised: () => rows.filter(row => !row.exercised).map(row => `${row.method} ${row.path}`),
    verifyNoWrites: () => {
      const violations = rows.filter(row => row.writes && row.exercised).map(row => `${row.method} ${row.path}`)
      return violations.length === 0
        ? { ok: true, reasonCode: null, violations }
        : { ok: false, reasonCode: 'door-write-exercised', violations }
    },
  }
}
