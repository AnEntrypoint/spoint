import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute } from 'node:path';

const ROOT = process.cwd();
const DOCS = ['AGENTS.md', 'docs/measurement-figures.md'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.gpu-lock', '.cache', 'out', '.gm', '.plugkit-browser-profile']);
const PATH_EXT = /\.(js|mjs|cjs|ts|tsx|glsl|tsl|json|yml|yaml|html|md|wasm|glb|hf|txt|lock|sh|ps1)$/;
const NOT_PATHS = new Set([
  '.git/index.lock',
  '.gpu-lock/owner.json',
  '.witness-audit-baseline.json',
  'apps/world/*.hf',
  'client/{index,landing/index,editor/thebird-host}.html',
  'in/<verb>/<session_id>-<random8>.txt',
  'node_modules/.bin',
  '@spoint/ecs',
  '@spoint/*',
  'world-snapshot',
  'vendor/*',
  'http://127.0.0.1:8787/mcp',
  'src,client,apps,scripts,bin',
  '.tmp',
  '.txt',
  'three.webgpu.js',
]);

const CODE_EXCLUDE_PREFIX = ['.gm/', '.plugkit', '.github/'];
const SEARCH_EXTS_SKIP = /\.(md|json|yml|yaml|txt|html)$/;

const REGISTRY_DECLARATION_FILES = ['client/core/RenderControls.js'];
const DEMO_ONLY_FILES = ['packages/mapspinner/src/terrain-gen-controls.js', 'packages/mapspinner/planet.html'];

const WRITE_ONLY_KEYS = {};

const DECLARATION_ONLY_KEYS = {
  'elevEdgeInset': 'documented as having NO consumer: only the registry entry and the mapspinner demo panel touch it',
};

const BASENAME_PIN = {
  'Relocation.js': 'src/sdk/Relocation.js',
  'gpu-eval.mjs': 'scripts/lib/gpu-eval.mjs',
  'server.js': 'src/sdk/server.js',
  'cluster-lod-mesh.js': 'packages/streaming-gltf/src/cluster-lod-mesh.js',
};

const LINE_TOKEN = {
  'src/shared/clusterConfig.js#9': 'JOLT_WASM_HEAP_BYTES',
  'src/shared/clusterConfig.js#35': 'resolveClusterConfig',
  'src/shared/clusterConfig.js#27,30,37': 'ClusterConfigError',
  'src/stage/Stage.js#13': 'planetRadiusMeters',
  'src/stage/Stage.js#63': 'getRelevantEntitiesHorizontal',
  'src/stage/StageLoader.js#4': 'resolveClusterConfig',
  'src/stage/StageLoader.js#5': 'planetRadius',
  'src/stage/StageLoader.js#135': 'getRelevantEntitiesHorizontal',
  'src/sdk/TickHandlerAOI.js#74': 'planetRadius',
  'src/shared/worldResolve.js#33': 'planetRadius',
  'src/apps/AppContext.js#11': 'defineFire',
  'packages/mapspinner/src/tsl/sky-tsl.js#89': 'marchRadiance',
  'packages/mapspinner/src/tsl/surface-splat-tsl.js#108': 'gFar',
  'packages/mapspinner/src/tsl/surface-splat-tsl.js#73': 'texFarFade',
  'packages/mapspinner/src/tsl/planet-tsl.js#28': 'WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS',
  'packages/mapspinner/src/tsl/planet-tsl.js#180': 'addUpdateRange',
  'packages/mapspinner/src/tsl/planet-tsl.js#232-270': 'function frame',
  'packages/mapspinner/src/tsl/planet-tsl.js#260': 'fsCheap',
  'packages/mapspinner/src/tsl/terrain-material-tsl.js#195': 'outputNode',
  'packages/mapspinner/src/tsl/terrain-material-tsl.js#198': 'DoubleSide',
  'client/app.js#190': 'legacygl',
  'client/app.js#191': '_runsInPageServer',
  'client/core/TerrainBackdrop.js#43': 'planet-tsl',
  'client/core/TerrainBackdrop.js#46-47': 'planet-orchestrator',
  'client/core/Weather.js#168': 'SNOW_GROUND_RESAMPLE_DRIFT_M',
  'packages/mapspinner/src/gl-render.js#616': '__vsCheap',
  'packages/mapspinner/src/gl-render.js#1253': '__fsCheap',
  'packages/mapspinner/src/gl-render.js#1441': '__halfResWater',
  'client/core/QualityPresets.js#16': 'halfResWater',
  'packages/mapspinner/src/terrain-gen-controls.js#45': 'elevEdgeInset',
  'packages/mapspinner/src/terrain-gen-controls.js#86': 'elevEdgeInset',
  'src/sdk/TickHandler.js#29': 'SNAP_COST_HIGH_FRAC',
  'src/presets/tps.js#5': 'relevanceRadius',
  'apps/world/construct.js#20': 'relevanceRadius',
  'src/sdk/server.js#80': 'getRelevanceRadius',
  'scripts/frame-time-gate.mjs#36': 'UNLOCK_RAF',
  'scripts/perf-run.mjs#277': 'abPhaseMs',
  'scripts/lib/gpu-eval.mjs#175': 'probeHeights',
};

const KNOB_KEYS = [
  'splitFactor', 'maxLevel', 'distFactor', 'geomorphLod', 'wetness',
  'fsCheap', 'vsCheap', 'octMax', 'fsDetailOcts', 'nrmStepM', 'waterVisGate',
  'elevEdgeInset', 'halfResWater', 'dprAuto', 'dprOff',
];

const KNOB_FLAGS = [
  'legacygl', 'noveg', 'veg', 'nograss', 'norocks', 'lightplanet', 'predict',
  'probe', 'singleplayer', 'multiplayer', 'connect', 'gpuhide', 'gpuab',
  'gpuabms', 'gpu-passes', 'knob', 'backend', 'extra', 'params',
  'server-tick', 'settle-tol', 'accept-slower', 'cdp-timeout',
];

const KNOB_GLOBALS = [
  '__vegAllOff', '__vdrs', '__vdrsScale', '__renderControls', '__terrainOff',
  '__warmupInFlight', '__dprAuto', '__app', '__spoint', '__rendererInfo',
  '__maxLevel', 'input.back', 'input.backward',
];

const EXPECTED_NO_READER = {
  '__dprAuto': 'documented as having NO consumer: DRY-n-r141-1 deleted _publishDpr, so neither window.__dprAuto nor window.__dprOff is written or read anywhere',
  'noveg': 'AGENTS.md records ?noveg as NOT a flag: silent no-op',
  '__terrainOff': 'documented as an unbuilt instrument, only a decided design',
  'input.back': 'documented as never set; keyboard sets input.backward',
  'elevEdgeInset': 'documented as having NO consumer',
};

const ABSENT_SYMBOLS = {
  '_collectElevEdgeSample': 'documented reader that does not exist',
};

const BINARY_EXT = /\.(glb|gltf|wasm|png|jpg|jpeg|gif|webp|ktx2|basis|mp3|ogg|wav|ttf|woff2?|zip|pdf|bin|hf|dat|exe|dll|node|pdb)$/;
const MAX_FILE_BYTES = 4_000_000;

const TRACKED = (() => {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 28 })
      .toString('utf8').split('\0').filter(Boolean);
  } catch { return []; }
})();

const ALL_FILES = [...new Set([...TRACKED, ...DOCS])]
  .filter((p) => !BINARY_EXT.test(p))
  .filter((p) => { try { return statSync(join(ROOT, p)).size <= MAX_FILE_BYTES; } catch { return false; } });
