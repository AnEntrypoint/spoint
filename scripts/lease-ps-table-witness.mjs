import { psProcessTable } from './lib/browser-lease.mjs'

const first = psProcessTable()
const failures = []
const mine = (table) => (table ? table.find((row) => row.pid === process.pid) : undefined)

if (!first) {
  failures.push('ps unavailable: psProcessTable returned null')
} else {
  const row = mine(first)
  if (!row) {
    failures.push('pid ' + process.pid + ' is absent from the ps table')
  } else {
    console.log('self: pid ' + row.pid + ' ppid ' + row.ppid + ' start ' + JSON.stringify(row.start))
    if (row.ppid !== process.ppid) failures.push('ppid ' + row.ppid + ' differs from process.ppid ' + process.ppid)
    if (!Number.isFinite(Date.parse(row.start))) failures.push('start ' + JSON.stringify(row.start) + ' does not parse as a date')
    const again = mine(psProcessTable())
    if (!again || again.start !== row.start) failures.push('start for pid ' + row.pid + ' differs between two reads')
  }
  console.log('rows read: ' + first.length)
}

for (const f of failures) console.log('check: FAIL ' + f)
console.log(failures.length === 0
  ? 'RESULT: PASS ps table: own pid, ppid and lstart parse and repeat on ' + process.platform
  : 'RESULT: FAIL ps table: ' + failures.length + ' check(s) failed')
process.exit(failures.length === 0 ? 0 : 1)
