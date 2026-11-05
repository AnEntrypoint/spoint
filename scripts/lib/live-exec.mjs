function refusal(code, message) {
  const err = new TypeError(`[live-exec] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export const REALMS = Object.freeze(['game', 'browser'])

export function createLiveExec(execute) {
  if (typeof execute !== 'function') throw refusal('exec-hook-invalid', 'execute must be a function')
  return {
    run({ script, realm = 'game', input = null, out = null, module = null, place = null, persist = false, readOnly = true } = {}) {
      if (typeof script !== 'string' || !script) throw refusal('exec-script-invalid', 'script must be a non-empty string')
      if (!REALMS.includes(realm)) throw refusal('exec-realm-invalid', `realm must be one of ${REALMS.join(', ')}`)
      if (persist && readOnly) throw refusal('exec-persist-refused', 'a read-only exec cannot persist')
      if (input !== null && typeof input !== 'object') throw refusal('exec-input-invalid', 'input must be an object or null')
      for (const [key, value] of Object.entries({ out, module, place })) {
        if (value !== null && typeof value !== 'string') throw refusal('exec-option-invalid', `${key} must be a string or null`)
      }
      const result = execute({ script, realm, input, out, module, place, persist, readOnly })
      return { ok: true, readOnly, persist, realm, result }
    },
  }
}
