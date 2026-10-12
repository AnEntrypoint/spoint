import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

const WITNESS = 'webgpu-hiz-shaders';
const ROW = 'witness-gap-webgpu-hiz-shaders';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_MODULE = path.join(REPO_ROOT, 'packages', 'streaming-gltf', 'src', 'webgpu-hiz-shaders.js');
const CPU_PARSER_MODULE = path.join(REPO_ROOT, 'packages', 'streaming-gltf', 'src', 'meshlet-codec.js');
const OUT_DIR = path.join(REPO_ROOT, '.gm', 'witness-out');
const LOG_PATH = path.join(REPO_ROOT, '.gm', 'witness-log.md');
const LABEL = argValue('label') ?? 'honest-tree';
const SESSION = argValue('session') ?? 'unset';
const LOD0_INDEX_COUNT = 100;

const SHADER_CONTRACTS = {
  HZB_REDUCE_WGSL: { workgroup: [8, 8, 1], bindings: ['0:srcTex', '1:dstTex', '2:params'] },
  HZB_SEED_WGSL: { workgroup: [8, 8, 1], bindings: ['0:srcDepth', '1:dstTex'] },
  CULL_LOD_WGSL: { workgroup: [64, 1, 1], bindings: ['0:clusters', '1:frame', '2:indirectArgs', '3:drawCount', '4:hzbTex', '6:lodState', '7:frustumVisible'] },
};

const EXPORT_TYPES = {
  HZB_REDUCE_WGSL: 'string',
  HZB_SEED_WGSL: 'string',
  CULL_LOD_WGSL: 'string',
  CLUSTER_STRIDE_BYTES: 'number',
  INDIRECT_STRIDE_BYTES: 'number',
  MAX_LOD_SLOTS: 'number',
  flattenClusters: 'function',
};

const CLUSTER_FIELD_ORDER = ['aabbMin', 'pad0', 'aabbMax', 'pad1', 'sphereCenter', 'sphereRadius', 'lod0Offset', 'lod0Count', 'lod1Offset', 'lod1Count', 'lod2Offset', 'lod2Count', 'lodCount', 'pad2'];
const INDIRECT_TYPE_ORDER = ['atomic<u32>', 'u32', 'u32', 'i32', 'u32'];
const WGSL_LAYOUT = {
  f32: [4, 4],
  u32: [4, 4],
  i32: [4, 4],
  'atomic<u32>': [4, 4],
  'vec2<f32>': [8, 8],
  'vec3<f32>': [12, 16],
  'vec4<f32>': [16, 16],
};

const FORBIDDEN_SOURCE_TOKENS = /\b(window|document|navigator|WebGL\w*|WebGPU|GPUDevice|GPUAdapter|WebSocket|Worker|requestAdapter|createShaderModule)\b|\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(/g;
const DEPENDENCY_STATEMENT = /^\s*import\b|^\s*export\s*\*\s*from\b|^\s*export\s*\{[^}]*\}\s*from\b/m;

const DIRECT_CLUSTER_SET = {
  clusters: [
    { aabb: [-1, -2, -3, 4, 5, 6], sphere: [0.5, 0.25, 0.125, 7], lods: [{ offset: 10, count: 3, stream: 0 }, { offset: 2, count: 5, stream: 1 }] },
    { aabb: [0, 0, 0, 1, 1, 1], sphere: [0.5, 0.5, 0.5, 0.75], lods: [{ offset: 0, count: 9, stream: 0 }] },
  ],
};

const EP_CLUSTER_LOD_EXTRAS = {
  EP_cluster_lod: {
    version: 2,
    clusterCount: 2,
    lodCount: 2,
    coarseIndexAccessor: 1,
    coarseIndexCount: 5,
    clusters: [
      { aabb: [-1, -2, -3, 4, 5, 6], sphere: [0.5, 0.25, 0.125, 7], lods: [[10, 3, 0], [2, 5, 1]] },
      { aabb: [0, 0, 0, 1, 1, 1], sphere: [0.5, 0.5, 0.5, 0.75], lods: [[0, 9, 0]] },
    ],
  },
};

const results = [];

function record(id, pass, detail) {
  results.push({ id, pass: pass === true, detail: String(detail).replace(/\s+/g, ' ').slice(0, 480) });
}

