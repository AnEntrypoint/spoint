import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { originInfoLine, pushedLine } from './lib/push-decision.mjs';

const SPOINT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JAYZEE = process.env.JAYZEE_ROOT ?? resolve(SPOINT, '..', 'jayzee');
const SAVI = process.env.SAVI_ROOT ?? resolve(SPOINT, '..', 'savi');
const OUT = process.env.SCRATCH_OUT ?? join(tmpdir(), 'spoint-parity', 'parity-crossmap.json');
const PARITY_FILE = process.env.PARITY_FILE ?? join(JAYZEE, 'docs/PARITY.md');
const PATH_TOKEN = /(?:src-tauri|src|client|apps|scripts|data|packages|edge|bin|vendor|work|\.gm|docs|gaps|runs|site|sources|spawn-engine|\.spawn)\/[A-Za-z0-9_.\/-]*[A-Za-z0-9_]/g;

const FAMILIES = {
  physics: ['src/physics/World.js', 'src/physics/CharacterManager.js', 'src/physics/StaticTileIndex.js', 'src/physics/DormantStatics.js', 'src/physics/VehiclePhysics.js', 'src/physics/GLBLoader.js', 'src/physics/DracoDecompressor.js', 'src/physics/MeshoptDecompressor.js', 'src/physics/joltLimits.js', 'src/physics/jointMap.js', 'src/physics/pivotTransform.js', 'src/physics/surfaceVelocity.js', 'src/physics/FlightModel.js'],
  characterStep: ['src/shared/characterStep.js'],
  netcodeAuthoritative: ['src/sdk/TickHandler.js', 'src/sdk/TickHandlerAOI.js', 'src/sdk/ServerHandlers.js'],
  rollbackLockstep: ['src/netcode/RollbackGameLoop.js', 'src/netcode/RollbackLoop.js', 'src/netcode/RollbackInputTransport.js', 'src/netcode/LockstepGameLoop.js', 'src/netcode/LockstepTickSystem.js', 'src/netcode/LockstepInputTransport.js', 'src/netcode/LockstepChecksum.js', 'src/netcode/peerLoops.js', 'src/netcode/PeerSimSession.js', 'src/netcode/NetcodeProfile.js'],
  aoi: ['src/sdk/TickHandlerAOI.js', 'src/spatial/Octree.js', 'src/stage/stageShapes.js', 'src/shared/relevanceRadius.js'],
  bandwidthPriority: ['src/sdk/TickHandler.js', 'src/sdk/TickHandlerAOI.js'],
  lagCompensation: ['src/netcode/LagCompensator.js', 'src/netcode/RewindSpatialIndex.js', 'src/netcode/Hitscan.js'],
  replay: ['src/netcode/ReplayRecorder.js', 'src/netcode/ReplayPlayer.js', 'src/netcode/ReplayFile.js', 'src/netcode/EventLog.js'],
  desyncAnticheat: ['src/netcode/DesyncDetector.js', 'src/netcode/ConsensusVoter.js', 'src/netcode/CheatEjection.js', 'src/netcode/OutlierDetector.js', 'src/netcode/InputGuard.js'],
  protocol: ['src/protocol/MessageTypes.js', 'src/protocol/msgpack.js', 'src/protocol/InputCodec.js', 'src/protocol/ComponentSchema.js', 'src/protocol/EventEmitter.js', 'src/protocol/CursorEventStream.js'],
  transport: ['src/transport/WebSocketTransport.js', 'src/transport/WebSocketClientTransport.js', 'src/transport/WebTransportServer.js', 'src/transport/WebTransportClientTransport.js', 'src/transport/WebTransportTransport.js', 'src/transport/WireweaveTransport.js', 'src/transport/WireweaveClient.js', 'src/transport/WorkerTransport.js', 'src/transport/TransformRing.js', 'src/transport/NetworkSimTransport.js', 'src/transport/TransportWrapper.js'],
  webrtcInClient: ['client/BrowserServer.js', 'client/hud/PeerHostUI.js'],
  sdkServer: ['src/sdk/server.js', 'src/sdk/ServerBoot.js', 'src/sdk/ServerAPI.js', 'src/sdk/ServerHandlers.js', 'src/sdk/WorkerEntry.js', 'src/sdk/WorkerBoot.js', 'src/sdk/RoomProcessWorker.js', 'src/sdk/Relocation.js', 'src/sdk/StaticHandler.js'],
  sharding: ['src/sharding/ClusterManager.js', 'src/sharding/ClusterRuntime.js', 'src/sharding/ClusterHandoff.js', 'src/sharding/ClusterServerWorld.js', 'src/sharding/ClusterWorldHost.js', 'src/sharding/RegionRouter.js', 'src/sharding/RegionGrid.js', 'src/sharding/RegionIPCTransport.js', 'src/sharding/ShardingRefusal.js'],
  appsRuntime: ['src/apps/AppRuntime.js', 'src/apps/AppContext.js', 'src/apps/AppLoader.js', 'src/apps/AppPhysics.js', 'src/apps/AppGameplay.js', 'src/apps/HotReloadQueue.js'],
  behaviours: ['src/behaviours/game-fsm.js', 'src/behaviours/triggerVolume.js', 'src/behaviours/combat.js', 'src/behaviours/health.js', 'src/behaviours/destructible.js', 'src/behaviours/softbody.js', 'src/behaviours/fluid.js', 'src/behaviours/spline.js', 'src/behaviours/path.js', 'src/behaviours/specBoundary.js', 'src/behaviours/buffs.js'],
  terrain: ['src/terrain/PlanetFrame.js', 'src/terrain/HeightfieldStreamer.js', 'src/terrain/ColliderStreamer.js', 'src/terrain/TerrainPhysics.js', 'src/terrain/PlacementChart.js', 'src/terrain/GrassPlacement.js', 'src/terrain/RockPlacement.js', 'src/terrain/CaveSDF.js', 'src/terrain/CavePatches.js', 'src/terrain/GrassPlacementLod.js', 'src/terrain/BiomeOverride.js', 'src/terrain/ClimateCache.js'],
  persistence: ['src/sdk/WorldPersistence.js', 'src/sdk/MinimapBake.js'],
  metrics: ['src/sdk/Metrics.js'],
  'client-prediction': ['src/client/PredictionEngine.js', 'src/client/ReconciliationEngine.js', 'src/client/SnapshotProcessor.js', 'src/client/SnapshotTimeline.js', 'src/client/ClockSync.js', 'src/client/ChartEpochSync.js', 'src/client/ReconnectManager.js'],
  'snapshot-encoding': ['src/netcode/SnapshotEncoder.js', 'src/netcode/SnapshotBinFormat.js'],
  'tick-governor': ['src/netcode/TickSystem.js'],
  fire: ['src/shared/fire/fireKernel.js', 'src/behaviours/fire.js'],
  pathfinding: ['src/pathfinding/NavmeshQuery.js', 'src/pathfinding/ChartNavmeshQuery.js', 'src/pathfinding/RecastIntegration.js'],
  stage: ['src/stage/Stage.js', 'src/stage/StageLoader.js'],
  sandbox: ['src/sdk/SESCompartmentEvaluator.js'],
  'client-render': ['client/core/SceneSetup.js', 'client/core/RenderGraph.js'],
  'client-xr': ['client/xr/XRWidgets.js'],
  'editor-hmr': ['client/editor/EditorShell.js', 'client/dev/HmrRuntime.js', 'src/debug'],
  'worlds-config': ['apps/world/tps-game.js', 'data/placed-models.json'],
  'stdlib-apps': ['src/stdlib-apps'],
  packages: ['packages/mapspinner/src/index.js', 'packages/streaming-gltf/index.js', 'packages/ecs/src/index.js', 'packages/spoint-core/src/lib.rs'],
  'game-systems': ['src/game/AbilityTree.js', 'src/game/QuestSystem.js', 'src/game/ProgressionSystem.js', 'src/game/StatsSystem.js', 'src/game/EventChainManager.js'],
  animation: ['src/animation/AnimationSystem.js'],
  'session-store': ['src/connection/SessionStore.js'],
  'terrain-marks': ['src/terrain/TerrainMarks.js', 'src/terrain/paintStore.js'],
  'cluster-config': ['src/shared/clusterConfig.js', 'src/shared/chartAnchor.js', 'src/terrain/CubeSphereCells.js'],
  'deploy-edge': ['edge/cf-do/spoint-do.js'],
  'desktop-shell': ['src-tauri/tauri.conf.json'],
  'bin-cli': ['bin/create-app.js'],
  'tooling-gate': ['scripts/check.mjs'],
  'feature-gap-report': ['.gm/witness-out/spawn-feature-gap.md'],
};

