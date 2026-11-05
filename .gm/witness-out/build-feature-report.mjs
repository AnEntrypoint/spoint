import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE = '/config/.claude/projects/-workspace-spoint/438a05ef-b51a-46d5-9bc3-1491ca557cb0/tool-results/by2vpn00c.txt'
const OUT = '/workspace/spoint/.gm/witness-out/savi-spawn-feature-gap.md'
const units = JSON.parse(readFileSync(SOURCE, 'utf8'))
const IMPLEMENTED = [
  'Named easing catalogue', 'Keyframe tween runtime (animate)', 'Ballistics lead, Vec3 arrays and ctx exposure',
  'PathHandle completion (distance, nearest, at, closed)', 'Room-routing helper set and async pickRoom contract',
  'Two-sided atomic trade', 'Wired provider-neutral decision runtime', 'Post-write verification and retry',
  'Reinstate the documented AGENTS.md/SKILL.md fact witness', 'AppLoader structured refusals with reason codes',
  'One-boundary world movement validation', 'Machine-checked SKILL.md ctx API coverage',
]
const lines = [
  '# savi / spawn feature-gap report',
  '',
  'Source: the parallel read workflow `savi-spawn-feature-gap` over /workspace/savi/.spawn/reference (208 indexed files) and /workspace/spawn (runs, sources, tooling). Four of eight readers returned structured feature claims; four stalled and the workflow was stopped. The adversarial vote and synthesis phases did not run, so these claims are reader evidence, not verified findings.',
  '',
  'Implemented in this coder run: ' + IMPLEMENTED.length + ' claims (marked [x] below). The rest are parked as one PRD row for verification and implementation.',
  '',
]
let count = 0
let done = 0
for (const unit of units) {
  if (!unit.features?.length) continue
  lines.push('## ' + (unit.unit || unit.file), '')
  for (const f of unit.features) {
    count++
    const hit = IMPLEMENTED.some(name => name.toLowerCase() === String(f.name).toLowerCase())
    if (hit) done++
    lines.push(`- [${hit ? 'x' : ' '}] **${f.name}** (${f.feasibility}) — ${f.gap}`)
    if (f.files?.length) lines.push(`  - files: ${f.files.map(p => '`' + p.replace('/workspace/spoint/', '') + '`').join(', ')}`)
  }
  lines.push('')
}
lines.push(`Total claims: ${count}. Implemented here: ${done}. Remaining: ${count - done}.`)
writeFileSync(OUT, lines.join('\n') + '\n')
console.log(`RESULT: PASS wrote ${OUT} with ${count} claim(s), ${done} implemented`)
