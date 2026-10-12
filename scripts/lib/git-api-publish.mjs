import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const REPO = 'AnEntrypoint/spoint'
const ROOT = process.cwd()

function parseArgv(argv) {
  const out = { message: null, messageFile: null, paths: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--message') out.message = argv[++i]
    else if (a === '--message-file') out.messageFile = argv[++i]
    else if (a === '--') continue
    else if (a === '--repo') out.repo = argv[++i]
    else out.paths.push(a)
  }
  return out
}

function ghToken() {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}

async function main() {
  const args = parseArgv(process.argv.slice(2))
  const repo = args.repo || REPO
  const message = args.messageFile ? readFileSync(args.messageFile, 'utf8') : args.message
  if (!message) {
    console.error('git-api-publish: --message or --message-file is required')
    process.exit(1)
  }
  if (args.paths.length === 0) {
    console.error('git-api-publish: at least one path is required')
    process.exit(1)
  }

  const H = {
    Authorization: 'Bearer ' + ghToken(),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'spoint-git-api-publish',
  }
  async function gh(path, init = {}) {
    const r = await fetch('https://api.github.com' + path, { ...init, headers: { ...H, ...(init.headers || {}) } })
    const text = await r.text()
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path + ' :: ' + text.slice(0, 500))
    return JSON.parse(text)
  }

  const tip = (await gh('/repos/' + repo + '/git/ref/heads/main')).object.sha
  const tree = []
  const local = {}
  for (const rel of args.paths) {
    const lf = readFileSync(ROOT + '/' + rel, 'utf8').replace(/\r\n/g, '\n')
    const blob = await gh('/repos/' + repo + '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: Buffer.from(lf, 'utf8').toString('base64'), encoding: 'base64' }),
    })
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha })
    local[rel] = execFileSync('git', ['hash-object', '--path=' + rel, rel], { cwd: ROOT, encoding: 'utf8' }).trim()
  }

  const newTree = await gh('/repos/' + repo + '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: tip, tree }),
  })
  const commit = await gh('/repos/' + repo + '/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [tip] }),
  })
  await gh('/repos/' + repo + '/git/refs/heads/main', {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  })

  const verify = {}
  let ok = true
  for (const rel of args.paths) {
    const remote = (await gh('/repos/' + repo + '/contents/' + rel + '?ref=main')).sha
    verify[rel] = { remote, local: local[rel], match: remote === local[rel] }
    if (remote !== local[rel]) ok = false
  }
  console.log(JSON.stringify({ parent: tip, commit: commit.sha, verify }, null, 2))
  if (!ok) {
    console.error('git-api-publish: remote blob sha disagrees with git hash-object')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('git-api-publish:', e.message || e)
  process.exit(1)
})
