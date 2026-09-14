#!/usr/bin/env node

import { chromium } from '../../../../scripts/lib/cdp-browser.mjs';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 5180;
const ASSETS = process.env.ASSETS || 'local';
const STRESS_URL = `http://127.0.0.1:${PORT}/stress.html?assets=${encodeURIComponent(ASSETS)}`;
const ARGS = process.argv.slice(2);
const COUNTS = ARGS.map((a) => (a === 'all' ? 'all' : Number(a))).filter((n) => n === 'all' || n > 0);
const ENTITY_COUNTS = COUNTS.length ? COUNTS : [500, 1000];
const WARMUP_MS = 30000;
const SAMPLE_COUNT = 40;
const SAMPLE_GAP_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureOne(page, n) {
  await page.goto(`${STRESS_URL}&cb=${Date.now()}`, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.__pool && window.__pool.getStats, { timeout: 30000 });
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
  const warmupStart = Date.now();
  let stableChecks = 0, lastEntities = -1;
  while (Date.now() - warmupStart < WARMUP_MS) {
    const st = await page.evaluate(() => {
      const s = window.__pool.getStats();
      return { entities: s.entities, inFlight: s.deferredLoading?.inFlight ?? 0, queued: s.deferredLoading?.queued ?? 0 };
    });
    const reachedTarget = n === 'all' ? st.entities > 0 : st.entities >= n;
    const settled = reachedTarget && st.inFlight === 0 && st.queued === 0 && st.entities === lastEntities;
    stableChecks = settled ? stableChecks + 1 : 0;
    lastEntities = st.entities;
    if (stableChecks >= 4) break;
    await sleep(500);
  }
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
