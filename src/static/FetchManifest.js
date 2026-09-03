// FetchManifest -- bake-time per-map FETCH MANIFEST generation, so a client can open every asset
// range/whole-file request for a map up front (instead of discovering each dependency serially as
// GLTFLoader/ModelPool parses one file and only then learns the next one it needs), and so the
// server can pair the highest-priority entries with real HTTP early hints (see StaticHandler.js's
// 103 Early Hints wiring, which reads this manifest's own ordering).
//
// Priority ordering is intentionally derived from the SAME scoreRequest() formula
// client/core/StreamingScheduler.js's live runtime scheduler uses (distance/screenSize/frustum/
// gameplayBoost -> numeric urgency, lower=more urgent) -- see that file's own module comment and
// this row's PRD detail ("the manifest's emitted priority ordering should be derived from the SAME
// scoreRequest() formula ... so a bake-time preload hint and a runtime dispatch never disagree on
// what 'high priority' means for a given asset"). scoreRequest is a pure function with no DOM/window
// dependency (guarded `typeof window !== 'undefined'` at its own bottom before touching window), so
// it dual-imports cleanly into this server-only module -- re-implementing the formula here would be
// exactly the kind of "every system reinvents its own priority" drift StreamingScheduler's own
// comment names as the problem it exists to prevent.
//
// A world entity has no live camera/frustum at bake time (there is no camera yet -- this runs
// server-side before any client connects), so the manifest can only approximate the features
// scoreRequest expects:
//   distance   0 for the world's own configured spawn point (worldSpawnPoint / worldDef.player.spawn
//              if present, else world origin) to the entity's own placed position -- the real
//              bake-time proxy for "how far will the player's camera actually be on first frame".
//   screenSize entity radius approximated via its target-model bounding info if cheaply available,
//              else the neutral default (scoreRequest already defaults screenSize to 1 when absent,
//              so omitting it here is a genuine "unknown, let the formula's own neutral default
//              apply" rather than a guessed number that would silently claim false precision).
//   inFrustum  always true at bake time (no camera exists yet to test against -- see above; every
//              entity is optimistically "will need this soon", matching scoreRequest's own doc that
//              out-of-frustum is a deprioritization multiplier, never a hard exclude, so defaulting
//              true here is the same "assume relevant until proven otherwise" posture, just applied
//              at a point in time where there is nothing to disprove it with yet).
//   gameplayBoost worldDef.entities[].custom._preloadBoost (0..1) if a world author set one (e.g. the
//              player's own starting weapon/vehicle), else 0 -- an explicit opt-in escape hatch for
//              "this asset matters more than distance alone says" at bake time too, matching
//              scoreRequest's own gameplayBoost semantics.
//
// The manifest's per-entry `url` is the REAL fetchable path a client's StaticHandler request already
// understands: the plain transformed-GLB URL, plus one entry per extracted KTX2 sub-resource (the
// `<model>.glb.ktx2/<imageIndex>.ktx2` virtual route KTX2Extract.js/StaticHandler.js already serve,
// Range-enabled) so a client (or a <link rel=preload> / 103 Early Hints response) can open the
// low-mip KTX2 fetch directly without first waiting on a whole-GLB round trip to discover it exists.
//
// scoreRequest is loaded via a RUNTIME dynamic import (never a static `import ... from`) resolved
// from this module's own on-disk location at import.meta.url, not a hardcoded relative specifier --
// this file is Node-server-only (StaticHandler.js's buildFetchManifest dev/prod helper) and is never
// meant to be part of the browser Worker bundle at all, but esbuild's static-analysis import graph
// still walks a top-level `import ... from '../../client/core/StreamingScheduler.js'` regardless of
// runtime reachability (see AGENTS.md workerentry-bundle-fetchmanifest-streamingscheduler-dist-path-miss).
// A relative specifier is also genuinely WRONG in the deployed gh-pages dist/ layout: .github/workflows/
// gh-pages.yml's "Build dist" step does `cp -r client/* dist/`, which FLATTENS client/'s contents to
// dist/ root (dist/core/StreamingScheduler.js), while `cp -r src/static dist/src/static` keeps src/'s
// own src/ prefix (dist/src/static/FetchManifest.js) -- so the SAME relative path that resolves
// correctly in the real repo (src/static/../../client/core/... = repo-root client/core/...) resolves
// in dist/ to a directory that never exists (dist/client/core/...) instead of the real dist/core/...
// two levels up. Probing both real on-disk layouts by existsSync at runtime, rather than hardcoding
// either, keeps this file correct in the real repo, the flattened gh-pages dist/, and any other future
// layout that preserves this relative-depth relationship, without needing a build-time path patch.
import { existsSync, statSync } from 'node:fs'
import { resolve, sep, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getTransformedAsync } from './GLBTransformer.js'
import { getKtx2Extracted } from './KTX2Extract.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Candidate on-disk locations for client/core/StreamingScheduler.js relative to THIS file, in
// probe order: (1) the real repo layout (src/static/../../client/core/...), (2) the flattened
// gh-pages dist/ layout (dist/src/static/../../core/..., one fewer directory since client/'s own
// prefix is gone in dist/).
const _streamingSchedulerCandidates = [
  join(__dirname, '../../client/core/StreamingScheduler.js'),
  join(__dirname, '../../core/StreamingScheduler.js'),
]
let _scoreRequestPromise = null
function _loadScoreRequest() {
  if (!_scoreRequestPromise) {
    const fp = _streamingSchedulerCandidates.find(existsSync)
    if (!fp) return Promise.reject(new Error('FetchManifest: could not locate client/core/StreamingScheduler.js in any known layout (tried: ' + _streamingSchedulerCandidates.join(', ') + ')'))
    _scoreRequestPromise = import(pathToFileURL(fp).href).then(m => m.scoreRequest)
  }
  return _scoreRequestPromise
}

