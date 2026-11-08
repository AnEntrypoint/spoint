import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkAppImports } from './check-app-imports.mjs'
import { ensureWorkspaceLinks, formatReport } from './ensure-workspace-links.mjs'

const execFileAsync = promisify(execFile)

const ROOTS = ['src', 'client', 'apps', 'scripts', 'bin']
const SKIP_DIRS = new Set(['basis', 'draco', 'maps'])
const SKIP_VENDORED_FILE = /(\.min\.js$|basis_transcoder|draco_decoder|jolt-physics)/
const MAX_PARALLEL_CHECKS = 16
const GUARDED = ['src/netcode/NetworkState.js', 'src/sdk/EditorHandlers.js', 'src/apps/AppContext.js']
const GENERATED = [
  {
    label: 'apps-manifest.json',
    generator: 'scripts/bundle-apps-manifest.mjs',
    checkArgs: ['scripts/bundle-apps-manifest.mjs', '--check'],
    writeArgs: ['scripts/bundle-apps-manifest.mjs'],
    freshLine: 'check: apps-manifest.json is in sync with ./apps',
    regeneratedLine: 'check: apps-manifest.json was stale and has been regenerated from ./apps',
  },
  {
    label: 'generated SDK typings',
    generator: 'scripts/gen-sdk-typings.mjs',
    checkArgs: ['scripts/gen-sdk-typings.mjs', '--check'],
    writeArgs: ['scripts/gen-sdk-typings.mjs'],
    freshLine: 'check: generated SDK typings match src/apps/AppContext.js',
    regeneratedLine: 'check: generated SDK typings were stale and have been regenerated from src/apps/AppContext.js',
  },
]

async function regenerateIfStale({ checkArgs, writeArgs }) {
  try {
    await execFileAsync(process.execPath, checkArgs)
    return 'fresh'
  } catch {}
  await execFileAsync(process.execPath, writeArgs)
  await execFileAsync(process.execPath, checkArgs)
  return 'regenerated'
}

function collect(out) {
  for (const root of ROOTS) walk(root, out)
  return out
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|cjs)$/.test(name) && !SKIP_VENDORED_FILE.test(name)) out.push(full)
  }
}

