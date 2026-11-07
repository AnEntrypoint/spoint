import fs from 'node:fs'
import os from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const ARGS = process.argv.slice(2)
const POSITIONAL = ARGS.filter(a => !a.startsWith('--'))
const option = (name, fallback) => {
  const hit = ARGS.find(a => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : fallback
}
const AUDIT = option('audit', '/tmp/hy3d-sd-audit.md')
const HY3D = option('hy3d', '/workspace/hy3d')
const SPOINT = '/workspace/spoint'
const AUDIT_PREFIX = '/workspace/hy3d/'
const TICK = String.fromCharCode(96)

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { ok: r.status === 0, code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

let PIN = null
let SCRATCH = null

function relOf(file) {
  return relative(HY3D, file)
}

function toLocal(p) {
  return join(HY3D, p.slice(AUDIT_PREFIX.length))
}

function readText(file) {
  if (PIN === null) return fs.readFileSync(file, 'utf8')
  const r = run('git', ['-C', HY3D, 'show', PIN + ':' + relOf(file)])
  if (!r.ok) throw new Error('git show ' + PIN + ':' + relOf(file) + ' failed: ' + r.err.trim())
  return r.out
}

function materialize(file) {
  if (PIN === null) return file
  if (SCRATCH === null) SCRATCH = fs.mkdtempSync(join(os.tmpdir(), 'hy3d-sweep-'))
  const dst = join(SCRATCH, relOf(file))
  fs.mkdirSync(dirname(dst), { recursive: true })
  fs.writeFileSync(dst, readText(file))
  return dst
}

function sectionLines(lines, startPrefix, endPrefix) {
  const start = lines.findIndex(l => l.startsWith(startPrefix))
  if (start < 0) return []
  let end = lines.findIndex((l, i) => i > start && l.startsWith(endPrefix))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end)
}

function parseAudit() {
  const lines = fs.readFileSync(AUDIT, 'utf8').split(/\r?\n/)
  const tableLines = sectionLines(lines, '## Per-file table', '## Comment lines')
  const commentLines = sectionLines(lines, '## Comment lines', '## Redacted possible-secret list')
  const secretLines = sectionLines(lines, '## Redacted possible-secret list', '## Caveats')
  const table = []
  const shebangs = []
  const findings = []
  for (const line of tableLines) {
    if (line.startsWith('| ' + TICK + '/workspace/hy3d/')) {
      const parts = line.split(TICK)
      if (parts.length > 1) table.push(toLocal(parts[1]))
    }
  }
  for (const line of commentLines) {
    if (line.startsWith('- ' + TICK + '/workspace/hy3d/') && line.includes('[shebang]')) {
      const parts = line.split(TICK)
      if (parts.length > 1) shebangs.push(toLocal(parts[1].split(':')[0]))
    }
  }
  for (const line of secretLines) {
    if (line.startsWith('- ' + TICK + '/workspace/hy3d/') && line.includes(' - ')) {
      const parts = line.split(TICK)
      if (parts.length > 1) {
        const rest = line.slice(line.indexOf(' - ') + 3)
        const kind = rest.replace(/\s*\| value: \[REDACTED\].*$/, '')
        findings.push({ file: toLocal(parts[1].split(':')[0]), kind })
      }
    }
  }
  return { table: [...new Set(table)], shebangs: [...new Set(shebangs)], findings }
}

function commentKind(line) {
  const t = line.trimStart()
  if (t.startsWith('#!')) return 'shebang'
  if (t.startsWith('//')) return 'line-comment'
  if (t.startsWith('#')) return 'hash-comment'
  if (t.startsWith('/*')) return 'block-comment'
  if (t.startsWith('*')) return 'block-comment'
  if (t.startsWith('<!--')) return 'html-comment'
  return null
}

const JS_FILE = /\.(m?js|cjs)$/
const HASH_FILE = /\.(py|sh)$/
const HEREDOC = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])

function regexAllowed(last) {
  if (last === '' || REGEX_KEYWORDS.has(last)) return true
  return !['id', 'num', 'str', 'regex', ')', ']'].includes(last)
}

