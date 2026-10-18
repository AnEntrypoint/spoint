# Client graphics debugging path: shortening "render looks wrong" to a diagnosed cause

Scope: the CLI-driven client graphics debugging path in /workspace/spoint. Citations are file:line from reads on 2026-10-18. Costs are estimates unless marked measured. No timing run was performed for this note.

Tooling caveat: the gm MCP server reported `bundle_stale` (serving 0.2.128, 0.2.129 installed) and `stale_tree` (checkout 31 commits behind upstream). Codesearch results may miss remote symbols until a gm-mcp restart and `git_pull`. Restart command as printed by the server: `node "/data/cache/gm/.gm-tools/gm-mcp-server.mjs"`.

## Key question 1: fastest CLI route from a render defect to its cause today

### Takeaway
There is no single "graphics doctor" verb. The fastest route is: (1) confirm the GPU is real with `assertGpu` / `window.__rendererInfo`, (2) read the warmup record `window.__lastShaderWarmup`, (3) read the governor mirror `qualityGovernorState`, (4) use one counted instrument (`overdrawStats` or `drawsInstrument`), and only then (5) a witness. Each of these is a single page.evaluate, but each today needs its own browser launch.

### Cited findings
- `window.__rendererInfo` is set once at boot: `client/app.js:255` (`window.__rendererInfo = rendererInfo`), logged at `client/app.js:256` as `[renderer] <class> backend=<backend> gpu=<glRenderer>`. This is the cheapest single-line answer to "which renderer, which backend, which GPU".
- Renderer fallback chain is logged at `client/app.js:205-210`: WebGPU unavailable -> WebGPURenderer WebGL2 backend -> legacy WebGLRenderer. Each step is a `console.warn`, so a grep of the console on the page shows which tier actually booted.
- `probeGpu(page)` in `scripts/lib/gpu-probe.mjs:13-70` reads `window.__rendererInfo` first and only falls back to a WebGL debug-renderer query and `navigator.gpu.requestAdapter()` if it is absent. Returns `{accelerated, renderer, vendor, adapter, haystack, source}`.
- `assertGpu(page, {requireAccelerated, expectVendor})` (`scripts/lib/gpu-probe.mjs:84-94`) throws on a SwiftShader/llvmpipe haystack. Use this as the first gate in any graphics probe so a software-rendered run cannot be read as a GPU result.
- `gpuArgs({accelerated})` (`scripts/lib/gpu-probe.mjs:96-98`) selects `SOFTWARE_ARGS` (swiftshader) or `ACCELERATED_ARGS`. The `--gpu=`/`--gl=` parsing is `gpuModeFlag` (`scripts/lib/gpu-probe.mjs:108-113`). A bare `--gpu` flag is not handled there; it falls to the default.
- Warmup record: `warmupShaders` writes `window.__lastShaderWarmup` in its `_record` helper (`client/core/SceneSetup.js:378-389`). Fields include `manifestDriven`, `total`, `manifestedCount`, `residentCount`, `skipped`, `reason`, `manifestUnresolvedUrls`, `manifestUnresolvedReason`. `scripts/shader-manifest-witness.mjs:35-45` already reads it through a `PROBE` string, and `READY` at line 47 gates on it. This is the existing one-call answer to "were the entity shaders compiled before first frame".
- Governor mirror: `qualityGovernorState` (`client/core/RenderControls.js:49-50`), also `window.__qualityGovernorState`. Fields include `tier`, `shedCause` (`hitch|excursion|window|none`), `excursions`, `leafOffM`, `knobs`. A tier change that is not explained by load is answered here in one read.
- Overdraw counter: `overdraw` flag (`client/core/RenderControls.js:96-97`) plus `overdrawStats` mirror (`client/core/RenderControls.js:98-99`), `window.__overdrawProbe.counters()` gives `{passes, reads, errors}`. Counted fragments, not timed. `null` (never 0) while uncalibrated, which is the correct refusal.
- Shader-error checker: `checkShaderErrors` (`client/core/RenderControls.js:94-95`) turns on THREE `renderer.debug.checkShaderErrors`. Documented as a real GPU sync per first-use variant, debugging only.
- Shadow/cascade state: `shadowCascades` (`client/core/RenderControls.js:105-106`) is read once at boot, so a flag edit needs a reload, not a `set()`. Also `shadowCostProbeArm` (`client/core/RenderControls.js:103-104`) for the static-vs-dynamic caster split.
- `perf-run.mjs` GPU and backend selection: `GPU` flag line 36, `BACKEND` line 35 (`--backend=webgl` default), `--require-accelerated` line 66, `--expect-vendor` line 67, `--gpu-passes` line 55, `--probe-heights` line 62, `--require-count` line 65 (default `draws,frames,veg`), `--require-mark` line 64 (default `boot:scenery-built`). These are the counted gates a perf run already enforces.
- Frame-time gate: `scripts/frame-time-gate.mjs` `THRESHOLD = 1.10` (line 28), `--gpu=`, `--accelerated`, `--expect-vendor=`, `--require-accelerated` (lines 24-32), `--update-baseline`, `--accept-slower=` (line 30). The unlocked-rAF args (`--disable-frame-rate-limit --disable-gpu-vsync`) are applied unless `SPOINT_UNLOCK_RAF=0` (lines 36-37).
- `scripts/maxlevel-crossover-witness.mjs` is the ladder instrument that unlocks vsync; per AGENTS it refuses a run still on the k*16.68 ms grid.

