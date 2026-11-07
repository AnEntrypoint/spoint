import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquire, sessionDir } from './lib/browser-lease.mjs'

const SELF = fileURLToPath(import.meta.url)
const T0 = Date.now() - 120000
const COMPETITOR_SINCE = T0 + 60000
const WAIT_MS = 30000

if (process.argv[2] === 'child') {
  const [root, owner, sinceArg] = process.argv.slice(3)
  const sinceMs = sinceArg === 'none' ? undefined : Number(sinceArg)
  const lease = await acquire({ root, owner, sinceMs, waitMs: WAIT_MS })
  console.log(owner === 'holder' ? 'HELD' : 'GOT ' + owner)
  process.stdin.once('data', () => {
    lease.release()
    process.exit(0)
  })
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

  async function scenario(retrySince) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-queue-'))
    const dir = sessionDir(root)
    const kids = []
    const launch = (owner, sinceArg) => {
      const p = spawn(process.execPath, [SELF, 'child', root, owner, sinceArg], { stdio: ['pipe', 'pipe', 'inherit'] })
      const lines = []
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (d) => lines.push(...d.split('\n').filter(Boolean)))
      kids.push(p)
      return { p, lines }
    }
    try {
      const holder = launch('holder', 'none')
      await waitFor(() => holder.lines.includes('HELD'))
      const competitor = launch('competitor', String(COMPETITOR_SINCE))
      await waitFor(() => ticketsIn(dir).some((t) => t.owner === 'competitor'))
      const retry = launch('retry', retrySince === undefined ? 'none' : String(retrySince))
      await waitFor(() => ticketsIn(dir).some((t) => t.owner === 'retry'))
      const retryTs = Number(ticketsIn(dir).find((t) => t.owner === 'retry').ts)
      holder.p.stdin.write('go\n')
      const winner = await waitFor(() => [competitor, retry].find((k) => k.lines.some((l) => l.startsWith('GOT'))))
      const loser = winner === competitor ? retry : competitor
      winner.p.stdin.write('go\n')
      await waitFor(() => loser.lines.some((l) => l.startsWith('GOT')))
      loser.p.stdin.write('go\n')
      return { retryTs, firstGrant: winner === competitor ? 'competitor' : 'retry' }
    } finally {
      for (const k of kids) k.kill()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  const withoutSince = await scenario(undefined)
  const withSince = await scenario(T0)
  const pass = withoutSince.firstGrant === 'competitor' && withSince.firstGrant === 'retry'
  console.log(JSON.stringify({ T0, withoutSince, withSince, sinceChangesPlace: withoutSince.firstGrant !== withSince.firstGrant }))
  console.log(pass ? 'RESULT: PASS a retried acquire keeps its queue place only when it carries sinceMs' : 'RESULT: FAIL retried acquire order does not match the sinceMs rule')
  process.exitCode = pass ? 0 : 1
}
