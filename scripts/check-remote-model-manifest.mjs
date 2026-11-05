import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname

function refusal(code, message) {
  const err = new TypeError(`[remote-model-manifest] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function readManifestFromSkill(text) {
  if (typeof text !== 'string') throw refusal('manifest-text-invalid', 'text must be a string')
  const names = new Set()
  for (const m of text.matchAll(/\b([A-Za-z0-9_.-]+\.glb)\b/g)) names.add(m[1])
  return names
}

export function checkRemoteModelUrls(text, manifest) {
  if (typeof text !== 'string') throw refusal('manifest-text-invalid', 'text must be a string')
  if (!(manifest instanceof Set)) throw refusal('manifest-invalid', 'manifest must be a Set')
  const bad = []
  for (const m of text.matchAll(/raw\.githubusercontent\.com\/anEntrypoint\/assets\/main\/([A-Za-z0-9_.-]+\.glb)/g)) {
    if (!manifest.has(m[1])) bad.push(m[1])
  }
  return { ok: bad.length === 0, bad, urls: [...text.matchAll(/raw\.githubusercontent\.com\/anEntrypoint\/assets\/main\/[A-Za-z0-9_.-]+\.glb/g)].length }
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(m?js|cjs)$/.test(name)) out.push(path)
  }
}

const skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf8')
const manifest = readManifestFromSkill(skill)
if (manifest.size === 0) throw refusal('manifest-empty', 'SKILL.md lists no verified .glb names')

const files = []
for (const root of ['apps', 'src/stdlib-apps']) walk(join(ROOT, root), files)
let urls = 0
for (const file of files) {
  const result = checkRemoteModelUrls(readFileSync(file, 'utf8'), manifest)
  urls += result.urls
  if (!result.ok) throw refusal('manifest-unverified-url', `${file} names ${result.bad.join(', ')} which SKILL.md does not verify`)
}

const negative = checkRemoteModelUrls('const u = "https://raw.githubusercontent.com/anEntrypoint/assets/main/guessed_model.glb"', manifest)
if (negative.ok) throw refusal('manifest-negative-control', 'a guessed URL must be refused')

console.log(`RESULT: PASS ${files.length} app file(s) scanned, ${urls} remote model URL(s) verified against ${manifest.size} manifest name(s), guessed URL refused`)
