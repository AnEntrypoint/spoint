import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

const DEFAULT_BLOCKS = 3
const DEFAULT_CHARS = 6000
const MAX_WALK_DEPTH = 6

function flagsOf(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--blocks') out.blocks = Number(argv[i + 1])
    if (argv[i] === '--chars') out.chars = Number(argv[i + 1])
  }
  return out
}

function findTaskOutput(id) {
  const root = join(tmpdir(), 'claude')
  if (!existsSync(root)) return null
  const wanted = `${id}.output`
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length) {
    const { dir, depth } = queue.shift()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (entry.name === wanted && basename(dir) === 'tasks') return full
    }
  }
  return null
}

function assistantTexts(file) {
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue
    for (const part of record.message.content) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) out.push(part.text)
    }
  }
  return out
}

function main() {
  const argv = process.argv.slice(2)
  const positional = argv.filter(a => !a.startsWith('--') && !/^\d+$/.test(a))
  const flags = flagsOf(argv)
  const blocks = Number.isFinite(flags.blocks) ? flags.blocks : DEFAULT_BLOCKS
  const chars = Number.isFinite(flags.chars) ? flags.chars : DEFAULT_CHARS
  const target = positional[0]
  if (!target) {
    console.error('agent-report: pass a task id or a path to a task .output file')
    process.exit(2)
  }
  const file = existsSync(target) ? target : findTaskOutput(target)
  if (!file) {
    console.error(`agent-report: no task output found for "${target}" under ${join(tmpdir(), 'claude')}/**/tasks/`)
    process.exit(1)
  }
  const bytes = statSync(file).size
  const texts = assistantTexts(file)
  const chosen = texts.slice(Math.max(0, texts.length - blocks))
  let body = chosen.join('\n-----\n')
  let truncated = false
  if (body.length > chars) {
    body = body.slice(body.length - chars)
    truncated = true
  }
  console.log(`agent-report: ${file} (${bytes} bytes), ${texts.length} assistant text block(s), showing last ${chosen.length}`)
  if (truncated) console.log(`agent-report: body truncated to the last ${chars} char(s) -- pass --chars N for more`)
  console.log(body)
}

main()
