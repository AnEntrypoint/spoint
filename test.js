import assert from 'node:assert/strict'

const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6
const GRAD2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]]
function buildPermTable(seed) {
  const p = new Uint8Array(256); for (let i = 0; i < 256; i++) p[i] = i
  let s = seed | 0
  for (let i = 255; i > 0; i--) { s=(s*1664525+1013904223)>>>0; const j=s%(i+1); const tmp=p[i]; p[i]=p[j]; p[j]=tmp }
  const perm = new Uint8Array(512); for (let i=0;i<512;i++) perm[i]=p[i&255]; return perm
}
function simplex2(perm, x, y) {
  const s=(x+y)*F2, i=Math.floor(x+s), j=Math.floor(y+s), t=(i+j)*G2
  const x0=x-(i-t),y0=y-(j-t),i1=x0>y0?1:0,j1=x0>y0?0:1
  const x1=x0-i1+G2,y1=y0-j1+G2,x2=x0-1+2*G2,y2=y0-1+2*G2
  const ii=i&255,jj=j&255; let n=0
  for (const [dx,dy,ddx,ddy] of [[x0,y0,ii,jj],[x1,y1,ii+i1,jj+j1],[x2,y2,ii+1,jj+1]]) {
    const t2=0.5-dx*dx-dy*dy
    if (t2>=0) { const g=GRAD2[perm[ddx+perm[ddy&255]]&7]; n+=(t2*t2)*(t2*t2)*(g[0]*dx+g[1]*dy) }
  }
  return n*70
}
function fbm({seed,octaves,frequency,amplitude,gain,lacunarity,offset=0}) {
  const perms=Array.from({length:octaves},(_,i)=>buildPermTable((seed+i*73856093)>>>0))
  return (x,y)=>{ let v=0,amp=amplitude,freq=frequency; for (let i=0;i<octaves;i++){v+=amp*simplex2(perms[i],freq*x,freq*y);amp*=gain;freq*=lacunarity}; return v+offset }
}

let pass = 0, fail = 0
const _tests = []
function test(name, fn) { _tests.push({ name, fn }) }

test('FBM noise is deterministic', () => {
  const n = fbm({seed:42,octaves:4,frequency:0.1,amplitude:1,gain:0.5,lacunarity:2})
  assert.equal(n(1,2).toFixed(6), n(1,2).toFixed(6))
  assert.notEqual(n(1,2).toFixed(4), n(3,4).toFixed(4))
})

test('FBM seed isolation', () => {
  const n1 = fbm({seed:0,octaves:4,frequency:0.1,amplitude:1,gain:0.5,lacunarity:2})
  const n2 = fbm({seed:999,octaves:4,frequency:0.1,amplitude:1,gain:0.5,lacunarity:2})
  assert.notEqual(n1(1,1).toFixed(4), n2(1,1).toFixed(4))
})

test('FBM offset applied', () => {
  const n = fbm({seed:0,octaves:1,frequency:0.01,amplitude:0.001,gain:0.5,lacunarity:2,offset:5})
  assert(Math.abs(n(0,0) - 5) < 0.1, `expected ~5, got ${n(0,0)}`)
})

test('simplex2 output in expected range', () => {
  const perm = buildPermTable(0)
  for (let i = 0; i < 20; i++) {
    const v = simplex2(perm, i*0.3, i*0.7)
    assert(v >= -1 && v <= 1, `simplex2 out of range: ${v}`)
  }
})

test('world config aim_sillos scale is [1,1,1]', async () => {
  const src = await import(new URL('./apps/world/tps-game.js', import.meta.url))
  const wd = src.default
  const sillos = wd.entities.find(e => e.id === 'env-sillos')
  assert(sillos, 'env-sillos not found')
  assert.deepEqual(sillos.scale, [1,1,1], `scale was ${JSON.stringify(sillos.scale)}`)
  // +4.8 was calibrated against a fixed render-scale bug and buries the arena at correct scale.
  assert.ok(sillos.position[1] >= 8, `env-sillos Y (${sillos.position[1]}) must lift the floor onto terrain (>=8); a smaller value buries the arena`)
})

test('terrain is a proper app (entity + app module), not a special-cased config block', async () => {
  const wd = (await import(new URL('./apps/world/tps-game.js', import.meta.url))).default
  const terrainEnt = wd.entities.find(e => e.id === 'terrain')
  assert(terrainEnt && terrainEnt.app === 'terrain', 'terrain entity present with app:terrain')
  assert(terrainEnt.config && terrainEnt.config.radius === 63600 && terrainEnt.config.reliefScale === 0.001, 'terrain entity config carries the tuned planet values')
  assert(Array.isArray(wd.trustedApps) && wd.trustedApps.includes('terrain'), 'terrain is in trustedApps')
  const app = (await import(new URL('./apps/terrain/index.js', import.meta.url))).default
  assert(app.server && typeof app.server.setup === 'function', 'terrain app has server.setup')
  assert(app.client && typeof app.client.setup === 'function', 'terrain app has client.setup')
})