function lineEnd(text, i) {
  const e = text.indexOf('\n', i)
  return e < 0 ? text.length : e
}

function skipQuoted(text, i, escapes) {
  const q = text[i]
  let j = i + 1
  while (j < text.length && text[j] !== '\n') {
    if (escapes && text[j] === '\\') {
      if (text[j + 1] === '\n') return j + 1
      j += 2
      continue
    }
    if (text[j] === q) return j + 1
    j++
  }
  return j
}

function regexEnd(text, i) {
  let inClass = false
  let j = i
  while (j < text.length && text[j] !== '\n') {
    const c = text[j]
    if (c === '\\') {
      if (text[j + 1] === '\n') return -1
      j += 2
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
    } else if (c === '[') {
      inClass = true
    } else if (c === '/') {
      j++
      while (j < text.length && /[a-z]/i.test(text[j])) j++
      return j
    }
    j++
  }
  return -1
}

function scanJs(text) {
  const found = []
  const n = text.length
  const frames = [{ tpl: false, expr: false, depth: 0 }]
  let line = 1
  let last = ''
  let i = 0
  if (text.startsWith('#!')) {
    found.push({ line: 1, kind: 'shebang' })
    i = lineEnd(text, 0)
  }
  while (i < n) {
    const frame = frames[frames.length - 1]
    const c = text[i]
    if (frame.tpl) {
      if (c === '\\') {
        if (text[i + 1] === '\n') line++
        i += 2
      } else if (c === '\x60') {
        frames.pop()
        last = 'str'
        i++
      } else if (c === '\x24' && text[i + 1] === '\x7b') {
        frames.push({ tpl: false, expr: true, depth: 0 })
        last = '{'
        i += 2
      } else {
        if (c === '\n') line++
        i++
      }
    } else if (c === '\n') {
      line++
      i++
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      found.push({ line, kind: 'line-comment' })
      i = lineEnd(text, i)
    } else if (c === '/' && text[i + 1] === '*') {
      found.push({ line, kind: 'block-comment' })
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      for (let k = i; k < stop; k++) if (text[k] === '\n') line++
      i = stop
    } else if (c === '/' && regexAllowed(last) && regexEnd(text, i + 1) > 0) {
      i = regexEnd(text, i + 1)
      last = 'regex'
    } else if (c === '/') {
      last = '/'
      i++
    } else if (c === '"' || c === "'") {
      i = skipQuoted(text, i, true)
      last = 'str'
    } else if (c === '\x60') {
      frames.push({ tpl: true, expr: false, depth: 0 })
      i++
    } else if (c === '{') {
      frame.depth++
      last = '{'
      i++
    } else if (c === '}') {
      if (frame.expr && frame.depth === 0) {
        frames.pop()
        last = 'str'
      } else {
        frame.depth--
        last = '}'
      }
      i++
    } else if (/[A-Za-z_$#]/.test(c)) {
      let j = i + 1
      while (j < n && /[\w$]/.test(text[j])) j++
      const word = text.slice(i, j)
      last = REGEX_KEYWORDS.has(word) ? word : 'id'
      i = j
    } else if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[\w.]/.test(text[j])) j++
      last = 'num'
      i = j
    } else {
      last = c
      i++
    }
  }
  return found
}