const GAPS = [
  { id: 'CHARTEST-est-s1-3', kind: 'PRD-REAL', family: 'terrain', paths: ['src/terrain/PlanetFrame.js'], keywords: ['CHARTEST', 'installGroundSource'] },
  { id: 'WADLER-relocation-probegroundy-m2-s1', kind: 'PRD-REAL', family: 'sdkServer', paths: ['src/sdk/Relocation.js'], keywords: ['probeGroundY'] },
  { id: 'GAP-bundle-freshness', kind: 'NON-PRD-REAL', family: 'tooling-gate', paths: ['package.json'], keywords: ['bundle-freshness'] },
  { id: 'GAP-MSG-DELTA_UPDATE', kind: 'NON-PRD-REAL', family: 'protocol', paths: ['src/protocol/MessageTypes.js'], keywords: ['DELTA_UPDATE'] },
  { id: 'GAP-trimesh-failure-propagation', kind: 'NON-PRD-REAL', family: 'appsRuntime', paths: ['src/apps/AppRuntime.js'], keywords: ['trimesh'] },
  { id: 'GAP-port-3002-shared', kind: 'NON-PRD-REAL', family: 'worlds-config', paths: ['apps/world/tps-game.js'], keywords: ['3002'] },
];

const problems = [];
const requirePath = (p, ctx) => { if (!existsSync(join(SPOINT, p))) problems.push(`${ctx}: missing ${p}`) };
for (const [fam, paths] of Object.entries(FAMILIES)) for (const p of paths) requirePath(p, `family ${fam}`);
for (const g of GAPS) for (const p of g.paths) if (g.id !== 'GAP-bundle-freshness') requirePath(p, `gap ${g.id}`);

