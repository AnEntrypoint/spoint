// Deathrun/parkour game mode: wires apps/_lib/checkpoint.js's defineCheckpoint (per-player checkpoint
// tracking + fall-plane respawn-to-last-checkpoint, already-existing primitive) together with a real
// SERVER-AUTHORITATIVE run timer and a real per-map leaderboard (apps/deathrun/server.js, same debounced
// ctx.storage atomic-write pattern apps/tps-game/server.js's scoreboard uses). Checkpoints are authored
// in-editor via apps/checkpoint-marker (order 0 = start, highest order = finish) and collected once,
// deferred to the first update() tick (see the setup() comment below). A run starts every time a player
// enters the start volume (re-triggerable -- see _tickStartFinish) and stops the instant they enter the
// finish volume; the elapsed ms is server Date.now()-derived (ctx.time.serverTime), never a
// client-reported value, so a client cannot fake a fast run.
import { defineCheckpoint } from '../_lib/checkpoint.js'
import { collectCheckpointMarkers } from '../checkpoint-marker/index.js'
import { loadLeaderboard, flushLeaderboard, recordRun, getTopEntries } from './server.js'

function fmtTime(ms) {
  if (ms == null) return '--:--.--'
  const totalCs = Math.floor(ms / 10)
  const m = Math.floor(totalCs / 6000)
  const s = Math.floor((totalCs % 6000) / 100)
  const cs = totalCs % 100
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function makeOverlay() {
  if (typeof document === 'undefined') return null
  let root = document.getElementById('deathrun-hud')
  if (root) return root
  root = document.createElement('div')
  root.id = 'deathrun-hud'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;font-family:system-ui,sans-serif'
  root.innerHTML =
    '<div id="dr-timer" style="position:absolute;left:50%;top:18px;transform:translateX(-50%);color:#fff;font-weight:800;font-size:28px;letter-spacing:1px;text-shadow:0 2px 6px #000;font-variant-numeric:tabular-nums">--:--.--</div>' +
    '<div id="dr-result" style="position:absolute;left:50%;top:56px;transform:translateX(-50%);color:#33ff88;font-weight:700;font-size:18px;text-shadow:0 2px 6px #000;opacity:0;transition:opacity .2s"></div>' +
    '<div id="dr-board" style="position:absolute;right:16px;top:16px;min-width:220px;background:rgba(0,0,0,.45);border-radius:8px;padding:10px 14px;color:#fff;font-size:13px">' +
      '<div style="font-weight:800;margin-bottom:6px;letter-spacing:.5px;color:#33ccff">LEADERBOARD</div>' +
      '<div id="dr-board-list"></div>' +
    '</div>'
  document.body.appendChild(root)
  return root
}

// Collects placed checkpoint-marker entities (sorted by order) and builds the course: BOTH (a) a
// defineCheckpoint instance (apps/_lib/checkpoint.js) purely for its fall-plane respawn-to-last-
// checkpoint behavior across the whole ordered sequence, which is a correct fit since "respawn at your
// last checkpoint" only ever needs to reach a NEW highest index once per run, and (b) deathrun's OWN
// re-triggerable start/finish radius check (see _tickStartFinish below) for the run-timer boundary
// events specifically, because defineCheckpoint's own onCheckpoint only ever fires once per player per
// index for the lifetime of that Map entry (monotonic `_cpIndex.get(id) < c.index` guard, see checkpoint.js)
// -- LIVE-WITNESSED this session: a first real timed run finished correctly, but a SECOND real run by the
// same connected player produced zero deathrun_start/deathrun_finish events at all, because index 0 and
// the finish index had already been marked reached and can never re-fire for that player again. A
// restartable game mode structurally cannot use defineCheckpoint's onCheckpoint for its start/finish
// boundary, only for the (correctly one-shot-per-new-index) fall-respawn target update.
// Falls back to a synthetic 2-point course at the world spawn if fewer than 2 markers are placed (so the
// mode still boots in a world with no authored course yet). Called once, from the first real update()
// tick -- see the setup() comment above for why collection cannot happen at setup time.
function _buildCourse(ctx) {
  const markers = collectCheckpointMarkers(ctx)
  if (markers.length < 2) {
    console.warn(`[deathrun] only ${markers.length} checkpoint-marker(s) placed -- need >=2 (start + finish) for a real run; falling back to a synthetic 2-point course at the world spawn so the mode still boots`)
  }
  const cps = markers.length >= 2 ? markers : [
    { position: [0, 15, 0], radius: 5 },
    { position: [0, 15, 20], radius: 5 },
  ]
  ctx.state.finishIndex = cps.length - 1
  ctx.state.startCp = cps[0]
  ctx.state.finishCp = cps[cps.length - 1]
  ctx.state._inStartVol = new Map()  // playerId -> bool, edge-detects start-volume entry (re-triggerable)
  ctx.state._inFinishVol = new Map() // playerId -> bool, edge-detects finish-volume entry (re-triggerable)

  ctx.state.checkpoint = defineCheckpoint({
    spawn: cps[0].position,
    minY: ctx.config?.minY ?? -50,
    checkpoints: cps.map(c => ({ position: c.position, radius: c.radius })),
    onRespawn: () => {
      // Falling below the kill-plane respawns to the last checkpoint (existing defineCheckpoint
      // behavior) -- the run timer is intentionally left untouched here: a fall mid-run is a
      // setback, not a run-ending failure, matching deathrun/parkour genre convention.
    },
  }, ctx)

  console.log(`[deathrun] ${cps.length} checkpoint(s) loaded for map '${ctx.state.map}' (finish index ${ctx.state.finishIndex})`)
}

// Re-triggerable (edge-detected, not monotonic) start/finish volume check -- every player, every tick.
// A player entering the start volume ALWAYS (re)seeds their run start, no matter how many times before;
// entering the finish volume ALWAYS completes a run IF one was in progress. Edge-detected (entered==true
// only on the frame crossing from outside to inside) so standing inside the volume doesn't restart the
// timer every single tick.
function _tickStartFinish(ctx) {
  const start = ctx.state.startCp, finish = ctx.state.finishCp
  if (!start || !finish) return
  const sx = start.position, sr2 = (start.radius ?? 5) ** 2
  const fx = finish.position, fr2 = (finish.radius ?? 5) ** 2
  for (const player of ctx.players.getAll()) {
    const pp = player.state?.position; if (!pp) continue
    const dsx = pp[0] - sx[0], dsy = pp[1] - sx[1], dsz = pp[2] - sx[2]
    const inStart = (dsx * dsx + dsy * dsy + dsz * dsz) <= sr2
    const wasInStart = ctx.state._inStartVol.get(player.id) || false
    ctx.state._inStartVol.set(player.id, inStart)
    if (inStart && !wasInStart) {
      const name = player.name || `Player ${player.id}`
      ctx.state.activeRuns.set(name, ctx.time.serverTime)
      ctx.players.send(player.id, { type: 'deathrun_start' })
    }

    const dfx = pp[0] - fx[0], dfy = pp[1] - fx[1], dfz = pp[2] - fx[2]
    const inFinish = (dfx * dfx + dfy * dfy + dfz * dfz) <= fr2
    const wasInFinish = ctx.state._inFinishVol.get(player.id) || false
    ctx.state._inFinishVol.set(player.id, inFinish)
    if (inFinish && !wasInFinish) {
      const name = player.name || `Player ${player.id}`
      const startMs = ctx.state.activeRuns.get(name)
      if (startMs == null) continue // reached the finish without a tracked start (e.g. joined mid-course) -- not a valid timed run
      const timeMs = ctx.time.serverTime - startMs
      ctx.state.activeRuns.delete(name)
      const { recorded, rank, previousBest } = recordRun(ctx, ctx.state.map, name, timeMs)
      ctx.state.lastResult.set(player.id, { timeMs, isPB: recorded, rank })
      ctx.players.send(player.id, { type: 'deathrun_finish', timeMs, isPB: recorded, rank, previousBest })
      ctx.network.broadcast({ type: 'deathrun_leaderboard', map: ctx.state.map, top: getTopEntries(ctx, ctx.state.map, 10) })
    }
  }
}

export default {
  description: 'Deathrun/parkour mode: server-authoritative checkpoint run timer + persistent per-map leaderboard.',
  server: {
    async setup(ctx) {
      ctx.state.map = ctx.config?.map || 'deathrun_kosova'
      ctx.state.activeRuns = new Map()       // playerName -> startMs (server clock)
      ctx.state.lastResult = new Map()       // playerId -> { timeMs, isPB, rank }
      ctx.state.checkpoint = null            // built once markers are collected -- see _buildCourse below

      await loadLeaderboard(ctx)
      ctx.onShutdown(() => flushLeaderboard(ctx))

      // Checkpoint-marker entities declared alongside this app in the SAME world-def entities[] array are
      // spawned synchronously in array order (AppRuntime.spawnEntity), but each entity's OWN app.setup()
      // (including checkpoint-marker's, which is what actually WRITES custom._deathrunCheckpoint) is
      // attached via a fire-and-forget async _attachApp call -- so collecting markers here, synchronously
      // inside THIS app's own setup(), races those still-pending setup() calls and can see zero markers
      // even when several are declared right below this entity in the world def (live-witnessed: 0
      // markers found despite 2 being declared). Deferring collection to the first real update() tick
      // (ticks run on a timer well after the whole synchronous boot-time entity-spawn loop AND every
      // entity's setup() has had a chance to run) is the same "wait for the next scheduling boundary"
      // idiom AppRuntime._scheduleRebuild already uses (setImmediate) for an analogous ordering problem.
      ctx.state._courseBuilt = false
    },
    update(ctx, dt) {
      if (!ctx.state._courseBuilt) {
        ctx.state._courseBuilt = true
        _buildCourse(ctx)
      }
      ctx.state.checkpoint?.tick(dt) // fall-plane respawn-to-last-checkpoint only, see _buildCourse comment
      _tickStartFinish(ctx)          // re-triggerable start/finish timer boundary, see its own comment
    },
    onMessage(ctx, msg) {
      if (!msg) return
      if (msg.type === 'player_join') {
        const p = ctx.players.getById(msg.playerId)
        const name = p?.name || `Player ${msg.playerId}`
        ctx.players.send(msg.playerId, { type: 'deathrun_leaderboard', map: ctx.state.map, top: getTopEntries(ctx, ctx.state.map, 10) })
        // A run in progress at disconnect stays keyed by NAME (not the ephemeral playerId, which changes
        // on reconnect) in ctx.state.activeRuns, so a genuine reconnect mid-run resumes its elapsed timer
        // rather than losing it -- matches apps/tps-game/index.js's own by-name durable-state precedent
        // for exactly this "ephemeral id changes, name persists" reconnect case.
        void name
      }
      if (msg.type === 'player_leave') {
        // Intentionally NOT deleting ctx.state.activeRuns here: the entry is keyed by player NAME so a
        // reconnect (new ephemeral playerId, same name) can resume the in-flight timer above. A player
        // who leaves for good simply never finishes that run -- the entry sits harmlessly in the Map
        // (bounded by distinct-name count, not unbounded growth) until overwritten by their next start.
        ctx.state.lastResult.delete(msg.playerId)
      }
    },
  },

  client: {
    setup(engine) {
      engine._deathrun = { overlay: makeOverlay(), top: [], startedAt: 0, running: false, resultText: '', resultUntil: 0 }
      const ov = engine._deathrun.overlay
      engine._deathrun._elTimer = ov?.querySelector('#dr-timer') || null
      engine._deathrun._elResult = ov?.querySelector('#dr-result') || null
      engine._deathrun._elBoardList = ov?.querySelector('#dr-board-list') || null
    },
    onEvent(payload, engine) {
      const dr = engine._deathrun; if (!dr) return
      if (payload.type === 'deathrun_start') { dr.running = true; dr.startedAt = Date.now() }
      if (payload.type === 'deathrun_finish') {
        dr.running = false
        const label = payload.isPB ? 'NEW BEST' : 'FINISH'
        dr.resultText = `${label}: ${fmtTime(payload.timeMs)}${payload.rank ? ` (rank #${payload.rank})` : ''}`
        dr.resultUntil = Date.now() + 4000
      }
      if (payload.type === 'deathrun_leaderboard') {
        dr.top = payload.top || []
        if (dr._elBoardList) {
          dr._elBoardList.innerHTML = dr.top.length
            ? dr.top.map((e, i) => `<div style="display:flex;justify-content:space-between;gap:12px"><span>${i + 1}. ${e.name}</span><span style="font-variant-numeric:tabular-nums">${fmtTime(e.timeMs)}</span></div>`).join('')
            : '<div style="opacity:.6">No runs yet</div>'
        }
      }
    },
    onFrame(_dt, engine) {
      const dr = engine._deathrun; if (!dr) return
      if (dr._elTimer) dr._elTimer.textContent = dr.running ? fmtTime(Date.now() - dr.startedAt) : '--:--.--'
      if (dr._elResult) {
        const show = Date.now() < dr.resultUntil
        dr._elResult.textContent = show ? dr.resultText : ''
        dr._elResult.style.opacity = show ? '1' : '0'
      }
    },
  },
}
