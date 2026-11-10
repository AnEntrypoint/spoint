import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
const DEFAULT_MODULE = path.join(ROOT, 'scripts/lib/quiesce.mjs')
const BOUND_MS = 3000
const flagValue = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
  return arg ? arg.slice(name.length + 3) : null
}
const modulePath = path.resolve(flagValue('module') ?? DEFAULT_MODULE)

if (process.argv.includes('--child')) {
  const code = Number(flagValue('code'))
  const { exitAfterQuiesce } = await import(pathToFileURL(modulePath).href)
  console.log('child running with piped stdout')
  await exitAfterQuiesce(code)
} else {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push(ok)
    console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
  }
  const runChild = (code) => new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [SELF, '--child', `--code=${code}`, `--module=${modulePath}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (buf) => { out += buf })
    child.on('exit', (exitCode) => resolve({ exitCode, elapsedMs: Date.now() - started, out }))
  })

  for (const code of [0, 1]) {
    const { exitCode, elapsedMs, out } = await runChild(code)
    check(`the child with piped stdout ran to its exit call (code ${code})`, out.includes('child running with piped stdout'))
    check(`exit code ${code} propagates`, exitCode === code, `exit ${exitCode}`)
    check(`exit code ${code} arrives within ${BOUND_MS} ms`, elapsedMs < BOUND_MS, `${elapsedMs} ms`)
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} exitAfterQuiesce ends a piped-stdout child at once with its exit code (${checks.length - failed} of ${checks.length} checks, module ${path.relative(ROOT, modulePath)})`)
  process.exit(failed ? 1 : 0)
}
