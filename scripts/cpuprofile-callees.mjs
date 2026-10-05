import { readFileSync } from 'node:fs'

const [file, rootName, depthArg = '2', mode = 'callees'] = process.argv.slice(2)
if (!file || !rootName) {
  console.error('usage: node scripts/cpuprofile-callees.mjs <file.cpuprofile> <function name> [depth=2] [callees|callers]')
  process.exit(2)
}
const maxDepth = Number(depthArg)
const profile = JSON.parse(readFileSync(file, 'utf8'))
const byId = new Map(profile.nodes.map(n => [n.id, n]))
const selfUs = new Map()
for (let i = 0; i < profile.samples.length; i++) selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) || 0) + (profile.timeDeltas[i] || 0))
const parentOf = new Map()
for (const n of profile.nodes) for (const c of n.children || []) parentOf.set(c, n.id)

const inclusive = new Map()
const order = []
const stack = [profile.nodes[0].id]
while (stack.length) { const id = stack.pop(); order.push(id); for (const c of byId.get(id).children || []) stack.push(c) }
for (let i = order.length - 1; i >= 0; i--) {
  const id = order[i]
  let total = selfUs.get(id) || 0
  for (const c of byId.get(id).children || []) total += inclusive.get(c)
  inclusive.set(id, total)
}
const totalUs = inclusive.get(profile.nodes[0].id)
const label = n => `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`
const pct = us => (100 * us / totalUs).toFixed(2).padStart(6) + '%'
const nameOf = id => byId.get(id).callFrame.functionName

const hasAncestorNamed = id => { for (let p = parentOf.get(id); p !== undefined; p = parentOf.get(p)) if (nameOf(p) === rootName) return true; return false }
const rootIds = profile.nodes.filter(n => n.callFrame.functionName === rootName && !hasAncestorNamed(n.id)).map(n => n.id)
console.log(`${rootName}: ${rootIds.length} outermost nodes, inclusive ${pct(rootIds.reduce((a, id) => a + inclusive.get(id), 0))} of ${(totalUs / 1e6).toFixed(1)} s`)

if (mode === 'callers') {
  const callers = new Map()
  for (const id of rootIds) {
    const chain = []
    for (let p = parentOf.get(id), d = 0; p !== undefined && d < maxDepth; p = parentOf.get(p), d++) chain.push(label(byId.get(p)))
    const key = chain.join(' <- ')
    callers.set(key, (callers.get(key) || 0) + inclusive.get(id))
  }
  for (const [k, v] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(pct(v), k)
  process.exit(0)
}

const agg = new Map()
const walk = (id, depth, path) => {
  for (const c of byId.get(id).children || []) {
    const key = path + ' > ' + label(byId.get(c))
    agg.set(key, (agg.get(key) || 0) + inclusive.get(c))
    if (depth + 1 < maxDepth) walk(c, depth + 1, key)
  }
}
let selfTotal = 0
for (const id of rootIds) { selfTotal += selfUs.get(id) || 0; walk(id, 0, rootName) }
console.log(pct(selfTotal), rootName, '(self)')
for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(pct(v), k)
