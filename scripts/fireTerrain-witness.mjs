import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WITNESS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(WITNESS_FILE), '..');
const DEFAULT_MODULE = path.join(REPO_ROOT, 'src', 'behaviours', 'fireTerrain.js');
const ARG_NAMES = new Set(['module', 'out', 'log', 'label', 'row', 'session']);
const UNSET = 'n/a';

const RADIUS = 100;
const ANCHOR_HEIGHT = 2;
const TANGENT_SCALE = RADIUS + ANCHOR_HEIGHT;
const BASE = 3;
const UP = [0, 1, 0];
const BASIS_A = Object.freeze({ east: [0, 0, 1], north: [1, 0, 0] });
const BASIS_B = Object.freeze({ east: [1, 0, 0], north: [0, 0, -1] });
const PROBE = Object.freeze({ x: 51, z: 25.5 });
const WEST_PROBE = Object.freeze({ x: -51, z: 25.5 });
const NO_BREAKS = Object.freeze({ water: false, kinds: new Set(), cleared: [], rock: null, heightAt: null, seaLevelAt: null, kindAt: null });
const NO_TERRAIN = Object.freeze({ heightAt: null, seaLevelAt: null, kindAt: null });
const ROAD_OR_RIVER = (x) => (x > 40 ? 'road' : x < 0 ? 'river' : null);
const TERRAIN_HEIGHT = (x) => (x > 40 ? -1 : 5);
const SEA_AT_ZERO = () => 0;
const refusalOf = (fn) => { try { fn(); return 'constructed'; } catch (err) { return String(err && err.message).startsWith('[fire] firebreaks.') ? 'refused' : `threw ${err && err.message}`; } };
const DISC = (x, z, radiusM) => ({ cleared: [{ center: [x, z], radiusM }] });

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = /^--([a-z]+)=(.+)$/.exec(arg);
    if (!m || !ARG_NAMES.has(m[1])) return { error: `bad argument: ${arg}` };
    opts[m[1]] = m[2];
  }
  return opts;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function directionAt(x, z, basis, du) {
  return [0, 1, 2].map((i) => du * UP[i] + du * (x / TANGENT_SCALE) * basis.east[i] + du * (z / TANGENT_SCALE) * basis.north[i]);
}

function latticeOver(directions) {
  return {
    cellCentreDir(face, I, J, out) {
      const d = directions[I];
      out[0] = d[0];
      out[1] = d[1];
      out[2] = d[2];
      return out;
    },
  };
}

function classify(mod, cells, { basis = BASIS_A, breaks = {}, terrain = NO_TERRAIN } = {}) {
  const directions = cells.map((c) => directionAt(c.x, c.z, basis, c.du ?? 1));
  const classAt = mod.createFirebreakFuel({
    baseClassAt: (face, I) => cells[I].base ?? BASE,
    breaks: { ...NO_BREAKS, ...breaks },
    frame: { radius: RADIUS, anchorHeight: ANCHOR_HEIGHT, up: UP, east: basis.east, north: basis.north },
    lattice: latticeOver(directions),
    terrain,
  });
  return cells.map((_, I) => classAt(0, I, 0));
}

function makeRecorder() {
  const rec = { lines: [], checks: 0, failed: 0 };
  rec.check = (name, got, want) => {
    rec.checks += 1;
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (!same) rec.failed += 1;
    rec.lines.push(`${same ? 'ok  ' : 'FAIL'} ${name} | got ${JSON.stringify(got)} | want ${JSON.stringify(want)}`);
  };
  return rec;
}