### Inferences
- The fastest single diagnosis path for "wrong colour or missing shading" is: `__rendererInfo` (is it WebGPU, is it accelerated) -> `__lastShaderWarmup` (were materials compiled) -> `overdrawStats`/`drawsInstrument` (is geometry actually drawn). A wrong-but-drawn image is a shader or material problem; an undrawn object is a pipeline or culling problem. Those two branches are not distinguished by any single existing probe today.
- No existing CLI verb prints all of those in one reply. Building one "gfx-state" probe that reads the four window globals in one `page.evaluate` would cut the read to one round trip per launch.

### Gaps
- No measured wall-clock figure for a cold probe launch on this machine. Docs claim a cold shader compile of about 110 s (source change) and about 150 s (d3d11/FXC) in `docs/index.html`, but that page describes a `planet.html`/`server.js` workflow that AGENTS.md does not mention, so the figure is unverified for the current tree.

## Key question 2: invalid or easily misread measurements

### Takeaway
Three classes are already guarded in code and AGENTS.md: vsync-quantized frame wall, per-pass GPU timings, and silent-no-op flags. The remaining misread risk is `perf-run.mjs` bare-flag parsing and a sampled max.

### Cited findings
- Per-pass GPU timings are invalid as GPU-bound measures (AGENTS.md "Measurement and witnessing", s0). `scripts/lib/perf-gpu-control.mjs` builds its own calibrated control shader (`controlScript`, lines 51-80, `GPU_CONTROL_PROBE_MS` line 8) to measure GPU spread instead of trusting pass timers.
- Frame wall is vsync-quantized: every rAF-to-rAF median is a multiple of 16.68 ms (AGENTS.md). The unlock is `UNLOCKED_RAF_ARGS` in `scripts/frame-time-gate.mjs:37` and `scripts/maxlevel-crossover-witness.mjs`; `--lock-raf` opts out.
- Silent no-op flags (AGENTS.md "Silent-no-op class"): `?noveg`, `__vdrsScale` (needs `window.__vdrs===true`), `?legacygl=1`, `u.fsCheap`. A flag edit that reads no effect should be checked against the reader before the measurement is trusted.
- `perf-run.mjs` argv parser (`scripts/perf-run.mjs:20-29`): a bare `--flag` with no following value becomes boolean `true` (line 27), and `flag(n,d)` returns that `true`. AGENTS.md "A bare CLI flag parses to the string 'true'" covers `Number()`; here the value is the boolean `true`, so `Number(true)` is 1 and silently sets a knob to 1. Callers of `flagNumber` (`scripts/lib/witness-args.mjs`) should be checked for the same failure.
- `--no-walk` is NOT a silent no-op (AGENTS.md REFUTED). `const WALK = !has('no-walk')` at `scripts/perf-run.mjs:37`.
- Walk arms on `?singleplayer` do not translate the player (AGENTS.md). `MIN_WALK_MOVED_M` (`scripts/perf-run.mjs:43`, default 10 m) floors the walk on its excursion, not net.
- Sampled max under-reports (AGENTS.md): a max sampled once per server tick is only a lower bound. Relevant to any "peak frame" claim.
- `drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame`/`glDrawCallsPerFrame`) is the authoritative draw count per AGENTS.md. A never-incremented counter reads as a silent pass (AGENTS.md: `vegProfile.meshInstances` absent on `WebGPULodInstancer`); `perf-run.mjs --require-count` (line 65) is the existing guard that fails when a counter is absent. Extend that list to any new graphics counter.
- CDP init-script trap (AGENTS.md): an init script must end in `())`, and `page.evaluate(string)` takes an expression. Assert `installed === true` before trusting a counter.

