# spoint local edit-test-fix loop: what would shorten it

Scope: the path from a code edit to a verified result on a developer or agent machine. Citations are file:line in /workspace/spoint at HEAD ba8850a. Savings are estimates from code structure, not measurements; no gate run was timed here (see Gaps).

## How the loop is put together (measured from source)

- `scripts/check.mjs` is the gate. Order of work inside `main()` (line 465):
  1. `node --check` on every tracked .js/.mjs under src, client, apps, scripts, bin: 1002 files (`git ls-files` count), spawned 16 at a time (line 498 `MAX_PARALLEL_CHECKS`, lines 500-520).
  2. Guard, workspace links, `check-relative-imports.mjs`, `check-cache-keys.mjs` (line 557), `check-tsl-imports.mjs`, `bundle-apps-manifest.mjs --check`, `gen-sdk-typings.mjs --check` (lines 571-583), `checkAppImports` (line 585). Each is a separate node process.
  3. The gpu-free witness arm: `NO_GPU_WITNESSES` (line 10, 91 unique gate entries) and `SLOW_NO_GPU_WITNESSES` (line 355). Run by `runNoGpuWitnesses` (line 601).
  4. Post-arm gates: strip witness (opt-in, line 664), fire gate, frame-time baselines, then the GPU arms (line 706 onward), all behind `SPOINT_GPU_WITNESS`.
  5. Final report at lines 1000-1012.
- Witness timeouts: 120 s for the normal list (line 353), 600 s for the slow list (line 354).
- `scripts/check-cache-keys.mjs`: `importClosure` (lines 47-68) is a regex walk of static and dynamic imports. Lines 117-123 fail when the import closure of a bake entry is not declared in its `BAKE_INPUTS_*` list. Lines 129-138 read every tracked `.hf` header and fail when its `codeVersion` differs from `HEIGHTFIELD_BAKE_CODE_VERSION`.
- `src/static/BakeCodeVersion.js`: `bakeCodeVersion` (lines 9-22) sha1s the whole text of every listed file. `BAKE_INPUTS_HEIGHTFIELD_BAKE` (lines 82-108) includes `...presetInputs()` (line 107, which globs every `src/presets/*.js`). `BAKE_TRANSFORMS` (lines 146-155) lists the eight transforms the check validates.
- `scripts/lib/browser-lease.mjs`: one accelerated browser session per project root. `DEFAULT_WAIT_MS` 600000 (line 8), `POLL_MS` 500 (line 9), `claim` (line 161), in-process adoption only (lines 170-172), `acquire` (line 272), `release` kills the browser tree and deletes the profile (lines 309-322).
- `scripts/lib/cdp-browser.mjs`: `launch` (line 474) refuses `headless` (lines 475-477), acquires the lease (line 482), spawns Chrome detached with a fresh profile (line 509), and on any failure kills the group and removes the profile (lines 529-535). Process-group reaping: `killGroup` (line 444), `reapLiveBrowsers` (line 454), exit and signal hooks (lines 458-461). `sweepStaleProfiles` (line 425). Port wait `CDP_PORT_TIMEOUT_MS` 60000 (line 101).
- Witness count: 251 `scripts/*-witness.mjs` files; 91 are in the gate lists; 53 import `cdp-browser`.

## Questions

### 1. Dependency map: does one exist, and can witnesses be selected by changed file?

No map exists. `check-cache-keys.mjs` has an import walker (lines 47-68) that is reusable as-is. I built a throwaway version in /tmp (not committed) and ran it on the 91 gate witnesses. Results:

- 74 of 91 gate witnesses have an import closure of 50 files or fewer. 14 have more than 200, because they import the app runtime (`spawn-clearance-witness.mjs`, `prediction-wedge-witness.mjs`, `terrain-reseed-failure-witness.mjs`, `planet-multiplayer-harness.mjs`, and others). Those 14 run on almost any app change.
- The import graph under-counts. 54 of the 91 contain string literals that name `src/`, `client/`, `apps/`, `packages/` or `scripts/` paths and read them with `readFileSync`. Example: `agents-md-facts-witness.mjs` has a closure of 1 and reads source files by path. Several witnesses have a closure of 1 to 2 and 8 to 15 path literals (`tps-game-spawn-ground-hold-witness.mjs`, `veg-dusk-irradiance-witness.mjs`, `tick-player-fanout-witness.mjs`).

