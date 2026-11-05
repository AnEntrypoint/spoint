function refusal(code, message) {
  const err = new TypeError(`[cli-help] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function createHelpRegistry(verbs) {
  if (!Array.isArray(verbs) || verbs.length === 0) throw refusal('cli-verbs-invalid', 'verbs must be a non-empty array')
  const byName = new Map()
  const bodies = new Set()
  for (const [i, verb] of verbs.entries()) {
    if (!verb || typeof verb !== 'object' || typeof verb.name !== 'string' || !verb.name) throw refusal('cli-verb-invalid', `verbs[${i}] needs a name`)
    if (typeof verb.help !== 'string' || !verb.help.trim()) throw refusal('cli-help-invalid', `verb ${verb.name} needs help text`)
    if (byName.has(verb.name)) throw refusal('cli-duplicate', `verb ${verb.name} is declared twice`)
    if (bodies.has(verb.help)) throw refusal('cli-help-duplicate', `verb ${verb.name} repeats another verb's help`)
    byName.set(verb.name, verb.help)
    bodies.add(verb.help)
  }
  return Object.freeze({
    names: () => [...byName.keys()],
    help: (name) => {
      const body = byName.get(name)
      if (!body) return { ok: false, reasonCode: 'cli-unknown-verb', name }
      return { ok: true, exitCode: 0, name, body }
    },
    verify: () => ({ ok: true, count: byName.size, distinct: bodies.size }),
  })
}
