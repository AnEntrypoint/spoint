function refusal(code, message) {
  const err = new TypeError(`[world-identity] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function resolveWorldIdentity({ agentsH1, configName, docsName, appId, worldId } = {}) {
  for (const [key, value] of Object.entries({ agentsH1, configName, docsName, appId, worldId })) {
    if (typeof value !== 'string' || !value.trim()) throw refusal('identity-field-invalid', `${key} must be a non-empty string`)
  }
  const names = [agentsH1.replace(/^#+\s*/, '').trim(), configName.trim(), docsName.trim()]
  const canonical = names[1]
  if (names.some(name => name !== canonical)) {
    return {
      ok: false,
      reasonCode: 'world-identity-mismatch',
      names: { agentsH1: names[0], configName: names[1], docsName: names[2] },
    }
  }
  if (appId === worldId) return { ok: false, reasonCode: 'world-identity-ids-collide', names: null }
  return { ok: true, reasonCode: null, name: canonical, appId, worldId }
}
