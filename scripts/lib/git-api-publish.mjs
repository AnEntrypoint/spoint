import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { SOURCE_REL, GENERATED_REL, MAX_BUFFER, catFileBatch, makeIndex, normalizeEol, recordedDigest } from './appcontext-closure.mjs'

const REPO = 'AnEntrypoint/spoint'
const ROOT = process.cwd()
const PUBLISH_RETRIES = 5

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Runs the shipped scripts/gen-sdk-typings.mjs in a throwaway worktree at `tip`
 * with every published closure member staged, so the digest it records is the
 * digest of the tree this publish writes. Returns the generated text (LF).
 */
function regenerateGeneratedTypings(tip, overrides) {
  const rel = '.gm/tmp/api-publish-typings-' + process.pid + '-' + Date.now()
  const abs = ROOT + '/' + rel
  if (!existsSync(ROOT + '/node_modules')) {
    throw new Error('regeneration needs ' + ROOT + '/node_modules (typescript) and it is absent')
  }
  try {
    execFileSync('git', ['worktree', 'add', '--detach', rel, tip], { cwd: ROOT, stdio: 'pipe' })
  } catch {
    // the tip can be a commit another lane published after our last fetch, so
    // it may not be in the local object store yet.
    execFileSync('git', ['fetch', 'origin'], { cwd: ROOT, stdio: 'pipe' })
    execFileSync('git', ['worktree', 'add', '--detach', rel, tip], { cwd: ROOT, stdio: 'pipe' })
  }
  try {
    if (!existsSync(abs + '/node_modules')) {
      symlinkSync(ROOT + '/node_modules', abs + '/node_modules', process.platform === 'win32' ? 'junction' : 'dir')
    }
    const staged = []
    for (const [member, text] of overrides) {
      const target = abs + '/' + member
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text, 'utf8')
      staged.push(member)
    }
    if (staged.length) execFileSync('git', ['add', '--', ...staged], { cwd: abs, stdio: 'pipe' })
    execFileSync(process.execPath, ['scripts/gen-sdk-typings.mjs'], { cwd: abs, stdio: 'pipe' })
    if (!existsSync(abs + '/' + GENERATED_REL)) {
      throw new Error('scripts/gen-sdk-typings.mjs produced no ' + GENERATED_REL)
    }
    return normalizeEol(readFileSync(abs + '/' + GENERATED_REL, 'utf8'))
  } finally {
    try {
      execFileSync(process.execPath, ['scripts/worktree-teardown.mjs', abs], { cwd: ROOT, stdio: 'pipe' })
    } catch (e) {
      console.error('[git-api-publish] worktree-teardown failed for ' + abs + ': ' + (e.message || e))
    }
  }
}

function hashObjectText(rel, text) {
  const scratch = ROOT + '/.gm/tmp/api-publish-hash-' + process.pid + '-' + Date.now() + '.tmp'
  mkdirSync(dirname(scratch), { recursive: true })
  try {
    writeFileSync(scratch, text, 'utf8')
    return execFileSync('git', ['hash-object', '--path=' + rel, scratch], { cwd: ROOT, encoding: 'utf8' }).trim()
  } finally {
    writeFileSync(scratch, '', 'utf8')
  }
}