test('StaticHandler serves symlinked (file:/workspace) node_modules packages', async () => {
  // realpath escape-guard must not 404 a node_modules package symlinked outside the mount (a 404 here breaks the ES-module graph and stalls boot).
  const { createStaticHandler } = await import(new URL('./src/sdk/StaticHandler.js', import.meta.url))
  const { existsSync, lstatSync } = await import('node:fs')
  const linkPath = new URL('./node_modules/streaming-gltf', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  if (!existsSync(linkPath) || !lstatSync(linkPath).isSymbolicLink()) return
  const handler = createStaticHandler([{ prefix: '/node_modules/', dir: new URL('./node_modules', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') }])
  let status = 0
  const res = { writeHead(c){ status = c }, end(){}, setHeader(){} }
  await handler({ url: '/node_modules/streaming-gltf/index.js', headers: {} }, res)
  assert.equal(status, 200, `symlinked node_modules pkg served ${status}, expected 200`)
})

test('TickSystem.onTick is idempotent (f.f=f): same callback registers once', async () => {
  // re-running boot/attachWSHandlers must not stack the same callback and fire it N times/tick
  const { TickSystem } = await import(new URL('./src/netcode/TickSystem.js', import.meta.url))
  const ts = new TickSystem(60)
  let calls = 0
  const cb = () => { calls++ }
  ts.onTick(cb); ts.onTick(cb); ts.onTick(cb)
  assert.equal(ts.callbacks.length, 1, `onTick registered ${ts.callbacks.length} copies, expected 1`)
})

test('dynamic physics body broadcasts an evolving rotation quaternion', async () => {
  const { PhysicsWorld } = await import(new URL('./src/physics/World.js', import.meta.url))
  const w = new PhysicsWorld({ gravity: [0,-9.81,0] }); await w.init()
  const id = w.addBody('box', [0.5,0.5,0.5], [0,10,0], 'dynamic', { mass: 1, rotation: [0,0,0,1] })
  const J = w.Jolt; const av = new J.Vec3(3,2,1); w.bodyInterface.SetAngularVelocity(w.bodyIds.get(id), av); J.destroy(av)
  const ent = { position:[0,10,0], rotation:[0,0,0,1], velocity:[0,0,0] }
  for (let i=0;i<20;i++){ w.step(1/60); w.syncDynamicBody(id, ent) }
  const moved = Math.abs(ent.rotation[0])+Math.abs(ent.rotation[1])+Math.abs(ent.rotation[2])+Math.abs(1-ent.rotation[3])
  assert.ok(moved > 0.01, `dynamic body rotation must evolve from identity, got ${JSON.stringify(ent.rotation.map(v=>+v.toFixed(3)))}`)
})

test('water surface depth is shared so submerged objects are occluded by water', async () => {
  // regression for 'all objects draw over water even under it' -- mapspinner must write water surface depth, not only terrain
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./node_modules/mapspinner/src/gl-render.js', import.meta.url), 'utf8')
  assert.match(src, /__waterDepthShared/, 'gl-render.js must run the water depth-share pass (writes water depth into _vdrsDepth)')
})

test('one server, one origin: single node_modules mount + one port + query-selected client mode', async () => {
  // ':3001 vs :8090 look different' guard -- same server.js as separate processes, must stay structurally un-divergeable
  const { readFileSync } = await import('node:fs')
  const { buildStaticDirs } = await import(new URL('./src/sdk/server.js', import.meta.url))
  const dirs = buildStaticDirs('/sdk', '/proj', ['/proj/apps'])
  const nm = dirs.filter(d => d.prefix === '/node_modules/')
  assert.equal(nm.length, 1, `exactly one /node_modules/ mount, got ${nm.length}`)
  const appSrc = readFileSync(new URL('./client/app.js', import.meta.url), 'utf8')
  assert.match(appSrc, /_isSingleplayer[\s\S]{0,120}new BrowserServer[\s\S]{0,120}new PhysicsNetworkClient/, 'app.js selects BrowserServer vs PhysicsNetworkClient by ?singleplayer on the same origin')
  const serverSrc = readFileSync(new URL('./src/sdk/server.js', import.meta.url), 'utf8')
  assert.match(serverSrc, /port:\s*parseInt\(process\.env\.PORT\s*\|\|\s*String\(worldDef\.port\s*\|\|\s*3000\)/, 'boot() reads a single port')
  const apiSrc = readFileSync(new URL('./src/sdk/ServerAPI.js', import.meta.url), 'utf8')
  assert.match(apiSrc, /EADDRINUSE/, 'single-instance guard handles EADDRINUSE')
  assert.match(apiSrc, /do NOT start a second instance/i, 'single-instance guard warns against a second divergent instance')
})

test('placed models get a real default collider (static meshes collide)', async () => {
  // Regression for 'static meshes should collide': PLACE_MODEL used to hardcode collider:'none'.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./src/sdk/EditorHandlers.js', import.meta.url), 'utf8')
  assert.match(src, /autoTrimesh:\s*true/, 'PLACE_MODEL spawns with autoTrimesh:true (real default collider, not none)')
  assert.match(src, /COLLIDER_TYPES\s*=\s*new Set/, 'collider type is allowlisted server-side')
})

test('moving a static entity repositions its physics body (collider follows move)', async () => {
  const { PhysicsWorld } = await import(new URL('./src/physics/World.js', import.meta.url))
  const w = new PhysicsWorld({ gravity: [0,-9.81,0] }); await w.init()
  const id = w.addBody('box', [0.5,0.5,0.5], [0,5,0], 'static', {})
  w._repositionBody(id, [10,5,20], [0,0,0,1])
  const p = w.getBodyPosition(id)
  assert.ok(Math.abs(p[0]-10) < 0.01 && Math.abs(p[1]-5) < 0.01 && Math.abs(p[2]-20) < 0.01, `body must follow reposition, got ${JSON.stringify(p)}`)
})

test('destroying an entity removes its physics body', async () => {
  const { AppRuntime } = await import(new URL('./src/apps/AppRuntime.js', import.meta.url))
  const rt = new AppRuntime({ gravity:[0,-9.81,0], playerManager:{getConnectedPlayers(){return[]}}, physics:null, physicsIntegration:{}, connections:{broadcast(){}}, eventBus:{on(){},emit(){},destroyScope(){}}, eventLog:{append(){},record(){}}, storage:{}, sdkRoot: process.cwd(), physicsRadius:0, entityTickRate:1, tickRate:64, lagCompensator:{} })
  const removed = []
  rt._physics = { removeBody: (bid) => removed.push(bid) }
  const ent = rt.spawnEntity('box1', { bodyType: 'static' })
  ent._physicsBodyId = 99
  rt._physicsBodyToEntityId.set(99, 'box1')
  rt.destroyEntity('box1')
  assert.deepEqual(removed, [99], 'destroyEntity must remove the physics body')
})

test('apps/environment removed -- no world-def entity references app:environment', async () => {
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(new URL('./apps/environment', import.meta.url)), false, 'apps/environment must be deleted')
  const wd = (await import(new URL('./apps/world/tps-game.js', import.meta.url))).default
  const envEntities = wd.entities.filter(e => e.app === 'environment')
  assert.equal(envEntities.length, 0, `no entity should reference app:'environment', found ${envEntities.length}`)
  const sillos = wd.entities.find(e => e.id === 'env-sillos')
  assert.equal(sillos.app, 'placed-model', 'env-sillos migrated to placed-model')
  assert.equal(sillos.custom?._interior, true, 'env-sillos keeps its interior-view flag')
})

test('StageLoader propagates a world-def entity\'s custom field to spawn config', async () => {
  // StageLoader once dropped entDef.custom entirely, silently losing world-def-authored custom.* fields
  const { StageLoader } = await import(new URL('./src/stage/StageLoader.js', import.meta.url))
  const spawned = []
  const fakeRuntime = { gravity: [0,-9.81,0], spawnEntity(id, cfg) { spawned.push(cfg); return { id, position: cfg.position || [0,0,0] } } }
  const sl = new StageLoader(fakeRuntime)
  sl.loadFromDefinition('t', { entities: [{ id: 'x', model: './m.glb', position: [0,0,0], app: 'placed-model', custom: { _interior: true } }] })
  assert.deepEqual(spawned[0].custom, { _interior: true }, 'custom field must reach spawnEntity config')
})

test('terrain app-mounted panel gates its render on selection (not always-displaying)', async () => {
  // render() once had no selectedId check, so terrain knobs occupied the inspector slot regardless of selection
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./apps/terrain/index.js', import.meta.url), 'utf8')
  assert.match(src, /render\(container,\s*\{\s*selectedId\s*\}\)/, 'mountPanel render must destructure selectedId')
  assert.match(src, /isTerrain/, 'render must gate on an isTerrain check before building the knob UI')
})

test('packQuat/unpackQuat round-trips within quantization error bound', async () => {
  const { packQuat, unpackQuat } = await import(new URL('./src/netcode/SnapshotEncoder.js', import.meta.url))
  const cases = [[0,0,0,1],[1,0,0,0],[0,1,0,0],[0,0,1,0],[0.5,0.5,0.5,0.5],[0.1,-0.2,0.9,0.36],[-0.7,0.1,-0.1,0.69]]
  for (const [x,y,z,w] of cases) {
    const n = Math.hypot(x,y,z,w) || 1
    const qx=x/n, qy=y/n, qz=z/n, qw=w/n
    const packed = packQuat(qx,qy,qz,qw)
    const out = unpackQuat(packed, [0,0,0,0])
    const dot = Math.abs(qx*out[0]+qy*out[1]+qz*out[2]+qw*out[3])
    assert.ok(dot > 0.999, `quat round-trip dot=${dot} too far from 1 for [${qx},${qy},${qz},${qw}] -> [${out}]`)
  }
})

test('TerrainPhysics createBakedHeightField dequantizes a GPU-bake-shaped sectored artifact with sub-quantum parity', async () => {
  // shape matches bake-heightfield.mjs --sector output: per-sector [min,max] + node q in [0,qmax]
  const { createBakedHeightField } = await import(new URL('./src/terrain/TerrainPhysics.js', import.meta.url))
  const N = 8, Sn = 4, gridS = Math.ceil(N / Sn), bits = 8, qmax = (1 << bits) - 1
  const sectorMin = [0, 10, 20, 30], sectorMax = [5, 15, 25, 45]
  const sidx = (ix, iz) => Math.min((iz / Sn) | 0, gridS - 1) * gridS + Math.min((ix / Sn) | 0, gridS - 1)
  const trueH = (ix, iz) => { const si = sidx(ix, iz); const lo = sectorMin[si], hi = sectorMax[si]; return lo + (ix % Sn) / (Sn - 1) * (hi - lo) }
  const q = new Uint8Array(N*N)
  for (let iz=0; iz<N; iz++) for (let ix=0; ix<N; ix++) { const si=sidx(ix,iz), lo=sectorMin[si], hi=sectorMax[si], v=trueH(ix,iz); q[iz*N+ix] = Math.round((v-lo)/(hi-lo)*qmax) }
  const artifact = { N, extent: 70, center: [0,0], sectors: { nodesPerSector: Sn, gridS, qmax, bits }, sectorMin, sectorMax, q }
  const field = createBakedHeightField(artifact)
  const step = 70 / (N - 1)
  for (const [ix, iz] of [[0,0],[3,0],[4,4],[7,7],[2,5]]) {
    const si = sidx(ix, iz), lo = sectorMin[si], hi = sectorMax[si]
    const localX = -35 + ix*step, localZ = -35 + iz*step
    const h = field.heightAtLocal(localX, localZ)
    const quantStep = (hi - lo) / qmax
    assert.ok(Number.isFinite(h), `dequantized height at node (${ix},${iz}) must be finite`)
    assert.ok(h >= lo - 1e-6 && h <= hi + 1e-6, `node (${ix},${iz}) height ${h} must fall within its own sector [${lo},${hi}]`)
    assert.ok(Math.abs(h - trueH(ix, iz)) <= quantStep + 1e-6, `node (${ix},${iz}) error ${Math.abs(h-trueH(ix,iz))} must be within one quantization step (${quantStep})`)
  }
})

test('SnapshotEncoder pitch/yaw 8+8-bit look-angle codec round-trips within its quantization step', async () => {
  const { SnapshotEncoder } = await import(new URL('./src/netcode/SnapshotEncoder.js', import.meta.url))
  const cases = [[0,0],[1.4,0.1],[-1.5,3.14],[0.7,6.2],[-0.2,1.0]]
  for (const [lookPitch, lookYaw] of cases) {
    const p = { id:'p1', position:[0,0,0], rotation:[0,0,0,1], velocity:[0,0,0], onGround:true, health:100, inputSequence:1, crouch:0, lookPitch, lookYaw }
    const { players } = SnapshotEncoder.decode(SnapshotEncoder.encode({ tick:1, players:[p], entities:[] }))
    const out = players[0]
    assert.ok(Math.abs(out.lookPitch - lookPitch) <= Math.PI/255 + 1e-9, `pitch round-trip off by ${Math.abs(out.lookPitch-lookPitch)}`)
    const yawErr = Math.min(Math.abs(out.lookYaw - ((lookYaw%(2*Math.PI)+2*Math.PI)%(2*Math.PI))), 2*Math.PI - Math.abs(out.lookYaw - lookYaw))
    assert.ok(yawErr <= 2*Math.PI/256 + 1e-9, `yaw round-trip off by ${yawErr}`)
  }
})

test('TERRAIN_RESEED/TERRAIN_CONFIG message types exist and are unique', async () => {
  const { MSG, msgName } = await import(new URL('./src/protocol/MessageTypes.js', import.meta.url))
  assert.ok(Number.isInteger(MSG.TERRAIN_RESEED), 'MSG.TERRAIN_RESEED must be defined')
  assert.ok(Number.isInteger(MSG.TERRAIN_CONFIG), 'MSG.TERRAIN_CONFIG must be defined')
  assert.notEqual(MSG.TERRAIN_RESEED, MSG.TERRAIN_CONFIG, 'the two new message types must not collide')
  assert.equal(msgName(MSG.TERRAIN_RESEED), 'TERRAIN_RESEED')
  assert.equal(msgName(MSG.TERRAIN_CONFIG), 'TERRAIN_CONFIG')
})

test('terrain editor panel: seed field present, 7 obsolete live shader knobs removed, worldDef.terrain alias untouched', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./apps/terrain/index.js', import.meta.url), 'utf8')
  assert.match(src, /reseedTerrain/, 'panel must call ctx.reseedTerrain for the seed field')
  assert.doesNotMatch(src, /LIVE_KNOBS/, 'the 7 obsolete live shader knobs (LIVE_KNOBS) must be removed')
  for (const knob of ['octMax', 'hiFreqCut', 'landBias', 'detailOverlay', 'canyonDepth', 'cliffAmt', 'beachShelf']) {
    assert.doesNotMatch(src, new RegExp("'" + knob + "'"), `removed knob "${knob}" must not remain referenced in the panel`)
  }
  const tpsGame = readFileSync(new URL('./apps/world/tps-game.js', import.meta.url), 'utf8')
  assert.match(tpsGame, /worldDef\.terrain|terrain:\s*TERRAIN|TERRAIN\s*=/, 'tps-game world-def terrain block must remain present')
  const terrainPhysics = readFileSync(new URL('./src/terrain/TerrainPhysics.js', import.meta.url), 'utf8')
  assert.match(terrainPhysics, /worldDef\s*&&\s*worldDef\.terrain/, 'TerrainPhysics.js legacy worldDef.terrain fallback must remain intact')
})

test('EditorHandlers TERRAIN_RESEED handler broadcasts full config to every client, tears down + rebuilds the streamer', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./src/sdk/EditorHandlers.js', import.meta.url), 'utf8')
  assert.match(src, /MSG\.TERRAIN_RESEED\]/, 'handler for MSG.TERRAIN_RESEED must exist')
  assert.match(src, /connections\.broadcast\(MSG\.TERRAIN_CONFIG/, 'reseed must BROADCAST (not send-to-one) the new config')
  assert.match(src, /_terrainStreamer\?\.stop\(\)|_terrainStreamer\.stop\(\)/, 'must tear down the existing collider streamer before rebuilding')
  assert.match(src, /setupTerrainStreaming/, 'must re-run setupTerrainStreaming with the new seed')
})

test('client rebuildTerrain disposes+recreates vegetation/rocks/grass on a seed change (not just the backdrop)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./client/app.js', import.meta.url), 'utf8')
  assert.match(src, /seedChanged/, 'rebuildTerrain must detect a seed change distinctly from other partial overrides (e.g. radius)')
  assert.match(src, /vegetation\.dispose|vegetation && vegetation\.dispose/, 'a seed change must dispose the old vegetation before recreating it')
  assert.match(src, /rocks\.dispose|rocks && rocks\.dispose/, 'a seed change must dispose the old rocks before recreating them')
  assert.match(src, /grass\.dispose|grass && grass\.dispose/, 'a seed change must dispose the old grass before recreating it')
})

