import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'AnEntrypoint/spoint'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_BUFFER = 32 * 1024 * 1024
const NO_RUNNER_JOB = /frame-time/i

function run(binary, args) {
  return spawnSync(binary, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true })
}

function gh(args) {
  const done = run('gh', args)
  if (done.status !== 0) return { ok: false, error: (done.stderr || '').trim().split('\n')[0] }
  try { return { ok: true, value: JSON.parse(done.stdout) } }
  catch { return { ok: false, error: `unparseable gh output: ${done.stdout.slice(0, 200)}` } }
}

function headSha() {
  const done = run('git', ['rev-parse', 'HEAD'])
  return done.status === 0 ? done.stdout.trim() : null
}

function shortSha(sha) {
  return sha.slice(0, 12)
}

function expandRev(rev) {
  const done = run('git', ['rev-parse', '--verify', `${rev}^{commit}`])
  return done.status === 0 ? done.stdout.trim() : rev
}

function jobsOf(runId) {
  const got = gh(['run', 'view', String(runId), '--repo', REPO, '--json', 'jobs'])
  if (!got.ok) return []
  return got.value.jobs ?? []
}

function main() {
  const given = process.argv[2]
  const target = given ? expandRev(given) : headSha()
  if (!target) {
    console.error('ci-verdict: no sha given and HEAD is unavailable')
    process.exit(2)
  }
  const listed = gh(['run', 'list', '--repo', REPO, '--commit', target, '--json', 'databaseId,status,conclusion,headSha,createdAt', '--limit', '5'])
  if (!listed.ok) {
    console.error(`ci-verdict: gh run list failed: ${listed.error}`)
    process.exit(2)
  }
  const runs = listed.value ?? []
  if (runs.length === 0) {
    console.log(`ci-verdict: no workflow run found for ${shortSha(target)} -- the push may not have registered a run yet`)
    process.exit(2)
  }
  let failures = 0
  let pending = 0
  let decided = 0
  let cancelled = 0
  for (const entry of runs) {
    const jobs = jobsOf(entry.databaseId)
    console.log(`run ${entry.databaseId}  ${shortSha(entry.headSha ?? target)}  status=${entry.status ?? '?'} conclusion=${entry.conclusion ?? '(none)'}`)
    console.log(`  https://github.com/${REPO}/actions/runs/${entry.databaseId}`)
    if (entry.conclusion === 'cancelled' && jobs.length === 0) {
      cancelled += 1
      console.log(`    no verdict: this run was cancelled while still pending, so no job ever started and nothing here is evidence about ${shortSha(target)} -- re-run it or push again`)
    }
    for (const job of jobs) {
      const name = job.name ?? 'unnamed'
      const conclusion = job.conclusion || ''
      const status = job.status ?? '?'
      let note = conclusion || status
      if (NO_RUNNER_JOB.test(name) && status === 'queued') note = 'queued forever -- no self-hosted GPU runner is online, so this is never a verdict on this sha'
      else if (status !== 'completed') note = `${status} -- not yet a verdict`
      console.log(`  ${note}  ${name.slice(0, 90)}`)
      if (conclusion === 'failure' || conclusion === 'timed_out') {
        failures += 1
        console.log(`    cause: node scripts/lib/ci-logs.mjs ${target} --tail=20`)
        console.log(`    raw: gh api repos/${REPO}/actions/jobs/${job.databaseId}/logs`)
      } else if (conclusion === 'cancelled') {
        cancelled += 1
        console.log(`    no verdict: a cancelled job never decided this sha, so nothing here is evidence about it -- re-run it or push again`)
      } else if (status !== 'completed') {
        if (NO_RUNNER_JOB.test(name)) continue
        pending += 1
      } else {
        decided += 1
      }
    }
  }
  if (failures > 0) {
    console.log(`ci-verdict: ${shortSha(target)} has ${failures} failing job(s) -- red is this sha's own verdict`)
    process.exit(1)
  }
  if (cancelled > 0) {
    console.log(`ci-verdict: ${shortSha(target)} has ${cancelled} cancelled job(s) and ${decided} decided -- a cancellation is not a verdict, so this sha is undecided`)
    process.exit(3)
  }
  if (pending > 0 || decided === 0) {
    console.log(`ci-verdict: ${shortSha(target)} has ${decided} decided job(s) and ${pending} still running -- no verdict yet, and zero decisions is not success`)
    process.exit(3)
  }
  console.log(`ci-verdict: ${shortSha(target)} green on ${decided} decided job(s)`)
  process.exit(0)
}

main()
