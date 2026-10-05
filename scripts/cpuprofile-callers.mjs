import fs from 'node:fs'

const [file, ...patterns] = process.argv.slice(2)
if (!file || patterns.length === 0) {
  console.error('usage: node scripts/cpuprofile-callers.mjs <file.cpuprofile> <function-name-regex>... [--depth=N] [--top=N]')
  process.exit(2)
}
const options = Object.fromEntries(patterns.filter(p => p.startsWith('--')).map(p => p.slice(2).split('=')))
const depth = Number(options.depth || 3)
const top = Number(options.top || 12)
const regexes = patterns.filter(p => !p.startsWith('--')).map(p => new RegExp(p))

const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
const nodes = new Map()
for (const n of profile.nodes) nodes.set(n.id, { ...n, parent: null, selfUs: 0, totalUs: 0 })
for (const n of nodes.values()) for (const c of n.children || []) nodes.get(c).parent = n
for (let i = 0; i < profile.samples.length; i++) nodes.get(profile.samples[i]).selfUs += profile.timeDeltas[i] || 0
const byDepth = [...nodes.values()].map(n => { let d = 0; for (let p = n.parent; p; p = p.parent) d++; return [n, d] }).sort((a, b) => b[1] - a[1])
for (const [n] of byDepth) { n.totalUs += n.selfUs; if (n.parent) n.parent.totalUs += n.totalUs }
const totalUs = profile.samples.reduce((s, _, i) => s + (profile.timeDeltas[i] || 0), 0)

const label = (n) => {
  const f = n.callFrame
  const file = f.url ? f.url.split('/').slice(-2).join('/') : ''
  return `${f.functionName || '(anonymous)'}${file ? ` ${file}:${f.lineNumber + 1}` : ''}`
}
const fmt = (us) => `${(us / 1000).toFixed(1)} ms ${(100 * us / totalUs).toFixed(2)}%`

console.log(`profile ${file}: ${(totalUs / 1e6).toFixed(2)} s sampled, ${nodes.size} nodes`)
for (const re of regexes) {
  const matches = [...nodes.values()].filter(n => re.test(n.callFrame.functionName || ''))
  const outermost = matches.filter(n => { for (let p = n.parent; p; p = p.parent) if (re.test(p.callFrame.functionName || '')) return false; return true })
  const inclusive = outermost.reduce((s, n) => s + n.totalUs, 0)
  const self = matches.reduce((s, n) => s + n.selfUs, 0)
  console.log(`\n== /${re.source}/  inclusive ${fmt(inclusive)}  self ${fmt(self)}  call sites ${outermost.length}`)
  const chains = new Map()
  for (const n of outermost) {
    const chain = []
    for (let p = n.parent; p && chain.length < depth; p = p.parent) chain.push(label(p))
    const key = chain.join('  <-  ')
    chains.set(key, (chains.get(key) || 0) + n.totalUs)
  }
  for (const [key, us] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${fmt(us).padEnd(22)} ${key}`)
}
