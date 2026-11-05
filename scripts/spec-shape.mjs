import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_DTS = join(ROOT, 'client/editor/sdk-typings.generated.d.ts')

const DECL = (name) => new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(interface|type|class|enum)\\s+${name}\\b`, 'm')
const OPEN = { '{': '}', '(': ')', '[': ']' }
const CLOSE = new Set(Object.values(OPEN))

export function declarationOf(text, name) {
  const m = DECL(name).exec(text)
  if (!m) return null
  let depth = 0
  for (let i = m.index; i < text.length; i += 1) {
    const ch = text[i]
    if (OPEN[ch]) depth += 1
    else if (CLOSE.has(ch)) {
      depth -= 1
      if (depth === 0 && ch === '}') return text.slice(m.index, i + 1)
    } else if (depth === 0 && ch === ';') return text.slice(m.index, i + 1)
  }
  return null
}

export function bodyOf(decl) {
  const open = decl.indexOf('{')
  const eq = decl.indexOf('=')
  if (open < 0 || (eq >= 0 && eq < open)) return decl.slice(eq + 1).replace(/;\s*$/, '').trim()
  return decl.slice(open + 1, decl.lastIndexOf('}')).trim()
}

function topLevelSplit(text, separator) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (OPEN[ch]) depth += 1
    else if (CLOSE.has(ch)) depth -= 1
    else if (depth === 0 && ch === separator) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

export function unionMembers(decl) {
  return topLevelSplit(bodyOf(decl), '|')
}

export function members(decl) {
  const out = []
  const lines = bodyOf(decl).split('\n')
  let depth = 0
  let current = null
  for (const line of lines) {
    if (depth === 0) {
      const key = /^\s*(?:readonly\s+)?(?:static\s+)?(?:get\s+|set\s+)?(\w+)\??\s*[(:<]/.exec(line)
      if (key) current = { key: key[1], text: [] }
      if (current) out.push(current)
    }
    if (current) current.text.push(line)
    for (const ch of line) {
      if (OPEN[ch]) depth += 1
      else if (CLOSE.has(ch)) depth -= 1
    }
  }
  return out.map((m) => ({ key: m.key, text: m.text.join('\n').trim() }))
}

function main(argv) {
  const args = argv.slice(2)
  const fileIdx = args.indexOf('--file')
  const file = fileIdx >= 0 ? args[fileIdx + 1] : DEFAULT_DTS
  const memberIdx = args.indexOf('--member')
  const member = memberIdx >= 0 ? args[memberIdx + 1] : null
  const valued = new Set([fileIdx, memberIdx].filter((i) => i >= 0).map((i) => i + 1))
  const name = args.find((a, i) => !a.startsWith('--') && !valued.has(i))
  if (!name) {
    process.stderr.write('usage: spec-shape.mjs <TypeName> [--member <key>] [--union] [--file <d.ts>]\n')
    return 2
  }
  const decl = declarationOf(readFileSync(file, 'utf8'), name)
  if (!decl) {
    process.stderr.write(`[spec-shape] no declaration named ${name} in ${file}\n`)
    return 3
  }
  if (args.includes('--union')) {
    if (!/^(?:export\s+)?(?:declare\s+)?type\s/.test(decl)) {
      process.stderr.write(`[spec-shape] ${name} is not a type alias\n`)
      return 5
    }
    process.stdout.write(unionMembers(decl).join('\n') + '\n')
    return 0
  }
  if (member) {
    const hit = members(decl).find((m) => m.key === member)
    if (!hit) {
      process.stderr.write(`[spec-shape] ${name} has no member ${member}\n`)
      return 4
    }
    process.stdout.write(hit.text + '\n')
    return 0
  }
  process.stdout.write(decl + '\n')
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv)
}