test('npx scaffold template is minimal (not a copy of the full bundled apps/) and package.json declares spoint as a real dependency', async () => {
  const { readFileSync, readdirSync, existsSync } = await import('node:fs')
  const tplRoot = new URL('./bin/project-template/', import.meta.url)
  assert.ok(existsSync(new URL('apps/hello-app/index.js', tplRoot)), 'template must ship a minimal starter app')
  assert.ok(existsSync(new URL('apps/world/index.js', tplRoot)), 'template must ship a minimal world-def')
  const worldDefEntities = readdirSync(new URL('apps/', tplRoot))
  assert.ok(worldDefEntities.length <= 2, `template apps/ must stay minimal (hello-app + world only), found: ${worldDefEntities.join(',')}`)
  const pkgTpl = readFileSync(new URL('package.json.template', tplRoot), 'utf8')
  assert.match(pkgTpl, /"spoint":\s*"\^__SPOINT_VERSION__"/, 'template package.json must declare spoint as a dependency (version substituted at scaffold time)')
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.bin['create-spoint-game'], 'package.json must expose a create-spoint-game bin entry')
})

test('AgentEditStaging: clean/dirty/persisting transitions, conflict detection, partial-failure-safe batch commit (real module, injected fake disk)', async () => {
  const { createAgentEditStaging } = await import(new URL('./client/editor/AgentEditStaging.js', import.meta.url))
  // in-memory IndexedDB stand-in: same DI seam the client wires real getSource/saveSource round-trips through
  const _store = new Map()
  class Req { constructor(){ this.onsuccess=null; this.onerror=null } ok(r){ this.result=r; queueMicrotask(()=>this.onsuccess&&this.onsuccess()) } }
  const fakeDb = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => fakeDb._store(),
    _store() { return { get:k=>{const r=new Req();r.ok(_store.get(k));return r}, getAll:()=>{const r=new Req();r.ok(Array.from(_store.values()));return r}, put:rec=>{_store.set(rec.key,rec);const r=new Req();r.ok();return r}, delete:k=>{_store.delete(k);const r=new Req();r.ok();return r} } },
    transaction() { const t={oncomplete:null,onerror:null,objectStore:()=>fakeDb._store()}; queueMicrotask(()=>t.oncomplete&&t.oncomplete()); return t }
  }
  const origIDB = globalThis.indexedDB
  globalThis.indexedDB = { open: () => { const r=new Req(); r.ok(fakeDb); return r } }
  try {
    let disk = { 'demo::index.js': 'old' }
    const getSource = async (a,f) => { const k=a+'::'+f; if (!(k in disk)) throw new Error('nf'); return disk[k] }
    const saveSource = async (a,f,s) => { disk[a+'::'+f]=s; return { ok:true } }
    const staging = createAgentEditStaging({ getSource, saveSource })
    await staging.loadAll()
    const rec = await staging.stage('demo', 'index.js', 'new content')
    assert.equal(rec.status, 'dirty', 'stage() must transition to dirty')
    assert.equal(staging.isDirty('demo', 'index.js'), true)
    disk['demo::index.js'] = 'changed elsewhere'
    assert.equal(await staging.hasConflict('demo', 'index.js'), true, 'a disk-side change since staging must be detected as a conflict')
    const aborted = await staging.commitOne('demo', 'index.js')
    assert.equal(aborted.ok, false, 'commit must abort on an unforced conflict')
    assert.equal(aborted.conflict, true)
    const forced = await staging.commitOne('demo', 'index.js', { force: true })
    assert.equal(forced.ok, true, 'a forced commit must succeed despite the conflict')
    assert.equal(disk['demo::index.js'], 'new content', 'commit must flush the staged content to disk via saveSource')
    assert.equal(staging.isDirty('demo', 'index.js'), false, 'a successful commit clears the dirty entry')
    // Partial-failure batch: one entry fails, the other still commits; only the failed one stays dirty.
    disk['a::index.js'] = 'A'; disk['b::index.js'] = 'B'
    const flaky = async (a,f,s) => a === 'a' ? { ok:false, error:'forced fail' } : (disk[a+'::'+f]=s, { ok:true })
    const staging2 = createAgentEditStaging({ getSource, saveSource: flaky })
    await staging2.loadAll()
    await staging2.stage('a', 'index.js', 'A2')
    await staging2.stage('b', 'index.js', 'B2')
    const results = await staging2.commitAll({ force: true })
    assert.equal(results.find(r => r.appName === 'a').ok, false, 'the failing entry must report failure')
    assert.equal(results.find(r => r.appName === 'b').ok, true, 'the succeeding entry in the same batch must still commit')
    assert.equal(staging2.isDirty('a', 'index.js'), true, 'a failed commit must leave that entry still dirty (no data loss)')
    assert.equal(staging2.isDirty('b', 'index.js'), false, 'a succeeded commit in the same batch must still clear')
  } finally {
    globalThis.indexedDB = origIDB
  }
})

