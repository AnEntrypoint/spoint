const LEADERBOARD_KEY = 'leaderboard'
const LEADERBOARD_PERSIST_DEBOUNCE_MS = 500
const MAX_ENTRIES_PER_MAP = 100

export async function loadLeaderboard(ctx) {
  let byMap = null
  try { byMap = await ctx.storage?.get(LEADERBOARD_KEY) } catch (e) { console.error('[deathrun] leaderboard load error:', e.message) }
  ctx.state.leaderboardByMap = (byMap && typeof byMap === 'object') ? byMap : {}
  ctx.state._leaderboardPersistTimer = null
  const totalEntries = Object.values(ctx.state.leaderboardByMap).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0)
  console.log(`[deathrun] loaded ${totalEntries} leaderboard entrie(s) across ${Object.keys(ctx.state.leaderboardByMap).length} map(s)`)
}

function scheduleLeaderboardPersist(ctx) {
  if (ctx.state._leaderboardPersistTimer) clearTimeout(ctx.state._leaderboardPersistTimer)
  ctx.state._leaderboardPersistTimer = setTimeout(() => {
    ctx.state._leaderboardPersistTimer = null
    ctx.storage?.set(LEADERBOARD_KEY, ctx.state.leaderboardByMap).catch(e => console.error('[deathrun] leaderboard persist error:', e.message))
  }, LEADERBOARD_PERSIST_DEBOUNCE_MS)
}

export async function flushLeaderboard(ctx) {
  if (ctx.state._leaderboardPersistTimer) { clearTimeout(ctx.state._leaderboardPersistTimer); ctx.state._leaderboardPersistTimer = null }
  if (ctx.state.leaderboardByMap) { try { await ctx.storage?.set(LEADERBOARD_KEY, ctx.state.leaderboardByMap) } catch (e) { console.error('[deathrun] leaderboard persist error:', e.message) } }
}

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

export function getTopEntries(ctx, mapName, n = 10) {
  const list = ctx.state.leaderboardByMap?.[mapName] || []
  return list.slice(0, n)
}
