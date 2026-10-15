import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'
const PACKAGES_DIR = 'packages'
const NODE_MODULES = 'node_modules'
// A real install found where a workspace link belongs is KEPT, never deleted: it is the only record
// of the bytes the dev server was actually serving. It is renamed aside under this suffix.
const STALE_SUFFIX = '.stale-copy'

export class WorkspaceTargetMissingError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'WorkspaceTargetMissingError'
    this.code = 'WorkspaceTargetMissingError'
    this.detail = detail ?? {}
  }
}

// Raised BEFORE any write when a repair would touch a path that does not resolve inside the tree being
// repaired. An archive whose node_modules is a junction onto another tree would otherwise rename and
// relink that tree's packages (the shared C:/dev/spoint/node_modules @spoint links).
export class WorkspaceLinkOutsideTreeError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'WorkspaceLinkOutsideTreeError'
    this.code = 'WorkspaceLinkOutsideTreeError'
    this.detail = detail ?? {}
  }
}

function readManifestName(dir) {
  if (!existsSync(dir)) return null
  let text
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    return typeof parsed?.name === 'string' && parsed.name.length ? parsed.name : null
  } catch {
    return null
  }
}

export function workspacePackages({ root = ROOT } = {}) {
  const packages = []
  const skipped = []
  const dir = join(root, PACKAGES_DIR)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { packages, skipped }
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const target = resolve(join(dir, entry.name))
    const name = readManifestName(target)
    if (name === null) {
      skipped.push({ dir: entry.name, reason: `packages/${entry.name} has no readable package.json name, so it is not a node workspace` })
      continue
    }
    packages.push({ dir: entry.name, name, target })
  }
  return { packages, skipped }
}

function isInstallOf(path, pkg) {
  const base = basename(path)
  if (base === pkg.name) return true
  if (base !== pkg.dir) return false
  const installed = readManifestName(path)
  return installed === null || installed === pkg.name
}

// Every specifier under node_modules this package can be served from. The manifest name alone is not
// enough: packages/mapspinner declares the UNSCOPED name "mapspinner", so a name-only check inspected
// node_modules/mapspinner and never touched node_modules/@spoint/mapspinner -- the real directory
// holding an installed copy that the dev server was serving.
export function installPaths({ root = ROOT, pkg }) {
  const found = new Set([pkg.name])
  const nm = join(root, NODE_MODULES)
  let top
  try {
    top = readdirSync(nm, { withFileTypes: true })
  } catch {
    return [...found].sort()
  }
  for (const entry of top) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.') || entry.name.endsWith(STALE_SUFFIX)) continue
    if (entry.name.startsWith('@')) {
      let inner
      try {
        inner = readdirSync(join(nm, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const sub of inner) {
        if (!sub.isDirectory() && !sub.isSymbolicLink()) continue
        if (sub.name.endsWith(STALE_SUFFIX)) continue
        if (isInstallOf(join(nm, entry.name, sub.name), pkg)) found.add(`${entry.name}/${sub.name}`)
      }
      continue
    }
    if (isInstallOf(join(nm, entry.name), pkg)) found.add(entry.name)
  }
  return [...found].sort()
}

// The question is not "does this specifier resolve" -- a stale installed copy resolves perfectly. It
// is "does this path resolve INTO packages/<dir>", and only that answer may count as present.
export function classifyInstall(path, targetReal) {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return { kind: 'missing' }
  }
  let real = null
  try {
    real = realpathSync(path)
  } catch {
    real = null
  }
  if (st.isSymbolicLink()) {
    if (real === null) return { kind: 'broken-link' }
    return real === targetReal ? { kind: 'linked' } : { kind: 'link-elsewhere', real }
  }
  if (st.isDirectory()) return { kind: 'real-directory', real }
  return { kind: 'file', real }
}

function keepsakePath(path) {
  const taken = (p) => {
    try {
      lstatSync(p)
      return true
    } catch {
      return false
    }
  }
  let candidate = path + STALE_SUFFIX
  let n = 2
  while (taken(candidate)) candidate = `${path}${STALE_SUFFIX}-${n++}`
  return candidate
}

const caseKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)

function isInside(real, tree) {
  const r = caseKey(real)
  const t = caseKey(tree)
  return r === t || r.startsWith(t.endsWith(sep) ? t : t + sep)
}

// Realpath of the nearest existing ancestor, so a path not yet created still reports where it would land.
function realAnchor(path) {
  let cur = path
  for (;;) {
    try {
      return realpathSync.native(cur)
    } catch {
      const up = dirname(cur)
      if (up === cur) return null
      cur = up
    }
  }
}

function assertWritesStayInTree({ root, name, link, state }) {
  const treeReal = realpathSync.native(root)
  const refuse = (reason, message) => {
    throw new WorkspaceLinkOutsideTreeError(`${message} -- the tree being repaired is ${treeReal}`, { name, link, reason, treeReal })
  }
  const parentReal = realAnchor(dirname(link))
  if (parentReal === null || !isInside(parentReal, treeReal)) {
    refuse('node-modules-outside-tree', `node_modules/${name} would be written under ${dirname(link)}, which resolves to ${parentReal ?? 'nothing'}, outside the tree`)
  }
  if (state.kind === 'link-elsewhere') {
    const real = realAnchor(link)
    if (real === null || !isInside(real, treeReal)) {
      refuse('link-target-outside-tree', `node_modules/${name} is a link to ${real ?? 'nothing'}, outside the tree, so it is refused and left unchanged`)
    }
  }
  if (state.kind === 'broken-link') {
    const abs = resolve(dirname(link), readlinkSync(link))
    if (!isInside(abs, treeReal)) {
      refuse('link-target-outside-tree', `node_modules/${name} is a broken link to ${abs}, outside the tree, so it is refused and left unchanged`)
    }
  }
}

