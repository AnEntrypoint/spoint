import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TARGET_DIR = join(REPO_ROOT, 'scripts')
const SKIP_DIRS = new Set(['lib', 'tsl-parity', 'data'])
const MAX_EVIDENCE_PER_CHECK = 3
const LONG_ARM_LINES = 10
const BOOLISH_DEFAULT = /^(true|false|on|off|yes|no|bare|full|all|none|auto|predict|enabled|disabled|strict)$/i
const MODE_GATED_NAME = /(BASELINE|CONTROL|REF|REFERENCE|VERBOSE|DEBUG|DUMP|STRICT|CHECK)/i
const COUNTER_NAME = /(?:count|Count|total|Total|num|Num|hits|Hits|sum|Sum|ticks|Ticks|samples|Samples|frames|Frames|calls|Calls)$/
const DEFAULT_NAME_FILTER = /(witness|harness|gate)/i

function walk(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...walk(full))
      continue
    }
    if (entry.name.startsWith('.')) continue
    if (extname(entry.name) !== '.mjs' && extname(entry.name) !== '.js') continue
    out.push(full)
  }
  return out
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

function evidence(text, re, cap = MAX_EVIDENCE_PER_CHECK) {
  const rows = []
  for (const m of text.matchAll(re)) {
    rows.push({ line: lineOf(text, m.index), text: m[0].trim().slice(0, 160) })
    if (rows.length >= cap) break
  }
  return rows
}

function has(text, re) {
  return re.test(text)
}

function quotedDefaultOf(rhs) {
  const coalesce = /(?:[?][?]|\|\|)\s*'([^']*)'/.exec(rhs)
  if (coalesce) return coalesce[1]
  const trailing = /,\s*'([^']*)'\s*\)/.exec(rhs)
  if (trailing) return trailing[1]
  return null
}

