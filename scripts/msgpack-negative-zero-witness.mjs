import { ensurePacked, pack, unpack, WIRE_STRUCTURES } from '../src/protocol/msgpack.js'

let failed = 0

function check(name, ok, detail) {
	if (!ok) failed++
	console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} -- ${detail}`)
}

function zeroSign(v) {
	if (Object.is(v, -0)) return '-0'
	if (Object.is(v, 0)) return '+0'
	return String(v)
}

const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(' ')

await ensurePacked

const negZero = -0

const scalarBytes = pack(negZero)
const scalar = unpack(scalarBytes)
check('scalar -0 round-trips', Object.is(scalar, -0), `bytes=[${hex(scalarBytes)}] got ${zeroSign(scalar)} 1/x=${1 / scalar}`)

const inArray = unpack(pack([7, negZero, 9]))[1]
check('-0 inside array round-trips', Object.is(inArray, -0), `got ${zeroSign(inArray)} 1/x=${1 / inArray}`)

const nested = unpack(pack({ a: { b: { c: negZero } } })).a.b.c
check('-0 inside nested object round-trips', Object.is(nested, -0), `got ${zeroSign(nested)} 1/x=${1 / nested}`)

const plain = unpack(pack({ x: negZero })).x
check('-0 as plain object property round-trips', Object.is(plain, -0), `got ${zeroSign(plain)} 1/x=${1 / plain}`)

const struct = {}
for (const key of WIRE_STRUCTURES[1]) struct[key] = 0
struct.serverTime = negZero
struct.players = [[negZero, 1, 2]]
const structBytes = pack(struct)
const structBack = unpack(structBytes)
check(
	'-0 inside snapshot struct round-trips',
	Object.is(structBack.serverTime, -0) && Object.is(structBack.players[0][0], -0),
	`${structBytes.byteLength}B firstByte=0x${new Uint8Array(structBytes)[0].toString(16)} ` +
	`serverTime=${zeroSign(structBack.serverTime)} players[0][0]=${zeroSign(structBack.players[0][0])}`
)

const posZero = unpack(pack(0))
check('+0 stays +0', Object.is(posZero, 0) && !Object.is(posZero, -0), `got ${zeroSign(posZero)} 1/x=${1 / posZero}`)

const inf = unpack(pack(Infinity))
const ninf = unpack(pack(-Infinity))
const nan = unpack(pack(NaN))
check(
	'Infinity / -Infinity / NaN survive',
	inf === Infinity && ninf === -Infinity && Number.isNaN(nan),
	`got ${inf} ${ninf} ${nan}`
)

const dec = unpack(pack(0.1))
check('0.1 stays bit-exact float64', Object.is(dec, 0.1), `got ${dec.toPrecision(20)}`)

const f64Probe = new Uint8Array(pack(1.5))[0]
check('encoder still emits 0xcb for non-integers', f64Probe === 0xcb, `firstByte=0x${f64Probe.toString(16)}`)

const { Unpackr } = await import('msgpackr')
const preChangePeer = new Unpackr()
check(
	'pre-change peer decodes our -0 bit-exact',
	Object.is(preChangePeer.unpack(pack(negZero)), -0),
	`bytes=[${hex(pack(negZero))}] peer got ${zeroSign(preChangePeer.unpack(pack(negZero)))}`
)
check(
	'pre-change peer decodes our 0.1 bit-exact',
	Object.is(preChangePeer.unpack(pack(0.1)), 0.1),
	`peer got ${preChangePeer.unpack(pack(0.1)).toPrecision(20)}`
)

const unkeyed = { zz1: 0, zz2: 0, zz3: 0, zz4: 0, zz5: 0, zz6: 0, zz7: 0, zz8: 0, zz9: 0, zz10: 0 }
unkeyed.zz3 = negZero
unkeyed.zz4 = [[negZero, 1, 2]]
const structLen = structBytes.byteLength
const unkeyedLen = pack(unkeyed).byteLength
check('snapshot still takes the record structure path', structLen < unkeyedLen, `struct=${structLen}B unkeyedMap=${unkeyedLen}B`)

console.log(failed === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed} check(s) failed)`)
process.exit(failed === 0 ? 0 : 1)
