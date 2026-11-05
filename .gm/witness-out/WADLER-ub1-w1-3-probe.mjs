import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const file = '/workspace/spoint/client/editor/sdk-typings.generated.d.ts'
const now = readFileSync(file, 'utf8')
const before = execFileSync('git', ['-C', '/workspace/spoint', 'show', 'HEAD:client/editor/sdk-typings.generated.d.ts'], { encoding: 'utf8' })
const count = t => (t.match(/\(v: any\)/g) || []).length
const line = (t, name) => (t.match(new RegExp(`${name}: [^\\n]*`, 'g')) || [])
const nonNegSinks = ['setMass', 'setLinearDamping', 'setAngularDamping', 'addSphereCollider', 'addCapsuleCollider']
const out = {
  file,
  vAnyCount: { head: count(before), now: count(now) },
  hasNonNegFinite: { head: before.includes('NonNegFinite'), now: now.includes('NonNegFinite') },
  setLinearDamping: { head: line(before, 'setLinearDamping'), now: line(now, 'setLinearDamping') },
  nonNegSinkLinesNow: Object.fromEntries(nonNegSinks.map(n => [n, line(now, n)])),
  nonNegSinkVAnyNow: nonNegSinks.filter(n => line(now, n).some(l => l.includes(': any'))),
}
console.log(JSON.stringify(out, null, 2))