Mechanism that would work: `affected(witness) = closure(witness) ∪ literalPaths(witness) ∩ changedFiles`, where `changedFiles` is `git diff --name-only <base>` plus the blobs of any `.hf` or other binary artifact the witness reads. Run the witnesses with a non-empty intersection, plus the always-on structural gates. Keep the full list in CI. The impact run is a local pre-push shortcut, so CI is unaffected.

Risks: dynamic path construction and artifact reads are invisible to the walker, so the literal scan is a heuristic that must over-approximate, not a proof. Witnesses spawned by another witness are also invisible. Estimated saving: for a one-file edit in a leaf module, roughly 70 to 80 percent of the gate witnesses drop out. For an edit to `src/apps/AppRuntime.js` the saving is near zero. Unmeasured.

### 2. Bake re-runs on shared module changes: can `BAKE_INPUTS_HEIGHTFIELD_BAKE` be narrowed?

Mechanism: `HEIGHTFIELD_BAKE_CODE_VERSION` (`src/static/BakeCodeVersion.js:144`) is a sha1 over the full text of every file in `BAKE_INPUTS_HEIGHTFIELD_BAKE` (lines 82-108). A change to any listed file changes the version, and `check-cache-keys.mjs:133-134` then fails every shipped `.hf` until someone re-runs `scripts/bake-heightfield.mjs`.

Findings:

- The declared list is not padded. I computed the closure of `scripts/bake-heightfield.mjs` with the same walker. It is 28 files, and the declared list equals that closure plus `terrain.glsl` (line 99), which is read as text. No entry can be deleted from the list without changing what the bake imports.
- The breadth comes from `PlanetFrame.js` (line 86), `WorldLocator.js`, `worldPresets.js`, and `presetInputs()` (line 107), which pulls every `src/presets/*.js` (arena, planet, platformer, rts, tps). An edit to `src/presets/rts.js` therefore forces a re-bake of the tps heightfield, even though a bake of `--world tps-game` never reads `rts.js` as data.
- The bake for hashVersion 2 worlds is CPU-only: `bakeFromCpuSampler` in `scripts/bake-heightfield.mjs` (around line 67) calls `createHeightSampler`, with no browser. The GLSL GPU probe path is used only for hashVersion 1 (line 63 and the `withGpuPage` import at line 4). So a bake does not need the browser lease and can run in parallel with the witness arm.

Levers, in order of safety:
- (a) Make the bake's staleness check content-based: the bake writes a digest of its sampled grid, and `check-cache-keys.mjs` re-samples a handful of fixed points (CPU, cheap) and compares. A preset edit then costs a few samples instead of a full re-bake. Risk: a sparse sample can miss a change, so the sample set must include the carve and seed points.
- (b) Split `BAKE_INPUTS_HEIGHTFIELD_BAKE` per world, so `presetInputs()` lists only the preset the artifact's world uses. Risk: the closure check (`check-cache-keys.mjs:117-123`) will fail unless the per-world list is derived, not hand-written.
- (c) Narrow the hash to the functions the bake actually calls. Largest change, most fragile.

Estimated saving: one full bake per shared-module edit. The bake's wall time was not measured (see Gaps).

### 3. Run only the witnesses affected by the last commit, locally, before push, without weakening CI

Yes, with the mechanism in question 1. Concretely:
- Add `scripts/check-affected.mjs` (new) that reuses the closure walker from `check-cache-keys.mjs:47-68`, takes `git diff --name-only HEAD~1` or a base ref, and selects entries from the `file:` lists in `scripts/check.mjs` (lines 10-352, 355-401).
- It must still run every structural gate in `check.mjs` lines 469-597 (parse, links, cache keys, tsl imports, apps manifest, sdk typings, app imports), because those are cheap and can change for any file.
- CI keeps running `check.mjs` in full. The local selection never replaces the gate.

