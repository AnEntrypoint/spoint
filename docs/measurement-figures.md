# Measurement figures

Home of every measured number, static count, and refutation recorded for spoint. `AGENTS.md` keeps the rules that govern how measurements are taken; this file keeps the figures, their instruments, and what replaced what.

Tags on every entry (`[W:unspecified]` means the source records no commit; `[STRUCK]` means the number is no longer quoted, and the section names its replacement; `[AWAITING-RE-DERIVATION]` means the figure is kept but waits for a re-derivation on a fixed instrument):

- `[STAT:...]` the statistic that produced the number. `static` and `count` are code-derived, not timed. Per-pass percentiles and per-pass averages are INVALIDATED; see section 0.
- `[INSTR:name]` the instrument or script that produced it. `UNSOURCED-INSTR` means no instrument is recorded in the source.
- `[ADAPTER:AMD iGPU|NVIDIA|none]` the GPU the number came from. `none` means the figure is not adapter-dependent.
- `[RES:...]` the resolution, where recorded.
- `[W:sha]` the commit the figure is witnessed at, where recorded.
- `[LANDED]`, `[STRUCK]`, `[REFUTED]`, `[PLANNED]`, `[UNBUILT]` for status.
- `[UNSOURCED]` a figure whose provenance (instrument, session, or commit) could not be established from the repository. It is kept, not removed, and it is not to be quoted as a measurement.

No per-pass GPU timing is quotable as a GPU-bound measure. Section 0 holds every figure that rests on one.

## 0. INVALIDATED: per-pass p50Ms and its derivatives

Reason: the GPU-pass instrument's per-pass `p50Ms` statistic is not usable as a GPU-bound measure in either direction. Instrument lane a368d997 tested the read-before-resolve hypothesis and refuted it: unresolved = 0 in every arm. It also found a bimodal near-zero mode on both the 30 fps and the 60 fps arms. Its acceptance bar failed: the fast-arm ctx0 p50 stayed at 0.1311, and the slow-arm p50 moved from 0.5243 to 2.5559. Its conclusion is that the per-pass statistic cannot be read as GPU time in either direction.

Witness for every entry below: the instrument-lane counts from a368d997 as quoted in its report. Those counts are not stored in this repository; the lane id is the only reference. Every figure in this section is INVALIDATED: do not quote it, rank arms by it, or build a fit on it until a re-derivation on a fixed instrument replaces it.

