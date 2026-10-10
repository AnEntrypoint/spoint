// Witness for packages/spoint-core/src/lib.rs: drives every #[wasm_bindgen] export of the
// module through a generated host harness (cargo + rustc required) and compares each answer
// against an independent JS formulation of the same math.
//
// Not listed in scripts/check.mjs: that arm runs on a runner with no pinned Rust toolchain.
// Run it where cargo exists:  node scripts/SpointCoreLib-witness.mjs
// A missing cargo is reported as RESULT: FAIL, never as a skipped measurement.
// Mutation mode (--mutant=<name>) copies the module into scratch, mutates the COPY and drives
// that; the tracked module is never written.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WITNESS = 'scripts/SpointCoreLib-witness.mjs';
const DEFAULT_MODULE = resolve(REPO, 'packages/spoint-core/src/lib.rs');
const FLAG_DEFAULTS = { module: null, mutant: 'none', out: null, log: null, run: 'adhoc', row: '-', session: '-' };

const QSCALE = 511 * Math.SQRT2;
const STEP = 1 / QSCALE;
const FNV_PRIME = 16777619;
const FNV_OFFSET = 0x811c9dc5;
const UNIT_QUATS = 512;
const PACKED_WORDS = 256;
const BYTE_STRINGS = 256;
const STRINGS = 128;
const FOLDS = 256;
const MUL_PAIRS = 256;
const ROT_PAIRS = 256;
const MIN_CALLS = 64;

// Each mutation targets one export; the mutated text is written to scratch only.
const MUTANTS = {
  'fnv1a-prime': ['const FNV_PRIME: u32 = 16777619;', 'const FNV_PRIME: u32 = 16777621;'],
  'fnv1a-offset': ['const FNV_OFFSET: u32 = 0x811c9dc5;', 'const FNV_OFFSET: u32 = 0x811c9dc6;'],
  'fnv1a-fold-zero': [
    'let v = if n == 0.0 { 0.0_f64 } else if n.is_nan() { f64::NAN } else { n };',
    'let v = if false { 0.0_f64 } else if n.is_nan() { f64::NAN } else { n };',
  ],
  'fnv1a-str-empty': ['fnv1a_32(s.as_bytes())', 'fnv1a_32(&[])'],
  'pack-scale': ['const QSCALE: f64 = 511.0 * std::f64::consts::SQRT_2;', 'const QSCALE: f64 = 512.0 * std::f64::consts::SQRT_2;'],
  'pack-sign': ['let sign = if max_val < 0.0 { -1.0 } else { 1.0 };', 'let sign = 1.0;'],
  'pack-argmax': ['let (max_idx, max_val) = if ary > arx {', 'let (max_idx, max_val) = if arx > ary {'],
  'unpack-indices': ['[[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]]', '[[1, 2, 3], [0, 2, 3], [0, 1, 3], [2, 1, 0]]'],
  'mul-sign': ['aw * bx + ax * bw + ay * bz - az * by,', 'aw * bx + ax * bw + ay * bz + az * by,'],
  'rot-sign': ['let iy = qw * vy + qz * vx - qx * vz;', 'let iy = qw * vy + qz * vx + qx * vz;'],
};

const lines = [];
const failures = [];
let measurements = 0;

const report = (line) => {
  lines.push(line);
  console.log(line);
};
const errorText = (err) => String(err && err.message ? err.message : err).split(/\r?\n/)[0];
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const utcStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const displayPath = (path) => (path.startsWith(REPO + sep) ? relative(REPO, path) : path).split(sep).join('/');
const shown = (value) => (value === undefined ? 'undefined' : JSON.stringify(value));

const claim = (name, check) => {
  measurements++;
  let verdict;
  try {
    verdict = check();
  } catch (err) {
    verdict = `threw ${errorText(err)}`;
  }
  if (verdict === true) {
    report(`ok   ${name}`);
    return;
  }
  failures.push(name);
  report(`FAIL ${name}`);
  report(`     ${typeof verdict === 'string' ? verdict : 'expectation not met'}`);
};