Caveat: the `must` regex is the part that makes a witness a gate. Running `node scripts/<file>.mjs` directly skips `must` (check.mjs:640). So a direct run can print PASS and the gate can still fail. The affected-run script must apply each entry's `must` and `args` from the list (`check.mjs:11-351`), otherwise the local result is not the gate result.

### 4. Browser probes that start a fresh browser: could they share one per lease?

53 witnesses import `cdp-browser`. Each `launch()` (`scripts/lib/cdp-browser.mjs:474`) starts a new Chrome with a new profile (line 489, 509). That is a cold start per witness.

Why it cannot be shared today:
- `release()` in `scripts/lib/browser-lease.mjs:309-322` kills the browser tree (line 317), reaps profile owners (line 318) and deletes the profile (line 320), for every holder.
- Adoption is in-process only: `claim` adopts a hold only when `isOurHold` matches (lines 170-172). A second process with a live browser cannot take over the browser.
- The lease already serializes all browser users per project (`acquire`, lines 272-302, with `DEFAULT_WAIT_MS` 600000 on line 8). So browser witnesses run one at a time anyway. The only win available is cutting the cold start, not parallelism, because the GPU is one adapter.

Proposal: on `release()`, leave Chrome running when the next queued holder has the same `fingerprint`. Record `port` and `browserPid` in `owner.json` (already written by `record()`, line 329). The next `launch()` attaches to `http://127.0.0.1:<port>/json/version` if the pid is alive, and opens a fresh target per witness (`Target.createTarget`), closing it at the end. Keep a TTL so a crashed witness cannot leave Chrome running forever (the `ttlMs` logic at lines 152-158 already handles a dead holder). Risk: state leaks between witnesses through cookies, storage or GL contexts unless each witness uses a fresh target and a fresh browser context (`Target.createBrowserContext`). Unmeasured saving: one Chrome cold start per browser witness, times 53 witnesses.

### 5. Where failure output is lost or truncated

- Full output is never kept. On success, `runNoGpuWitnesses` keeps only stdout (`check.mjs:624-625`, stderr discarded). On failure it keeps six lines: cause-matching lines first, then the tail (`echoLines`, lines 443-463, with `NO_GPU_WITNESS_ECHO_LINES` = 6 at line 404 and `NO_GPU_WITNESS_CAUSE_RE` at line 405). A stack trace ("at ...") is cut unless it sits in the last six lines.
- `maxBuffer` is 16 MB (line 624). A child whose stdout exceeds it is killed by Node. `e.code` is then undefined, so `code = 1` (line 629), and the failure reads "exited 1" or "printed no line matching". The real cause is the buffer, and nothing says so.
- A `must` miss (line 640) prints the regex, not what the witness printed. The developer cannot see the actual RESULT line from the gate output.
- Pre-witness gates exit early. `process.exit(1)` at lines 488, 525, 546, 562, 569, 576, 582 and 589 runs before the witness arm (line 649). A stale bake, a stale SDK typing or a failing app import stops the gate before any witness runs. The arm's own comment (lines 595-598) says the arm no longer exits at the first red witness, but that applies only to witnesses, not to these earlier gates. The result is serial discovery: fix the bake, re-run, see the next failure.
- Durations are printed only on success (line 645). Failures print seconds too (line 643), but nothing is persisted, so a developer cannot pick a pool order from past runs.

What a developer re-runs today to see the full stack of a failing witness: `node scripts/<file>.mjs` with the same `args` from its entry (`check.mjs:11-351`), and the same environment. The `must` check is then not applied, so the developer must read the output by hand.

