// Witness for ORCH-workspace-link-stale-copy-1013.
//
// The defect: `npm run links` answered "does this specifier resolve" when the question it appears to
// ask is "is this a workspace link into packages/*". A real directory holding an INSTALLED COPY of a
// workspace package resolves perfectly, so the check reported "3 already resolved" while the dev
// server served published bytes. On this box node_modules/@spoint/mapspinner held mapspinner
// 0.1.264 with src/lod-config.js absent, while packages/mapspinner had it.
//
// gpu-free and hermetic: every scenario is built in a fresh mkdtemp tree, so this never touches the
// repo's own node_modules links except in the final read-only audit.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyInstall, ensureWorkspaceLink, ensureWorkspaceLinks, formatReport, installPaths, workspacePackages, WorkspaceTargetMissingError } from './ensure-workspace-links.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = '[workspace-links-witness]'
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${TAG} [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`)
}
function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
function realOrNull(p) {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function workspacePackage(root, dir, name) {
  const p = join(root, 'packages', dir)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  writeFileSync(join(p, 'index.js'), `export const origin = 'workspace:${dir}'\n`)
  return p
}
function installedCopy(root, spec, name, markerBody) {
  const p = join(root, 'node_modules', ...spec.split('/'))
  mkdirSync(join(p, 'src'), { recursive: true })
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name, version: '9.9.9' }))
  writeFileSync(join(p, 'src', 'served.js'), markerBody)
  return p
}

const scratch = mkdtempSync(join(tmpdir(), 'spoint-wslink-'))
try {
  // ---------------------------------------------------------------- scenario A: the reported defect
  // packages/alpha declares the UNSCOPED name "alpha", exactly as packages/mapspinner does. The flat
  // link is correct; the scoped path is a real directory holding an installed copy. This is the tree
  // on which the old check printed "already resolved".
  const aRoot = join(scratch, 'A')
  const aPkg = workspacePackage(aRoot, 'alpha', 'alpha')
  mkdirSync(join(aRoot, 'node_modules'), { recursive: true })
  symlinkSync(aPkg, join(aRoot, 'node_modules', 'alpha'), LINK_TYPE)
  const stale = installedCopy(aRoot, '@spoint/alpha', 'alpha', 'export const bytes = 6408\n')
  const staleBytes = readFileSync(join(stale, 'src', 'served.js'), 'utf8')

  // The premise, pinned: the stale copy RESOLVES, which is why a resolve-only check passed it.
  check(
    'premise: the stale copy resolves, so a resolve-only check cannot tell it from a workspace link',
    existsSync(join(stale, 'package.json')) && realOrNull(stale) !== null,
    `node_modules/@spoint/alpha/package.json readable, realpath resolves`,
  )

  const aReport = ensureWorkspaceLinks({ root: aRoot })
  const aStaleRepair = aReport.repaired.find((r) => r.name === '@spoint/alpha')
  const aStalePath = join(aRoot, 'node_modules', '@spoint/alpha')

  check(
    'the stale copy is reported as a repair, not as already resolved',
    aStaleRepair !== undefined && aStaleRepair.kind === 'real-directory',
    aStaleRepair ? `kind=${aStaleRepair.kind}` : 'not repaired',
  )
  check(
    'the stale copy was MOVED ASIDE, not deleted, and the report names where it went',
    aStaleRepair?.movedTo != null && existsSync(join(aStaleRepair.movedTo, 'src', 'served.js')),
    aStaleRepair ? `kept at ${aStaleRepair.movedTo}` : 'no keepsake path',
  )
  check(
    'the moved-aside copy still holds the bytes that were being served',
    (() => {
      try {
        return readFileSync(join(aStaleRepair.movedTo, 'src', 'served.js'), 'utf8') === staleBytes
      } catch {
        return false
      }
    })(),
    'keepsake src/served.js is byte-identical to what was installed',
  )
  check(
    'the repaired path is now a link resolving INTO the workspace',
    isLink(aStalePath) && realOrNull(aStalePath) === realOrNull(aPkg),
    `node_modules/@spoint/alpha -> ${realOrNull(aStalePath)}`,
  )
  check(
    'a link that was already correct is left alone and not moved aside',
    aReport.present.some((r) => r.name === 'alpha') && !existsSync(join(aRoot, 'node_modules', 'alpha.stale-copy')),
    'node_modules/alpha reported present, no keepsake created beside it',
  )
  check(
    'both install paths of one unscoped-name package are inspected',
    JSON.stringify(installPaths({ root: aRoot, pkg: { dir: 'alpha', name: 'alpha', target: aPkg } })) === JSON.stringify(['@spoint/alpha', 'alpha']),
    'installPaths finds the flat path AND the scoped path',
  )
  const aText = formatReport(aReport, { root: aRoot }).join('\n')
  check(
    'the summary reports the repair instead of "already resolved"',
    !/already resolved/.test(aText) && /REPAIR/.test(aText) && /moved aside/.test(aText),
    'summary names the repair and the keepsake',
  )
  console.log(`${TAG} MEASURED scenario A: ${aReport.repaired.length} repaired of ${aReport.present.length + aReport.repaired.length + aReport.created.length} install path(s), ${aReport.repaired.filter((r) => r.movedTo !== null).length} kept aside`)
  for (const line of formatReport(aReport, { root: aRoot })) console.log(`${TAG}   ${line}`)

  const aAgain = ensureWorkspaceLinks({ root: aRoot })
  check(
    'a repaired tree is idempotent: a second run repairs nothing',
    aAgain.created.length === 0 && aAgain.repaired.length === 0 && aAgain.failed.length === 0,
    `second run: ${aAgain.present.length} present, ${aAgain.created.length} created, ${aAgain.repaired.length} repaired`,
  )

  // ------------------------------------------- scenario B: a link elsewhere, a missing path, control
  const bRoot = join(scratch, 'B')
  const bPkg = workspacePackage(bRoot, 'beta', '@spoint/beta')
  workspacePackage(bRoot, 'gamma', 'gamma')
  mkdirSync(join(bRoot, 'packages', 'rustcrate'), { recursive: true })
  writeFileSync(join(bRoot, 'packages', 'rustcrate', 'Cargo.toml'), '[package]\nname = "rustcrate"\n')
  const elsewhere = join(bRoot, 'node_modules', '.cache', 'elsewhere')
  mkdirSync(join(elsewhere, 'src'), { recursive: true })
  writeFileSync(join(elsewhere, 'package.json'), JSON.stringify({ name: '@spoint/beta', version: '1.2.3' }))
  writeFileSync(join(elsewhere, 'src', 'elsewhere.js'), 'export const origin = "elsewhere"\n')
  mkdirSync(join(bRoot, 'node_modules', '@spoint'), { recursive: true })
  symlinkSync(elsewhere, join(bRoot, 'node_modules', '@spoint', 'beta'), LINK_TYPE)
  const control = installedCopy(bRoot, '@spoint/unrelated', 'unrelated', 'export const origin = "unrelated"\n')

  const bReport = ensureWorkspaceLinks({ root: bRoot })
  const bBeta = bReport.repaired.find((r) => r.name === '@spoint/beta')
  check(
    'a link pointing anywhere other than the workspace is repaired',
    bBeta !== undefined && bBeta.kind === 'link-elsewhere' && bBeta.pointedTo === realOrNull(elsewhere),
    bBeta ? `was link-elsewhere -> ${bBeta.pointedTo}` : 'not repaired',
  )
  check(
    'removing a misdirected link does not eat what it pointed at',
    existsSync(join(elsewhere, 'src', 'elsewhere.js')) && bBeta?.movedTo === null,
    'the elsewhere tree survives and no keepsake was minted for a link',
  )
  check(
    'a missing install path is created as a link into the workspace',
    bReport.created.some((r) => r.name === 'gamma') && isLink(join(bRoot, 'node_modules', 'gamma')) && realOrNull(join(bRoot, 'node_modules', 'gamma')) === realOrNull(join(bRoot, 'packages', 'gamma')),
    'node_modules/gamma created -> packages/gamma',
  )
  check(
    '@spoint/beta is repaired while @spoint/ecs-style scoped names resolve',
    isLink(join(bRoot, 'node_modules', '@spoint', 'beta')) && realOrNull(join(bRoot, 'node_modules', '@spoint', 'beta')) === realOrNull(bPkg),
    'node_modules/@spoint/beta -> packages/beta',
  )
  check(
    'an unrelated installed package is NOT touched',
    !isLink(control) && existsSync(join(control, 'src', 'served.js')) && !existsSync(`${control}.stale-copy`),
    'node_modules/@spoint/unrelated left as a real directory',
  )
  check(
    'a packages/ directory with no package.json is reported as skipped, not silently ignored',
    (bReport.skipped ?? []).some((s) => s.dir === 'rustcrate'),
    bReport.skipped?.find((s) => s.dir === 'rustcrate')?.reason ?? 'not reported',
  )

  // ------------------------------------------------------------------- scenario C: the named refusal
  let threw = null
  try {
    ensureWorkspaceLink({ root: bRoot, name: '@spoint/ghost', target: join(bRoot, 'packages', 'ghost'), dir: 'ghost' })
  } catch (e) {
    threw = e
  }
  check(
    'a missing workspace target is REFUSED with a named error',
    threw instanceof WorkspaceTargetMissingError && threw.name === 'WorkspaceTargetMissingError' && threw.code === 'WorkspaceTargetMissingError',
    threw ? `${threw.code}: ${threw.message}` : 'no error thrown',
  )
  check(
    'the refusal leaves no link behind',
    !existsSync(join(bRoot, 'node_modules', '@spoint', 'ghost')) && !existsSync(join(bRoot, 'node_modules', '@spoint', 'ghost.stale-copy')),
    'node_modules/@spoint/ghost absent',
  )

  // --------------------------------------------------------------- audit of the tree this runs on
  // Read-only: check.mjs has already run ensureWorkspaceLinks() on ROOT by the time this witness is
  // spawned, so every install path here must classify as 'linked'. A stale copy surviving that would
  // mean the box is serving published bytes again.
  const audit = workspacePackages({ root: ROOT })
  let audited = 0
  const notLinked = []
  for (const pkg of audit.packages) {
    const targetReal = realOrNull(pkg.target)
    if (targetReal === null) {
      notLinked.push(`${pkg.dir}: packages/${pkg.dir} absent`)
      continue
    }
    for (const name of installPaths({ root: ROOT, pkg })) {
      audited++
      const state = classifyInstall(join(ROOT, 'node_modules', ...name.split('/')), targetReal)
      if (state.kind !== 'linked') notLinked.push(`${name}: ${state.kind}${state.real ? ` -> ${state.real}` : ''}`)
    }
  }
  check(
    'every install path of this tree resolves INTO its workspace package',
    audited > 0 && notLinked.length === 0,
    `${audited} install path(s) over ${audit.packages.length} workspace package(s)${notLinked.length ? `; not linked: ${notLinked.join(', ')}` : ''}`,
  )

  const failed = checks.filter((c) => !c.ok)
  if (failed.length > 0) {
    console.log(`${TAG} MEASURED failures: ${failed.map((f) => f.name).join('; ')}`)
    console.log(`RESULT: FAIL -- ${checks.length - failed.length} of ${checks.length} check(s) passed`)
    process.exit(1)
  }
  console.log(`RESULT: PASS -- ${checks.length} of ${checks.length} check(s) passed label=workspace-link-stale-copy`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