### Inferences
- `--require-count` is the cheapest existing protection against the "absent counter reads as zero" class, and it is only as good as the list passed in. A default list that includes the draw/frame/veg counters already exists; the gap is graphics-state counters such as `overdrawStats.coveragePct` and `qualityGovernorState.tier`, which are not in the default.

### Gaps
- I did not verify that `flagNumber` rejects a boolean `true`. Check `scripts/lib/witness-args.mjs` before claiming the bare-flag bug is live.

## Key question 3: invisible shader and pipeline failures

### Takeaway
The WebGPU pipeline-validation failure is the main invisible class. The recovery hook `installStuckPipelineRecovery` cannot see the failure as written, and the shader warmup swallows compile errors.

### Cited findings
- A WebGPU pipeline that fails validation dispatches nothing and surfaces nothing (AGENTS.md "Rendering"): the wrapper caches before the compile result, errors arrive only async via `device.onuncapturederror` -> `renderer.onError`.
- `installStuckPipelineRecovery` (`client/core/SceneSetup.js:243-265`) hooks `renderer.onError`, filters on `/RenderPipeline|CommandBuffer/`, and after 3 errors inside 2000 ms (`STUCK_PIPELINE_ERROR_THRESHOLD`/`WINDOW_MS`, lines 240-241) forces `material.needsUpdate` with a 5000 ms cooldown (line 242). Recovery is therefore reactive and needs three async errors; a single bad pipeline never triggers it.
- The hook is only installed when `renderer.isWebGPURenderer` (`client/app.js:215-217`, and `SceneSetup.js:244`). On the WebGL2 backend of WebGPURenderer it is still installed, but its trigger text is WebGPU-specific.
- SILENT SWALLOW: `warmupShaders` compiles each mesh with `try { await renderer.compileAsync(...) } catch (_) { try { renderer.compile(...) } catch (_2) {} }` (`client/core/SceneSetup.js:411`). Both catches discard the error. A shader that fails to compile in warmup is invisible here and surfaces later, if at all, as the no-draw symptom above. Cheap instrument: record the error message into the `_record` payload (for example `compileFailures: [{url, message}]`) at this line, so `window.__lastShaderWarmup` reports it. That touches one line and adds one field to an existing record.
- Warmup can skip entirely with no record of the cause unless `_record` runs: the `scene-unchanged` path (`client/core/SceneSetup.js:401`, keyed in `localStorage 'lastShaderWarmupKey'`) returns early after `_record`, so it is recorded, but a stale key that matches a changed scene hides a real recompile. The reason string `scene-unchanged` is visible in `__lastShaderWarmup.reason`.
- `renderDeferringUnreadyPrograms(renderer, scene, camera)` (`client/core/SceneSetup.js:418`, `:422`) defers programs not ready. Its return value is not recorded, so a count of still-deferred programs after warmup is not visible.
- Renderer error path in boot: `installAsyncRenderPipelines` failure is a `console.warn` only (`client/app.js:223-224`), so the first draws silently go synchronous.
- The validation-refusal witness (`scripts/webgpu-pipeline-validation-refusal-witness.mjs:1-10`) is node-only with a stub device. It proves the refusal path in code, but cannot tell you whether a live pipeline failed. It is the cheapest check and needs no browser.
- `scripts/shader-manifest-witness.mjs` checks manifest residence but not compile success; its `PROBE` (lines 35-45) reads `unresolvedUrls` and `manifestedCount`, not failures.
- The WebGL side: `gl.getError()` 1282 covers three distinct bugs (AGENTS.md). The driver string is the discriminator, so a console capture is required, not the numeric code.

