import assert from 'node:assert/strict'
import { splitTome, parseTypeListing } from './lib/reference-bundle.mjs'

const tome = '# Spawn Game API\nintro\n## World Queries\nfirst\n# State\nstate body\n## World Queries\nsecond\n'
const sections = splitTome(tome)
assert.equal(sections.length, 4)
assert.deepEqual(sections.map(s => s.slug), ['spawn-game-api', 'world-queries', 'state', 'world-queries-2'])
assert.equal(sections[1].body, 'first')
assert.equal(sections[3].body, 'second')

const types = parseTypeListing('Foo (2 kinds), Bar (1 kind), Baz\n305 types:\nShouldNotAppear (3 kinds)\n')
assert.deepEqual(types, ['Foo', 'Bar', 'Baz'])
assert.deepEqual(parseTypeListing(''), [])

for (const [call, code] of [
  [() => splitTome(''), 'tome-text-invalid'],
  [() => splitTome('no headings here'), 'tome-no-sections'],
  [() => parseTypeListing(null), 'type-text-invalid'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

console.log('RESULT: PASS Tome splitter keeps duplicate headings distinct and the type listing stops at its footer')
