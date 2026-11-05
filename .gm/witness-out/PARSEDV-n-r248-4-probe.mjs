const root = '/workspace/spoint/src/shared/'
const { parseWorld, assertWorld, WorldResolveError } = await import(root + 'worldResolve.js')
const { playerDefault, worldMaxPlayers } = await import(root + 'worldDefaults.js')
const { parseTerrainConfig, isParsedTerrainConfig } = await import(root + 'terrainConfig.js')
const out = {}
const good = parseWorld({ name: 'w', player: { capsuleRadius: 0.5 }, terrain: { seed: 7, radius: 1000 } })
out.goodOk = good.ok
out.goodTerrainParsed = isParsedTerrainConfig(good.world.terrain)
out.goodPlayerDefault = playerDefault(good.world.player, 'capsuleRadius')
out.badPlayerDefaultRaw = playerDefault({ capsuleRadius: -1 }, 'capsuleRadius')
const bad = parseWorld({ name: 'w', player: { capsuleRadius: -1 } })
out.badRefusedCode = bad.code
out.badPath = bad.path
try { assertWorld({ name: 'w', terrain: { seed: 'x', radius: 1000 } }, 'w') } catch (e) { out.assertThrowName = e.name; out.assertCode = e.code; out.assertPath = e.path }
out.terrainRawBadSeed = parseTerrainConfig({ seed: 'x' }).path
console.log(JSON.stringify(out))
