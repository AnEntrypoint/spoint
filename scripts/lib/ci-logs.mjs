import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'AnEntrypoint/spoint'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_BUFFER = 64 * 1024 * 1024
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g
const CR = /\r(?!\n)/g
const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/
const RUNNER_NOISE = /^(?:\[command\]|##\[|Cleaning up orphan processes|Post job cleanup|Evaluate and set job outputs|Starting phase|Finishing:|git version|Temporarily overriding|Adding repository directory|http\.https|Downloading|Set up job|Complete job)/
const INTERESTING = /RESULT: FAIL|\[FAIL\]|^check: .*(?:exited [1-9]|failed to|error:)|Error:|AssertionError|npm ERR!|error TS\d+|npm error|FATAL|Traceback|unable to write|No space left/i

function run(binary, args) {
  return spawnSync(binary, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true })
}

function ghJson(args) {
  const done = run('gh', args)
  if (done.status !== 0) return { ok: false, error: (done.stderr || done.stdout || '').trim().split('\n')[0] }
  try { return { ok: true, value: JSON.parse(done.stdout) } }
  catch { return { ok: false, error: `unparseable gh output: ${done.stdout.slice(0, 200)}` } }
}

function ghText(args) {
  const done = run('gh', args)
  if (done.status !== 0) return { ok: false, error: (done.stderr || done.stdout || '').trim().split('\n').slice(0, 3).join(' ') }
  return { ok: true, value: done.stdout }
}

function flag(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

function shortSha(sha) {
  return sha.slice(0, 12)
}

function expandRev(rev) {
  const done = run('git', ['rev-parse', '--verify', `${rev}^{commit}`])
  return done.status === 0 ? done.stdout.trim() : rev
}

function clean(text) {
  return text.replace(ANSI, '').replace(CR, '\n')
}

function tailLines(lines, count) {
  return lines.slice(Math.max(0, lines.length - count))
}

function main() {
  const target = expandRev(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '')
  const tailCount = Number(flag('tail', '20'))
  const jobFilter = flag('job', '')
  const customMatch = flag('match', '')
  if (!target) {
    console.error('ci-logs: no sha given, so there is no run whose logs to show')
    process.exit(2)
  }
  const matcher = customMatch ? new RegExp(customMatch) : INTERESTING
  const listed = ghJson(['run', 'list', '--repo', REPO, '--commit', target, '--json', 'databaseId,status,conclusion,headSha', '--limit', '5'])
  if (!listed.ok) {
    console.error(`ci-logs: gh run list failed: ${listed.error}`)
    process.exit(2)
  }
  let runs = listed.value ?? []
  if (runs.length === 0) {
    const recent = ghJson(['run', 'list', '--repo', REPO, '--json', 'databaseId,status,conclusion,headSha', '--limit', '20'])
    if (!recent.ok) {
      console.error(`ci-logs: gh run list failed on the recent-run fallback: ${recent.error}`)
      process.exit(2)
    }
    const prefix = target.slice(0, 12)
    runs = (recent.value ?? []).filter((r) => (r.headSha ?? '').startsWith(prefix))
  }
  if (runs.length === 0) {
    console.error(`ci-logs: no workflow run found for ${shortSha(target)} -- nothing to show, and an absent run is not a green one`)
    process.exit(2)
  }
  let shown = 0
  let fetched = 0
  for (const entry of runs) {
    const jobs = ghJson(['run', 'view', String(entry.databaseId), '--repo', REPO, '--json', 'jobs'])
    if (!jobs.ok) {
      console.error(`ci-logs: gh run view failed for run ${entry.databaseId}: ${jobs.error}`)
      process.exit(2)
    }
    const wanted = (jobs.value.jobs ?? []).filter((j) => {
      if (jobFilter && !(j.name ?? '').includes(jobFilter)) return false
      const conclusion = j.conclusion || ''
      return conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out'
    })
    const picked = wanted.length > 0 ? wanted : (jobs.value.jobs ?? []).filter((j) => !jobFilter || (j.name ?? '').includes(jobFilter))
    for (const job of picked) {
      const got = ghText(['api', `repos/${REPO}/actions/jobs/${job.databaseId}/logs`])
      console.log(`ci-logs: run ${entry.databaseId} job ${job.databaseId} "${job.name}" conclusion=${job.conclusion || '(none)'}`)
      if (!got.ok) {
        console.error(`ci-logs: log fetch failed: ${got.error}`)
        process.exit(2)
      }
      const raw = clean(got.value).split('\n').map((l) => l.replace(STAMP, '').trimEnd()).filter((l) => l.trim() !== '')
      const lines = raw.filter((l) => !RUNNER_NOISE.test(l))
      if (lines.length === 0) {
        console.error(`ci-logs: job ${job.databaseId} held only runner scaffolding across ${raw.length} line(s), so the cause is still unnamed -- fetch it at https://github.com/${REPO}/actions/runs/${entry.databaseId}`)
        process.exit(2)
      }
      fetched += 1
      const hits = lines.filter((l) => matcher.test(l))
      const unique = []
      const seen = new Set()
      for (const line of hits) {
        const key = line.trim()
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(key)
      }
      const head = unique.slice(0, tailCount)
      if (head.length > 0) {
        console.log(`  cause line(s) (${unique.length} total, showing ${head.length}):`)
        for (const line of head) console.log(`    ${line.slice(0, 300)}`)
        shown += head.length
      }
      const tail = tailLines(lines, tailCount)
      console.log(`  last ${tail.length} line(s):`)
      for (const line of tail) console.log(`    ${line.slice(0, 300)}`)
    }
  }
  if (fetched === 0) {
    console.error(`ci-logs: no job log was fetched for ${shortSha(target)}, so its cause was not shown`)
    process.exit(2)
  }
  if (shown === 0) console.log(`ci-logs: no line matched ${matcher} -- read the tail above or the web log before calling this green`)
  else console.log(`ci-logs: ${shown} cause line(s) from ${fetched} job log(s) for ${shortSha(target)}`)
}

main()