const DOC_SET = new Set(DOCS);
const SELF_PATH = 'scripts/lib/verify-doc-claims.mjs';
const SEARCHABLE = ALL_FILES.filter((p) => !DOC_SET.has(p)
  && p !== SELF_PATH
  && !CODE_EXCLUDE_PREFIX.some((x) => p.startsWith(x))
  && !SEARCH_EXTS_SKIP.test(p));

function resolvePath(token) {
  const bare = token.endsWith('/') ? token.slice(0, -1) : token;
  if (existsSync(join(ROOT, bare)) && statSync(join(ROOT, bare)).isFile()) return bare;
  if (BASENAME_PIN[token]) return BASENAME_PIN[token];
  const base = token.split('/').pop();
  const hits = ALL_FILES.filter((p) => p === token || p.endsWith('/' + token) || p.split('/').pop() === base);
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return null;
  const pinned = BASENAME_PIN[base];
  if (pinned && hits.includes(pinned)) return pinned;
  return { ambiguous: hits };
}

function parseLineSpec(spec) {
  const lines = new Set();
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b; i++) lines.add(i);
  }
  return lines;
}

function lineHasToken(fileLines, lineNums, token) {
  for (const n of lineNums) {
    const text = fileLines[n - 1];
    if (text !== undefined && text.includes(token)) return n;
  }
  return 0;
}

function derivedTokens(docLine) {
  const out = [];
  for (const m of docLine.matchAll(/`([^`]+)`/g)) {
    const t = m[1];
    if (/^[A-Za-z_$][A-Za-z0-9_$.]{3,}$/.test(t) && !PATH_EXT.test(t)) out.push(t);
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(t)) out.push(t);
  }
  return [...new Set(out)];
}

const fileCache = new Map();
function fileLines(rel) {
  if (!fileCache.has(rel)) {
    try { fileCache.set(rel, readFileSync(join(ROOT, rel), 'utf8').split('\n')); }
    catch { fileCache.set(rel, null); }
  }
  return fileCache.get(rel);
}

function backticks(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
}

function isGlob(t) { return t.includes('*') || t.includes('{') || t.includes('<'); }

function looksLikePath(t) {
  if (NOT_PATHS.has(t)) return false;
  if (t.includes(' ')) return false;
  if (isGlob(t)) return false;
  if (PATH_EXT.test(t)) return true;
  if (/^(src|client|apps|scripts|bin|packages|docs|edge|lang|vendor)\//.test(t)) return true;
  return false;
}

function isDirectoryClaim(t) { return t.endsWith('/') || (existsSync(join(ROOT, t)) && statSync(join(ROOT, t)).isDirectory()); }

function shaExists(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', sha], { stdio: 'pipe', cwd: ROOT });
    return true;
  } catch { return false; }
}

const readerIndex = new Map();
const readerBoundary = new Map();

function hitKind(rel, line, idx) {
  const before = line.slice(0, idx);
  const docAt = before.lastIndexOf('doc:');
  if (docAt >= 0 && /^\s*['"`][^'"`]*$/.test(before.slice(docAt + 4))) return 'docstring';
  if (REGISTRY_DECLARATION_FILES.includes(rel)) return 'declaration';
  if (DEMO_ONLY_FILES.includes(rel)) return 'demo';
  return 'consumer';
}

function buildReaderIndex(needles) {
  for (const n of needles) {
    readerIndex.set(n, []);
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const head = /[A-Za-z_$]/.test(n[0]) ? '\\b' : '';
    const tail = /[A-Za-z0-9_]/.test(n[n.length - 1]) ? '\\b' : '';
    readerBoundary.set(n, new RegExp(head + esc + tail));
  }
  for (const rel of SEARCHABLE) {
    let raw;
    try { raw = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const n of needles) {
        const hits = readerIndex.get(n);
        if (hits.length >= 12) continue;
        const idx = line.indexOf(n);
        if (idx < 0) continue;
        if (!readerBoundary.get(n).test(line)) continue;
        hits.push({ loc: rel + ':' + (i + 1), kind: hitKind(rel, line, idx) });
      }
    }
  }
}

function findReaders(token) {
  return readerIndex.get(token) || [];
}

const pathClaims = new Map();
const shaClaims = new Map();
for (const doc of DOCS) {
  if (!existsSync(join(ROOT, doc))) continue;
  const lines = fileLines(doc) || [];
  lines.forEach((line, idx) => {
    for (const tok of backticks(line)) {
      const lm = tok.match(/^(.+?):([0-9,\-]+)$/);
      const raw = lm ? lm[1] : tok;
      const spec = lm ? lm[2] : null;
      if (NOT_PATHS.has(raw) || isGlob(raw)) continue;
      if (looksLikePath(raw) || isDirectoryClaim(raw) || spec) {
        if (!looksLikePath(raw) && !isDirectoryClaim(raw)) continue;
        const key = raw + '#' + (spec || '-');
        if (!pathClaims.has(key)) pathClaims.set(key, { doc, raw, spec, line: idx + 1 });
      } else if (/^[0-9a-f]{7,40}$/.test(tok) && /[a-f]/.test(tok)) {
        if (!shaClaims.has(tok)) shaClaims.set(tok, doc + ':' + (idx + 1));
      }
    }
  });
}

const findings = [];
let pathsChecked = 0;
let dirsChecked = 0;
let linesChecked = 0;
let linesSymbolAsserted = 0;
let linesDerived = 0;
let linesExistenceOnly = 0;
let linesSymbolAbsent = 0;

for (const claim of [...pathClaims.values()].sort((a, b) => (a.raw + a.spec).localeCompare(b.raw + b.spec))) {
  if (isDirectoryClaim(claim.raw)) {
    const dirPath = claim.raw.endsWith('/') ? claim.raw.slice(0, -1) : claim.raw;
    if (existsSync(join(ROOT, dirPath)) && statSync(join(ROOT, dirPath)).isDirectory()) { dirsChecked++; continue; }
    findings.push({ kind: 'dir-missing', claim: claim.raw, at: claim.doc + ':' + claim.line });
    continue;
  }
  const resolved = resolvePath(claim.raw);
  if (!resolved) { findings.push({ kind: 'path-missing', claim: claim.raw, at: claim.doc + ':' + claim.line }); continue; }
  if (typeof resolved === 'object') { findings.push({ kind: 'path-ambiguous', claim: claim.raw, candidates: resolved.ambiguous.slice(0, 4), at: claim.doc + ':' + claim.line }); continue; }
  pathsChecked++;
  if (!claim.spec) continue;
  const lineNums = parseLineSpec(claim.spec);
  const lines = fileLines(resolved);
  if (!lineNums || !lines) { findings.push({ kind: 'linespec-unparsed', claim: claim.raw + ':' + claim.spec, at: claim.doc + ':' + claim.line }); continue; }
  linesChecked++;
  const explicit = LINE_TOKEN[resolved + '#' + claim.spec] || LINE_TOKEN[resolved + '#' + [...lineNums][0]];
  if (explicit) {
    if (lineHasToken(lines, lineNums, explicit)) linesSymbolAsserted++;
    else { linesSymbolAbsent++; findings.push({ kind: 'symbol-absent', claim: claim.raw + ':' + claim.spec, resolved, token: explicit, at: claim.doc + ':' + claim.line }); }
    continue;
  }
  let hit = 0;
  for (const t of derivedTokens(fileLines(claim.doc)[claim.line - 1])) {
    const h = lineHasToken(lines, lineNums, t);
    if (h) { hit = h; linesDerived++; break; }
  }
  if (!hit) {
    const maxLine = Math.max(...lineNums);
    if (lines.length >= maxLine && lines[maxLine - 1] !== undefined) linesExistenceOnly++;
    else { findings.push({ kind: 'line-out-of-range', claim: claim.raw + ':' + claim.spec, resolved, fileLines: lines.length, at: claim.doc + ':' + claim.line }); continue; }
  }
}

