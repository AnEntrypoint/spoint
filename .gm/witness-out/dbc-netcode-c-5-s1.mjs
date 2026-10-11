import { readFileSync } from 'node:fs'

const B = 'file:///C:/dev/spoint/src/netcode/'
const R = 'C:/dev/spoint/src/netcode/'
const cf = await import(B + 'controlFrame.js')
const { LockstepInputTransport } = await import(B + 'LockstepInputTransport.js')
const { RollbackInputTransport } = await import(B + 'RollbackInputTransport.js')
const { ConsensusVoter } = await import(B + 'ConsensusVoter.js')

let fail = 0
let claims = 0
const ck = (name, cond, got) => {
  claims++
  if (!cond) fail++
  console.log((cond ? 'ok   ' : 'FAIL ') + name + ' -> ' + JSON.stringify(got))
}

function makeBridge(pubkey) {
  const data = new EventTarget()
  data.peers = new Map()
  data.broadcast = () => 1
  return { pubkey, data }
}
function deliver(bridge, payload, from) {
  bridge.data.dispatchEvent(new CustomEvent('data', { detail: { data: payload, peerPubkey: from } }))
}
const enc = (prefix, frame) => prefix + JSON.stringify(frame)

const L = cf.LOCKSTEP_CTRL_PREFIX
const B_ = cf.ROLLBACK_CTRL_PREFIX
const C = cf.CONSENSUS_CTRL_PREFIX

// --- 1. the contract sits next to the kind, in the boundary ---
ck('countUnknownKind is gone, countReject replaces it', !('countUnknownKind' in cf) && typeof cf.countReject === 'function', Object.keys(cf).sort())
ck('controlFrameKinds still names lockstep input,drop', JSON.stringify(cf.controlFrameKinds(L)) === '["input","drop"]', cf.controlFrameKinds(L))
ck('controlFrameKinds still names rollback input,checksum', JSON.stringify(cf.controlFrameKinds(B_)) === '["input","checksum"]', cf.controlFrameKinds(B_))
ck('controlFrameKinds still names consensus checksum', JSON.stringify(cf.controlFrameKinds(C)) === '["checksum"]', cf.controlFrameKinds(C))

ck('lockstep input admits tick 1', cf.parseControlFrame(L, enc(L, { type: 'input', tick: 1 })).status, 'accepted')
ck('lockstep input names tick 0 as invalid-field', cf.parseControlFrame(L, enc(L, { type: 'input', tick: 0 })), { status: 'invalid-field', kind: 'input', field: 'tick' })
ck('lockstep input names tick 1.5 as invalid-field', cf.parseControlFrame(L, enc(L, { type: 'input', tick: 1.5 })), { status: 'invalid-field', kind: 'input', field: 'tick' })
ck('lockstep input names a missing tick as invalid-field', cf.parseControlFrame(L, enc(L, { type: 'input' })).field, 'tick')
ck('lockstep drop names a non-string peer', cf.parseControlFrame(L, enc(L, { type: 'drop', peer: 5, have: 1, tail: [] })), { status: 'invalid-field', kind: 'drop', field: 'peer' })
ck('lockstep drop names a non-integer have', cf.parseControlFrame(L, enc(L, { type: 'drop', peer: 'p3', have: 1.5, tail: [] })).field, 'have')
ck('lockstep drop names a non-array tail', cf.parseControlFrame(L, enc(L, { type: 'drop', peer: 'p3', have: 1, tail: 'x' })).field, 'tail')
ck('lockstep drop accepts a whole frame', cf.parseControlFrame(L, enc(L, { type: 'drop', peer: 'p3', have: 1, tail: [] })).status, 'accepted')
ck('rollback input names a non-integer tick', cf.parseControlFrame(B_, enc(B_, { type: 'input', tick: 1.5 })), { status: 'invalid-field', kind: 'input', field: 'tick' })
ck('rollback checksum names a non-integer tick', cf.parseControlFrame(B_, enc(B_, { type: 'checksum', tick: 1.5 })), { status: 'invalid-field', kind: 'checksum', field: 'tick' })
ck('rollback checksum accepts an integer tick', cf.parseControlFrame(B_, enc(B_, { type: 'checksum', tick: 30 })).status, 'accepted')
ck('consensus checksum names a missing pubkey', cf.parseControlFrame(C, enc(C, { type: 'checksum', tick: 30, checksum: 'cs' })), { status: 'invalid-field', kind: 'checksum', field: 'pubkey' })
ck('consensus checksum names a missing checksum', cf.parseControlFrame(C, enc(C, { type: 'checksum', tick: 30, pubkey: 'p2' })), { status: 'invalid-field', kind: 'checksum', field: 'checksum' })
ck('consensus checksum names a non-number tick', cf.parseControlFrame(C, enc(C, { type: 'checksum', tick: '30', pubkey: 'p2', checksum: 'cs' })).field, 'tick')
ck('unknown-kind still outranks a field check', cf.parseControlFrame(L, enc(L, { type: 'checksum' })), { status: 'unknown-kind', kind: 'checksum' })
ck('foreign-prefix still outranks the contract', cf.parseControlFrame(L, enc(B_, { type: 'input' })).status, 'foreign-prefix')
ck('malformed-payload still outranks the contract', cf.parseControlFrame(L, 'wwlockstep:not-json').status, 'malformed-payload')
ck('unregistered-prefix still outranks the contract', cf.parseControlFrame('wwnope:', 'wwnope:{}').status, 'unregistered-prefix')