function runChecks(mod, rec) {
  const at = (cell, extra) => ({ ...cell, ...extra });

  rec.check('no breaks: a fuel cell keeps its base class', classify(mod, [PROBE])[0], BASE);
  rec.check('no breaks: base class 7 is returned unchanged', classify(mod, [at(PROBE, { base: 7 })])[0], 7);
  rec.check('base class 0 stays 0 under a cleared disc', classify(mod, [at(PROBE, { base: 0 })], { breaks: DISC(51, 25.5, 1) })[0], 0);

  rec.check('projection: a disc on (51, 25.5) clears the probe (scale R+anchorHeight, east to x, north to z)', classify(mod, [PROBE], { breaks: DISC(51, 25.5, 0.001) })[0], 0);
  rec.check('projection: the same disc clears the probe under rotated basis B', classify(mod, [PROBE], { basis: BASIS_B, breaks: DISC(51, 25.5, 0.001) })[0], 0);
  rec.check('projection: a disc on the axis-swapped point (25.5, 51) does not clear the probe', classify(mod, [PROBE], { breaks: DISC(25.5, 51, 0.001) })[0], BASE);
  rec.check('projection: a disc on the unscaled point (50, 25) does not clear the probe', classify(mod, [PROBE], { breaks: DISC(50, 25, 0.001) })[0], BASE);

  rec.check('cleared: a disc whose radius equals the centre distance clears the probe (inclusive)', classify(mod, [PROBE], { breaks: DISC(54, 29.5, 5) })[0], 0);
  rec.check('cleared: a disc 0.001 short of the centre distance does not clear the probe', classify(mod, [PROBE], { breaks: DISC(54, 29.5, 4.999) })[0], BASE);
  rec.check('cleared: a distant disc does not clear the probe', classify(mod, [PROBE], { breaks: DISC(1000, 1000, 1) })[0], BASE);
  rec.check('cleared: one disc among several is enough', classify(mod, [PROBE], { breaks: { cleared: [{ center: [1000, 1000], radiusM: 1 }, { center: [51, 25.5], radiusM: 0.5 }] } })[0], 0);

  rec.check('du guard: a cell at du exactly 0.2 is not projected and keeps its base', classify(mod, [{ x: 204, z: 0, du: 0.2 }], { breaks: DISC(204, 0, 1) })[0], BASE);
  rec.check('du guard: a cell at du 0.25 is projected and cleared by a disc on its projection', classify(mod, [{ x: 204, z: 0, du: 0.25 }], { breaks: DISC(204, 0, 0.5) })[0], 0);

  const roads = { kinds: new Set(['road']), kindAt: ROAD_OR_RIVER };
  rec.check('kinds: a cell of a listed kind is cleared', classify(mod, [PROBE], { breaks: roads })[0], 0);
  rec.check('kinds: a cell of an unlisted kind keeps its base', classify(mod, [WEST_PROBE], { breaks: roads })[0], BASE);
  rec.check('kinds: a cell with no kind keeps its base', classify(mod, [{ x: 10, z: 25.5 }], { breaks: roads })[0], BASE);
  rec.check('kinds: an empty kind set clears nothing', classify(mod, [PROBE], { breaks: { kinds: new Set(), kindAt: ROAD_OR_RIVER } })[0], BASE);
  rec.check('kinds: an undefined kind keeps the base', classify(mod, [PROBE], { breaks: { kinds: new Set(['road']), kindAt: () => undefined } })[0], BASE);
  rec.check('kinds: breaks.kindAt takes precedence over terrain.kindAt', classify(mod, [PROBE], { breaks: { kinds: new Set(['road']), kindAt: () => 'road' }, terrain: { ...NO_TERRAIN, kindAt: () => null } })[0], 0);
  rec.check('kinds: terrain.kindAt is used when breaks.kindAt is absent', classify(mod, [PROBE], { breaks: { kinds: new Set(['road']) }, terrain: { ...NO_TERRAIN, kindAt: () => 'road' } })[0], 0);
  rec.check('kinds: a non-empty kind set with no kind sampler is refused at construction', refusalOf(() => classify(mod, [PROBE], { breaks: { kinds: new Set(['road']) } })), 'refused');
  rec.check('kinds: an empty kind set needs no kind sampler', classify(mod, [PROBE], { breaks: { kinds: new Set() } })[0], BASE);

  const water = { water: true, heightAt: TERRAIN_HEIGHT, seaLevelAt: SEA_AT_ZERO };
  rec.check('water: a cell below sea level is cleared', classify(mod, [PROBE], { breaks: water })[0], 0);
  rec.check('water: a cell above sea level keeps its base', classify(mod, [WEST_PROBE], { breaks: water })[0], BASE);
  rec.check('water: a cell exactly at sea level keeps its base', classify(mod, [PROBE], { breaks: { water: true, heightAt: () => 0, seaLevelAt: SEA_AT_ZERO } })[0], BASE);
  rec.check('water: a NaN height keeps the base', classify(mod, [PROBE], { breaks: { water: true, heightAt: () => NaN, seaLevelAt: SEA_AT_ZERO } })[0], BASE);
  rec.check('water: a NaN sea level keeps the base', classify(mod, [PROBE], { breaks: { water: true, heightAt: () => -1, seaLevelAt: () => NaN } })[0], BASE);
  rec.check('water: water false disables the test', classify(mod, [PROBE], { breaks: { ...water, water: false } })[0], BASE);
  rec.check('water: terrain.heightAt is used when breaks.heightAt is absent', classify(mod, [PROBE], { breaks: { water: true, seaLevelAt: SEA_AT_ZERO }, terrain: { heightAt: TERRAIN_HEIGHT, seaLevelAt: null, kindAt: null } })[0], 0);
  rec.check('water: no height source is refused at construction', refusalOf(() => classify(mod, [PROBE], { breaks: { water: true, seaLevelAt: SEA_AT_ZERO } })), 'refused');
  rec.check('water: no sea-level source is refused at construction', refusalOf(() => classify(mod, [PROBE], { breaks: { water: true, heightAt: TERRAIN_HEIGHT } })), 'refused');
  rec.check('water: water false needs no sampler', classify(mod, [PROBE], { breaks: { water: false } })[0], BASE);

  rec.check('rock: a cell the rock test flags is cleared', classify(mod, [PROBE], { breaks: { rock: (x) => x > 40 } })[0], 0);
  rec.check('rock: a cell the rock test does not flag keeps its base', classify(mod, [PROBE], { breaks: { rock: () => false } })[0], BASE);
  rec.check('rock: a null rock test keeps the base', classify(mod, [PROBE], { breaks: { rock: null } })[0], BASE);
  rec.check('rock: the test is evaluated per cell', classify(mod, [PROBE, WEST_PROBE], { breaks: { rock: (x) => x < 0 } }), [BASE, 0]);

  const rnd = lcg(20261010);
  const grid = Array.from({ length: 200 }, (_, i) => ({
    x: Math.round((rnd() * 2 - 1) * 300),
    z: Math.round((rnd() * 2 - 1) * 300),
    du: [1, 0.5, 0.25, 0.2, 0.1][Math.floor(rnd() * 5)],
    base: i % 11 === 0 ? 0 : 1 + (i % 7),
  }));
  const clearedOnly = { cleared: [{ center: [0, 0], radiusM: 120 }, { center: [-150, 80], radiusM: 40 }] };
  const allBreaks = { ...clearedOnly, kinds: new Set(['road']), kindAt: (x) => (x > 200 ? 'road' : null), rock: (x, z) => x * z > 50000 };
  const plain = classify(mod, grid);
  const clearedRun = classify(mod, grid, { breaks: clearedOnly });
  const allRun = classify(mod, grid, { breaks: allBreaks });
  const fuelIndices = [];
  grid.forEach((c, i) => { if (c.base !== 0) fuelIndices.push(i); });
  const zeroedBy = (out) => new Set(fuelIndices.filter((i) => out[i] === 0));
  const zeroedCleared = zeroedBy(clearedRun);
  const zeroedAll = zeroedBy(allRun);
  rec.check('property: with no breaks every grid cell keeps its base class', grid.every((c, i) => plain[i] === c.base), true);
  rec.check('property: every grid output is its base class or 0', [clearedRun, allRun].every((out) => grid.every((c, i) => out[i] === c.base || out[i] === 0)), true);
  rec.check('property: adding breaks never un-clears a cell', [...zeroedCleared].every((i) => zeroedAll.has(i)), true);
  rec.check('property: the cleared-disc run clears some but not all fuel cells', zeroedCleared.size > 0 && zeroedCleared.size < fuelIndices.length, true);
  rec.check('property: the full run clears more fuel cells than the cleared-disc run', zeroedAll.size > zeroedCleared.size, true);
}

