import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

function workspacePackages() {
  const dir = join(ROOT, 'packages')
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const target = join(dir, entry.name)
    const manifest = join(target, 'package.json')
    if (!existsSync(manifest)) continue
    let name
    try {
      name = JSON.parse(readFileSync(manifest, 'utf8')).name
    } catch {
      continue
    }
    if (typeof name === 'string' && name.length) out.push({ name, target })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function resolvesTo(path, target) {
  let actual
  try {
    actual = realpathSync(path)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  return { ok: actual === realpathSync(target), reason: 'present', actual }
}

export function ensureWorkspaceLinks({ root = ROOT } = {}) {
  const created = []
  const repaired = []
  const present = []
  const failed = []
  for (const { name, target } of workspacePackages()) {
    const link = join(root, 'node_modules', name)
    if (!existsSync(join(target, 'package.json'))) {
      failed.push(`${name}: packages/${name} has no package.json`)
      continue
    }
    const state = resolvesTo(link, target)
    if (state.ok) {
      present.push(name)
      continue
    }
    try {
      rmSync(link, { recursive: true, force: true })
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(target, link, LINK_TYPE)
    } catch (e) {
      failed.push(`${name}: could not link -> ${e.message}`)
      continue
    }
    ;(state.reason === 'missing' ? created : repaired).push(name)
  }
  return { created, repaired, present, failed }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { created, repaired, present, failed } = ensureWorkspaceLinks()
  for (const name of created) console.log(`[workspace-links] created node_modules/${name}`)
  for (const name of repaired) console.log(`[workspace-links] repaired node_modules/${name}`)
  for (const name of failed) console.error(`[workspace-links] FAILED ${name}`)
  console.log(`[workspace-links] ${present.length} already resolved, ${created.length} created, ${repaired.length} repaired`)
  if (failed.length) {
    console.error(`[workspace-links] run \`npm install\` if this persists, then re-run \`node scripts/ensure-workspace-links.mjs\``)
    process.exit(1)
  }
}