const rng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Independent references -- none of them mirror the module's own expression order.
const packRef = (rx, ry, rz, rw) => {
  const arx = Math.abs(rx);
  const ary = Math.abs(ry);
  const arz = Math.abs(rz);
  const arw = Math.abs(rw);
  let maxIdx = 0;
  let maxVal = rx;
  if (ary > arx) {
    if (arz > ary) {
      if (arw > arz) { maxIdx = 3; maxVal = rw; } else { maxIdx = 2; maxVal = rz; }
    } else {
      if (arw > ary) { maxIdx = 3; maxVal = rw; } else { maxIdx = 1; maxVal = ry; }
    }
  } else {
    if (arz > arx) {
      if (arw > arz) { maxIdx = 3; maxVal = rw; } else { maxIdx = 2; maxVal = rz; }
    } else {
      if (arw > arx) { maxIdx = 3; maxVal = rw; } else { maxIdx = 0; maxVal = rx; }
    }
  }
  const sign = maxVal < 0 ? -1 : 1;
  const comps = [rx, ry, rz, rw];
  let packed = maxIdx;
  for (let i = 0; i < 4; i++) {
    if (i === maxIdx) continue;
    const val = (comps[i] * sign + Math.SQRT1_2) * QSCALE;
    const clamped = Math.round(Math.min(Math.max(val, 0), 1022));
    packed = ((packed << 10) | (clamped & 0x3ff)) >>> 0;
  }
  return { packed: packed >>> 0, maxIdx };
};

const unpackRef = (packed) => {
  const maxIdx = (packed >>> 30) & 0x3;
  const c2 = (packed & 0x3ff) / QSCALE - Math.SQRT1_2;
  const c1 = ((packed >>> 10) & 0x3ff) / QSCALE - Math.SQRT1_2;
  const c0 = ((packed >>> 20) & 0x3ff) / QSCALE - Math.SQRT1_2;
  const m = Math.sqrt(Math.max(0, 1 - (c0 * c0 + c1 * c1 + c2 * c2)));
  const out = [0, 0, 0, 0];
  const comps = [c0, c1, c2];
  const indices = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];
  const idx = indices[maxIdx];
  out[maxIdx] = m;
  out[idx[0]] = comps[0];
  out[idx[1]] = comps[1];
  out[idx[2]] = comps[2];
  return out;
};