function logLine(report, exitCode, result, outSha) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const fields = [
    ts,
    'scripts/fireTerrain-witness.mjs',
    `exit=${exitCode}`,
    result,
    `run=${report.label}`,
    `module=${report.modulePath}`,
    `module_sha256=${report.moduleSha}`,
    `witness_sha256=${sha256(fs.readFileSync(WITNESS_FILE))}`,
    `out=${report.outRel}`,
    `out_sha256=${outSha}`,
    `row=${report.row}`,
    `session=${report.session}`,
  ];
  return `${fields.join(' | ')}\n`;
}

function conclude(report) {
  const summary = `${report.checks - report.failed}/${report.checks} checks passed`;
  let result;
  if (report.fatal !== null) result = `RESULT: FAIL ${report.fatal}`;
  else if (report.checks === 0 || report.failed > 0) result = `RESULT: FAIL (${summary})`;
  else result = `RESULT: PASS (${summary})`;
  const header = [
    `witness=scripts/fireTerrain-witness.mjs label=${report.label}`,
    `module=${report.modulePath}`,
    `module_sha256=${report.moduleSha}`,
    'source=none: pure module (no imports, no browser, GPU, network or clock global); expectations are fixed values worked out from the module source',
    'contract: a firebreaks promise that cannot be applied is refused at construction, never silently skipped -- water without a height and sea-level sampler, a non-empty kinds without a kind sampler',
    `frame: radius=${RADIUS} anchorHeight=${ANCHOR_HEIGHT} tangentScale=${TANGENT_SCALE} base=${BASE}`,
  ];
  let text = [...header, ...report.body, result, ''].join('\n');
  let wrote = false;
  if (report.out) {
    try {
      fs.mkdirSync(path.dirname(report.out), { recursive: true });
      fs.writeFileSync(report.out, text, { flag: 'wx' });
      wrote = true;
    } catch (err) {
      result = `RESULT: FAIL out not written: ${err.message}`;
      text = [...header, ...report.body, result, ''].join('\n');
    }
  }
  const exitCode = result.startsWith('RESULT: PASS') ? 0 : 1;
  process.stdout.write(text);
  if (report.log) {
    try {
      fs.appendFileSync(report.log, logLine(report, exitCode, result, wrote ? sha256(text) : 'none'));
    } catch (err) {
      process.stderr.write(`log not appended: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = exitCode;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = { label: 'unlabelled', row: UNSET, session: UNSET, modulePath: 'n/a', moduleSha: 'n/a', fatal: null, body: [], checks: 0, failed: 0, out: null, outRel: 'none', log: null };
  if (opts.error) {
    report.fatal = opts.error;
    return conclude(report);
  }
  report.label = opts.label ?? 'unlabelled';
  report.row = opts.row ?? UNSET;
  report.session = opts.session ?? UNSET;
  report.log = opts.log ? path.resolve(opts.log) : null;
  report.out = opts.out ? path.resolve(opts.out) : null;
  if (report.out) report.outRel = path.relative(REPO_ROOT, report.out).split(path.sep).join('/');
  if (report.out && fs.existsSync(report.out)) {
    report.fatal = `out already exists, create-only: ${report.out}`;
    report.out = null;
    return conclude(report);
  }
  report.modulePath = path.resolve(opts.module ?? DEFAULT_MODULE);
  if (!fs.existsSync(report.modulePath)) {
    report.fatal = `module not found: ${report.modulePath}`;
    return conclude(report);
  }
  report.moduleSha = sha256(fs.readFileSync(report.modulePath));
  let mod;
  try {
    mod = await import(pathToFileURL(report.modulePath).href);
  } catch (err) {
    report.fatal = `module import failed: ${err.message}`;
    return conclude(report);
  }
  if (typeof mod.createFirebreakFuel !== 'function') {
    report.fatal = 'module does not export createFirebreakFuel';
    return conclude(report);
  }
  const rec = makeRecorder();
  try {
    runChecks(mod, rec);
  } catch (err) {
    rec.check('module ran without throwing', `threw ${err.message}`, 'ran');
  }
  report.body = rec.lines;
  report.checks = rec.checks;
  report.failed = rec.failed;
  return conclude(report);
}

main().catch((err) => {
  process.stdout.write(`RESULT: FAIL witness crashed: ${err.message}\n`);
  process.exitCode = 1;
});
