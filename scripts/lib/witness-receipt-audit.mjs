import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_WITNESS_OUT = join(REPO_ROOT, '.gm', 'witness-out')
const DEFAULT_PRD = join(REPO_ROOT, '.gm', 'prd.yml')
const DEFAULT_LOG = join(REPO_ROOT, '.gm', 'witness-log.md')
const RECEIPT_PREFIX = '.gm/witness-out/'
const DISPATCH_ID = /\d{13}-\d+-[0-9a-f]{16}/
const RECEIPT_MENTION = /\.gm\/witness-out\/[^\s'"`,;)\]]+/
const NOT_A_CONCRETE_PATH = /[*{}$<>]/
const SHA256_HEX = /^[0-9a-f]{64}$/
const VERDICT_GLOBAL = /RESULT\s*[:=]\s*"?\s*(PASS|FAIL)\b/g
const VERDICT_FIRST = /RESULT\s*[:=]\s*"?\s*(PASS|FAIL)\b/
const ENTRY_START = /^(\d{4}-\d{2}-\d{2}T|W\d+ )/
const LOG_ENTRY_LINES = 4
const SHOWN_IDS = 10

function unquote(raw) {
  const value = (raw ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  return value === 'null' || value === '~' ? '' : value
}

function parseLatestBlocks(prdText) {
  const blocks = []
  let current = null
  for (const line of prdText.split(/\r?\n/)) {
    const head = /^- id:\s*(.*)$/.exec(line)
    if (head !== null) {
      current = { id: unquote(head[1]), raw: [] }
      blocks.push(current)
    } else if (current !== null) {
      current.raw.push(line)
    }
  }
  const latest = new Map()
  for (const block of blocks) {
    if (block.id !== '') latest.set(block.id, block)
  }
  return latest
}

function topField(raw, key) {
  const start = raw.findIndex(line => line.startsWith(`  ${key}:`))
  if (start === -1) return ''
  const parts = [raw[start].slice(key.length + 3)]
  for (let i = start + 1; i < raw.length && !/^  \S/.test(raw[i]); i++) parts.push(raw[i])
  return unquote(parts.join(' ').replace(/\s+/g, ' '))
}

function nestedFields(raw, key) {
  const header = raw.findIndex(line => line.trim() === `${key}:`)
  if (header === -1) return null
  const indent = raw[header].search(/\S/)
  const fields = {}
  for (let i = header + 1; i < raw.length; i++) {
    if (raw[i].trim() === '') continue
    const field = /^(\s*)([A-Za-z_]\w*):\s?(.*)$/.exec(raw[i])
    if (field === null || field[1].length <= indent) break
    fields[field[2]] = unquote(field[3])
  }
  return fields
}

function resolveReceipt(outputPath, witnessOut) {
  const rel = outputPath.replace(/\\/g, '/')
  if (!rel.startsWith(RECEIPT_PREFIX)) return { scope: 'outside' }
  const sub = rel.slice(RECEIPT_PREFIX.length)
  if (sub === '' || isAbsolute(sub) || sub.split('/').includes('..')) return { scope: 'unsafe' }
  const file = resolve(witnessOut, sub)
  const inside = relative(witnessOut, file)
  if (inside === '' || isAbsolute(inside) || inside.startsWith('..')) return { scope: 'unsafe' }
  return { scope: 'inside', file }
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile()
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function lastVerdict(text) {
  let verdict = null
  for (const match of text.matchAll(VERDICT_GLOBAL)) verdict = match[1]
  return verdict
}

function entryText(logLines, at) {
  const entry = [logLines[at]]
  for (let i = at + 1; i < logLines.length && i < at + LOG_ENTRY_LINES; i++) {
    if (logLines[i].trim() === '' || ENTRY_START.test(logLines[i])) break
    entry.push(logLines[i])
  }
  return entry.join('\n')
}

function logVerdict(logLines, needle) {
  let found = false
  for (let at = 0; at < logLines.length; at++) {
    if (!logLines[at].includes(needle)) continue
    found = true
    const match = VERDICT_FIRST.exec(entryText(logLines, at))
    if (match !== null) return { found, verdict: match[1] }
  }
  return { found, verdict: null }
}

export function auditReceipts({ witnessOut = DEFAULT_WITNESS_OUT, prdText, logText, onlyRow = null }) {
  const latest = parseLatestBlocks(prdText)
  const logLines = logText.split(/\r?\n/)
  const summary = {
    completed: 0,
    shaBound: 0,
    dispatchBound: 0,
    unbound: 0,
    outsideWitnessOut: 0,
    checked: 0,
    shaChecked: 0,
    dispatchChecked: 0,
    noReceiptNamed: [],
    mismatches: [],
  }
  const mismatch = (row, receipt, reason, detail = '') => summary.mismatches.push({ row, receipt, reason, detail })

  for (const [id, block] of latest) {
    if (topField(block.raw, 'status') !== 'completed') continue
    summary.completed += 1
    const selected = onlyRow === null || id === onlyRow
    const binding = nestedFields(block.raw, 'witness_binding')
    const witness = topField(block.raw, 'witness')
    const dispatch = (DISPATCH_ID.exec(witness) ?? [null])[0]

    if (binding !== null) {
      const expected = (binding.output_sha256 ?? '').toLowerCase()
      const outputPath = binding.output_path ?? ''
      if (!SHA256_HEX.test(expected)) {
        if (selected) mismatch(id, outputPath, 'binding-sha-missing')
        continue
      }
      summary.shaBound += 1
      const receipt = resolveReceipt(outputPath, witnessOut)
      if (receipt.scope === 'outside') {
        summary.outsideWitnessOut += 1
        continue
      }
      if (!selected) continue
      summary.checked += 1
      summary.shaChecked += 1
      if (receipt.scope === 'unsafe') {
        mismatch(id, outputPath, 'unsafe-path')
      } else if (!isFile(receipt.file)) {
        mismatch(id, outputPath, 'receipt-missing')
      } else {
        const actual = sha256Of(receipt.file)
        if (actual !== expected) mismatch(id, outputPath, 'sha256-differs', `expected=${expected} actual=${actual}`)
      }
      continue
    }

    if (dispatch === null) {
      summary.unbound += 1
      continue
    }
    summary.dispatchBound += 1
    const token = (RECEIPT_MENTION.exec(witness) ?? [null])[0]
    const mention = token !== null && !NOT_A_CONCRETE_PATH.test(token) ? token : null
    if (mention === null) {
      if (selected) summary.noReceiptNamed.push(id)
      continue
    }
    if (!selected) continue
    const receiptPath = mention.replace(/[.:]+$/, '')
    const receipt = resolveReceipt(receiptPath, witnessOut)
    summary.checked += 1
    summary.dispatchChecked += 1
    if (receipt.scope !== 'inside') {
      mismatch(id, receiptPath, 'unsafe-path')
      continue
    }
    if (!isFile(receipt.file)) {
      mismatch(id, receiptPath, 'receipt-missing')
      continue
    }
    const receiptVerdict = lastVerdict(readFileSync(receipt.file, 'utf8'))
    const byName = logVerdict(logLines, basename(receiptPath))
    const logged = byName.found && byName.verdict !== null ? byName : logVerdict(logLines, dispatch)
    if (!logged.found) mismatch(id, receiptPath, 'log-line-missing', `dispatch=${dispatch}`)
    else if (logged.verdict === null) mismatch(id, receiptPath, 'log-verdict-missing', `dispatch=${dispatch}`)
    else if (receiptVerdict === null) mismatch(id, receiptPath, 'receipt-verdict-missing')
    else if (receiptVerdict !== logged.verdict) mismatch(id, receiptPath, 'verdict-differs', `receipt=${receiptVerdict} log=${logged.verdict}`)
  }
  return summary
}

export function runCli(argv) {
  const option = name => {
    const hit = argv.find(arg => arg.startsWith(`--${name}=`))
    return hit === undefined ? null : hit.slice(name.length + 3)
  }
  const witnessOut = resolve(option('witness-out') ?? DEFAULT_WITNESS_OUT)
  const prdPath = resolve(option('prd') ?? DEFAULT_PRD)
  const logPath = resolve(option('log') ?? DEFAULT_LOG)
  const onlyRow = option('row')
  const summary = auditReceipts({
    witnessOut,
    prdText: readFileSync(prdPath, 'utf8'),
    logText: readFileSync(logPath, 'utf8'),
    onlyRow,
  })
  const scope = onlyRow === null ? '' : ` row=${onlyRow}`
  console.log(`receipt-audit${scope}: completed=${summary.completed} sha-bound=${summary.shaBound} dispatch-bound=${summary.dispatchBound} unbound=${summary.unbound} outside-witness-out=${summary.outsideWitnessOut} checked=${summary.checked} (sha256=${summary.shaChecked} dispatch=${summary.dispatchChecked}) mismatches=${summary.mismatches.length} no-receipt-named=${summary.noReceiptNamed.length}`)
  for (const row of summary.mismatches) {
    console.log(`MISMATCH row=${row.row} receipt=${row.receipt} reason=${row.reason}${row.detail ? ` ${row.detail}` : ''}`)
    console.log(`reopen-required row=${row.row}`)
  }
  if (summary.noReceiptNamed.length > 0) {
    console.log(`no-receipt-named (dispatch id only, not checked): ${summary.noReceiptNamed.slice(0, SHOWN_IDS).join(', ')}${summary.noReceiptNamed.length > SHOWN_IDS ? ' ...' : ''}`)
  }
  const ok = summary.mismatches.length === 0 && summary.checked > 0
  console.log(ok
    ? `RESULT: PASS receipt-audit ${summary.checked} checked receipt(s), 0 mismatches`
    : `RESULT: FAIL receipt-audit ${summary.mismatches.length} mismatch(es) over ${summary.checked} checked receipt(s)`)
  return ok ? 0 : 1
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2))
}