- `[STAT:p50] [INSTR:perf-run.mjs --gpu-passes] [ADAPTER:AMD iGPU] [RES:1080p] [INVALIDATED]` the per-pass `p50Ms` collapses toward 0 on any arm that leaves the GPU-bound regime. ctx0 p50 0.131 ms against p95 26.35 ms; p50/p95 0.00-0.63 on 9 of 11 AMD WebGPU arms. Granularity is 65.5 us, so a 0 duration means UNWRITTEN, not free: ctx=4 reads p50 0 in healthy arms too. `?gpuhide=` and `?lightplanet` arms always leave the regime; `?gpuab=` arms never do (both phases GPU-bound, p50/p95 0.81-0.83).
- `[STAT:p50] [INSTR:perf-run.mjs --no-walk] [INVALIDATED]` the static arm (`--no-walk`) reads ctx0 p50 0.1311 ms against a 33.22 ms wall frame. The silent-no-op example in AGENTS.md uses this figure. The instrument lane shows the fast-arm ctx0 p50 stays at 0.1311 after its change.
- `[STAT:avg] [ADAPTER:AMD iGPU] [W:52b09a09] [INVALIDATED]` per-pass `avgMs` is DRAIN-BIASED 25-36% low. Per-pass averages from before `52b09a09` are not re-derived and are not quotable.
- `[STAT:p50] [ADAPTER:AMD iGPU] [INVALIDATED]` AMD absolute ctx0 is SESSION-LOCAL: 15.93 ms and 24.77 ms at 1080p across sessions. The values rest on the INVALIDATED statistic.
- `[STAT:p50] [ADAPTER:NVIDIA] [INVALIDATED]` NVIDIA absolute ms were not comparable across sessions: a 2.3x shift against its own 5.18 ms control. The NVIDIA per-arm split did not close additively (terrain+sky 9.9 ms > planet 8.6 ms).
- `[STAT:p50-derived] [ADAPTER:AMD iGPU, NVIDIA] [INVALIDATED]` the p50-derived ratio, planet = 8.6 of 11.0 ctx0 on NVIDIA (78%) and the same 78% on AMD. The ratio rested on the INVALIDATED statistic and is withdrawn with it.
- `[STAT:p50] [INSTR:perf-run.mjs] [INVALIDATED]` AMD noise is +-1.3 ms with the planet ON and +-0.2 ms with the planet OFF. The noise bands were taken on the INVALIDATED statistic.
- `[INSTR:contention gate, script not named in source] [LANDED] [INVALIDATED]` the contention gate needs a GPU-bound control page. It refuses on no cadence, floor unreached, quantum at 1.5x its own p50, or before/after >1.25x. The gate's p50 threshold rests on the INVALIDATED statistic. No capture writes a slower baseline unless `--accept-slower=<reason>` is passed.
- `[ADAPTER:AMD iGPU] [INSTR:host-contention] [INVALIDATED]` slow AMD capture is the shared-box signature. One page read 392.76 ms p50 at 720p, 59.97 ms at 64x64, and 13.10 ms back at 720p on identical draw calls. The quiet-window range of 22.55-24.08 ms was taken on the same statistic. `scripts/lib/host-contention.mjs` cannot see the contention because it is GPU-side.
- `[STAT:p50] [ADAPTER:AMD iGPU] [INSTR:unrecorded] [INVALIDATED]` the quiet-window AMD range is 22.55-24.08 ms (contended readings: the host-contention entry above).
- `[STAT:p50-derived] [ADAPTER:AMD iGPU] [RES:1080p] [W:52b09a09] [STRUCK] [INVALIDATED]` the per-stage split taken with `?gpuhide=`: sky 1.38, trees 0.33, grass 0.33, rocks 0.10, residual 1.90, ctx2 shadow 0.131, ctx1 composite 0.393. Struck: the method priced real stages below zero in the same arms. Sky -0.852 ms at 1080p p50, water -0.689 ms at 1080p mean, terrain -2.294 ms at 720p and -0.655 ms at 480p. A hide-differential cannot support a positive intercept.
- `[STAT:p50-derived] [ADAPTER:AMD iGPU] [INSTR:?gpuhide=terrain,water] [INVALIDATED]` the hide-differential puts the whole fixed floor on terrain. Cutting terrain geometry about 80% (`__maxLevel` 11 -> 2, about 41k -> about 8k vertices) moved ctx0 +0.26 ms and +0.45 ms (about 0.2x noise) while CPU frame wall halved 33.07 -> 16.70 ms. Not established: whether the 6.27 ms floor is itself an artifact of the INVALIDATED statistic.
- `[STAT:p50-derived] [ADAPTER:NVIDIA] [RES:1080p] [INVALIDATED]` planet = 8.6 of 11.0 ctx0 ms (78%).
- `[STAT:p50-derived] [UNSOURCED] [INVALIDATED]` vegetation costs 0.33 ms with the planet on and 3.21 ms with it off, on the same about 130k triangles. Never quote one cost without the planet state. Superseded by the in-run A/B in section 5, which is awaiting re-derivation.
- `[STAT:p50] [INSTR:ctx0 resolution sweep] [ADAPTER:AMD iGPU] [STRUCK] [INVALIDATED]` ctx0 = 6.607 + 8.665·Mpx, R^2 0.9904. This is the p50 fit. Struck with the statistic it rests on.
- `[STAT:mean] [ADAPTER:AMD iGPU] [INSTR:ctx0 resolution sweep] [INVALIDATED]` the same arms by mean give `1.31 + 8.06·Mpx`. The mean is a per-pass average, so this fit is INVALIDATED with the p50 fit.
- `[STAT:p50-derived] [ADAPTER:AMD iGPU] [INVALIDATED]` 4.00x fewer pixels moved ctx0 13.11 ms, but 6.61 ms (26.7%) did not scale with pixels. Not established as fixed cost; see section 3 and section 13.
- `[STAT:p50-derived] [ADAPTER:AMD iGPU] [RES:720p] [INVALIDATED]` the terrain geometry ladder: `maxLevel` 11 -> 18 adds 2064 triangles and moves ctx0 -0.43 ms. 11 -> 2 removes 30,779 of 282,794 triangles and drops mean/frame 18.284 -> 9.696 ms, but renders a much coarser surface and ran at 59.7 fps (p50 collapsed). At the A/B rate (about 60k foliage triangles = 0.20 ms), 30.8k triangles cannot be worth 8.6 ms, or the remaining 252k would cost 70 ms. Un-re-derived: the 2/6/11/16/22 ladder never got the adapter.
- `[STAT:p50 p95] [ADAPTER:AMD iGPU] [RES:1080p] [INVALIDATED]` the arm condition of the in-run A/B in section 5: both phases at 30 fps with p50/p95 0.81-0.83. The sub-ms foliage figure in section 5 is kept as AWAITING-RE-DERIVATION; the arm condition it was taken under is this INVALIDATED statistic.
- `[STAT:p50] [ADAPTER:AMD iGPU] [W:unspecified] [INVALIDATED]` ctx2 p50 0.131-0.262 ms on every arm (shadow-pass timings, per-pass).
- `[STAT:p50] [ADAPTER:AMD iGPU] [INSTR:perf-run.mjs --gpu-passes --extra=gputime=1] [INVALIDATED]` at 1080p, GPU p50 25.36 ms against 15.88 ms CPU: GPU-bound. NVIDIA 5.18 ms, vsync-locked, NOT GPU-bound. The GPU-bound verdict rested on the INVALIDATED statistic.
- `[STAT:p50] [ADAPTER:AMD iGPU] [INSTR:frame-time statistic] [INVALIDATED]` the frame-time arm needs an accelerated runner; a software rasterizer cannot reach the gate floor. Vsync-locked p50 is the refresh divisor, not the work; `frame-time-gate.mjs` unlocks rAF. Withdrawn with the p50 statistic it names.

