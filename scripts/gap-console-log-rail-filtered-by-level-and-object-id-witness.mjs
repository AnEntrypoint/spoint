import { createConsoleRail, CONSOLE_LEVELS } from './lib/console-rail.mjs'

let failures = 0
function expect(name, ok, detail = '') {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures += 1
    console.log(`FAIL ${name} ${detail}`)
  }
}

function throwsWith(fn, ErrorType) {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof ErrorType
  }
}

const rail = createConsoleRail({ capacity: 5 })
rail.push({ level: 'log', objectId: 'obj-1', text: 'a' })
rail.push({ level: 'warn', objectId: 'obj-2', text: 'b' })
rail.push({ level: 'error', objectId: 'obj-1', text: 'c' })
rail.push({ level: 'exception', objectId: null, text: 'd' })
rail.push({ level: 'info', objectId: 'obj-1', text: 'e' })

expect('levels are the six CDP-facing levels', CONSOLE_LEVELS.length === 6)
expect('query without filter returns all entries in order', rail.query().map((e) => e.text).join('') === 'abcde')
expect('filter by one level', rail.query({ level: 'error' }).map((e) => e.text).join('') === 'c')
expect('filter by level array', rail.query({ level: ['warn', 'info'] }).map((e) => e.text).join('') === 'be')
expect('filter by objectId', rail.query({ objectId: 'obj-1' }).map((e) => e.text).join('') === 'ace')
expect('objectId null matches unattributed entries', rail.query({ objectId: null }).map((e) => e.text).join('') === 'd')
expect('level and objectId combine', rail.query({ level: 'log', objectId: 'obj-2' }).length === 0)
expect('limit keeps the newest matches', rail.query({ objectId: 'obj-1', limit: 2 }).map((e) => e.text).join('') === 'ce')
expect('capacity evicts the oldest entry', rail.size() === 5 && rail.query({ level: 'debug' }).length === 0)

rail.push({ level: 'log', objectId: 'obj-3', text: 'f' })
expect('eviction keeps the newest five', rail.size() === 5 && rail.query()[0].text === 'b')
expect('seq is monotonic across eviction', rail.query().at(-1).seq === 6)

expect('unknown level is refused', throwsWith(() => rail.push({ level: 'fatal' }), RangeError))
expect('unknown filter level is refused', throwsWith(() => rail.query({ level: 'fatal' }), RangeError))
expect('non-string objectId is refused', throwsWith(() => rail.push({ level: 'log', objectId: 7 }), TypeError))
expect('zero capacity is refused', throwsWith(() => createConsoleRail({ capacity: 0 }), RangeError))

rail.clear()
expect('clear empties the rail', rail.size() === 0 && rail.query().length === 0)

if (failures === 0) {
  console.log('RESULT: PASS')
  process.exitCode = 0
} else {
  console.log(`RESULT: FAIL (${failures} check(s))`)
  process.exitCode = 1
}
