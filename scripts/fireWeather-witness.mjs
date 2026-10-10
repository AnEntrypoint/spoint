// Node witness for src/behaviours/fireWeather.js (createFireWeather).
//
// The module's closure (fireWire.js -> fireKernel.js -> fireLattice.js -> terrain/PlacementLattice.js)
// is deterministic integer code: no Math.random, no Date.now, no browser or GPU global. Every
// expectation below is a fixed value worked out by hand from the module source, so nothing is seeded.
//
// Usage: node scripts/fireWeather-witness.mjs [--module=<path>] [--out=<path>] [--log=<path>] [--label=<text>]
//   --module  file to exercise (default: src/behaviours/fireWeather.js of this repo)
//   --out     report file, created new; refused if it already exists
//   --log     log file; one line is appended per run
//   --label   free text carried into the report and the log line
// Exit 0 on RESULT: PASS, exit 1 on RESULT: FAIL.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODULE = path.join(REPO_ROOT, 'src', 'behaviours', 'fireWeather.js');
const ARG_NAMES = new Set(['module', 'out', 'log', 'label']);
const WIND_CLAMP = 16; // FIRE_MAX_WIND_COMPONENT, src/shared/fire/fireKernel.js line 5
const CONFIG = Object.freeze({
  rainPerIntensity: 255,
  snowRainFraction: 0.5,
  maxMoisture: 100,
  wetPerStep: 40,
  dryPerStep: 3,
  hysteresis: 5,
});
const RAIN_FULL = { type: 'rain', intensity: 1 };
const RAIN_HALF = { type: 'rain', intensity: 0.5 };
const RAIN_BYTE_1 = { type: 'rain', intensity: 0.003 };
const RAIN_BYTE_105 = { type: 'rain', intensity: 105 / 255 };
const CLEAR = null;

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

function rig(mod, { stepTicks = 1, wind, config = CONFIG } = {}) {
  const queue = [];
  let reads = 0;
  const sim = mod.createFireWeather({
    config,
    readWeather: () => {
      reads += 1;
      return queue.length > 0 ? queue.shift() : CLEAR;
    },
    stepTicks,
    wind,
  });
  return { sim, queue, reads: () => reads };
}

function afterSteps(mod, weathers) {
  const r = rig(mod);
  weathers.forEach((w, t) => {
    r.queue.push(w);
    r.sim.step(t, {});
  });
  return r;
}

function emit(r, tick, weather) {
  r.queue.push(weather);
  const out = {};
  r.sim.step(tick, out);
  return [out.rain, out.moisture, out.wind];
}