## 1. Instrument caveats

- `[INSTR:frame-time-gate.mjs:36]` no `perf-run.mjs` instrument unlocks vsync. `--disable-frame-rate-limit --disable-gpu-vsync` exist only in `frame-time-gate.mjs:36`, behind `UNLOCK_RAF`. Arms idle into the vsync cap otherwise.
- `[INSTR:perf-run.mjs]` `info.render.calls` is CUMULATIVE and is the only reliable liveness signal; `drawCalls` and `.triangles` read 0 on the measured backend.
- `[INSTR:perf-run.mjs drawsInstrument.authoritativeField]` the authoritative draw count is that field. `vegProfile.meshInstances` is absent on `WebGPULodInstancer`.
- Per-pass timing statistics (percentiles, averages, the contention and noise bands) are INVALIDATED; their entries are in section 0.

## 2. Frame-time baselines

- `[STAT:frame-time] [ADAPTER:AMD iGPU] [INSTR:frame-time-gate.mjs] [W:ee756369]` AMD baseline 18.39 ms.
- `[STAT:frame-time] [ADAPTER:NVIDIA] [INSTR:frame-time-gate.mjs] [W:76059b48]` NVIDIA baseline 9.03 ms.
- Baselines are per-vendor. Another adapter's baseline is refused, and an unbaselined vendor fails loudly.

## 3. GPU pass split and stage costs

The per-stage split, the NVIDIA planet ratio and the hide-differential were moved to section 0 as INVALIDATED.

- `[STAT:p50-derived] [ADAPTER:AMD iGPU] [STRUCK]` `terrain = 6.27 + 4.34 x Mpx`, i.e. "9.00 ms fragment + 6.27 ms fixed at 1080p". Struck in 55cd0199 for the same reason: the fit has a negative-priced stage, so its intercept is not supported. Replacement: terrain is about 12.8 of 18.3 ms ctx0 at 1080p (70%, about 6.1 ms per Mpx), with the intercept at or below noise. The replacement figure rests on the INVALIDATED statistic (section 0) and is not quotable until re-derived; the refutation itself stands.

## 4. Resolution sweep

Both fits and the non-scaling remainder were moved to section 0 as INVALIDATED.

- `[INSTR:perf-run.mjs] [PLANNED → REFUTED-HYPOTHESIS]` the GPU-pass instrument change was to classify each timestamp query as `resolved`, `unresolved`, `inverted` or `unverified`, tallying only resolved ones, and to replace the `setInterval` drain with an rAF pump and a modal per-frame filter, targeting queries read before they resolve. Instrument lane a368d997 refuted that hypothesis: unresolved = 0 in every arm. No fix landed. The per-pass statistic stays INVALIDATED (section 0). `scripts/perf-run.mjs` is modified and uncommitted in another lane's worktree, so no figure here depends on it.

## 5. In-run A/B and planned instruments

