// Deathrun/parkour run timer + per-map leaderboard persistence. Mirrors apps/tps-game/server.js's
// scoreboard persistence pattern exactly (SCOREBOARD_KEY / loadScoreboard / scheduleScoreboardPersist /
// flushScoreboard), but keyed by MAP NAME (not a flat by-player-name store) since a deathrun leaderboard
// is inherently per-course: data/deathrun_leaderboard.json holds { [mapName]: [{name,timeMs,ts}, ...] },
// each map's array kept sorted ascending by timeMs (fastest first -- standard speedrun/leaderboard
// convention) with best-time-wins-per-player semantics (a new run only replaces an existing entry for
// that player NAME if the new timeMs is strictly lower; a slower repeat run is recorded nowhere).
// Uses ctx.storage (src/apps/AppContext.js) -- namespaced by entity._appName ('deathrun'), so this
// writes to data/deathrun_leaderboard.json, a file distinct from tps-game's data/tps-game_scoreboard.json
// (different appName -> different FSAdapter namespace -- see deathrun-storage-namespace-collision-check).
const LEADERBOARD_KEY = 'leaderboard'
const LEADERBOARD_PERSIST_DEBOUNCE_MS = 500
const MAX_ENTRIES_PER_MAP = 100

// Loads the durable per-map leaderboard into ctx.state.leaderboardByMap ({mapName: [{name,timeMs,ts}]}).
// Awaited from setup(ctx) so a rejoining/first player's finish can be compared against real prior data.
export async function loadLeaderboard(ctx) {
  let byMap = null
  try { byMap = await ctx.storage?.get(LEADERBOARD_KEY) } catch (e) { console.error('[deathrun] leaderboard load error:', e.message) }
  ctx.state.leaderboardByMap = (byMap && typeof byMap === 'object') ? byMap : {}
  ctx.state._leaderboardPersistTimer = null
  const totalEntries = Object.values(ctx.state.leaderboardByMap).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0)
  console.log(`[deathrun] loaded ${totalEntries} leaderboard entrie(s) across ${Object.keys(ctx.state.leaderboardByMap).length} map(s)`)
}

// Debounced (trailing, 500ms) persist -- identical shape to apps/tps-game/server.js scheduleScoreboardPersist.
function scheduleLeaderboardPersist(ctx) {
  if (ctx.state._leaderboardPersistTimer) clearTimeout(ctx.state._leaderboardPersistTimer)
  ctx.state._leaderboardPersistTimer = setTimeout(() => {
    ctx.state._leaderboardPersistTimer = null
    ctx.storage?.set(LEADERBOARD_KEY, ctx.state.leaderboardByMap).catch(e => console.error('[deathrun] leaderboard persist error:', e.message))
  }, LEADERBOARD_PERSIST_DEBOUNCE_MS)
}

// Forces the pending debounced write (if any) to happen immediately -- registered via ctx.onShutdown so a
// SIGINT/SIGTERM within the 500ms debounce window doesn't silently drop the last finished run.
export async function flushLeaderboard(ctx) {
  if (ctx.state._leaderboardPersistTimer) { clearTimeout(ctx.state._leaderboardPersistTimer); ctx.state._leaderboardPersistTimer = null }
  if (ctx.state.leaderboardByMap) { try { await ctx.storage?.set(LEADERBOARD_KEY, ctx.state.leaderboardByMap) } catch (e) { console.error('[deathrun] leaderboard persist error:', e.message) } }
}

// Records a finished run IF it beats (or is the player's first) recorded time for this map, sorted
// ascending by timeMs (fastest first) and capped at MAX_ENTRIES_PER_MAP so the file can't grow unbounded.
// Returns { recorded: boolean, rank: number|null, previousBest: number|null } for the caller to broadcast.
export function recordRun(ctx, mapName, playerName, timeMs) {
  const byMap = ctx.state.leaderboardByMap || (ctx.state.leaderboardByMap = {})
  const list = byMap[mapName] || (byMap[mapName] = [])
  const existingIdx = list.findIndex(e => e.name === playerName)
  const previousBest = existingIdx >= 0 ? list[existingIdx].timeMs : null
  if (existingIdx >= 0) {
    if (timeMs >= previousBest) return { recorded: false, rank: null, previousBest }
    list.splice(existingIdx, 1)
  }
  list.push({ name: playerName, timeMs, ts: Date.now() })
  list.sort((a, b) => a.timeMs - b.timeMs)
  if (list.length > MAX_ENTRIES_PER_MAP) list.length = MAX_ENTRIES_PER_MAP
  scheduleLeaderboardPersist(ctx)
  const rank = list.findIndex(e => e.name === playerName && e.timeMs === timeMs)
  return { recorded: true, rank: rank >= 0 ? rank + 1 : null, previousBest }
}

// Top-N entries for a map, ascending by timeMs (fastest first) -- the client-facing read used both on
// join (full snapshot) and after a finish (updated snapshot).
export function getTopEntries(ctx, mapName, n = 10) {
  const list = ctx.state.leaderboardByMap?.[mapName] || []
  return list.slice(0, n)
}
