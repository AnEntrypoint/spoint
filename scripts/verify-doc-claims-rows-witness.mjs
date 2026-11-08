import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = 'scripts/lib/verify-doc-claims.mjs';
const checkerSrc = readFileSync(join(ROOT, CHECKER), 'utf8');

function rowTable(name) {
  const start = checkerSrc.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`no ${name} literal in ${CHECKER}`);
  const open = checkerSrc.indexOf('{', start);
  const end = checkerSrc.indexOf('\n};', open);
  return new Function(`return ${checkerSrc.slice(open, end + 2)}`)();
}

const LINE_TOKEN = rowTable('LINE_TOKEN');
const FOLD_CORRECTED = rowTable('FOLD_CORRECTED');
const FOLD_NUMBER_RETIRED = rowTable('FOLD_NUMBER_RETIRED');

const fileCache = new Map();
function linesOf(rel) {
  if (!fileCache.has(rel)) fileCache.set(rel, readFileSync(join(ROOT, rel), 'utf8').split('\n'));
  return fileCache.get(rel);
}

function parseSpec(spec) {
  const nums = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let n = a; n <= (b ?? a); n++) nums.push(n);
  }
  return nums;
}

function firstLineWith(rel, token) {
  const n = linesOf(rel).findIndex((l) => l.includes(token));
  if (n < 0) throw new Error(`token ${JSON.stringify(token)} not in ${rel}`);
  return n + 1;
}

