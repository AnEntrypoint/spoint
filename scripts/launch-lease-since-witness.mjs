import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquire, sessionDir } from './lib/browser-lease.mjs'

const SELF = fileURLToPath(import.meta.url)
const T0 = Date.now() - 120000
const OWNER = 'launch-retry'
const WAIT_MS = 60000

if (process.argv[2] === 'child') {
  const [root, mode, sinceArg] = process.argv.slice(3)
  if (mode === 'holder') {
    const lease = await acquire({ root, owner: 'holder', waitMs: WAIT_MS })
    console.log('HELD')
    process.stdin.once('data', () => {
      lease.release()
      process.exit(0)
    })
  } else {
    const { launch } = await import('./lib/cdp-browser.mjs')
    console.log('LAUNCHING')
    await launch({ root, owner: OWNER, leaseWaitMs: WAIT_MS, sinceMs: Number(sinceArg) })
    console.log('LAUNCHED')
    process.exit(0)
  }
} else {
  const ticketsIn = (dir) => {
    const waiters = dir + '-waiters'
    if (!fs.existsSync(waiters)) return []
    return fs.readdirSync(waiters).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(waiters, n), 'utf8')))
  }
  const waitFor = async (predicate) => {
    for (let i = 0; i < 1200; i++) {
      const v = predicate()
      if (v) return v
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('condition not reached')
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-lease-'))
  const dir = sessionDir(root)
  const kids = []
  const spawnChild = (args) => {
    const p = spawn(process.execPath, [SELF, 'child', ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
    const lines = []
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d) => lines.push(...d.split('\n').filter(Boolean)))
    kids.push(p)
    return { p, lines }
  }
  let observed = null
  try {
    const holder = spawnChild([root, 'holder'])
    await waitFor(() => holder.lines.includes('HELD'))
    const launcher = spawnChild([root, 'launch', String(T0)])
    await waitFor(() => ticketsIn(dir).some((t) => t.owner === OWNER))
    observed = Number(ticketsIn(dir).find((t) => t.owner === OWNER).ts)
    launcher.p.kill()
    holder.p.stdin.write('go\n')
  } finally {
    for (const k of kids) k.kill()
    fs.rmSync(root, { recursive: true, force: true })
  }
  const pass = observed === T0
  console.log(JSON.stringify({ T0, observed, carriedSince: pass }))
  console.log(pass
    ? 'RESULT: PASS launch() passes sinceMs into the browser lease queue, so a retried launch keeps its place'
    : 'RESULT: FAIL launch() does not pass sinceMs into the browser lease queue (ticket ts is ' + observed + ', expected ' + T0 + ')')
  process.exitCode = pass ? 0 : 1
}
