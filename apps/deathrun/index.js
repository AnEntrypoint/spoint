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
  ctx.state._inStartVol = new Map()
  ctx.state._inFinishVol = new Map()

  ctx.state.checkpoint = defineCheckpoint({
    spawn: cps[0].position,
    minY: ctx.config?.minY ?? -50,
    checkpoints: cps.map(c => ({ position: c.position, radius: c.radius })),
    onRespawn: () => {
    },
  }, ctx)

  console.log(`[deathrun] ${cps.length} checkpoint(s) loaded for map '${ctx.state.map}' (finish index ${ctx.state.finishIndex})`)
}

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
      if (startMs == null) continue
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
      ctx.state.activeRuns = new Map()
      ctx.state.lastResult = new Map()
      ctx.state.checkpoint = null

      await loadLeaderboard(ctx)
      ctx.onShutdown(() => flushLeaderboard(ctx))

      ctx.state._courseBuilt = false
    },
    update(ctx, dt) {
      if (!ctx.state._courseBuilt) {
        ctx.state._courseBuilt = true
        _buildCourse(ctx)
      }
      ctx.state.checkpoint?.tick(dt)
      _tickStartFinish(ctx)
    },
    onMessage(ctx, msg) {
      if (!msg) return
      if (msg.type === 'player_join') {
        const p = ctx.players.getById(msg.playerId)
        const name = p?.name || `Player ${msg.playerId}`
        ctx.players.send(msg.playerId, { type: 'deathrun_leaderboard', map: ctx.state.map, top: getTopEntries(ctx, ctx.state.map, 10) })
        void name
      }
      if (msg.type === 'player_leave') {
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
      if (dr._elTimer) {
        const t = dr.running ? fmtTime(Date.now() - dr.startedAt) : '--:--.--'
        if (dr._lastTimerText !== t) { dr._lastTimerText = t; dr._elTimer.textContent = t }
      }
      if (dr._elResult) {
        const show = Date.now() < dr.resultUntil
        const t = show ? dr.resultText : ''
        if (dr._lastResultText !== t) { dr._lastResultText = t; dr._elResult.textContent = t }
        const op = show ? '1' : '0'
        if (dr._lastResultOp !== op) { dr._lastResultOp = op; dr._elResult.style.opacity = op }
      }
    },
  },
}
