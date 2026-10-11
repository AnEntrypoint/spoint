import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE = process.env.COMPONENT_SCHEMA_MODULE
  ? resolve(process.env.COMPONENT_SCHEMA_MODULE)
  : resolve(REPO, 'src/protocol/ComponentSchema.js')

let total = 0
let failed = 0

function expect(claim, got, want) {
  total++
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${claim}`)
  if (!ok) console.log(`     want ${want}\n     got  ${got}`)
}

function thrownOf(fn) {
  try {
    fn()
  } catch (err) {
    return `${err.constructor.name}: ${err.message}`
  }
  return 'no throw'
}

const bytesOf = (u8) => Array.from(u8).join(',')
const json = (value) => JSON.stringify(value)
const zeros = (n) => Array(n).fill(0).join(',')
const NAME_ERROR = 'TypeError: [ComponentSchema] registerComponentSchema: name must be a non-empty string'

const NUMERIC = {
  hp: { type: 'u16' },
  alive: { type: 'bool' },
  team: { type: 'enum', enum: ['red', 'blue', 'none'] },
  lvl: { type: 'u8' },
  speed: { type: 'f32' },
  pos: { type: 'f64' },
  dx: { type: 'i16' },
}
const MIXED = {
  label: { type: 'string' },
  team: { type: 'enum', enum: ['red', 'blue', 'none'] },
  hp: { type: 'u16' },
}
const LONG = { s: { type: 'string' } }
const FULL = { hp: 300, alive: true, team: 'blue', lvl: 7, speed: 2.5, pos: 1234.5678, dx: -42 }
const NO_POS = { hp: 300, alive: true, team: 'blue', lvl: 7, speed: 2.5, dx: -42 }

function runClaims(mod) {
  const {
    FIELD_TYPES, validateSchema, defineComponentSchema, registerComponentSchema,
    getComponentSchema, hasComponentSchema, encodeCustomFields, decodeCustomFields,
  } = mod
  const defaults = mod.default
  const one = (schema, value) => decodeCustomFields(schema, encodeCustomFields(schema, value))

  expect('FIELD_TYPES lists the eight wire types in declaration order',
    Object.keys(FIELD_TYPES).join(','), 'u8,u16,i16,f32,f64,bool,string,enum')
  expect('FIELD_TYPES maps every name to itself',
    Object.entries(FIELD_TYPES).every(([key, value]) => key === value), true)
  expect('FIELD_TYPES is frozen', Object.isFrozen(FIELD_TYPES), true)
  expect('default export carries the same functions and table',
    defaults.encodeCustomFields === encodeCustomFields && defaults.decodeCustomFields === decodeCustomFields
      && defaults.validateSchema === validateSchema && defaults.defineComponentSchema === defineComponentSchema
      && defaults.FIELD_TYPES === FIELD_TYPES, true)

  expect('validateSchema returns the same object for a valid schema', validateSchema(NUMERIC) === NUMERIC, true)
  expect('validateSchema accepts an empty schema', thrownOf(() => validateSchema({})), 'no throw')
  expect('validateSchema rejects null', thrownOf(() => validateSchema(null)),
    'TypeError: [ComponentSchema] schema must be an object')
  expect('validateSchema rejects a non-object', thrownOf(() => validateSchema(5)),
    'TypeError: [ComponentSchema] schema must be an object')
  expect('validateSchema rejects a null field', thrownOf(() => validateSchema({ x: null })),
    'TypeError: [ComponentSchema] field "x" must be an object')
  expect('validateSchema rejects an unknown type', thrownOf(() => validateSchema({ x: { type: 'u9' } })),
    'TypeError: [ComponentSchema] field "x" has unknown type: u9')
  expect('validateSchema rejects the type constructor', thrownOf(() => validateSchema({ x: { type: 'constructor' } })),
    'TypeError: [ComponentSchema] field "x" has unknown type: constructor')
  expect('validateSchema rejects the type toString', thrownOf(() => validateSchema({ x: { type: 'toString' } })),
    'TypeError: [ComponentSchema] field "x" has unknown type: toString')
  expect('validateSchema rejects the type __proto__', thrownOf(() => validateSchema({ x: { type: '__proto__' } })),
    'TypeError: [ComponentSchema] field "x" has unknown type: __proto__')
  expect('validateSchema rejects the type hasOwnProperty', thrownOf(() => validateSchema({ x: { type: 'hasOwnProperty' } })),
    'TypeError: [ComponentSchema] field "x" has unknown type: hasOwnProperty')
  expect('validateSchema rejects an enum with no list', thrownOf(() => validateSchema({ e: { type: 'enum' } })),
    'TypeError: [ComponentSchema] enum field "e" needs a non-empty enum: string[]')
  expect('validateSchema rejects an empty enum list', thrownOf(() => validateSchema({ e: { type: 'enum', enum: [] } })),
    'TypeError: [ComponentSchema] enum field "e" needs a non-empty enum: string[]')
  expect('validateSchema rejects 257 enum values',
    thrownOf(() => validateSchema({ e: { type: 'enum', enum: Array.from({ length: 257 }, (_, i) => `v${i}`) } })),
    'TypeError: [ComponentSchema] enum field "e" exceeds 256 values (1-byte index)')
  expect('validateSchema accepts exactly 256 enum values',
    thrownOf(() => validateSchema({ e: { type: 'enum', enum: Array.from({ length: 256 }, (_, i) => `v${i}`) } })),
    'no throw')
  expect('validateSchema rejects a tier other than full or reduced',
    thrownOf(() => validateSchema({ a: { type: 'u8', tier: 'bogus' } })),
    "TypeError: [ComponentSchema] field \"a\" tier must be 'full' or 'reduced'")
  expect('validateSchema accepts tier full, reduced, null and absent',
    ['full', 'reduced', null, undefined].map((tier) => thrownOf(() => validateSchema({ a: { type: 'u8', tier } }))).join('|'),
    'no throw|no throw|no throw|no throw')

  const raw = { v: { type: 'u8' } }
  expect('defineComponentSchema returns the same object', defineComponentSchema(raw) === raw, true)
  expect('defineComponentSchema freezes the schema it returns', Object.isFrozen(raw), true)
  expect('defineComponentSchema rejects an invalid schema like validateSchema',
    thrownOf(() => defineComponentSchema({ x: { type: 'u9' } })),
    'TypeError: [ComponentSchema] field "x" has unknown type: u9')
  expect('defineComponentSchema rejects the type constructor like validateSchema',
    thrownOf(() => defineComponentSchema({ x: { type: 'constructor' } })),
    'TypeError: [ComponentSchema] field "x" has unknown type: constructor')

  const REG_A = { v: { type: 'u8' } }
  const REG_B = { v: { type: 'u16' } }
  expect('an unregistered name is not present', hasComponentSchema('witness.absent'), false)
  expect('getComponentSchema returns null for an unregistered name', getComponentSchema('witness.absent'), null)
  expect('registerComponentSchema returns the schema it stored',
    registerComponentSchema('witness.reg', REG_A) === REG_A, true)
  expect('getComponentSchema returns the registered object', getComponentSchema('witness.reg') === REG_A, true)
  expect('hasComponentSchema is true after registration', hasComponentSchema('witness.reg'), true)
  registerComponentSchema('witness.reg', REG_B)
  expect('registering the same name again replaces the schema', getComponentSchema('witness.reg') === REG_B, true)
  expect('registerComponentSchema rejects an empty name',
    thrownOf(() => registerComponentSchema('', REG_A)), NAME_ERROR)
  expect('registerComponentSchema rejects a non-string name',
    thrownOf(() => registerComponentSchema(7, REG_A)), NAME_ERROR)
  expect('a schema that fails validation is not registered',
    `${thrownOf(() => registerComponentSchema('witness.bad', { x: { type: 'u9' } }))}|${hasComponentSchema('witness.bad')}`,
    'TypeError: [ComponentSchema] field "x" has unknown type: u9|false')
  expect('a schema naming the type toString is rejected and not registered',
    `${thrownOf(() => registerComponentSchema('witness.proto', { x: { type: 'toString' } }))}|${hasComponentSchema('witness.proto')}`,
    'TypeError: [ComponentSchema] field "x" has unknown type: toString|false')
  expect('a schema fetched from the registry encodes and decodes',
    json(one(getComponentSchema('witness.reg'), { v: 513 })), '{"v":513}')

  const fullBytes = encodeCustomFields(NUMERIC, FULL)
  expect('a schema without strings encodes to one presence byte plus the value size per field',
    fullBytes.length, 26)
  expect('exact wire bytes with pos absent: presence flags, little-endian values, zero-filled absent slot',
    bytesOf(encodeCustomFields(NUMERIC, NO_POS)),
    [1, 44, 1, 1, 1, 1, 1, 1, 7, 1, 0, 0, 32, 64, ...Array(9).fill(0), 1, 214, 255].join(','))
  expect('full round trip keeps every field in schema order',
    json(decodeCustomFields(NUMERIC, fullBytes)), json(FULL))
  expect('round trip with pos absent omits that key',
    json(decodeCustomFields(NUMERIC, encodeCustomFields(NUMERIC, NO_POS))), json(NO_POS))
  expect('an empty object encodes as zero bytes for every field',
    bytesOf(encodeCustomFields(NUMERIC, {})), zeros(26))
  expect('null encodes the same as an empty object',
    bytesOf(encodeCustomFields(NUMERIC, null)), bytesOf(encodeCustomFields(NUMERIC, {})))
  expect('decoding all-absent bytes yields an empty object',
    json(decodeCustomFields(NUMERIC, encodeCustomFields(NUMERIC, {}))), '{}')
  expect('an undefined value is treated as absent',
    bytesOf(encodeCustomFields(NUMERIC, { hp: undefined })), bytesOf(encodeCustomFields(NUMERIC, {})))
  expect('keys outside the schema are ignored',
    bytesOf(encodeCustomFields(NUMERIC, { hp: 1, nope: 9 })), bytesOf(encodeCustomFields(NUMERIC, { hp: 1 })))
  expect('a false bool is a present field, not an absent one',
    json(one(NUMERIC, { alive: false })), '{"alive":false}')
  expect('encoding is deterministic', bytesOf(encodeCustomFields(NUMERIC, FULL)), bytesOf(fullBytes))
  expect('an empty schema encodes to zero bytes and decodes to an empty object',
    `${encodeCustomFields({}, {}).length}|${json(decodeCustomFields({}, new Uint8Array(0)))}`, '0|{}')

  expect('u8 clamps values above 255', one(NUMERIC, { lvl: 300 }).lvl, 255)
  expect('u8 clamps values below 0', one(NUMERIC, { lvl: -4 }).lvl, 0)
  expect('u8 rounds 7.6 to 8', one(NUMERIC, { lvl: 7.6 }).lvl, 8)
  expect('u8 rounds 7.4 to 7', one(NUMERIC, { lvl: 7.4 }).lvl, 7)
  expect('u16 clamps values above 65535', one(NUMERIC, { hp: 70000 }).hp, 65535)
  expect('u16 clamps values below 0', one(NUMERIC, { hp: -1 }).hp, 0)
  expect('i16 clamps values below -32768', one(NUMERIC, { dx: -40000 }).dx, -32768)
  expect('i16 clamps values above 32767', one(NUMERIC, { dx: 40000 }).dx, 32767)
  expect('f32 stores the single-precision value', one(NUMERIC, { speed: 0.1 }).speed, Math.fround(0.1))
  expect('f64 keeps the double-precision value exactly',
    one(NUMERIC, { pos: -0.000123456789 }).pos, -0.000123456789)
  expect('every enum value round-trips',
    ['red', 'blue', 'none'].map((team) => one(NUMERIC, { team }).team).join(','), 'red,blue,none')
  expect('an enum value outside the declared list is refused at the producer',
    thrownOf(() => encodeCustomFields(NUMERIC, { team: 'nope' })),
    'RangeError: [ComponentSchema] field "team" of type enum is nope, outside [red, blue, none]')
  expect('a non-finite u8 is refused at the producer',
    thrownOf(() => encodeCustomFields(NUMERIC, { lvl: NaN })),
    'RangeError: [ComponentSchema] field "lvl" is not a finite number (got number NaN)')
  expect('an infinite u16 is refused at the producer',
    thrownOf(() => encodeCustomFields(NUMERIC, { hp: Infinity })),
    'RangeError: [ComponentSchema] field "hp" is not a finite number (got number Infinity)')
  expect('a non-finite i16 is refused at the producer',
    thrownOf(() => encodeCustomFields(NUMERIC, { dx: NaN })),
    'RangeError: [ComponentSchema] field "dx" is not a finite number (got number NaN)')
  expect('a non-finite f32 is refused at the producer',
    thrownOf(() => encodeCustomFields(NUMERIC, { speed: NaN })),
    'RangeError: [ComponentSchema] field "speed" is not a finite number (got number NaN)')
  expect('a non-finite f64 is refused at the producer, so the encoder never emits bytes its own decoder refuses',
    thrownOf(() => encodeCustomFields(NUMERIC, { pos: -Infinity })),
    'RangeError: [ComponentSchema] field "pos" is not a finite number (got number -Infinity)')
  expect('a non-finite numeric field is refused on the string-bearing encode path too',
    thrownOf(() => encodeCustomFields(MIXED, { label: 'a', hp: NaN })),
    'RangeError: [ComponentSchema] field "hp" is not a finite number (got number NaN)')
  expect('a string in a numeric field is refused at the producer',
    thrownOf(() => encodeCustomFields(NUMERIC, { hp: '5' })),
    'RangeError: [ComponentSchema] field "hp" is not a finite number (got string 5)')

  const padded = new Uint8Array(fullBytes.length + 3)
  padded.set([9, 9, 9])
  padded.set(fullBytes, 3)
  expect('decode accepts a Uint8Array view with a nonzero byteOffset',
    json(decodeCustomFields(NUMERIC, padded.subarray(3))), json(FULL))
  expect('decode accepts a raw ArrayBuffer', json(decodeCustomFields(NUMERIC, fullBytes.buffer)), json(FULL))

  const mixedFull = { label: 'Zoë ✓', team: 'red', hp: 5 }
  const mixedBytes = encodeCustomFields(MIXED, mixedFull)
  expect('string field bytes: presence flag, u16 length counted in UTF-8 bytes, then the UTF-8 bytes',
    bytesOf(mixedBytes), '1,8,0,90,111,195,171,32,226,156,147,1,0,1,5,0')
  expect('string field round trip with multi-byte UTF-8',
    json(decodeCustomFields(MIXED, mixedBytes)), json(mixedFull))
  expect('an absent string writes one zero byte',
    bytesOf(encodeCustomFields(MIXED, { team: 'blue', hp: 5 })), '0,1,1,1,5,0')
  expect('a schema with an absent string round-trips its present fields',
    json(one(MIXED, { team: 'blue', hp: 5 })), '{"team":"blue","hp":5}')
  const longBytes = encodeCustomFields(LONG, { s: 'a'.repeat(70000) })
  expect('a string over 65535 bytes writes the length header as 65535',
    bytesOf(longBytes.subarray(0, 3)), '1,255,255')
  expect('a string over 65535 bytes is stored as its first 65535 bytes',
    decodeCustomFields(LONG, longBytes).s.length, 65535)
  expect('encoding an unknown field type throws',
    thrownOf(() => encodeCustomFields({ x: { type: 'u9' } }, { x: 1 })),
    'TypeError: [ComponentSchema] unknown field type: u9')

  const NAME_HP_LVL = { name: { type: 'string' }, hp: { type: 'u16' }, lvl: { type: 'u8' } }
  const HP_THEN_NAME = { hp: { type: 'u16' }, name: { type: 'string' } }
  const tryJson = (schema, value) => {
    try {
      return json(one(schema, value))
    } catch (err) {
      return `${err.constructor.name}: ${err.message}`
    }
  }
  const presencePatternsRoundTrip = (schema, values) => {
    const keys = Object.keys(schema)
    const patterns = Array.from({ length: 2 ** keys.length }, (_, mask) => {
      const obj = {}
      keys.forEach((key, bit) => { if (mask & (1 << bit)) obj[key] = values[key] })
      return obj
    })
    return `${patterns.filter((obj) => tryJson(schema, obj) === json(obj)).length} of ${patterns.length}`
  }

  expect('mixed schema {name: string, hp: u16, lvl: u8} with hp absent decodes to {name, lvl}',
    tryJson(NAME_HP_LVL, { name: 'x', lvl: 5 }), '{"name":"x","lvl":5}')
  expect('the same mixed schema with hp absent writes hp as its presence byte plus two zero bytes',
    bytesOf(encodeCustomFields(NAME_HP_LVL, { name: 'x', lvl: 5 })), '1,1,0,120,0,0,0,1,5')
  expect('an all-absent mixed schema writes each absent non-string field at its full width',
    bytesOf(encodeCustomFields(NAME_HP_LVL, {})), zeros(6))
  expect('an all-absent mixed schema decodes to an empty object',
    tryJson(NAME_HP_LVL, {}), '{}')
  expect('an absent u16 before a string does not hide the string',
    tryJson(HP_THEN_NAME, { name: 'x' }), '{"name":"x"}')
  expect('an absent u16 at the end of a mixed schema writes its presence byte plus two zero bytes',
    bytesOf(encodeCustomFields(MIXED, { label: 'a', team: 'red' })), '1,1,0,97,1,0,0,0,0')
  expect('an absent enum between a string and a u16 writes its presence byte plus one zero byte',
    bytesOf(encodeCustomFields(MIXED, { label: 'a', hp: 5 })), '1,1,0,97,0,0,1,5,0')
  expect('every presence pattern of {name: string, hp: u16, lvl: u8} round-trips its present fields',
    presencePatternsRoundTrip(NAME_HP_LVL, { name: 'Zoë ✓', hp: 300, lvl: 7 }), '8 of 8')
  expect('every presence pattern of the MIXED schema round-trips its present fields',
    presencePatternsRoundTrip(MIXED, mixedFull), '8 of 8')
}

let mod = null
try {
  mod = await import(pathToFileURL(MODULE).href)
} catch (err) {
  console.log(`module: ${MODULE}`)
  console.log(`FAIL import: ${err.message}`)
  console.log('RESULT: FAIL -- module did not load')
  process.exitCode = 1
}

if (mod) {
  console.log(`module: ${MODULE}`)
  try {
    runClaims(mod)
  } catch (err) {
    total++
    failed++
    console.log(`FAIL uncaught: ${err.message}`)
  }
  console.log(failed === 0
    ? `RESULT: PASS -- ${total} of ${total} claims`
    : `RESULT: FAIL -- ${failed} of ${total} claims failed`)
  process.exitCode = failed === 0 ? 0 : 1
}
