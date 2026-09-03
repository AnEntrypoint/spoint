#!/usr/bin/env node
// measure-fps.mjs — reproducible steady-state FPS measurement for the stress demo.
//
// Loads stress.html in headless Chromium, spawns a fixed entity count, warms up,
// then samples window.__pool.getStats().fps and reports median/min/max to JSON.
// This replaces the scattered ad-hoc profiling scripts and gives every
// optimization a real number to be witnessed against (not narration).
//
// Usage:
//   node examples/local-progressive/measure-fps.mjs                 # 500 and 1000
//   node examples/local-progressive/measure-fps.mjs 1000            # just 1000
//   node examples/local-progressive/measure-fps.mjs 500 1000 2000   # custom set
//
// Assumes the dev server is already serving stress.html on PORT (default 5180).
// Start it with: node examples/local-progressive/serve.mjs
//
// IMPORTANT — renderer caveat: Playwright's bundled Chromium headless launch
// falls back to SwiftShader (software rasterizer, ANGLE/Vulkan) by default in
// many environments (~50s cold-shader-compile + single-digit FPS regardless of
// the optimizations under test). Default here is now `--use-angle=d3d11
// --use-gl=angle` (real GPU driver via ANGLE, no system Chrome install
// required) -- on a real Windows/AMD dev machine this measured a ~40% faster
// world-ready time (28-30s vs 47-52s) than the SwiftShader path, AND reports
// real hardware FPS instead of a software-rasterizer number. Only relevant on
// Windows/Linux with a real GPU driver; harmless no-op elsewhere (ANGLE falls
// back). Override with ANGLE=swiftshader for a portable/deterministic run, or
// CHANNEL=chrome to use the installed system Chrome instead of bundled
// Chromium (its own default GPU policy, independent of these ANGLE args).
// The `renderer` field in the JSON output tells you which path you got
// (look for "SwiftShader" = software vs a real GPU name = hardware).
// Also: run with no other GPU-heavy browser tab open — two contexts sharing
// one GPU will tank the numbers for both.