function runChecks(mod, rec) {
  const rainOf = (w) => afterSteps(mod, [w]).sim.rain;
  const windOf = (w) => afterSteps(mod, [w]).sim.wind;

  rec.check('rain: intensity 1 maps to 255', rainOf(RAIN_FULL), 255);
  rec.check('rain: intensity 0.5 maps 127.5 to 128', rainOf(RAIN_HALF), 128);
  rec.check('rain: intensity 2 clamps to 255', rainOf({ type: 'rain', intensity: 2 }), 255);
  rec.check('rain: intensity -1 clamps to 0', rainOf({ type: 'rain', intensity: -1 }), 0);
  rec.check('rain: intensity 0.003 maps 0.765 to 1', rainOf(RAIN_BYTE_1), 1);
  rec.check('snow: intensity 1 maps 127.5 to 128', rainOf({ type: 'snow', intensity: 1 }), 128);
  rec.check('snow: intensity 0.5 maps 63.75 to 64', rainOf({ type: 'snow', intensity: 0.5 }), 64);
  rec.check('fog: unknown type yields no rain', rainOf({ type: 'fog', intensity: 1 }), 0);
  rec.check('rain: string intensity yields no rain', rainOf({ type: 'rain', intensity: '1' }), 0);
  rec.check('rain: NaN intensity yields no rain', rainOf({ type: 'rain', intensity: NaN }), 0);
  rec.check('absent weather yields no rain', rainOf(CLEAR), 0);

  rec.check('wind: in-range integers pass through', windOf({ type: 'clear', wind: [3, -2, 5] }), [3, -2, 5]);
  rec.check('wind: components clamp to +-16 after rounding', windOf({ type: 'clear', wind: [20, -20, 16.4] }), [WIND_CLAMP, -WIND_CLAMP, WIND_CLAMP]);
  rec.check('wind: halves round toward +infinity', windOf({ type: 'clear', wind: [1.5, 2.5, -1.5] }), [2, 3, -1]);
  rec.check('wind: two components are rejected', windOf({ type: 'clear', wind: [1, 2] }), [0, 0, 0]);
  rec.check('wind: a NaN component rejects the vector', windOf({ type: 'clear', wind: [1, NaN, 3] }), [0, 0, 0]);
  rec.check('wind: a non-array is rejected', windOf({ type: 'clear', wind: 'abc' }), [0, 0, 0]);
  rec.check('wind: constructor wind is kept', rig(mod, { wind: [4, -5, 6] }).sim.wind, [4, -5, 6]);
  rec.check('wind: constructor wind truncates toward zero', rig(mod, { wind: [1.7, -2.2, 3] }).sim.wind, [1, -2, 3]);
  rec.check('wind: default wind is zero', rig(mod).sim.wind, [0, 0, 0]);
  rec.check('wind: emitted wind starts at constructor wind', rig(mod, { wind: [4, -5, 6] }).sim.emittedWind, [4, -5, 6]);

  {
    const r = rig(mod);
    const seen = [];
    for (let t = 0; t < 4; t += 1) {
      r.queue.push(RAIN_FULL);
      r.sim.step(t, {});
      seen.push(r.sim.moisture);
    }
    rec.check('moisture: full rain adds 40 a step and stops at 100', seen, [40, 80, 100, 100]);
    r.queue.push(CLEAR);
    r.sim.step(4, {});
    rec.check('moisture: one dry step removes 3', r.sim.moisture, 97);
  }
  rec.check('moisture: rain byte 128 adds ceil(40*128/255) = 21', afterSteps(mod, [RAIN_HALF]).sim.moisture, 21);
  rec.check('moisture: rain byte 1 adds at least one unit', afterSteps(mod, [RAIN_BYTE_1]).sim.moisture, 1);
  rec.check('moisture: two rain byte 1 steps reach 2', afterSteps(mod, [RAIN_BYTE_1, RAIN_BYTE_1]).sim.moisture, 2);
  rec.check('moisture: dry air stays at 0', afterSteps(mod, [CLEAR]).sim.moisture, 0);
  rec.check('moisture: drying from 2 floors at 0', afterSteps(mod, [RAIN_BYTE_1, RAIN_BYTE_1, CLEAR]).sim.moisture, 0);

  {
    const r = rig(mod, { stepTicks: 10 });
    const out = {};
    rec.check('cadence: tick 5 is off the boundary, returns null', r.sim.step(5, out), null);
    rec.check('cadence: an off-boundary tick reads no weather', r.reads(), 0);
    rec.check('cadence: tick 0 is on the boundary, returns out', r.sim.step(0, out) === out, true);
    rec.check('cadence: tick 9 is off the boundary, returns null', r.sim.step(9, out), null);
    rec.check('cadence: tick 10 is on the boundary, returns out', r.sim.step(10, out) === out, true);
    rec.check('cadence: two boundary ticks read weather twice', r.reads(), 2);
  }

  {
    const r = rig(mod);
    rec.check('emit: quiet start reports nothing', emit(r, 0, CLEAR), [-1, -1, null]);
    rec.check('emit: rain onset reports rain and moisture', emit(r, 1, RAIN_FULL), [255, 40, null]);
    r.sim.markEmitted(255, 40);
    rec.check('markEmitted stores rain and moisture', [r.sim.emittedRain, r.sim.emittedMoisture], [255, 40]);
    rec.check('emit: moisture change of 3 is held inside hysteresis 5', emit(r, 2, CLEAR), [0, -1, null]);
    r.sim.markEmitted(0, 40);
    rec.check('emit: moisture change of 6 is reported at hysteresis 5', emit(r, 3, CLEAR), [-1, 34, null]);
    r.sim.markEmitted(0, 34);
  }

  {
    const r = afterSteps(mod, [RAIN_BYTE_1, RAIN_BYTE_1]);
    r.sim.markEmitted(1, 2);
    rec.check('emit: reaching zero is reported inside hysteresis', emit(r, 2, CLEAR), [0, 0, null]);
  }

  {
    const r = afterSteps(mod, [RAIN_FULL, RAIN_FULL, RAIN_BYTE_105]);
    r.sim.markEmitted(105, 97);
    rec.check('emit: reaching the cap is reported inside hysteresis', emit(r, 3, RAIN_FULL), [255, 100, null]);
  }

  {
    const r = rig(mod);
    rec.check('emit: first wind vector is reported', emit(r, 0, { type: 'clear', wind: [3, -2, 5] }), [-1, -1, [3, -2, 5]]);
    r.sim.markEmitted(0, 0, [3, -2, 5]);
    rec.check('markEmitted copies a length-3 wind', r.sim.emittedWind, [3, -2, 5]);
    rec.check('emit: an unchanged wind is not reported', emit(r, 1, { type: 'clear', wind: [3, -2, 5] }), [-1, -1, null]);
    rec.check('emit: a clamped change is reported clamped', emit(r, 2, { type: 'clear', wind: [20, -20, 16.4] }), [-1, -1, [WIND_CLAMP, -WIND_CLAMP, WIND_CLAMP]]);
    r.sim.markEmitted(0, 0, [1, 2]);
    rec.check('markEmitted ignores a wind that is not length 3', r.sim.emittedWind, [3, -2, 5]);
  }

  {
    const r = rig(mod, { wind: [1, 2, 3] });
    r.sim.wind[0] = 99;
    rec.check('wind getter returns a copy', r.sim.wind, [1, 2, 3]);
    r.sim.emittedWind[1] = 77;
    rec.check('emittedWind getter returns a copy', r.sim.emittedWind, [1, 2, 3]);
  }

  {
    const pattern = [RAIN_FULL, CLEAR, { type: 'snow', intensity: 0.5 }, CLEAR, RAIN_BYTE_1, CLEAR, CLEAR, RAIN_HALF, CLEAR, CLEAR, CLEAR];
    const r = rig(mod);
    let moistureInRange = true;
    let rainIsByte = true;
    for (let t = 0; t < 200; t += 1) {
      r.queue.push(pattern[t % pattern.length]);
      r.sim.step(t, {});
      if (r.sim.moisture < 0 || r.sim.moisture > CONFIG.maxMoisture) moistureInRange = false;
      if (!Number.isInteger(r.sim.rain) || r.sim.rain < 0 || r.sim.rain > 255) rainIsByte = false;
    }
    rec.check('property: moisture stays within 0..maxMoisture for 200 ticks', moistureInRange, true);
    rec.check('property: rain stays an integer byte for 200 ticks', rainIsByte, true);
  }
}