async function main() {
  const files = collect([])
  const missingRoots = ROOTS.filter((r) => !existsSync(r))
  if (missingRoots.length) {
    console.error(`check: source root(s) absent, so ${files.length} file(s) were scanned: ${missingRoots.join(', ')}`)
    process.exit(1)
  }
  if (files.length === 0) {
    console.error(`check: 0 tracked source files collected from ${ROOTS.join(', ')} -- an empty parse scan is not a pass`)
    process.exit(1)
  }
  console.log(`check: parsing ${files.length} source file(s) under ${ROOTS.join(', ')}`)

  const failures = []

  const links = ensureWorkspaceLinks()
  if (links.refused.length) {
    for (const line of formatReport(links)) console.error(line)
    console.error(`check: workspace-link repair refused ${links.refused.length} link(s) that resolve outside this tree; the gate stopped before writing`)
    process.exit(1)
  }
  for (const c of links.created) console.log(`check: workspace link node_modules/${c.name} was missing and is now created -> packages/${c.dir}`)
  for (const r of links.repaired) {
    const kept = r.movedTo === null ? '' : ` -- the install it displaced is kept at ${r.movedTo}`
    console.log(`check: workspace link node_modules/${r.name} was ${r.kind} (not a link into packages/) and is now relinked -> packages/${r.dir}${kept}`)
  }
  for (const detail of links.failed) failures.push(`workspace link ${detail} -- run: node scripts/ensure-workspace-links.mjs`)

  let idx = 0
  async function worker() {
    while (idx < files.length) {
      const file = files[idx++]
      try {
        const buf = readFileSync(file)
        if (buf.length && buf[buf.length - 1] === 0) {
          failures.push({ file, error: 'trailing NUL byte(s) - file is corrupted (Windows Edit/Write artifact)' })
          continue
        }
      } catch (e) {
        failures.push({ file, error: 'unreadable: ' + e.message })
        continue
      }
      try {
        await execFileAsync(process.execPath, ['--check', file])
      } catch (e) {
        failures.push({ file, error: (e.stderr || e.message || '').toString().split('\n').slice(0, 3).join(' ') })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_CHECKS, files.length) }, worker))

  if (failures.length) {
    console.error(`check: ${failures.length} of ${files.length} files failed to parse:`)
    for (const f of failures) console.error(`  ${f.file}: ${f.error}`)
    process.exit(1)
  }
  console.log(`check: ${files.length} source files parse cleanly`)

  const guardFails = []
  for (const rel of GUARDED) {
    const full = join(...rel.split('/'))
    let txt = ''
    try { txt = readFileSync(full, 'utf8') } catch (e) {
      guardFails.push(`${rel}: unreadable (${e.message}) -- its NaN-poison guard was not verified`)
      continue
    }
    if (!/shared\/vecGuard/.test(txt)) {
      guardFails.push(`${rel}: accepts external transforms but no longer imports shared/vecGuard - NaN-poison guard removed`)
    }
  }
  if (guardFails.length) {
    console.error(`check: ${guardFails.length} transform-validation guardrail violation(s):`)
    for (const g of guardFails) console.error(`  ${g}`)
    process.exit(1)
  }
  console.log(`check: transform-validation guardrail intact (${GUARDED.length} write-boundary files)`)

  const steps = [
    ['netcode-quat-metamorphic', 'scripts/netcode-quat-metamorphic.mjs', (out) => `check: ${out}`],
    ['netcode-wire-pbt', 'scripts/netcode-wire-pbt.mjs', (out) => `check: ${out}`],
    ['relative import resolution', 'scripts/check-relative-imports.mjs', (out) => `check: ${out}`],
    ['bake code-version closure', 'scripts/check-cache-keys.mjs', (out) => out],
    ['three export-name resolution', 'scripts/check-tsl-imports.mjs', (out) => `check: ${out}`],
    ['SES preflight refusals', 'scripts/check-ses-preflight.mjs', (out) => `check: ${out}`],
    ['app authoring contract', 'scripts/check-app-contract.mjs', (out) => `check: ${out}`],
    ['check pin parse', 'scripts/check-pin-parse-witness.mjs', (out) => `check: ${out}`],
    ['dead-code removal', 'scripts/dead-lib-removal-witness.mjs', (out) => `check: ${out}`],
    ['comment sweep token witness', 'scripts/comment-sweep-token-witness.mjs', (out) => `check: ${out}`],
    ['patch-deps marker witness', 'scripts/patch-deps-marker-witness.mjs', (out) => `check: ${out}`],
    ['model-load gate failure', 'scripts/model-gate-failure-witness.mjs', (out) => `check: ${out}`],
    ['model-load gate', 'scripts/model-load-gate-witness.mjs', (out) => `check: ${out}`],
    ['model failure loading machine', 'scripts/loading-machine-model-failure-witness.mjs', (out) => `check: ${out}`],
    ['singleplayer model gate', 'scripts/singleplayer-model-gate-witness.mjs', (out) => `check: ${out}`],
    ['entity loader refusal', 'scripts/entity-loader-refusal-witness.mjs', (out) => `check: ${out}`],
    ['failed entity environment done', 'scripts/failed-entity-no-env-done-witness.mjs', (out) => `check: ${out}`],
    ['placed model load', 'scripts/placed-model-load-witness.mjs', (out) => `check: ${out}`],
    ['prefab load', 'scripts/prefab-load-witness.mjs', (out) => `check: ${out}`],
    ['three loader error', 'scripts/three-loader-error-witness.mjs', (out) => `check: ${out}`],
    ['force-ready model failure', 'scripts/force-ready-model-failure-witness.mjs', (out) => `check: ${out}`],
    ['agent-commands-witness', 'scripts/agent-commands-witness.mjs', (out) => `check: ${out}`],
    ['agents-md-facts-witness', 'scripts/agents-md-facts-witness.mjs', (out) => `check: ${out}`],
    ['animation-ragdoll-plan-witness', 'scripts/animation-ragdoll-plan-witness.mjs', (out) => `check: ${out}`],
    ['animation-ragdoll-real-skeleton-witness', 'scripts/animation-ragdoll-real-skeleton-witness.mjs', (out) => `check: ${out}`],
    ['app-contract-witness', 'scripts/app-contract-witness.mjs', (out) => `check: ${out}`],
    ['app-loader-refusal-witness', 'scripts/app-loader-refusal-witness.mjs', (out) => `check: ${out}`],
    ['appcontext-field-paint-witness', 'scripts/appcontext-field-paint-witness.mjs', (out) => `check: ${out}`],
    ['asset-registry-witness', 'scripts/asset-registry-witness.mjs', (out) => `check: ${out}`],
    ['ballistics-lead-witness', 'scripts/ballistics-lead-witness.mjs', (out) => `check: ${out}`],
    ['browser-server-worker-error-witness', 'scripts/browser-server-worker-error-witness.mjs', (out) => `check: ${out}`],
    ['character-animator-ragdoll-witness', 'scripts/character-animator-ragdoll-witness.mjs', (out) => `check: ${out}`],
    ['check-app-contract-negative-witness', 'scripts/check-app-contract-negative-witness.mjs', (out) => `check: ${out}`],
    ['checkpoint-nested-radius-witness', 'scripts/checkpoint-nested-radius-witness.mjs', (out) => `check: ${out}`],
    ['cli-help-witness', 'scripts/cli-help-witness.mjs', (out) => `check: ${out}`],
    ['count-verifier-witness', 'scripts/count-verifier-witness.mjs', (out) => `check: ${out}`],
    ['crown-card-layout-witness', 'scripts/crown-card-layout-witness.mjs', (out) => `check: ${out}`],
    ['ctx-ragdoll-witness', 'scripts/ctx-ragdoll-witness.mjs', (out) => `check: ${out}`],
    ['ctx-vibe-witness', 'scripts/ctx-vibe-witness.mjs', (out) => `check: ${out}`],
    ['decision-runtime-witness', 'scripts/decision-runtime-witness.mjs', (out) => `check: ${out}`],
    ['decoration-item-fields-witness', 'scripts/decoration-item-fields-witness.mjs', (out) => `check: ${out}`],
    ['decoration-layers-witness', 'scripts/decoration-layers-witness.mjs', (out) => `check: ${out}`],
    ['define-spec-boundary-witness', 'scripts/define-spec-boundary-witness.mjs', (out) => `check: ${out}`],
    ['define-spec-coverage-witness', 'scripts/define-spec-coverage-witness.mjs', (out) => `check: ${out}`],
    ['define-spec-shape-witness', 'scripts/define-spec-shape-witness.mjs', (out) => `check: ${out}`],
    ['docs-coverage-witness', 'scripts/docs-coverage-witness.mjs', (out) => `check: ${out}`],
    ['easing-tween-witness', 'scripts/easing-tween-witness.mjs', (out) => `check: ${out}`],
    ['editor-field-paint-witness', 'scripts/editor-field-paint-witness.mjs', (out) => `check: ${out}`],
    ['engine-pin-witness', 'scripts/engine-pin-witness.mjs', (out) => `check: ${out}`],
    ['field-paint-config-witness', 'scripts/field-paint-config-witness.mjs', (out) => `check: ${out}`],
    ['field-paint-persist-witness', 'scripts/field-paint-persist-witness.mjs', (out) => `check: ${out}`],
    ['field-paint-place-witness', 'scripts/field-paint-place-witness.mjs', (out) => `check: ${out}`],
    ['field-paint-terrain-wiring-witness', 'scripts/field-paint-terrain-wiring-witness.mjs', (out) => `check: ${out}`],
    ['find-path-status-witness', 'scripts/find-path-status-witness.mjs', (out) => `check: ${out}`],
    ['grass-seam-card-witness', 'scripts/grass-seam-card-witness.mjs', (out) => `check: ${out}`],
    ['grass-wind-field-seam-witness', 'scripts/grass-wind-field-seam-witness.mjs', (out) => `check: ${out}`],
    ['ground-detail-reach-witness', 'scripts/ground-detail-reach-witness.mjs', (out) => `check: ${out}`],
    ['hot-swap-accept-witness', 'scripts/hot-swap-accept-witness.mjs', (out) => `check: ${out}`],
    ['http-door-catalog-witness', 'scripts/http-door-catalog-witness.mjs', (out) => `check: ${out}`],
    ['joint-map-witness', 'scripts/joint-map-witness.mjs', (out) => `check: ${out}`],
    ['lag-overflow-witness', 'scripts/lag-overflow-witness.mjs', (out) => `check: ${out}`],
    ['leaf-spray-texture-witness', 'scripts/leaf-spray-texture-witness.mjs', (out) => `check: ${out}`],
    ['live-exec-witness', 'scripts/live-exec-witness.mjs', (out) => `check: ${out}`],
    ['natural-mask-consumer-witness', 'scripts/natural-mask-consumer-witness.mjs', (out) => `check: ${out}`],
    ['nav-cost-witness', 'scripts/nav-cost-witness.mjs', (out) => `check: ${out}`],
    ['nearfield-lod-lattice-witness', 'scripts/nearfield-lod-lattice-witness.mjs', (out) => `check: ${out}`],
    ['path-handle-witness', 'scripts/path-handle-witness.mjs', (out) => `check: ${out}`],
    ['pivot-riders-witness', 'scripts/pivot-riders-witness.mjs', (out) => `check: ${out}`],
    ['postfx-graph-structure-witness', 'scripts/postfx-graph-structure-witness.mjs', (out) => `check: ${out}`],
    ['postfx-look-witness', 'scripts/postfx-look-witness.mjs', (out) => `check: ${out}`],
    ['postfx-render-graph-witness', 'scripts/postfx-render-graph-witness.mjs', (out) => `check: ${out}`],
    ['press-router-witness', 'scripts/press-router-witness.mjs', (out) => `check: ${out}`],
    ['private-body-witness', 'scripts/private-body-witness.mjs', (out) => `check: ${out}`],
    ['projectile-gravity-witness', 'scripts/projectile-gravity-witness.mjs', (out) => `check: ${out}`],
    ['quat-witness', 'scripts/quat-witness.mjs', (out) => `check: ${out}`],
    ['ragdoll-activation-witness', 'scripts/ragdoll-activation-witness.mjs', (out) => `check: ${out}`],
    ['reference-bundle-witness', 'scripts/reference-bundle-witness.mjs', (out) => `check: ${out}`],
    ['rock-model-exclusion-witness', 'scripts/rock-model-exclusion-witness.mjs', (out) => `check: ${out}`],
    ['room-routing-witness', 'scripts/room-routing-witness.mjs', (out) => `check: ${out}`],
    ['run-manifest-witness', 'scripts/run-manifest-witness.mjs', (out) => `check: ${out}`],
    ['script-preflight-witness', 'scripts/script-preflight-witness.mjs', (out) => `check: ${out}`],
    ['scripted-terrain-witness', 'scripts/scripted-terrain-witness.mjs', (out) => `check: ${out}`],
    ['server-field-paint-host-witness', 'scripts/server-field-paint-host-witness.mjs', (out) => `check: ${out}`],
    ['server-restart-loadworld-witness', 'scripts/server-restart-loadworld-witness.mjs', (out) => `check: ${out}`],
    ['shared-lattice-surface-witness', 'scripts/shared-lattice-surface-witness.mjs', (out) => `check: ${out}`],
    ['skill-md-facts-witness', 'scripts/skill-md-facts-witness.mjs', (out) => `check: ${out}`],
    ['source-ledger-witness', 'scripts/source-ledger-witness.mjs', (out) => `check: ${out}`],
    ['spline-witness', 'scripts/spline-witness.mjs', (out) => `check: ${out}`],
    ['src-batch1-rules-witness', 'scripts/src-batch1-rules-witness.mjs', (out) => `check: ${out}`],
    ['src-batch3-rules-witness', 'scripts/src-batch3-rules-witness.mjs', (out) => `check: ${out}`],
    ['surface-velocity-witness', 'scripts/surface-velocity-witness.mjs', (out) => `check: ${out}`],
    ['terrain-field-paint-witness', 'scripts/terrain-field-paint-witness.mjs', (out) => `check: ${out}`],
    ['terrain-mark-kinds-witness', 'scripts/terrain-mark-kinds-witness.mjs', (out) => `check: ${out}`],
    ['terrain-marks-readers-witness', 'scripts/terrain-marks-readers-witness.mjs', (out) => `check: ${out}`],
    ['terrain-marks-wiring-witness', 'scripts/terrain-marks-wiring-witness.mjs', (out) => `check: ${out}`],
    ['terrain-paint-restart-witness', 'scripts/terrain-paint-restart-witness.mjs', (out) => `check: ${out}`],
    ['tester-body-witness', 'scripts/tester-body-witness.mjs', (out) => `check: ${out}`],
    ['tick-drop-counter-witness', 'scripts/tick-drop-counter-witness.mjs', (out) => `check: ${out}`],
    ['touch-selector-channels-witness', 'scripts/touch-selector-channels-witness.mjs', (out) => `check: ${out}`],
    ['touch-surface-resolver-witness', 'scripts/touch-surface-resolver-witness.mjs', (out) => `check: ${out}`],
    ['trigger-volume-witness', 'scripts/trigger-volume-witness.mjs', (out) => `check: ${out}`],
    ['two-sided-trade-witness', 'scripts/two-sided-trade-witness.mjs', (out) => `check: ${out}`],
    ['vec3-witness', 'scripts/vec3-witness.mjs', (out) => `check: ${out}`],
    ['vibe-event-list-witness', 'scripts/vibe-event-list-witness.mjs', (out) => `check: ${out}`],
    ['vibe-pattern-witness', 'scripts/vibe-pattern-witness.mjs', (out) => `check: ${out}`],
    ['voxels-witness', 'scripts/voxels-witness.mjs', (out) => `check: ${out}`],
    ['water-helpers-witness', 'scripts/water-helpers-witness.mjs', (out) => `check: ${out}`],
    ['water-level-witness', 'scripts/water-level-witness.mjs', (out) => `check: ${out}`],
    ['witness-server-assertions-witness', 'scripts/witness-server-assertions-witness.mjs', (out) => `check: ${out}`],
    ['worker-entry-bare-specifier-witness', 'scripts/worker-entry-bare-specifier-witness.mjs', (out) => `check: ${out}`],
    ['worker-field-paint-witness', 'scripts/worker-field-paint-witness.mjs', (out) => `check: ${out}`],
    ['world-identity-witness', 'scripts/world-identity-witness.mjs', (out) => `check: ${out}`],
    ['world-movement-parse-witness', 'scripts/world-movement-parse-witness.mjs', (out) => `check: ${out}`],
    ['movement-defaults-readme-witness', 'scripts/movement-defaults-readme-witness.mjs', (out) => `check: ${out}`],
    ['default-world-movement-readme-witness', 'scripts/default-world-movement-readme-witness.mjs', (out) => `check: ${out}`],
    ['docs-page-freshness-witness', 'scripts/docs-page-freshness-witness.mjs', (out) => `check: ${out}`],
    ['static-handler-containment-witness', 'scripts/static-handler-containment-witness.mjs', (out) => `check: ${out}`],
    ['static-handler-derived-containment-witness', 'scripts/static-handler-derived-containment-witness.mjs', (out) => `check: ${out}`],
    ['fetch-manifest-containment-witness', 'scripts/fetch-manifest-containment-witness.mjs', (out) => `check: ${out}`],
    ['input-codec-encode-witness', 'scripts/input-codec-encode-witness.mjs', (out) => `check: ${out}`],
    ['input-codec-quantize-witness', 'scripts/input-codec-quantize-witness.mjs', (out) => `check: ${out}`],
    ['expr-truncation-witness', 'scripts/expr-truncation-witness.mjs', (out) => `check: ${out}`],
    ['chart-wire-input-gating-witness', 'scripts/chart-wire-input-gating-witness.mjs', (out) => `check: ${out}`],
    ['chart-resync-reply-witness', 'scripts/chart-resync-reply-witness.mjs', (out) => `check: ${out}`],
    ['chart-wire-stats-witness', 'scripts/chart-wire-stats-witness.mjs', (out) => `check: ${out}`],
    ['transport-connect-error-witness', 'scripts/transport-connect-error-witness.mjs', (out) => `check: ${out}`],
    ['ses-evaluator-witness', 'scripts/ses-evaluator-witness.mjs', (out) => `check: ${out}`],
    ['sandbox-unavailable-witness', 'scripts/sandbox-unavailable-witness.mjs', (out) => `check: ${out}`],
    ['relocation-search-nodata-witness', 'scripts/relocation-search-nodata-witness.mjs', (out) => `check: ${out}`],
    ['input-codec-decode-witness', 'scripts/input-codec-decode-witness.mjs', (out) => `check: ${out}`],
    ['lockstep-input-delay-witness', 'scripts/lockstep-input-delay-witness.mjs', (out) => `check: ${out}`],
    ['rollback-stall-witness', 'scripts/rollback-stall-witness.mjs', (out) => `check: ${out}`],
    ['write-verified-witness', 'scripts/write-verified-witness.mjs', (out) => `check: ${out}`],
    ['receipt-audit', 'scripts/lib/witness-receipt-audit.mjs', (out) => `check: ${out}`],
    ['xr-teleport-ground-witness', 'scripts/xr-teleport-ground-witness.mjs', (out) => `check: ${out}`],
    ['xr-pointer-ground-witness', 'scripts/xr-pointer-ground-witness.mjs', (out) => `check: ${out}`],
    ['xr-arc-frame-order-witness', 'scripts/xr-arc-frame-order-witness.mjs', (out) => `check: ${out}`],
    ['xr-teleport-warm-witness', 'scripts/xr-teleport-warm-witness.mjs', (out) => `check: ${out}`],
  ]
  for (const [label, file, fmt] of steps) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [file])
      for (const line of stdout.split('\n')) if (line.trim()) console.log(fmt(line))
    } catch (e) {
      console.error(`check: ${label}:`, [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim())
      process.exit(1)
    }
  }
  for (const artifact of GENERATED) {
    try {
      const state = await regenerateIfStale(artifact)
      console.log(state === 'fresh' ? artifact.freshLine : artifact.regeneratedLine)
    } catch (e) {
      console.error(`check: ${artifact.label} is stale and could not be regenerated; run: node ${artifact.generator}`, (e.stderr || e.message || '').toString().trim())
      process.exit(1)
    }
  }

  const imports = await checkAppImports()
  if (imports.problems.length) {
    console.error(`check: ${imports.problems.length} app import/asset resolution problem(s):`)
    for (const p of imports.problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`check: ${imports.count ?? 'all'} app(s) resolve every import`)
}

main().catch((e) => { console.error('check: harness error:', e); process.exit(2) })
