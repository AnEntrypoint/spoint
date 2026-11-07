#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TARGET_BYTES = 30 * 1024

export function sizeReport(path) {
  const bytes = statSync(path).size
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n').length
  return { bytes, lines, target: TARGET_BYTES, overBy: Math.max(0, bytes - TARGET_BYTES) }
}

function main() {
  const r = sizeReport(ROOT + 'AGENTS.md')
  console.log('AGENTS.md: ' + r.bytes + ' bytes, ' + r.lines + ' lines; target 30 KB = ' + r.target + ' bytes')
  if (r.overBy > 0) console.log('over target by ' + r.overBy + ' bytes (reported only; no gate enforces the target)')
  else console.log('within target by ' + (r.target - r.bytes) + ' bytes')
  console.log('RESULT: PASS size report is non-failing; exit 0 regardless of size')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