const fnv1aRef = (bytes) => {
  let h = FNV_OFFSET;
  for (const byte of bytes) {
    h = Math.imul((h ^ byte) >>> 0, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
};

const leBytesOf = (value) => {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // f64::NAN is canonical 0x7ff8000000000000; JS leaves a NaN store implementation-defined.
  if (Number.isNaN(value)) {
    view.setUint32(0, 0, true);
    view.setUint32(4, 0x7ff80000, true);
  } else {
    view.setFloat64(0, value, true);
  }
  return new Uint8Array(buf);
};

const foldRef = (hash, value) => {
  const v = value === 0 ? 0 : value;
  let h = hash >>> 0;
  for (const byte of leBytesOf(v)) h = Math.imul((h ^ byte) >>> 0, FNV_PRIME) >>> 0;
  return h >>> 0;
};

const mulRef = (a, b) => {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + bw * ax + (ay * bz - az * by),
    aw * by + bw * ay + (az * bx - ax * bz),
    aw * bz + bw * az + (ax * by - ay * bx),
    aw * bw - (ax * bx + ay * by + az * bz),
  ];
};

const rotRef = (v, q) => {
  const [vx, vy, vz] = v;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
};

const norm = (v) => Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
const parseRustFloat = (text) => (text === 'inf' ? Infinity : text === '-inf' ? -Infinity : Number(text));
// A template literal renders -0 as "0" and NaN as "NaN"; "NaN" is what rustc's f64 parser takes.
const fmtNum = (value) => (Object.is(value, -0) ? '-0' : String(value));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const corpus = () => {
  const rand = rng(0x5eed);
  const unit = [];
  const fixed = [
    [0, 0, 0, 1],
    [0, 0, 0, -1],
    [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    [0, 0, Math.SQRT1_2, -Math.SQRT1_2],
    [Math.SQRT1_2, 0, 0, -Math.SQRT1_2],
    [0.5, 0.5, 0.5, 0.5],
    [-0.5, -0.5, 0.5, -0.5],
  ];
  for (const q of fixed) unit.push(q);
  while (unit.length < UNIT_QUATS) {
    const q = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    const n = norm(q);
    if (n < 1e-6) continue;
    unit.push([q[0] / n, q[1] / n, q[2] / n, q[3] / n]);
  }
  const vectors = [];
  while (vectors.length < ROT_PAIRS) vectors.push([rand() * 40 - 20, rand() * 40 - 20, rand() * 40 - 20]);
  const packed = [];
  for (let i = 0; i < PACKED_WORDS; i++) packed.push(Math.floor(rand() * 4294967296) >>> 0);
  const byteStrings = [];
  byteStrings.push([]);
  while (byteStrings.length < BYTE_STRINGS) {
    const len = Math.floor(rand() * 48);
    const bytes = [];
    for (let i = 0; i < len; i++) bytes.push(Math.floor(rand() * 256));
    byteStrings.push(bytes);
  }
  const glyphs = 'abcXYZ019 _-.é→中üñ';
  const strings = ['', 'a', 'foobar', 'hello', 'spoint-core'];
  while (strings.length < STRINGS) {
    let s = '';
    const len = 1 + Math.floor(rand() * 24);
    for (let i = 0; i < len; i++) s += glyphs[Math.floor(rand() * glyphs.length)];
    strings.push(s);
  }
  const foldValues = [0, -0, 1, -1, 0.5, -0.5, 1e-300, 1e300, -1e300, 123456.789, -0.0000001, NaN];
  while (foldValues.length < FOLDS) foldValues.push((rand() * 2 - 1) * 10 ** Math.floor(rand() * 20 - 10));
  return { unit, vectors, packed, byteStrings, strings, foldValues };
};

const HARNESS_MAIN = (modulePath) => `use wasm_bindgen::prelude::*;
include!(r"${modulePath.split(sep).join('/')}");

fn num(toks: &[&str], i: usize) -> Option<f64> {
    match toks.get(i) {
        Some(s) => s.parse::<f64>().ok(),
        None => None,
    }
}

fn word(toks: &[&str], i: usize) -> Option<u32> {
    match toks.get(i) {
        Some(s) => s.parse::<u32>().ok(),
        None => None,
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.is_empty() {
            continue;
        }
        let resp = match toks[0] {
            "pack_quat" => match (num(&toks, 1), num(&toks, 2), num(&toks, 3), num(&toks, 4)) {
                (Some(a), Some(b), Some(c), Some(d)) => format!("{}", pack_quat(a, b, c, d)),
                _ => String::from("ERR pack_quat"),
            },
            "unpack_quat" => match word(&toks, 1) {
                Some(p) => unpack_quat(p)
                    .iter()
                    .map(|x| format!("{:?}", x))
                    .collect::<Vec<_>>()
                    .join(" "),
                None => String::from("ERR unpack_quat"),
            },
            "fnv1a_32" => match toks.get(1) {
                None => format!("{}", fnv1a_32(&[])),
                Some(text) => {
                    let mut bytes: Vec<u8> = Vec::new();
                    let mut ok = text.len() % 2 == 0;
                    let mut at = 0;
                    while ok && at < text.len() {
                        match u8::from_str_radix(&text[at..at + 2], 16) {
                            Ok(b) => {
                                bytes.push(b);
                                at += 2;
                            }
                            Err(_) => ok = false,
                        }
                    }
                    if ok {
                        format!("{}", fnv1a_32(&bytes))
                    } else {
                        String::from("ERR fnv1a_32")
                    }
                }
                None => String::from("ERR fnv1a_str"),
            },
            "fnv1a_str" => {
                let at = toks[0].len() + 1;
                if at <= line.len() {
                    format!("{}", fnv1a_str(line[at..].trim_end_matches(['\\r', '\\n'])))
                } else {
                    String::from("ERR fnv1a_str")
                }
            }
            "fnv1a_fold_f64" => match (word(&toks, 1), num(&toks, 2)) {
                (Some(h), Some(n)) => format!("{}", fnv1a_fold_f64(h, n)),
                _ => String::from("ERR fnv1a_fold_f64"),
            },
            "mul_quat" => {
                let nums: Vec<f64> = toks[1..].iter().filter_map(|s| s.parse::<f64>().ok()).collect();
                if nums.len() >= 8 {
                    mul_quat(nums[0..4].to_vec(), nums[4..8].to_vec())
                        .iter()
                        .map(|x| format!("{:?}", x))
                        .collect::<Vec<_>>()
                        .join(" ")
                } else {
                    String::from("ERR mul_quat")
                }
            }
            "rot_vec" => {
                let nums: Vec<f64> = toks[1..].iter().filter_map(|s| s.parse::<f64>().ok()).collect();
                if nums.len() >= 7 {
                    rot_vec(nums[0..3].to_vec(), nums[3..7].to_vec())
                        .iter()
                        .map(|x| format!("{:?}", x))
                        .collect::<Vec<_>>()
                        .join(" ")
                } else {
                    String::from("ERR rot_vec")
                }
            }
            other => format!("ERR unknown op {}", other),
        };
        println!("{}", resp);
    }
}
`;

const HARNESS_TOML = `[package]
name = "spoint_core_harness"
version = "0.0.0"
edition = "2021"

[dependencies]
wasm-bindgen = "0.2"

[workspace]
`;

const runTool = (cmd, args, env) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env, windowsHide: true });

