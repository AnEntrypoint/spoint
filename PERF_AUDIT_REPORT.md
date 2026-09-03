# Performance Audit: Vegetation & Terrain Rendering on Mobile iGPU

---

## 2026-06-29 CORRECTION (live re-measurement on a REAL GPU)

The original 2026-06-21 audit ran headless with `--disable-gpu` (SwiftShader software raster),
which it itself flagged as artificially suppressing throughput. Re-measured on 2026-06-29 against
a REAL AMD Radeon GPU (ANGLE D3D11, the exact mobile-iGPU target class) via
`scripts/perf-planet-witness.mjs` + `scripts/perf-profile-witness.mjs`. Findings:

- **Baseline (real GPU, steady state, 240-sample ring): ~12-14 ms/frame (~72-85 fps), p50 11-14 ms.**
  The app already clears 30 fps comfortably on real hardware. The "12.7 fps" headless number was a
  pure SwiftShader artifact.
- **Terrain raymarching is NOT the bottleneck -- hypothesis REFUTED.** The planet draw dispatch
  (`__terrain.planet.frame`, the per-pixel fBm raymarch submit) wraps to **0.2-0.3 ms CPU/call**.
  Toggling `window.__vdrsScale` live across 1.0 / 0.75 / 0.5 produced NO measurable frame-time
  delta -- the run-to-run variance (11.6 vs 13.8 ms at the same vdrsScale=1.0) exceeded any scale
  effect. Adaptive renderScale would buy nothing; the earlier 0.75 default was already reverted in
  TerrainBackdrop.js for the same reason ("the real OOM was the streaming-spiral infinite loop").
- **What the planet actually costs (CPU profile, real source):** the spikes (p99 ~68 ms, max ~104 ms)
  come from mapspinner terrain TEXTURE STREAMING -- `loadSurfaceTextures` (gl-render.js:569, 6.1%),
  `texSubImage2D` (7.5%), `readPixels` (3.5%), `delin` (gl-render.js:593) -- all inside
  `node_modules/mapspinner`, not the client. Not a per-pixel-fBm fragment cost.
- Client-side hot nodes are small and already optimized: BVH frustum cull
  (`intersectsBoxMask`/`isIntersected`, ~4% combined) and placement noise (`vnoise3`, 2%).
- The vegetation system was independently confirmed well-optimized in the original 2026-06-21 pass.

**Conclusion: no confident client-side speedup exists.** Terrain raymarching is cheap, and the
remaining streaming spikes live in mapspinner (out of scope here). No code change was made on
2026-06-29; the original audit's leading adaptive-renderScale recommendation is retracted as
measurement-refuted.