const failures = [];
let checks = 0;
function check(label, ok, detail = '') {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` :: ${detail}` : ''}`);
}

for (const [key, token] of Object.entries(LINE_TOKEN)) {
  const [file, spec] = key.split('#');
  const lines = existsSync(join(ROOT, file)) ? linesOf(file) : [];
  const holds = parseSpec(spec).some((n) => (lines[n - 1] ?? '').includes(token));
  check(`LINE_TOKEN ${key} holds ${token}`, holds, holds ? '' : `lines ${spec} of ${file} do not contain it`);
}

function citesAt(table, key, cites, forbid = []) {
  const value = table[key];
  check(`row ${key} exists`, typeof value === 'string');
  if (typeof value !== 'string') return;
  for (const [file, token] of cites) {
    const line = firstLineWith(file, token);
    const forms = file.split('/').map((_, i, parts) => parts.slice(i).join('/') + ':' + line);
    check(`row ${key} cites ${file}:${line}`, forms.some((f) => value.includes(f)), `value: ${value.slice(0, 140)}`);
  }
  for (const bad of forbid) check(`row ${key} no longer says ${JSON.stringify(bad)}`, !value.includes(bad));
}

const TSL = 'packages/mapspinner/src/tsl';
const CLUSTER = 'src/shared/clusterConfig.js';

citesAt(FOLD_CORRECTED, 'outputNode', [[`${TSL}/terrain-material-tsl.js`, 'material.outputNode']]);
citesAt(FOLD_CORRECTED, 'side = DoubleSide', [[`${TSL}/terrain-material-tsl.js`, 'material.side = THREE.BackSide']]);
citesAt(FOLD_CORRECTED, 'terrain-material-tsl.js:198', [[`${TSL}/terrain-material-tsl.js`, 'material.side = THREE.BackSide']], ['still at']);
citesAt(FOLD_CORRECTED, 'app.js:191', [['client/app.js', "_params.get('legacygl')"]], ['app.js:191']);
citesAt(FOLD_CORRECTED, 'app.js:190-193', [['client/app.js', "_params.get('legacygl')"]]);
citesAt(FOLD_CORRECTED, 'TerrainBackdrop.js:43', [['client/core/TerrainBackdrop.js', "await import('/node_modules/mapspinner/src/tsl/planet-tsl.js')"]], ['TerrainBackdrop.js:43']);
citesAt(FOLD_CORRECTED, 'TerrainBackdrop.js:46-47', [['client/core/TerrainBackdrop.js', "await import('/node_modules/mapspinner/src/tsl/planet-tsl.js')"]]);
citesAt(FOLD_CORRECTED, 'gl-render.js:1444,1555', [['packages/mapspinner/src/gl-render.js', 'const _hrwActive']], ['gl-render.js:1441']);
citesAt(FOLD_CORRECTED, 'QualityPresets.js:95', [['client/core/QualityPresets.js', "RenderControls.set('halfResWater'"]]);
citesAt(FOLD_CORRECTED, 'worldResolve.js:33', [['src/shared/worldResolve.js', 'function checkSlices'], ['src/shared/worldResolve.js', 'w.planetRadius !== undefined']], ['worldResolve.js:11', 'non-positive-finite']);
citesAt(FOLD_CORRECTED, 'apps/world/construct.js:20', [['apps/world/construct.js', 'relevanceRadius: 100']], ['construct.js:20']);
citesAt(FOLD_CORRECTED, 'src/apps/AppContext.js:387', [['src/apps/AppContext.js', 'defineFire(spec = {})']]);
citesAt(FOLD_CORRECTED, 'TickHandler.js:30', [['src/sdk/TickHandler.js', 'const SNAP_COST_HIGH_FRAC']], ['TickHandler.js:29']);
citesAt(FOLD_CORRECTED, 'StageLoader.js:110', [['src/stage/StageLoader.js', 'getRelevantEntitiesHorizontal(position, radius) {']], ['StageLoader.js:135']);
citesAt(FOLD_CORRECTED, 'surface-splat-tsl.js:133', [[`${TSL}/surface-splat-tsl.js`, 'const texFarFade']]);
citesAt(FOLD_CORRECTED, 'surface-splat-tsl.js:116', [[`${TSL}/surface-splat-tsl.js`, 'texFarFade.greaterThan(0.001)']], ['gFar is at']);
citesAt(FOLD_CORRECTED, 'planet-tsl.js:193-194', [[`${TSL}/planet-tsl.js`, 'addUpdateRange']]);
citesAt(FOLD_CORRECTED, 'clusterConfig.js:38,43,44,46,48,50', [[CLUSTER, 'throw new ClusterConfigError']], ['thrown at src/shared/clusterConfig.js:27']);
citesAt(FOLD_CORRECTED, 'Stage.js:61', [['src/stage/Stage.js', 'getRelevantEntitiesHorizontal(position, radius) {']]);
citesAt(FOLD_CORRECTED, 'src/sdk/server.js:79', [['src/sdk/server.js', 'getRelevanceRadius: () =>']]);
citesAt(FOLD_CORRECTED, 'perf-run.mjs:277', [['scripts/perf-run.mjs', 'const abPhaseMs']]);
citesAt(FOLD_CORRECTED, 'frame-time-gate.mjs:36', [['scripts/frame-time-gate.mjs', 'const UNLOCK_RAF']]);
citesAt(FOLD_CORRECTED, 'src/shared/clusterConfig.js:8', [[CLUSTER, 'JOLT_WASM_HEAP_BYTES = 134217728']]);

citesAt(FOLD_NUMBER_RETIRED, '301', [['scripts/perf-run.mjs', 'const abPhaseMs']], ['moved to 277']);
citesAt(FOLD_NUMBER_RETIRED, '193', [['client/app.js', "_params.get('legacygl')"]], ['TerrainBackdrop.js:46-47']);

for (const key of ['SnapshotGroupPlanner', 'config.planetRadius || 0', 'nearbyHorizontal', 'Octree.js:111', 'uniformFlow', 'exec_js', 'must:', '--server-tick=<hz>', 'fire-witness-gate.mjs', 'if/else', 'scaffold.js']) {
  const value = FOLD_CORRECTED[key] ?? '';
  check(`row ${key} says the repo-wide absence claim excludes this checker`, value.includes('this checker'));
}

const nearbyValue = FOLD_CORRECTED.nearbyHorizontal ?? '';
check('row nearbyHorizontal cites no stale checker line number', !nearbyValue.includes('line 424'));

const tpsGlb = execFileSync('git', ['ls-files', 'apps/tps-game/*.glb'], { cwd: ROOT }).toString().split('\n').filter(Boolean).length;
const glbValue = FOLD_CORRECTED['apps/tps-game/*.glb'] ?? '';
check(`row apps/tps-game/*.glb states the tracked count ${tpsGlb}`, glbValue.includes(`${tpsGlb} tracked .glb files under apps/tps-game`), `value: ${glbValue.slice(0, 120)}`);

const ifElseValue = FOLD_CORRECTED['if/else'] ?? '';
check('row if/else lists AGENTS.md among the files that carry uniformFlow', ifElseValue.includes('AGENTS.md'));
check('row if/else does not claim scripts is clean of uniformFlow', !ifElseValue.includes('scripts, apps and edge returned nothing'));

const reseedHits = (() => {
  try { return execFileSync('git', ['grep', '-l', '-F', 'terrain-reseed-failure-witness', '--', '.'], { cwd: ROOT }).toString().trim(); }
  catch { return ''; }
})();
const num120 = FOLD_NUMBER_RETIRED['120'] ?? '';
check('row 120 does not say the reseed grep returned nothing while it finds hits', reseedHits === '' || !num120.includes('returned nothing'));

const agentsCount = (readFileSync(join(ROOT, 'AGENTS.md'), 'utf8').match(/\b203\b/g) || []).length;
const num211 = FOLD_NUMBER_RETIRED['211'] ?? '';
check('row 211 does not claim AGENTS.md states a file count it does not state', agentsCount > 0 || !num211.includes('203'));

const ok = failures.length === 0;
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`checks: ${checks}, failures: ${failures.length}`);
console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