### Inferences
- Cheapest instrument, one edit: in `warmupShaders` line 411, push `{url, message: String(err && err.message)}` into a list and include it in `_record`. This makes compile failures a counted field, which matches the AGENTS.md "Refusals carry a code" rule.
- Cheapest instrument for the async class: make `installStuckPipelineRecovery` also increment a counter on every matching `onError` (before the threshold check, at `SceneSetup.js:251`) and expose it on `window`, so a probe can read "N pipeline errors seen" without needing 3 to fire recovery. Today a single error is invisible.
- `renderer.onError` is async, so a probe that reads the counter immediately after a draw reads the previous state. Wait one `MessageChannel` turn (AGENTS.md: MessageChannel is the yield primitive) before reading.

### Gaps
- Not verified: whether `device.onuncapturederror` actually fires in the headful CDP session used here. The AGENTS.md note states it, I did not reproduce it.

## Key question 4: browser launches per graphics probe, and sharing one window

### Takeaway
Every witness launches its own Chrome. There are about 68 `chromium.launch` call sites under `scripts/` (codesearch, `launch(` literal, 40 of 68 shown). A typical graphics probe costs one full launch plus its own shader compile. Sharing one window across several probes is possible at the CDP layer, but per-launch state leaks across probes, so it needs a reset step.

### Cited findings
- `launch(opts)` in `scripts/lib/cdp-browser.mjs:474-537` spawns one Chrome per call with a fresh `--user-data-dir` (`profileDir`, line 500), `--remote-debugging-port=0`, and `about:blank`. Each call also acquires a lease (`acquireLease`, lines 482-487, with `leaseWaitMs`/`leaseTtlMs`). Lease wait is the serialization cost when several witnesses run in parallel.
- `launch` refuses `headless` (lines 475-477): headful only, per AGENTS.md.
- `Browser` teardown removes the profile dir (`removeProfileDir`, lines 467-472) on error (lines 529-535). A reused window would need its own teardown contract.
- Call-site census: `scripts/perf-run.mjs:548`, `scripts/frame-time-gate.mjs:342`, `scripts/maxlevel-crossover-witness.mjs:264`, `scripts/shader-manifest-witness.mjs` (via `chromium` import at line 4), `scripts/lib/perf-gpu-control.mjs:149` (a calibration browser that runs before every frame-time gate), and about 60 more witnesses (codesearch, 68 matches).
- `scripts/lib/perf-gpu-control.mjs` launches its own browser (line 149) to calibrate GPU spread (`GPU_CONTROL_PROBE_MS` 2000 ms, line 8). `frame-time-gate.mjs` imports it (lines 11-13). So a frame-time gate run likely makes two browser launches (the control probe and the gate itself); I read the import list and the launch site, not the full call order, so treat the count as probable.
- `scripts/lib/gpu-probe.mjs:185` launches a Chrome pinned to a D3D11 adapter LUID (`--use-adapter-luid=0,<luid>`). Adapter pinning is per launch, so it cannot be changed inside a shared window.

### Inferences
- Count for a typical graphics probe today: 1 launch for `assertGpu`/`__rendererInfo`, plus 1 more for `__lastShaderWarmup`, plus 1 for the overdraw or draw counter (these are separate witnesses). A combined probe would be 1.
- Sharing one window: add a `launch({reuse: <name>})` mode in `cdp-browser.mjs` that keeps the browser alive under a named lease and opens a new target (`Target.createTarget`) per witness. Requires: (a) reset of module-level state in the page (AGENTS.md: `BrowserServer.js` `_lastTodSync`/`_deliveredWorldFingerprints` are module-level), (b) a fresh page load per witness to reset the warmup key and `window.__*` mirrors, and (c) the same adapter pin for every witness, asserted with `assertGpu` on each reuse.
- The cheapest real saving is not window sharing but a single combined "graphics state" probe (see Key question 1) that reads `__rendererInfo`, `__lastShaderWarmup`, `qualityGovernorState`, `overdrawStats` in one `page.evaluate` on one launch.

