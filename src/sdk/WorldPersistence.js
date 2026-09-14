import { canonicalJSON } from '../shared/canonicalJSON.js'
import { createChecksumFold } from '../netcode/LockstepChecksum.js'

export const WORLD_SNAPSHOT_FORMAT_VERSION = 1

function mapToEntries(m) { return m ? [...m.entries()] : [] }
function entriesToMap(e) { return new Map(e || []) }
function yieldToEventLoop() { return new Promise(resolve => setImmediate(resolve)) }
function envWorldName() { return typeof process !== 'undefined' && process.env ? process.env.WORLD : undefined }

export function worldDefFingerprint(worldDef) {
  const fold = createChecksumFold()
  const text = canonicalJSON(worldDef)
  for (let i = 0; i < text.length; i++) fold.pushInt(text.charCodeAt(i))
  return 'def-' + fold.digest()
}

export function resolveWorldName(ctx) {
  return ctx.currentWorldDef?.name || ctx.worldName || envWorldName() || null
}

export function buildWorldSnapshot(appRuntime, physics, worldName) {
  const game = appRuntime.snapshotGameState({ includeStatic: true })
  const entities = []
  for (const [id, s] of game.entities) {
    const e = appRuntime.entities.get(id)
    const bodyId = e && e._physicsBodyId !== undefined ? e._physicsBodyId : undefined
    let body = null
    if (bodyId !== undefined && physics && typeof physics.getBodyVelocity === 'function') {
      if (e.bodyType !== 'static') {
        body = {
          position: physics.getBodyPosition(bodyId),
          rotation: physics.getBodyRotation(bodyId),
          velocity: physics.getBodyVelocity(bodyId),
          angularVelocity: physics.getBodyAngularVelocity ? physics.getBodyAngularVelocity(bodyId) : [0, 0, 0]
        }
      }
    }
    entities.push({ id, ...s, body })
  }
  return {
    version: WORLD_SNAPSHOT_FORMAT_VERSION,
    world: worldName || null,
    tick: game.tick,
    savedAt: Date.now(),
    entities,
    respawnTimers: mapToEntries(game.respawnTimers),
    timers: mapToEntries(game.timers).map(([id, list]) => [id, list.map(t => ({ remaining: t.remaining, repeat: t.repeat, interval: t.interval }))]),
    interactCooldowns: mapToEntries(game.interactCooldowns)
  }
}

export async function saveWorldSnapshot(ctx) {
  const { appRuntime, physics, storage } = ctx
  if (!appRuntime || !storage) return false
  try {
    await yieldToEventLoop()
    const snap = buildWorldSnapshot(appRuntime, physics, resolveWorldName(ctx))
    await storage.set('world-snapshot', snap)
    console.log(`[world-persistence] saved snapshot: tick=${snap.tick} entities=${snap.entities.length}`)
    return true
  } catch (e) {
    console.error('[world-persistence] save error:', e.message)
    return false
  }
}

export async function restoreWorldSnapshot(ctx) {
  const { appRuntime, physics, storage } = ctx
  if (!appRuntime || !storage) return { restored: false, reason: 'no-runtime' }
  let snap
  try { snap = await storage.get('world-snapshot') } catch (e) { console.error('[world-persistence] load error:', e.message); return { restored: false, reason: 'load-error' } }
  if (!snap) return { restored: false, reason: 'no-snapshot' }
  if (snap.version !== WORLD_SNAPSHOT_FORMAT_VERSION) {
    console.warn(`[world-persistence] snapshot format version mismatch (saved=${snap.version} current=${WORLD_SNAPSHOT_FORMAT_VERSION}) -- discarding, booting clean`)
    return { restored: false, reason: 'version-mismatch' }
  }
  const worldName = resolveWorldName(ctx)
  if (snap.world !== worldName) {
    console.warn(`[world-persistence] snapshot world mismatch (saved="${snap.world}" current="${worldName}") -- discarding, booting clean`)
    return { restored: false, reason: 'world-mismatch' }
  }
  const entities = new Map()
  const bodyStateByLiveBodyId = new Map()
  let bodiesRestored = 0, bodiesSkippedNotFound = 0
  for (const e of snap.entities) {
    const { id, body, ...s } = e
    entities.set(id, s)
    if (body) {
      const live = appRuntime.entities.get(id)
      const liveBodyId = live && live._physicsBodyId !== undefined ? live._physicsBodyId : undefined
      if (liveBodyId !== undefined) { bodyStateByLiveBodyId.set(liveBodyId, body); bodiesRestored++ }
      else bodiesSkippedNotFound++
    }
  }
  appRuntime.restoreGameState({
    tick: snap.tick,
    entities,
    respawnTimers: entriesToMap(snap.respawnTimers),
    timers: new Map(),
    interactCooldowns: entriesToMap(snap.interactCooldowns)
  })
  if (physics && typeof physics.restoreBodies === 'function' && bodyStateByLiveBodyId.size) physics.restoreBodies(bodyStateByLiveBodyId)
  console.log(`[world-persistence] restored snapshot: tick=${snap.tick} entities=${entities.size} bodies=${bodiesRestored}${bodiesSkippedNotFound ? ` (skipped ${bodiesSkippedNotFound}, body not yet created)` : ''}`)
  return { restored: true, tick: snap.tick, entityCount: entities.size, bodiesRestored, bodiesSkippedNotFound }
}