let shasChecked = 0;
for (const [sha, at] of [...shaClaims].sort()) {
  shasChecked++;
  if (!shaExists(sha)) findings.push({ kind: 'sha-missing', claim: sha, at });
}

const docText = DOCS.filter((d) => existsSync(join(ROOT, d))).map((d) => fileLines(d).join('\n')).join('\n');
const keysChecked = [];
const keyFindings = [];

function checkKey(token, origin) {
  const needle = token.replace(/^\?/, '');
  const hits = [...findReaders(needle), ...findReaders('__' + needle)];
  const consumers = hits.filter((h) => h.kind === 'consumer');
  keysChecked.push({ token, hits, consumers });
  if (consumers.length > 0) {
    if (EXPECTED_NO_READER[needle]) keyFindings.push({ kind: 'expected-absent-but-consumed', token, consumers: consumers.map((c) => c.loc), why: EXPECTED_NO_READER[needle] });
    if (DECLARATION_ONLY_KEYS[needle]) keyFindings.push({ kind: 'declaration-only-key-now-consumed', token, consumers: consumers.map((c) => c.loc), why: DECLARATION_ONLY_KEYS[needle] });
    return;
  }
  if (hits.length === 0) {
    if (EXPECTED_NO_READER[needle] || DECLARATION_ONLY_KEYS[needle]) return;
    keyFindings.push({ kind: 'key-no-reader', token, origin });
    return;
  }
  if (!EXPECTED_NO_READER[needle] && !DECLARATION_ONLY_KEYS[needle]) {
    keyFindings.push({ kind: 'key-no-consumer', token, origin, hits: hits.map((h) => h.loc + '[' + h.kind + ']') });
  }
}

