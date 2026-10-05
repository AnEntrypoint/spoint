import { resolveTerrainConfig } from '../shared/terrainConfig.js'
import { resolveClusterConfig } from '../shared/clusterConfig.js'
import { createClusterManager } from './ClusterManager.js'
import { createClusterWorldHost } from './ClusterWorldHost.js'
import { createClusterCoordinator } from './ClusterCoordinator.js'
import { createClusterServerWorldFactory } from './ClusterServerWorld.js'

export function createClusterRuntime({ worldDef, serverConfig, onHandoff = null, now = () => performance.now() }) {
  const tcfg = resolveTerrainConfig(worldDef)
  const config = tcfg ? resolveClusterConfig(tcfg.clusters, { radius: tcfg.radius, relevanceRadius: worldDef.relevanceRadius ?? 200, maxWeaponRangeM: worldDef.maxWeaponRangeM ?? 0 }) : null
  if (!config) return null
  const manager = createClusterManager({ config, now })
  const factory = createClusterServerWorldFactory({ baseWorldDef: worldDef, serverConfig })
  const host = createClusterWorldHost({ ...factory, maxWorlds: config.maxWorlds, idleGraceMs: config.idleGraceMs, now })
  const coordinator = createClusterCoordinator({
    manager, host, onHandoff,
    descriptorOf: cluster => ({ anchorDir: cluster.anchorDir, spawnDirs: cluster.memberIds.map(id => manager.dirOf(id)).filter(Boolean) }),
  })
  return { config, manager, host, coordinator }
}