- `[ADAPTER:AMD iGPU] [RES:1080p] [LANDED] [AWAITING-RE-DERIVATION]` healthy in-run A/B REPLACES the unresolved vegetation pair (0.33 ms planet-on vs 3.21 ms planet-off, both in section 0). `?gpuab=__vegAllOff` with both phases at 30 fps gives foliage about 0.20 ms. The pair was two collapsed arms differenced, not a planet-state effect. The arm condition the figure was taken under is INVALIDATED (section 0); the figure itself waits for a re-derivation on a fixed instrument.
- `[INSTR:TerrainBackdrop.js] [PLANNED] [UNBUILT] [AWAITING-RE-DERIVATION]` decided: no in-run A/B gates terrain yet. Add a per-frame reader in `client/core/TerrainBackdrop.js` (outside the protected tsl tree) that sets `planet.mesh.visible = !window.__terrainOff`, then run `?gpuab=__terrainOff` at 1080p, 720p and 480p. A/B keeps both phases GPU-bound, which is the only way to separate slope from intercept. `__terrainOff` has no reader in the tree as of this file. This instrument is built on the INVALIDATED per-pass statistic and needs a fixed instrument first.
- `[RES:2560x1440] [ADAPTER:AMD iGPU]` unrunnable: the page wedges on `Runtime.evaluate`, arms exit 1, and `--cdp-timeout=120000` does not rescue it. Only `?lightplanet` completed there.
- `[INSTR:RenderControls registry audit] [STAT:static] [LANDED]` the registry classification, NOT a live-page witness: 35 keys are read only from `gl-render.js` and `planet-orchestrator.js`, reachable solely through `?legacygl=1` (`app.js:190-193`, `TerrainBackdrop.js:46-47`). `--knob` on any of them writes a global nobody consumes and reports a clean null result. Only `splitFactor`, `maxLevel`, `distFactor`, `geomorphLod` and `wetness` live on the default path. `fsCheap`, `vsCheap`, `octMax`, `fsDetailOcts`, `nrmStepM` and `waterVisGate` are legacy-only (`fsCheap` read only at `gl-render.js:619`).
- `[STAT:static] [INSTR:scripts/lib/verify-doc-claims.mjs, reader index over git-tracked files]` the current-tree readers for the legacy-only keys: `vsCheap` at `packages/mapspinner/src/gl-render.js:619`, `octMax` at `:624`, `fsDetailOcts` at `:630`, `waterVisGate` at `:1560`. Each reads `window.__<key>`, the global that `RenderControls` installs (`globalName = '__' + key`). `fsCheap` has 15 consumer sites, including TSL ones (`planet-tsl.js:260`, `terrain-material-tsl.js:86,194,195`). The legacy-only classification above stands for the first four; `fsCheap` is not legacy-only.
- `[STAT:static] [INSTR:RenderControls registry] [STRUCK]` `elevEdgeInset` has no runtime consumer. The documented reader `gl-render.js _collectElevEdgeSample` does not exist; the only hits are `terrain-gen-controls.js:45` and `:86` (the mapspinner demo panel writing and rereading it), and the registry declaration itself (`RenderControls.js:226`). `_collectElevEdgeSample` appears only in a docstring (`RenderControls.js:227`).
- `[STAT:static] [LANDED] [INSTR:RenderControls registry]` `dprAuto` and `dprOff`: `createDprController` in `client/core/FrameMetrics.js:134` reads `RenderControls.get('dprAuto')` and `RenderControls.get('dprOff')`, landed in ad17a29a. `dprAuto` is declared with REGISTRY DEFAULT TRUE (`RenderControls.js:11`), so an un-knobbed run enables adaptive pixel ratio on the measuring instrument itself. `target` equalled the nominal viewport in every arm measured so far, so it has not bitten. Pass `--knob=dprOff=true`; `--knob` readback can itself time out on heavy pages.
- `[STAT:static] [REFUTED]` the earlier AGENTS.md statement that `window.__dprAuto` was "never installed" is refuted: `client/hud/SettingsMenu.js:166` and `:175` write it (`window.__dprAuto = v` / `= values.dprAuto`). Nothing in the tree reads `window.__dprAuto` on the live path. The earlier "in flight" status of the FrameMetrics edit is refuted by ad17a29a, which landed it.
- `[INSTR:perf-run.mjs] [STAT:static] [W:uncommitted]` `?gpuabms=` WAS inert through `3384c0613f`, not merely dropped by the CLI. `perf-run.mjs:277` (at 55cd0199) sits inside the `GPU_PASS_ARM_SRC` untagged template literal (opened at `:261`). A lone `\d` in an untagged template literal evaluates to `d`, so the regex reached the page as `(d+)`, never matched, and `abPhaseMs` was always 5000. The on-disk source read `\d+`, so review could not see it. The fix is writing `\\d+` inside the template literal, which the page receives as `\d+`. Its landing belongs to another lane (recorded at `:301` in its uncommitted tree), so re-check the escape before the flag is trusted. `?gpuab=<name>` was never affected.
- `[INSTR:perf-run.mjs] [STAT:static]` the knob audit that informs the `?knob` rules in AGENTS.md: keys are registry `key`s verbatim (`maxLevel`, not `__maxLevel`). Range limits: `maxLevel` 2..22, `splitFactor` >= 0.05.

