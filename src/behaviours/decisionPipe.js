export class DecisionPipeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'DecisionPipeError'
    this.code = code
  }
}

const QUESTION_TYPES = ['boolean', 'choice', 'score']

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export function validateQuestions(questions) {
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    throw new DecisionPipeError('no-questions', 'questions must be a non-empty object keyed by name')
  }
  for (const [name, q] of Object.entries(questions)) {
    if (!isPlainObject(q) || !QUESTION_TYPES.includes(q.type)) {
      throw new DecisionPipeError('bad-type', `question "${name}" needs type boolean, choice or score`)
    }
    if (q.type === 'choice' && (!isPlainObject(q.criteria) || Object.keys(q.criteria).length === 0)) {
      throw new DecisionPipeError('no-criteria', `choice question "${name}" needs criteria keyed by option`)
    }
    if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length === 0)) {
      throw new DecisionPipeError('no-criteria', `score question "${name}" needs ordered criteria steps`)
    }
  }
  return questions
}

const sumProbabilities = (probabilities) => Object.values(probabilities).reduce((acc, p) => acc + p, 0)

export function normalizeAnswers(raw, questions) {
  const answers = isPlainObject(raw) ? raw : null
  if (!answers) throw new DecisionPipeError('malformed-answer', 'answers must be an object')
  const out = {}
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name]
    if (q.type === 'boolean') {
      if (!isPlainObject(a) || typeof a.probability !== 'number' || !(a.probability >= 0 && a.probability <= 1)) {
        throw new DecisionPipeError('malformed-answer', `boolean answer "${name}" needs probability in [0,1]`)
      }
      out[name] = a
    } else if (q.type === 'choice') {
      const options = Object.keys(q.criteria)
      const probs = isPlainObject(a?.probabilities) ? a.probabilities : null
      if (!probs || options.some((o) => typeof probs[o] !== 'number' || !(probs[o] >= 0))) {
        throw new DecisionPipeError('malformed-answer', `choice answer "${name}" needs a non-negative probability per option`)
      }
      if (!(sumProbabilities(probs) > 0)) {
        throw new DecisionPipeError('malformed-answer', `choice answer "${name}" has no probability mass`)
      }
      out[name] = { options, probabilities: Object.fromEntries(options.map((o) => [o, probs[o]])) }
    } else {
      const steps = q.criteria
      const probs = isPlainObject(a?.probabilities) ? a.probabilities : null
      if (!probs || !Array.isArray(steps) || steps.some((s) => typeof probs[s] !== 'number' || !(probs[s] >= 0))) {
        throw new DecisionPipeError('malformed-answer', `score answer "${name}" needs a non-negative probability per step`)
      }
      if (!(sumProbabilities(probs) > 0)) {
        throw new DecisionPipeError('malformed-answer', `score answer "${name}" has no probability mass`)
      }
      out[name] = { options: steps, probabilities: Object.fromEntries(steps.map((s) => [s, probs[s]])) }
    }
  }
  return out
}

export function sampleAnswer(answer, roll) {
  if (typeof answer.probability === 'number') return roll < answer.probability
  const total = sumProbabilities(answer.probabilities)
  let cursor = roll * total
  for (const option of answer.options) {
    cursor -= answer.probabilities[option]
    if (cursor < 0) return option
  }
  return answer.options[answer.options.length - 1]
}

export function createDecisionPipe({ ask, random }) {
  if (typeof ask !== 'function') throw new DecisionPipeError('no-backend', 'ask must be a function')
  if (typeof random !== 'function') throw new DecisionPipeError('no-random', 'random must be a function')
  return async function decide({ state, questions }) {
    validateQuestions(questions)
    let raw
    try {
      raw = await ask({ state, questions })
    } catch (err) {
      return { ok: false, error: { code: 'ask-failed', message: String(err?.message ?? err) } }
    }
    let normalized
    try {
      normalized = normalizeAnswers(raw, questions)
    } catch (err) {
      return { ok: false, error: { code: err.code ?? 'malformed-answer', message: err.message } }
    }
    const sampled = {}
    for (const [name, answer] of Object.entries(normalized)) sampled[name] = sampleAnswer(answer, random())
    return { ok: true, data: { answers: sampled, probabilities: normalized } }
  }
}