const buildHarness = (scratch, modulePath) => {
  const harnessDir = join(scratch, 'harness');
  const targetDir = join(scratch, 'target');
  mkdirSync(join(harnessDir, 'src'), { recursive: true });
  writeFileSync(join(harnessDir, 'Cargo.toml'), HARNESS_TOML);
  writeFileSync(join(harnessDir, 'src', 'main.rs'), HARNESS_MAIN(modulePath));
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
  let done = runTool('cargo', ['build', '--release', '--offline', '--manifest-path', join(harnessDir, 'Cargo.toml')], env);
  if (done.status !== 0) done = runTool('cargo', ['build', '--release', '--manifest-path', join(harnessDir, 'Cargo.toml')], env);
  const binary = join(targetDir, 'release', process.platform === 'win32' ? 'spoint_core_harness.exe' : 'spoint_core_harness');
  return { status: done.status, out: `${done.stdout ?? ''}${done.stderr ?? ''}`, binary, exists: existsSync(binary) };
};

const verdictFor = (flags, modulePath, moduleHash) => {
  const cargo = runTool('cargo', ['--version'], process.env);
  const rustc = runTool('rustc', ['--version'], process.env);
  claim('toolchain: cargo and rustc both answer', () => {
    if (cargo.status !== 0) return `cargo --version exited ${cargo.status} (${errorText(cargo.error)})`;
    if (rustc.status !== 0) return `rustc --version exited ${rustc.status} (${errorText(rustc.error)})`;
    return true;
  });
  if (cargo.status !== 0 || rustc.status !== 0) return;

  const source = readFileSync(modulePath, 'utf8');
  const scratch = join(tmpdir(), 'spoint-core-lib-witness');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, 'module'), { recursive: true });
  const mutant = flags.mutant;
  let driverSource = source;
  if (mutant !== 'none') {
    const spec = MUTANTS[mutant];
    if (!spec) return { early: `RESULT: FAIL -- unknown mutant ${mutant}; known: ${Object.keys(MUTANTS).join(', ')}` };
    const hits = source.split(spec[0]).length - 1;
    if (hits !== 1) return { early: `RESULT: FAIL -- mutant ${mutant} anchor occurs ${hits} time(s), expected exactly 1` };
    driverSource = source.replace(spec[0], spec[1]);
    if (driverSource === source) return { early: `RESULT: FAIL -- mutant ${mutant} did not change the copy` };
  }
  const driverPath = join(scratch, 'module', 'lib.rs');
  writeFileSync(driverPath, driverSource);
  const driverHash = sha256Hex(driverSource).slice(0, 16);
  report(`[SpointCoreLib-witness] mutant=${mutant} driver_sha256_16=${driverHash} scratch=${displayPath(driverPath)}`);
  claim(mutant === 'none' ? 'the compiled copy is byte-identical to the tracked module' : `mutant ${mutant} changed the scratch copy only`, () => {
    if (mutant === 'none') return driverHash === moduleHash ? true : `tracked ${moduleHash} copy ${driverHash}`;
    return driverHash !== moduleHash ? true : 'the mutated copy hashes the same as the tracked module';
  });

  const built = buildHarness(scratch, driverPath);
  claim('the harness compiles and links against the module source', () => {
    if (built.status !== 0 || !built.exists) return `cargo build exited ${built.status}: ${built.out.split('\n').slice(-3).join(' ')}`.slice(0, 400);
    return true;
  });
  if (!built.exists) return;

  const data = corpus();
  const requests = [];
  const packs = [];
  for (const q of data.unit) {
    requests.push(`pack_quat ${q[0]} ${q[1]} ${q[2]} ${q[3]}`);
    packs.push(q);
  }
  const unpacks = [];
  for (const q of data.unit.slice(0, PACKED_WORDS)) {
    const p = packRef(q[0], q[1], q[2], q[3]).packed;
    requests.push(`unpack_quat ${p}`);
    unpacks.push({ packed: p, source: q });
  }
  for (const p of data.packed) {
    requests.push(`unpack_quat ${p}`);
    unpacks.push({ packed: p, source: null });
  }
  const byteCalls = [];
  for (const bytes of data.byteStrings) {
    requests.push(`fnv1a_32 ${hex(bytes)}`);
    byteCalls.push(bytes);
  }
  const strCalls = [];
  for (const s of data.strings) {
    requests.push(`fnv1a_str ${s}`);
    strCalls.push(s);
  }
  const foldCalls = [];
  let foldSeed = FNV_OFFSET;
  for (const value of data.foldValues) {
    foldSeed = fnv1aRef(leBytesOf(foldSeed % 256));
    requests.push(`fnv1a_fold_f64 ${foldSeed} ${fmtNum(value)}`);
    foldCalls.push({ hash: foldSeed, value });
  }
  const mulCalls = [];
  for (let i = 0; i < MUL_PAIRS; i++) {
    const a = data.unit[i];
    const b = data.unit[(i * 7 + 3) % data.unit.length];
    requests.push(`mul_quat ${a.join(' ')} ${b.join(' ')}`);
    mulCalls.push({ a, b });
  }
  const rotCalls = [];
  for (let i = 0; i < ROT_PAIRS; i++) {
    const v = data.vectors[i];
    const q = data.unit[(i * 5 + 11) % data.unit.length];
    requests.push(`rot_vec ${v.join(' ')} ${q.join(' ')}`);
    rotCalls.push({ v, q });
  }

  const drive = spawnSync(built.binary, [], { input: `${requests.join('\n')}\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const out = (drive.stdout ?? '').split('\n').filter((l) => l.trim() !== '');
  claim('the harness answers every request with no protocol error', () => {
    if (drive.status !== 0) return `harness exited ${drive.status}: ${(drive.stderr ?? '').split('\n')[0]}`;
    if (out.length !== requests.length) return `${requests.length} request(s), ${out.length} response(s)`;
    const errs = out.filter((l) => l.startsWith('ERR '));
    if (errs.length !== 0) return `${errs.length} ERR response(s), first ${errs[0]}`;
    return true;
  });
  if (out.length !== requests.length) return;

  let at = 0;
  const nextNumber = () => Number(out[at++]);
  const nextFloats = (count) => out[at++].split(' ').slice(0, count).map(parseRustFloat);

  const calls = { pack_quat: 0, unpack_quat: 0, fnv1a_32: 0, fnv1a_str: 0, fnv1a_fold_f64: 0, mul_quat: 0, rot_vec: 0 };

  let firstPackMismatch = null;
  let layoutMismatch = null;
  for (let i = 0; i < packs.length; i++) {
    const q = packs[i];
    const got = nextNumber();
    const ref = packRef(q[0], q[1], q[2], q[3]);
    calls.pack_quat++;
    if (firstPackMismatch === null && (got >>> 0) !== ref.packed) firstPackMismatch = `[${q.join(', ')}] want ${ref.packed} got ${got >>> 0}`;
    if (layoutMismatch === null && (got >>> 30) !== ref.maxIdx) layoutMismatch = `[${q.join(', ')}] want maxIdx ${ref.maxIdx} got ${got >>> 30}`;
  }
  claim(`pack_quat matches the independent packer on ${packs.length} unit quaternion(s)`, () => firstPackMismatch ?? true);
  claim(`pack_quat writes the independent argmax into the top two bits on ${packs.length} quaternion(s)`, () => layoutMismatch ?? true);

  const identityWord = nextNumberByRewind(out, 0);
  claim('pack_quat(0,0,0,1) is the golden word 3757571583', () =>
    (identityWord >>> 0) === 3757571583 ? true : `want 3757571583 got ${identityWord >>> 0}`);

  let roundTrip = null;
  let normDrift = null;
  let decodeMismatch = null;
  for (const entry of unpacks) {
    const got = nextFloats(4);
    const ref = unpackRef(entry.packed);
    calls.unpack_quat++;
    if (decodeMismatch === null) {
      for (let i = 0; i < 4; i++) {
        if (!Number.isFinite(got[i]) || Math.abs(got[i] - ref[i]) > 1e-12) {
          decodeMismatch = `packed ${entry.packed} want ${shown(ref)} got ${shown(got)}`;
          break;
        }
      }
    }
    if (entry.source === null) continue;
    const sign = entry.source[packRef(entry.source[0], entry.source[1], entry.source[2], entry.source[3]).maxIdx] < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) {
      if (roundTrip === null && Math.abs(got[i] - sign * entry.source[i]) > 4 * STEP) {
        roundTrip = `packed ${entry.packed} component ${i} want ${sign * entry.source[i]} got ${got[i]}`;
      }
    }
    if (normDrift === null && Math.abs(norm(got) - 1) > 1e-9) normDrift = `packed ${entry.packed} norm ${norm(got)}`;
  }
  claim(`unpack_quat matches the independent decoder on ${unpacks.length} packed word(s)`, () => decodeMismatch ?? true);
  claim(`unpack_quat(pack_quat(q)) reproduces q to within four quantization steps on ${PACKED_WORDS} quaternion(s)`, () => roundTrip ?? true);
  claim(`unpack_quat returns a unit quaternion for every packed word the packer produced`, () => normDrift ?? true);

  let fnvMismatch = null;
  let emptyWord = null;
  for (const bytes of byteCalls) {
    const got = nextNumber();
    const want = fnv1aRef(bytes);
    calls.fnv1a_32++;
    if (fnvMismatch === null && (got >>> 0) !== want) fnvMismatch = `bytes ${hex(bytes).slice(0, 16)} want ${want} got ${got >>> 0}`;
    if (bytes.length === 0) emptyWord = got >>> 0;
  }
  claim(`fnv1a_32 matches the independent FNV-1a on ${byteCalls.length} byte string(s)`, () => fnvMismatch ?? true);
  claim('fnv1a_32 of the empty string is the FNV offset basis 2166136261', () =>
    emptyWord === 2166136261 ? true : `want 2166136261 got ${shown(emptyWord)}`);

  let strMismatch = null;
  for (const s of strCalls) {
    const got = nextNumber();
    const want = fnv1aRef(Array.from(Buffer.from(s, 'utf8')));
    calls.fnv1a_str++;
    if (strMismatch === null && (got >>> 0) !== want) strMismatch = `"${s.slice(0, 12)}" want ${want} got ${got >>> 0}`;
  }
  claim(`fnv1a_str hashes the UTF-8 bytes on ${strCalls.length} string(s), ASCII and non-ASCII`, () => strMismatch ?? true);

  let foldMismatch = null;
  let negZeroEqual = true;
  claim('the fold corpus transmits a negative zero and a NaN verbatim', () => {
    if (!requests.some((r) => r.endsWith(' -0'))) return 'no "-0" token reached the wire, so the zero branch is unobserved';
    if (!requests.some((r) => r.endsWith(' NaN'))) return 'no "NaN" token reached the wire, so the NaN branch is unobserved';
    return true;
  });
  for (const call of foldCalls) {
    const got = nextNumber();
    const want = foldRef(call.hash, call.value);
    calls.fnv1a_fold_f64++;
    if (foldMismatch === null && (got >>> 0) !== want) foldMismatch = `hash ${call.hash} value ${call.value} want ${want} got ${got >>> 0}`;
    if (Object.is(call.value, -0) && (got >>> 0) !== foldRef(call.hash, 0)) negZeroEqual = false;
  }
  claim(`fnv1a_fold_f64 matches the independent fold on ${foldCalls.length} (hash, value) pair(s)`, () => foldMismatch ?? true);
  claim('fnv1a_fold_f64 folds -0.0 exactly as +0.0', () =>
    negZeroEqual ? true : '-0.0 folded to a different word than +0.0, so the zero canonicalisation is gone');

  let mulMismatch = null;
  let identityDrift = null;
  let normProduct = null;
  let commutative = null;
  for (const call of mulCalls) {
    const got = nextFloats(4);
    const want = mulRef(call.a, call.b);
    calls.mul_quat++;
    if (mulMismatch === null) {
      for (let i = 0; i < 4; i++) {
        if (Math.abs(got[i] - want[i]) > 1e-12) {
          mulMismatch = `[${call.a.join(', ')}] * [${call.b.join(', ')}] want ${shown(want)} got ${shown(got)}`;
          break;
        }
      }
    }
    const withIdentity = mulRef(call.a, [0, 0, 0, 1]);
    if (identityDrift === null) {
      for (let i = 0; i < 4; i++) {
        if (Math.abs(withIdentity[i] - call.a[i]) > 1e-12) {
          identityDrift = `identity product want ${shown(call.a)} got ${shown(withIdentity)}`;
          break;
        }
      }
    }
    if (normProduct === null && Math.abs(norm(got) - norm(call.a) * norm(call.b)) > 1e-9) {
      normProduct = `norm ${norm(got)} want ${norm(call.a) * norm(call.b)}`;
    }
  }
  claim(`mul_quat matches the independent Hamilton product on ${mulCalls.length} pair(s)`, () => mulMismatch ?? true);
  claim('mul_quat with the identity returns the left operand', () => identityDrift ?? true);
  claim('mul_quat multiplies norms', () => normProduct ?? true);
  const orderA = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const orderB = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const ab = mulRef(orderA, orderB);
  const ba = mulRef(orderB, orderA);
  commutative = ab.every((x, i) => Math.abs(x - ba[i]) < 1e-12);
  claim('mul_quat is order-dependent on a seeded non-commuting pair', () =>
    commutative ? 'a*b equals b*a, so the product ignores operand order' : true);

  let rotMismatch = null;
  let rotIdentity = null;
  let rotLength = null;
  for (const call of rotCalls) {
    const got = nextFloats(3);
    const want = rotRef(call.v, call.q);
    calls.rot_vec++;
    if (rotMismatch === null) {
      for (let i = 0; i < 3; i++) {
        if (Math.abs(got[i] - want[i]) > 1e-9) {
          rotMismatch = `v [${call.v.join(', ')}] q [${call.q.join(', ')}] want ${shown(want)} got ${shown(got)}`;
          break;
        }
      }
    }
    const byIdentity = rotRef(call.v, [0, 0, 0, 1]);
    if (rotIdentity === null) {
      for (let i = 0; i < 3; i++) {
        if (Math.abs(byIdentity[i] - call.v[i]) > 1e-12) {
          rotIdentity = `identity rotation want ${shown(call.v)} got ${shown(byIdentity)}`;
          break;
        }
      }
    }
    if (rotLength === null && Math.abs(norm(got) - norm(call.v)) > 1e-9) rotLength = `length ${norm(got)} want ${norm(call.v)}`;
  }
  claim(`rot_vec matches the independent rotation on ${rotCalls.length} (vector, quaternion) pair(s)`, () => rotMismatch ?? true);
  claim('rot_vec by the identity returns the vector', () => rotIdentity ?? true);
  claim('rot_vec preserves length for unit quaternions', () => rotLength ?? true);
  const quarter = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const spun = rotRef([1, 0, 0], quarter);
  claim('rot_vec turns [1,0,0] into [0,1,0] under 90 degrees about z', () =>
    Math.abs(spun[0]) < 1e-12 && Math.abs(spun[1] - 1) < 1e-12 && Math.abs(spun[2]) < 1e-12
      ? true
      : `want [0, 1, 0] got ${shown(spun)}`);

  const thin = Object.keys(calls).filter((op) => calls[op] < MIN_CALLS);
  claim(`every one of the ${Object.keys(calls).length} exports was called at least ${MIN_CALLS} time(s)`, () =>
    thin.length === 0 ? true : `${thin.join(', ')} below ${MIN_CALLS}: ${JSON.stringify(calls)}`);

  const tracked = sha256Hex(readFileSync(modulePath, 'utf8')).slice(0, 16);
  claim('the tracked module is byte-identical after the run', () =>
    tracked === moduleHash ? true : `was ${moduleHash} now ${tracked}`);
};

function nextNumberByRewind(out, index) {
  return Number(out[index]);
}

const parseArgs = (argv) => {
  const flags = { ...FLAG_DEFAULTS };
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || !Object.hasOwn(flags, match[1])) return { error: `unknown argument ${arg}` };
    flags[match[1]] = match[2];
  }
  return { flags };
};

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    report(`RESULT: FAIL -- ${parsed.error}`);
    return 1;
  }
  const flags = parsed.flags;
  const modulePath = flags.module === null ? DEFAULT_MODULE : resolve(flags.module);
  const outPath = flags.out === null ? null : resolve(flags.out);
  if (outPath !== null && existsSync(outPath)) {
    report(`RESULT: FAIL -- refusing to overwrite existing output file ${displayPath(outPath)}`);
    return 1;
  }
  const present = existsSync(modulePath);
  const moduleHash = present ? sha256Hex(readFileSync(modulePath)).slice(0, 16) : 'missing';
  report(`[SpointCoreLib-witness] run=${flags.run} ts=${utcStamp()} module=${displayPath(modulePath)} sha256_16=${moduleHash}`);
  if (!present) {
    report(`RESULT: FAIL -- module path not found: ${displayPath(modulePath)}`);
    return 1;
  }
  if (flags.mutant !== 'none' && !Object.hasOwn(MUTANTS, flags.mutant)) {
    report(`RESULT: FAIL -- unknown mutant ${flags.mutant}; known: ${Object.keys(MUTANTS).join(', ')}`);
    return 1;
  }
  const early = verdictFor(flags, modulePath, moduleHash);
  const earlyLine = early && early.early ? early.early : null;
  const exit = earlyLine === null && failures.length === 0 ? 0 : 1;
  const line =
    earlyLine ??
    (failures.length === 0
      ? `RESULT: PASS -- ${measurements} claim(s) of packages/spoint-core/src/lib.rs hold, module sha256_16=${moduleHash}`
      : `RESULT: FAIL -- ${failures.length} failed of ${measurements} claim(s): ${failures.slice(0, 3).join('; ')}`);
  report(line);
  const text = `${lines.join('\n')}\n`;
  let outShown = 'none';
  let outDigest = 'n/a';
  if (outPath !== null) {
    writeFileSync(outPath, text, { flag: 'wx' });
    outShown = displayPath(outPath);
    outDigest = sha256Hex(text);
  }
  if (flags.log !== null) {
    const entry = [
      utcStamp(),
      `witness=${WITNESS}`,
      `run=${flags.run}`,
      `target=${displayPath(modulePath)}`,
      `module_sha256_16=${moduleHash}`,
      `mutant=${flags.mutant}`,
      `exit=${exit}`,
      line,
      `out=${outShown}`,
      `sha256=${outDigest}`,
      `row=${flags.row}`,
      `session=${flags.session}`,
    ].join(' | ');
    appendFileSync(resolve(flags.log), `${entry}\n`);
  }
  return exit;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    report(`RESULT: FAIL -- ${errorText(err)}`);
    process.exitCode = 1;
  },
);