const _manifestCache = new Map() // worldName -> { mtimeKey, manifest }

// Resolves a worldDef entity's `model` path (e.g. './apps/maps/aim_sillos.glb') to (a) a real
// filesystem path for bake-pipeline reads and (b) the '/apps/...' URL a client actually fetches --
// same two-directory precedence (project override, then SDK bundled default) server.js's own
// existing env-model resolveModel() closure already uses for the progressive-bake prewarm, kept
// consistent here rather than reinventing a third resolution order.
function resolveModelPaths(model, project, sdkRoot) {
  const rel = model.startsWith('./') ? model.slice(2) : model.startsWith('/') ? model.slice(1) : model
  for (const dir of [project, sdkRoot]) {
    const fp = resolve(dir, rel)
    if (existsSync(fp)) return { fp, url: '/' + rel.split(sep).join('/') }
  }
  return null
}

function _entityDistance(entity, spawn) {
  const p = entity.position
  if (!Array.isArray(p) || p.length < 3) return 0
  const sp = Array.isArray(spawn) && spawn.length >= 3 ? spawn : [0, 0, 0]
  const dx = p[0] - sp[0], dy = p[1] - sp[1], dz = p[2] - sp[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

// buildManifestEntries(worldDef, project, sdkRoot) -> Promise<Array<manifest entry>>, unsorted
// input order; sorting by score happens in buildFetchManifest so this stays independently testable
// (a live witness can call this alone and check per-entry scores without needing the sort to hide a
// scoring bug behind array order).
export async function buildManifestEntries(worldDef, project, sdkRoot) {
  const scoreRequest = await _loadScoreRequest()
  const entities = Array.isArray(worldDef.entities) ? worldDef.entities : []
  const spawn = worldDef.worldSpawnPoint || worldDef.player?.spawn || [0, 0, 0]
  const entries = []
  const seenModel = new Set() // one manifest entry per unique model file, even if placed multiple times
  for (const entity of entities) {
    if (!entity.model || typeof entity.model !== 'string') continue
    if (seenModel.has(entity.model)) continue
    seenModel.add(entity.model)
    const resolved = resolveModelPaths(entity.model, project, sdkRoot)
    if (!resolved) continue
    const { fp, url } = resolved
    let stat
    try { stat = statSync(fp) } catch { continue }
    const features = {
      distance: _entityDistance(entity, spawn),
      inFrustum: true,
      gameplayBoost: Number.isFinite(entity.custom?._preloadBoost) ? entity.custom._preloadBoost : 0,
    }
    const score = scoreRequest(features)
    // Whole-GLB manifest entry -- always present; this is the "open the range request now" hint even
    // when KTX2 extraction hasn't produced sub-resources yet (a fresh/never-baked asset), so the
    // manifest degrades to "just the GLB" instead of omitting the asset outright.
    let byteSize = stat.size
    try {
      const transformed = await getTransformedAsync(fp)
      if (transformed) byteSize = transformed.length
    } catch { /* transform failed -- fall back to source file size, still a real fetchable URL */ }
    entries.push({ url, kind: 'model', score, byteSize, entityId: entity.id || null })

    // KTX2 sub-resource entries -- only added once extraction has actually produced files (kicked off
    // as a side effect of getKtx2Extracted; a first-ever bake may still be extracting, in which case
    // this correctly contributes zero sub-entries for this pass rather than guessing indices that
    // don't exist on disk yet -- a later manifest rebuild picks them up once ready, same eventual-
    // consistency contract getKtx2Extracted's own callers already rely on).
    try {
      const ktx2Ready = getKtx2Extracted(fp)
      if (ktx2Ready) {
        for (const idx of ktx2Ready.indices) {
          entries.push({
            url: `${url}.ktx2/${idx}.ktx2`,
            kind: 'textureMip',
            // texture mips are slightly less urgent than the mesh itself at the SAME distance (a
            // model can render as a bounding-box placeholder before its texture arrives, but not
            // before its geometry does) -- a small fixed multiplier keeps this monotonic with the
            // model's own score without inventing a second scoring axis the runtime scheduler
            // doesn't also have (this manifest must stay a strict re-derivation of scoreRequest, not
            // a bake-time-only heuristic the live scheduler would disagree with).
            score: score * 1.05,
            byteSize: null, // per-mip size varies by level and isn't known without a further per-level parse; omitted rather than guessed
            entityId: entity.id || null,
          })
        }
      }
    } catch { /* extraction not ready / not a KTX2-bearing GLB -- no sub-entries this pass */ }
  }
  return entries
}

// buildFetchManifest(worldName, worldDef, project, sdkRoot) -> Promise<manifest object>
// { worldName, generatedAt, entries: [ ...sorted ascending by score (most urgent first) ] }
// Cached by a cheap mtime-sum key so repeated requests for an unchanged world don't re-walk the
// bake pipeline every time (mirrors the house getTransformed/getKtx2Extracted mtime-cache idiom,
// scoped to this module's own coarser per-world granularity).
export async function buildFetchManifest(worldName, worldDef, project, sdkRoot) {
  const entities = Array.isArray(worldDef.entities) ? worldDef.entities : []
  let mtimeKey = ''
  for (const e of entities) {
    if (!e.model) continue
    const resolved = resolveModelPaths(e.model, project, sdkRoot)
    if (!resolved) continue
    try { mtimeKey += `${e.model}:${statSync(resolved.fp).mtimeMs};` } catch {}
    // KTX2 extraction readiness is its OWN axis of change independent of the GLB's mtime: the GLB file
    // itself doesn't change when its background extraction (kicked off by any getKtx2Extracted call,
    // possibly from an unrelated earlier request -- e.g. a client directly hitting the `.glb.ktx2/`
    // virtual route before ever fetching the manifest) finishes going from 0 extracted sub-resources to
    // N. Folding the extracted-index COUNT into the cache key (not just calling getKtx2Extracted again,
    // which is what buildManifestEntries already does) means a manifest built while extraction was
    // still in flight gets correctly rebuilt with the new KTX2 sub-entries once it completes, instead of
    // being served stale forever from a cache keyed on a GLB mtime that never moves again. Cheap: this
    // is the SAME synchronous, non-blocking getKtx2Extracted() call buildManifestEntries makes per
    // entry -- calling it here too just reads its already-computed in-memory readiness state a second
    // time, no extra bake/extraction work triggered.
    try { const ready = getKtx2Extracted(resolved.fp); mtimeKey += `ktx2:${ready ? ready.indices.length : 0};` } catch {}
  }
  const cached = _manifestCache.get(worldName)
  if (cached && cached.mtimeKey === mtimeKey) return cached.manifest
  const entries = await buildManifestEntries(worldDef, project, sdkRoot)
  entries.sort((a, b) => a.score - b.score)
  const manifest = { worldName, generatedAt: Date.now(), entries }
  _manifestCache.set(worldName, { mtimeKey, manifest })
  return manifest
}

export function clearManifestCache(worldName) {
  if (worldName) _manifestCache.delete(worldName)
  else _manifestCache.clear()
}