function guard(id, probe) {
  try {
    const outcome = probe();
    record(id, outcome.pass, outcome.detail);
  } catch (error) {
    record(id, false, `threw ${error.message}`);
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function structFields(source, structName) {
  const block = source.match(new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\};`));
  if (!block) throw new Error(`struct ${structName} not found`);
  return [...block[1].matchAll(/(\w+)\s*:\s*(vec[234]<\w+>|atomic<\w+>|\w+)\s*,?/g)].map((hit) => ({ name: hit[1], type: hit[2] }));
}

function wgslLayout(fields) {
  const offsets = {};
  let offset = 0;
  let maxAlign = 1;
  for (const field of fields) {
    const entry = WGSL_LAYOUT[field.type];
    if (!entry) throw new Error(`unsupported WGSL type ${field.type} on ${field.name}`);
    const [size, align] = entry;
    offset = Math.ceil(offset / align) * align;
    offsets[field.name] = offset;
    offset += size;
    maxAlign = Math.max(maxAlign, align);
  }
  return {
    size: Math.ceil(offset / maxAlign) * maxAlign,
    offsets,
    names: fields.map((field) => field.name),
    types: fields.map((field) => field.type),
  };
}

function lodSlotCountOf(layout) {
  return layout.names.filter((name) => /^lod\d+Offset$/.test(name)).length;
}

function elementTypeOf(type) {
  return type.startsWith('vec') ? 'f32' : type;
}

function readScalar(view, at, type) {
  if (type === 'f32') return view.getFloat32(at, true);
  if (type === 'i32') return view.getInt32(at, true);
  return view.getUint32(at, true);
}

function expectedClusterRecord(cluster, lodSlotCount) {
  const slot = (s) => cluster.lods[Math.min(s, cluster.lods.length - 1)];
  const absoluteOffset = (lod) => (lod.stream === 1 ? LOD0_INDEX_COUNT : 0) + lod.offset;
  const expected = {
    aabbMin: cluster.aabb.slice(0, 3),
    pad0: [0],
    aabbMax: cluster.aabb.slice(3, 6),
    pad1: [0],
    sphereCenter: cluster.sphere.slice(0, 3),
    sphereRadius: [cluster.sphere[3]],
    lodCount: [Math.min(cluster.lods.length, lodSlotCount)],
    pad2: [0],
  };
  for (let s = 0; s < lodSlotCount; s += 1) {
    expected[`lod${s}Offset`] = [absoluteOffset(slot(s))];
    expected[`lod${s}Count`] = [slot(s).count];
  }
  return expected;
}

function packedMismatches(buffer, clusters, layout, lodSlotCount) {
  const view = new DataView(buffer);
  const mismatches = [];
  clusters.forEach((cluster, index) => {
    const expected = expectedClusterRecord(cluster, lodSlotCount);
    layout.names.forEach((name, fieldIndex) => {
      const type = elementTypeOf(layout.types[fieldIndex]);
      expected[name].forEach((want, k) => {
        const at = index * layout.size + layout.offsets[name] + 4 * k;
        const got = readScalar(view, at, type);
        if (!Object.is(got, want)) mismatches.push(`c${index}.${name}[${k}]@${at} want ${want} got ${got}`);
      });
    });
  });
  return mismatches;
}

async function run() {
  const requested = argValue('module');
  const modulePath = requested === null ? DEFAULT_MODULE : path.resolve(requested);
  if (!existsSync(modulePath)) {
    record('C00-module-present', false, `no file at ${modulePath}`);
    return { modulePath, moduleSha: 'absent' };
  }
  const bytes = readFileSync(modulePath);
  const source = bytes.toString('utf8');
  const moduleSha = sha256Hex(bytes);
  record('C00-module-present', true, modulePath);

  const forbidden = [...new Set(source.match(FORBIDDEN_SOURCE_TOKENS) ?? [])];
  record('C09-no-browser-or-gpu-api', forbidden.length === 0, forbidden.length === 0 ? '0 hits in module source' : `hits ${forbidden.join(' ')}`);
  const hasDependencies = DEPENDENCY_STATEMENT.test(source);
  record('C10-dependency-free', !hasDependencies, hasDependencies ? 'import or re-export statement present' : 'no import or re-export statement');

  let mod = null;
  if (forbidden.length === 0 && !hasDependencies) {
    try {
      mod = await import(pathToFileURL(modulePath).href);
      record('C01-module-loads', true, 'imported under node with no globals');
    } catch (error) {
      record('C01-module-loads', false, `import threw ${error.message}`);
    }
  } else {
    record('C01-module-loads', false, 'not executed: source gate failed');
  }

  let parser = null;
  try {
    parser = await import(pathToFileURL(CPU_PARSER_MODULE).href);
    record('C11-cpu-parser-loads', true, 'meshlet-codec.js imported under node');
  } catch (error) {
    record('C11-cpu-parser-loads', false, `import threw ${error.message}`);
  }

  const withModule = (probe) => () => (mod === null ? { pass: false, detail: 'not executed: module not loaded' } : probe(mod));

  guard('C02-exports-typed', withModule((m) => {
    const bad = Object.entries(EXPORT_TYPES).filter(([name, type]) => typeof m[name] !== type).map(([name, type]) => `${name} not ${type}`);
    return { pass: bad.length === 0, detail: bad.length === 0 ? `${Object.keys(EXPORT_TYPES).length} exports typed as contracted` : bad.join('; ') };
  }));

  guard('C03-entry-points-and-workgroups', withModule((m) => {
    const problems = [];
    for (const [name, contract] of Object.entries(SHADER_CONTRACTS)) {
      const mainCount = (m[name].match(/fn\s+main\s*\(/g) ?? []).length;
      const head = m[name].match(/@compute\s+@workgroup_size\((\d+),\s*(\d+),\s*(\d+)\)\s*fn\s+main\s*\(/);
      if (mainCount !== 1 || head === null) {
        problems.push(`${name} entry point missing or duplicated`);
        continue;
      }
      const size = head.slice(1).map(Number);
      if (size.join(',') !== contract.workgroup.join(',')) problems.push(`${name} workgroup ${size.join('x')}`);
    }
    return { pass: problems.length === 0, detail: problems.length === 0 ? 'one @compute main per shader with contracted workgroup size' : problems.join('; ') };
  }));

  guard('C04-bindings-declared', withModule((m) => {
    const problems = [];
    for (const [name, contract] of Object.entries(SHADER_CONTRACTS)) {
      const found = [...m[name].matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+(\w+)\s*:/g)]
        .filter((hit) => hit[1] === '0')
        .map((hit) => `${hit[2]}:${hit[3]}`);
      if (found.join(' ') !== contract.bindings.join(' ')) problems.push(`${name} group0 [${found.join(' ')}]`);
    }
    return { pass: problems.length === 0, detail: problems.length === 0 ? 'group 0 bindings match contract for every shader' : problems.join('; ') };
  }));

  guard('C05-delimiters-balanced', withModule((m) => {
    const unbalanced = Object.keys(SHADER_CONTRACTS).filter((name) => ['{}', '()', '[]'].some(([open, close]) => m[name].split(open).length !== m[name].split(close).length));
    return { pass: unbalanced.length === 0, detail: unbalanced.length === 0 ? 'braces, parentheses and brackets balanced' : `unbalanced ${unbalanced.join(' ')}` };
  }));

  guard('C06-strides-match-wgsl-layout', withModule((m) => {
    const cluster = wgslLayout(structFields(m.CULL_LOD_WGSL, 'Cluster'));
    const indirect = wgslLayout(structFields(m.CULL_LOD_WGSL, 'IndirectArgs'));
    const lodSlots = lodSlotCountOf(cluster);
    const pass = m.CLUSTER_STRIDE_BYTES === cluster.size && m.INDIRECT_STRIDE_BYTES === indirect.size && m.MAX_LOD_SLOTS === lodSlots;
    return { pass, detail: `cluster ${m.CLUSTER_STRIDE_BYTES} vs wgsl ${cluster.size}; indirect ${m.INDIRECT_STRIDE_BYTES} vs wgsl ${indirect.size}; lodSlots ${m.MAX_LOD_SLOTS} vs wgsl ${lodSlots}` };
  }));

  guard('C07-wgsl-field-order', withModule((m) => {
    const cluster = wgslLayout(structFields(m.CULL_LOD_WGSL, 'Cluster'));
    const indirect = wgslLayout(structFields(m.CULL_LOD_WGSL, 'IndirectArgs'));
    const clusterOk = cluster.names.join(',') === CLUSTER_FIELD_ORDER.join(',');
    const indirectOk = indirect.types.join(',') === INDIRECT_TYPE_ORDER.join(',');
    return { pass: clusterOk && indirectOk, detail: `Cluster field order ${clusterOk ? 'matches' : 'drifted'}; IndirectArgs types ${indirectOk ? 'match' : 'drifted'}` };
  }));

  guard('C08-packer-direct-matches-wgsl-layout', withModule((m) => {
    const cluster = wgslLayout(structFields(m.CULL_LOD_WGSL, 'Cluster'));
    const buffer = m.flattenClusters(DIRECT_CLUSTER_SET, LOD0_INDEX_COUNT);
    if (!(buffer instanceof ArrayBuffer)) return { pass: false, detail: 'flattenClusters did not return an ArrayBuffer' };
    const wantBytes = DIRECT_CLUSTER_SET.clusters.length * cluster.size;
    if (buffer.byteLength !== wantBytes) return { pass: false, detail: `byteLength ${buffer.byteLength} want ${wantBytes}` };
    const mismatches = packedMismatches(buffer, DIRECT_CLUSTER_SET.clusters, cluster, lodSlotCountOf(cluster));
    return { pass: mismatches.length === 0, detail: mismatches.length === 0 ? `${DIRECT_CLUSTER_SET.clusters.length} clusters read back at WGSL offsets` : mismatches.slice(0, 6).join('; ') };
  }));

  guard('C12-parser-to-packer-matches-wgsl-layout', withModule((m) => {
    if (parser === null) return { pass: false, detail: 'CPU parser not loaded' };
    const parsed = parser.parseClusterLod(EP_CLUSTER_LOD_EXTRAS);
    if (parsed === null) return { pass: false, detail: 'parseClusterLod rejected the documented EP_cluster_lod fixture' };
    const cluster = wgslLayout(structFields(m.CULL_LOD_WGSL, 'Cluster'));
    const buffer = m.flattenClusters(parsed, LOD0_INDEX_COUNT);
    if (!(buffer instanceof ArrayBuffer)) return { pass: false, detail: 'flattenClusters did not return an ArrayBuffer' };
    const wantBytes = parsed.clusters.length * cluster.size;
    if (buffer.byteLength !== wantBytes) return { pass: false, detail: `byteLength ${buffer.byteLength} want ${wantBytes}` };
    const mismatches = packedMismatches(buffer, parsed.clusters, cluster, lodSlotCountOf(cluster));
    return { pass: mismatches.length === 0, detail: mismatches.length === 0 ? `${parsed.clusters.length} parsed clusters packed and read back at WGSL offsets` : mismatches.slice(0, 6).join('; ') };
  }));

  return { modulePath, moduleSha };
}

async function main() {
  let context = { modulePath: DEFAULT_MODULE, moduleSha: 'unknown' };
  try {
    context = await run();
  } catch (error) {
    record('C99-unexpected-error', false, error.message);
  }
  const failed = results.filter((entry) => !entry.pass);
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  const exitCode = verdict === 'PASS' ? 0 : 1;
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tally = verdict === 'PASS'
    ? `${results.length} of ${results.length} checks passed`
    : `${failed.length} of ${results.length} checks failed`;
  const resultLine = `RESULT: ${verdict} -- ${tally} module_sha256=${context.moduleSha}`;
  const checkLines = results.map((entry) => `CHECK ${entry.id} ${entry.pass ? 'PASS' : 'FAIL'} ${entry.detail}`);
  const body = [
    `witness: ${WITNESS}`,
    `row: ${ROW}`,
    `label: ${LABEL}`,
    `module: ${context.modulePath}`,
    `module_sha256: ${context.moduleSha}`,
    `ts: ${ts}`,
    ...checkLines,
    resultLine,
    '',
  ].join('\n');
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = ts.replace(/[-:]/g, '');
  const outPath = path.join(OUT_DIR, `${WITNESS}-${LABEL}-${stamp}-${randomBytes(4).toString('hex')}.txt`);
  writeFileSync(outPath, body, { encoding: 'utf8', flag: 'wx' });
  const outSha = sha256Hex(Buffer.from(body, 'utf8'));
  const outRel = path.relative(REPO_ROOT, outPath).split(path.sep).join('/');
  appendFileSync(LOG_PATH, `${ts} ${WITNESS} label=${LABEL} exit=${exitCode} ${resultLine} sha256=${outSha} out=${outRel} module_sha256=${context.moduleSha} session=${SESSION} row=${ROW}\n`, 'utf8');
  for (const line of checkLines) console.log(line);
  console.log(resultLine);
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.log(`RESULT: FAIL -- witness aborted: ${String(error.message).replace(/\s+/g, ' ')}`);
  process.exitCode = 1;
});