Proposed fixes:
- Write each witness's full stdout and stderr to `.gm/witness-out/<file>-<ts>.txt` (the directory exists; `.gm/witness-out` is already used for witness output per AGENTS.md) and print the path on failure (lines 643 and 1003).
- Collect the pre-witness gate failures into the same list and run the witness arm anyway, so one run shows every failure.
- Detect `maxBuffer` (`e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`) and report it as its own reason.

## Ranked changes

| # | Change | File and symbol | Estimated saving | Risk |
|---|---|---|---|---|
| 1 | Keep going after pre-witness gate failures; report all in one run | `scripts/check.mjs` `main()`, the `process.exit(1)` calls at lines 488-589 | Removes one full gate cycle per stale-bake or stale-typing failure; often the largest single loss | Low |
| 2 | Write full witness output to `.gm/witness-out`, print the path | `scripts/check.mjs` `runNoGpuWitnesses`, lines 624-643 and 1001-1006 | Removes one re-run per witness failure | Low; needs pruning |
| 3 | Run the gpu-free arm with a bounded worker pool, timing-sensitive witnesses serial | `scripts/check.mjs` `runNoGpuWitnesses`, serial `for` at line 602 | Wall time of the 91-witness arm divided by pool size; unmeasured | Medium: shared ports and scratch dirs; timing witnesses (for example `tick-snapshot-send-cost-witness.mjs`) flake under load |
| 4 | Impact-selected local run that applies each entry's `must` and `args` | new `scripts/check-affected.mjs`, using `scripts/check-cache-keys.mjs:47-68` and the lists at `scripts/check.mjs:10-401` | 70-80% of witnesses for a leaf edit; near zero for `AppRuntime.js` | Medium: literal-path heuristic must over-approximate; CI still runs everything |
| 5 | Cache the `node --check` parse by blob hash under `.gm/` | `scripts/check.mjs` lines 498-520 | Most of 1002 process spawns per run; unmeasured | Low |
| 6 | Content-based heightfield staleness, not whole-file code version | `src/static/BakeCodeVersion.js:82-108,144`; `scripts/check-cache-keys.mjs:129-138`; `scripts/bake-heightfield.mjs` | One full bake per shared-module edit | Medium: sparse-sample check can miss a change |
| 7 | Per-world heightfield input list instead of `...presetInputs()` | `src/static/BakeCodeVersion.js:49-54,107` | Avoids re-bake when an unrelated preset changes | Medium: closure check must still pass |
| 8 | Keep Chrome alive across same-fingerprint lease holders; fresh target per witness | `scripts/lib/browser-lease.mjs` `release` (309-322), `claim` (161-192); `scripts/lib/cdp-browser.mjs` `launch` (474-528) | One cold Chrome start per browser witness (53 witnesses) | Medium: state leakage; needs TTL |
| 9 | Persist per-witness durations under `.gm/` to order the pool longest-first | `scripts/check.mjs` lines 618-645 | Lower tail latency for parallel runs | Low |
| 10 | Report `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` as its own reason | `scripts/check.mjs` line 624-629 | Stops a misleading "exited 1" from costing a diagnosis run | Low |

## Gaps

- No wall-clock timings. I did not run `node scripts/check.mjs`, because it boots browsers when `SPOINT_GPU_WITNESS` is set and needs a GPU; the gpu-free arm alone was not timed. Every saving above is structural, not measured. The first step for any of the changes is to record per-witness seconds (check.mjs already prints them on success, line 645).
- I did not measure the heightfield bake's wall time for `--extent 256 --res 1`.
- `scripts/witness-audit.mjs` does not exist. The audit is `scripts/lib/witness-audit.mjs`, which the gate runs with `--gate` (check.mjs list, line 74). I read its header only.
- `scripts/lib/browser-lease.mjs` `holderIsLive` and the `ttl` path were read but not exercised.
- The gm MCP codesearch was used once and returned a stale tree (checkout 24 commits behind upstream) and a bundle version mismatch that needs a restart of gm-mcp. Lookups here fell back to Read and Bash. The gm-mcp restart and the stale-tree result are friction to fix under the project's gm invariants, not in this note.
