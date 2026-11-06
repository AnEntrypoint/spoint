import { pathToFileURL } from 'node:url'
const R = '/workspace/spoint'
const ic = await import(pathToFileURL(R + '/src/protocol/InputCodec.js').href)
const mt = await import(pathToFileURL(R + '/src/protocol/MessageTypes.js').href)
const out = []

out.push(`csproto-2 ${mt.msgName(0x7fff) === null && mt.isUnreliable(0x7fff) === null ? 'CONFIRMED' : 'NOT-CONFIRMED'} msgName=${JSON.stringify(mt.msgName(0x7fff))} isUnreliable=${JSON.stringify(mt.isUnreliable(0x7fff))}`)

const mk = (seq) => ({ sequence: seq, data: { buttons: 0, axes: [], forward: 0, right: 0, yaw: 0, pitch: 0 } })
const entries = Array.from({ length: 10 }, (_, i) => mk(i + 1))
const r = ic.tryEncodeInputPacket(ic.DEFAULT_INPUT_SCHEMA, entries, 0)
const dropped = r.cases.find(c => c.code === ic.INPUT_CASE.DROPPED)
const decoded = ic.decodeInputPacket(ic.DEFAULT_INPUT_SCHEMA, r.bytes)
const seqs = decoded.entries?.map(e => e.sequence) ?? []
out.push(`csproto-7 ${r.accepted && r.dropped === 2 && dropped && seqs.join() === '3,4,5,6,7,8,9,10' ? 'CONFIRMED' : 'NOT-CONFIRMED'} accepted=${r.accepted} dropped=${r.dropped} caseCode=${dropped?.code} kept=${JSON.stringify(seqs)} reasonVisible=${dropped ? dropped.reason.slice(0, 90) : 'none'}`)

const q1 = ic.quantizeInput(ic.DEFAULT_INPUT_SCHEMA, { pitch: 5, yaw: 0, forward: 0, right: 0, buttons: 0, axes: [] }, [])
const cases1 = []
ic.quantizeInput(ic.DEFAULT_INPUT_SCHEMA, { pitch: 5, yaw: 0 }, cases1)
const cases2 = []
ic.quantizeInput(ic.DEFAULT_INPUT_SCHEMA, { pitch: 0, yaw: 7 }, cases2)
const clamped = cases1.some(c => c.code === ic.INPUT_CASE.CLAMPED)
const wrapped = cases2.some(c => c.code === ic.INPUT_CASE.WRAPPED)
out.push(`csproto-8 ${clamped && wrapped ? 'CONFIRMED' : 'NOT-CONFIRMED'} pitchClampedCase=${clamped} yawWrappedCase=${wrapped}`)
console.log(out.join('\n'))
