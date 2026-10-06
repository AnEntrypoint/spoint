#!/usr/bin/env node
import { readFile, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const argv = process.argv.slice(2)
function flag(name, dflt = null) {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3141')
const WORLD = flag('world', 'sandbox')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAG = '[docs-player-model]'

const DOC_FILES = [
  'docs/index.html',
  'docs/getting-started.md',
  'docs/quick-reference.md',
  'README.md',
  'SKILL.md',
]
const PLAYER_MODEL_RE = /playerModel\s*:\s*['"`]([^'"`]+)['"`]/g

const failures = []
function expect(cond, msg) {
  if (cond) return true
  failures.push(msg)
  console.error(`${TAG} assertion failed: ${msg}`)
  return false
}

const CLIENT_ROOT = path.join(ROOT, 'client')
const withoutQueryOf = p => p.split(/[?#]/)[0]
const httpPathOf = p => (p.startsWith('./') ? '/' + p.slice(2) : p)
const diskPathOf = p => {
  const resolved = path.resolve(CLIENT_ROOT, httpPathOf(withoutQueryOf(p)).replace(/^\/+/, ''))
  return resolved === CLIENT_ROOT || resolved.startsWith(CLIENT_ROOT + path.sep) ? resolved : null
}

async function collectPlayerModels() {
  const byValue = new Map()
  for (const rel of DOC_FILES) {
    let text
    try { text = await readFile(path.join(ROOT, rel), 'utf8') } catch (e) { continue }
    PLAYER_MODEL_RE.lastIndex = 0
    let m
    while ((m = PLAYER_MODEL_RE.exec(text))) {
      if (!byValue.has(m[1])) byValue.set(m[1], new Set())
      byValue.get(m[1]).add(rel)
    }
  }
  return byValue
}

async function diskMagic(file) {
  let handle = null
  try {
    handle = await open(file, 'r')
    const buf = new Uint8Array(4)
    const { bytesRead } = await handle.read(buf, 0, 4, 0)
    return bytesRead === 4 ? String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) : null
  } catch (_) { return null } finally { try { await handle?.close() } catch (_) {} }
}

async function main() {
  const found = await collectPlayerModels()
  const values = [...found.keys()].sort()
  console.log(`${TAG} playerModel literals found in docs: ${values.length} -> ${JSON.stringify(values)}`)
  expect(values.length > 0, 'no playerModel literal was extracted from the docs: the extractor matched nothing, so this run proves nothing')

  const checked = []
  for (const value of values) {
    const absolute = /^https?:\/\//i.test(value)
    const httpPath = absolute ? value : httpPathOf(withoutQueryOf(value))
    const disk = absolute ? null : diskPathOf(value)
    let diskOk = false
    let diskBytes = null
    if (disk) { try { const st = await stat(disk); diskOk = st.isFile(); diskBytes = st.size } catch (_) {} }
    checked.push({ value, httpPath, absolute, disk, diskOk, diskBytes, sources: [...found.get(value)].sort() })
  }

  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.SPOINT_NO_WATCH = '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  console.log(`${TAG} booting real spoint server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  const base = `http://localhost:${PORT}`

  try {
    for (const row of checked) {
      const url = row.absolute ? row.httpPath : base + row.httpPath
      let status = null
      let bytes = 0
      let magic = null
      try {
        const res = await fetch(url, { cache: 'no-store' })
        status = res.status
        const buf = new Uint8Array(await res.arrayBuffer())
        bytes = buf.length
        magic = bytes >= 4 ? String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) : null
      } catch (e) {
        console.error(`${TAG} fetch threw for ${url}: ${e.message}`)
      }
      row.status = status
      row.httpBytes = bytes
      row.magic = magic
      row.diskMagic = row.disk ? await diskMagic(row.disk) : null
      console.log(`${TAG} ${String(status)} ${String(bytes).padStart(9)}B magic=${magic} ${row.httpPath}   (docs: ${row.sources.join(', ')})`)
      expect(status === 200, `docs playerModel "${row.value}" resolves to ${row.httpPath} which answered HTTP ${status} on a real server (docs: ${row.sources.join(', ')})`)
      expect(bytes > 0, `docs playerModel "${row.value}" resolved ${row.httpPath} with an empty body`)
      expect(magic === 'glTF', `docs playerModel "${row.value}" resolved ${row.httpPath} whose first 4 bytes are ${JSON.stringify(magic)}, not the glTF/VRM container magic`)
      if (!row.absolute) {
        expect(row.disk !== null, `docs playerModel "${row.value}" resolves outside the served client root ${CLIENT_ROOT}, so no committed file can back it`)
        expect(row.diskOk === true, `docs playerModel "${row.value}" has no committed file at ${row.disk}`)
        expect(row.diskMagic === 'glTF', `docs playerModel "${row.value}" points at ${row.disk} whose first 4 bytes are ${JSON.stringify(row.diskMagic)}, not the glTF/VRM container magic`)
      }
    }
  } finally {
    try { server.stop() } catch (_) {}
  }

  const okCount = checked.filter(r => r.status === 200).length
  console.log(`${TAG} resolved ${okCount}/${checked.length} documented playerModel paths on a real server`)
  if (failures.length) {
    console.error(`${TAG} RESULT: FAIL -- ${failures.length} assertion(s) failed, first: ${failures[0]}`)
    await exitAfterQuiesce(1)
    return
  }
  console.log(`${TAG} RESULT: PASS -- ${okCount}/${checked.length} documented playerModel paths resolve HTTP 200 with glTF magic on a real spoint server`)
  await exitAfterQuiesce(0)
}

main().catch(e => { console.error(`${TAG} run FAILED: ${e.stack || e.message}`); process.exit(1) })