function conclude(report) {
  const summary = `${report.checks - report.failed}/${report.checks} checks passed`;
  let result;
  if (report.fatal !== null) result = `RESULT: FAIL ${report.fatal}`;
  else if (report.checks === 0 || report.failed > 0) result = `RESULT: FAIL (${summary})`;
  else result = `RESULT: PASS (${summary})`;
  const header = [
    `witness=fireWeather label=${report.label}`,
    `module=${report.modulePath}`,
    `module_sha256=${report.moduleSha}`,
    'source=none: deterministic integer module (no Math.random, no Date); expectations are fixed values',
    `config=${Object.entries(CONFIG).map(([k, v]) => `${k}:${v}`).join(' ')} (explicit fixture)`,
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
      fs.appendFileSync(report.log, `${new Date().toISOString()} fireWeather label=${report.label} exit=${exitCode} ${result} out_sha256=${wrote ? sha256(text) : 'none'} module_sha256=${report.moduleSha}\n`);
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
  const report = { label: 'unlabelled', modulePath: 'n/a', moduleSha: 'n/a', fatal: null, body: [], checks: 0, failed: 0, out: null, log: null };
  if (opts.error) {
    report.fatal = opts.error;
    return conclude(report);
  }
  report.label = opts.label ?? 'unlabelled';
  report.log = opts.log ? path.resolve(opts.log) : null;
  report.out = opts.out ? path.resolve(opts.out) : null;
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
  if (typeof mod.createFireWeather !== 'function') {
    report.fatal = 'module does not export createFireWeather';
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
