import { writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let sequence = 0

function refusal(code, message) {
  const err = new Error(`[script-preflight] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function assertNoTemplateLeak(command) {
  if (typeof command !== 'string') throw refusal('preflight-command-invalid', 'command must be a string')
  if (command.includes('${')) throw refusal('preflight-template-leak', 'a shell command must not contain an unresolved ${...} expression')
  return command
}

function parseDiagnostic(stderr, path) {
  const lines = stderr.split('\n')
  const at = lines.find(line => line.includes(path + ':') && /\d+/.test(line))
  const lineMatch = at?.match(/:(\d+)(?::(\d+))?/)
  const caret = lines.find(line => line.includes('^'))
  return {
    line: lineMatch ? Number(lineMatch[1]) : null,
    column: lineMatch?.[2] ? Number(lineMatch[2]) : (caret ? caret.indexOf('^') + 1 : null),
    message: lines.filter(Boolean).slice(0, 4).join(' | ').slice(0, 400),
  }
}

export function preflight(source, { filename = 'generated.mjs' } = {}) {
  if (typeof source !== 'string' || !source) throw refusal('preflight-source-invalid', 'source must be a non-empty string')
  if (!/^[a-zA-Z0-9_.-]+\.(mjs|js|cjs)$/.test(filename)) throw refusal('preflight-filename-invalid', 'filename must end in .mjs, .js or .cjs')
  sequence += 1
  const path = join(tmpdir(), `spoint-preflight-${process.pid}-${sequence}-${filename}`)
  writeFileSync(path, source, 'utf8')
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
    return { ok: true, line: null, column: null, message: null }
  } catch (err) {
    const detail = parseDiagnostic(String(err?.stderr ?? err?.message ?? err), path)
    return { ok: false, ...detail, reasonCode: 'preflight-syntax-error' }
  } finally {
    unlinkSync(path)
  }
}