function scanHash(text, isPy) {
  const found = []
  const n = text.length
  const pending = []
  let line = 1
  let i = 0
  if (text.startsWith('#!')) {
    found.push({ line: 1, kind: 'shebang' })
    i = lineEnd(text, 0)
  }
  while (i < n) {
    const c = text[i]
    if (c === '\n') {
      line++
      i++
      for (const h of pending.splice(0)) {
        let done = false
        while (!done && i < n) {
          const e = lineEnd(text, i)
          const raw = text.slice(i, e)
          const cmp = h.dash ? raw.replace(/^\t+/, '') : raw
          if (e < n) line++
          i = e < n ? e + 1 : n
          done = cmp === h.tag
        }
      }
    } else if (!isPy && c === '<' && text[i + 1] === '<' && HEREDOC.test(text.slice(i, i + 120))) {
      const m = HEREDOC.exec(text.slice(i, i + 120))
      pending.push({ dash: m[1] === '-', tag: m[3] })
      i += m[0].length
    } else if (isPy && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const q = text.slice(i, i + 3)
      const close = text.indexOf(q, i + 3)
      const stop = close < 0 ? n : close + 3
      for (let k = i; k < stop; k++) if (text[k] === '\n') line++
      i = stop
    } else if (c === '"' || c === "'") {
      i = skipQuoted(text, i, c === '"' || isPy || (c === "'" && text[i - 1] === '$' && text[i - 2] !== '$'))
    } else if (c === '#' && text[i - 1] !== '$' && text[i - 1] !== '{') {
      found.push({ line, kind: 'hash-comment' })
      i = lineEnd(text, i)
    } else {
      i++
    }
  }
  return found
}

function scanLines(text) {
  const found = []
  text.split(/\r?\n/).forEach((line, i) => {
    const kind = commentKind(line)
    if (kind) found.push({ line: i + 1, kind })
  })
  return found
}

function scanText(file, text) {
  if (JS_FILE.test(file)) return scanJs(text)
  if (HASH_FILE.test(file)) return scanHash(text, file.endsWith('.py'))
  return scanLines(text)
}

const CONTROLS = [
  ['a.mjs', 'const a = 1 // note', ['line-comment@1']],
  ['a.mjs', "const u = 'http://x' // y", ['line-comment@1']],
  ['a.mjs', "const u = 'http://x'", []],
  ['a.mjs', 'x = 1 /* c */', ['block-comment@1']],
  ['a.mjs', 'const s = \x60line one // not a comment\nline two\x60', []],
  ['a.mjs', 'const s = \x60a \x24{ f(1) // real\n}\x60', ['line-comment@1']],
  ['a.mjs', '/* a\n // b\n*/ x', ['block-comment@1']],
  ['a.mjs', 'const r = /\\/\\//', []],
  ['a.mjs', 'const r = /[/]x/', []],
  ['a.mjs', 'const d = a / b // c', ['line-comment@1']],
  ['a.mjs', 'function f() { return /a\\/\\/b/ }', []],
  ['a.mjs', "const s = 'it\\'s // no'", []],
  ['a.mjs', '#!/usr/bin/env node\nconst a = 1 // x', ['shebang@1', 'line-comment@2']],
  ['a.mjs', 'const t = \x60a\nb\x60;\nconst u = 1 // z', ['line-comment@3']],
  ['a.sh', 'echo a # c', ['hash-comment@1']],
  ['a.sh', 'echo \x24{#arr}', []],
  ['a.sh', 'echo \x24#', []],
  ['a.sh', "echo 'a # b'", []],
  ['a.sh', 'cat <<EOF\n# not a comment\nEOF\necho ok # real', ['hash-comment@4']],
  ['a.sh', "cat <<-'X'\n\t# body\n\tX\necho # c", ['hash-comment@4']],
  ['a.sh', "echo $'a\\'b' # real", ['hash-comment@1']],
  ['a.sh', "echo $'a#b' # real", ['hash-comment@1']],
  ['a.sh', "echo $'x\\\\' # real", ['hash-comment@1']],
  ['a.sh', "echo 'a\\' # real", ['hash-comment@1']],
  ['a.py', 'x = 1  # c', ['hash-comment@1']],
  ['a.py', 'x = """a\n# not\n"""\ny = 2 # c', ['hash-comment@4']],
  ['a.py', "x = '#not' ", []],
  ['a.py', '#!/usr/bin/env python3\nx = 1', ['shebang@1']],
  ['d.tsv', '# x\na', ['hash-comment@1']]
];

function controlFailures() {
  return CONTROLS
    .map(([file, text, want]) => ({ file, text, want, got: scanText(file, text).map(v => v.kind + '@' + v.line) }))
    .filter(x => x.got.join(',') !== x.want.join(','));
}

function commentViolations(file, shebangSet) {
  return scanText(file, readText(file)).filter(v => !(v.kind === 'shebang' && v.line === 1 && shebangSet.has(file)));
}