### Gaps
- Launch and compile wall-clock figures were not measured in this session, so the saving is an estimate (one launch is saved per avoided witness; cold compile is the larger cost per AGENTS.md and docs, unverified).

## Ranked changes (file, cost, risk)

| # | Change | File / symbol | Cost (estimate) | Risk |
|---|---|---|---|---|
| 1 | Record compile failures in warmup instead of swallowing them | `client/core/SceneSetup.js` `warmupShaders`, line 411 and `_record` at 378-389 | ~5 lines; zero runtime cost | Low: additive field on an existing record |
| 2 | Count every `renderer.onError` pipeline error, not just the 3-in-2s trigger | `client/core/SceneSetup.js` `installStuckPipelineRecovery`, line 251 | ~3 lines | Low; counter write per error only |
| 3 | One `page.evaluate` "graphics state" probe reading `__rendererInfo`, `__lastShaderWarmup`, `qualityGovernorState`, `overdrawStats` | new `scripts/` probe using `scripts/lib/gpu-probe.mjs` `probeGpu`/`assertGpu` (lines 13-94) | Removes 2-3 launches per diagnosis (estimate) | Low; read-only |
| 4 | Add `compileFailures`/`pipelineErrors` to `--require-count` default list | `scripts/perf-run.mjs:65` | 1 line | Medium: a run that previously passed may now fail; the counter must actually be incremented first (AGENTS.md absent-counter trap) |
| 5 | Check `flagNumber` for a boolean `true` input | `scripts/lib/witness-args.mjs`, `scripts/perf-run.mjs:20-29` | Investigation only | Low |
| 6 | Named-lease browser reuse (`launch({reuse})`) | `scripts/lib/cdp-browser.mjs` `launch`, lines 474-537 | Saves one launch per witness (estimate, not measured) | High: module-level page state leaks; needs per-witness reload and adapter re-assert |
| 7 | Restart gm-mcp to serve 0.2.129 and `git_pull` the 31 commits | gm MCP (`/data/cache/gm/.gm-tools/gm-mcp-server.mjs`) | Codesearch currently can miss remote symbols | Low; but restarting the server drops the stdio client |

## Stale or misleading sources noticed
- `docs/index.html` (around lines 2880-2901) describes a `server.js` `/diag` workflow and `planet.html` `__diag.gpuTimer`, and says per-pass GPU timers are a valid measure. AGENTS.md says per-pass GPU timings are INVALID (s0). Treat that doc as stale for the GPU timer claim.
- `packages/mapspinner/AGENTS.md` (lines 50, 94-95, 120) uses the same `__diag` probes, which are outside this repo's main client path.

## Sources read
- AGENTS.md sections Rendering, Measurement and witnessing, Debugging discipline (as supplied in the system context).
- client/core/SceneSetup.js (lines 236-285, 370-430).
- client/app.js (lines 205-256).
- client/core/RenderControls.js (lines 1-140).
- scripts/lib/gpu-probe.mjs (lines 1-120).
- scripts/lib/perf-gpu-control.mjs (lines 1-80).
- scripts/lib/cdp-browser.mjs (lines 440-539).
- scripts/shader-manifest-witness.mjs (lines 1-50).
- scripts/perf-run.mjs (lines 1-70).
- scripts/frame-time-gate.mjs (lines 1-40).
- scripts/webgpu-pipeline-validation-refusal-witness.mjs (lines 1-30).
- client/core/TerrainBackdrop.js (isWebGPU branches, codesearch only, not fully read).
- gm codesearch: `installStuckPipelineRecovery`, `warmupShaders`, `__diag`, `launch(`, `checkShaderErrors`, `onuncapturederror`, `__rendererInfo`, `isWebGPU`.

Not read in full: `client/core/QualityGovernor.js` body, `client/core/TerrainBackdrop.js` body, `scripts/maxlevel-crossover-witness.mjs` body, `RenderControls.js` lines 140-395. Findings from those files are limited to codesearch hits and AGENTS.md.
