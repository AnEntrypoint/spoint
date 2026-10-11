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
  'src/spatial/Octree.js#65': '< 1.0',
  'src/spatial/Octree.js#111': 'nearbyHorizontal',
  'src/shared/clusterConfig.js#8': 'JOLT_WASM_HEAP_BYTES',
  'src/shared/clusterConfig.js#35': 'return null',
  'src/shared/clusterConfig.js#38,43,44,46,48,50': 'ClusterConfigError',
  'src/stage/Stage.js#13': 'planetRadiusMeters',
  'src/stage/Stage.js#61': 'getRelevantEntitiesHorizontal',
  'src/stage/StageLoader.js#15': 'resolveClusterConfig',
  'src/stage/StageLoader.js#21': 'planetRadius',
  'src/stage/StageLoader.js#110': 'getRelevantEntitiesHorizontal',
  'src/sdk/TickHandlerAOI.js#136': 'planetRadius',
  'src/shared/worldResolve.js#33': 'planetRadius',
  'src/apps/AppContext.js#387': 'defineFire',
  'packages/mapspinner/src/tsl/sky-tsl.js#89': 'marchRadiance',
  'packages/mapspinner/src/tsl/surface-splat-tsl.js#116': 'gFar',
  'packages/mapspinner/src/tsl/surface-splat-tsl.js#133': 'texFarFade',
  'packages/mapspinner/src/tsl/planet-tsl.js#117': 'castShadow',
  'packages/mapspinner/src/tsl/planet-tsl.js#193': 'addUpdateRange',
  'packages/mapspinner/src/tsl/planet-tsl.js#232-270': 'function frame',
  'packages/mapspinner/src/tsl/planet-tsl.js#260': 'fsCheap',
  'packages/mapspinner/src/tsl/terrain-material-tsl.js#195': 'outputNode',
  'packages/mapspinner/src/tsl/terrain-material-tsl.js#198': 'DoubleSide',
  'client/app.js#190': 'legacygl',
  'client/app.js#191': '_runsInPageServer',
  'client/core/TerrainBackdrop.js#43': 'planet-tsl',
  'client/core/TerrainBackdrop.js#46-47': 'planet-orchestrator',
  'client/core/Weather.js#168': 'SNOW_GROUND_RESAMPLE_DRIFT_M',
  'packages/mapspinner/src/gl-render.js#619': '__vsCheap',
  'packages/mapspinner/src/gl-render.js#1256': '__fsCheap',
  'packages/mapspinner/src/gl-render.js#1444': '__halfResWater',
  'packages/mapspinner/src/gl-render.js#1444,1555': '__halfResWater',
  'client/core/QualityPresets.js#95': 'halfResWater',
  'packages/mapspinner/src/terrain-gen-controls.js#45': 'elevEdgeInset',
  'packages/mapspinner/src/terrain-gen-controls.js#86': 'elevEdgeInset',
  'src/sdk/TickHandler.js#29': 'SNAP_COST_HIGH_FRAC',
  'src/presets/tps.js#5': 'relevanceRadius',
  'apps/world/construct.js#20': 'relevanceRadius',
  'src/sdk/server.js#79': 'getRelevanceRadius',
  'scripts/frame-time-gate.mjs#36': 'UNLOCK_RAF',
  'scripts/perf-run.mjs#301': 'abPhaseMs',
  'scripts/lib/gpu-eval.mjs#102': 'probeHeights',
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
for (const m of baselineText.matchAll(/`([^`\n]+)`/g)) {
  const tok = m[1].trim().replace(/\s+/g, ' ');
  foldTokens++;
  if (!Object.hasOwn(FOLD_CORRECTED, tok) && !foldUnion.includes(tok)) foldFindings.push({ kind: 'fold-token-missing', token: tok });
}
for (const m of baselineText.matchAll(/[0-9][0-9A-Za-z.]*/g)) {
  foldNumbers++;
  const num = m[0].replace(/\.+$/, '');
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
      isOpenQuestion = /^## .*Open questions/.test(line);
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
