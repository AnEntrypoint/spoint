import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { quantizeInput, createInputSchema, DEFAULT_INPUT_SCHEMA, INPUT_CASE } = await import(pathToFileURL(path.join(ROOT, 'src/protocol/InputCodec.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const HALF_PI = Math.PI / 2
const TAU = 2 * Math.PI
const PITCH_STEP = HALF_PI / 32767
const YAW_STEP = TAU / 65536
const schema = DEFAULT_INPUT_SCHEMA
const base = { forward: true, yaw: 0, pitch: 0, expr: 0 }
const run = (input) => { const cases = []; const data = quantizeInput(schema, { ...base, ...input }, cases); return { data, cases } }
const codes = (cases) => cases.map((c) => c.code)

const high = run({ pitch: 2 })
check('a pitch above +HALF_PI is clamped to HALF_PI', Math.abs(high.data.pitch - HALF_PI) <= PITCH_STEP, `pitch=${high.data.pitch}`)
check('the pitch clamp is reported with input_field_clamped and the bounds', high.cases.length === 1 && high.cases[0].code === INPUT_CASE.CLAMPED && high.cases[0].field === 'pitch' && high.cases[0].hi === HALF_PI, codes(high.cases).join(','))
const low = run({ pitch: -2 })
check('a pitch below -HALF_PI is clamped to -HALF_PI', Math.abs(low.data.pitch + HALF_PI) <= PITCH_STEP, `pitch=${low.data.pitch}`)

const mid = run({ pitch: 0.5 })
check('an in-range pitch round-trips within one pitch step and reports nothing', Math.abs(mid.data.pitch - 0.5) <= PITCH_STEP && mid.cases.length === 0, `pitch=${mid.data.pitch}`)

const negYaw = run({ yaw: -0.1 })
check('a negative yaw is wrapped into [0, TAU) and reported with input_field_wrapped', Math.abs(negYaw.data.yaw - (TAU - 0.1)) <= YAW_STEP && negYaw.cases.length === 1 && negYaw.cases[0].code === INPUT_CASE.WRAPPED, `yaw=${negYaw.data.yaw} cases=${codes(negYaw.cases)}`)
const overYaw = run({ yaw: TAU + 0.1 })
check('a yaw past TAU wraps to its remainder and is reported', Math.abs(overYaw.data.yaw - 0.1) <= YAW_STEP && overYaw.cases[0].code === INPUT_CASE.WRAPPED, `yaw=${overYaw.data.yaw}`)
const inYaw = run({ yaw: 1.0 })
check('an in-range yaw reports no case', inYaw.cases.length === 0 && Math.abs(inYaw.data.yaw - 1.0) <= YAW_STEP)

const expr = run({ expr: 300 })
check('an expr above 255 is clamped to 255 and reported', expr.data.expr === 255 && expr.cases[0].code === INPUT_CASE.CLAMPED && expr.cases[0].field === 'expr', `expr=${expr.data.expr}`)

const analog = run({ analogForward: 2, analogRight: -3 })
check('analog axes clamp to [-1, 1] and report both fields', analog.data.analogForward === 1 && analog.data.analogRight === -1 && codes(analog.cases).filter((c) => c === INPUT_CASE.CLAMPED).length === 2, `aF=${analog.data.analogForward} aR=${analog.data.analogRight}`)
const analogIn = run({ analogForward: 0.5 })
check('an in-range analog value round-trips within one 1/127 step', Math.abs(analogIn.data.analogForward - 0.5) <= 1 / 127 && analogIn.cases.length === 0)

const buttons = run({ forward: true, jump: true })
check('buttons quantize to booleans in the schema button order', buttons.data.forward === true && buttons.data.jump === true && buttons.data.backward === false && buttons.data.sprint === false)

let threw = null
try { quantizeInput(schema, { ...base, yaw: NaN }) } catch (e) { threw = e }
check('a non-finite yaw throws a RangeError with the not-finite code', threw instanceof RangeError && /input record field "yaw" is not a finite number/.test(threw.message), threw ? threw.message : 'no throw')

const withAxis = createInputSchema({ inputAxes: ['throttle'] })
const axisCases = []
const axisData = quantizeInput(withAxis, { ...base, throttle: 0.75 }, axisCases)
check('a declared extra axis is stored as a finite f32 and round-trips', Math.abs(axisData.throttle - 0.75) < 1e-6 && axisCases.length === 0, `throttle=${axisData.throttle}`)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS quantizeInput clamps pitch and analog axes and expr with input_field_clamped, wraps yaw with input_field_wrapped, round-trips in-range values within one step, and refuses non-finite fields')
process.exit(0)
