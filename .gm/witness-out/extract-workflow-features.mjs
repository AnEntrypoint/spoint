import { readdirSync, readFileSync } from 'node:fs'

const dir = '/config/.claude/projects/-workspace-spoint/438a05ef-b51a-46d5-9bc3-1491ca557cb0/subagents/workflows/wf_da065f18-566'
const files = readdirSync(dir).filter(n => /^agent-.*\.jsonl$/.test(n))
const out = []
for (const n of files) {
  let found = null
  for (const line of readFileSync(`${dir}/${n}`, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const content = e.message?.content ?? e.content ?? []
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c?.type === 'tool_use' && /StructuredOutput/i.test(c.name || '') && c.input) found = c.input
    }
  }
  out.push({
    file: n,
    unit: found?.unit ?? null,
    features: (found?.features ?? []).map(f => ({ name: f.name, feasibility: f.feasibility, files: f.proposedFiles, gap: f.gap })),
  })
}
console.log(JSON.stringify(out, null, 2))