## 6. Terrain cost sizing and the struck 6 ms

- `[STAT:sizing] [REFUTED] [ADAPTER:AMD iGPU]` "There is no 6 ms fixed terrain cost to remove", ruled out with sizes, not timings:
  - No per-frame compute dispatch. `planet-tsl.js:232-270` writes uniforms only. The one compute, `createHeightProbeTSL` (`packages/mapspinner/src/tsl/height-probe-tsl.js`), is constructed at `planet-tsl.js:287` and consumed by `gpu-eval.mjs`, never the render loop.
  - No fixed-resolution terrain target. `planet-tsl.js:117` sets `castShadow=false`, so terrain contributes zero shadow passes. The per-pass shadow timings on every arm are INVALIDATED (section 0).
  - The unconditional per-frame attribute upload at `planet-tsl.js:193-194` is sized by live quad count `n`: 20n bytes, about 2.5 KB at n=127 and 40 KB at capacity 2048, three orders under the 6 ms.
- `[STAT:count] [INSTR:static] [ADAPTER:none]` the "6 ms" intercept was struck in section 3; this section is the reason the removal candidate was ruled out, not a timed proof.
- `[STAT:count] [INSTR:static]` `planet-tsl.js:193-194` attribute upload sizing as above.

## 7. Per-pixel and per-vertex counts (static, live TSL path)

- `[STAT:count] [INSTR:static] [ADAPTER:none]` LAND = 9 `snoise3` (about 900 ALU) + 19-31 fetches, 12-24 triplanar from a 1024^2 4-layer RGBA8 mip set at `anisotropy = 8` (about 43 MB, past an iGPU cache). WATER = 77-107 `seaOctave` (about 5-7k ALU) = 5-7x terrain per pixel, yet measured about 0 because terrain occludes it. VS = 240 `snoise3` per vertex (`FD_TAPS` 5).
- `[STAT:count] [INSTR:static]` `terrain-lighting-tsl.js` gates `sky.marchRadiance` on `apGate > 0` (`e233212d`). The gate drops march ALU and its 6 LUT fetches per terrain pixel (`sky-tsl.js:89`). `mix(lit, hazed, 0) === lit`, so the result is bit-identical.
- `[STAT:count] [INSTR:static]` `texFarFade > 0.001` (`surface-splat-tsl.js:133`) buys 12-24 fetches for a 0.001 contribution.
- `[STAT:count] [INSTR:static] [UNSOURCED]` dead per-pixel taps: `octFarFade` saturates at `reliefScale` 0.1, and only 6 fetches are removable. `surface-splat-tsl.js:116` already gates `gFar` fetches, and `albNear`'s 3 taps feed `disp` into `pool`/`finger`. `bandWarp` is NOT dead: `texFarFade` holds on about 100% of terrain pixels, so hoisting it saves ~0.
- `[STAT:count] [INSTR:static]` legacy-vs-TSL: `terrain.glsl` mixes the raw interpolated vertex normal while TSL normalizes first. `reliefShade` 6 amplifies 0.53/0.73 into a 3.11/5.67 delta.
- `[STAT:count] [INSTR:static]` `invertAcesFilmic` example: saturated blue inverts to (-0.034, 0.346, 1.395), outside the AP1/ACES gamut. Clamping re-encodes 82.7 vs 55.9.
- `[INSTR:witness] [W:unspecified]` the sea radius (sphere R == `PlanetFrame.waterlineLocalY` to 1 cm) and zero-mean waves are the AGENTS.md invariant; the 1 cm figure is the tolerance recorded at that witness.