// --- 2. the three consumers no longer restate the contract ---
for (const [file, needle] of [
  ['LockstepInputTransport.js', 'stats.malformed'],
  ['RollbackInputTransport.js', 'countUnknownKind'],
  ['ConsensusVoter.js', 'countUnknownKind'],
  ['LockstepInputTransport.js', 'countUnknownKind'],
  ['RollbackInputTransport.js', 'Number.isInteger(frame.tick)'],
  ['ConsensusVoter.js', "typeof frame.tick !== 'number'"],
]) {
  ck(`${file} no longer contains ${needle}`, !readFileSync(R + file, 'utf8').includes(needle), needle)
}

// --- 3. every rejection is a named counted status the transports read ---
const b1 = makeBridge('p1')
const lock = new LockstepInputTransport({ bridge: b1 })
ck('lockstep starts with an empty rejects ledger', JSON.stringify(lock.getStats().rejects), '{}')
deliver(b1, enc(L, { type: 'input', tick: 0 }), 'p2')
deliver(b1, enc(L, { type: 'drop', peer: 5, have: 1, tail: [] }), 'p2')
deliver(b1, enc(L, { type: 'checksum', tick: 30 }), 'p2')
const s1 = lock.getStats()
ck('lockstep counts invalid-field twice by name', s1.rejects['invalid-field'] === 2, s1.rejects)
ck('lockstep still counts unknown-kind', s1.unknownKind === 1 && s1.rejects['unknown-kind'] === 1, { unknownKind: s1.unknownKind, rejects: s1.rejects })
ck('lockstep applied neither rejected frame', s1.received === 0 && s1.dropReportsReceived === 0, { received: s1.received, drops: s1.dropReportsReceived })
deliver(b1, enc(L, { type: 'input', tick: 7, input: { f: 1 } }), 'p2')
deliver(b1, enc(L, { type: 'drop', peer: 'p3', have: 1, tail: [] }), 'p2')
ck('lockstep still applies a whole frame', lock.getStats().received === 1 && lock.getStats().dropReportsReceived === 1, lock.getStats())

const b2 = makeBridge('p1')
const rb = new RollbackInputTransport({ bridge: b2 })
let rbGot = null
rb.onRemoteInput = (from, tick) => { rbGot = { from, tick } }
deliver(b2, enc(B_, { type: 'input', tick: 1.5 }), 'p2')
deliver(b2, enc(B_, { type: 'checksum', tick: 'x' }), 'p2')
deliver(b2, enc(B_, { type: 'drop', peer: 'p3' }), 'p2')
const s2 = rb.getStats()
ck('rollback counts the two invalid-field rejects', s2.rejects['invalid-field'] === 2, s2.rejects)
ck('rollback counts the unknown-kind reject', s2.unknownKind === 1 && s2.rejects['unknown-kind'] === 1, { unknownKind: s2.unknownKind, rejects: s2.rejects })
ck('rollback applied nothing and named no peer', rbGot === null && s2.received === 0 && s2.checksumsReceived === 0, { got: rbGot, received: s2.received })
deliver(b2, enc(B_, { type: 'input', tick: 7 }), 'p2')
deliver(b2, enc(B_, { type: 'checksum', tick: 30, checksum: 'abc' }), 'p2')
ck('rollback still applies whole frames', rb.getStats().received === 1 && rb.getStats().checksumsReceived === 1 && rbGot.tick === 7, rb.getStats())

// --- 4. ConsensusVoter's declared arm is live ---
const b3 = makeBridge('p1')
const voter = new ConsensusVoter({ bridge: b3, checksumOf: (t) => 'cs' + t, localPeerId: 'p1', expectedPeerIds: ['p1', 'p2'] })
deliver(b3, enc(C, { type: 'checksum', tick: 30, pubkey: 'p2' }), 'p2')
deliver(b3, enc(C, { type: 'checksum', tick: 30, pubkey: 'p1', checksum: 'cs' }), 'p2')
const s3 = voter.getStats()
ck('consensus counts the missing-checksum reject by name', s3.rejects['invalid-field'] === 1, s3.rejects)
ck('consensus dropped neither frame into the detector', s3.checksumsReceived + s3.checksumsIgnored === 0, { received: s3.checksumsReceived, ignored: s3.checksumsIgnored })
deliver(b3, enc(C, { type: 'checksum', tick: 30, pubkey: 'p2', checksum: 'cs30' }), 'p2')
const s4 = voter.getStats()
ck('the declared checksum arm now runs', s4.checksumsReceived + s4.checksumsIgnored === 1, { received: s4.checksumsReceived, ignored: s4.checksumsIgnored })
ck('an unattributed checksum still never reaches the detector', s4.checksumsReceived + s4.checksumsIgnored === 1, s4.rejects)

console.log(fail === 0 ? `RESULT: PASS (${claims})` : `RESULT: FAIL (${fail} of ${claims})`)
process.exitCode = fail === 0 ? 0 : 1
