import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
const TAIL_EXIT_WINDOW_LINES = 40
const BASELINE_FILE = '.witness-audit-baseline.json'

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

function catchBlocks(text) {
  const blocks = []
  const re = /catch\s*(?:\([^)]*\))?\s*\{/g
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < text.length && depth > 0) {
      const c = text[i]
      if (c === '{') depth += 1
      else if (c === '}') depth -= 1
      i += 1
    }
    blocks.push({ line: lineOf(text, m.index), body: text.slice(m.index + m[0].length, i - 1) })
  }
  return blocks
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
    id: 'no-verdict-emitted',
    why: 'emits no RESULT, PASS, FAIL or non-zero exit, so a gate that treats exit 0 as the verdict can never see a failure',
    find(text) {
      if (has(text, /RESULT/) || has(text, /\bPASS\b/) || has(text, /\bFAIL\b/) || has(text, /process\.exit\(\s*[1-9]/)) return []
      return [{ line: 1, text: 'no RESULT, PASS, FAIL or non-zero exit anywhere in the file' }]
    },
    witnessesOnly: true,
  },
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
    id: 'tail-exit-always-zero',
    why: 'ends in an unconditional process.exit(0) with no PASS/FAIL vocabulary and no exitCode assignment, so any non-zero exit elsewhere is a setup bail rather than a verdict on the measurement',
    find(text) {
      if (has(text, /\bPASS\b/) || has(text, /\bFAIL\b/)) return []
      if (has(text, /process\.exitCode\s*=/)) return []
      const lines = text.split('\n')
      const rows = []
      for (const m of text.matchAll(/process\.exit\(\s*0\s*\)/g)) {
        const line = lineOf(text, m.index)
        if (lines.length - line > TAIL_EXIT_WINDOW_LINES) continue
        if (/process\.exit\(\s*[1-9]/.test(lines.slice(line - 1).join('\n'))) continue
        rows.push({ line, text: `${m[0].trim()} on line ${line} of ${lines.length} -- no measured value can change it` })
        if (rows.length >= MAX_EVIDENCE_PER_CHECK) break
      }
      return rows
    },
    witnessesOnly: true,
  },
  {
    id: 'verdict-array-never-appended',
    why: 'the exit code is decided by an array length but nothing ever appends to that array, so the verdict is a constant zero',
    find(text) {
      const rows = []
      for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[\s*\]/g)) {
        const name = m[1]
        const escaped = name.replace(/\$/g, '\\$')
        if (!new RegExp(`process\\.exitCode\\s*=\\s*${escaped}\\.length`).test(text)) continue
        if (new RegExp(`\\b${escaped}\\s*\\.\\s*push\\s*\\(`).test(text)) continue
        rows.push({ line: lineOf(text, m.index), text: `${m[0].trim()} -- no ${name}.push( anywhere` })
        if (rows.length >= MAX_EVIDENCE_PER_CHECK) break
      }
      return rows
    },
    witnessesOnly: true,
  },
  {
    id: 'ws-polyfill-missing',
    why: 'reaches a ws:// URL from Node without a globalThis.WebSocket assignment, so on a runner whose Node has no global WebSocket every client fails to connect and the arm exits before it measures anything',
    find(text) {
      if (!has(text, /ws:\/\//)) return []
      if (has(text, /globalThis\.WebSocket\s*=/)) return []
      if (has(text, /from\s+['"]ws['"]/) || has(text, /import\(\s*['"]ws['"]\s*\)/)) return []
      return evidence(text, /['"`]ws:\/\/[^'"`]*['"`]/g)
    },
    witnessesOnly: true,
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
    id: 'swallowed-error',
    why: 'catch block records the error but never rethrows or exits non-zero, so a fatal becomes report data if nothing else decides the verdict',
    find(text) {
      const rows = []
      for (const block of catchBlocks(text)) {
        if (/throw|process\.exit\(|process\.exitCode|reject\(/.test(block.body)) continue
        if (!/console\.|\bpush\(|report|failures|\+=/.test(block.body)) continue
        rows.push({ line: block.line, text: block.body.trim().slice(0, 120) })
        if (rows.length >= MAX_EVIDENCE_PER_CHECK) break
      }
      return rows
    },
  },
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

function gitTrackedScripts() {
  const done = spawnSync('git', ['ls-files', '--', 'scripts'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (done.status !== 0) return null
  return done.stdout.split('\n').map(s => s.trim()).filter(s => /\.(?:mjs|js)$/.test(s))
}

function committedText(rel) {
  const done = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  return done.status === 0 ? done.stdout : null
}

function audit(text, name, checks) {
  const isWitness = DEFAULT_NAME_FILTER.test(name)
  const rows = []
  for (const check of checks) {
    if (check.witnessesOnly && !isWitness) continue
    for (const hit of check.find(text)) rows.push({ check: check.id, why: check.why, ...hit })
  }
  return rows
}

function auditFile(file, checks) {
  return audit(readFileSync(file, 'utf8'), basename(file), checks)
}

function main() {
  const argvAll = process.argv.slice(2)
  const argv = argvAll.filter(a => !a.startsWith('--'))
  const showLow = argvAll.includes('--all')
  const allFiles = argvAll.includes('--all-files')
  const committed = (argvAll.includes('--gate') || argvAll.includes('--write-baseline'))
    ? !argvAll.includes('--worktree')
    : argvAll.includes('--committed')
  const report = []
  if (committed) {
    const tracked = gitTrackedScripts()
    if (tracked === null) {
      console.log('RESULT: FAIL witness-audit cannot list tracked files under scripts, so committed content was not audited')
      process.exit(1)
    }
    for (const rel of tracked) {
      if (rel.split('/')[1] !== undefined && SKIP_DIRS.has(rel.split('/')[1])) continue
      if (rel.split('/').some(seg => seg.startsWith('.') && seg !== '.')) continue
      if (!allFiles && !DEFAULT_NAME_FILTER.test(rel)) continue
      const text = committedText(rel)
      if (text === null) {
        console.log(`RESULT: FAIL witness-audit cannot read HEAD:${rel}, so committed content was not fully audited`)
        process.exit(1)
      }
      report.push({ file: rel, high: audit(text, rel, HIGH_CHECKS), low: audit(text, rel, LOW_CHECKS) })
    }
  } else {
    let files = argv.length > 0 ? argv.map(p => resolve(p)) : walk(TARGET_DIR)
    if (argv.length === 0 && !allFiles) files = files.filter(f => DEFAULT_NAME_FILTER.test(basename(f)))
    for (const file of files) {
      let stat
      try { stat = statSync(file) } catch { continue }
      if (!stat.isFile()) continue
      const text = readFileSync(file, 'utf8')
      const name = relative(REPO_ROOT, file).replace(/\\/g, '/')
      report.push({ file: name, high: audit(text, name, HIGH_CHECKS), low: audit(text, name, LOW_CHECKS) })
    }
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
  if (process.argv.includes('--write-baseline')) {
    const known = {}
    for (const entry of report) {
      if (entry.high.length === 0) continue
      const counts = {}
      for (const row of entry.high) counts[row.check] = (counts[row.check] ?? 0) + 1
      known[entry.file] = counts
    }
    writeFileSync(join(REPO_ROOT, BASELINE_FILE), `${JSON.stringify({ known }, null, 2)}\n`, 'utf8')
    console.log(`witness-audit: wrote ${BASELINE_FILE} with ${Object.keys(known).length} known file(s)`)
    return
  }
  console.log(`witness-audit: ${report.length} file(s) scanned, ${total} high-signal finding(s)`)
  if (!process.argv.includes('--gate')) return
  const baselinePath = join(REPO_ROOT, BASELINE_FILE)
  let baseline = {}
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).known ?? {} }
  catch (e) {
    console.log(`RESULT: FAIL witness-audit baseline ${BASELINE_FILE} is unreadable (${e.message}), so no dead gate can be told apart from a known one`)
    process.exit(1)
  }
  const regressions = []
  const improved = []
  for (const entry of report) {
    const current = {}
    for (const row of entry.high) current[row.check] = (current[row.check] ?? 0) + 1
    const known = baseline[entry.file] ?? {}
    for (const id of new Set([...Object.keys(current), ...Object.keys(known)])) {
      const now = current[id] ?? 0
      const was = known[id] ?? 0
      if (now > was) regressions.push(`${entry.file} [${id}] ${was} -> ${now}`)
      else if (now < was) improved.push(`${entry.file} [${id}] ${was} -> ${now}`)
    }
  }
  if (regressions.length > 0) {
    console.log(`RESULT: FAIL ${regressions.length} new dead gate(s): ${regressions.join('; ')}`)
    process.exit(1)
  }
  for (const line of improved) console.log(`witness-audit: below baseline, so ${BASELINE_FILE} is stale and over-states it: ${line}`)
  console.log(`RESULT: PASS ${report.length} file(s) scanned, ${total} high-signal finding(s), ${regressions.length} new dead gate(s)`)
}

if (process.argv.includes('--receipts')) {
  const { runCli } = await import('./witness-receipt-audit.mjs')
  process.exitCode = runCli(process.argv.slice(2))
} else {
  main()
}
