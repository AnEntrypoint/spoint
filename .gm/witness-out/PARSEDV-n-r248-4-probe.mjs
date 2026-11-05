const root = '/workspace/spoint/src/shared/'
const { parseWorld, assertWorld, WorldResolveError } = await import(root + 'worldResolve.js')
const { playerDefault, worldMaxPlayers } = await import(root + 'worldDefaults.js')
const { parseTerrainConfig, isParsedTerrainConfig } = await import(root + 'terrainConfig.js')
const out = {}
const good = parseWorld({ name: 'w', player: { capsuleRadius: 0.5 }, terrain: { seed: 7, radius: 1000 } })
out.goodOk = good.ok
out.goodTerrainParsed = isParsedTerrainConfig(good.world.terrain)
out.goodValuePlayerDefault = playerDefault(good.world.player, 'capsuleRadius')
out.absentPlayerDefault = playerDefault(parseWorld({ name: 'w', player: {} }).world.player, 'capsuleRadius')
out.badParseCode = parseWorld({ name: 'w', player: { capsuleRadius: -1 } }).code
out.badParsePath = parseWorld({ name: 'w', player: { capsuleRadius: -1 } }).path
try { assertWorld({ name: 'w', player: { capsuleRadius: -1 } }, 'w'); out.badAssertThrew = false } catch (e) { out.badAssertThrew = e instanceof WorldResolveError; out.assertName = e.name; out.assertCode = e.code; out.assertPath = e.path }
out.terrainRawBadSeed = parseTerrainConfig({ seed: 'x' }).path
console.log(JSON.stringify(out))