const parityText = readFileSync(PARITY_FILE, 'utf8');
const rankedBlock = parityText.split('## Ranked rows')[1].split('## Split')[0];
const splitBlock = parityText.split('## Split')[1]?.split(/\n## /)[0] ?? '';
const rankedRowLines = [...rankedBlock.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ row: Number(m[1]), text: m[2] }));
const parityRowCount = rankedRowLines.length;
rankedRowLines.forEach((r, i) => { if (r.row !== i + 1) problems.push(`PARITY ranked row numbering: row ${r.row} at position ${i + 1}`) });

const ENFORCE_UNLABELLED = true;
const EXPECTED_ABSENT = ['scripts/bundle-freshness-witness.mjs'];
const EXT_CANDIDATES = ['.js', '.mjs', '.cjs', '.ts', '.json', '.rs', '.md', '.yml'];
const resolvesIn = (p) => [existsSync(join(SPOINT, p)) && 'spoint', existsSync(join(JAYZEE, p)) && 'jayzee'].filter(Boolean);
const pathReport = [];
const LABELLED_TOKEN = new RegExp(`${PATH_TOKEN.source}(?:\\s*\\((spoint|jayzee|savi)(, not created)?\\))?`, 'g');
const citedIn = (text) => {
  const byKey = new Map();
  for (const m of text.matchAll(LABELLED_TOKEN)) {
    const path = m[0].replace(/\s*\((spoint|jayzee|savi)(, not created)?\)$/, '');
    const saviPrefix = text.slice(Math.max(0, m.index - 5), m.index) === 'savi ';
    const label = m[1] ?? (saviPrefix ? 'savi' : null);
    const target = m[2] !== undefined;
    const key = target ? `${path}\u0000target` : path;
    if (!byKey.has(key)) byKey.set(key, { path, target, labels: new Set() });
    byKey.get(key).labels.add(label);
  }
  return [...byKey.values()].map(({ path, target, labels }) => ({ path, target, labels: [...labels] }));
};
const repoExists = (repo, p) => existsSync(join({ spoint: SPOINT, jayzee: JAYZEE, savi: SAVI }[repo], p));
const ROWS = rankedRowLines.map((r) => {
  const cited = citedIn(r.text).map(({ path, target, labels }) => {
    const label = labels.find((l) => l) ?? null;
    if (labels.filter((l) => l).length > 1 && new Set(labels.filter((l) => l)).size > 1) problems.push(`PARITY row ${r.row} labels ${path} as both spoint and jayzee`);
    return { path, target, label, resolvesIn: resolvesIn(path) };
  });
  for (const c of cited) {
    const home = c.label;
    if (c.target) {
      c.reason = repoExists(home, c.path) ? 'TARGET_CREATED_BUT_MARKED_NOT_CREATED' : 'TARGET_NOT_CREATED';
      if (c.reason !== 'TARGET_NOT_CREATED') problems.push(`PARITY row ${r.row} ${c.reason} ${c.path} (${home}, marked not created; exists in ${c.resolvesIn.join(',')})`);
      pathReport.push({ row: r.row, path: c.path, label: home, target: true, reason: c.reason, located: null, resolvesIn: c.resolvesIn, hints: [] });
      continue;
    }
    const homeOk = home ? repoExists(home, c.path) : c.resolvesIn.length > 0 || repoExists('savi', c.path);
    if (EXPECTED_ABSENT.includes(c.path)) {
      c.reason = c.resolvesIn.length ? 'EXPECTED_ABSENT_BUT_PRESENT' : 'EXPECTED_ABSENT';
      if (c.resolvesIn.length) problems.push(`PARITY row ${r.row} ${c.reason} ${c.path} (exists in ${c.resolvesIn.join(',')})`);
    } else if (!homeOk) {
      const searched = home ? [home] : ['spoint', 'jayzee'];
      c.hints = searched.flatMap((repo) => EXT_CANDIDATES.map((e) => ({ path: `${c.path}${e}`, repo }))).filter((h) => repoExists(h.repo, h.path)).map((h) => ({ path: h.path, resolvesIn: [h.repo] }));
      const wrongHome = home && c.resolvesIn.length > 0;
      c.reason = c.hints.length ? 'EXTENSION_MISMATCH' : wrongHome ? `NAMESPACE_MISMATCH` : home ? `MISSING_IN_${home.toUpperCase()}` : 'MISSING_IN_BOTH';
      const detail = c.hints.length ? ` -> ${c.hints.map((h) => `${h.path} (${h.resolvesIn.join(',')})`).join(' or ')}` : wrongHome ? ` (labelled ${home}, exists only in ${c.resolvesIn.join(',')})` : '';
      problems.push(`PARITY row ${r.row} ${c.reason} ${c.path}${home ? ` (${home})` : ''}${detail}`);
    } else {
      c.reason = home ? `LABELLED_${home.toUpperCase()}_OK` : c.resolvesIn.length === 2 ? 'IN_BOTH_REPOS' : c.resolvesIn.length === 1 ? `${c.resolvesIn[0].toUpperCase()}_PATH` : 'SAVI_PATH';
    }
    if (c.label === null && ENFORCE_UNLABELLED) {
      c.located = c.reason;
      c.reason = 'UNLABELLED';
      problems.push(`PARITY row ${r.row} UNLABELLED ${c.path} (located ${c.located}; add (spoint), (jayzee) or (savi))`);
    }
    pathReport.push({ row: r.row, path: c.path, label: c.label, reason: c.reason, located: c.located ?? null, resolvesIn: c.resolvesIn, hints: c.hints ?? [] });
  }
  const spointCited = cited.filter((c) => !c.target && (c.label === 'spoint' ? c.resolvesIn.includes('spoint') : c.label === null && c.resolvesIn.includes('spoint'))).map((c) => c.path);
  const families = Object.keys(FAMILIES).filter((f) => FAMILIES[f].some((p) => spointCited.some((c) => c === p || p.startsWith(c + '/') || c.startsWith(p + '/'))));
  return { row: r.row, families, cited, spointCited };
});
for (const p of EXPECTED_ABSENT) if (existsSync(join(SPOINT, p))) problems.push(`expected-absent ${p} now exists in spoint: the gap is closed`);