function planLink({ root, name, target, dir }) {
  let targetReal
  try {
    targetReal = realpathSync(target)
  } catch {
    throw new WorkspaceTargetMissingError(`packages/${dir ?? name} is absent (${target}), so node_modules/${name} cannot be linked into it`, { name, dir, target })
  }
  const link = join(root, NODE_MODULES, ...name.split('/'))
  const state = classifyInstall(link, targetReal)
  if (state.kind !== 'linked') assertWritesStayInTree({ root, name, link, state })
  return { link, state }
}

export function ensureWorkspaceLink({ root = ROOT, name, target, dir }) {
  const { link, state } = planLink({ root, name, target, dir })
  if (state.kind === 'linked') return { name, dir, path: link, action: 'present', kind: state.kind }
  let movedTo = null
  if (state.kind === 'real-directory' || state.kind === 'file') {
    movedTo = keepsakePath(link)
    renameSync(link, movedTo)
  } else if (state.kind !== 'missing') {
    // A link is removed, never followed: what it pointed at stays on disk.
    rmSync(link, { recursive: true, force: true })
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, LINK_TYPE)
  return {
    name,
    dir,
    path: link,
    action: state.kind === 'missing' ? 'created' : 'repaired',
    kind: state.kind,
    movedTo,
    pointedTo: state.real ?? null,
  }
}

export function ensureWorkspaceLinks({ root = ROOT } = {}) {
  const created = []
  const repaired = []
  const present = []
  const failed = []
  const refused = []
  const { packages, skipped } = workspacePackages({ root })
  // Plan every link before writing any: one refused link stops the whole repair with nothing written.
  const plan = []
  for (const pkg of packages) {
    for (const name of installPaths({ root, pkg })) {
      try {
        planLink({ root, name, target: pkg.target, dir: pkg.dir })
        plan.push({ pkg, name })
      } catch (e) {
        if (e instanceof WorkspaceLinkOutsideTreeError) refused.push({ name, reason: e.detail.reason, message: e.message })
        else failed.push(`${name}: ${e instanceof Error ? (e.code ?? e.name) : 'Error'}: ${e.message}`)
      }
    }
  }
  if (refused.length) return { created, repaired, present, failed, skipped, refused }
  for (const { pkg, name } of plan) {
    try {
      const r = ensureWorkspaceLink({ root, name, target: pkg.target, dir: pkg.dir })
      if (r.action === 'present') present.push(r)
      else if (r.action === 'created') created.push(r)
      else repaired.push(r)
    } catch (e) {
      const code = e instanceof Error ? (e.code ?? e.name) : 'Error'
      failed.push(`${name}: ${code}: ${e.message}`)
    }
  }
  return { created, repaired, present, failed, skipped, refused }
}

export function formatReport(report, { root = ROOT } = {}) {
  const rel = (p) => relative(root, p).split(sep).join('/')
  const refused = report.refused ?? []
  if (refused.length) return refused.map((r) => `[workspace-links] REFUSED (${r.reason}) ${r.message} -- nothing was written`)
  const lines = []
  for (const c of report.created) lines.push(`[workspace-links] created ${rel(c.path)} -> packages/${c.dir}`)
  for (const r of report.repaired) {
    const into = `packages/${r.dir}`
    if (r.kind === 'real-directory') {
      lines.push(`[workspace-links] REPAIR ${rel(r.path)} was a REAL DIRECTORY holding an installed copy, not a workspace link -> the copy is kept at ${rel(r.movedTo)} and ${rel(r.path)} now links into ${into}`)
    } else if (r.kind === 'file') {
      lines.push(`[workspace-links] REPAIR ${rel(r.path)} was a FILE where a workspace link belongs -> kept at ${rel(r.movedTo)} and ${rel(r.path)} now links into ${into}`)
    } else if (r.kind === 'broken-link') {
      lines.push(`[workspace-links] REPAIR ${rel(r.path)} was a BROKEN link -> ${rel(r.path)} now links into ${into}`)
    } else {
      lines.push(`[workspace-links] REPAIR ${rel(r.path)} linked to ${r.pointedTo ?? 'a missing path'}, not into packages/ -> ${rel(r.path)} now links into ${into}`)
    }
  }
  for (const s of report.skipped ?? []) lines.push(`[workspace-links] skipped ${s.dir}: ${s.reason}`)
  const stale = report.repaired.filter((r) => r.movedTo !== null).length
  lines.push(
    `[workspace-links] ${report.present.length} already linked into packages/, ${report.created.length} created, ${report.repaired.length} repaired (${stale} stale install(s) moved aside, not deleted), ${(report.skipped ?? []).length} skipped, ${report.failed.length} failed`,
  )
  return lines
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = ensureWorkspaceLinks()
  for (const line of formatReport(report)) console.log(line)
  for (const detail of report.failed) console.error(`[workspace-links] FAILED ${detail}`)
  if (report.refused.length || report.failed.length) {
    if (report.failed.length) console.error('[workspace-links] run `npm install` if this persists, then re-run `node scripts/ensure-workspace-links.mjs`')
    process.exit(1)
  }
}