## 8. Parity witness figures

- `[STAT:mean] [INSTR:WebGPU TSL-vs-legacy parity witness] [UNSOURCED-INSTR]` same-code floor: same code vs itself = 0.470 meanAbs/channel and 86.72% exact pixels. Post-change: 0.467 and 87.46%. The 13% of pixels that differ is not drift. The floor is established before any cross-renderer comparison.
- The region-match threshold is cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR`), as stated in AGENTS.md.

## 9. Terrain height backends and sample rates

- `[STAT:mean/max] [INSTR:height-backend comparison] [UNSOURCED-INSTR]` v2 mean 0.001 m, max 0.005 m. v1 mean 1.288 m, max 2.840 m. The v2 backend is the parity backend; the carves are v2-only.
- `[STAT:count] [INSTR:Weather.js] [W:unspecified]` snow resamples only after more than 0.1 m of drift (`SNOW_GROUND_RESAMPLE_DRIFT_M`). The counted effect is 229 -> 46 samples per update.

## 10. Netcode figures

- `[STAT:count] [INSTR:CollisionSystem applyPlayerCollisions] [UNSOURCED-INSTR]` client peer separation: 0.1943 and 0.2049 corrections per ack, against 0.7422 without the separation. The separation is the AGENTS.md win; these are its measured correction counts.

## 11. Frame cost of the app runtime

- `[STAT:median] [ADAPTER:AMD iGPU] [INSTR:tps-game boot timing] [W:3384c0613f]` boot-to-playable median 12623 -> 11622 ms after `Grass.prewarm` budgets work (macrotask yield every 24 ms, reports `prewarmMs`, `prewarmWorkMs`, `prewarmChunks`). rAF was the wrong yield: display-owned and throttled in a hidden tab. This is a wall-clock boot median, not a per-pass GPU figure, so the section 0 finding does not apply to it.

## 12. Rules and figures from the witnessing discipline (moved from AGENTS.md)

- Every named GPU arm pins its adapter with `vendorGpuArgs(vendor)` (`--use-adapter-luid=0,<luid>`). `gpu-probe.mjs gpuLaunchArgs()` does NOT. Pinning is necessary, NOT sufficient: Chrome ignores an unresolvable LUID while reporting accelerated, so the renderer string must be asserted.
- `[STAT:none] [ADAPTER:AMD iGPU] [W:unspecified] [REFUTED]` AMD iGPU does not lose GPU context at boot. The hang was `probeGpu()` minting a fresh WebGL2 context inside the measured page. It now reads `window.__rendererInfo`.
- `[ADAPTER:AMD iGPU] [W:unspecified]` AMD iGPU DOES expose `timestamp-query`. `--gpu-passes --extra=gputime=1 --backend=webgpu` works after `npm run build:client`, which is required or the run is FATAL. The GPU-bound verdict and the NVIDIA vsync-locked reading were taken on the per-pass statistic: INVALIDATED (section 0).
- `[ADAPTER:AMD iGPU]` a frame-time verdict on AMD needs a quiet window. The `gpulock` serializes the adapter only, never the CPU.
- `[INSTR:prediction-drift-witness.mjs] [STAT:count]` diagnostic defaults: peak unacked 24, divergence 3 m, last 5 samples under `--settle-tol` 0.5 m. At `--server-tick=10` the floor is one 100 ms step, so raised caps are needed.
- `[INSTR:CDP] [STAT:count]` keyboard input sets `input.backward`, never `input.back`. `[physics] peak active 0` does not mean a stalled player: `CharacterVirtual` is never counted by `GetNumActiveBodies()`.

## 13. Open questions the file records and does not answer

- Whether the 6.27 ms terrain floor is an artifact of the INVALIDATED per-pass statistic. Unresolved until a re-derivation on a fixed instrument.
- The 2/6/11/16/22 `maxLevel` ladder has no adapter measurement.
- Whether the resolution-sweep non-scaling part (6.61 ms at 1080p) is fixed cost. Unresolved under the INVALIDATED statistic.
- Whether any re-derived number from a fixed GPU-pass instrument agrees with the struck figures. Unresolved until that instrument exists.
- `tc3-*` rows: the coordinator's update names a `tc3-*` set of per-pass figures in AGENTS.md. Neither this file nor the baseline 55cd0199 AGENTS.md contains any `tc3` token; the set was not located and is not invalidated here.
