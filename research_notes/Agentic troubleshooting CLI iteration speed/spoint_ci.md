# spoint CI: push-to-verdict wall-clock research

Scope: `.github/workflows/ci.yml`, `.github/workflows/pages.yml`, `scripts/check.mjs`, `scripts/check-cache-keys.mjs`, `src/static/BakeCodeVersion.js`, `scripts/static-export.mjs`, `scripts/generate-docs-site.js`.

## Revision and sourcing caveats

- The local checkout (`ba8850a`) is BEHIND `origin/main` (`b90df90`). All `file:line` citations below are from `origin/main` (`git show origin/main:<path>`), which is what CI runs. Local `ci.yml` lacks `cache: npm`; origin has it.
- Timings come from two real CI runs, read with `gh api repos/AnEntrypoint/spoint/actions/runs/<id>/jobs` and `gh run view <id> --log`:
  - run `39124903385` (sha `d637e0c`): check job 11:51:13 to 12:00:51, npm test step 11:51:30 to 12:00:51 = **561 s**.
  - run `39126550865` (sha `b90df90`): check job 12:15:45 to 12:24:40, npm test 12:15:57 to 12:24:39 = **522 s**.
  - run `39126550812` (pages, `b90df90`): build 12:15:44 to 12:16:07 = **23 s**; deploy 12:16:10 to 12:16:30 = **20 s**.
