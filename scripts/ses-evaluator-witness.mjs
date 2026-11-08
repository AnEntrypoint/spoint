import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { SESCompartmentEvaluator } = await import(pathToFileURL(path.join(ROOT, 'src/sdk/SESCompartmentEvaluator.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const BLOCKED = ['process.exit', 'child_process', '__proto__', 'Object.prototype', 'globalThis', 'import(', 'require(', 'eval(', 'Function(', 'WebAssembly.', 'new Worker']
const evaluator = new SESCompartmentEvaluator()

const realError = console.error
console.error = () => {}
const blocked = BLOCKED.map((pattern) => [pattern, evaluator._validate(`export default { run() { return ${pattern} } }`, 'probe')])
console.error = realError
for (const [pattern, accepted] of blocked) check(`source containing "${pattern}" is refused by the blocklist`, accepted === false)

check('ordinary app source passes the blocklist', evaluator._validate('export default { onTick(ctx) { return ctx.state.count + 1 } }', 'probe') === true)

check('the default per-tick step cap is one million', evaluator._maxStepsPerTick === 1000000 && evaluator._buildEndowments().__sandboxMaxSteps === 1000000)

const capped = new SESCompartmentEvaluator({ maxStepsPerTick: 3 })
const endowments = capped._buildEndowments()
check('the endowment starts its step count at zero under the configured cap', endowments.__sandboxSteps === 0 && endowments.__sandboxMaxSteps === 3)
let threw = null
for (let i = 0; i < 3; i++) endowments.__checkBudget()
try { endowments.__checkBudget() } catch (e) { threw = e }
check('the step after the cap throws the CPU budget error', threw !== null && threw.message === '[Sandbox] CPU budget exceeded', threw ? threw.message : 'no throw')
check('the step count reached the cap plus one at the refusal', endowments.__sandboxSteps === 4)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS SESCompartmentEvaluator refuses each blocked source pattern, passes ordinary app source, and its step endowment throws the CPU budget error after the configured cap')
process.exit(0)