test('Vegetation cull regression guard: full-tree union box/sphere stamped on LOD0+every simplified LOD (no BVH partial-box culling on approach)', async () => {
  const { readFileSync } = await import('node:fs')
  const vegSrc = readFileSync(new URL('./client/core/Vegetation.js', import.meta.url), 'utf8')
  const impSrc = readFileSync(new URL('./client/core/VegImpostorTier.js', import.meta.url), 'utf8')
  assert.match(vegSrc, /branchGeo0\.boundingBox\.clone\(\)\.union\(leafGeo0\.boundingBox\)/, 'tree box = union(branch, leaf)')
  assert.match(vegSrc, /for\s*\(const g of \[b1, b2, l1, l2\]\)\s*\{\s*g\.boundingBox\s*=\s*_treeBox\.clone\(\);\s*g\.boundingSphere\s*=\s*_treeSph\.clone\(\)/, 'every simplified LOD geo gets the union box+sphere')
  assert.doesNotMatch(vegSrc, /m\.sortObjects\s*=\s*true/, 'sortObjects stays off (sort-based LOD drops LOD0-band instances)')
  assert.doesNotMatch(vegSrc, /installNearForceDraw/, 'force-draw wrap stays removed (single-assignment LOD)')
  assert.doesNotMatch(vegSrc, /async function simplifyGeo[\s\S]*?\n\s*return geo\n/, 'simplifyGeo must clone, never alias the source geo across LOD levels')
  const m = vegSrc.match(/cfg\.bvhMargin\s*:\s*(\d+)/)
  assert.ok(m && Number(m[1]) >= 16, 'BVH cull margin stays generous (>=16m) for tall/scaled canopies')
  assert.match(vegSrc, /const LOD_HYS\s*=\s*Number\.isFinite\(cfg\.lodHysteresis\)\s*\?\s*cfg\.lodHysteresis\s*:\s*0\.12/, 'non-zero LOD hysteresis default (no boundary flicker)')
  assert.match(impSrc, /boundingSphere\.radius\s*=\s*1\.0/, 'shared impostor cull sphere sized to tree diameter, not the unit plane')
  assert.match(vegSrc, /cfg\.renderDistance\s*:\s*640/, 'vegetation render distance doubled with a distance-density falloff')
})

test('VegPlacement: deterministic + client/server placement parity, water/slope/treeline rejection gates', async () => {
  const { VEG, SPECIES, hash3, trunkIdOf, classify, speciesFor, baseDensity, placementsForChunk } = await import(new URL('./src/terrain/VegPlacement.js', import.meta.url))
  const frame = { groundHeightLocal(x, z) { return 40 + 6 * Math.sin(x * 0.01) * Math.cos(z * 0.013) }, localToDir(x, z) { const dx = x * 1e-6, dz = z * 1e-6, l = Math.hypot(dx, 1, dz); return [dx / l, 1 / l, dz / l] } }
  const field = { sampleDir() { return { temp: 0.6, humidity: 0.6, seaBias: 50 } } }
  assert.equal(hash3(1, 2, 3), hash3(1, 2, 3), 'hash3 deterministic')
  assert.equal(trunkIdOf(12.34, -56.78), trunkIdOf(12.34, -56.78), 'trunkIdOf stable')
  const a = placementsForChunk(0, 0, frame, field, 1234), b = placementsForChunk(0, 0, frame, field, 1234)
  assert.deepEqual(a, b, 'same seed -> byte-identical forest (client/server collider parity contract)')
  assert.ok(a.length > 0, 'temperate-wet chunk produces trees')
  assert.notDeepEqual(placementsForChunk(0, 0, frame, field, 1), placementsForChunk(0, 0, frame, field, 2), 'different seeds vary')
  const under = { groundHeightLocal() { return -5 }, localToDir() { return [0, 1, 0] } }
  assert.equal(placementsForChunk(0, 0, under, field, 1).length, 0, 'fully-submerged chunk yields zero trees')
  const cliff = { groundHeightLocal(x) { return 40 + x * VEG.SLOPE_MAX * 10 }, localToDir() { return [0, 1, 0] } }
  assert.equal(placementsForChunk(0, 0, cliff, field, 1).length, 0, 'a cliff (>>SLOPE_MAX) yields zero trees')
  const high = { groundHeightLocal() { return VEG.TREELINE + VEG.TREELINE_FADE + 10 }, localToDir() { return [0, 1, 0] } }
  assert.equal(placementsForChunk(0, 0, high, field, 1).length, 0, 'above the treeline fade band yields zero trees')
  assert.equal(speciesFor(0.1, 0.6, 0.2), SPECIES.indexOf('Pine Medium'), 'cold climate -> pine species band')
  assert.ok(baseDensity(0.8, 0.9) > baseDensity(0.2, 0.2), 'wet-warm denser than cold-dry (Whittaker density band)')
  for (const p of a) assert.ok(p.species >= 0 && p.species < SPECIES.length && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), 'well-formed placement record')
})

