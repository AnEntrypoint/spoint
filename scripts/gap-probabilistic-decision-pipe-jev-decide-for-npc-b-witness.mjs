import { validateQuestions, normalizeAnswers, sampleAnswer, createDecisionPipe, DecisionPipeError } from '../src/behaviours/decisionPipe.js'

let failures = 0
const expect = (label, ok) => { if (!ok) failures += 1; console.log((ok ? 'ok   ' : 'FAIL ') + label) }
const throwsCode = (fn, code) => { try { fn(); return false } catch (e) { return e instanceof DecisionPipeError && e.code === code } }

const questions = {
  act: { type: 'choice', instructions: 'next', criteria: { buy: 'pays', browse: 'looks', leave: 'walks' } },
  retreat: { type: 'boolean' },
  mood: { type: 'score', criteria: ['sour', 'flat', 'glad'] },
}

expect('valid questions accepted', validateQuestions(questions) === questions)
expect('empty questions refused', throwsCode(() => validateQuestions({}), 'no-questions'))
expect('unknown type refused', throwsCode(() => validateQuestions({ x: { type: 'maybe' } }), 'bad-type'))
expect('choice without criteria refused', throwsCode(() => validateQuestions({ x: { type: 'choice', criteria: {} } }), 'no-criteria'))

const raw = {
  act: { probabilities: { buy: 0.2, browse: 0.3, leave: 0.5 } },
  retreat: { probability: 0.25 },
  mood: { probabilities: { sour: 0.1, flat: 0.1, glad: 0.8 } },
}
const normalized = normalizeAnswers(raw, questions)
expect('normalized choice keeps option order', normalized.act.options.join() === 'buy,browse,leave')
expect('malformed probability refused', throwsCode(() => normalizeAnswers({ ...raw, retreat: { probability: 2 } }, questions), 'malformed-answer'))
expect('zero-mass choice refused', throwsCode(() => normalizeAnswers({ ...raw, act: { probabilities: { buy: 0, browse: 0, leave: 0 } } }, questions), 'malformed-answer'))

expect('roll inside first band picks first option', sampleAnswer(normalized.act, 0.05) === 'buy')
expect('roll at top of range never argmax-clones to the top answer', sampleAnswer(normalized.act, 0.999) === 'leave')
expect('roll 0.4 picks middle band', sampleAnswer(normalized.act, 0.4) === 'browse')
expect('boolean below probability is true', sampleAnswer(normalized.retreat, 0.1) === true)
expect('boolean above probability is false', sampleAnswer(normalized.retreat, 0.9) === false)
expect('score roll near 1 picks last step', sampleAnswer(normalized.mood, 0.99) === 'glad')

let seed = 7
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
const counts = { buy: 0, browse: 0, leave: 0 }
for (let i = 0; i < 6000; i += 1) counts[sampleAnswer(normalized.act, random())] += 1
expect('sampled frequencies track probabilities within 3 points', Math.abs(counts.leave / 6000 - 0.5) < 0.03 && Math.abs(counts.buy / 6000 - 0.2) < 0.03)

const decide = createDecisionPipe({ ask: async () => raw, random: () => 0.05 })
const good = await decide({ state: {}, questions })
expect('decide returns ok with sampled answers', good.ok === true && good.data.answers.act === 'buy' && good.data.answers.retreat === true)

const failing = createDecisionPipe({ ask: async () => { throw new Error('offline') }, random: () => 0.5 })
const failed = await failing({ state: {}, questions })
expect('failed ask answers ok:false with ask-failed', failed.ok === false && failed.error.code === 'ask-failed')

const bad = createDecisionPipe({ ask: async () => ({ act: 'buy' }), random: () => 0.5 })
const badAns = await bad({ state: {}, questions })
expect('malformed answer answers ok:false', badAns.ok === false && badAns.error.code === 'malformed-answer')

const pass = failures === 0
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL (' + failures + ')')
process.exit(pass ? 0 : 1)