import { chromium } from '../../../../scripts/lib/cdp-browser.mjs';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 5180;
// 127.0.0.1 (not "localhost"): under CHANNEL=chrome, Playwright's localhost
// resolution intermittently stalls page.goto even though the server is up.
// ?assets=local is MANDATORY for benchmarking: since the SDK-packaging commit
// the demo defaults to streaming baked models CROSS-ORIGIN from the public host,
// which never reaches instanced/BatchedMesh steady state within the warmup window
// (far-LOD geometry never lands in geoCache, so every entity renders as its own
// plain Mesh draw). ?assets=local streams from the dev server so the far tier
// warms and we measure the real engine, not cold cross-origin streaming.
// Override with ASSETS=<url|remote> if you specifically want to bench a host.
const ASSETS = process.env.ASSETS || 'local';
const STRESS_URL = `http://127.0.0.1:${PORT}/stress.html?assets=${encodeURIComponent(ASSETS)}`;
// Args are entity counts, or the literal "all" to spawn every distinct model.
const ARGS = process.argv.slice(2);
const COUNTS = ARGS.map((a) => (a === 'all' ? 'all' : Number(a))).filter((n) => n === 'all' || n > 0);
const ENTITY_COUNTS = COUNTS.length ? COUNTS : [500, 1000];
const WARMUP_MS = 30000;   // MAX warmup; exits early once streaming quiesces
const SAMPLE_COUNT = 40;
const SAMPLE_GAP_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureOne(page, n) {
  // STRESS_URL already carries ?assets=…, so the cache-bust joins with '&'.
  await page.goto(`${STRESS_URL}&cb=${Date.now()}`, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.__pool && window.__pool.getStats, { timeout: 30000 });
  // n === 'all' clicks the spawn-all-distinct-models button; otherwise spawn the
  // requested count by clicking the closest data-n presets repeatedly.
  if (n === 'all') {
    await page.waitForFunction(() => document.getElementById('spawn-all'), { timeout: 5000 });
    await page.evaluate(() => document.getElementById('spawn-all').click());
  } else {
    await page.evaluate((target) => {
      const btns = [...document.querySelectorAll('#panel button[data-n]')]
        .map((b) => ({ b, n: +b.dataset.n }))
        .sort((a, z) => z.n - a.n);
      let remaining = target;
      while (remaining > 0 && btns.length) {
        const pick = btns.find((x) => x.n <= remaining) || btns[btns.length - 1];
        pick.b.click();
        remaining -= pick.n;
      }
    }, n);
  }
  // Adaptive warmup: wait until the entity count has reached the target AND
  // asset streaming has quiesced (deferred-queue inFlight==0 and entity count
  // stable for a few checks). A fixed sleep samples mid-stream on a cold cache
  // and reports cold-load FPS, not steady state.
  const warmupStart = Date.now();
  let stableChecks = 0, lastEntities = -1;
  while (Date.now() - warmupStart < WARMUP_MS) {
    const st = await page.evaluate(() => {
      const s = window.__pool.getStats();
      return { entities: s.entities, inFlight: s.deferredLoading?.inFlight ?? 0, queued: s.deferredLoading?.queued ?? 0 };
    });
    // For a numeric target, require entities >= target; for 'all', just require
    // the count to have stopped growing (entities === lastEntities).
    const reachedTarget = n === 'all' ? st.entities > 0 : st.entities >= n;
    const settled = reachedTarget && st.inFlight === 0 && st.queued === 0 && st.entities === lastEntities;
    stableChecks = settled ? stableChecks + 1 : 0;
    lastEntities = st.entities;
    if (stableChecks >= 4) break; // ~2s of stability
    await sleep(500);
  }
  // A short post-stability settle so the adaptive FPS EMA reflects steady state.
  await sleep(1500);
  const samples = await page.evaluate(async (cfg) => {
    const out = [];
    for (let i = 0; i < cfg.count; i++) {
      out.push(window.__pool.getStats().fps);
      await new Promise((r) => setTimeout(r, cfg.gap));
    }
    return out;
  }, { count: SAMPLE_COUNT, gap: SAMPLE_GAP_MS });
  const stats = await page.evaluate(() => window.__pool.getStats());
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    requested: n,
    entities: stats.entities,
    distinctAssets: stats.assets,
    visible: stats.visible,
    far: stats.far,
    drawCalls: stats.drawCalls,
    medianFps: +median.toFixed(2),
    avgFps: +avg.toFixed(2),
    minFps: +samples[0].toFixed(2),
    maxFps: +samples[samples.length - 1].toFixed(2),
  };
}

async function main() {
  // CHANNEL=chrome uses the installed system Chrome (hardware GPU on most
  // machines) instead of Playwright's bundled Chromium. Otherwise default the
  // bundled Chromium's own GPU backend to real ANGLE/D3D11 (fast, real FPS)
  // instead of its SwiftShader fallback; ANGLE=swiftshader opts back into the
  // slow-but-portable software path deliberately.
  const angle = process.env.ANGLE || 'd3d11';
  const launchOpts = { headless: true, args: angle === 'none' ? [] : [`--use-angle=${angle}`, '--use-gl=angle'] };
  if (process.env.CHANNEL) launchOpts.channel = process.env.CHANNEL;
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    console.warn(`[measure-fps] launch with channel="${process.env.CHANNEL}" args=${JSON.stringify(launchOpts.args)} failed (${e.message}); falling back to bundled Chromium default args`);
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage();
  let renderer = 'unknown';
  const results = [];
  try {
    for (const n of ENTITY_COUNTS) {
      const r = await measureOne(page, n);
      if (renderer === 'unknown') {
        renderer = await page.evaluate(() => {
          try {
            const gl = window.__pool.renderer.getContext();
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'no-debug-ext';
          } catch (e) { return 'err:' + e.message; }
        });
      }
      results.push(r);
      console.log(`[${r.entities} entities / ${r.distinctAssets} distinct] median ${r.medianFps} FPS  (min ${r.minFps}, max ${r.maxFps}, visible ${r.visible}, far ${r.far}, draws ${r.drawCalls})`);
    }
  } finally {
    await browser.close();
  }
  const report = { ts: new Date().toISOString(), url: STRESS_URL, renderer, results };
  const outPath = fileURLToPath(new globalThis.URL('./fps-measurement.json', import.meta.url));
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('\nWrote examples/local-progressive/fps-measurement.json');
  console.log(`Renderer: ${renderer}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
