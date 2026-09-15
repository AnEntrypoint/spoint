# Performance: measured findings

Durable, re-verified performance investigations. Add a new dated section per investigation;
never a status/self-congratulation report -- only root-caused, reproducible findings and the
methodology that produced them.

## Terrain rendering on mobile-class iGPU (2026-06-29)

Real-GPU re-measurement (ANGLE D3D11, AMD Radeon -- the actual mobile-iGPU target class) via
`scripts/perf-planet-witness.mjs` + `scripts/perf-profile-witness.mjs` superseded an earlier
2026-06-21 headless (`--disable-gpu`, SwiftShader software raster) audit that had flagged terrain
raymarching as the bottleneck; that finding was a pure SwiftShader artifact and is retracted.

- Baseline on real hardware: ~12-14ms/frame (~72-85fps), p50 11-14ms -- comfortably above 30fps.
- Terrain raymarching (the per-pixel fBm raymarch, `__terrain.planet.frame`) is NOT the
  bottleneck: 0.2-0.3ms CPU/call. Toggling `window.__vdrsScale` across 1.0/0.75/0.5 produced no
  measurable frame-time delta (run-to-run variance exceeded any scale effect) -- adaptive
  renderScale buys nothing on this path.
- The real cost is mapspinner terrain TEXTURE STREAMING, not per-pixel rendering:
  `loadSurfaceTextures` (`node_modules/mapspinner` `gl-render.js:569`, 6.1% of frame),
  `texSubImage2D` (7.5%), `readPixels` (3.5%), `delin` (`gl-render.js:593`) -- all inside
  mapspinner, out of scope for a client-side fix. These streaming calls produce the p99 ~68ms /
  max ~104ms frame-time outliers, not the raymarch.
- Client-side hot nodes (BVH frustum cull, placement noise) are small (~4% and ~2% combined) and
  already optimized; vegetation was independently confirmed well-optimized in the 2026-06-21 pass.

**No confident client-side speedup exists for this path.** Re-measure on real GPU hardware (never
`--disable-gpu`/SwiftShader) before trusting any terrain-rendering perf hypothesis -- headless
software rasterization inflates frame time by an order of magnitude and misattributes the cause.
If terrain frame-time spikes recur, look at mapspinner's texture-streaming path first, not the
raymarch or `vdrsScale`.