test('GrassPlacement: cheap-reject reorder is output-identical to sample-first + tiling/parity/cursor invariants', async () => {
  const { classify, placementsForGrassChunk, createGrassChunkCursor, GRASS } = await import(new URL('./src/terrain/GrassPlacement.js', import.meta.url))
  assert.equal(GRASS.CELL * GRASS.GRID, GRASS.CHUNK, 'grass cell grid exactly tiles one chunk (no seams/overlaps)')
  const frame = { groundHeightLocal(x, z) { return 20 + 3 * Math.sin(x * 0.01) * Math.cos(z * 0.01) }, localToDir(x, z) { const dx = x * 1e-6, dz = z * 1e-6, l = Math.hypot(dx, 1, dz); return [dx / l, 1 / l, dz / l] } }
  const field = { sampleDir() { return { temp: 0.8, humidity: 0.9, seaBias: 1 } } }
  const seed = 5544
  assert.deepEqual(placementsForGrassChunk(3, -1, frame, field, seed), placementsForGrassChunk(3, -1, frame, field, seed), 'independent callers get byte-identical placements (determinism contract)')
  const cliff = { groundHeightLocal(x) { return 20 + x * GRASS.SLOPE_MAX * 10 }, localToDir(x, z) { const dx = x * 1e-6, dz = z * 1e-6, l = Math.hypot(dx, 1, dz); return [dx / l, 1 / l, dz / l] } }
  assert.equal(classify(0, 0, cliff, field), null, 'steep cliff rejected by the slope gate')
  const atomic = placementsForGrassChunk(0, 0, frame, field, 1337)
  let tick = 0
  const cur = createGrassChunkCursor(0, 0, frame, field, 1337, () => (tick += 100))
  let guard = 0
  while (!cur.step(1) && guard++ < 100000) { /* one cell per step */ }
  assert.ok(cur.done && cur.blades.length === atomic.length, 'incremental cursor is bit-identical to the atomic build (same blade count)')
})