const jayzeeSha = execFileSync('git', ['-C', JAYZEE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const spoint = execFileSync('git', ['-C', SPOINT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const parityDirty = execFileSync('git', ['-C', JAYZEE, 'status', '--porcelain', '--', 'docs/PARITY.md'], { encoding: 'utf8' }).trim() !== '';
const jayzeeOriginMain = (() => { try { return execFileSync('git', ['-C', JAYZEE, 'rev-parse', '--short', 'origin/main'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
const jayzeeRemoteLive = (() => { try { return execFileSync('git', ['-C', JAYZEE, 'ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' }).trim().split(/\s+/)[0] || null; } catch { return null; } })();
const jayzeeAheadOfOrigin = jayzeeOriginMain ? Number(execFileSync('git', ['-C', JAYZEE, 'rev-list', '--count', 'origin/main..HEAD'], { encoding: 'utf8' }).trim()) : null;

const familyRows = Object.fromEntries(Object.keys(FAMILIES).map((f) => [f, []]));
for (const r of ROWS) for (const f of r.families) familyRows[f].push(r.row);
const rowsWithNoSpoint = ROWS.filter((r) => r.spointCited.length === 0).map((r) => r.row);
const uncoveredFamilies = Object.keys(FAMILIES).filter((f) => familyRows[f].length === 0);

const citedSet = new Set(ROWS.flatMap((r) => r.spointCited));
const uncitedPathsByFamily = {};
for (const [fam, paths] of Object.entries(FAMILIES)) {
  const u = paths.filter((p) => !citedSet.has(p) && !ROWS.some((r) => r.spointCited.some((c) => c === p || p.startsWith(c + '/'))));
  if (u.length) uncitedPathsByFamily[fam] = u;
}
const uncitedPathCount = Object.values(uncitedPathsByFamily).reduce((n, ps) => n + ps.length, 0);

const gapCoverage = GAPS.map((g) => {
  const inRanked = rankedRowLines.filter((r) => g.keywords.some((k) => r.text.includes(k))).map((r) => r.row);
  const inSplit = g.keywords.some((k) => splitBlock.includes(k));
  const familyRowsCovering = familyRows[g.family] ?? [];
  let status;
  if (inRanked.length) status = 'NAMED-IN-RANKED-ROW';
  else if (inSplit) status = 'NAMED-IN-SPLIT-SECTION';
  else if (familyRowsCovering.length) status = 'FAMILY-COVERED-NOT-NAMED';
  else status = 'NO-ROW';
  return { id: g.id, kind: g.kind, spointPaths: g.paths, family: g.family, familyRowsCovering, namedInRankedRows: inRanked, namedInSplit: inSplit, status };
});

const scriptsMjs = readdirSync(join(SPOINT, 'scripts')).filter((f) => f.endsWith('.mjs'));
const countDirs = (p) => readdirSync(join(SPOINT, p), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
const countFiles = (p, re) => readdirSync(join(SPOINT, p)).filter((f) => re.test(f)).length;
const shippedContentText = rankedRowLines.find((r) => r.text.startsWith('Shipped content:'))?.text ?? '';
const shippedContentClaim = {
  stdlibAppDirs: Number(shippedContentText.match(/(\d+) built-in placed-app director/)?.[1]),
  worldDefsExcludingIndex: Number(shippedContentText.match(/(\d+) world definitions/)?.[1]),
  glbMapsTopLevel: Number(shippedContentText.match(/(\d+) GLB maps/)?.[1]),
};
const shippedContentSpoint = {
  stdlibAppDirs: countDirs('src/stdlib-apps'),
  worldDefsExcludingIndex: countFiles('apps/world', /\.js$/) - (existsSync(join(SPOINT, 'apps/world/index.js')) ? 1 : 0),
  glbMapsTopLevel: countFiles('apps/maps', /\.glb$/i),
};
for (const k of Object.keys(shippedContentSpoint)) {
  if (!Number.isFinite(shippedContentClaim[k])) problems.push(`PARITY shipped-content row has no parseable ${k} count`);
  else if (shippedContentClaim[k] !== shippedContentSpoint[k]) problems.push(`PARITY shipped-content row ${k} claims ${shippedContentClaim[k]}, spoint measures ${shippedContentSpoint[k]}`);
}
const shippedContentClaims = { parityShippedContent: { claim: shippedContentText, parsed: shippedContentClaim, spointCount: shippedContentSpoint } };

const savi13 = readFileSync(join(SPOINT, '.gm/witness-out/spawn-feature-gap.md'), 'utf8')
  .split('\n').filter((l) => /^- \[ \] /.test(l)).map((l) => l.replace(/^- \[ \] \*\*(.+?)\*\*.*$/, '$1'));
if (savi13.length !== 13) problems.push(`savi gap report unchecked claims: expected 13, found ${savi13.length}`);
const savi47 = readFileSync(join(SPOINT, '.gm/witness-out/spawn-feature-gap.md'), 'utf8').split('\n').filter((l) => /^- \[x\] /.test(l)).length;
if (savi47 !== 47) problems.push(`savi gap report checked claims: expected 47, found ${savi47}`);

const prdIds = (readFileSync(join(SPOINT, '.gm/prd.yml'), 'utf8').match(/^- id:/gm) ?? []).length;
const trackedVerdicts = execFileSync('git', ['-C', SPOINT, 'ls-files', '.gm/witness-out'], { encoding: 'utf8' }).split('\n').filter((p) => /verdict/i.test(p)).length;
const untrackedLines = execFileSync('git', ['-C', SPOINT, 'status', '--short'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
const vendorItems = readFileSync(join(SPOINT, 'vendor/design/PRD-remediation-2026-08-20.md'), 'utf8');
const vendorHas = (n, title) => new RegExp(`^${n}\\. .*${title}`, 'm').test(vendorItems);
const evidence = {
  prdRows: prdIds,
  trackedVerdictFiles: trackedVerdicts,
  untrackedGitStatusLines: untrackedLines,
  prdNumberingCandidates: {
    vendorDesignPRD: {
      path: 'vendor/design/PRD-remediation-2026-08-20.md',
      item2: vendorHas(2, 'Collapse'),
      item3: vendorHas(3, 'purple'),
      item4: vendorHas(4, 'Severity vocabulary'),
    },
    workRowsCsproto: ['work/rows/csproto-2.yml', 'work/rows/csproto-3.yml', 'work/rows/csproto-4.yml'].map((p) => ({ path: p, exists: existsSync(join(SPOINT, p)) })),
  },
  lostVerdictSurvivingEvidence: ['work/rows/ILLEGAL-n-r256-5.yml', 'work/rows/ILLEGAL-n-r259-1.yml', 'work/rows/docclaim-gm-git-push-1.yml', '.gm/witness-out/ILLEGAL-n-r256-4-5-verdict.txt', '.gm/witness-out/ILLEGAL-n-r259-verdict.txt', '.gm/witness-out/completed-rows-check.txt', '.gm/witness-out/migration-map.txt'].map((p) => ({ path: p, exists: existsSync(join(SPOINT, p)) })),
  waveC: ['.gm/WAVE_C_COMPLETION_SUMMARY.md', '.gm/MODEL_BROWSER_DELIVERY.md'].map((p) => ({ path: p, exists: existsSync(join(SPOINT, p)) })),
  bundleFreshnessWitnessPresent: existsSync(join(SPOINT, 'scripts/bundle-freshness-witness.mjs')),
  scriptsTopLevelFiles: readdirSync(join(SPOINT, 'scripts')).filter((f) => !f.startsWith('.')).length,
  scriptsWitnessMjs: scriptsMjs.filter((f) => /witness/i.test(f)).length,
  scriptsHarnessMjs: scriptsMjs.filter((f) => /harness/i.test(f)).length,
};
if (prdIds !== 103) problems.push(`prd.yml ids ${prdIds}, expected 103`);
if (trackedVerdicts !== 76) problems.push(`tracked verdict files ${trackedVerdicts}, expected 76`);
if (untrackedLines !== 0) problems.push(`git status lines ${untrackedLines}, expected 0`);
if (!evidence.prdNumberingCandidates.vendorDesignPRD.item2 || !evidence.prdNumberingCandidates.vendorDesignPRD.item3 || !evidence.prdNumberingCandidates.vendorDesignPRD.item4) problems.push('vendor/design items 2-4 not all present');
if (evidence.bundleFreshnessWitnessPresent) problems.push('bundle-freshness witness now exists: GAP-bundle-freshness is closed');
for (const e of [...evidence.lostVerdictSurvivingEvidence, ...evidence.waveC, ...evidence.prdNumberingCandidates.workRowsCsproto]) if (!e.exists) problems.push(`evidence path missing: ${e.path}`);

const out = {
  spoint: { root: SPOINT, head: spoint },
  savi13Unchecked: savi13,
  evidence,
  jayzee: { parityDoc: 'docs/PARITY.md', head: jayzeeSha, rankedRows: parityRowCount, parityDirty, originMain: jayzeeOriginMain, remoteMainLive: jayzeeRemoteLive, aheadOfOrigin: jayzeeAheadOfOrigin },
  familyCount: Object.keys(FAMILIES).length,
  pathCount: Object.values(FAMILIES).reduce((n, ps) => n + ps.length, 0),
  rows: ROWS,
  pathReport,
  targetsNotCreated: pathReport.filter((p) => p.reason === 'TARGET_NOT_CREATED').map(({ row, path, label }) => ({ row, path, label })),
  familyCoverage: Object.fromEntries(Object.keys(FAMILIES).map((f) => [f, { parityRows: familyRows[f], covered: familyRows[f].length > 0 }])),
  uncoveredFamilies,
  uncitedPathsByFamily,
  uncitedPathCount,
  rowsWithNoSpointSource: rowsWithNoSpoint,
  gapCoverage,
  shippedContentClaims,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

console.log(`families ${out.familyCount}, spoint paths ${out.pathCount}, PARITY ranked rows ${parityRowCount} (jayzee ${jayzeeSha}, spoint ${spoint})`);
console.log(`uncovered families (no PARITY row): ${uncoveredFamilies.join(', ') || 'none'}`);
console.log(`rows with no spoint source path: ${rowsWithNoSpoint.join(', ') || 'none'}`);
console.log(`spoint paths not cited by any row: ${uncitedPathCount} across ${Object.keys(uncitedPathsByFamily).length} families`);
const reasonCounts = pathReport.reduce((n, p) => ({ ...n, [p.reason]: (n[p.reason] ?? 0) + 1 }), {});
console.log(`cited path reasons: ${JSON.stringify(reasonCounts)}`);
console.log(`named targets not created (reported, not a problem): ${out.targetsNotCreated.map((t) => `${t.row} ${t.path}`).join('; ') || 'none'}`);
for (const g of gapCoverage) console.log(`gap ${g.id}: ${g.status} (family ${g.family}; family rows ${g.familyRowsCovering.join('/') || '-'}; ranked rows ${g.namedInRankedRows.join('/') || '-'}; split ${g.namedInSplit})`);
console.log(`parity shipped-content row claims ${JSON.stringify(shippedContentClaim)}; spoint measures ${JSON.stringify(shippedContentSpoint)}`);
for (const p of problems) console.log(`PROBLEM ${p}`);
console.log(parityDirty ? `tree: DIRTY docs/PARITY.md has uncommitted changes; this run is PROVISIONAL, not final` : `tree: CLEAN at ${jayzeeSha}`);
console.log(originInfoLine({ originMain: jayzeeOriginMain, remoteLive: jayzeeRemoteLive, aheadOfOrigin: jayzeeAheadOfOrigin }));
console.log(pushedLine({ localSha: jayzeeSha, remoteLive: jayzeeRemoteLive }));
console.log(problems.length === 0 ? `RESULT: PASS${parityDirty ? ' (PROVISIONAL)' : ''} (${OUT})` : 'RESULT: FAIL');
process.exit(problems.length === 0 ? 0 : 1);
