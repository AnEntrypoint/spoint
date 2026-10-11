import { pathToFileURL } from 'node:url'

const B = 'file:///C:/dev/spoint/src/netcode/'
const { EventLog, parseEventKind, EVENT_LOG_KINDS } = await import(B + 'EventLog.js')
const cf = await import(B + 'controlFrame.js')

let fail = 0
let claims = 0
const ck = (name, cond, got) => {
  claims++
  if (!cond) fail++
  console.log((cond ? 'ok   ' : 'FAIL ') + name + ' -> ' + JSON.stringify(got))
}

ck('EVENT_LOG_KINDS names the three replayable kinds exactly', JSON.stringify(EVENT_LOG_KINDS) === JSON.stringify(['entity_spawn', 'entity_destroy', 'bus_event']), EVENT_LOG_KINDS)

ck('parseEventKind returns its case by name for a declared kind', parseEventKind('entity_spawn'), { status: 'replayable', kind: 'entity_spawn' })
ck('parseEventKind returns its case by name for an undeclared kind', parseEventKind('totally_made_up'), { status: 'no-replay-arm', kind: 'totally_made_up' })
ck('every declared kind parses as replayable', EVENT_LOG_KINDS.every(k => parseEventKind(k).status === 'replayable'), EVENT_LOG_KINDS.map(parseEventKind))

const log = new EventLog({ maxSize: 20 })
const declared = log.record('entity_spawn', { id: 'a', config: { k: 1 } }, { tick: 1 })
const undeclared = log.record('move', { to: 3 }, { tick: 2 })
ck('record stamps replayable on a declared kind', declared.kindStatus, 'replayable')
ck('record stamps no-replay-arm on an undeclared kind', undeclared.kindStatus, 'no-replay-arm')
ck('record still accepts an undeclared kind instead of refusing it', undeclared.type === 'move' && log.size === 2, { type: undeclared.type, size: log.size })

const remote = log.ingestRemote({ id: 7, tick: 4, type: 'entity_destroy', data: { id: 'r1' }, meta: {}, timestamp: 1000 }, 'eu')
ck('ingestRemote stamps the boundary verdict', remote && remote.kindStatus, 'replayable')

const runtime = { spawnEntity: () => {}, destroyEntity: () => {}, _eventBus: { emit: () => {} } }
const replayed = log.replay(runtime, {})
ck('replay applies only the replayable kinds and names the rest', replayed.eventsReplayed === 2 && replayed.errors.length === 1, replayed)
ck('replay names the undeclared kind by name', replayed.errors[0], { eventId: 2, error: 'unknown event type "move"' })

const bytes = log.serialize()
const copy = EventLog.deserialize(bytes)
ck('deserialize stamps the verdict on every restored record', copy.query({}).map(e => e.kindStatus), ['replayable', 'no-replay-arm', 'replayable'])
ck('a deserialized log replays to the same verdict as the original', JSON.stringify(copy.replay(runtime, {})) === JSON.stringify(replayed), copy.replay(runtime, {}))

const stripped = EventLog.deserialize(bytes)
for (const e of stripped.query({})) e.kindStatus = undefined
const strippedResult = stripped.replay(runtime, {})
ck('an event with no verdict is refused at replay, never silently applied', strippedResult.eventsReplayed === 0 && strippedResult.errors.length === 3, strippedResult)

ck('decodeControlFrame is gone, so no caller can re-collapse the cases', 'decodeControlFrame' in cf === false, Object.keys(cf).sort())
ck('parseControlFrame names unregistered-prefix', cf.parseControlFrame('wwnope:', 'wwnope:{}'), { status: 'unregistered-prefix' })
ck('parseControlFrame names foreign-prefix', cf.parseControlFrame(cf.LOCKSTEP_CTRL_PREFIX, 'wwrollback:{"type":"input"}'), { status: 'foreign-prefix' })
ck('parseControlFrame names malformed-payload', cf.parseControlFrame(cf.LOCKSTEP_CTRL_PREFIX, 'wwlockstep:not-json'), { status: 'malformed-payload' })
ck('parseControlFrame names unknown-kind and carries the kind', cf.parseControlFrame(cf.LOCKSTEP_CTRL_PREFIX, 'wwlockstep:{"type":"checksum"}'), { status: 'unknown-kind', kind: 'checksum' })
ck('parseControlFrame accepts a real frame', cf.parseControlFrame(cf.LOCKSTEP_CTRL_PREFIX, 'wwlockstep:{"type":"input","tick":1}'), { status: 'accepted', frame: { type: 'input', tick: 1 } })

console.log(fail === 0 ? `RESULT: PASS (${claims})` : `RESULT: FAIL (${fail} of ${claims})`)
process.exitCode = fail === 0 ? 0 : 1