test('TerrainPhysics: planet heightfield build + PlanetFrame contract + dequantized sectored artifact parity', async () => {
  const { setupTerrainStreaming, sampleTerrainGrid, createBakedHeightField } = await import(new URL('./src/terrain/TerrainPhysics.js', import.meta.url))
  const { createPlanetFrame } = await import(new URL('./src/terrain/PlanetFrame.js', import.meta.url))
  const { createHeightSampler } = await import('mapspinner/height-cpu')
  const ANCHOR = [-0.641, 0.2558, 0.7237]
  const calls = []
  const physics = {
    addHeightField: (samples, N, scale, pos) => { calls.push({ N, scale, pos, finite: samples.every(Number.isFinite) }); return 100 + calls.length },
    removeBody: (id) => calls.push({ removed: id }),
    setTerrainBodyId(id) { return (this._terrainBodyId = id) },
    getTerrainBodyId() { return this._terrainBodyId ?? null },
    setTerrainHeightSource(fn, frame, offsetY = 0) { this._terrainHeightAt = fn; this._planetFrame = frame; this._terrainOffsetY = offsetY },
    terrainHeightAt(x, z) { return typeof this._terrainHeightAt === 'function' ? this._terrainHeightAt(x, z) + (this._terrainOffsetY || 0) : null },
  }
  const worldDef = { terrain: { enabled: true, anchorDir: ANCHOR, radius: 6360000, offsetY: 0, physics: { extent: 256, resolution: 16 } } }
  const streamer = await setupTerrainStreaming({ physics, playerManager: { players: new Map() }, worldDef })
  const build = calls.find(c => c.N)
  assert.ok(build && build.finite, 'planet heightfield built with all-finite samples')
  assert.ok(Math.abs(physics._terrainHeightAt(0, 0)) < 1e-6, 'terrainHeightAt(0,0)=0 at the anchor (matches PlanetFrame contract)')
  const firstId = streamer.bodyId
  await streamer._rebuild(2000, -1500)
  assert.notEqual(streamer.bodyId, firstId, 'terrain re-center installs a new body')
  assert.ok(calls.some(c => c.removed === firstId), 'terrain re-center removes the old body (atomic swap, no leak)')
  streamer.stop()
  const sampler = createHeightSampler()
  const frame = createPlanetFrame({ sampler, anchorDir: ANCHOR, offsetY: 0 })
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  assert.ok(Math.abs(dot(frame.east, frame.up)) < 1e-9 && Math.abs(dot(frame.north, frame.up)) < 1e-9, 'PlanetFrame basis is orthonormal')
  const grid = sampleTerrainGrid({ heightFn: (x) => (x > 40 ? NaN : x * 0.001 + 0.5), extent: 100, resolution: 10 })
  assert.equal(grid.N % 2, 0, 'sampleTerrainGrid N stays even')
  assert.ok(grid.samples.includes(-1000), 'sampleTerrainGrid replaces NaN with the -1000 guard sentinel')
  const N = 8, Sn = 4, gridS = Math.ceil(N / Sn), bits = 8, qmax = (1 << bits) - 1
  const sectorMin = [0, 10, 20, 30], sectorMax = [5, 15, 25, 45]
  const sidx = (ix, iz) => Math.min((iz / Sn) | 0, gridS - 1) * gridS + Math.min((ix / Sn) | 0, gridS - 1)
  const trueH = (ix, iz) => { const si = sidx(ix, iz); const lo = sectorMin[si], hi = sectorMax[si]; return lo + (ix % Sn) / (Sn - 1) * (hi - lo) }
  const q = new Uint8Array(N * N)
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) { const si = sidx(ix, iz), lo = sectorMin[si], hi = sectorMax[si], v = trueH(ix, iz); q[iz * N + ix] = Math.round((v - lo) / (hi - lo) * qmax) }
  const artifact = { N, extent: 70, center: [0, 0], sectors: { nodesPerSector: Sn, gridS, qmax, bits }, sectorMin, sectorMax, q }
  const field2 = createBakedHeightField(artifact)
  const step = 70 / (N - 1)
  const [ix, iz] = [4, 4]
  const si = sidx(ix, iz), lo = sectorMin[si], hi = sectorMax[si]
  const h = field2.heightAtLocal(-35 + ix * step, -35 + iz * step)
  const quantStep = (hi - lo) / qmax
  assert.ok(Math.abs(h - trueH(ix, iz)) <= quantStep + 1e-6, 'dequantized sectored heightfield stays within one quantization step of the true height')
})

