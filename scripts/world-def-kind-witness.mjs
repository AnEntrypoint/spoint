import { parseWorldDef, WORLD_DEF_FIELDS, TERRAIN_DEF_FIELDS, ENTITY_DEF_FIELDS } from '../apps/world/_shared/worldDefParse.js'

const TARGET = 'apps/world/_shared/worldDefParse.js'
const SHIPPED_WORLDS = [
  'tutorial', 'arena-combat', 'lockstep-rts', 'empty', 'agent-demo',
  'tps-game', 'rollback-duel', 'fire-duel', 'deathrun', 'tutorial-rpg', 'sandbox'
]

const rows = []

function record(name, expected, observed) {
  const ok = expected === observed
  rows.push({ name, expected, observed, ok })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} :: expected ${expected} :: got ${observed}`)
}

function verdictOf(def) {
  try {
    parseWorldDef('witness-world', def)
    return 'ACCEPTED'
  } catch (e) {
    if (e && e.name === 'WorldDefParseError') return e.code
    return 'UNEXPECTED-' + (e && e.name)
  }
}

function messageOf(def) {
  try {
    parseWorldDef('witness-world', def)
    return ''
  } catch (e) {
    return e && e.message ? e.message : ''
  }
}

const FLAT = { planetRadius: 0 }

function flat(extra) {
  return Object.assign({}, FLAT, extra)
}

console.log(`[world-def-kind] declared kinds at ${TARGET}`)

record('WORLD_DEF_FIELDS.netcode.kind', 'object', WORLD_DEF_FIELDS.netcode.kind)
record('TERRAIN_DEF_FIELDS.enabled.kind', 'boolean', TERRAIN_DEF_FIELDS.enabled.kind)
record('ENTITY_DEF_FIELDS.id.kind', 'string', ENTITY_DEF_FIELDS.id.kind)

record('netcode string is refused', 'world-field-type-invalid', verdictOf(flat({ netcode: 'rollback' })))
record('netcode number is refused', 'world-field-type-invalid', verdictOf(flat({ netcode: 5 })))
record('netcode array is refused', 'world-field-type-invalid', verdictOf(flat({ netcode: ['rollback'] })))
record('netcode boolean is refused', 'world-field-type-invalid', verdictOf(flat({ netcode: true })))
record('netcode object is accepted', 'ACCEPTED', verdictOf(flat({ netcode: { profile: 'rollback' } })))
record('netcode null means absent', 'ACCEPTED', verdictOf(flat({ netcode: null })))
record('netcode absent is accepted', 'ACCEPTED', verdictOf(flat({})))

record('terrain string is refused', 'world-field-type-invalid', verdictOf(flat({ terrain: 'x' })))
record(
  'terrain.enabled string is refused',
  'world-terrain-field-type-invalid',
  verdictOf(flat({ terrain: { enabled: 'yes', clusters: { enabled: false } } }))
)
record(
  'terrain.enabled boolean is accepted',
  'ACCEPTED',
  verdictOf(flat({ terrain: { enabled: true, clusters: { enabled: false } } }))
)

record(
  'entity id number is refused',
  'world-entity-field-type-invalid',
  verdictOf(flat({ entities: [{ id: 5, app: 'terrain', config: { clusters: { enabled: false } } }] }))
)
record(
  'entity position of mixed types keeps its own code',
  'world-entity-position-invalid',
  verdictOf(flat({ entities: [{ position: [1, 2, 'x'] }] }))
)
record('entity scale number keeps its own code', 'world-entity-scale-invalid', verdictOf(flat({ entities: [{ scale: 5 }] })))
record('entity bodyType outside the set keeps its own code', 'world-entity-body-type-unknown', verdictOf(flat({ entities: [{ bodyType: 'static' }] })))

record('world name number is refused', 'world-field-type-invalid', verdictOf(flat({ name: 7 })))
record('world tickRate string is refused', 'world-field-type-invalid', verdictOf(flat({ tickRate: '60' })))
record('world gravity number is accepted', 'ACCEPTED', verdictOf(flat({ gravity: -9.81 })))
record('world gravity array is accepted', 'ACCEPTED', verdictOf(flat({ gravity: [0, -9.81, 0] })))
record('world shape null is accepted', 'ACCEPTED', verdictOf(flat({ shape: null })))
record('world terrain object is accepted', 'ACCEPTED', verdictOf(flat({ terrain: { clusters: { enabled: false } } })))

const netcodeDetail = messageOf(flat({ netcode: 'rollback' }))
record(
  'the refused netcode names the field, the declared kind and the observed kind',
  true,
  netcodeDetail.includes('field "netcode"') && netcodeDetail.includes('declared object') && netcodeDetail.includes('got string')
)

for (const name of SHIPPED_WORLDS) {
  let observed = 'ACCEPTED'
  try {
    await import('../apps/world/' + name + '.js')
  } catch (e) {
    observed = (e && e.code) || 'THREW'
  }
  record(`shipped world apps/world/${name}.js still parses`, 'ACCEPTED', observed)
}

const failed = rows.filter((r) => !r.ok)
console.log(`[world-def-kind] ${rows.length - failed.length} passed, ${failed.length} failed`)
console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${rows.length - failed.length} of ${rows.length} check(s) held over ${TARGET}`)
process.exit(failed.length === 0 ? 0 : 1)
