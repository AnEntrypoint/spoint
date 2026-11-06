import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const R = '/workspace/spoint'
const out = []
const rec = (id, ok, detail) => { out.push(`${id} ${ok ? 'CONFIRMED' : 'NOT-CONFIRMED'} ${detail}`) }

const mp = await import(pathToFileURL(R + '/src/protocol/msgpack.js').href)
const mt = await import(pathToFileURL(R + '/src/protocol/MessageTypes.js').href)
const ic = await import(pathToFileURL(R + '/src/protocol/InputCodec.js').href)
const mpSrc = readFileSync(R + '/src/protocol/msgpack.js', 'utf8')
const ictSrc = readFileSync(R + '/src/protocol/InputCodec.js', 'utf8')

const w1 = mp.WIRE_STRUCTURES[1]
rec('csproto-1', Array.isArray(w1) && w1.length === 10, `WIRE_STRUCTURES[1].length=${w1?.length} keys=${JSON.stringify(w1)}`)

const unknownId = 0x7fff
rec('csproto-2', mt.msgName(unknownId) === null && mt.isUnreliable(unknownId) === null,
  `msgName(${unknownId})=${JSON.stringify(mt.msgName(unknownId))} isUnreliable(${unknownId})=${JSON.stringify(mt.isUnreliable(unknownId))}`)

let threw = false, msg = ''
try { mp.pack({ a: 1 }) } catch (e) { threw = true; msg = e.message.slice(0, 80) }
await mp.ensurePacked
let after = null
try { after = mp.unpack(mp.pack({ a: 1 })) } catch (e) { after = 'ERR ' + e.message.slice(0, 60) }
rec('csproto-3', threw && JSON.stringify(after) === '{"a":1}', `pack before settle threw=${threw} ("${msg}"); after settle roundtrip=${JSON.stringify(after)}`)

const iife = /\(\s*\(\s*\)\s*=>|\(\s*function\s*\(\s*\)/.test(mpSrc) && /msgpackr/.test(mpSrc)
rec('csproto-4', iife, `msgpack.js contains an IIFE near the msgpackr specifier: ${iife}`)

const ids = Object.values(mt.MSG ?? {}).filter(v => typeof v === 'number')
const ascending = ids.every((v, i) => i === 0 || ids[i - 1] < v)
const unique = new Set(ids).size === ids.length
rec('csproto-5', !ascending && unique, `MSG ids=${ids.length} ascending=${ascending} unique=${unique}`)

const packLine = mpSrc.split('\n').find(l => /useFloat32/.test(l) && /pack|NEVER|DECIMAL/.test(l)) || ''
rec('csproto-6', /NEVER/.test(mpSrc) && /DECIMAL_ROUND/.test(mpSrc), `source names NEVER and DECIMAL_ROUND: ${/NEVER/.test(mpSrc)} ${/DECIMAL_ROUND/.test(mpSrc)} line="${packLine.trim().slice(0, 100)}"`)

const cap = ictSrc.match(/\bMAX[A-Z_]*\s*=\s*(\d+)/)
const sliceLine = ictSrc.split('\n').slice(280, 300).find(l => /slice|length|MAX/.test(l)) || ''
rec('csproto-7', /slice\(-\s*8\)|-8|MAX_[A-Z_]*\s*=\s*8/.test(ictSrc.slice(ictSrc.indexOf('function encodeInputPacket'), ictSrc.indexOf('function encodeInputPacket') + 900)) || (cap && cap[1] === '8'),
  `cap=${cap ? cap[0] : 'none'} line="${sliceLine.trim().slice(0, 120)}"`)

const qStart = ictSrc.indexOf('export function quantizeInput')
const qBody = ictSrc.slice(qStart, qStart + 2000)
const clampsPitch = /HALF_PI/.test(qBody)
const wrapsYaw = /TAU/.test(qBody)
rec('csproto-8', clampsPitch && wrapsYaw, `quantizeInput references HALF_PI=${clampsPitch} TAU=${wrapsYaw}`)

console.log(out.join('\n'))