const HIGH_CHECKS = [
  {
    id: 'verdict-cannot-fail',
    why: 'prints PASS with no FAIL literal, no non-zero exit and no throw, so the verdict is a constant',
    find(text) {
      if (!has(text, /RESULT/) || !has(text, /\bPASS\b/)) return []
      if (has(text, /\bFAIL\b/) || has(text, /process\.exit\(\s*[1-9]/) || has(text, /throw\s+new/)) return []
      return evidence(text, /.*RESULT.*PASS.*/g)
    },
  },
  {
    id: 'verdict-not-a-decision',
    why: 'prints a RESULT payload with neither PASS nor FAIL anywhere, so nothing downstream can decide',
    find(text) {
      if (!has(text, /RESULT/)) return []
      if (has(text, /\bPASS\b/) || has(text, /\bFAIL\b/)) return []
      return evidence(text, /.*RESULT.*/g)
    },
  },
  {
    id: 'bare-exit-zero',
    why: 'exits 0 with no FAIL literal and no non-zero exit anywhere, so it cannot report a failure',
    find(text) {
      if (!has(text, /process\.exit\(\s*0\s*\)/)) return []
      if (has(text, /\bFAIL\b/) || has(text, /process\.exit\(\s*[1-9]/)) return []
      return evidence(text, /.*process\.exit\(\s*0\s*\).*/g)
    },
  },
  {
    id: 'bare-flag-parses-to-true',
    why: 'a bare flag parses to the string "true", so Number() of that flag yields NaN and silently disables the mechanism',
    find(text) {
      if (!has(text, /=\s*'true'/)) return []
      const rows = []
      for (const m of text.matchAll(/Number\(\s*(?:args|argv|opts|flags|parsed|config)\s*[.[]/g)) {
        rows.push({ line: lineOf(text, m.index), text: `${m[0]}... -- bare flags parse to 'true'` })
        if (rows.length >= MAX_EVIDENCE_PER_CHECK) break
      }
      return rows
    },
  },
  {
    id: 'nan-flag',
    why: 'Number() applied to a value defaulting to a boolean-ish string, so the flag yields NaN',
    find(text) {
      const rows = []
      for (const m of text.matchAll(/Number\(\s*'([^']*)'\s*\)/g)) {
        if (!BOOLISH_DEFAULT.test(m[1])) continue
        rows.push({ line: lineOf(text, m.index), text: m[0].trim().slice(0, 160) })
      }
      const defaults = new Map()
      for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
        defaults.set(m[1], { rhs: m[2], line: lineOf(text, m.index) })
      }
      for (const m of text.matchAll(/Number\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        const decl = defaults.get(m[1])
        if (!decl) continue
        const quoted = quotedDefaultOf(decl.rhs)
        if (quoted === null || !BOOLISH_DEFAULT.test(quoted)) continue
        rows.push({ line: lineOf(text, m.index), text: `${m[0]} -- ${m[1]} defaults to '${quoted}' at line ${decl.line}` })
      }
      return rows.slice(0, MAX_EVIDENCE_PER_CHECK)
    },
  },
  {
    id: 'self-comparison',
    why: 'compares an expression to itself, so the assertion holds whatever the measurement was',
    find(text) {
      return evidence(text, /(?<![.\w$[\]])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])*)\s*===\s*\1(?![[\w$.])/g)
    },
  },
  {
    id: 'dead-counter',
    why: 'declares a counter at zero and never increments it, so a gate reading it sees a constant',
    find(text) {
      const rows = []
      for (const m of text.matchAll(/(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*0\s*;/g)) {
        const name = m[1]
        if (!COUNTER_NAME.test(name)) continue
        const incremented = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*(?:\\+\\+|--|\\+=|-=|\\*=|\\/=|=[^=])`)
        if (incremented.test(text)) continue
        rows.push({ line: lineOf(text, m.index), text: m[0].trim().slice(0, 160) })
      }
      return rows.slice(0, MAX_EVIDENCE_PER_CHECK)
    },
  },
  {
    id: 'flag-gated-arm',
    why: 'a whole arm of the measurement sits behind a mode constant, so the default run never executes it',
    find(text) {
      const rows = []
      for (const m of text.matchAll(/^if\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/gm)) {
        const name = m[1]
        if (!MODE_GATED_NAME.test(name)) continue
        const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]*)`).exec(text)
        if (!decl || !/(process\.env|argv|has\(|flag\(|valueOf\(|args\.|opts\.)/.test(decl[1])) continue
        const rest = text.slice(m.index)
        const closeAt = rest.indexOf('\n}')
        const armLines = closeAt === -1 ? 0 : rest.slice(0, closeAt).split('\n').length
        if (armLines < LONG_ARM_LINES) continue
        rows.push({ line: lineOf(text, m.index), text: `${m[0].trim()} -- ${armLines} line(s) gated` })
      }
      return rows.slice(0, MAX_EVIDENCE_PER_CHECK)
    },
  },
]

const LOW_CHECKS = [
  {
    id: 'empty-catch',
    why: 'swallows an error with no handler body, so a failure in the measured path is invisible',
    find(text) {
      const rows = evidence(text, /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)
      rows.push(...evidence(text, /\.catch\(\s*(?:\([^)]*\))?\s*(?:=>)?\s*\{\s*\}\s*\)/g))
      return rows.slice(0, MAX_EVIDENCE_PER_CHECK)
    },
  },
]

function audit(file, checks) {
  const text = readFileSync(file, 'utf8')
  const rows = []
  for (const check of checks) {
    for (const hit of check.find(text)) rows.push({ check: check.id, why: check.why, ...hit })
  }
  return rows
}

function main() {
  const argv = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const showLow = process.argv.includes('--all')
  const allFiles = process.argv.includes('--all-files')
  let files = argv.length > 0 ? argv.map(p => resolve(p)) : walk(TARGET_DIR)
  if (argv.length === 0 && !allFiles) files = files.filter(f => DEFAULT_NAME_FILTER.test(basename(f)))
  const report = []
  for (const file of files) {
    let stat
    try { stat = statSync(file) } catch { continue }
    if (!stat.isFile()) continue
    report.push({
      file: relative(REPO_ROOT, file),
      high: audit(file, HIGH_CHECKS),
      low: audit(file, LOW_CHECKS),
    })
  }
  report.sort((a, b) => b.high.length - a.high.length)
  let total = 0
  for (const entry of report) {
    if (entry.high.length === 0) continue
    total += entry.high.length
    console.log(`${entry.file}  (${entry.high.length})`)
    for (const row of entry.high) console.log(`  ${row.line}: [${row.check}] ${row.text}`)
  }
  const lowOnly = report.filter(e => e.low.length > 0)
  if (showLow) {
    for (const entry of lowOnly) {
      console.log(`${entry.file}  (${entry.low.length} low)`)
      for (const row of entry.low) console.log(`  ${row.line}: [${row.check}] ${row.text}`)
    }
  } else if (lowOnly.length > 0) {
    console.log(`witness-audit: ${lowOnly.length} file(s) hold empty-catch findings only -- pass --all for their lines`)
  }
  console.log(`witness-audit: ${report.length} file(s) scanned, ${total} high-signal finding(s)`)
}

main()
