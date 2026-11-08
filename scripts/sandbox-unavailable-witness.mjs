import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')
const EVALUATOR = pathToFileURL(path.join(ROOT, 'src/sdk/SESCompartmentEvaluator.js')).href
const APP = 'witness-app'
const SOURCE = 'export default { onTick() { return 1 } }'
const WITHHELD = 'witness withholds the ses package'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }))

if (process.argv.includes('--control')) {
  const { SESCompartmentEvaluator } = await import(EVALUATOR)
  const result = await new SESCompartmentEvaluator().evaluate(SOURCE, APP)
  check('control: with SES present, evaluate returns the app definition', result !== null && result.default.onTick() === 1)
  const failed = checks.filter((c) => !c.ok)
  if (failed.length) {
    console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
    process.exit(1)
  }
  console.log('RESULT: PASS with SES present the same evaluate returns the app definition')
  process.exit(0)
}

let sesAttempts = 0
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'ses') {
      sesAttempts++
      const err = new Error(WITHHELD)
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    return nextResolve(specifier, context)
  },
})

const { SESCompartmentEvaluator, SandboxUnavailableError } = await import(EVALUATOR)
const evaluator = new SESCompartmentEvaluator()

const first = await settle(evaluator.evaluate(SOURCE, APP))
check('withheld ses makes evaluate reject rather than return null', 'error' in first, JSON.stringify(first.value ?? null))
const err = first.error
check('the rejection is a SandboxUnavailableError', err instanceof SandboxUnavailableError)
check('it carries the coded name, code and reasonCode SES_IMPORT_FAILED', err?.name === 'SandboxUnavailableError' && err?.code === 'SANDBOX_UNAVAILABLE' && err?.reasonCode === 'SES_IMPORT_FAILED', `${err?.name} ${err?.code} ${err?.reasonCode}`)
check('it names the app whose source was refused', err?.appName === APP)
check('its message says SES is unavailable and names the app', err?.message.includes(`"${APP}"`) && err?.message.includes('SES is unavailable'), err?.message)
check('its cause is the failed import', err?.cause?.message?.includes(WITHHELD), err?.cause?.message)
check('the import was attempted', sesAttempts > 0, `attempts=${sesAttempts}`)

const attemptsBeforeSecond = sesAttempts
const second = await settle(evaluator.evaluate(SOURCE, APP))
check('a second evaluate rejects with the same SandboxUnavailableError reason', second.error instanceof SandboxUnavailableError && second.error.reasonCode === 'SES_IMPORT_FAILED')
check('the failed settlement is cached: no second import is attempted', sesAttempts === attemptsBeforeSecond, `attempts=${sesAttempts}`)

const blocked = await settle(evaluator.evaluate('export default { onTick() { return eval("1") } }', APP))
check('unavailable SES is reported before the source blocklist runs', blocked.error instanceof SandboxUnavailableError && blocked.error.reasonCode === 'SES_IMPORT_FAILED')

const empty = await settle(evaluator.evaluate('', APP))
check('an empty source still returns null without touching SES', empty.value === null && !('error' in empty), `attempts=${sesAttempts}`)

const control = spawnSync(process.execPath, [SELF, '--control'], { cwd: ROOT, encoding: 'utf8' })
check('the same evaluate with SES present returns the app (control child)', control.status === 0 && control.stdout.includes('check control: with SES present, evaluate returns the app definition: ok'), `exit=${control.status}`)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS SESCompartmentEvaluator.evaluate throws SandboxUnavailableError (code SANDBOX_UNAVAILABLE, reasonCode SES_IMPORT_FAILED, naming the app) when ses cannot be imported, caches that refusal, and returns the app when ses is present')
process.exit(0)
