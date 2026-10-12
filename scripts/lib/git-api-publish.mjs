import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { SOURCE_REL, GENERATED_REL, MAX_BUFFER, catFileBatch, makeIndex, normalizeEol, recordedDigest } from './appcontext-closure.mjs'

const REPO = 'AnEntrypoint/spoint'
const ROOT = process.cwd()

function parseArgv(argv) {
  const out = { message: null, messageFile: null, paths: [], binary: [] }
  let bucket = 'paths'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--message') out.message = argv[++i]
    else if (a === '--message-file') out.messageFile = argv[++i]
    else if (a === '--binary') bucket = 'binary'
    else if (a === '--') continue
    else if (a === '--repo') out.repo = argv[++i]
    else out[bucket].push(a)
  }
  return out
}

function ghToken() {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}

function refuse(lines) {
  for (const line of lines) console.error('[git-api-publish] ' + line)
  process.exit(1)
}

async function main() {
  const args = parseArgv(process.argv.slice(2))
  const repo = args.repo || REPO
  const message = args.messageFile ? readFileSync(args.messageFile, 'utf8') : args.message
  if (!message) {
    console.error('git-api-publish: --message or --message-file is required')
    process.exit(1)
  }
  if (args.paths.length === 0 && args.binary.length === 0) {
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
  async function remoteBlobText(sha) {
    const blob = await gh('/repos/' + repo + '/git/blobs/' + sha)
    if (typeof blob.content === 'string' && blob.content.length > 0) {
      return Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
    }
    const r = await fetch('https://api.github.com/repos/' + repo + '/git/blobs/' + sha, { headers: { ...H, Accept: 'application/vnd.github.raw' } })
    if (!r.ok) throw new Error('HTTP ' + r.status + ' /repos/' + repo + '/git/blobs/' + sha)
    return await r.text()
  }

  const tip = (await gh('/repos/' + repo + '/git/ref/heads/main')).object.sha

  const prepared = []
  for (const rel of args.paths) {
    prepared.push({ rel, text: normalizeEol(readFileSync(ROOT + '/' + rel, 'utf8')), buffer: null })
  }
  for (const rel of args.binary) {
    const buffer = readFileSync(ROOT + '/' + rel)
    prepared.push({ rel, text: buffer.toString('utf8'), buffer })
  }
  const local = {}
  for (const p of prepared) {
    local[p.rel] = execFileSync('git', ['hash-object', '--path=' + p.rel, p.rel], { cwd: ROOT, encoding: 'utf8' }).trim()
  }

  const enforceClosureGate = async () => {
    const publishing = new Set(prepared.map(p => p.rel))
    const listing = await gh('/repos/' + repo + '/git/trees/' + tip + '?recursive=1')
    if (listing.truncated) {
      throw new Error('closure gate: the tip tree ' + tip + ' came back truncated, so the ' + SOURCE_REL + ' import closure cannot be enumerated; refusing to publish unverified')
    }
    const atTip = new Map()
    for (const entry of listing.tree) if (entry.type === 'blob') atTip.set(entry.path, entry.sha)
    if (!atTip.has(SOURCE_REL)) {
      throw new Error('closure gate: ' + SOURCE_REL + ' is absent from tip tree ' + tip + '; this is not the spoint closure')
    }
    const byPath = new Map(prepared.map(p => [p.rel, p]))
    const blobCache = new Map()
    const has = (rel) => atTip.has(rel) || publishing.has(rel)
    const read = async (rel) => {
      if (byPath.has(rel)) return byPath.get(rel).text
      const sha = atTip.get(rel)
      if (sha === undefined) return null
      if (blobCache.has(sha)) return blobCache.get(sha)
      let text
      try {
        text = execFileSync('git', ['cat-file', 'blob', sha], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER })
      } catch {
        text = await remoteBlobText(sha)
      }
      blobCache.set(sha, text)
      return text
    }

    const preload = async (rels) => {
      const wanted = []
      for (const rel of rels) {
        if (byPath.has(rel)) continue
        const sha = atTip.get(rel)
        if (sha === undefined || blobCache.has(sha)) continue
        wanted.push([rel, sha])
      }
      if (wanted.length === 0) return
      const shas = [...new Set(wanted.map(w => w[1]))]
      let batch = new Map()
      try {
        batch = catFileBatch(shas, ROOT)
      } catch {
        batch = new Map()
      }
      for (const [, sha] of wanted) {
        if (blobCache.has(sha)) continue
        blobCache.set(sha, batch.has(sha) ? batch.get(sha) : await remoteBlobText(sha))
      }
    }

    const index = makeIndex({ has, read, preload })
    const members = await index.members()
    const memberSet = new Set(members)
    const changed = [...publishing].filter(rel => memberSet.has(rel) && atTip.get(rel) !== local[rel])
    const digest = await index.digest()

    if (publishing.has(GENERATED_REL)) {
      const recorded = recordedDigest(byPath.get(GENERATED_REL).text)
      if (recorded === null) {
        refuse([
          'REFUSING PUBLISH: ' + GENERATED_REL + ' carries no source digest, so it cannot be checked against this tree.',
          'it predates the digest header or was hand-edited.',
          'fix: npm run gen-typings, then publish ' + GENERATED_REL + ' again'
        ])
      }
      if (recorded !== digest) {
        refuse([
          'REFUSING PUBLISH: ' + GENERATED_REL + ' was generated from source digest ' + recorded.slice(0, 12) + ',',
          'but the tree this publish would write digests the ' + SOURCE_REL + ' import closure to ' + digest.slice(0, 12) + '.',
          'the committed artifact would not match the committed source, so the CI drift step would fail.',
          'closure member(s) carried by this publish: ' + (changed.length ? changed.join(', ') : '(none)') + '.',
          'fix: npm run gen-typings over exactly the closure content you are publishing, then publish ' + GENERATED_REL + ' in the same commit as every changed closure member'
        ])
      }
      console.log('[git-api-publish] closure gate: ' + GENERATED_REL + ' matches the ' + SOURCE_REL + ' import closure of the tree being written (' + digest.slice(0, 12) + ', ' + members.length + ' files)')
      return
    }

    if (changed.length) {
      refuse([
        'REFUSING PUBLISH: ' + changed.join(', ') + ' is part of the ' + SOURCE_REL + ' import closure,',
        'but ' + GENERATED_REL + ' is not part of this commit.',
        'the committed artifact would still describe the previous closure, so the CI drift step would fail.',
        'fix: npm run gen-typings && publish ' + GENERATED_REL + ' together with ' + changed.join(' ')
      ])
    }
  }
  await enforceClosureGate()

  const tree = []
  for (const p of prepared) {
    const content = p.buffer === null ? Buffer.from(p.text, 'utf8') : p.buffer
    const blob = await gh('/repos/' + repo + '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
    })
    tree.push({ path: p.rel, mode: '100644', type: 'blob', sha: blob.sha })
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
  for (const rel of [...args.paths, ...args.binary]) {
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