const presentFlags = new Set();
const presentGlobals = new Set();
for (const m of docText.matchAll(/(^|[\s`(])\?([a-zA-Z][a-zA-Z0-9_-]*)/g)) presentFlags.add(m[2]);
for (const m of docText.matchAll(/window\.(__[A-Za-z0-9_]+)/g)) presentGlobals.add(m[1]);
for (const m of docText.matchAll(/`(__[A-Za-z0-9_]+)`/g)) presentGlobals.add(m[1]);
presentGlobals.delete('__dirname');

const needleSet = new Set();
for (const f of KNOB_FLAGS) if (presentFlags.has(f)) needleSet.add(f);
for (const g of KNOB_GLOBALS) if (presentGlobals.has(g)) needleSet.add(g.replace(/^\?/, ''));
for (const k of KNOB_KEYS) if (new RegExp('\\b' + k + '\\b').test(docText)) needleSet.add(k);
for (const sym of Object.keys(ABSENT_SYMBOLS)) if (docText.includes(sym)) needleSet.add(sym);
for (const tok of Object.keys(EXPECTED_NO_READER)) needleSet.add(tok);
for (const k of KNOB_KEYS) if (needleSet.has(k)) needleSet.add('__' + k);
buildReaderIndex([...needleSet]);
fileCache.clear();

for (const f of KNOB_FLAGS) if (presentFlags.has(f)) checkKey('?' + f, 'flag-in-doc');
for (const g of KNOB_GLOBALS) if (presentGlobals.has(g)) checkKey(g, 'global-in-doc');
for (const k of KNOB_KEYS) {
  if (!new RegExp('\\b' + k + '\\b').test(docText)) continue;
  checkKey(k, 'registry-key');
}

for (const [sym, why] of Object.entries(ABSENT_SYMBOLS)) {
  if (!docText.includes(sym)) continue;
  const hits = findReaders(sym);
  const consumers = hits.filter((h) => h.kind === 'consumer');
  keysChecked.push({ token: sym, hits, consumers });
  if (consumers.length > 0) keyFindings.push({ kind: 'documented-absent-symbol-now-consumed', token: sym, consumers: consumers.map((c) => c.loc), why });
}

const writeOnlyFindings = [];
for (const [key, file] of Object.entries(WRITE_ONLY_KEYS)) {
  const consumers = (readerIndex.get(key) || []).filter((h) => h.kind === 'consumer');
  for (const h of consumers) {
    const loc = h.loc.split(':')[0];
    const lineNo = Number(h.loc.split(':')[1]);
    const text = (fileLines(loc) || [])[lineNo - 1] || '';
    const isWrite = new RegExp(key + '\\s*=(?!=)').test(text);
    if (loc !== file || !isWrite) writeOnlyFindings.push({ kind: 'write-only-key-has-reader', key, at: h.loc, text: text.trim().slice(0, 120) });
  }
  if (consumers.length === 0) writeOnlyFindings.push({ kind: 'write-only-key-unwritten', key });
}

const FOLD_CORRECTED = {
  'TickHandler.js:30': 'citation corrected to TickHandler.js:29 (the SNAP_COST_HIGH_FRAC declaration; line 30 is SNAP_STALL_ENTER), validated by the path:line check',
  'src/shared/clusterConfig.js:8': 'line moved: JOLT_WASM_HEAP_BYTES is declared at src/shared/clusterConfig.js:9 (line 8 is CLUSTER_DEFAULT_HZ)',
  'clusterConfig.js:35': 'line dropped, symbol kept: resolveClusterConfig is still at src/shared/clusterConfig.js:35, and AGENTS.md cites path + symbol because line numbers drift',
  'clusterConfig.js:38,43,44,46,48,50': 'lines moved: ClusterConfigError is thrown at src/shared/clusterConfig.js:27,30,37',
  'Stage.js:61': 'line moved: getRelevantEntitiesHorizontal is at src/stage/Stage.js:63',
  'StageLoader.js:15': 'line moved: resolveClusterConfig is imported at src/stage/StageLoader.js:4',
  'StageLoader.js:20': 'line moved: planetRadius is at src/stage/StageLoader.js:5',
  'StageLoader.js:110': 'line moved: getRelevantEntitiesHorizontal is at src/stage/StageLoader.js:135',
  'TickHandlerAOI.js:132': 'line moved: planetRadius is at src/sdk/TickHandlerAOI.js:74',
  'src/apps/AppContext.js:387': 'line moved: defineFire is wired at src/apps/AppContext.js:11',
  'src/sdk/server.js:79': 'line moved: getRelevanceRadius is at src/sdk/server.js:80',
  'surface-splat-tsl.js:116': 'line moved: gFar is at packages/mapspinner/src/tsl/surface-splat-tsl.js:108',
  'surface-splat-tsl.js:133': 'line moved: texFarFade is at packages/mapspinner/src/tsl/surface-splat-tsl.js:73',
  'planet-tsl.js:117': 'line moved: WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS is at packages/mapspinner/src/tsl/planet-tsl.js:28',
  'planet-tsl.js:193-194': 'line moved: addUpdateRange is at packages/mapspinner/src/tsl/planet-tsl.js:180',
  'gl-render.js:619': 'line moved: __vsCheap is read at packages/mapspinner/src/gl-render.js:616',
  'gl-render.js:1444,1555': 'line moved: __halfResWater is read at packages/mapspinner/src/gl-render.js:1441',
  'QualityPresets.js:95': 'line moved: halfResWater is applied at client/core/QualityPresets.js:16',
  'worldResolve.js:33': 'line dropped, symbol kept: checkSlices is at src/shared/worldResolve.js:11 and still rejects a non-positive-finite planetRadius',
  'src/presets/tps.js:5': 'line dropped, symbol kept: relevanceRadius: 200 is still at src/presets/tps.js:5',
  'apps/world/construct.js:20': 'line dropped, symbol kept: relevanceRadius: 100 is still at apps/world/construct.js:20',
  'TerrainBackdrop.js:43': 'line dropped, symbol kept: the planet-tsl import is still at client/core/TerrainBackdrop.js:43',
  'app.js:191': 'line dropped, symbol kept: the legacygl param read is still at client/app.js:191',
  'terrain-material-tsl.js:198': 'line dropped, symbol kept: side = DoubleSide is still at terrain-material-tsl.js:198',
  'Octree.js:65': 'symbol gone: "distSq < 1.0" occurs 0 times in src/spatial/Octree.js, so no line in that file can satisfy the pin',
  'Octree.js:111': 'symbol gone: nearbyHorizontal occurs 0 times in tracked code; the horizontal-AOI claim is pinned on getRelevantEntitiesHorizontal instead',
  'Stage.js:8': 'symbol gone: src/stage/Stage.js:8 is now "export class Stage {"; the planetRadius default it pinned no longer exists',
  'config.planetRadius || 0': 'expression replaced: "config.planetRadius || 0" occurs 0 times in tracked code; the radius is now validated by checkSlices',
  'planet-tsl.js:232-270': 'span gone: the uniform-write block is no longer a single line span; the refutation it carried lives in docs/measurement-figures.md',
  'git_push {rev:"HEAD"}': 'form reworded: AGENTS.md now states the literal-sha push form "{rev:"HEAD"}"',
  'git_push {branch:...}': 'form reworded: AGENTS.md now states that the bare branch form is refused',
  'git_rm {"cached":true}': 'form reworded: AGENTS.md now writes git_rm {cached:true}',
  'scripts/gpulock.mjs run <owner> -- <node> <script>': 'arg form extended: scripts/gpulock.mjs run <owner> [--wait-ms N] [--ttl-ms N] [--lease-wait-ms N] [--no-browser] -- <cmd>, and the browser lease is claimed before the GPU lock',
  'in/<verb>/<session_id>-<random8>.txt': 'spool naming changed: the body file is now in/<verb>/<session>-<pid>-<epochms>-<rand>.txt',
  "(() => './' + 'ServerAPI' + '.js')()": 'example swapped: the opaque-import IIFE is now shown as the MinimapBake form',
  'head-vs-worktree.mjs <paths>': 'arg form dropped, name kept: "scripts/lib/": head-vs-worktree.mjs',
  'gm-dispatch.mjs <verb> [body]': 'arg form dropped, name kept: gm-dispatch.mjs <verb> <json> is the CLI form now recorded',
  'hash(seed, step, face, I, J)': 'form reworded: hash(seed,step,face,I,J) (no spaces)',
  'hash(seed, step)': 'form reworded: hash(seed,step) gust',
  'Relocation.js drive()': 'form reworded: Relocation.js and drive are both still pinned',
  'src/terrain/PlacementChart.js radialSlopeAt': 'form reworded: PlacementChart.js radialSlopeAt (path prefix dropped per the line-drift rule)',
  'CollisionSystem.js applyPlayerCollisions': 'form reworded: applyPlayerCollisions is still pinned in docs/measurement-figures.md',
  'TickHandler.js processPlayerMovement': 'form reworded: processPlayerMovement is still pinned in AGENTS.md',
  'src/apps/AppGameplay.js pickSpawnPoint': 'form reworded: AppGameplay.js pickSpawnPoint is still pinned in AGENTS.md',
  '!== false': 'code inverted: halfResWater is now read "=== true", and AGENTS.md states unset = OFF, so the old "unset means ON" claim no longer holds',
  'If(apGate.greaterThan(0.0), …)': 'form reworded: AGENTS.md now states that apGate > 0 gates sky.marchRadiance',
  '?singleplayer&legacygl=1': 'form reworded: ?legacygl=1 (needs an in-page server)',
  'localhost': 'form reworded: AGENTS.md now states "use 127.0.0.1"',
  'checkout': 'verb list dropped: the gm git autocrlf defect was fixed, so the add/status/diff/checkout/commit/stash workaround list is obsolete',
  'stash': 'verb list dropped with checkout: same gm git fix',
  '43097ece': 'CRLF example sha dropped with the example; the rule survives as "a CRLF blob shows as one whole-file rewrite in git show"',
  'submit': 'wording dropped with the delta-vs-counters sentence; the rule survives as "restore verifies against counters, never delta"',
  'classify()': 'symbol renamed: ring classification is now classifyRings (src/terrain/ColliderStreamer.js)',
  '{ok, reason, detail}': 'shape gone: the reject path now carries err.reason (src/client)',
  '+ 0': 'not a fact: Fragment of the old sentence `Height samples snap to 1 mm via + 0`. The -0 versus +0 Float32Array caveat is already restored in the Physics and Jolt section.',
  '+= -delta': 'not a fact: Fragment of the FloatingOrigin rebase claim. It is covered by the bullet restored under the FloatingOrigin.js update() token.',
  '--server-tick=<hz>': 'absent at HEAD: grep -rn -- \'--server-tick\' scripts src client returned nothing; scripts/prediction-drift-witness.mjs does not exist. Its only mentions are in docs/ and .gm/pool logs.',
  '.gm/disciplines/project/': 'not a fact: Duplicate: the current .gitignore bullet already names the memories and disciplines/project re-includes.',
  '.gm/memories/': 'not a fact: Duplicate: the current .gitignore bullet already names the memories and disciplines/project re-includes.',
  '?knob=': 'not a fact: Covered by the bullet restored under --knob=<key>=<value>[,...], which names the ?knob= form.',
  '?nograss': 'not a fact: Covered by the foliage-toggles bullet restored under ?veg=none, which names ?nograss.',
  '?norocks': 'not a fact: Covered by the foliage-toggles bullet restored under ?veg=none, which names ?norocks.',
  '?predict': 'stale at HEAD: Prediction is on by default now. Only predict=0 turns it off, so the old off-by-default caveat is inverted.',
  'AppRuntime._releaseAppContext': 'stale at HEAD: The caller rebuilds both lists before returning, so the torn-down context window the old bullet warned about is not a live hazard for hot reload.',
  'BAKE_TRANSFORMS': 'stale at HEAD: The old claim that a transform names only its narrowest reads, not its import closure, is inverted.',
  'BakeCodeVersion.js': 'stale at HEAD: The old claim that a BAKE_TRANSFORMS entry names only the narrowest reads, not the import closure, is inverted.',
  'BodyInterface.GetPosition': 'not a fact: Duplicate: the Physics and Jolt bullet on getBodyPosition already states the shared temp and the copy-before-next-call rule. The addConstraint detail is not re-proved here.',
  'Get-CimInstance Win32_Process': 'not a fact: A host-level PowerShell diagnostic and lock-removal procedure, not a repo fact. The repo-facing caveat (git_commit fails while .git/index.lock exists) is already in Working rules.',
  'InstancedMesh2': 'not a fact: Covered by the restored CullFreeze bullet, which names the vegetation InstancedMesh2 meshes. The claim that sortObjects stays false with LODs is not found for vegetation and is not restored.',
  'QualityPresets.js': 'not a fact: A shipped preset value (ssao and bloom false in client/core/QualityPresets.js), not a caveat. Read the file for current values.',
  'SNAP_COST_HIGH_FRAC': 'stale at HEAD: The constant survives with the same value, but it now drives tick-rate halving. The SnapshotGroupPlanner group formula it was budgeting no longer exists.',
  'ShadowPipeline.js forceUpdate': 'stale at HEAD: The \'sets EVERY cascade\' claim is refuted. The cascadeCount clamp to 1 when sun.castShadow is false still holds, but the bullet\'s forceUpdate claim is no longer true.',
  'SnapshotGroupPlanner': 'absent at HEAD: git grep -n -F SnapshotGroupPlanner -- src client apps packages edge scripts bin returned no output. Snapshot grouping now lives inline in src/sdk/TickHandler.js.',
  'WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS': 'not a fact: Duplicate: the constant (packages/mapspinner/src/tsl/planet-tsl.js) is named in the bullet restored under TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS.',
  '"$(cat file)"': 'not a fact: Shell-quoting usage example, not a repo fact. scripts/lib/gm-dispatch.mjs takes the body as an argv string, and the gm MCP HTTP fact is already covered in the current Working rules.',
  '_lastTodSync': 'not a fact: Duplicate: named in the bullet restored under _deliveredWorldFingerprints (client/BrowserServer.js).',
  '_modelUrls': 'not a fact: Duplicate of the _modelUrls finding above, which is restored.',
  '_revivePooledBody': 'not a fact: The pooled-body rule (type mismatch destroys and replaces; pool key model|scale) is already in the current Physics and Jolt section. _revivePooledBody still exists in src/physics/World.js, but the bullet adds nothing an agent would act on beyond that.',
  '_updateList': 'not a fact: Duplicate: named in the bullet restored under _rebuildCollisionList (src/apps/AppRuntime.js).',
  'addConstraint': 'not a fact: The shared-temp (getBodyPosition) and recycle-only-in-physics.step facts are already in the current Physics and Jolt section. addConstraint exists in src/physics/World.js, but the bullet adds no new caveat.',
  'apRad': 'not a fact: Implementation detail of the apGate gating (packages/mapspinner/src/tsl/terrain-lighting-tsl.js, If(apGate.greaterThan(0.0)); sky-tsl.js marchRadiance). The gating exists but is a description of code, not a caveat; the renderOrder caveat is restored separately.',
  'apTrans': 'not a fact: Same as apRad: a description of the apGate optimisation in terrain-lighting-tsl.js, not a caveat.',
  'app.clientMachine.send(\'TOGGLE_EDITOR\')': 'not a fact: How-to snippet. TOGGLE_EDITOR exists in client/core/ClientMachine.js and is sent in client/app.js, but the snippet is a test-driving recipe rather than a caveat.',
  'apps/tps-game/*.glb': 'absent at HEAD: ls scripts/edge-collider-draco-witness.mjs: No such file or directory; grep -rln draco scripts lists no draco witness. The 18 tracked .glb files still exist, but the script that rewrote them in place is gone.',
  'apps/world/*.hf': 'not a fact: Duplicate of the current Working rules bullet on stale bake pins and the re-bake command. scripts/bake-heightfield.mjs defaults its output to data/heightfield.json, so the apps/world path is only reached with an explicit --out.',
  'bloom': 'not a fact: A default value (ssao and bloom false in every preset in client/core/QualityPresets.js), easily re-read from the file; not a caveat an agent would act on.',
  'bufA,bufA': 'not a fact: Duplicate: the self-comparison is named in the bullet restored under authCompare.js timingSafeTokenEqual.',
  'ceil(viewers*perViewerMs/(budgetMs-fixedMs))': 'stale at HEAD: The grouping formula has been replaced.',
  'check-frame-time-baselines': 'stale at HEAD: The claimed npm run check pipeline no longer runs it.',
  'checkSlices': 'not a fact: The StageLoader and six ClusterConfigError codes caveat is already in the current Planet-wide multiplayer section. checkSlices still exists (src/shared/worldResolve.js), but the bullet adds nothing new.',
  'coversPosition': 'not a fact: Duplicate: named in the spawn-hold bullet restored under SPAWN_HOLD_MAX_MS=20000 (src/sdk/Relocation.js).',
  'discard': 'not a fact: Duplicate: the terrain.glsl discard rule is restored under _WATERPASS_. The TSL package discard count (0 across packages/mapspinner/src/tsl) is covered by the restored renderOrder bullet.',
  'distSq < 1.0': 'stale at HEAD: The skip condition is now MOVE_TOLERANCE_SQ against the stored anchor. The caveat is restored under SpatialIndex.update with the corrected symbol.',
  'document.body': 'stale at HEAD: client/AppModuleSystem.js: _appHudContainer is created (line 21) and appended to uiRoot (line 22); applyDiff targets _appHudContainer (line 130), not uiRoot and not document.body. The per-frame diff still holds but the mount point is stale.',
  'drawElementsInstanced': 'not a fact: Method detail of the live-GL debugging bullet already in the current AGENTS.md (pin file:line via addInitScript, page.evaluate for window/document access).',
  'edge-collider-draco-witness.mjs': 'absent at HEAD: find . -name edge-collider-draco-witness.mjs (excluding node_modules) returned nothing; the script does not exist at HEAD.',
  'evictOverCap': 'not a fact: evictOverCap exists in src/terrain/ColliderStreamer.js, but its farthest-first eviction is already covered by the restored collider-rings wording in the Planet-wide multiplayer section; the per-cluster quota claim was not verified.',
  'exec_js': 'absent at HEAD: The gm run_code verb list (mcp__gm__run_code description: read_file, run_shell, ..., prd_reopen) has no exec_js verb. Repo references are only in docs, vendor and work/research files.',
  'fE': 'stale at HEAD: client/core/TerrainBackdrop.js: fE is a local forward-vector scratch used to place a lookAt target (fE * 1000 added to the eye). It is not a per-vertex clip transform.',
  'fire-witness-gate.mjs': 'absent at HEAD: find returned no scripts/fire-witness-gate.mjs; scripts/check.mjs steps do not name it; it appears only in .gm/pool/pool.log and reports.',
  'getRelevanceRadius': 'stale at HEAD: src/shared/relevanceRadius.js resolveRelevanceRadius returns DEFAULT_RELEVANCE_RADIUS_M (200) when the value is absent or not positive; it does not fall back to 0. src/sdk/server.js passes ctx.currentWorldDef?.relevanceRadius through it.',
  'git hash-object --path': 'not a fact: Verification tip for the CRLF false-modified case; the CRLF bullet already in the current AGENTS.md (core.autocrlf in SYSTEM config, w/crlf in git ls-files --eol) covers the caveat.',
  'git show': 'not a fact: Example of how a CRLF blob renders in a diff, inside the CRLF caveat already restored in the current AGENTS.md; no separate fact.',
  'git_reset {paths}': 'absent at HEAD: The gm run_code verb list has no git_reset verb (git_status, git_add, git_rm, git_commit, git_push, git_log, git_diff, git_show, git_fetch, git_pull, git_checkout, git_branch only).',
  'git_reset {}': 'absent at HEAD: The gm run_code verb list has no git_reset verb; see git_reset {paths}.',
  'git_reset_head': 'absent at HEAD: The gm run_code verb list has no git_reset_head verb.',
  'gm-dispatch.mjs <verb> \'<json>\'': 'stale at HEAD: The file is now scripts/lib/gm-dispatch.mjs and its usage message reads node scripts/lib/gm-dispatch.mjs <verb> [body-json] [--cwd ...]. The shell-backslash advice was not verified, and the gm MCP section is the primary channel.',
  'halfResWater': 'stale at HEAD: packages/mapspinner/src/gl-render.js reads window.__halfResWater===true (lines ~1445 and ~1556), not !== false; the default is false in client/core/RenderControls.js and the presets set it false. The declared-false-but-read-!==-false inversion no longer exists.',
  'http://127.0.0.1:8787/mcp': 'not a fact: Duplicate: the current AGENTS.md Netcode/Working rules already state that gm MCP is HTTP on 127.0.0.1:8787/mcp and never retries.',
  'if/else': 'absent at HEAD: grep -rn uniformFlow over src, client, packages, scripts, apps and edge returned nothing; the term appears only in .gm/disciplines, docs/index.html and runs logs.',
  'if: vars.CI_GPU_RUNNER_ONLINE == \'true\'': 'not a fact: Duplicate: the current AGENTS.md CI bullet already states that frame-time needs vars.CI_GPU_RUNNER_ONLINE == \'true\' and is SKIPPED otherwise.',
  'import(\'ses\')': 'stale at HEAD: the specifier is built by the IIFE `importSes` in src/sdk/SESCompartmentEvaluator.js, so the literal is absent; the IIFE rule is stated in the Repo boundaries section',
  'intruding': 'not a fact: The kind name is part of the footprintBlockers caveat restored under that token.',
  'lang/spoint.js': 'not a fact: Scanner-triage note about benign exec surfaces; it does not change how code is edited or verified in this repo.',
  'loadChunk': 'stale at HEAD: client/core/Grass.js prewarm yields with macrotaskYield after each chunk step under a work budget (budgetMs); there is no fixed 24 ms yield cadence. The rAF-versus-macrotask rule is already in the Vegetation prewarm bullet of the current AGENTS.md.',
  'mapspinner/planet.html': 'not a fact: Scanner-triage note about benign exec surfaces; not a repo behaviour caveat.',
  'max(x, 0)': 'stale at HEAD: no `max(x, 0)` in packages/mapspinner/src/tsl/display-referred-tsl.js; the clamp claim could not be re-derived',
  'must:': 'absent at HEAD: grep -rn -F \'must:\' over src, client, apps, scripts, packages, edge and bin returned nothing; scripts/check.mjs runs witnesses from its steps array and has no pinned must regex.',
  'nearbyHorizontal': 'absent at HEAD: The symbol occurs nowhere in tracked code (scripts/lib/verify-doc-claims.mjs line 424 records it as gone). The horizontal-AOI fact is already restored in the current AGENTS.md on getRelevantEntitiesHorizontal, which exists in src/stage/Stage.js and src/sdk/TickHandlerAOI.js.',
  'npm install': 'stale at HEAD: scripts/ensure-workspace-links.mjs advises running npm install if the workspace-link failure persists, which contradicts the old never-npm-install claim. npm run links maps to node scripts/ensure-workspace-links.mjs in package.json.',
  'ok:false': 'not a fact: The ack detail is subsumed by the current --params=multiplayer and one-expect-per-measurement bullets.',
  'preStep': 'not a fact: Duplicate: the current AGENTS.md Fire bullet already states that rewindTo verifies against counters, never delta, which at a boundary rolls back the step before it.',
  'relevanceRadius': 'not a fact: Duplicate: the current \'## Planet-wide multiplayer\' bullet \'Flat AOI is HORIZONTAL (getRelevantEntitiesHorizontal, chosen when planetRadius <= 0): zero vertical slack\' already carries the caveat; the relevanceRadius rationale is not a separate fact an agent acts on.',
  'resolveClusterConfig': 'not a fact: Duplicate: the current \'## Planet-wide multiplayer\' bullet \'Clusters are OFF in every shipped world\' already states that no shipped world reaches resolveClusterConfig; the cube-sphere consequence is restored under resolvePlayerCell.',
  'scaffold.js': 'absent at HEAD: `find . -name scaffold.js -not -path \'./node_modules/*\'` returns only src/sdk/scaffold.js, not a root-level file. `grep -rn \'lang/spoint\' --include=*.mjs --include=*.js --include=*.json --include=*.yml .` (excluding node_modules) returns only a CHANGELOG.md line, so no malware-scanne',
  'shared/characterStep.js': 'not a fact: Duplicate: the current \'## Netcode and wire\' bullet \'Prediction suppresses only the blocked DIRECTION\' already names characterStep.js (the file is src/shared/characterStep.js).',
  'solveCellViewer': 'not a fact: Duplicate: the same cube-sphere caveat is restored under the resolvePlayerCell finding, which names solveCellViewer in its bullet.',
  'sortObjects': 'not a fact: a Three.js mesh property (`sortObjects = false` on batched and rock meshes); the restored CullFreeze bullet covers the LOD-level cull freeze',
  'spatial.mutations': 'not a fact: The anecdote about a filed PRD row is historical; its general rule (a reported cause is a claim until instrumented) is already in \'## Debugging discipline\'.',
  'spawnEntity': 'not a fact: Duplicate: the spawn fire-and-forget caveat is restored under the setup() finding, which names spawnEntity in its bullet.',
  'src/terrain/TerrainPhysics.js': 'not a fact: Duplicate: the current \'## Terrain and colliders\' bullet \'Baked heightfield FAIL-LOUD (`TerrainPhysics.js`)\' already states this; the path exists at src/terrain/TerrainPhysics.js.',
  'staged': 'not a fact: The CRLF rule (core.autocrlf only in SYSTEM config; w/crlf = no diff) is already in \'## Working rules\'. The rest describes a gm host tooling quirk (belongs with the orchestrator per INVARIANT 1) and a point-in-time count of 211 files, not a durable repo caveat.',
  'stepTicks': 'not a fact: Duplicate: the \'## Fire\' bullet \'A tampered keyframe is rejected at DECODE\' already states that rewindTo verifies against counters, never delta, which at a boundary rolls back the step BEFORE it; the stepTicks/takeDelta detail is internal.',
  'sun.castShadow===false': 'not a fact: Duplicate: the same cascade-clamp fact is restored under the ssao finding, whose bullet names sun.castShadow === false.',
  'takeDelta': 'not a fact: Duplicate: see the stepTicks finding; the current \'## Fire\' bullet on rewindTo versus delta covers the caveat.',
  'texFarFade > 0.001': 'not a fact: A performance estimate (\'buys 12-24 fetches\') that was not re-measured or verified here; the 0.001 gate itself is visible in packages/mapspinner/src/tsl/surface-splat-tsl.js and needs no note.',
  'uniformFlow': 'not a fact: No repo code uses uniformFlow (0 hits under src, client, scripts, apps, packages, edge). The if/else-versus-ternary behaviour is three.js ConditionalNode behaviour (node_modules/three/src/nodes/math/ConditionalNode.js) that this repo does not depend on.',
  'update()': 'stale at HEAD: Both hot-reload and detach paths now rebuild the update and collision lists after releasing the context, so update() no longer runs with a torn-down ctx on the shipped paths.',
  'updateLOD': 'not a fact: Duplicate: the satellite and 0.5 m re-evaluation caveat is restored under the first updateLOD finding.',
  'uv_async_send': 'not a fact: Duplicate: the libuv uv_async_send assert caveat is restored under the process.exit() finding, whose bullet names it.',
  'witness-audit.mjs': 'not a fact: A troubleshooting pointer list naming scripts/lib tools, not a caveat. The file exists at scripts/lib/witness-audit.mjs; the caveat that matters (--gate is not wired into check) is restored under the --gate finding.',
  'AppRuntime._attachApp': 'absent at HEAD: no `_attachApp` in src/apps/AppRuntime.js (the setup-await fact was not re-derived)',
  'apps.set': 'absent at HEAD: no `_attachApp` in src/apps/AppRuntime.js (the setup-await fact was not re-derived)',
  'setup()': 'absent at HEAD: no `_attachApp` in src/apps/AppRuntime.js (the setup-await fact was not re-derived)',
  'gen-height.mjs': 'covered by the restored bullet for `#ifdef _WATERPASS_`',
  'process.exit()': 'covered by the restored bullet for `process._getActiveHandles()`',
  'ssao': 'covered by the restored bullet for `light.shadow.needsUpdate`',
  'amend': 'not a repo fact: the gm MCP git verbs (amend, git_reset_head) are gm tooling outside this repo, not scripts or src code',
  'perf-run.mjs:277': 'line moved: perf-run.mjs:277 was the abPhaseMs pin at bd5573267fc; at HEAD the pin is at perf-run.mjs:281, which the figures cite',
};
const FOLD_NUMBER_RETIRED = {
  '211': 're-measured: AGENTS.md now states 203 files are index-LF + worktree-CRLF, so the old file count cannot be restored',
  '122': 'CRLF example compacted: the +122/-122 diff illustration was dropped with the example sha',
  '2000': 'settle-probe cadence example (40 frames per 2000 ms) compacted out of AGENTS.md',
  '301': 'perf-run.mjs line number: the abPhaseMs pin moved to 277 when the \\\\d+ escape landed, so the baseline line cannot be restored',
  '0.35': 'stale at HEAD: The constant survives with the same value, but it now drives tick-rate halving. The SnapshotGroupPlanner group-count formula it fed no longer exists.',
  '120': 'absent at HEAD: grep -rn \'terrain-reseed-failure-witness\' over the repo (excluding node_modules and .git) returned nothing; scripts/terrain-reseed-failure-witness.mjs does not exist.',
  '1500': 'not a fact: The 50 ms floor and 1500 ms ceiling of the MIGRATE-peek grace are restated in the bullet restored under the ?probe=1 token (src/sdk/ServerHandlers.js onClientConnect). Only one bullet should carry them.',
  '200': 'stale at HEAD: The old fallback claim (falls back to 0 where a world omits it) is wrong. A world that omits relevanceRadius gets 200 m, so interest management is on everywhere.',
};
const BASELINE_REV = '55cd0199';
const FOLD_FINDINGS_BASELINE = 84;
const baselineText = (() => {
  try { return execFileSync('git', ['show', BASELINE_REV + ':AGENTS.md'], { cwd: ROOT, maxBuffer: 1 << 26 }).toString('utf8'); }
  catch { return ''; }
})();
const foldUnion = DOCS.map((d) => (fileLines(d) || []).join(' ')).join(' ').replace(/\s+/g, ' ');
const foldFindings = [];
let foldTokens = 0;
let foldNumbers = 0;
const retiredSpans = [];
for (const m of baselineText.matchAll(/`([^`\n]+)`/g)) {
  const tok = m[1].trim().replace(/\s+/g, ' ');
  foldTokens++;
  if (Object.hasOwn(FOLD_CORRECTED, tok)) {
    retiredSpans.push([m.index, m.index + m[0].length]);
    continue;
  }
  if (!foldUnion.includes(tok)) foldFindings.push({ kind: 'fold-token-missing', token: tok });
}
for (const m of baselineText.matchAll(/[0-9][0-9A-Za-z.]*/g)) {
  foldNumbers++;
  const num = m[0].replace(/\.+$/, '');
  if (Object.hasOwn(FOLD_NUMBER_RETIRED, num)) continue;
  if (retiredSpans.some(([a, b]) => m.index >= a && m.index < b)) continue;
  const escaped = num.replace(/[.]/g, '\\.');
  if (!new RegExp('(^|[^0-9.])' + escaped + '(?![0-9])').test(foldUnion)) {
    foldFindings.push({ kind: 'fold-number-missing', number: num, context: baselineText.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\n/g, ' ') });
  }
}
console.log('fold tokens checked (backticked, vs ' + BASELINE_REV + ' AGENTS.md): ' + foldTokens);
console.log('fold numbers checked: ' + foldNumbers);
console.log('fold findings: ' + foldFindings.length);
console.log('fold drift gate: ' + foldFindings.length + ' vs baseline ' + FOLD_FINDINGS_BASELINE + ' at ' + BASELINE_REV + ' -> ' + (foldFindings.length > FOLD_FINDINGS_BASELINE ? 'REGRESSION' : 'accepted'));
console.log('write-only key findings: ' + writeOnlyFindings.length);
const PROVENANCE_TAGS = ['LANDED', 'DERIVED', 'STRUCK', 'REFUTED', 'UNSOURCED'];
const PROVENANCE_SRC = '\\[(' + PROVENANCE_TAGS.join('|') + ')\\]';
const FIGURE_SLOT_SRC = '\\[(STAT|INSTR|ADAPTER|RES|W):';
const LIFECYCLE_SRC = '\\[(PLANNED|UNBUILT|AWAITING-RE-DERIVATION|INVALIDATED)\\]';

const TOP_BULLET = '- ';
const SUB_BULLET_SRC = /^\s+- /;
const HEADING_SRC = /^## /;

function parseDocRow(text, section, isOpenQuestion, seenHeading, enclosingProvenance) {
  const provenanceTags = [...text.matchAll(new RegExp(PROVENANCE_SRC, 'g'))].map((m) => m[1]);
  const slots = [...text.matchAll(new RegExp(FIGURE_SLOT_SRC, 'g'))].map((m) => m[1]);
  const modifiers = [...text.matchAll(new RegExp(LIFECYCLE_SRC, 'g'))].map((m) => m[1]);
  const bullet = text.startsWith(TOP_BULLET);
  const subBullet = !bullet && SUB_BULLET_SRC.test(text);
  const quotesNumber = /[0-9]/.test(text);
  const declaresFigure = provenanceTags.length > 0 || (bullet && quotesNumber && slots.length > 0);
  const shape = !seenHeading ? 'preamble'
    : HEADING_SRC.test(text) ? 'heading'
    : text.trim() === '' ? 'blank'
    : subBullet ? 'sub-bullet'
    : isOpenQuestion ? 'open-question'
    : declaresFigure ? 'figure'
    : 'prose';
  const rejected = shape === 'figure' && provenanceTags.length !== 1;
  const provenance = shape === 'figure' ? (provenanceTags.length === 1 ? provenanceTags[0] : null)
    : shape === 'sub-bullet' ? enclosingProvenance
    : null;
  const reason = rejected ? (provenanceTags.length === 0 ? 'provenance-missing' : 'provenance-multiple')
    : shape === 'figure' ? 'carries exactly one provenance tag, so the row is a figure'
    : shape === 'sub-bullet' ? 'indented sub-bullet, inherits the enclosing provenance and carries no tag of its own'
    : shape === 'open-question' ? 'section 13 records open questions, not figures'
    : shape === 'preamble' ? 'stands before the first section heading'
    : shape === 'heading' ? 'section heading'
    : shape === 'blank' ? 'empty line'
    : slots.length > 0 ? 'carries a figure slot but no provenance tag, so it is prose, not a figure'
    : quotesNumber ? 'quotes a number with no slot and no provenance, so it is prose, not a figure'
    : 'quotes no number and carries no slot or provenance tag, so it is prose';
  return {
    text, section, shape, verdict: rejected ? 'rejected' : 'accepted',
    bullet, subBullet, quotesNumber, slots, modifiers, provenanceTags,
    provenanceCount: provenanceTags.length, provenance, reason,
  };
}

const docRows = [];
{
  let seenHeading = false;
  let section = '';
  let isOpenQuestion = false;
  let enclosingProvenance = null;
  (fileLines('docs/measurement-figures.md') || []).forEach((line, idx) => {
    if (line.startsWith('## ')) {
      seenHeading = true;
      section = line.slice(3).trim();
      isOpenQuestion = /^## 13\. /.test(line);
      enclosingProvenance = null;
    }
    const row = parseDocRow(line, section, isOpenQuestion, seenHeading, enclosingProvenance);
    row.at = 'docs/measurement-figures.md:' + (idx + 1);
    if (row.bullet) enclosingProvenance = row.provenance;
    docRows.push(row);
  });
}

const figureRows = docRows.filter((r) => r.shape === 'figure');
const acceptedRows = docRows.filter((r) => r.verdict === 'accepted');
const rejectedRows = docRows.filter((r) => r.verdict === 'rejected');
const undecidedRows = docRows.filter((r) => r.verdict !== 'accepted' && r.verdict !== 'rejected');
const provenanceFindings = rejectedRows.map((r) => ({ kind: r.reason, at: r.at, tags: r.provenanceTags, text: r.text.trim().slice(0, 120) }));
for (const row of undecidedRows) provenanceFindings.push({ kind: 'row-shape-undecided', at: row.at, shape: row.shape, text: row.text.trim().slice(0, 120) });
const lineNumbers = (rows) => rows.map((r) => r.at.split(':')[1]).join(' ') || 'none';
const shapeTally = [...new Set(docRows.map((r) => r.shape))].sort().map((s) => s + ' ' + docRows.filter((r) => r.shape === s).length).join(', ');
const provenanceTally = PROVENANCE_TAGS.map((t) => t + ' ' + figureRows.filter((r) => r.provenance === t).length).join(', ');
console.log('provenance figure rows checked: ' + figureRows.length + ' (' + provenanceTally + ')');
console.log('doc rows parsed: ' + docRows.length + ' -> accepted ' + acceptedRows.length + ', rejected ' + rejectedRows.length + ', undecided ' + undecidedRows.length);
console.log('row shapes: ' + shapeTally);
console.log('figure rows admitted on provenance alone (quotes no number): ' + lineNumbers(figureRows.filter((r) => !r.quotesNumber)));
console.log('sub-bullets inheriting an enclosing provenance: ' + lineNumbers(docRows.filter((r) => r.shape === 'sub-bullet' && r.provenance !== null)));
for (const row of docRows.filter((r) => r.shape === 'prose' && (r.quotesNumber || r.slots.length > 0))) console.log('  prose ' + row.at.split(':')[1] + ': ' + row.reason);
console.log('provenance findings (figure row without exactly one provenance tag): ' + provenanceFindings.length);
const p50Findings = [];
let p50InvalidatedCount = 0;
let p50StruckCount = 0;
for (const row of docRows) {
  if (!/p50/.test(row.text)) continue;
  if (row.section.startsWith('0.')) { p50InvalidatedCount++; continue; }
  if (row.provenance === 'STRUCK' || row.provenance === 'REFUTED') { p50StruckCount++; continue; }
  p50Findings.push({ kind: 'p50-figure-not-invalidated', at: row.at, text: row.text.trim().slice(0, 120) });
}
(fileLines('AGENTS.md') || []).forEach((line, idx) => {
  if (!/p50/.test(line)) return;
  if (/INVALID/.test(line)) { p50InvalidatedCount++; return; }
  p50Findings.push({ kind: 'p50-in-rules-not-invalid', at: 'AGENTS.md:' + (idx + 1), text: line.trim().slice(0, 120) });
});
console.log('p50 citations invalidated (section 0 or AGENTS INVALID rules): ' + p50InvalidatedCount);
console.log('p50 citations struck or refuted (outside section 0): ' + p50StruckCount);
console.log('p50 findings (figure cites p50 without INVALIDATED or STRUCK/REFUTED): ' + p50Findings.length);
const DEFAULT_CLAIM_KEYS = ['dprAuto'];
const DEFAULT_RULE_DOCS = [process.env.VERIFY_DEFAULT_RULE_DOC || 'docs/measurement-figures.md', 'AGENTS.md'];
const defaultValueFindings = [];
let defaultClaimLines = 0;
for (const key of DEFAULT_CLAIM_KEYS) {
  const declLine = (fileLines('client/core/RenderControls.js') || []).find((l) => l.includes(`key: '${key}'`)) || '';
  const declared = (declLine.match(/default: (\w+)/) || [])[1];
  if (!declared) { defaultValueFindings.push({ kind: 'default-decl-unparsed', key, at: 'client/core/RenderControls.js' }); continue; }
  for (const doc of DEFAULT_RULE_DOCS) {
    const docPath = isAbsolute(doc) ? doc : join(ROOT, doc);
    if (!existsSync(docPath)) { defaultValueFindings.push({ kind: 'default-rule-doc-missing', doc }); continue; }
    readFileSync(docPath, 'utf8').split('\n').forEach((line, idx) => {
      const claim = line.match(/REGISTRY DEFAULT (TRUE|FALSE)/);
      if (!claim || !line.includes(key)) return;
      defaultClaimLines++;
      if (claim[1].toLowerCase() !== declared) defaultValueFindings.push({ kind: 'default-claim-mismatch', key, claimed: claim[1].toLowerCase(), declared, at: doc + ':' + (idx + 1) });
    });
  }
}
console.log('default-value claims checked: ' + defaultClaimLines);
const foldRegression = foldFindings.length > FOLD_FINDINGS_BASELINE;
const allClear = findings.length === 0 && keyFindings.length === 0 && writeOnlyFindings.length === 0 && p50Findings.length === 0 && provenanceFindings.length === 0 && defaultValueFindings.length === 0 && !foldRegression;
console.log('RESULT: ' + (allClear ? 'PASS' : 'FAIL'));
console.log('paths checked: ' + pathsChecked + ' (+' + dirsChecked + ' directories)');
console.log('path:line claims checked: ' + linesChecked + ' (symbol ' + linesSymbolAsserted + ', derived ' + linesDerived + ', existence-only ' + linesExistenceOnly + ', symbol-absent ' + linesSymbolAbsent + ')');
console.log('shas checked: ' + shasChecked + ' -> ' + [...shaClaims.keys()].join(' '));
console.log('keys checked: ' + keysChecked.length);
for (const k of keysChecked) console.log('  ' + k.token + ' [' + k.consumers.length + ' consumer] ' + (k.hits.length ? k.hits.map((h) => h.loc + '(' + h.kind + ')').join(' ') : 'NONE'));
if (findings.length) { console.log('--- path findings ---'); for (const f of findings) console.log(JSON.stringify(f)); }
if (keyFindings.length) { console.log('--- key findings ---'); for (const f of keyFindings) console.log(JSON.stringify(f)); }
if (foldFindings.length) { console.log('--- fold findings ---'); for (const f of foldFindings) console.log(JSON.stringify(f)); }
if (writeOnlyFindings.length) { console.log('--- write-only findings ---'); for (const f of writeOnlyFindings) console.log(JSON.stringify(f)); }
if (p50Findings.length) { console.log('--- p50 findings ---'); for (const f of p50Findings) console.log(JSON.stringify(f)); }
if (defaultValueFindings.length) { console.log('--- default-value findings ---'); for (const f of defaultValueFindings) console.log(JSON.stringify(f)); }
if (provenanceFindings.length) { console.log('--- provenance findings ---'); for (const f of provenanceFindings) console.log(JSON.stringify(f)); }
process.exit(allClear ? 0 : 1);