function shebangKept(file) {
  const first = readText(file).split(/\r?\n/)[0] || ''
  return first.trimStart().startsWith('#!')
}

const RAW_SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  /https?:\/\/[^\s/]*:[^\s/@]+@/g,
]

function rawSecretHitsIn(text) {
  return RAW_SECRET_PATTERNS.reduce((n, p) => n + (text.match(new RegExp(p.source, p.flags)) || []).length, 0)
}

function rawSecretHits(file) {
  return rawSecretHitsIn(readText(file))
}

const ENV_REF = /process\.env\.|import\.meta\.env|os\.environ|secrets\.|Deno\.env|getenv\(|ENV\[/g
const AUTH_REF = /Authorization|authorization|Bearer|bearer|X-API-Key|api[_-]?key/gi

function referenceCount(file, kind) {
  const text = readText(file)
  const re = /environment variable/.test(kind) ? ENV_REF : AUTH_REF
  return (text.match(new RegExp(re.source, re.flags)) || []).length
}

function tsvCheck(file) {
  const lines = readText(file).split(/\r?\n/).filter(l => l.length > 0)
  if (!lines.length) return { ok: false, out: '', err: 'empty TSV' }
  const cols = lines[0].split('\t').length
  const bad = lines.filter(l => l.split('\t').length !== cols).length
  return { ok: bad === 0, out: 'rows=' + lines.length + ' cols=' + cols, err: bad ? 'column_mismatch=' + bad : '' }
}

function syntaxCheck(file) {
  if (/\.tsv$/.test(file)) return tsvCheck(file)
  const target = materialize(file)
  if (/\.(mjs|js)$/.test(file)) return run('node', ['--check', target])
  if (/\.py$/.test(file)) return run('python3', ['-c', "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", target])
  if (/\.sh$/.test(file)) return run('bash', ['-n', target])
  return { ok: true, out: 'no-syntax-check', err: '' }
}

function commitChecks(sha, files) {
  const fetch = run('git', ['-C', HY3D, 'fetch', 'origin', 'main'])
  const show = run('git', ['-C', HY3D, 'show', '-s', '--format=%H%n%an%n%ae%n%cn%n%ce%n%B', sha])
  if (!show.ok) return { ok: false, reason: 'git-show-failed' }
  const parts = show.out.trim().split('\n')
  const full = parts[0]
  const an = parts[1]
  const ae = parts[2]
  const cn = parts[3]
  const ce = parts[4]
  const bodyText = parts.slice(5).join('\n')
  const authorOk = an === 'lanmower' && cn === 'lanmower'
  const trailerFree = !/Co-Authored-By|Generated with/i.test(bodyText)
  const ls = run('git', ['-C', HY3D, 'ls-remote', 'origin', 'main'])
  const remoteLine = ls.out.trim().split('\n')[0] || ''
  const remote = remoteLine.split(/\s+/)[0] || ''
  const ancestry = run('git', ['-C', HY3D, 'merge-base', '--is-ancestor', sha, remote])
  const pushedOk = remote.startsWith(sha) || remote === full || (ancestry.ok && remote.length > 0)
  const tree = run('git', ['-C', HY3D, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha])
  const paths = tree.out.trim().split('\n').filter(Boolean)
  const rel = files.map(relOf)
  const missing = rel.filter(p => !paths.includes(p))
  const envCommitted = paths.includes('.env')
  const status = run('git', ['-C', HY3D, 'status', '--porcelain', '--', ...rel])
  const clean = status.out.trim().length === 0
  const ok = fetch.ok && authorOk && trailerFree && pushedOk && missing.length === 0 && !envCommitted && clean
  return { ok, fetched: fetch.ok, full, an, ae, cn, ce, remote, pushedOk, trailerFree, authorOk, paths: paths.length, missing, envCommitted, clean }
}

function spointState() {
  const status = run('git', ['-C', SPOINT, 'status', '--porcelain', '--untracked-files=no'])
  const tracked = status.out.trim().split('\n').filter(Boolean).length
  const head = run('git', ['-C', SPOINT, 'rev-parse', '--short', 'HEAD']).out.trim()
  const ls = run('git', ['-C', SPOINT, 'ls-remote', 'origin', 'main'])
  const remote = (ls.out.trim().split('\n')[0] || '').split(/\s+/)[0].slice(0, 7)
  return { tracked, head, remote, unchanged: tracked === 0 && head.length > 0 && head === remote }
}

function buildReport(s) {
  const lines = []
  lines.push('# hy3d comment sweep independent verification')
  lines.push('')
  lines.push('Commit: ' + s.sha)
  lines.push('Result: ' + (s.pass ? 'PASS' : 'FAIL'))
  lines.push('Generated from read-only checks; no repository file was edited by spoint.')
  lines.push('')
  lines.push('## Method')
  lines.push('Parsed /tmp/hy3d-sd-audit.md for the 37 audited paths, 6 original shebang files and 9 redacted possible-secret findings.')
  lines.push('No .env file was read; no secret values were printed or stored; no shell grep or find was used.')
  lines.push('Syntax checks: node --check for .mjs/.js, ast.parse for .py, bash -n for .sh, column-count check for .tsv.')
  lines.push('Commit checks: git show, git ls-remote, git merge-base, git diff-tree, git status --porcelain for the 37 paths.')
  lines.push('')
  lines.push('## Done-condition checks')
  lines.push('Prose comment violations: ' + s.violationCount + (s.commentFindings.length ? ' in ' + s.commentFindings.map(x => x.file + ':' + x.violations.length).join(', ') : ''))
  lines.push('Shebangs kept: ' + (s.shebangSetSize - s.shebangMissing.length) + '/' + s.shebangSetSize + (s.shebangMissing.length ? '; missing: ' + s.shebangMissing.join(', ') : ''))
  lines.push('Code references present: ' + s.refTotal + ' token matches across ' + s.refChecks.length + ' finding files; missing: ' + (s.refMissing.length ? s.refMissing.join(', ') : 'none'))
  lines.push('Removed references: ' + (s.removedRefs.length ? s.removedRefs.join(', ') : 'none') + ' (expected after the prose comment sweep; no raw values printed)')
  lines.push('Raw secret value patterns in files: ' + s.rawFileHits)
  lines.push('Raw secret value patterns in this report: ' + s.reportRaw)
  lines.push('Syntax checks passed: ' + (s.syntax.length - s.syntaxFailures.length) + '/' + s.syntax.length + (s.syntaxFailures.length ? '; failures: ' + s.syntaxFailures.join(', ') : ''))
  lines.push('Commit ok: ' + s.commit.ok + '; authorOk=' + s.commit.authorOk + '; pushedOk=' + s.commit.pushedOk + '; trailerFree=' + s.commit.trailerFree + '; clean=' + s.commit.clean + '; envCommitted=' + s.commit.envCommitted)
  lines.push('Commit: full=' + (s.commit.full || 'n/a') + ' author=' + (s.commit.an || 'n/a') + ' committer=' + (s.commit.cn || 'n/a') + ' remote=' + (s.commit.remote || 'n/a') + ' paths=' + (s.commit.paths || 0) + ' missing=' + (s.commit.missing ? s.commit.missing.length : 0) + (s.commit.reason ? ' reason=' + s.commit.reason : ''))
  if (s.commit.missing && s.commit.missing.length) lines.push('Missing from commit: ' + s.commit.missing.join(', '))
  lines.push('Spoint state (informational): tracked=' + s.spoint.tracked + ' head=' + s.spoint.head + ' remote=' + s.spoint.remote + ' unchanged=' + s.spoint.unchanged)
  lines.push('')
  lines.push('## Caveats')
  s.caveats.forEach(c => lines.push('- ' + c))
  lines.push('')
  lines.push('Result: ' + (s.pass ? 'PASS' : 'FAIL'))
  return lines.join('\n') + '\n'
}

const audit = parseAudit()
const files = audit.table
const shebangSet = new Set(audit.shebangs)
const findings = audit.findings

if (ARGS.includes('--self-test')) {
  const exists = files.every(f => fs.existsSync(f))
  const syntax = files.map(f => ({ file: f, ok: syntaxCheck(f).ok }))
  const raw = files.reduce((n, f) => n + rawSecretHits(f), 0)
  const controls = controlFailures()
  const ok = files.length === 37 && shebangSet.size === 6 && findings.length === 9 && exists && syntax.every(x => x.ok) && raw === 0 && controls.length === 0
  console.log(JSON.stringify({ mode: 'self-test', files: files.length, shebangs: shebangSet.size, findings: findings.length, exists, syntaxFailures: syntax.filter(x => !x.ok).map(x => x.file), rawSecretHits: raw, controlCases: CONTROLS.length, controlFailures: controls, ok }))
  process.exit(ok ? 0 : 1)
}

const sha = (POSITIONAL[0] || '').toLowerCase()
if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) {
  console.error('usage: node scripts/hy3d-comment-sweep-verify.mjs [--hy3d=<path>] [--audit=<path>] [--self-test] <commit-sha>')
  process.exit(2)
}

PIN = sha
const commentFindings = files.map(f => ({ file: f, violations: commentViolations(f, shebangSet) })).filter(x => x.violations.length)
const violationCount = commentFindings.reduce((n, x) => n + x.violations.length, 0)
const shebangMissing = [...shebangSet].filter(f => !shebangKept(f))
const rawFileHits = files.reduce((n, f) => n + rawSecretHits(f), 0)
const refChecks = findings.map(f => ({ file: f.file, kind: f.kind, count: referenceCount(f.file, f.kind) }))
const removedRefs = [join(HY3D, 'work/combat/mk-tsv.py')]
const refMissing = refChecks.filter(x => x.count === 0).map(x => x.file).filter(f => !removedRefs.includes(f))
const refTotal = refChecks.reduce((n, x) => n + x.count, 0)
const syntax = files.map(f => ({ file: f, ok: syntaxCheck(f).ok }))
const syntaxFailures = syntax.filter(x => !x.ok).map(x => x.file)
const commit = commitChecks(sha, files)
const spoint = spointState()
const hy3dOk = violationCount === 0 && shebangMissing.length === 0 && rawFileHits === 0 && refMissing.length === 0 && syntaxFailures.length === 0 && commit.ok
const caveats = [
  'Comment detection is lexical; a shebang is allowed only on line 1 of a file that originally had one.',
  'Trailing comments are detected per line; a // or # inside a multi-line string or a JS regex literal can be misread.',
  'Secret matching is heuristic; references remain in code and no literal values were printed or stored.',
  'TSV syntax check verifies a header and uniform tab-delimited column counts only.',
  'Remote push check accepts the commit as origin/main itself or an ancestor of the current origin/main head.',
  'The mk-tsv.py authorization/bearer reference from the original audit was a prose comment removed by the sweep; it is reported as removed, not required.',
  'Spoint state is informational and is not part of the hy3d pass condition.',
  'No .env file was read; no repository file was edited, staged, committed, pushed or deleted by this verification; the only remote operation is a read-only git fetch origin main in hy3d.',
]
const state = { sha, commentFindings, violationCount, shebangSetSize: shebangSet.size, shebangMissing, rawFileHits, refChecks, refTotal, refMissing, removedRefs, syntax, syntaxFailures, commit, spoint, caveats }
const draft = buildReport({ ...state, pass: hy3dOk, reportRaw: 0 })
const reportRaw = rawSecretHitsIn(draft)
const pass = hy3dOk && reportRaw === 0
process.stdout.write(buildReport({ ...state, pass, reportRaw }))
if (SCRATCH !== null) fs.rmSync(SCRATCH, { recursive: true, force: true })
console.log(JSON.stringify({ pass, files: files.length, violationCount, shebangMissing: shebangMissing.length, rawFileHits, refTotal, refMissing: refMissing.length, removedRefs: removedRefs.length, syntaxFailures: syntaxFailures.length, commitOk: commit.ok, spointUnchanged: spoint.unchanged, reportRaw }))
process.exit(pass ? 0 : 1)
