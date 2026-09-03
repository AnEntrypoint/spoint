// Stateless entity/app-state helpers for AppRuntime.js: sandboxed asset-path containment check and the
// Map/Set-preserving tag/untag pair for ctx.state (app-owned internal state that may hold live Map/Set
// instances -- see tagAppState's own comment for why the naive JSON round-trip snapshotGameState/
// restoreGameState uses for entity.custom silently drops them). Split out as AppRuntime.js's only
// pure-function block -- everything else in that file is an AppRuntime instance method reading `this.*`.
// Node fs/path handles are resolved here too (containedAssetPath needs realpathSync/sep); AppRuntime.js
// imports the SAME resolved handles for its own resolveAssetPath rather than re-resolving them.

let _existsSync = null, _resolve = null, _realpathSync = null, _sep = '/'
try { if (typeof process !== 'undefined' && process.versions?.node) { const fs = await import('node:fs'); const path = await import('node:path'); _existsSync = fs.existsSync; _resolve = path.resolve; _realpathSync = fs.realpathSync; _sep = path.sep } } catch {}

function containedAssetPath(filePath, rootDir) {
  if (!_realpathSync || !rootDir) return null
  let rootReal
  try { rootReal = _realpathSync(rootDir) } catch { return null }
  const prefix = rootReal.endsWith(_sep) ? rootReal : rootReal + _sep
  let real
  try { real = _realpathSync(filePath) } catch { return null }
  return (real === rootReal || real.startsWith(prefix)) ? real : null
}

// tps-game-ctx-state-buffs-not-iterable: ctx.state (entity._appState) is app-owned internal state, and
// several shipped apps (apps/tps-game/index.js's buffs/invuln/respawning/ammo/reloading/lastEmoteAt/
// fallTimers/killStreaks/powerups/playerStats, all constructed as `new Map()` in setup()) store real
// Map/Set instances in it. A naive `JSON.parse(JSON.stringify(appState))` -- the discipline
// snapshotGameState/restoreGameState already used for entity.custom, which genuinely IS meant to be
// plain-JSON/editor-facing -- silently downgrades any Map to `{}` (JSON.stringify(new Map()) is "{}",
// there is no Map wire type) and any Set to `{}` too. Both restoreGameState (in-process rollback +
// hot-reload, see rollback-entity-gamestate-snapshot) and WorldPersistence.js's on-disk restart-survival
// save/restore round-trip appState through this exact path, so EVERY app whose ctx.state holds a Map
// silently loses it on the next resimulate/restore -- e.g. `for (const [pid,buff] of ctx.state.buffs)`
// throwing "ctx.state.buffs is not iterable" the next time update() runs after a restore, since
// ctx.state.buffs is now a plain object, not a Map. Fixed at the root (not per-app defensive guards,
// which only patch the ONE field a given app happened to notice broke) via a tagged Map/Set-preserving
// pair, used ONLY for appState (custom stays plain JSON -- editor/wire-format contract, must not
// silently start carrying non-JSON-safe tags).
//
// IMPORTANT split, found live via the WorldPersistence.js on-disk path: snapshotGameState's OWN output
// must stay a plain-JSON-safe TAGGED shape (never a live Map/Set instance), not a fully round-tripped-
// back-to-Map value -- WorldPersistence.buildWorldSnapshot takes snapshotGameState's entities verbatim
// and hands them straight to storage.set (FSAdapter.set does its own unguarded JSON.stringify(value)
// with no replacer of its own), so a live Map sitting in that structure gets silently flattened to `{}`
// a SECOND time on the way to disk, exactly reproducing the original bug one level downstream. Tagging
// at snapshot time (tagAppState) and reviving only at actual restore time (untagAppState, called from
// restoreGameState) keeps the snapshot object plain-JSON-safe everywhere in between, correct for both
// the in-process rollback consumer (never itself re-serializes the snapshot) and the on-disk consumer
// (storage.set's plain JSON.stringify is now a no-op on an already-plain-JSON tree).
function tagAppState(state) {
  if (!state) return null
  const replacer = (key, value) => {
    if (value instanceof Map) return { __type: 'Map', entries: [...value.entries()] }
    if (value instanceof Set) return { __type: 'Set', values: [...value.values()] }
    return value
  }
  return JSON.parse(JSON.stringify(state, replacer))
}
// Reviving on the way in tolerates EITHER a tagged plain-JSON shape (the normal case: freshly tagged by
// tagAppState above, or read back off disk after a real storage.get/JSON.parse round trip) OR a
// snapshot taken BEFORE this fix existed (on-disk, from an old process -- has plain `{}` where a Map
// used to be, no tag at all) -- reviving that degrades to a plain object, not a fabricated Map, which is
// the correct honest-degrade behavior for old data rather than a hard requirement on snapshot shape.
function untagAppState(state) {
  if (!state) return null
  const reviver = (key, value) => {
    if (value && typeof value === 'object' && value.__type === 'Map' && Array.isArray(value.entries)) return new Map(value.entries)
    if (value && typeof value === 'object' && value.__type === 'Set' && Array.isArray(value.values)) return new Set(value.values)
    return value
  }
  // state may already be a plain-JSON tree (tagAppState's own output, or a fresh JSON.parse off disk) --
  // stringify-then-parse-with-reviver is the simplest way to apply the reviver uniformly to every nested
  // level without hand-walking the tree twice for the two different possible input shapes.
  return JSON.parse(JSON.stringify(state), reviver)
}

export { containedAssetPath, tagAppState, untagAppState, _existsSync, _resolve, _realpathSync, _sep }
