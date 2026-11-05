import { readFileSync } from 'node:fs'
const root = '/workspace/spoint/src/game/'
const sites = {}
for (const f of ['StatsSystem.js', 'EventChainManager.js', 'ProgressionSystem.js']) {
  sites[f] = readFileSync(root + f, 'utf8').split('\n').map((l, i) => ({ line: i + 1, text: l.trim() })).filter(x => /return false\b/.test(x.text)).map(x => x.line + ': ' + x.text)
}
const counts = Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, v.length]))
console.log(JSON.stringify({ bareFalseReturnSites: sites, counts }, null, 2))