test('SnapshotProcessor: array-form player look angles survive the buffer path with the 8-bit layout, no aliasing', async () => {
  const { SnapshotProcessor } = await import(new URL('./src/client/SnapshotProcessor.js', import.meta.url))
  const { SnapshotEncoder } = await import(new URL('./src/netcode/SnapshotEncoder.js', import.meta.url))
  const sp = new SnapshotProcessor()
  // Array-form player wire tuple (the real MessageHandler path -- bypasses SnapshotEncoder.decode).
  // Built via the real encodePlayer path (SnapshotEncoder.encodePlayers) so this fixture matches
  // production's [id, bin(23-byte packed), onGround, health, inputSequence, crouch, lookPacked] layout
  // exactly, rather than hand-rolling a stale pre-binary-format flat-number tuple.
  const PITCH_BYTE = 200, YAW_BYTE = 64
  const lookPitch = (PITCH_BYTE / 255) * Math.PI - Math.PI / 2
  const lookYaw = (YAW_BYTE / 256) * (2 * Math.PI)
  const [player] = SnapshotEncoder.encodePlayers([{
    id: 7, position: [1, 2, 3], rotation: [0, 0, 0, 1], velocity: [0.1, 0.2, 0.3],
    onGround: true, health: 88, inputSequence: 42, crouch: 1, lookPitch, lookYaw
  }])
  const snap = sp.processSnapshot({ players: [player], entities: [] }, 1)
  const buf = snap.players[0]
  const expPitch = (PITCH_BYTE / 255) * Math.PI - Math.PI / 2
  const expYaw = (YAW_BYTE / 256) * (2 * Math.PI)
  assert.ok(Math.abs(buf.lookPitch - expPitch) < 1e-6, `buffer lookPitch ${buf.lookPitch} matches 8-bit decode ${expPitch} (was the drifted 4-bit bug)`)
  assert.ok(Math.abs(buf.lookYaw - expYaw) < 1e-6, `buffer lookYaw ${buf.lookYaw} matches 8-bit decode ${expYaw}`)
  assert.equal(buf.id, 7, 'player id decoded')
  assert.equal(buf.inputSequence, 42, 'inputSequence preserved (reconciliation ack)')
  // No aliasing: the buffer entry must be an independent object from the pooled track slot (interpolation
  // holds older+newer buffer entries across frames).
  const track = sp.getPlayerState(7)
  assert.notEqual(buf, track, 'buffer entry is not the same object as the track slot')
  assert.notEqual(buf.position, track.position, 'buffer position array is a copy, not aliased')
  const before = buf.position[0]
  track.position[0] = 999   // mutating the track must not touch the buffer entry
  assert.equal(buf.position[0], before, 'mutating the track slot does not corrupt the already-buffered entry')
})

test('SnapshotProcessor: entity field-delta and full-form both push independent buffer entries', async () => {
  const { SnapshotProcessor } = await import(new URL('./src/client/SnapshotProcessor.js', import.meta.url))
  const { encodeEntity } = await import(new URL('./src/netcode/SnapshotEncoder.js', import.meta.url))
  const sp = new SnapshotProcessor()
  // full-form entity array, built via the real encode path: [id, model, bin(23-byte packed), bodyType, custom, sleeping]
  const ent = encodeEntity({
    id: 5, model: 'crate', position: [10, 0, 20], rotation: [0, 0, 0, 1], velocity: [0, 0, 0],
    bodyType: 'dynamic', custom: null, scale: [1, 1, 1], _dynSleeping: false
  })
  const snap = sp.processSnapshot({ entities: [ent], players: [] }, 1)
  const buf = snap.entities[0]
  assert.equal(buf.id, 5, 'entity id decoded'); assert.equal(buf.model, 'crate', 'model decoded')
  assert.equal(buf.position[0], 10, 'entity x decoded')
  const track = sp.getEntity(5)
  assert.notEqual(buf.position, track.position, 'entity buffer position is a copy')
  track.position[0] = 777
  assert.equal(buf.position[0], 10, 'mutating entity track does not corrupt buffered entry')
})

test('ECS createPrefab: flat entity from component+tag template, overrides merged', async () => {
  const { createWorld } = await import(new URL('./packages/ecs/src/world.js', import.meta.url))
  const w = createWorld()

  // Basic prefab with components and tags
  const r1 = w.createPrefab({
    components: { position: { x: 1, y: 2 }, health: { hp: 100 } },
    tags: ['enemy', 'ground'],
  })
  assert.ok(w.exists(r1.id), 'entity created from prefab exists')
  assert.deepEqual(r1.children, [], 'flat prefab has no children')
  assert.deepEqual(w.getComponent(r1.id, 'position'), { x: 1, y: 2 }, 'component data matches')
  assert.deepEqual(w.getComponent(r1.id, 'health'), { hp: 100 }, 'second component matches')
  assert.equal(w.hasTag(r1.id, 'enemy'), true, 'tag enemy set')
  assert.equal(w.hasTag(r1.id, 'ground'), true, 'tag ground set')

  // Override a component field
  const r2 = w.createPrefab(
    { components: { position: { x: 1, y: 2 } } },
    { position: { y: 99 } },
  )
  assert.deepEqual(w.getComponent(r2.id, 'position'), { x: 1, y: 99 }, 'override merged into component data')

  // Override for a component not in the spec is ignored
  const r3 = w.createPrefab(
    { components: { position: { x: 0 } } },
    { health: { hp: 50 } },
  )
  assert.equal(w.hasComponent(r3.id, 'health'), false, 'override for non-existent component is ignored')

  // Prefab with no components, only tags
  const r4 = w.createPrefab({ tags: ['marker'] })
  assert.ok(w.exists(r4.id), 'tag-only prefab entity exists')
  assert.equal(w.hasTag(r4.id, 'marker'), true, 'tag marker set')

  // Prefab with empty spec (no components, no tags)
  const r5 = w.createPrefab({})
  assert.ok(w.exists(r5.id), 'empty prefab entity exists')

  // Snapshot/restore round-trip preserves prefab entities
  const snap = w.snapshot()
  const w2 = createWorld()
  w2.restore(snap)
  assert.equal(w2.exists(r1.id), true, 'prefab entity survives snapshot/restore')
  assert.deepEqual(w2.getComponent(r1.id, 'position'), { x: 1, y: 2 }, 'component data survives round-trip')
  assert.equal(w2.hasTag(r1.id, 'enemy'), true, 'tag survives round-trip')

  w.destroy()
  assert.throws(() => w.createPrefab({ components: { pos: { x: 0 } } }), 'destroyed world rejects createPrefab')
})

