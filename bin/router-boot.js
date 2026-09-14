#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RegionRouter } from '../src/sharding/RegionRouter.js'
import { assertNodeModulesLinked, buildStaticDirs } from '../src/sdk/server.js'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  assertNodeModulesLinked(SDK_ROOT)
  const PROJECT = process.cwd()
  const worldName = process.env.WORLD || 'tps-game'
  const localWorld = resolve(PROJECT, `apps/world/${worldName}.js`)
  const fallbackLocal = resolve(PROJECT, 'apps/world/index.js')
  const worldPath = existsSync(localWorld) ? localWorld : existsSync(fallbackLocal) ? fallbackLocal : resolve(SDK_ROOT, 'apps/world/index.js')
  if (!existsSync(worldPath)) {
    console.error(`[router-boot] FATAL: no world found for WORLD=${worldName} (looked at ${localWorld}, ${fallbackLocal}, and the bundled SDK default) -- cannot resolve a worldDef to shard.`)
    process.exit(1)
  }
  console.log(`[router-boot] using world: ${worldName}`)
  const worldDef = (await import(pathToFileURL(worldPath).href + `?t=${Date.now()}`)).default || {}

  const shardCfg = worldDef.shardGrid || {}
  const gridRadius = parseInt(process.env.SHARD_GRID_RADIUS || String(shardCfg.radius ?? 1), 10)
  const cellSize = parseInt(process.env.SHARD_CELL_SIZE || String(shardCfg.cellSize ?? 0), 10) || undefined
  const ghostMargin = process.env.SHARD_GHOST_MARGIN != null
    ? parseInt(process.env.SHARD_GHOST_MARGIN, 10)
    : (shardCfg.ghostMargin != null ? shardCfg.ghostMargin : undefined)
  const port = parseInt(process.env.PORT || String(worldDef.port || 3500), 10)

  const localApps = resolve(PROJECT, 'apps'), sdkApps = join(SDK_ROOT, 'apps')
  const appsDirs = existsSync(localApps) ? [localApps, sdkApps] : [sdkApps]
  const staticDirs = buildStaticDirs(SDK_ROOT, PROJECT, appsDirs)

  const router = new RegionRouter({
    port,
    worldDef,
    ...(cellSize != null ? { cellSize } : {}),
    ...(ghostMargin != null ? { ghostMargin } : {}),
    staticDirs
  })

  console.log(`[router-boot] spawning ${(2 * gridRadius + 1) ** 2} region worker(s) (grid radius ${gridRadius}, cellSize ${router.cellSize}, ghostMargin ${router.ghostMargin})...`)
  await router.spawnGridAroundOrigin(gridRadius)
  const info = await router.start()
  console.log(`[router-boot] region-shard router listening on http://localhost:${info.port} (world=${worldName}, ${router.workers.size} shard(s) live)`)

  const shutdown = async (signal) => {
    console.log(`[router-boot] received ${signal}, shutting down router + all region workers...`)
    await router.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  console.error('[router-boot] FATAL:', err)
  process.exit(1)
})
