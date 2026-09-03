#!/usr/bin/env node
// perf-gate.mjs -- performance regression gate (zero deps, <80 lines)
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BASELINE_PATH = new URL('../.perf-baseline.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const THRESHOLD = 1.10;
const UPDATE = process.argv.includes('--update-baseline');

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function writeBaseline(data) {
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`[perf-gate] baseline written: ${BASELINE_PATH}`);
  console.log(JSON.stringify(data, null, 2));
}

// glsl-check now emits {ok, compiled, probe, vendor, pageErr} (no shaderCompileMs).
// The perf-cost it gates is the headless compile+warm wall time, so MEASURE that here
// and assert compiled===true with a finite probe (the shader actually built and ran).
async function runGlslCheck() {
  console.log('[perf-gate] running lab.mjs glsl-check ...');
  let stdout = '', stderr = '';
  const t0 = Date.now();
  try {
    const r = await exec(process.execPath, ['scripts/lab.mjs', 'glsl-check'], {
      cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
      timeout: 300_000,
    });
    stdout = r.stdout; stderr = r.stderr;
  } catch (e) {
    stdout = e.stdout ?? ''; stderr = e.stderr ?? '';
    console.error('[perf-gate] glsl-check failed:\n', stderr || e.message);
    process.exit(1);
  }
  const glslCheckMs = Date.now() - t0;
  const combined = stdout + '\n' + stderr;
  const jm = combined.match(/\{[\s\S]*?"compiled"[\s\S]*?\}/);
  let parsed = null;
  if (jm) { try { parsed = JSON.parse(jm[0]); } catch { /* fall through */ } }
  if (!parsed || parsed.compiled !== true) {
    console.error('[perf-gate] glsl-check did not report compiled:true:\n', combined.slice(0, 1000));
    process.exit(1);
  }
  if (typeof parsed.probe !== 'number' || !Number.isFinite(parsed.probe)) {
    console.error(`[perf-gate] glsl-check probe is not a finite number (got ${JSON.stringify(parsed.probe)}); shader compiled but did not run.`);
    process.exit(1);
  }
  console.log(`[perf-gate] compiled=true probe=${parsed.probe} vendor=${parsed.vendor}`);
  return glslCheckMs;
}

async function runParity() {
  console.log('[perf-gate] running lab.mjs parity ...');
  try {
    await exec(process.execPath, ['scripts/lab.mjs', 'parity'], {
      cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
      timeout: 300_000,
    });
    console.log('[perf-gate] parity: PASS');
  } catch (e) {
    console.error('[perf-gate] parity FAILED:\n', e.stderr || e.message);
    process.exit(1);
  }
}

async function main() {
  const glslCheckMs = await runGlslCheck();
  console.log(`[perf-gate] glslCheckMs = ${glslCheckMs}`);

  if (UPDATE) {
    writeBaseline({ glslCheckMs });
    await runParity();
    console.log('[perf-gate] baseline updated. PASS');
    process.exit(0);
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.error('[perf-gate] no baseline found. Run with --update-baseline to create one.');
    process.exit(1);
  }
  // accept the legacy shaderCompileMs key as the glsl-check wall-time baseline (same gate).
  const baseMs = baseline.glslCheckMs != null ? baseline.glslCheckMs : baseline.shaderCompileMs;
  if (baseMs == null) {
    console.error('[perf-gate] baseline missing glslCheckMs. Run with --update-baseline to refresh.');
    process.exit(1);
  }

  const limit = Math.round(baseMs * THRESHOLD);
  console.log(`[perf-gate] baseline=${baseMs}ms  limit=${limit}ms (+10%)  measured=${glslCheckMs}ms`);

  if (glslCheckMs > limit) {
    console.error(`[perf-gate] REGRESSION: ${glslCheckMs}ms > ${limit}ms (${((glslCheckMs/baseMs-1)*100).toFixed(1)}% over baseline)`);
    process.exit(1);
  }

  await runParity();
  console.log('[perf-gate] PASS');
}

main();
