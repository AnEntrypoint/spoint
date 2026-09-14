#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from '../src/sdk/server.js'
import { buildHeatmapPNG } from './lib/heatmap-image.mjs'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_SECONDS = parseFloat(process.argv[2] || '15')
const OUT_DIR = resolve(SDK_ROOT, 'data', 'playtest-heatmap-run')
const PORT = 20000 + Math.floor(Math.random() * 20000)

async function main() {
  const worldPath = resolve(SDK_ROOT, 'apps/world/playtest-heatmap-harness.js')
  const worldDef = (await import(pathToFileURL(worldPath).href)).default

  const appsDirs = [resolve(SDK_ROOT, 'apps')]
  const config = {
    port: PORT,
    tickRate: worldDef.tickRate || 60,
    appsDirs,
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    movement: worldDef.movement || {},
    playerConfig: worldDef.player || {},
    physicsRadius: 0,
    physicsBodyBudget: 0,
    entityTickRate: worldDef.entityTickRate,
    staticDirs: [],
    storageDir: resolve(SDK_ROOT, 'data'),
  }

  console.log(`[playtest-heatmap-run] booting real server on port ${PORT} for world: playtest-heatmap-harness`)
  const server = await createServer(config)
  await server.loadWorld(worldDef)
  const info = await server.start()
  console.log(`[playtest-heatmap-run] server up: port=${info.port} tickRate=${info.tickRate}, running for ${RUN_SECONDS}s real wall-clock time`)

  const t0 = Date.now()
  await new Promise(r => setTimeout(r, RUN_SECONDS * 1000))
  const wallMs = Date.now() - t0
  const ticksElapsed = server.tickSystem.currentTick
  console.log(`[playtest-heatmap-run] ${wallMs}ms real wall-clock time elapsed, ${ticksElapsed} real ticks ran`)

  const appRuntime = server.runtime
  const botIds = [...appRuntime.entities.keys()].filter(id => appRuntime.entities.get(id)?.custom?._isPlaytestBot)
  if (botIds.length === 0) throw new Error('[playtest-heatmap-run] no playtest-bot entities found after loadWorld -- harness world misconfigured')
  console.log(`[playtest-heatmap-run] found ${botIds.length} real playtest-bot entities: ${botIds.join(', ')}`)

  const perBot = {}
  const aggVisited = new Map()
  const aggWeaponVisits = new Map()
  let weaponSpawnMeta = []
  let totalPositionSamples = 0

  for (const id of botIds) {
    const appCtx = appRuntime.contexts.get(id)
    if (!appCtx) { console.warn(`[playtest-heatmap-run] no app context found for bot ${id}`); continue }
    const st = appCtx.state
    perBot[id] = {
      tick: st.tick,
      findingsCount: st.findings.length,
      findings: st.findings,
      visitedCells: st.visited.size,
      weaponSpawnVisits: Object.fromEntries(st.weaponSpawnVisits),
    }
    totalPositionSamples += st.tick
    for (const [k, v] of st.visited.entries()) {
      aggVisited.set(k, (aggVisited.get(k) || 0) + v)
    }
    for (const [k, v] of st.weaponSpawnVisits.entries()) {
      aggWeaponVisits.set(k, (aggWeaponVisits.get(k) || 0) + v)
    }
    if (st.weaponSpawns.length) weaponSpawnMeta = st.weaponSpawns
  }

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const k of aggVisited.keys()) {
    const [gx, gz] = k.split(',').map(Number)
    if (gx < minX) minX = gx; if (gx > maxX) maxX = gx
    if (gz < minZ) minZ = gz; if (gz > maxZ) maxZ = gz
  }
  const spreadX = isFinite(minX) ? maxX - minX : 0
  const spreadZ = isFinite(minZ) ? maxZ - minZ : 0

  for (const ws of weaponSpawnMeta) if (!aggWeaponVisits.has(ws.id)) aggWeaponVisits.set(ws.id, 0)
  const balanceEntries = [...aggWeaponVisits.entries()].map(([id, count]) => {
    const meta = weaponSpawnMeta.find(w => w.id === id)
    return { id, weaponType: meta?.weaponType ?? 'unknown', position: meta?.position ?? null, count }
  })
  const totalVisits = balanceEntries.reduce((s, e) => s + e.count, 0)
  const meanVisits = balanceEntries.length ? totalVisits / balanceEntries.length : 0
  for (const e of balanceEntries) {
    e.ratioToMean = meanVisits > 0 ? e.count / meanVisits : (e.count > 0 ? Infinity : 0)
    e.deviationFromMean = e.count - meanVisits
  }
  balanceEntries.sort((a, b) => a.count - b.count)

  const balanceReport = {
    generatedAt: new Date().toISOString(),
    ticksRun: ticksElapsed,
    runSeconds: RUN_SECONDS,
    botCount: botIds.length,
    spawnCount: balanceEntries.length,
    totalVisits,
    meanVisits,
    mostUnderVisited: balanceEntries[0] || null,
    mostOverVisited: balanceEntries[balanceEntries.length - 1] || null,
    spawns: balanceEntries,
  }

  const heatmapCells = [...aggVisited.entries()].map(([k, count]) => {
    const [x, z] = k.split(',').map(Number)
    return { x, z, count }
  })
  const heatmap = {
    generatedAt: new Date().toISOString(),
    ticksRun: ticksElapsed,
    runSeconds: RUN_SECONDS,
    botCount: botIds.length,
    cellSize: 8,
    cellCount: heatmapCells.length,
    boundingBox: { minX, maxX, minZ, maxZ, spreadX, spreadZ },
    cells: heatmapCells,
  }

  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true })
  const balancePath = resolve(OUT_DIR, 'balance-report.json')
  const heatmapPath = resolve(OUT_DIR, 'heatmap.json')
  await writeFile(balancePath, JSON.stringify(balanceReport, null, 2))
  await writeFile(heatmapPath, JSON.stringify(heatmap, null, 2))
  console.log(`[playtest-heatmap-run] wrote real balance report -> ${balancePath}`)
  console.log(`[playtest-heatmap-run] wrote real heatmap grid -> ${heatmapPath}`)

  const pngPath = resolve(OUT_DIR, 'heatmap.png')
  const pngWritten = await buildHeatmapPNG(heatmap, pngPath)
  if (pngWritten) console.log(`[playtest-heatmap-run] wrote real heatmap PNG -> ${pngPath}`)

  console.log('[playtest-heatmap-run] === SUMMARY ===')
  console.log(`  bots: ${botIds.length}`)
  console.log(`  total position samples (tick-commits, summed across bots): ${totalPositionSamples}`)
  console.log(`  aggregated visited grid cells: ${aggVisited.size}`)
  console.log(`  grid bounding box: x[${minX},${maxX}] z[${minZ},${maxZ}] spread=(${spreadX}x${spreadZ} cells, ${spreadX * 8}x${spreadZ * 8} metres)`)
  console.log(`  weapon spawns: ${balanceEntries.length}, total visits: ${totalVisits}, mean: ${meanVisits.toFixed(2)}`)
  console.log(`  most under-visited: ${balanceEntries[0]?.id} (${balanceEntries[0]?.count} visits)`)
  console.log(`  most over-visited: ${balanceEntries[balanceEntries.length - 1]?.id} (${balanceEntries[balanceEntries.length - 1]?.count} visits)`)
  for (const [id, b] of Object.entries(perBot)) {
    console.log(`  bot ${id}: tick=${b.tick} findings=${b.findingsCount} visitedCells=${b.visitedCells}`)
  }

  server.stop()
  process.exit(0)
}

main().catch(err => {
  console.error('[playtest-heatmap-run] FATAL:', err.stack || err.message)
  process.exit(1)
})
