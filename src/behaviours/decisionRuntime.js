import { createDecisionPipe } from './decisionPipe.js'

function refusal(code, message) {
  const err = new TypeError(`[decision-runtime] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function createDecisionRuntime({ ask, random, now, hasPlayers = () => true, periodMs = 1000, maxEntities = 128 } = {}) {
  if (typeof ask !== 'function' || typeof random !== 'function' || typeof now !== 'function') throw refusal('runtime-hooks-invalid', 'ask, random and now must be functions')
  if (!Number.isFinite(periodMs) || periodMs <= 0) throw refusal('runtime-period-invalid', 'periodMs must be a positive finite number')
  if (!Number.isInteger(maxEntities) || maxEntities < 1) throw refusal('runtime-cap-invalid', 'maxEntities must be a positive integer')
  const decide = createDecisionPipe({ ask, random })
  const entries = new Map()

  return {
    register(entityId, { questions, state = null, onDecision = null } = {}) {
      if (typeof entityId !== 'string' || !entityId) throw refusal('runtime-entity-invalid', 'entityId must be a non-empty string')
      if (!questions || typeof questions !== 'object') throw refusal('runtime-questions-invalid', 'questions must be an object')
      if (entries.has(entityId)) throw refusal('runtime-duplicate', `entity ${entityId} is already registered`)
      if (entries.size >= maxEntities) throw refusal('runtime-cap-reached', `at most ${maxEntities} entities can be registered`)
      if (onDecision !== null && typeof onDecision !== 'function') throw refusal('runtime-callback-invalid', 'onDecision must be a function or null')
      const at = now()
      if (!Number.isFinite(at)) throw refusal('runtime-clock-invalid', 'now() must return a finite number')
      entries.set(entityId, { entityId, questions, state, onDecision, nextAt: at })
      return { ok: true, entityId, nextAt: at }
    },
    async tick() {
      const at = now()
      if (!Number.isFinite(at)) throw refusal('runtime-clock-invalid', 'now() must return a finite number')
      if (!hasPlayers()) return { ran: 0, skipped: 'no-players', decisions: [] }
      const due = [...entries.values()].filter(entry => at >= entry.nextAt)
      const decisions = []
      for (const entry of due) {
        entry.nextAt = at + periodMs
        let result
        try {
          result = await decide({ state: entry.state, questions: entry.questions })
        } catch (err) {
          result = { ok: false, error: { code: err?.code ?? err?.reasonCode ?? 'decide-failed', message: String(err?.message ?? err) } }
        }
        decisions.push({ entityId: entry.entityId, at, ...result })
        if (entry.onDecision) entry.onDecision(decisions[decisions.length - 1])
      }
      return { ran: due.length, skipped: null, decisions }
    },
    unregister(entityId) {
      if (!entries.delete(entityId)) throw refusal('runtime-unknown-entity', `entity ${entityId} is not registered`)
      return { ok: true, entityId }
    },
    size() { return entries.size },
  }
}
