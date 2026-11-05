#!/usr/bin/env node
import { RoomLog, RoomLogError } from '../src/sdk/RoomLog.js'

const fails = []
let total = 0
const expect = (name, ok, detail) => {
  total++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}: ${detail}`)
  if (!ok) fails.push(name)
}
const refusal = (fn) => {
  try { fn(); return null } catch (err) { return err }
}

const log = new RoomLog({ capacity: 5 })
const s1 = log.append('info', 'boot', 'started')
const s2 = log.append('warn', 'physics', 'contacts dropped')
expect('append returns increasing seq', s1 === 1 && s2 === 2, `seq ${s1},${s2}`)

const noPath = refusal(() => log.append('error', 'physics', 'body overflow'))
expect('error without path refused', noPath instanceof RoomLogError && noPath.reasonCode === 'missing-path', `reasonCode ${noPath?.reasonCode}`)

const badLevel = refusal(() => log.append('fatal', 'boot', 'x'))
expect('unknown level refused', badLevel instanceof RoomLogError && badLevel.reasonCode === 'bad-level', `reasonCode ${badLevel?.reasonCode}`)

log.append('error', 'terrain', 'height solve failed', 'client/core/Rocks.js')
for (let i = 0; i < 4; i++) log.append('info', 'tick', `tick ${i}`)
expect('capacity bounds retained entries', log.entries.length === 5, `length ${log.entries.length}`)

const first = log.read({ after: 0, limit: 2 })
expect('first page holds two entries', first.entries.length === 2 && first.more === true, `count ${first.entries.length} more ${first.more}`)
expect('first page reports evicted entries', first.dropped === 2, `dropped ${first.dropped}`)

const second = log.read({ after: first.nextCursor, limit: 2 })
const seen = [...first.entries, ...second.entries].map(e => e.seq)
expect('cursor pages join without gap or repeat', seen.join(',') === '3,4,5,6', `seqs ${seen.join(',')}`)
expect('cursor pages are strictly increasing', seen.every((s, i) => i === 0 || s > seen[i - 1]), `seqs ${seen.join(',')}`)

const errors = log.read({ after: 0, limit: 10, level: 'error' })
expect('level filter returns only errors', errors.entries.length === 1 && errors.entries[0].path === 'client/core/Rocks.js', `count ${errors.entries.length}`)

const end = log.read({ after: log.nextSeq - 1, limit: 10 })
expect('read past head is empty and keeps cursor', end.entries.length === 0 && end.nextCursor === log.nextSeq - 1 && end.more === false, `cursor ${end.nextCursor}`)

const badCursor = refusal(() => log.read({ after: -1 }))
expect('negative cursor refused', badCursor instanceof RoomLogError && badCursor.reasonCode === 'bad-cursor', `reasonCode ${badCursor?.reasonCode}`)

const badLimit = refusal(() => log.read({ limit: 0 }))
expect('zero limit refused', badLimit instanceof RoomLogError && badLimit.reasonCode === 'bad-limit', `reasonCode ${badLimit?.reasonCode}`)

const badCap = refusal(() => new RoomLog({ capacity: 0 }))
expect('zero capacity refused', badCap instanceof RoomLogError && badCap.reasonCode === 'bad-capacity', `reasonCode ${badCap?.reasonCode}`)

console.log(`${total - fails.length}/${total} checks passed`)
if (fails.length) {
  console.log(`RESULT: FAIL ${fails.join(', ')}`)
  process.exit(1)
}
console.log('RESULT: PASS')
