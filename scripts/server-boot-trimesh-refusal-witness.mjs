import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(REPO_ROOT, 'server.js')
const READY_LINE = '[server] http://localhost:'
const BOOT_TIMEOUT_MS = 240000
const CORRUPT_MODEL = './apps/world/_fixtures/witness-corrupt-static.glb'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

function bootWorld(world, port) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, WORLD: world, PORT: String(port), SPOINT_HOST: '127.0.0.1', SPOINT_SKIP_PREWARM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let listening = false
    let timedOut = false
    let settled = false
    let exitCode = null
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      resolve({ exitCode, listening, timedOut, stdout, stderr })
    }
    const timer = setTimeout(() => { timedOut = true; finish() }, BOOT_TIMEOUT_MS)
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', s => {
      stdout += s
      if (!listening && stdout.includes(READY_LINE)) { listening = true; finish() }
    })
    proc.stderr.on('data', s => { stderr += s })
    proc.on('exit', code => { exitCode = code; finish() })
  })
}

const refused = await bootWorld('trimesh-boot-refusal', 3411)
check('a world whose static trimesh build fails does not finish booting', !refused.timedOut && !refused.listening, refused.timedOut ? 'timed out' : refused.listening ? 'listening' : 'not listening')
check('the refused boot exits non-zero', refused.exitCode !== null && refused.exitCode !== 0, `exit=${refused.exitCode}`)
check('the refusal is a ColliderBuildError', refused.stderr.includes('ColliderBuildError'), refused.stderr.includes('ColliderBuildError') ? '' : refused.stderr.slice(-240))
check('the refusal names the model whose static trimesh build failed', refused.stderr.includes(CORRUPT_MODEL), refused.stderr.includes(CORRUPT_MODEL) ? '' : 'model absent from stderr')

const clean = await bootWorld('trimesh-boot-clean', 3412)
check('a world whose static trimesh build succeeds reaches listening', clean.listening && !clean.timedOut, clean.timedOut ? 'timed out' : clean.listening ? '' : `exit=${clean.exitCode}`)
check('a clean boot raises no ColliderBuildError', !clean.stderr.includes('ColliderBuildError'), clean.stderr.includes('ColliderBuildError') ? clean.stderr.slice(-240) : '')

const failedCount = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failedCount}/${checks.length} checks passed`)
if (failedCount) {
  console.log(`RESULT: FAIL ${failedCount} check(s): ${checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS a world whose static trimesh build fails is refused at boot with a ColliderBuildError naming the model and never listens, and a world whose build succeeds boots and listens')
  await exitAfterQuiesce(0)
}