- The brief said the pages build step is about 60 s. This run measured 23 s total for the whole build job (`npm ci` 7 s, `static-export` 2 s, `generate-docs-site` 0 s, upload 6 s). The brief's npm test figure (about 380 s) is also not what these runs show: 522 to 561 s.
- The witness log text `38 concurrent (jobs 4), 55 serial` appears in the `d637e0c` log. I checked that the pool code exists on `origin/main`, not in the local file.
- Per-witness durations come from the `check: gpu-free witness <f> <s> s` lines of the `d637e0c` log (93 lines, summing to 522.7 s, matching the log's own total). Classification uses the regexes at `origin/main:scripts/check.mjs:652-655`, applied to `origin/main` sources.

## Where the 561 s goes (run `d637e0c`)

| phase | wall | source |
|---|---|---|
| npm ci, bundle-apps-manifest, apps-manifest-fresh | ~30 s | `ci.yml` steps 2-4 |
| static gates (relative imports, cache-keys, tsl imports, app imports, sdk-typings --check) | ~10 s | `check.mjs:546-582` |
| gpu-free witness phase: 38 pooled (184 s of work) then 55 serial (339 s of work) | **412 s** | `check.mjs:651-665` |
| fire-witness-gate: 10 witnesses, all serial | **147 s** | `check.mjs:702`, `scripts/fire-witness-gate.mjs` (`for (const name of WITNESSES)`) |
| check-frame-time-baselines | <1 s | `check.mjs:709-712` |

Witness phase total = 522.7 s of witness work; fire gate = 147.3 s. Serial-equivalent work for `npm test` is about 670 s. The actual wall is 561 s because the 38 pooled witnesses overlap.

## Key question 1: which witnesses dominate, and which could move to a parallel job

Serial witnesses (55, 339 s of work). Top by time, with the classifier reason:

| s | witness | why serial | clock read? | literal port/tmp? |
|---|---|---|---|---|
| 41.5 | collider-ring-frame-cost-witness.mjs | `performance.now(` | yes (7) | no |
| 32.7 | planet-multiplayer-harness.mjs | `cpuUsage` | yes (12) | no |
| 32.5 | prediction-wedge-witness.mjs | `MEASURED` only | **no (0)** | no |
| 29.1 | collider-ring-scale-witness.mjs | `performance.now(` | yes (12) | no |
| 25.1 | grass-rim-draw-ring-witness.mjs | `MEASURED` only | **no (0)** | no |
| 18.0 | grass-seam-card-witness.mjs | `hrtime` | yes (8) | no |
| 16.5 | collider-build-failure-witness.mjs | `tmpdir(` | n/a | yes, `tmpdir(` |
| 13.8 | capture-server-witness.mjs | `tmpdir(` + `PORT = 20000 + random` | n/a | random port, mkdtemp |
| 13.7 | static-collision-cpu-witness.mjs | `performance.now(` | yes (20) | no |
| 10.2 | transport-churn-witness.mjs | `port = 20000 + random` | n/a | random port |
| 6.4 | tps-game-player-movement-witness.mjs | `PORT = 38000 + random` | n/a | random port |
| 5.4 | sky-aerial-perspective-count-witness.mjs | `MEASURED` only | **no (0)** | no |
| 4.0 | relocation-ground-wait-witness.mjs | `PORT = 39800 + random` | n/a | random port |
| 3.3 | hmr-rebuild-count-witness.mjs | `MEASURED` only | **no (0)** | no |
| 3.0 | tps-game-spawn-ground-hold-witness.mjs | `PORT = 39000 + random` | n/a | random port |
| 2.8 | player-manager-send-failure-witness.mjs | `MEASURED` only | **no (0)** | no |

Findings:

1. **The `FIXED_RESOURCE` regex is a false positive for 6 witnesses.** `FIXED_RESOURCE` (`check.mjs:652`) matches the literal prefix `PORT = 38000` or `port = 20000` even when the code adds `Math.floor(Math.random() * ...)` (`tps-game-player-movement-witness.mjs:38`, `capture-server-witness.mjs:20`, `transport-churn-witness.mjs:97`, `relocation-ground-wait-witness.mjs`, `tps-game-spawn-ground-hold-witness.mjs`). `capture-server-witness.mjs:18` already uses `mkdtempSync`. These 6 witnesses (about 54 s of work) could be pooled, or converted to `listen(0)` for certainty. Not verified: `collider-build-failure-witness.mjs` `tmpdir(` usage, and whether a shared `tmpdir` subpath is used.
2. **The `TIMED_MEASUREMENT` regex is too broad.** `check.mjs:654` includes `\bMEASURED\b`, which matches printed labels. Four witnesses (prediction-wedge 32.5 s, grass-rim-draw-ring 25.1 s, sky-aerial 5.4 s, hmr-rebuild 3.3 s) read no clock (count 0 for `performance.now|hrtime|cpuUsage`) and are serialized only because of the label. Moving them to the pool would save about 66 s of serial time. Caveat: a witness that drives a browser measures browser-side CPU, so before pooling check `grass-rim-draw-ring-witness.mjs` and `prediction-wedge-witness.mjs` for CDP ThreadTime reads.
3. Clock-reading witnesses that stay serial are correct: `collider-ring-frame-cost-witness.mjs`, `planet-multiplayer-harness.mjs`, `collider-ring-scale-witness.mjs`, `static-collision-cpu-witness.mjs`. Pooling them skews their CPU measurements.

Largest pooled witnesses (for pool balance): grass-distance-density-fade-witness 51.0 s, grass-near-lod-revisit-witness 48.2 s, relevance-radius-witness 26.7 s. Two of the top three pooled witnesses are grass, so they can land on one worker. With 4 workers, pool wall was about 73 s (412 minus 339 serial), against an ideal of 184/4 = 46 s.

## Key question 2: does check wait on anything it does not need?

- No `needs:` on `check` (`ci.yml:14-25`). It does not wait on `frame-time-coverage` (`ci.yml:27-40`, a stub that only writes a step summary, about 3 s) or `frame-time` (`ci.yml:42-58`, skipped because `vars.CI_GPU_RUNNER_ONLINE` is unset). No wall cost there.
- `pages.yml` is a separate workflow (`pages.yml:3-6`, push to main). It does not gate or wait for CI, and CI does not wait on it. Pages and check run in parallel. No wall cost on the check verdict.
- Real wall cost is inside `npm test`: the fire gate (147 s) runs after the witness phase, and nothing else runs in parallel with it.

## Key question 3: is the Pages build repeated work?

Yes, but it does not affect check's verdict time.

- `static-export.mjs` re-runs the client bundle (`origin:scripts/static-export.mjs:76`), `bundle-apps-manifest --check` (`:78`), and the worker bundle (`:104`). `check.mjs` also runs `bundle-apps-manifest --check` (`check.mjs:572`) and `ci.yml:23` runs `bundle-apps-manifest` first. The manifest is built 3 times per push across two workflows. Cost is about 1 s each, so it is cosmetic.
- No artifact sharing between check and pages. Pages could reuse the check job's `client/` build via `actions/upload-artifact`, but the saving is about 5 s of `npm ci` plus the bundle steps, and it adds coupling.
- `generate-docs-site.js` reads sibling repo docs (`scripts/generate-docs-site.js:13-34`, `:44` returns null on a missing file). In CI only `spoint` is checked out, so the published docs page silently lacks wireweave/mapspinner/streaming-gltf sections. This is a correctness issue, not a timing one.

## Key question 4: which bake or typings steps force re-runs on unrelated changes?

- `check-cache-keys.mjs` (`check.mjs:558`) only hashes files and compares them to pins in `src/shared/cacheCodeVersions.js`. It does not re-bake in CI. A bake-input edit fails it. Because it runs in the static-gate block (`check.mjs:546-562`), a failure exits before the 9-minute witness phase, so the verdict is about 1 minute. The cost is a red push plus a fix-up commit, which is 2 full CI cycles. The recent log has two commits titled "bake: re-bake tps-game heightfield" (`2b47d11`, `8d442bf`); I did not confirm that each was a response to a red run.
- Shared inputs widen the blast radius: `../shared/fnv1a.js` appears in 5 `BAKE_INPUTS_*` lists and `../shared/terrainConfig.js` in 2 (`src/static/BakeCodeVersion.js`, `BAKE_INPUTS_MINIMAP_BAKE` at :56 and `BAKE_INPUTS_HEIGHTFIELD_BAKE` at :82). Editing either forces pin bumps in every listed transform, and the pins are computed from file contents (`bakeCodeVersion`, `BakeCodeVersion.js:9-19`, SHA-1 truncated to 12 hex characters).
- `gen-sdk-typings.mjs --check` (`check.mjs:579`) is also a fail-fast static gate. Same pattern as the bake pins.
- `ci.yml` does not run bakes or typings regeneration. The only CI-side re-run is the static gate itself.

## Key question 5: which witnesses could shard across runners?

The FIXED_RESOURCE rule (`check.mjs:652`) exists for in-runner contention. GitHub-hosted `ubuntu-latest` runners are separate VMs, so they do not share `127.0.0.1` ports or `/tmp`. Cross-runner matrix sharding is therefore safe for all 55 serial witnesses, provided each shard keeps its own in-runner ordering. The repo is public (`gh api repos/AnEntrypoint/spoint` reports `visibility: public`), so standard hosted runners apply. Documented specs (4 vCPU, 16 GB RAM for standard public Linux runners) were not verified in this session.

Also: `fire-witness.mjs` has an OOM path (`scripts/fire-witness-gate.mjs` OOM_RE); a separate runner gives it a fresh heap.

## Proposed changes, ranked by saving per push

Estimates use measured per-witness durations from run `d637e0c`. Wall is an estimate, not a measurement.

1. **Shard the witness phase across 3 matrix jobs (new `ci.yml` matrix; `check.mjs` plan filter at `:656-660`).** Add `SPOINT_CHECK_SHARD=i/n` to filter `plan` by index. Each shard does its own checkout and `npm ci` (about 25 s overhead). Serial-equivalent work is 670 s, so each shard is about 225 s plus overhead, roughly 265 s. Current check wall is 561 s. **Estimated saving: about 5 min per push.** Risk: medium. The static gates must run once (in one shard, or a separate job), and the shard split must balance grass witnesses (51 s and 48 s), which should go to different shards.
2. **Run the fire gate's 10 witnesses through the pool (`scripts/fire-witness-gate.mjs` `main()` loop; `check.mjs:702`).** Today it is serial: tps-game 69.9 s, peer-rollback 40.6 s, tile-reclaim 22.2 s, the rest 14.6 s. Running them concurrently gives wall of about 70 s. **Estimated saving: about 75 s.** Risk: low to medium. The gate currently stops at the first failing witness (`fire-witness-gate.mjs` `main()`); concurrent runs must still report every failure. Check that `fire-tps-game-witness.mjs` and `fire-peer-rollback-witness.mjs` bind no fixed port before pooling. I checked only `fire-tile-reclaim`, `fire-peer-rollback`, `fire-tps-game` and `fire-witness` for literal ports; none had any. `fire-weather`, `fire-combat`, `fire-wind-coupling`, `fire-smoke-los`, `fire-kernel-cost`, `fire-rain-coupling` are unchecked.
3. **Fix the FIXED_RESOURCE false positives for 6 witnesses (`check.mjs:652`).** Either pool them directly, or add a `// shared-port: random` escape hatch. Safer: convert them to `listen(0)`. **Estimated saving: about 54 s of serial work, about 30-40 s of wall after pooling.** Risk: low; the random-port collision risk with 4 workers is small but not zero.
4. **Narrow the `\bMEASURED\b` clause of `TIMED_MEASUREMENT` (`check.mjs:654`).** Four witnesses print the label without reading a clock. **Estimated saving: about 66 s of serial work.** Risk: medium. Confirm each has no in-process or CDP timing before reclassifying.
5. **Pages: add a `paths:` filter (`pages.yml:3-6`).** Skip the build for changes that touch no site input (`client/**`, `src/**`, `docs/**`, `scripts/static-export.mjs`, `scripts/generate-docs-site.js`). **Saving: 45 s of Pages runner time per unrelated push, no effect on check's verdict.** Risk: low, but a missed input means stale Pages.
6. **Duplicate apps-manifest bundling (`ci.yml:23-24` vs `check.mjs:572`).** Drop the `ci.yml` pre-step, or the check.mjs `--check`. **Saving: about 1-2 s.** Cosmetic.
7. **Fix the docs-site sibling-repo gap (`scripts/generate-docs-site.js:13-34`, `:44`).** Not a timing change. It is a correctness fix: the Pages docs page is missing 3 of 4 repos in CI.
8. **Concurrency group (`ci.yml:9-11`).** The group key includes `github.sha`, so each push gets its own group and nothing is ever cancelled or serialized. This is a no-op as written, not a saving. Leave it unless you want superseded-commit cancellation, which would drop verdicts for intermediate commits.

Not worth changing: `npm ci` with `cache: npm` is already present on origin (`ci.yml:22`, `pages.yml:25`) and takes 5-7 s. `frame-time-coverage` and `frame-time` cost nothing on push.

## Gaps

- Did not measure the sharding wall directly. The 265 s figure is arithmetic from serial-equivalent work, and it ignores CPU contention between witnesses that share a runner.
- Did not verify whether `collider-build-failure-witness.mjs` uses a fixed subpath under `tmpdir()`.
- Did not check whether the two grass-heavy pooled witnesses share state that makes them unsafe to pool together.
- Did not verify runner specs (vCPU, RAM) against current GitHub docs.
