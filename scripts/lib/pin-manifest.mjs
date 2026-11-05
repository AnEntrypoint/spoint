function refusal(code, message) {
  const err = new TypeError(`[pin-manifest] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function readPin(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw refusal('pin-record-invalid', 'record must be an object')
  const { version, sha256 } = record
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw refusal('pin-version-invalid', 'version must be a semver string')
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw refusal('pin-sha-invalid', 'sha256 must be a lowercase 64-hex digest')
  return Object.freeze({ version, sha256 })
}

export function verifyPin(record, actual) {
  const pin = readPin(record)
  const observed = readPin(actual)
  if (pin.version === observed.version && pin.sha256 !== observed.sha256) {
    return { ok: false, reasonCode: 'pin-sha-changed-under-same-version', version: pin.version }
  }
  if (pin.sha256 !== observed.sha256) return { ok: false, reasonCode: 'pin-sha-mismatch', version: pin.version }
  if (pin.version !== observed.version) return { ok: false, reasonCode: 'pin-version-mismatch', version: pin.version }
  return { ok: true, reasonCode: null, version: pin.version }
}