function isFastForwardLoss(err) {
  const m = err && err.message ? err.message : ''
  return /\bHTTP (409|422)\b/.test(m) || /not a fast forward|is at .*but expected|Reference does not exist/i.test(m)
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

  const enforceClosureGate = async (tip) => {
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

    const tipRead = async (rel) => {
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
    const preloadTip = async (rels) => {
      const shas = []
      for (const rel of rels) {
        const sha = atTip.get(rel)
        if (sha === undefined || blobCache.has(sha)) continue
        shas.push(sha)
      }
      if (shas.length === 0) return
      const uniq = [...new Set(shas)]
      let batch = new Map()
      try {
        batch = catFileBatch(uniq, ROOT)
      } catch {
        batch = new Map()
      }
      for (const sha of uniq) {
        if (blobCache.has(sha)) continue
        blobCache.set(sha, batch.has(sha) ? batch.get(sha) : await remoteBlobText(sha))
      }
    }

    const index = makeIndex({ has, read, preload })
    const members = await index.members()
    const memberSet = new Set(members)
    const changed = [...publishing].filter(rel => memberSet.has(rel) && atTip.get(rel) !== local[rel])
    const digest = await index.digest()

    const unpublishedDrift = () => {
      const dirty = []
      for (const rel of members) {
        if (publishing.has(rel)) continue
        let sha
        try {
          sha = execFileSync('git', ['hash-object', '--path=' + rel, rel], { cwd: ROOT, encoding: 'utf8' }).trim()
        } catch {
          continue
        }
        if (sha !== atTip.get(rel)) dirty.push(rel)
      }
      if (dirty.length === 0) return 'unpublished closure member(s) whose worktree copy differs from tip: (none)'
      const shown = dirty.slice(0, 10).join(', ')
      return 'unpublished closure member(s) whose worktree copy differs from tip: ' + shown + (dirty.length > 10 ? ' (+' + (dirty.length - 10) + ' more)' : '')
    }

    const tipIndex = makeIndex({ has: (rel) => atTip.has(rel), read: tipRead, preload: preloadTip })
    const tipDigest = await tipIndex.digest()
    const published = publishing.has(GENERATED_REL)

    if (!published && digest === tipDigest) {
      console.log('[git-api-publish] closure gate: no published path moves the ' + SOURCE_REL + ' import closure (' + digest.slice(0, 12) + ', ' + members.length + ' files)')
      return null
    }

    const recorded = published
      ? recordedDigest(byPath.get(GENERATED_REL).text)
      : recordedDigest((await tipRead(GENERATED_REL)) ?? '')
    if (recorded === digest) {
      console.log('[git-api-publish] closure gate: ' + GENERATED_REL + ' matches the ' + SOURCE_REL + ' import closure of the tree being written (' + digest.slice(0, 12) + ', ' + members.length + ' files)')
      return null
    }

    const overrides = new Map()
    for (const rel of members) if (byPath.has(rel)) overrides.set(rel, byPath.get(rel).text)
    console.log('[git-api-publish] closure gate: regenerating ' + GENERATED_REL + ' -- recorded ' + (recorded === null ? '(none)' : recorded.slice(0, 12)) + ' vs the tree being written ' + digest.slice(0, 12) + ' over ' + members.length + ' closure files')
    console.log('[git-api-publish] closure gate: closure member(s) carried by this publish: ' + (changed.length ? changed.join(', ') : '(none)') + '.')
    console.log('[git-api-publish] closure gate: ' + unpublishedDrift() + '.')
    const text = regenerateGeneratedTypings(tip, overrides)
    const got = recordedDigest(text)
    if (got !== digest) {
      refuse([
        'REFUSING PUBLISH: the regenerated ' + GENERATED_REL + ' carries source digest ' + (got === null ? '(none)' : got.slice(0, 12)) + ',',
        'but the tree this publish would write digests the ' + SOURCE_REL + ' import closure to ' + digest.slice(0, 12) + '.',
        'regeneration disagrees with this tree, so the CI drift step would still fail.',
        'fix: run node scripts/gen-sdk-typings.mjs in a clean checkout of ' + tip + ' and inspect its output'
      ])
    }
    console.log('[git-api-publish] closure gate: regenerated ' + GENERATED_REL + ' matches the tree being written (' + digest.slice(0, 12) + ', ' + members.length + ' files)')
    return text
  }

  const publishOnce = async () => {
    const tip = (await gh('/repos/' + repo + '/git/ref/heads/main')).object.sha
    const regenerated = await enforceClosureGate(tip)
    if (regenerated !== null) {
      const entry = { rel: GENERATED_REL, text: regenerated, buffer: null }
      const at = prepared.findIndex((p) => p.rel === GENERATED_REL)
      if (at >= 0) prepared[at] = entry
      else prepared.push(entry)
      local[GENERATED_REL] = hashObjectText(GENERATED_REL, regenerated)
    }

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
    return { tip, commit: commit.sha }
  }

  let attempts = 0
  let published = null
  for (;;) {
    attempts++
    try {
      published = await publishOnce()
      break
    } catch (e) {
      if (!isFastForwardLoss(e) || attempts >= PUBLISH_RETRIES) throw e
      console.error('[git-api-publish] attempt ' + attempts + ' lost refs/heads/main (' + (e.message || e).slice(0, 200) + '); re-reading the tip and retrying with force:false')
      await sleep(500 * attempts)
    }
  }

  const verify = {}
  let ok = true
  for (const rel of prepared.map((p) => p.rel)) {
    const remote = (await gh('/repos/' + repo + '/contents/' + rel + '?ref=main')).sha
    verify[rel] = { remote, local: local[rel], match: remote === local[rel] }
    if (remote !== local[rel]) ok = false
  }
  console.log(JSON.stringify({ attempts, parent: published.tip, commit: published.commit, verify }, null, 2))
  if (!ok) {
    console.error('git-api-publish: remote blob sha disagrees with git hash-object')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('git-api-publish:', e.message || e)
  process.exit(1)
})