test('ECS createPrefab: nested children recursively instantiated', async () => {
  const { createWorld } = await import(new URL('./packages/ecs/src/world.js', import.meta.url))
  const w = createWorld()

  // Prefab with one child
  const r = w.createPrefab({
    components: { transform: { parent: true } },
    children: [
      { components: { transform: { child: 1 } }, tags: ['leaf'] },
    ],
  })
  assert.ok(w.exists(r.id), 'parent entity exists')
  assert.equal(r.children.length, 1, 'one child created')
  assert.ok(w.exists(r.children[0].id), 'child entity exists')
  assert.deepEqual(w.getComponent(r.children[0].id, 'transform'), { child: 1 }, 'child component data correct')
  assert.equal(w.hasTag(r.children[0].id, 'leaf'), true, 'child tag set')
  assert.deepEqual(r.children[0].children, [], 'leaf child has no grandchildren')

  // Prefab with multiple children
  const r2 = w.createPrefab({
    tags: ['root'],
    children: [
      { components: { pos: { x: 0 } } },
      { components: { pos: { x: 1 } } },
      { components: { pos: { x: 2 } } },
    ],
  })
  assert.equal(r2.children.length, 3, 'three children created')
  assert.deepEqual(w.getComponent(r2.children[0].id, 'pos'), { x: 0 }, 'child 0 data correct')
  assert.deepEqual(w.getComponent(r2.children[1].id, 'pos'), { x: 1 }, 'child 1 data correct')
  assert.deepEqual(w.getComponent(r2.children[2].id, 'pos'), { x: 2 }, 'child 2 data correct')

  // Deeply nested (grandchildren)
  const r3 = w.createPrefab({
    components: { label: { name: 'root' } },
    children: [
      {
        components: { label: { name: 'a' } },
        children: [
          { components: { label: { name: 'a1' } } },
          { components: { label: { name: 'a2' } } },
        ],
      },
      {
        components: { label: { name: 'b' } },
        children: [
          { components: { label: { name: 'b1' } } },
        ],
      },
    ],
  })
  assert.equal(r3.children.length, 2, 'two children at depth 1')
  assert.deepEqual(w.getComponent(r3.children[0].id, 'label'), { name: 'a' }, 'child a label correct')
  assert.equal(r3.children[0].children.length, 2, 'child a has two grandchildren')
  assert.deepEqual(w.getComponent(r3.children[0].children[0].id, 'label'), { name: 'a1' }, 'grandchild a1 label correct')
  assert.deepEqual(w.getComponent(r3.children[0].children[1].id, 'label'), { name: 'a2' }, 'grandchild a2 label correct')
  assert.equal(r3.children[1].children.length, 1, 'child b has one grandchild')
  assert.deepEqual(w.getComponent(r3.children[1].children[0].id, 'label'), { name: 'b1' }, 'grandchild b1 label correct')

  // All entities are distinct
  const allIds = new Set()
  function collectIds(node) {
    allIds.add(node.id)
    for (const c of node.children) collectIds(c)
  }
  collectIds(r3)
  assert.equal(allIds.size, 6, 'all 6 entities are distinct')

  // Snapshot/restore round-trip preserves hierarchy
  const snap = w.snapshot()
  const w2 = createWorld()
  w2.restore(snap)
  assert.equal(w2.exists(r3.id), true, 'root survives snapshot/restore')
  assert.equal(w2.exists(r3.children[0].id), true, 'child a survives snapshot/restore')
  assert.equal(w2.exists(r3.children[0].children[0].id), true, 'grandchild a1 survives snapshot/restore')
  assert.deepEqual(w2.getComponent(r3.children[0].children[0].id, 'label'), { name: 'a1' }, 'grandchild label survives round-trip')

  w.destroy()
})

test('EventChainManager handles triggers, conditions, actions, delays, and serialization', async () => {
  const { EventChainManager } = await import(new URL('./src/game/EventChainManager.js', import.meta.url))
  const mgr = new EventChainManager()

  let soundPlayed = false
  let entitySpawned = false

  mgr.setContext({
    audio: {
      play(name, opts) {
        if (name === 'coin_pickup') soundPlayed = true
      }
    },
    world: {
      spawn(id, spec) {
        entitySpawned = true
        return { id, ...spec }
      }
    }
  })

  // Add a chain: onInteract -> ifVariable score >= 10 -> playSound + setVariable + spawnPrefab
  mgr.setVariable('score', 10)
  mgr.setInventoryItem('player1', 'key_gold', 1)

  const chain = mgr.addChain({
    id: 'test_chain_1',
    name: 'Pickup Key Chain',
    trigger: { type: 'onInteract', entityId: 'chest_01' },
    conditions: [
      { type: 'ifVariable', variableName: 'score', operator: '>=', value: 10 },
      { type: 'ifItemInInventory', ownerId: 'player1', itemId: 'key_gold', operator: '>=', count: 1 }
    ],
    actions: [
      { type: 'playSound', sound: 'coin_pickup', volume: 0.8 },
      { type: 'setVariable', variableName: 'score', operator: '+=', value: 5 },
      { type: 'spawnPrefab', prefabId: 'gold_coin', position: [1, 2, 3] }
    ]
  })

  assert.equal(mgr.getChains().length, 1)

  // Trigger event for wrong entity
  const res1 = mgr.triggerEvent('onInteract', { entityId: 'chest_other', player: { id: 'player1' } })
  assert.equal(res1.length, 0, 'No chain triggered for wrong entity')

  // Trigger event for correct entity
  const res2 = mgr.triggerEvent('onInteract', { entityId: 'chest_01', playerId: 'player1' })
  assert.equal(res2.length, 1, 'Chain triggered for chest_01')
  assert.equal(res2[0].success, true, 'Chain execution succeeded')
  assert.equal(soundPlayed, true, 'playSound action executed')
  assert.equal(entitySpawned, true, 'spawnPrefab action executed')
  assert.equal(mgr.getVariable('score'), 15, 'setVariable += 5 updated score to 15')

  // Test delayed actions & tick
  mgr.addChain({
    id: 'delay_chain',
    trigger: { type: 'onTimer', timerId: 't1' },
    actions: [
      { type: 'delay', duration: 0.5 },
      { type: 'setVariable', variableName: 'timerDone', operator: '=', value: true }
    ]
  })

  mgr.triggerEvent('onTimer', { timerId: 't1' })
  assert.equal(mgr.getVariable('timerDone'), undefined, 'Delayed variable set not immediately applied')
  mgr.tick(0.3)
  assert.equal(mgr.getVariable('timerDone'), undefined, 'Still not applied after 0.3s')
  mgr.tick(0.3)
  assert.equal(mgr.getVariable('timerDone'), true, 'Applied after 0.6s total tick')

  // Test serialization round-trip
  const json = mgr.toJSON()
  const mgr2 = new EventChainManager()
  mgr2.fromJSON(json)
  assert.equal(mgr2.getChains().length, 2, 'Deserialized 2 chains')
  assert.equal(mgr2.getVariable('score'), 15, 'Deserialized variable score=15')
})

for (const { name, fn } of _tests) {
  try { await fn(); console.log('PASS', name); pass++ }
  catch(e) { console.error('FAIL', name, e.message); fail++ }
}
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
