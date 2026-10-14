import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { checkAppImports } from './check-app-imports.mjs'
import { ensureWorkspaceLinks } from './ensure-workspace-links.mjs'

const execFileAsync = promisify(execFile)

const NO_GPU_WITNESSES = [
  { file: 'msgpack-negative-zero-witness.mjs', must: /\[PASS\] scalar -0 round-trips[\s\S]*RESULT: PASS/ },
  { file: 'app-event-dispatch-error-witness.mjs', must: /RESULT: PASS -- 8 of 8 check\(s\) passed/ },
  { file: 'lattice-dir-cache-witness.mjs', must: /, 0 mismatch\(es\)[\s\S]*violations: 0 over [1-9]\d* key\(s\) in [1-9]\d* ring\(s\)[\s\S]*RESULT: PASS -- [1-9]\d* chunk key\(s\) agree and [1-9]\d* ring key\(s\) across [1-9]\d* ring\(s\)/ },
  { file: 'lattice-ring-bound-witness.mjs', must: /RESULT: PASS \(missing 0, beyond 0,/ },
  { file: 'veg-painted-surface-witness.mjs', must: /RESULT: PASS -- [1-9]\d* placement\(s\) over [1-9]\d* cell\(s\), of which [1-9]\d* snow-dominant carrying 0 and [1-9]\d* bare-sand carrying 0/ },
  { file: 'physics-body-pool-witness.mjs', must: /RESULT: PASS \([1-9]\d*\/[1-9]\d*\)/ },
  { file: 'physics-motion-recreate-witness.mjs', must: /RESULT: PASS \([1-9]\d*\/[1-9]\d*\)/ },
  { file: 'terrain-reseed-failure-witness.mjs', must: /\[reseed-witness\] [1-9]\d* passed, 0 failed[\s\S]*\[reseed-witness\] RESULT: PASS/ },
  // ACCEPTPORT-orch-main-w1-30-1: the baked-artifact port. The `must` is the second half of the
  // witness: the fail-loud arms (absent -> null with no warning, truncated / bad-magic / stale-code
  // -> [baked-heightfield], hashVersion / terrainKey / chartEpoch -> warn and fall back) have to
  // have run, and so do the two the port adds -- the loader refuses a caller that supplies no
  // baked source, and the same artifact loads identically through an in-memory readBytes port.
  { file: 'terrain-baked-heightfield-fail-loud-witness.mjs', must: /pass [1-9]\d* fail 0[\s\S]*RESULT: PASS/ },
  { file: 'terrain-residency-seam-witness.mjs', must: /RESULT: PASS -- [1-9]\d* seam check\(s\) held over [1-9]\d* heightfield accessor read\(s\)/ },
  { file: 'spawn-clearance-witness.mjs', must: /RESULT: PASS -- [1-9]\d* intersecting candidate\(s\) across [1-9]\d* blocker height\(s\), 0 called clear/ },
  { file: 'prediction-wedge-witness.mjs', must: /\[wedge\] \{[^\n]*"arm":"kinematic-headon"[^\n]*"heldMaxPenetrationM":0,[^\n]*"wallPlaneTicks":0,[^\n]*\n[\s\S]*RESULT: PASS/ },
  { file: 'boot-failure-leak-witness.mjs', must: /MEASURED boot-failure-leak: 2 induced failed boot\(s\) \+ 1 control boot, handle census [1-9]\d* handle\(s\) of which [1-9]\d* owned, post-boot log line\(s\) 0\/0, control log window [1-9]\d* line\(s\) of [1-9]\d* emitted, listener leak false, watchers 0, servers \d+, owned growth -?\d+[\s\S]*RESULT: PASS/ },
  { file: 'collider-build-failure-witness.mjs', must: /"arm":"appruntime\.autoTrimesh\.probe-good","model"[\s\S]*"arm":"editor\.rebuild\.retryAfterFailure"[\s\S]*"recovered":true[\s\S]*RESULT: PASS/ },
  { file: 'player-manager-send-failure-witness.mjs', must: /MEASURED player-manager-send-failure: 3 player\(s\), [1-9]\d* refused send\(s\) of 4 site\(s\), sendFailures \+[1-9]\d*, log line\(s\) [1-9]\d*[\s\S]*disconnect site call\(s\) [1-9]\d*, encode signal\(s\) [1-9]\d*, control frame\(s\) [1-9]\d*[\s\S]*RESULT: PASS/ },
  { file: 'static-collision-cpu-witness.mjs', must: /MEASURED static-collision-cpu: [1-9]\d* tick\(s\) over 144 collision entit[\s\S]*16 forced overlap pair\(s\) producing [1-9]\d* collision event\(s\)[\s\S]*0 event\(s\)\/tick after the overlaps were removed[\s\S]*RESULT: PASS/ },
  { file: 'physics-lod-budget-cpu-witness.mjs', args: ['--warm=0', '--ticks=256', '--budget=128'], must: /MEASURED physics-lod-budget:[^\n]*resident=[1-9]\d* dropped=0[\s\S]*RESULT: PASS/ },
  { file: 'physics-lod-budget-cpu-witness.mjs', args: ['--warm=256', '--ticks=256', '--budget=128', '--playerSpeed=6'], must: /MEASURED physics-lod-budget:[^\n]*resident=[1-9]\d* dropped=0[\s\S]*RESULT: PASS/ },
  { file: 'transport-churn-witness.mjs', must: /\[transport-churn\] [1-9]\d* passed, 0 failed[\s\S]*\[transport-churn\] RESULT: PASS/ },
  { file: 'veg-lod-stream-witness.mjs', must: /^(?![\s\S]*\binstances=0\b)[\s\S]*shape=\S+ instancers=[1-9]\d* instances=[1-9]\d* visits\/frame=[1-9][\d.]*[\s\S]*shape=\S+ instancers=[1-9]\d* instances=[1-9]\d* visits\/frame=[1-9][\d.]*[\s\S]*RESULT: PASS/ },
  { file: 'veg-lod-sweep-witness.mjs', must: /^(?![\s\S]*\binstances=0\b)(?![\s\S]*\bsurvivors=0\b)[\s\S]*shape=\S+ instances=[1-9]\d* instancers=[1-9]\d* records\/frame=[1-9][\d.]* planeTests\/frame=[1-9][\d.]*[\s\S]*scaling: \{"countRatio":[\d.]+,"survivorRatio":[\d.]+[\s\S]*RESULT: PASS/ },
  { file: 'veg-lod-pair-witness.mjs', must: /ratio shared\/control: \{"recordsWalked":0\.5\d+,"cellsTested":0\.5\d+,"planeTests":0\.5\d+,"rebuilds":0\.5,"rebuildRecords":0\.5\}/ },
  { file: 'relevance-radius-witness.mjs', args: ['--counts=8', '--reps=1', '--duration=3000'], must: /MEASURED relevance-radius:[\s\S]*snapshot byte\(s\)\/snapshot \d+:[1-9]\d*->[1-9]\d*[\s\S]*[1-9]\d* shot\(s\) at hit rate[\s\S]*[1-9]\d*\/[1-9]\d* real client\(s\) over [1-9]\d* stage entit[\s\S]*cell-centre solves\/tick [1-9][\d.]* -> 0\.00 \([1-9][\d.]*% cut\)[\s\S]*[1-9]\d*\/[1-9]\d* cached base set\(s\) matched[\s\S]*re-solved [1-9]\d*\/[1-9]\d* centre\(s\)[\s\S]*RESULT: PASS/ },
  { file: 'ep-progressive-lod-schema-witness.mjs', must: /MEASURED ep-progressive-lod-schema: [1-9]\d* mesh\(es\) \/ [1-9]\d* LOD\(s\)[\s\S]*[1-9]\d* clustered prim\(s\) \/ [1-9]\d* cluster\(s\)[\s\S]*[1-9]\d* schema mutation\(s\) and [1-9]\d* cluster mutation\(s\) each rejected[\s\S]*RESULT: PASS \(0 failure\(s\)\)/ },
  // The declared spawn height -- apps/world/tps-game.js:50 authors spawnPoint y=8.39 over ground the
  // collider probes at ~-0.02 m, so the player was created ~8.1 m in the air and fell on every spawn
  // and every respawn -- and the spawn hold that gave up wherever the ground probe was non-finite,
  // which is the one input that means "no ground here yet". --terrain-hash=1 forces the exact CPU
  // solve, so this arm does not depend on the baked .hf pin: the spawn has to land on whatever
  // ground the collider reports, and the hold has to hold where there is none, on both colliders.
  { file: 'tps-game-spawn-ground-hold-witness.mjs', args: ['--terrain-hash=1'], must: /\[PASS\] groundless: a non-finite terrain probe ARMS the hold instead of releasing the player[\s\S]*\[PASS\] groundless: the hold is on a finite budget that cannot outlive 20000 ms[\s\S]*\[PASS\] groundless: the hold RELEASES at its deadline with no ground, and does not hold forever[\s\S]*\[PASS\] the spawn the game uses is within [\d.]+ m of the ground the collider probes[\s\S]*RESULT: PASS world=tps-game -- [1-9]\d* check\(s\), 0 failure\(s\)/ },
  { file: 'tps-game-player-movement-witness.mjs', must: /RESULT: PASS: walked [1-9][\d.]*m over [1-9]\d* input step\(s\) and [1-9]\d* tick\(s\) in world=tps-game/ },
  { file: 'placement-climate-gate-witness.mjs', must: /RESULT: PASS identical true over [1-9]\d* veg and [1-9]\d* rock placement\(s\)[\s\S]*over [1-9]\d*\/[1-9]\d*\/[1-9]\d*\/[1-9]\d* placement\(s\) \(quarter-chunk control [1-9]\d* of [1-9]\d*\)/ },
  { file: 'check-cache-keys-scope-witness.mjs', must: /verifying 2 artifact\(s\) of the 2 tracked/ },
  // scripts/edge-collider-draco-witness.mjs is deliberately NOT listed here: see the
  // SPOINT_STRIP_WITNESS arm below. A gate witness may not rewrite a tracked binary.
  { file: 'collider-turnover-witness.mjs', must: /MEASURED collider-turnover: [1-9]\d* step\(s\) of 30 m, radius 64 m -- capped cap 8 live [1-9]\d*\.\.[1-9]\d* in-radius [1-9]\d*\.\.[1-9]\d*[\s\S]*free cap 256 live [1-9]\d*\.\.[1-9]\d* in-radius [1-9]\d*\.\.[1-9]\d*[\s\S]*saturated 0\/9, stale 0\/18 step\(s\)[\s\S]*RESULT: PASS/ },
  { file: 'cpu-skip-witness.mjs', must: /"ticks": [1-9]\d*[\s\S]*"row2_encodePerSnapshotCall": [1-9][\d.]*[\s\S]*"row2_snapshotStaleTotal": 0[\s\S]*"row2_snapshotChecks": [1-9]\d*[\s\S]*"row3_colEntitiesPerTick": [1-9]\d*[\s\S]*"row4_interactPairsPerTick": [1-9]\d*[\s\S]*"clientErrors": 0[\s\S]*RESULT: PASS/ },
  { file: 'snapshot-perplayer-encode-witness.mjs', must: /RESULT: PASS -- [1-9]\d* recipient\(s\), 0 re-encode\(s\) with a warm cache, 0 byte mismatch\(es\) over [1-9]\d* wire record\(s\)/ },
  { file: 'tick-snapshot-send-cost-witness.mjs', args: ['--ticks=128', '--rounds=2', '--players=64', '--entities=3000', '--spread=120', '--cluster=60', '--ctrlPlayers=8', '--ctrlEntities=300'], must: /per_snapshot_tick_ms relevance=[\d.]+ plan=[\d.]+ encode=[\d.]+ send=[\d.]+[\s\S]*recipients_per_snap_tick mean=[1-9][\d.]* max=[1-9]\d*[\s\S]*crowded recipients=[1-9]\d*\/[1-9]\d*[\s\S]*RESULT: PASS -- [1-9]\d* of [1-9]\d* claim\(s\)/ },
  { file: 'tick-snapshot-send-cost-witness.mjs', args: ['--ticks=128', '--rounds=2', '--players=64', '--entities=3000', '--spread=120', '--cluster=60', '--ctrlPlayers=8', '--ctrlEntities=300'], must: /per_snapshot_tick_ms relevance=[\d.]+ plan=[\d.]+ encode=[\d.]+ send=[\d.]+[\s\S]*recipients_per_snap_tick mean=[1-9][\d.]* max=[1-9]\d*[\s\S]*crowded recipients=[1-9]\d*\/[1-9]\d*[\s\S]*RESULT: PASS -- [1-9]\d* of [1-9]\d* claim\(s\)/ },
  { file: 'netcode-profile-downgrade-witness.mjs', must: /RESULT: PASS -- MSG\.WORLD_DEF carries netcode\.profile "lockstep" to a client that never saw the world file/ },
  { file: 'agents-md-facts-witness.mjs', must: /checked [1-9]\d* path claim\(s\), \d+ line claim\(s\) and \d+ sha-like token\(s\)[\s\S]*RESULT: PASS -- every AGENTS\.md path and line claim resolves/ },
  { file: 'ground-source-port-witness.mjs', must: /RESULT: PASS checks=[1-9]\d* failed=0/ },
  { file: 'ground-entry-precondition-witness.mjs', must: /checks=[1-9]\d* failed=0[\s\S]*RESULT: PASS/ },
  { file: 'hud-applydiff-witness.mjs', args: ['--frames=200'], must: /\[hud-applydiff\] armC \{[^\n]*"removes":[1-9][\d.]*[\s\S]*\[hud-applydiff\] gate \{[^\n]*"hz":4[\s\S]*\[hud-applydiff\] RESULT: PASS [1-9]\d* tick\(s\) over [1-9]\d* node\(s\): [01] mutation\(s\)\/tick, \d+\.\d+ ms diff\/tick, full-replace control [1-9][\d.]* mutation\(s\)\/tick/ },
  { file: 'terrain-quad-upload-witness.mjs', must: /\[quad-upload\] RESULT: PASS -- 2 config\(s\), 0 upload\(s\) issued for 1200 frame\(s\) whose payload was unchanged/ },
  { file: 'contact-occlusion-softness-witness.mjs', must: /  passed [1-9]\d*, failed 0[\s\S]*RESULT: PASS/ },
  { file: 'browser-lease-single-session-witness.mjs', must: /  passed [1-9]\d*, failed 0[\s\S]*RESULT: PASS/ },
  { file: 'lib/witness-audit.mjs', args: ['--gate'], must: /RESULT: PASS [1-9]\d* file\(s\) scanned/ },
  { file: 'governor-hitch-response-witness.mjs', must: /qualityGovernor registry default true[\s\S]*single 100ms hitch answered after 1 frames[\s\S]*min trigger 1 frame\(s\)[\s\S]*smallest visible hitch 34ms answered after 1 frames[\s\S]*sustained 25ms overrun answered after 8 frames[\s\S]*single-frame spike 0 step\(s\)[\s\S]*0 resolution key\(s\) written[\s\S]*RESULT: PASS/ },
  { file: 'governor-leaf-ladder-witness.mjs', must: /RESULT: PASS label=governor-leaf-ladder-witness[\s\S]*leaf cutoff by tier 0\/0\/0\/[1-9]\d*\/[1-9]\d*\/[1-9]\d*m \(0 = leaves everywhere\), near and mid bands keep their foliage at every tier/ },
  { file: 'veg-macrotask-yield-witness.mjs', must: /\[veg-macrotask-yield\] delivery: messageChannel=\d+ setTimeout=0[\s\S]*requestAnimationFrame=0 macrotaskYield calls=[4-9][\s\S]*RESULT: PASS/ },
  // Species build / prewarm slice: the longest synchronous block the main thread takes is one unit
  // of work, and a rebuild clones the finished LOD chain instead of re-simplifying it. Its `must`
  // is the second half of the witness: the cold arm has to be over a frame (or the fix proves
  // nothing), the warm arm has to fit in one, the warm chain has to place the same tree count, and
  // every LOD level has to come back vertex-identical.
  { file: 'veg-build-slice-witness.mjs', must: /\[veg-build-slice\] species LOD chain WARM \(a rebuild clones\): \{"n":[1-9]\d*,[\s\S]*trees placed [1-9]\d*[\s\S]*slice constants=0[\s\S]*\[veg-build-slice\] RESULT: PASS -- species rebuild cold [\d.]+ms -> warm [\d.]+ms worst per species \(total [\d.]+ -> [\d.]+ms over [1-9]\d* species, every LOD level vertex-identical\), prewarm slice [\d.]+ms worst chunk over [1-9]\d* chunk\(s\) placing [1-9]\d* tree\(s\), [1-9]\d* macrotask yield\(s\) and 0 slice constant\(s\), frame budget [\d.]+ms/ },
  // PERF-grass-rock-prewarm-slice-96ms-1013: the same defect on the other two members of the
  // Promise.all client/app.js runs the prewarm in. The unit differs because the work does: a rock
  // chunk is about a millisecond of placement, so its slice is the chunk, while a grass chunk is
  // itself about a frame, so its slice is one step of the chunk placement cursor the streaming path
  // already used. The `must` is the second half of the witness: the before arm has to block for more
  // than a frame, the after arm has to fit in one and to have fallen by at least 4x, and both arms
  // have to place the same counts, so a run that bought the win by shedding grass -- least of all
  // underfoot -- reads as a failure rather than as silence that passes.
  { file: 'grass-rock-prewarm-slice-witness.mjs', must: /grass slice unit: one [\d.]+ms step of the chunk placement cursor[\s\S]*worst block Promise\.all: accumulated [\d.]+ms -> sliced [\d.]+ms[\s\S]*\[PASS\] the worst block across the whole Promise\.all now fits inside one frame[\s\S]*\[PASS\] the worst block across the whole Promise\.all fell by at least 4x[\s\S]*RESULT: PASS -- worst block over the whole Promise\.all [\d.]+ms -> [\d.]+ms \(grass [\d.]+ -> [\d.]+, rock [\d.]+ -> [\d.]+, veg [\d.]+ -> [\d.]+\); grass unit [\d.]+ms cursor step[\s\S]*0\/0 slice constant\(s\), frame budget 16\.67ms/ },
  { file: 'rain-over-grass-draw-order-witness.mjs', must: /\[rain-over-grass-draw-order\] \[PASS\] weather band is above the grass band[\s\S]*RESULT: PASS/ },
  { file: 'grass-lod-geometry-budget-witness.mjs', must: /\[PASS\] both grass LOD call sites read out of client\/core\/Grass\.js[\s\S]*RESULT: PASS/ },
  { file: 'grass-near-lod-revisit-witness.mjs', must: /\[PASS\] at rest the near LOD is exactly the near disc[\s\S]*\[PASS\] at rest the triangle count fell[\s\S]*\[PASS\] after a walk the near LOD is still exactly the near disc[\s\S]*\[PASS\] the decision was re-taken as the player moved[\s\S]*RESULT: PASS -- grass near LOD population=[1-9][\d]* clump\(s\)/ },
  { file: 'grass-distance-density-fade-witness.mjs', must: /\[PASS\] the law really removed clumps[\s\S]*\[PASS\] the triangle count fell[\s\S]*\[PASS\] the draw distance grew[\s\S]*\[PASS\] the nearest density is unchanged[\s\S]*\[PASS\] every blade inside the full-density radius is present and fully faded in[\s\S]*\[PASS\] no blade is absent while it should be visible[\s\S]*\[PASS\] no blade is held past its own edge plus the lead[\s\S]*RESULT: PASS -- grass distance-density: [1-9][\d]* -> [1-9][\d]* clump\(s\)/ },
  // gpu-free: it measures the bend the shader computes, not pixels. Whether that much bend is VISIBLE
  // still needs a real frame, and that arm is a browser arm this CI does not run.
  { file: 'grass-bend-geometry-witness.mjs', must: /\[PASS\] the bend is quadratic in the card height coordinate[\s\S]*\[PASS\] the change is under 8% of the card height at the wind that ships[\s\S]*RESULT: PASS/ },
  // PERF-grass-coherent-wind-1013. The wind used to give every blade its own oscillator phase, so
  // neighbours pulled in unrelated directions and half the sway cancelled; it is now one gust field
  // evaluated once per cell of a lattice, so they move together and the turbulence reads as a wave.
  // The `must` is the second half: the before arm has to be measurably incoherent at half a metre
  // (or the claim is vacuous), the after arm has to be coherent there, the turbulence a 4m block of
  // blades carries has to RISE (a run that bought coherence by lowering an amplitude must fail),
  // and the joined term has to be rebuilt as a fraction of the lattice rather than whole -- without
  // them a run that printed a coherence number but joined nothing still reads as a pass.
  // The two [PASS] fragments are in the order grass-coherent-wind-witness.mjs PRINTS them (the
  // "gust is computed once per group" check is the first check() in the file, the turbulence check
  // the sixth). They used to be listed the other way round, which no output can satisfy: the
  // witness exits 0 and prints RESULT: PASS while this arm fails it on the `must`, which is the red
  // gate with a green witness that reads as "never ran". Keep the order in step with the witness.
  { file: 'grass-coherent-wind-witness.mjs', must: /MEASURED grass-coherent-wind: neighbour coherence[\s\S]*before \(per-blade phase\)  0\.5m 0\.[0-7]\d*[\s\S]*after  \(shared gust field\) 0\.5m 0\.9\d*[\s\S]*\[PASS\] the gust is computed once per group[\s\S]*\[PASS\] the turbulence reads MORE, not less[\s\S]*\[PASS\] the shared field is what makes them move together[\s\S]*\[PASS\] a recentre recomputes only the cells it no longer has[\s\S]*RESULT: PASS/ },
  { file: 'grass-terrain-shared-geometry-witness.mjs', must: /field relief over a 30m ring: [1-9][\d.]*m[\s\S]*CELL ground vs rendered mesh, BEFORE \(frame as shipped\)[\s\S]*band far  \[40,61\.6\)m  n= *[1-9]\d*  mean=[\d.]*m  p95=[\d.]*m  max=[\d.]*m[\s\S]*CELL ground vs rendered mesh, AFTER  \(shared mesh surface\)[\s\S]*band far  \[40,61\.6\)m  n= *[1-9]\d*  mean=0\.0000m  p95=0\.0000m  max=0\.0000m[\s\S]*surface stats: \{[^\n]*"served":[1-9]\d*[\s\S]*RESULT: PASS/ },
  { file: 'veg-lod-poly-budget-witness.mjs', args: ['--min-mid-tris=600', '--min-mid-total=18000'], must: /branchTriCap=6000 \(shipped default\)[\s\S]*RESULT: PASS -- 15 species at branchTriCap=6000, branch mid tier \d+ far \d+, 0 violation\(s\)/ },
  { file: 'veg-leaf-cap-witness.mjs', must: /RESULT: PASS -- leaf near=\d+ mid=\d+ far=\d+ triangle\(s\), cap \d+ met by \d+\/\d+ and refused by \d+, leaf vertices \d+, attribute bytes \d+, 0 violation\(s\)/ },
  { file: 'webgpu-hiz-shaders-witness.mjs', must: /CHECK C06-strides-match-wgsl-layout PASS[\s\S]*CHECK C08-packer-direct-matches-wgsl-layout PASS[\s\S]*CHECK C12-parser-to-packer-matches-wgsl-layout PASS[\s\S]*RESULT: PASS -- [1-9]\d* of [1-9]\d* checks passed/ },
  // PERF-veg-dusk-lighting-discontinuity-1013. The ambient each lighting path gives a Lambert
  // surface at a stated time-of-day, measured by running the real code: the keyframes come from
  // client/core/TimeOfDay.js and both surfaces' numbers from terrain-ambient-shared.js, the module
  // terrain-lighting-tsl.js itself imports. Dusk is where it bites because the direct sun term
  // collapses with NdotL there, so what a surface reads at dusk IS its ambient. The `must` is the
  // second half: the albedo-invariant double ratio, the parity at every stated albedo, and the
  // wiring contract that the correction is still applied to both tree materials -- without them a
  // run that computed numbers but stopped applying the fix would still read as a pass.
  { file: 'veg-dusk-irradiance-witness.mjs', must: /MEASURED veg-dusk-lighting: dusk albedo=0\.2 veg\/terrain [\d.]+ -> [\d.]+[\s\S]*PASS ambient-parity-noon-albedo-0\.5[\s\S]*MEASURED veg-dusk-lighting double ratio \(dusk over noon, albedo 0\.2\): [\d.]+ -> [\d.]+[\s\S]*PASS dusk-over-noon-double-ratio[\s\S]*RESULT: PASS -- [1-9]\d* check\(s\), 0 failed, label=veg-dusk-lighting/ },
  // PERF-grass-dusk-ambient-1013, the grass half of the same owner report. Grass is lit by its own
  // uniforms rather than by three's lights, so it was missing the same two ambient terms AND the
  // grade the terrain puts its lit colour through: pre-fix it emitted radiance to the framebuffer as
  // it stood, so an ambient that agreed in radiance still displayed ~2.5 codes darker. The `must` is
  // the second half: the grass/terrain ratio and the albedo-invariant double ratio at every stated
  // albedo, the identity that pins the grass ambient to the terrain ambient channel for channel, and
  // the wiring contract that both shader paths still carry the terms and the grade -- without them a
  // run that computed numbers but stopped applying the fix would still read as a pass.
  { file: 'grass-dusk-ambient-witness.mjs', must: /MEASURED grass-dusk-ambient: dusk albedo=0\.2 grass\/terrain [\d.]+ -> [\d.]+[\s\S]*PASS ambient-parity-noon-albedo-0\.5[\s\S]*MEASURED grass-dusk-ambient double ratio \(dusk over noon, albedo 0\.2\): [\d.]+ -> [\d.]+[\s\S]*PASS dusk-over-noon-double-ratio[\s\S]*PASS grass-ambient-is-the-terrain-ambient[\s\S]*RESULT: PASS -- [1-9]\d* check\(s\), 0 failed, label=grass-dusk-ambient/ },
  // Owner report "a ridge with no grass where terrain tiles meet", kept as two symptoms and not one:
  // the population straddling every boundary against the same line away from it, and the surface the
  // placement reads. The `must` is the second half of the witness: a run that sampled no boundary,
  // or one whose population at a boundary fell under 70% of its own surroundings -- a bare strip --
  // must read as a failure rather than as silence that passes. Blades are indexed by their own
  // coordinates and never by the chunk they came from, because chunk-key arithmetic manufactures a
  // gap at exactly the chunk spacing, which is what the first run of this instrument appeared to find.
  { file: 'grass-tile-seam-witness.mjs', must: /\[grass-tile-seam\] MEASURED grass-tile-seam: worst boundary ratio (0\.[7-9]\d*|1[\d.]*) \(budget [\d.]+\) at the \d+m boundary @ \d+m; worst surface step [\d.]+m against a [\d.]+m median step[\s\S]*RESULT: PASS/ },
  // PERF-grass-rim-draw-gap-1013, the DRAW side of the owner report the placement-side witness
  // above closed: the population is continuous across the terrain-tile rim, so a bare strip there
  // can only be a draw-side loss -- a blade the distance law keeps that the instancer never hands
  // the encoder. It reads the two values that become `instanceCount` and the instance buffer --
  // InstancedMesh.count and instanceMatrix -- buckets them by distance ring, and compares them to
  // the instancer's own liveCount, so a slot three submits whose matrix is the zero matrix (the
  // state setVisibleAt(id,false) and releaseId() leave behind) is counted as what it is and never
  // as a blade. The `must` is the second half: law-on has to equal drawn in every ring, the rim
  // ratio has to hold against the 0.7 budget, and BOTH forcing arms have to have MOVED one band --
  // a ring held empty because nothing reaches it fills when the ring widens, and when FULL_R is
  // pushed out -- so an instrument that cannot see distance reads as a failure rather than as
  // silence that passes. gpu-free: it boots client/core/Grass.js in node over the real tps-game
  // terrain and reaches three's submission boundary, which is the layer that owns instanceCount;
  // the WebGPU encoder itself is a browser arm this CI does not run.
  // PERF-fill-overdraw-backface-1013. The terrain patch grid is single-sided now, and the pin is
  // the WHOLE decision, not the one line: the material the page builds has to build the side the
  // camera sees (named by scripts/terrain-side-overdraw-ab-witness.mjs, which culls each side in
  // turn and diffs the frame per band), it has to be one assignment site so no second place
  // re-doubles it, and the surfaces whose backfaces are load-bearing -- grass cards, vegetation
  // leaves and the water surface -- have to be UNCHANGED. gpu-free: it builds the real node graph in
  // node and reads four sources; it never touches an adapter. The `must` is the second half: a
  // reintroduced DoubleSide, a moved vertex stencil or a flipped constant fails here instead of
  // drifting.
  { file: 'terrain-side-single-witness.mjs', must: /MEASURED terrain-side-single: terrain material side=BackSide\(1\) built from createTerrainMaterialTSL; grass, vegetation leaves and water still DoubleSide; [1-9]\d* check\(s\) passed[\s\S]*RESULT: PASS [1-9]\d* check\(s\) label=terrain-side-single/ },
  { file: 'grass-rim-draw-ring-witness.mjs', must: /\[grass-rim-draw\] MEASURED grass-rim-draw: rim ratio (0\.[7-9]\d*|1[\d.]*) \(budget [\d.]+\); submitted=[1-9]\d* live=[1-9]\d* drawn=[1-9]\d*[\s\S]*\[PASS\] every blade the law keeps is a blade the instancer submits[\s\S]*\[PASS\] the instrument sees distance[\s\S]*\[PASS\] the fade is what empties that ring[\s\S]*\[PASS\] there is no rim gap on the draw side[\s\S]*\[PASS\] no drawn-density strip at either boundary spacing the report could mean[\s\S]*RESULT: PASS/ },
  // Owner report "the grass looks weird like its been made too narrow" / "grass scale is very small
  // ... too narrow": a blade card that TURNS has to be measured, because the same card reads at a
  // different width the moment its orientation changes, and the per-blade fade can shrink width as
  // well as height. The `must` is the second half of the witness: a run whose shipped turning is
  // not the one that faces the camera, or whose fade still multiplies the whole card, must read as
  // a failure rather than as silence that passes.
  { file: 'grass-blade-silhouette-witness.mjs', must: /\[PASS\] the fade takes a blade to zero in height and leaves its width alone[\s\S]*\[grass-silhouette\] MEASURED grass-silhouette: shipped=NORMAL-TO-CAMERA width [\d.]+ \(min [\d.]+\) vs fixed [\d.]+[\s\S]*RESULT: PASS/ },
  // PERF-shadow-cascade-redraw-hitch-1013: how many cascade shadow maps one frame re-renders while
  // the player travels, unbounded against shipped. The `must` is the second half of the witness: a
  // run that printed no ladder, one whose unbounded arm never put all three cascades on one frame, or
  // one whose shipped arm did not cut that, must read as a failure rather than as silence that
  // passes. The cascade 0 figure is the fidelity pin -- the near cascade redraws on every frame in
  // both arms, so the near band's cadence is not what the budget bought.
  { file: 'shadow-cascade-redraw-witness.mjs', must: /RESULT: PASS label=shadow-cascade-redraw -- worst cascade redraw\(s\) in one frame while travelling 3m\/s:3->2 6m\/s:3->3 12m\/s:3->3 20m\/s:3->3 \(of 3\); frame\(s\) redrawing all three 3m\/s:31->0 6m\/s:178->3 12m\/s:671->174 20m\/s:1553->651; far redraw\(s\) 3m\/s:839->836 6m\/s:1613->1592 12m\/s:3069->2905 20m\/s:4662->3974; cascade 0 3600\/3600 frame\(s\) unchanged/ },
  { file: 'webgpu-pipeline-validation-refusal-witness.mjs', must: /\[PASS\] A1 real WGSL validates all four pipelines -- pipelinesValidated=4[\s\S]*\[PASS\] B1 broken WGSL is REFUSED --[\s\S]*\[PASS\] M1 without the error scope the same broken WGSL is NOT refused[\s\S]*RESULT: PASS/ },
  // PERF-shadowmap-needsupdate-dead-1013: the shadow cost probe has to be ATTACHED before any shadow
  // cost quoted from it means anything, and it was not. three's node renderer shadowMap is { enabled,
  // transmitted, type } with no render, so the probe's guard never installed there, nothing set
  // window.__shadowCost, and an unattached instrument read the same as a measured zero. The `must` is
  // the second half of the witness: both arms have to attach AND have counted a pass by contrast (the
  // main pass adds none, and on the legacy arm a pass with needsUpdate false adds none), the third
  // renderer has to be refused with a reason, and client/app.js has to carry zero
  // renderer.shadowMap.needsUpdate writes -- a run that installed nothing must read as a failure
  // rather than as silence that passes.
  { file: 'shadow-cost-probe-attach-witness.mjs', must: /\[PASS\] three's node renderer shadowMap attaches the probe[\s\S]*\[PASS\] the node renderer arm is the per-light pass, not the renderer-level one[\s\S]*\[PASS\] the main pass adds no sample, so the pass count is attribution and not a counter \(samples=0 after 1 main pass\)[\s\S]*\[PASS\] one shadow camera render per cascade is counted as one pass each \(samples=3 of 3 cascade\(s\)\)[\s\S]*\[PASS\] the legacy renderer-level shadow pass attaches the probe[\s\S]*\[PASS\] a pass the renderer was not asked for adds no sample \(samples=0 with needsUpdate=false\)[\s\S]*\[PASS\] a pass the renderer was asked for is counted \(samples=1 with needsUpdate=true\)[\s\S]*\[PASS\] a renderer with no shadow pass and no render\(\) is refused, not silently installed[\s\S]*\[PASS\] the refusal carries a reason, so it cannot be quoted as a measured zero[\s\S]*\[PASS\] client\/app\.js writes renderer\.shadowMap\.needsUpdate nowhere \(0 write\(s\)\)[\s\S]*RESULT: PASS label=shadow-cost-probe-attach -- 0 failure\(s\) over 3 install arm\(s\) and the client\/app\.js write pin/ },
  { file: 'tree-texture-budget-witness.mjs', must: /the leaf default is an eighth of the source, not the source[\s\S]*RESULT: PASS/ },
  // gpu-free: it builds the real node graph and models the sampler in JS, so no adapter is touched.
  // The second half of the witness is the `must`: a run that never swept a footprint inside the
  // coincide band, or never swept one outside it, has to read as a failure rather than as silence
  // that passes -- without an out-of-band sample the guard is decorative and unproven.
  { file: 'surface-splat-octave-tap-witness.mjs', must: /MEASURED surface-splat-octave-tap: [1-9]\d* in-band footprint\(s\) collapse to one tap set, [1-9]\d* do not, [1-9]\d* check\(s\) passed[\s\S]*RESULT: PASS [1-9]\d* check\(s\) label=surface-splat-octave-tap/ },
  // PERF-terrain-fragment-fetch-budget-1013-wall-unresolved-1013. The reproduction switch the frame
  // -wall arm flips: a TSL uniform, so one page load carries both the collapsed fragment path and the
  // pre-change one and the arms can interleave. gpu-free: it builds the real node graph and models
  // the sampler in JS. The `must` names both budgets, so a switch that stops restoring the pre-change
  // 12 fetches per layer -- or one that starts collapsing out-of-band pixels -- fails instead of
  // passing silently, and the nine snoise3 and FD_TAPS pins keep the pair differing by fetches only.
  { file: 'surface-splat-octave-ab-switch-witness.mjs', must: /MEASURED surface-splat-octave-ab-switch: revert arm 12 triplanar fetch\(es\) per layer on all [1-9]\d* sample\(s\), collapse arm 6 on the [1-9]\d* in-band one\(s\), [1-9]\d* check\(s\) passed[\s\S]*RESULT: PASS [1-9]\d* check\(s\) label=surface-splat-octave-ab-switch/ },
  // gpu-free: it drives the real deferral against a stub Pipelines, so the property it pins -- a
  // first use never builds inside the frame that needs it, and no queued object is ever stranded --
  // holds without an adapter. How long one prologue takes is a browser arm this CI does not run.
  { file: 'pipeline-firstuse-deferral-witness.mjs', must: /\[PASS\] a first use on the draw path builds nothing[\s\S]*\[PASS\] the drain builds it off the draw path[\s\S]*\[PASS\] a prologue longer than the slice cannot starve the queue[\s\S]*\[PASS\] an object enqueued mid-drain is still drained[\s\S]*\[PASS\] a ready object is never deferred[\s\S]*\[PASS\] the reproduction switch puts a first use back on the draw path[\s\S]*\[PASS\] a build that never succeeds stops being retried[\s\S]*RESULT: PASS/ },
  // gpu-free: the count is read out of three's own Pipelines and Info classes with a stub backend,
  // so no adapter is touched. Whether a real adapter's async creation resolves on the same schedule
  // is a browser arm this CI does not run.
  { file: 'program-readiness-witness.mjs', must: /MEASURED common arm: info\.programs=undefined \(as-shipped count 0\) with 4 outstanding, fixed count 4, 0 after settle[\s\S]*MEASURED wait: 3 outstanding at entry, polled max [1-9]\d*, resolved pending=0 after [1-9][\d.]*ms, work finished at [1-9][\d.]*ms[\s\S]*RESULT: PASS/ },
  // The near-field density pin: the rendered near band must sit at the COLLIDER's lattice -- equal to
  // it, not merely not coarser -- at every quality tier, measured against the grass placement lattice
  // too, with the vegetation the same ground carries counted so a trees-missing regression cannot
  // hide behind a density figure that did not move. The re-solve arm is pinned by the counter its own
  // mutation moves: `--mutate-reseed` re-solves every node and this `must` must then fail.
  { file: 'nearfield-lod-lattice-witness.mjs', must: /\[nearfield-lattice\] PIN near-field density boot L13: rendered 1\.2775 m, grass placement lattice 2 m, collider lattice 1 m, near-field lattice step 1 m == collider 1 m at all 8 tier\(s\), measured step [\d.]+ m u \/ [\d.]+ m v, rim step 0.06257 m at all 8 tier\(s\); trees placed over the near band: [1-9]\d* over [1-9]\d* chunk\(s\)[\s\S]*checks [1-9]\d* passed, 0 failed[\s\S]*RESULT: PASS/ },
  // PERF-terrain-vs-snoise-per-vertex-1013. The vertex stage's height/normal stencil: five taps
  // (four of them offsets the vertex's own grid neighbours already occupy) became three, so the
  // height tap is bit-identical and the normal is the one quality claim the change has to answer.
  // gpu-free: it evaluates the CPU mirror of the height field, not pixels. The `must` names the
  // per-vertex counts, so a stencil that goes back to five taps fails it, and it names the two
  // noise-floor checks, so a stencil that moves the normal past the mesh's own vertex-to-vertex
  // normal turn fails it too.
  { file: 'terrain-vs-normal-witness.mjs', must: /measured snoise3 per composeHeight: 48[\s\S]*the stencil move is inside the mesh's own normal variation at the median \([\d.]+deg vs [\d.]+deg\)[\s\S]*the stencil move is inside the mesh's own normal variation at p95 \([\d.]+deg vs [\d.]+deg\)[\s\S]*MEASURED terrain-vs-normal: [1-9]\d* stencil comparison\(s\)[\s\S]*vertex stage 243 -> 147 snoise3 per vertex[\s\S]*RESULT: PASS -- [1-9]\d* of [1-9]\d* check\(s\) passed/ },
  // ORCH-workspace-link-stale-copy-1013: `npm run links` used to answer "does this specifier resolve"
  // when the question it appears to ask is "is this a link into packages/*". A real directory holding
  // an INSTALLED COPY resolves perfectly, so it printed "3 already resolved" while the dev server
  // served published mapspinner bytes and browser-side arms measured unmodified code. The `must` is
  // the second half of the witness: a run that never saw the stale copy reported as a repair, never
  // kept it aside, never refused a missing target by name, or never proved the misdirected link's
  // target survives, must read as a failure rather than as silence that passes.
  { file: 'workspace-link-stale-copy-witness.mjs', must: /\[PASS\] the stale copy is reported as a repair, not as already resolved[\s\S]*\[PASS\] the stale copy was MOVED ASIDE, not deleted, and the report names where it went[\s\S]*\[PASS\] a link pointing anywhere other than the workspace is repaired[\s\S]*\[PASS\] an unrelated installed package is NOT touched[\s\S]*\[PASS\] a missing workspace target is REFUSED with a named error[\s\S]*\[PASS\] every install path of this tree resolves INTO its workspace package[\s\S]*RESULT: PASS -- [1-9]\d* of [1-9]\d* check\(s\) passed/ },
  // PERF-veg-trees-missing-1013. The tier-node-graph warm in client/core/Vegetation.js is entered
  // from the species build loop, which runs ABOVE the warm's own declarations, so any `const` in
  // that path is still in its temporal dead zone at the call site: every species build then threw a
  // ReferenceError that the build loop's own try/catch logged and swallowed, and the world came up
  // with zero tree species -- no trees at all, while every instance and draw counter read a healthy
  // zero and no witness that counts placements could see it. The `must` is the second half of the
  // witness: a run that classified no binding, or one that found the warm call site gone, must read
  // as a failure rather than as silence that passes.
  { file: 'veg-warm-temporal-dead-zone-witness.mjs', must: /\[veg-warm-tdz\] RESULT: PASS -- [1-9]\d* warm binding\(s\) initialized before the species build loop's warm call at client.core.Vegetation\.js:[1-9]\d*, [1-9]\d* hoisted declaration\(s\) and \d+ declared above it/ },
  // ORCH-check-pin-witness-exists-1013. A path-scoped publish in a shared work tree is not
  // content-scoped: the check.mjs blob it writes carries whatever sibling lanes currently have
  // uncommitted in that file, including pins for witnesses those lanes have not published, and CI
  // then answers "never ran: unreadable (ENOENT)" for a witness remote has never seen.
  // scripts/lib/git-api-publish.mjs now refuses that, and this witness is the guard’s own `must`:
  // a publish carrying check.mjs and this file together must be accepted, one carrying check.mjs
  // with this witness still absent must be refused.
  { file: 'publish-gate-witness.mjs', must: /\[publish-gate\] RESULT: PASS -- [1-9]\d* of [1-9]\d* check\(s\) passed/ },
  // PERF-terrain-far-tessellation-step-1013. "One step better tessellation at a distance" names one
  // step on the split-distance ladder: mapspinner/lod-config.js LOD_STEP 3.6 -> 7.2, which is the
  // codebase's own step constant. Quadtree._recurse splits a node while `dist < l * effSplit`, so
  // the split distance is the only thing setting the leaf side that survives at a given distance,
  // and it is not maxLevel (a display-wide ceiling the governor sheds), not the splitFactor knob
  // (the same quantity under another name) and not the near-field lattice (the collider's spacing).
  // The `must` is the second half of the witness: the step that ships has to be the doubled one and
  // the split distance has to have doubled with it, and the near band -- the leaf the camera stands
  // in, its level, the near-field lattice step and the lattice-covered extent -- has to be identical
  // arm to arm. A run that printed no band, or one whose near band moved, must read as a failure
  // rather than as silence that passes.
  { file: 'farfield-tessellation-step-witness.mjs', must: /\[far-tess-step\] RESULT: PASS arm=far-tessellation-step[\s\S]*lodStep 3\.6->7\.2 splitDist 1\.1375->2\.275[\s\S]*distanceBand\(s\)=5[\s\S]*nearLeaf=23\.0322m==23\.0322m latticeStep=1m/ },
  // ORCH-serverless-static-hosting-guard-1013. OWNER RULING, verbatim: "this is a serverless/self
  // hosting game no cloud services, must be able to run everything that self hosted can do from the
  // simple github pages setup polymorphically for rtc games as well as for singleplayer". This is the
  // ruling made mechanical: it boots the shipped client out of a PLAIN STATIC FILE SERVER -- raw
  // bytes, no dev server, no bundler, no rebuild -- and walks the real module graph the browser
  // walks, resolving every specifier the way the page's own import map tells it to. The `must` is
  // the second half of the witness: a run that resolved no module, one whose singleplayer and RTC
  // paths are not both reachable from the one static output, or one that never printed the module
  // count, must read as a failure rather than as silence that passes. It also refuses any remote
  // URL outside the pinned design CDN, so cloud or edge rendering, remote lighting or server-side
  // frame work cannot be introduced by a later row without reddening this arm. gpu-free: it reads
  // bytes and resolves specifiers; whether the frame is the right frame is a browser arm CI does
  // not run. It serves the entry out of the worktree, so a stale dist/client/app.js is not
  // something a boot from here can be measuring.
  { file: 'static-host-boot-witness.mjs', must: /MEASURED static-host-boot: [1-9]\d* module\(s\) resolved out of the static tree[\s\S]*\[PASS\] singleplayer and RTC are both reachable from this one static output -- 5\/5 boot path\(s\)[\s\S]*RESULT: PASS/ },
  // PERF-hmr-hard-stop-1013, the REBUILD side of "hmr is hitching up the game" / "1fps": what one
  // HMR update does to the RUNNING FRAME, as counts. One real write produces one update (measured
  // through the real src/sdk/DevHmr.js watcher), one update applies at most a handful of accept
  // boundaries, and the species rebuild stays on the WARM path -- `species path -- 0 of N` is the
  // pin: `_speciesLodCache` is module scope in client/core/VegetationBuild.js, so it is reused only
  // while the page keeps that module instance. A count of 1 or more means a boundary edit re-imports
  // it at a fresh `?hmr=` url and every species rebuilds cold, which is the 1 fps shape.
  { file: 'hmr-rebuild-count-witness.mjs', must: /MEASURED hmr-rebuild-count: update\(s\) per save \[[1-9]\d*(,[1-9]\d*)*\][\s\S]*MEASURED hmr-rebuild-count: subsystem\(s\) rebuilt per update -- boundaries per edit worst [1-9]\d* \([\s\S]*MEASURED hmr-rebuild-count: species path -- 0 of [1-9]\d* accept boundary edit\(s\)[\s\S]*RESULT: PASS/ },
  // PERF-hmr-hard-stop-1013, the RELOAD side: the longest uninterrupted main-thread block one hot
  // reload takes, by phase, A/B-ed inside one process through the runtime's own reproduction switch.
  // The `must` is the second half: the unsliced arm has to block for MORE than a frame (or the fix
  // proves nothing) and to have taken NO macrotask yield, the sliced arm has to yield at least twice
  // per update, and the block has to have fallen by at least 4x and to fit inside one frame.
  { file: 'hmr-reload-block-witness.mjs', must: /LADDER entries= *[1-9]\d*  decide[\s\S]*MEASURED hmr-reload-block: longest synchronous block [\d.]+ ms -> [\d.]+ ms \(frame budget 16\.67 ms\); macrotask yield\(s\) per update 0\.00 -> [1-9][\d.]*[\s\S]*RESULT: PASS/ },
  // PERF-sky-single-march-1013. Counted work units for the sky background node: exp operations
  // and atmosphere LUT taps per pixel, measured by building the real TSL node graph in node and
  // walking it -- no adapter, no browser. The shipped node runs ONE march whose end distance is
  // selected by wSky instead of two marches whose results are blended by it, so the `must` pins
  // 40 exp / 8 taps shipped and 80 / 16 restored. It is non-vacuous in BOTH directions only
  // because the witness re-counts a variant that puts the second march back -- the count has to
  // return to 80 / 16 -- and a variant with every march removed -- it has to fall to zero -- so
  // a counter that printed the same figure in every arm, or 0 in every arm, fails here instead
  // of reading as a measurement. The two [PASS] anchors are the guard the REFUTED predecessor
  // row (PERF-sky-aerial-perspective-share-1013) needs: that change swapped marchSteps for
  // marchRadiance, a different integrator, and the witness refuses a background node that
  // integrates with anything other than marchSteps or that carries more than one march.
  { file: 'sky-aerial-perspective-count-witness.mjs', must: /\[PASS\] background node still integrates with marchSteps[\s\S]*\[PASS\] background node no longer carries the second march: got=1 want=1[\s\S]*MEASURED single-march: expNodes=24 expOps=40 lutFetches=8 graphNodes=\d+[\s\S]*MEASURED two-marches-restored: expNodes=48 expOps=80 lutFetches=16[\s\S]*MEASURED both-marches-removed: expNodes=0 expOps=0 lutFetches=0[\s\S]*RESULT: PASS label=sky-single-march-count single=\{exp:40,lut:8\} two-marches=\{exp:80,lut:16\}/ },
  // PERF-grass-seam-height-step-1013, the third symptom of "a ridge with no grass where terrain
  // tiles meet": the placement side and the draw side are already closed, so what is left is the
  // STEP ITSELF and how a blade card sits on it. It rebuilds the drawn quad payload the renderer
  // really emits (the quadtree at the world's own LOD plus the near-field lattice tiles), finds
  // every seam geometrically, and for real blades out of placementsForGrassChunk measures the
  // SLOPE-FREE jump the card has to cover: 2*d(e) - d(2e), because a one-sided pair is the jump
  // plus the slope times 2e and the raw pair is what perimeterJump quotes. The `must` is the
  // second half: both non-vacuity arms have to MOVE (welding the seam has to collapse the figure,
  // tripling it has to triple it), the own-foot residual has to stay k-independent -- that is what
  // separates "the card spans two heights" from "the placer is off the surface" -- and the mirror
  // has to reconstruct THIS site, since a lattice read at a chart it does not describe answers
  // with another place's ground and every figure would then be about that and not about a seam.
  { file: 'grass-seam-card-witness.mjs', args: ['--ring=88'], must: /the mirror really reconstructs this site[\s\S]*footprint crossed=[1-9]\d* \([\d.]+%\)[\s\S]*NON-VACUOUS DOWN: welding the seam collapses the step a card must cover[\s\S]*NON-VACUOUS UP: tripling the step grows what a card must cover[\s\S]*the own-foot residual is k-independent[\s\S]*a straddling card never has to cover a visible step: p95 under 10 mm[\s\S]*a straddling card never has to cover a visible step: max under 50 mm[\s\S]*RESULT: PASS/ },
]
const NO_GPU_WITNESS_TIMEOUT_MS = 120000
const SLOW_WITNESS_TIMEOUT_MS = 600000
const SLOW_NO_GPU_WITNESSES = [

  // PERF-tps-game-spawn-above-ground-1013 / PERF-spawn-not-touching-ground-1013. A relocation to a
  // point (`?at=<x>,<z>`) must wait for the same ground, on the same budget, as a spawn. Before
  // this change src/sdk/Relocation.js teleportPlayer() armed TeleportHold with its own 8000 ms
  // ceiling and a bare 60 m downward raycast, neither of which can tell "no collider field here
  // yet" from "no ground here at all", so on a world whose collider has to be CPU-solved -- which
  // is what ?terrainhash=1 forces, because the shipped bake is rejected for the other hash version
  // -- it released the player into the air at 8 s and src/behaviours/combat.js killByFall took it
  // again on every respawn. The `must` is the second half of the witness: a run that never armed a
  // hold, one that kept the 8 s ceiling, or one whose uncovered player still fell, must read as a
  // failure rather than as silence that passes.
  { file: 'relocation-ground-wait-witness.mjs', must: /\[PASS\] the relocation hold waits on the spawn ground budget[\s\S]*\[PASS\] while the field is missing the relocation hold probes no ground[\s\S]*\[PASS\] one second later the uncovered player is still held and has not fallen[\s\S]*RESULT: PASS relocation-ground-wait/ },
  { file: 'planet-multiplayer-harness.mjs', args: ['--n=8'], must: /RESULT: PASS -- [1-9]\d* of [1-9]\d* check\(s\) passed/ },
  { file: 'collider-ring-scale-witness.mjs', must: /\[ring-scale\] [1-9]\d* passed, 0 failed[\s\S]*\[ring-scale\] RESULT: PASS/ },
  { file: 'collider-ring-boot-batches-witness.mjs', must: /ms per 1k operation\(s\) over [1-9]\d* operation\(s\)/ },
  // PERF-terrain-collider-ring-hitch-1013. The `must` is the second half of the witness: a run that
  // printed no A/B, one whose realistic arm reached the eviction path it is supposed to find
  // unreachable, or one whose eviction-pressure arm never evicted, must read as a failure rather
  // than as silence that passes.
  { file: 'collider-ring-frame-cost-witness.mjs', must: /\[ring-frame\] 8 walking, shipped cap:[^\n]*evict scan 0 \/ evicted 0[\s\S]*\[ring-frame\] 8 walking, tight cap 64:[^\n]*evict scan [1-9]\d* \/ evicted [1-9]\d*[\s\S]*\[ring-frame\] A\/B: 8 player\(s\) frame wall max [\d.]+ ms walking vs [\d.]+ ms settled[\s\S]*\[ring-frame\] A\/B: 48 player\(s\) frame wall max [\d.]+ ms walking vs [\d.]+ ms settled[\s\S]*\[ring-frame\] [1-9]\d* passed, 0 failed[\s\S]*\[ring-frame\] RESULT: PASS/ },
  // PERF-tick-player-fanout-1013: the PLAYER half of the snapshot tick, measured with the per-player
  // stages broken out separately and A/B-ed inside one process through the surface's own
  // reproduction switch (setPlayerFanoutWholeLobby), because this box runs sibling lanes and two
  // separate runs measure the neighbours as much as the code. The `must` is the second half of the
  // witness: a run that printed no per-player stage line for both arms, no encode-pass figure for
  // both layouts (packed, where every player really is reachable so no pass can be smaller than what
  // is delivered, and spread, where the union is a fraction of the lobby), or no player-walk
  // before->after, must read as a failure rather than as silence that passes. Byte identity between
  // the two arms and the fan-out not having moved are claims C4 and C9, so they are inside the count.
  { file: 'tick-player-fanout-witness.mjs', args: ['--ticks=640', '--rounds=2'], must: /\[tick-player-fanout\] packed\/legacy per_snapshot_tick_ms playersEncode=[\d.]+ nearby=[\d.]+ playersFilter=[\d.]+ tombstones=[\d.]+ prune=[\d.]+ trackedSweep=[\d.]+ playerWalk=[\d.]+[\s\S]*\[tick-player-fanout\] packed\/union per_snapshot_tick_ms playersEncode=[\d.]+ nearby=[\d.]+ playersFilter=[\d.]+[\s\S]*\[tick-player-fanout\] spread\/union per_snapshot_tick_ms playersEncode=[\d.]+ nearby=[\d.]+ playersFilter=[\d.]+[\s\S]*\[tick-player-fanout\] MEASURED packed: encode pass [\d.]+ -> [\d.]+ player\(s\) per tick of a [\d.]+ player lobby[\s\S]*\[tick-player-fanout\] MEASURED spread: encode pass [1-9][\d.]* -> [1-9][\d.]* player\(s\) per tick of a 64\.0000 player lobby[\s\S]*\[tick-player-fanout\] MEASURED player-walk ms per snapshot tick: packed [\d.]+ -> [\d.]+, spread [\d.]+ -> [\d.]+[\s\S]*RESULT: PASS -- 10 of 10 claim\(s\)/ },
]
const NO_GPU_WITNESS_GPU_SURFACE = /cdp-browser|gpu-probe|gpu-eval|witnessGpu|gpuLaunchArgs|use-angle|adapter-luid|WebGLRenderer|WebGPURenderer/
const NO_GPU_VERDICT_RE = /^(?:\[[^\]]*\]\s*)?RESULT:\s+(PASS|FAIL)(?![A-Za-z0-9_])/
const NO_GPU_WITNESS_ECHO_LINES = 6
const NO_GPU_WITNESS_CAUSE_RE = /RESULT: FAIL|\[FAIL\]|^FAIL |FATAL|Error:|AssertionError|error TS\d+|npm ERR!/i

const ROOTS = ['src', 'client', 'apps', 'scripts', 'bin']
const SKIP_DIRS = new Set(['basis', 'draco', 'maps'])
const SKIP_VENDORED_FILE = /(\.min\.js$|basis_transcoder|draco_decoder|jolt-physics)/

function collect(out) {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--', ...ROOTS], { maxBuffer: 64 * 1024 * 1024 })
  for (const rel of raw.toString('utf8').split('\0')) {
    if (!rel) continue
    const ext = extname(rel)
    if (ext !== '.js' && ext !== '.mjs') continue
    if (SKIP_VENDORED_FILE.test(rel)) continue
    if (rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg))) continue
    out.push(rel)
  }
  return out
}

function noGpuVerdict(stdout) {
  let failing = null
  let passing = null
  for (const line of stdout.split('\n')) {
    const m = NO_GPU_VERDICT_RE.exec(line.trim())
    if (m === null) continue
    if (m[1] === 'FAIL') { if (failing === null) failing = line.trim() }
    else if (passing === null) passing = line.trim()
  }
  if (failing !== null) return { verdict: 'FAIL', line: failing }
  if (passing !== null) return { verdict: 'PASS', line: passing }
  return { verdict: null, line: null }
}

function tailLines(text, count) {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
  return lines.slice(Math.max(0, lines.length - count))
}

function echoLines(text, limit) {
  const all = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
  const picked = []
  const shown = new Set()
  for (const line of all) {
    if (!NO_GPU_WITNESS_CAUSE_RE.test(line)) continue
    const key = line.trim()
    if (shown.has(key)) continue
    shown.add(key)
    picked.push(key)
    if (picked.length >= limit) break
  }
  for (const line of tailLines(text, limit)) {
    const key = line.trim()
    if (key === '' || shown.has(key)) continue
    shown.add(key)
    picked.push(key)
    if (picked.length >= limit) break
  }
  return picked
}

async function main() {
  const files = []
  collect(files)

  const missingRoots = ROOTS.filter((r) => !existsSync(r))
  if (missingRoots.length) {
    console.error(`check: source root(s) absent, so ${files.length} file(s) were scanned: ${missingRoots.join(', ')}`)
    process.exit(1)
  }
  if (files.length === 0) {
    console.error(`check: 0 tracked source files collected from ${ROOTS.join(', ')} -- an empty parse scan is not a pass`)
    process.exit(1)
  }
  console.log(`check: parsing ${files.length} git-tracked source file(s) under ${ROOTS.join(', ')} (untracked scratch is not scanned)`)

  const failures = []

  // ORCH-workspace-link-stale-copy-1013: the report names the install path, not just the specifier,
  // because one workspace package occupies several (packages/mapspinner declares the UNSCOPED name
  // "mapspinner", so both node_modules/mapspinner and node_modules/@spoint/mapspinner are its).
  const links = ensureWorkspaceLinks()
  for (const c of links.created) console.log(`check: workspace link node_modules/${c.name} was missing and is now created -> packages/${c.dir}`)
  for (const r of links.repaired) {
    const kept = r.movedTo === null ? '' : ` -- the install it displaced is kept at ${r.movedTo}`
    console.log(`check: workspace link node_modules/${r.name} was ${r.kind} (not a link into packages/) and is now relinked -> packages/${r.dir}${kept}`)
  }
  for (const detail of links.failed) failures.push(`workspace link ${detail} -- run: node scripts/ensure-workspace-links.mjs`)

  const MAX_PARALLEL_CHECKS = 16
  let idx = 0
  async function worker() {
    while (idx < files.length) {
      const file = files[idx++]
      try {
        const buf = readFileSync(file)
        if (buf.length && buf[buf.length - 1] === 0) {
          failures.push({ file, error: 'trailing NUL byte(s) - file is corrupted (Windows Edit/Write artifact)' })
          continue
        }
      } catch (e) {
        failures.push({ file, error: 'unreadable: ' + e.message })
        continue
      }
      try {
        await execFileAsync(process.execPath, ['--check', file])
      } catch (e) {
        failures.push({ file, error: (e.stderr || e.message || '').toString().split('\n').slice(0, 3).join(' ') })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_CHECKS, files.length) }, worker))

  if (failures.length) {
    console.error(`check: ${failures.length} of ${files.length} files failed to parse:`)
    for (const f of failures) console.error(`  ${f.file}: ${f.error}`)
    process.exit(1)
  }
  console.log(`check: ${files.length} source files parse cleanly`)

  const GUARDED = ['src/netcode/NetworkState.js', 'src/sdk/EditorHandlers.js', 'src/apps/AppContext.js']
  const guardFails = []
  if (GUARDED.length === 0) guardFails.push('no write-boundary file is guarded -- the guardrail is vacuous')
  for (const rel of GUARDED) {
    const full = join(...rel.split('/'))
    let txt = ''
    try { txt = readFileSync(full, 'utf8') } catch (e) {
      guardFails.push(`${rel}: unreadable (${e.message}) -- its NaN-poison guard was not verified`)
      continue
    }
    if (!/shared\/vecGuard/.test(txt)) {
      guardFails.push(`${rel}: accepts external transforms but no longer imports shared/vecGuard - NaN-poison guard removed`)
    }
  }
  if (guardFails.length) {
    console.error(`check: ${guardFails.length} transform-validation guardrail violation(s):`)
    for (const g of guardFails) console.error(`  ${g}`)
    process.exit(1)
  }
  console.log(`check: transform-validation guardrail intact (${GUARDED.length} write-boundary files)`)

  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-relative-imports.mjs'])
    for (const line of stdout.split('\n')) if (line.trim()) console.log(`check: ${line}`)
  } catch (e) {
    console.error('check: relative import resolution:', (e.stderr || e.message || '').toString().trim())
    process.exit(1)
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-cache-keys.mjs'])
    for (const line of stdout.split('\n')) if (line.trim()) console.log(line)
  } catch (e) {
    console.error('check: bake code-version closure:', (e.stderr || e.message || '').toString().trim())
    process.exit(1)
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-tsl-imports.mjs'])
    for (const line of stdout.split('\n')) if (line.trim()) console.log(`check: ${line}`)
  } catch (e) {
    console.error('check: three export-name resolution:', (e.stderr || e.message || '').toString().trim())
    process.exit(1)
  }
  try {
    await execFileAsync(process.execPath, ['scripts/bundle-apps-manifest.mjs', '--check'])
    console.log('check: apps-manifest.json is in sync with ./apps')
  } catch (e) {
    console.error('check: apps-manifest.json regeneration failed:', e.stderr || e.message)
    process.exit(1)
  }
  try {
    await execFileAsync(process.execPath, ['scripts/gen-sdk-typings.mjs', '--check'])
  } catch (e) {
    console.error('check: generated SDK typings drift:', (e.stderr || e.message || '').toString().trim())
    process.exit(1)
  }
  console.log('check: generated SDK typings match src/apps/AppContext.js')
  const imports = await checkAppImports()
  if (imports.problems.length) {
    console.error(`check: ${imports.problems.length} app import/asset resolution problem(s):`)
    for (const p of imports.problems) console.error(`  ${p}`)
    process.exit(1)
  }
  if (NO_GPU_WITNESSES.length === 0 && SLOW_NO_GPU_WITNESSES.length === 0) {
    console.error('check: no gpu-free witness is listed, so the gpu-free witness arm proves nothing')
    process.exit(1)
  }
  // The arm no longer exits at the first red witness: one failure used to hide every sibling after
  // it plus both post-arm gates, so a lane could not tell its own status from CI's output. Each
  // witness is an independent process with its own timeout, verdict regex and `must` regex, so a
  // failure is recorded and the arm runs on; the build still fails, but on the complete list.
  let noGpuMs = 0
  const noGpuFailures = []
  async function runNoGpuWitnesses(list, timeoutMs) {
    for (const spec of list) {
      const rel = join('scripts', spec.file)
      let source = ''
      try {
        source = readFileSync(rel, 'utf8')
      } catch (e) {
        noGpuFailures.push({ file: spec.file, code: null, reasons: [`unreadable (${e.message}), so its assertions never ran`], echo: [] })
        console.error(`check: gpu-free witness ${spec.file} FAILED (never ran, unreadable) -- recorded; the arm runs every witness so the failure list is complete`)
        continue
      }
      const gpuHit = NO_GPU_WITNESS_GPU_SURFACE.exec(source)
      if (gpuHit !== null) {
        noGpuFailures.push({ file: spec.file, code: null, reasons: [`reaches the "${gpuHit[0]}" surface, so it cannot run where CI has no GPU -- move it behind SPOINT_GPU_WITNESS`], echo: [] })
        console.error(`check: gpu-free witness ${spec.file} FAILED (never ran, reaches the "${gpuHit[0]}" surface) -- recorded; the arm runs every witness so the failure list is complete`)
        continue
      }
      const started = Date.now()
      let stdout = ''
      let stderr = ''
      let code = 0
      let killed = false
      try {
        const done = await execFileAsync(process.execPath, [rel, ...(spec.args ?? [])], { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs })
        stdout = done.stdout
      } catch (e) {
        stdout = (e && e.stdout) || ''
        stderr = (e && e.stderr) || ''
        code = Number.isInteger(e.code) ? e.code : 1
        killed = e.killed === true
      }
      const ms = Date.now() - started
      noGpuMs += ms
      const verdict = noGpuVerdict(stdout)
      const witnessFailures = []
      if (killed) witnessFailures.push(`ran past the ${timeoutMs / 1000} s cap and was killed`)
      if (code !== 0) witnessFailures.push(`exited ${code}`)
      if (verdict.verdict === 'FAIL') witnessFailures.push(`reported ${verdict.line}`)
      if (stdout.trim() === '') witnessFailures.push('printed nothing, so silence cannot be told apart from a witness that never asserted')
      if (spec.must && !spec.must.test(stdout)) witnessFailures.push(`printed no line matching ${spec.must}, so its assertions never ran`)
      if (witnessFailures.length > 0) {
        noGpuFailures.push({ file: spec.file, code, reasons: witnessFailures, echo: echoLines(`${stdout}\n${stderr}`, NO_GPU_WITNESS_ECHO_LINES) })
        console.error(`check: gpu-free witness ${spec.file} FAILED (${(ms / 1000).toFixed(1)} s, exit ${code}): ${witnessFailures.join('; ')} -- recorded; the arm runs every witness so the failure list is complete`)
      } else {
        console.log(`check: gpu-free witness ${spec.file} ${(ms / 1000).toFixed(1)} s, exit 0, ${verdict.line ?? 'no RESULT: line, so exit 0 is the verdict'}`)
      }
    }
  }
  await runNoGpuWitnesses(NO_GPU_WITNESSES, NO_GPU_WITNESS_TIMEOUT_MS)
  await runNoGpuWitnesses(SLOW_NO_GPU_WITNESSES, SLOW_WITNESS_TIMEOUT_MS)
  const noGpuCount = NO_GPU_WITNESSES.length + SLOW_NO_GPU_WITNESSES.length
  console.log(`check: ${noGpuCount} gpu-free witness(es) ran in ${(noGpuMs / 1000).toFixed(1)} s with no GPU required`)

  // These gates read committed state, not any witness's artefact, so a red witness above is no
  // reason to withhold their verdicts.
  const gateFailures = []

  // ORCH-gate-hygiene-draco-and-docclaim-1013: edge-collider-draco-witness.mjs strips Draco out of a
  // real GLB, and AGENTS.md records that a strip run rewrites the tracked binary in place, so it must
  // never be reachable from an ordinary `npm test`. It is therefore absent from both gpu-free lists
  // above and runs only behind SPOINT_STRIP_WITNESS=1 -- the same explicit opt-in shape
  // SPOINT_GPU_WITNESS gives the browser arms. A witness that mutates tracked binaries is not a gate
  // witness, and a gate must not be able to trigger it by accident.
  if (process.env.SPOINT_STRIP_WITNESS === '1') {
    const stripFile = 'edge-collider-draco-witness.mjs'
    const stripMust = /0 byte\(s\) written into the tracked tree/
    const stripStarted = Date.now()
    let stripOut = ''
    let stripCode = 0
    try {
      const done = await execFileAsync(process.execPath, [join('scripts', stripFile)], { maxBuffer: 16 * 1024 * 1024, timeout: NO_GPU_WITNESS_TIMEOUT_MS })
      stripOut = done.stdout
    } catch (e) {
      stripOut = (e && e.stdout) || ''
      stripCode = Number.isInteger(e.code) ? e.code : 1
    }
    const stripMs = Date.now() - stripStarted
    if (stripCode !== 0 || !stripMust.test(stripOut)) {
      gateFailures.push(`${stripFile}: exit ${stripCode} in ${(stripMs / 1000).toFixed(1)}s${stripMust.test(stripOut) ? '' : ', printed no line proving 0 byte(s) reached the tracked tree'}`)
      for (const line of echoLines(stripOut, NO_GPU_WITNESS_ECHO_LINES)) console.error(`check: ${line}`)
    } else {
      console.log(`check: opt-in strip witness ${stripFile} ${(stripMs / 1000).toFixed(1)} s, exit 0, ${noGpuVerdict(stripOut).line}`)
    }
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/fire-witness-gate.mjs'], { maxBuffer: 16 * 1024 * 1024 })
    for (const line of stdout.split('\n')) if (line.trim()) console.log(`check: ${line}`)
  } catch (e) {
    const out = (e.stdout || '').toString()
    for (const line of out.split('\n')) if (line.trim()) console.error(`check: ${line}`)
    gateFailures.push(`fire-witness-gate.mjs: ${(e.stderr || e.message || '').toString().trim()}`)
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-frame-time-baselines.mjs'])
    for (const line of stdout.split('\n')) if (line.trim()) console.log(line)
  } catch (e) {
    gateFailures.push(`check-frame-time-baselines.mjs: ${(e.stderr || e.stdout || e.message || '').toString().trim()}`)
  }
  // PERF-veg-trees-missing-1013. The tree count this arm pins is the one the owner reported missing:
  // trees alive at the end of the settle, and the same counter alongside the vegetation draw counter
  // after a 45 s walk, so a regression that loses trees only once the player moves cannot pass here.
  // The `must` is the second half of the witness: a run that printed no profile, whose vegetation
  // never issued a draw, or whose walk never moved, must read as a failure rather than as silence
  // that passes.
  const VEG_INSTANCE_MUST = /\[PASS\] vegetation has instances after the player stands on open ground \(vegTotal=[1-9]\d*[\s\S]*\[PASS\] vegetation issues draw calls \(vegDraws=[\d.]+ impostor=[\d.]+\)[\s\S]*\[PASS\] vegetation is still drawn after a walk \(vegTotal=[1-9]\d* vegDraws=[1-9][\d.]*\)[\s\S]*RESULT: PASS vegTotal=[1-9]\d* peak=[1-9]\d*/
  const gpuArms = (process.env.SPOINT_GPU_WITNESS || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const gpu of gpuArms) {
    const keep = (line) => /^(\[veg-witness\]|RESULT:|  \[(PASS|FAIL)\])/.test(line)
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/veg-instance-browser-witness.mjs', `--gpu=${gpu}`, '--at=-15,-12.5', '--settle=15000', '--walk=45000'], { maxBuffer: 16 * 1024 * 1024 })
      for (const line of stdout.split('\n')) if (keep(line)) console.log(`check: ${line}`)
      if (!VEG_INSTANCE_MUST.test(stdout)) gateFailures.push(`veg-instance-browser-witness.mjs on ${gpu}: printed no line pinning a non-zero tree count at rest and after the walk, so either its profiles or its walk never ran`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (keep(line)) console.error(`check: ${line}`)
      gateFailures.push(`veg-instance-browser-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  // PERF-hitch-perframe-allocation-r1: the per-frame allocation arm reaches cdp-browser, so like
  // every other browser witness it rides behind SPOINT_GPU_WITNESS and gpulock rather than the
  // gpu-free arm, which refuses it by name. The `must` pins the measured rate, the population it was
  // measured at and the worst pause, so an exit 0 from a run that stopped measuring still fails here.
  if (process.env.SPOINT_GPU_WITNESS) {
    const allocFile = 'per-frame-allocation-browser-witness.mjs'
    const allocMust = /RESULT: PASS label=per-frame-allocation -- [1-9]\d* B\/frame at [1-9]\d* entities \/ [1-9]\d* draw calls over [1-9]\d* frames, worst GC pause [\d.]+ms/
    const started = Date.now()
    let allocOut = ''
    let allocCode = 0
    try {
      const done = await execFileAsync(process.execPath, [join('scripts', allocFile), '--frames=2400'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      allocOut = done.stdout
    } catch (e) {
      allocOut = (e && e.stdout) || ''
      allocCode = Number.isInteger(e.code) ? e.code : 1
    }
    const allocMs = Date.now() - started
    if (allocCode !== 0 || !allocMust.test(allocOut)) {
      gateFailures.push(`${allocFile}: exit ${allocCode} in ${(allocMs / 1000).toFixed(1)}s${allocMust.test(allocOut) ? '' : ', printed no line pinning a measured bytes/frame rate and worst pause'}`)
      for (const line of echoLines(allocOut, NO_GPU_WITNESS_ECHO_LINES)) console.error(`check: ${line}`)
    } else {
      console.log(`check: gpu-arm witness ${allocFile} ${(allocMs / 1000).toFixed(1)} s, exit 0, ${noGpuVerdict(allocOut).line}`)
    }
  }
  // PERF-camera-eye-height-above-grass-1013. Every GROUND is already published as one surface to
  // under 0.098 m out to 400 m (scripts/player-ground-hover-witness.mjs), so the owner-visible
  // "we're hovering far above the grass" is an EYE question, and camera Y only exists in a page.
  // This arm measures the eye above the player's feet and above the grass under the eye at five
  // distances, and pins the TPS rig's own identity (eye = mesh base + headHeight + 0.2 -
  // sin(pitch)*boom, client/core/camera.js updateTPS) so the owning layer is named by arithmetic
  // rather than by a screenshot nobody in CI can look at. It boots a browser, so it rides
  // SPOINT_GPU_WITNESS and gpulock and never the gpu-free arm. The `must` is the second half of
  // the witness: a run that measured no rung, or one whose rig identity never held, must read as
  // a failure rather than as silence that passes.
  if (process.env.SPOINT_GPU_WITNESS) {
    const eyeFile = 'camera-eye-height-above-grass-witness.mjs'
    const eyeMust = /\[camera-eye-height\] RESULT: PASS label=camera-eye-height -- eye-above-feet [\d.]+ \.\. [\d.]+ m, eye-above-grass [\d.]+ \.\. [\d.]+ m, worst spread [\d.]+ m, implied headHeight [\d.]+ \.\. [\d.]+ m over [1-9]\d* rung\(s\), rebase\(s\) \d+/
    const eyeKeep = (line) => /^(RESULT:|\[camera-eye-height\])/.test(line)
    const eyeStarted = Date.now()
    let eyeOut = ''
    let eyeCode = 0
    try {
      const done = await execFileAsync(process.execPath, [join('scripts', eyeFile), `--gpu=${gpuArms[0] || 'amd'}`, '--settle=18000', '--rung-settle=4000'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      eyeOut = done.stdout
    } catch (e) {
      eyeOut = (e && e.stdout) || ''
      eyeCode = Number.isInteger(e.code) ? e.code : 1
    }
    const eyeMs = Date.now() - eyeStarted
    if (eyeCode !== 0 || !eyeMust.test(eyeOut)) {
      gateFailures.push(`${eyeFile}: exit ${eyeCode} in ${(eyeMs / 1000).toFixed(1)}s${eyeMust.test(eyeOut) ? '' : ', printed no line pinning a measured eye-above-feet and eye-above-grass at every rung'}`)
      for (const line of echoLines(eyeOut, NO_GPU_WITNESS_ECHO_LINES)) console.error(`check: ${line}`)
    } else {
      console.log(`check: gpu-arm witness ${eyeFile} ${(eyeMs / 1000).toFixed(1)} s, exit 0, ${noGpuVerdict(eyeOut).line}`)
      for (const line of eyeOut.split('\n')) if (eyeKeep(line) && /RESULT:/.test(line)) console.log(`check: ${line}`)
    }
  }
  // Owner-reported hard hitches when the landscape changes (row
  // PERF-landscape-change-hitch-r270-74). This witness boots a real browser, so it rides the same
  // opt-in GPU arm as the veg witness and never the gpu-free one. Its `must` is the second half of
  // the witness: a run that printed no distribution, or one whose window exercised no first draw,
  // must read as a failure rather than as silence that passes. It also pins the fix's own counted
  // work unit -- synchronous createRenderPipeline on the draw path must be 0 -- so a regression that
  // puts compilation back on the draw path reds this arm even if the frame distribution still
  // happens to hold.
  const GPU_HITCH_MUST = /\[landscape-change-hitch-witness\] first-draw compilation exercised by this window: [1-9]\d* pipeline\/shaderModule unit\(s\)[\s\S]*\[landscape-change-hitch-witness\] wall\(rAF delta\) \{"n":[1-9]\d*,"p50":[\d.]+,"p95":[\d.]+,"p99":[\d.]+,"max":[\d.]+[\s\S]*\[landscape-change-hitch-witness\] cpu\(main-thread frame cost\) \{"n":[1-9]\d*,"p50":[\d.]+,"p95":[\d.]+,"p99":[\d.]+,"max":[\d.]+[\s\S]*synchronous createRenderPipeline on the draw path over the window: 0[\s\S]*RESULT: PASS arm=\S+ label=landscape-change-hitch-witness/
  const gpuHitchKeep = (line) => /^(RESULT:|\[landscape-change-hitch-witness\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/landscape-change-hitch-witness.mjs', `--gpu=${gpu}`, '--settle=4000', '--measure=30000', '--worst=10', '--worst-cpu=4'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (gpuHitchKeep(line)) console.log(`check: ${line}`)
      if (!GPU_HITCH_MUST.test(stdout)) gateFailures.push(`landscape-change-hitch-witness.mjs on ${gpu}: printed no line matching its must regex, so either its distribution or its first-draw floor never ran`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (gpuHitchKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`landscape-change-hitch-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  // PERF-authoritative-draw-count-1013: the authoritative per-frame draw and instance inventory of a
  // shipped world, split by draw band (terrain/veg/grass/rocks/water/shadow/...), counted at the API
  // boundary (`drawsInstrument.authoritativeField`). It boots a real browser, so it rides the same
  // opt-in GPU arm as the veg witness and never the gpu-free one. Its `must` is the second half of
  // the witness: a run that printed no band table, whose authoritative field never resolved, or whose
  // counters never moved, must read as a failure rather than as silence that passes.
  // PERF-rocks-multidrawcount-stale-1013: the `must` no longer accepts a rocks band of 0. `measured`
  // plus a non-zero `rocksDrawsPerFrame` is the only passing shape now: `proven-zero-batch-count` was
  // the measured name of the defect (a populated batch that drew nothing), not a verdict, and this
  // arm runs the default world, which places rocks, so `proven-empty` is the same defect wearing a
  // different reason. A band that disagrees with the batch's own `_multiDrawCount` still fails as
  // `instrument-gap`, and the two mutation arms must still have moved the number in both directions.
  const DRAW_INSTRUMENT_MUST = /\[draw-instrument\] MEASURED authoritative-draw-count: \{[^\n]*"authoritativeField":"(wgpuDrawsPerFrame|glDrawCallsPerFrame)"[\s\S]*\[draw-instrument\] band draws\/frame: terrain=[1-9][\d.]*[\s\S]*\[draw-instrument\] band instances\/frame:[\s\S]*\[draw-instrument\] api boundary:[\s\S]*\[draw-instrument\] liveness: info\.render\.calls [1-9]\d* -> [1-9]\d* \(moved=true\)[\s\S]*\[draw-instrument\] MEASURED rocks-batch-attribution: \{"placed":\d+[\s\S]*"rocksDrawsPerFrame":[1-9][\d.]*[\s\S]*"reason":"measured"[\s\S]*RESULT: PASS arm=draw-instrument/
  const drawInstrumentKeep = (line) => /^(RESULT:|\[draw-instrument\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/draw-instrument-witness.mjs', `--gpu=${gpu}`, '--settle=12000', '--frames=40', '--timeout=540000'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (drawInstrumentKeep(line)) console.log(`check: ${line}`)
      if (!DRAW_INSTRUMENT_MUST.test(stdout)) gateFailures.push(`draw-instrument-witness.mjs on ${gpu}: printed no line matching its must regex, so either its band inventory or its counter-moved floor never ran`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (drawInstrumentKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`draw-instrument-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  // PERF-grass-density-fade-visual-1013. The distance-density law, its fade and the greater ring
  // landed on gpu-free pins (instances, triangles, the ring, the near density and the two no-pop
  // invariants), but the criterion that needs pixels -- that the drop-off reads as a GROWTH and not
  // a step at near / mid / far, and that the enlarged camera-facing far clumps still read as grass
  // -- cannot be seen by a counter. This arm boots the real page on the pinned adapter, REFUSES a
  // silent fallback off WebGPURenderer/webgpu (which would run a different shader path), reads the
  // uncaptured WebGPU error hook, and reports the browser grass inventory per distance band, the
  // per-band apparent density as the pixels grass actually paints against a noise floor measured by
  // diffing two grass-on frames, and the pop count over a real walk. Its `must` is the second half
  // of the witness: a run whose renderer is not WebGPU, whose audit sampled nothing, whose grass
  // painted no pixels in a band, or whose pop count is not zero, must fail rather than pass in
  // silence.
  const GRASS_FADE_VISUAL_MUST = /\[grass-fade-visual\] MEASURED browser grass inventory: instances \d+ -> [1-9][\d.]* \(near [1-9][\d.]*\), triangles [1-9][\d.]*, ring [\d.]+m[\s\S]*\[grass-fade-visual\] MEASURED band near \[0,\d+\)m:[^\n]*instances=[1-9]\d*[^\n]*grassPixels=[1-9]\d*[\s\S]*\[grass-fade-visual\] MEASURED band far-beyond \[[1-9]\d*,ring\]m:[^\n]*instances=[1-9]\d*[^\n]*grassPixels=[1-9]\d*[\s\S]*\[grass-fade-visual\] MEASURED popping: popOut=0 \(atRest=0 moving=\d+\) missingVisible=\d+ \(atRest=0 moving=\d+\) nearNotFull=0 overreach=0[\s\S]*RESULT: PASS label=\S+/
  const grassFadeKeep = (line) => /^(RESULT:|\[grass-fade-visual\]|  \[(PASS|FAIL)\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/grass-density-fade-visual-witness.mjs', `--gpu=${gpu}`, '--rebuild-bundle', '--settle=25000', '--walk=20000'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (grassFadeKeep(line)) console.log(`check: ${line}`)
      if (!GRASS_FADE_VISUAL_MUST.test(stdout)) gateFailures.push(`grass-density-fade-visual-witness.mjs on ${gpu}: printed no line pinning a non-zero browser grass inventory, a per-band apparent density and a zero pop count, so either its renderer assertion, its band capture or its walk audit never ran`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (grassFadeKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`grass-density-fade-visual-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  // PERF-occlusion-retarget-ab-1013. Whether the retargeted occlusion tier PAYS FOR ITSELF, read in
  // both currencies on ONE instrument: draws at the API boundary (the same
  // `drawsInstrument.authoritativeField` the draw-count row above reports, so the two pictures are
  // comparable rather than two inventories) and main-thread CPU in ms/frame (CDP ThreadTime, the one
  // clock vsync does not quantize -- the rAF wall here is a refresh multiple and is printed, never
  // decided on). Both arms run inside ONE page load, one GPU lock hold and one continuous walk,
  // interleaved, each warmed past the policy's own 90-frame stale-resolve reveal so neither arm is
  // measured still carrying the other's hide state. The ON arm is pinned at the tier's own ceiling
  // (96 = occlusionQueryBudget.maxTotalBudget) and merely RECORDS what the frame-time allocator was
  // asking for, because that allocator allocates 0 on any frame it judges fast and forwarding its
  // number would measure the allocator instead of the mechanism. Its `must` is the second half of
  // the witness: a run whose cull never issued, whose arm switch never took (hiddenKeysMax 0 on
  // both arms is one arm measured twice), whose CPU clock never read, or whose near/mid band fell
  // under its floor, must read as a failure rather than as silence that passes. The verdict is
  // reported but not pinned to a value -- the measurement decides it, and a cull that starts
  // removing draws must not be able to turn this gate red by succeeding.
  const OCC_AB_MUST = /\[occ-ab\] MEASURED occlusion-retarget A\/B: tier=webgpu-hiz field=wgpuDrawsPerFrame OFF [1-9][\d.]* draw\(s\)\/frame at [\d.]+ ms\/frame CPU, ON [1-9][\d.]* draw\(s\)\/frame at [\d.]+ ms\/frame CPU, [\d.]+ draw\(s\)\/frame saved for -?[\d.]+ ms\/frame, headroom [\d.]+ ms\/frame, verdict=(PAYS|PAYS-IN-DRAWS-OVER-BUDGET|DOES-NOT-PAY),[\s\S]*\[occ-ab\] RESULT: PASS[^\n]*cullRan=true instrumentCounted=true armTook=true[^\n]*warmed=true cpuRead=true nearOk=true midOk=true/
  const occAbKeep = (line) => /^(RESULT:|\[occ-ab\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/occlusion-retarget-ab-witness.mjs', `--gpu=${gpu}`, '--frames=60', '--warm=150', '--windows=3'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (occAbKeep(line)) console.log(`check: ${line}`)
      if (!OCC_AB_MUST.test(stdout)) gateFailures.push(`occlusion-retarget-ab-witness.mjs on ${gpu}: printed no line matching its must regex, so either the A/B never ran or its gates did not all hold`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (occAbKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`occlusion-retarget-ab-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  // PERF-maxlevel-cpu-ladder-r1: the per-level cost gradient of `maxLevel` ABOVE the level the frame
  // wall can resolve, on an instrument proven to have unlocked rAF. s6's locked ladder read
  // L11=L16=L22=33.36 ms -- every median a multiple of the 16.68 ms refresh period -- so levels
  // above 11 were indistinguishable on it, and `splitFactor` is inert (s6/s13). This arm unlocks rAF
  // and refuses a run whose medians are still on that grid: the `must` names `unlockRaf:true`, the
  // measured ladder and the crossover level, so a run that stayed vsync-locked, one whose rAF never
  // unlocked, or one that resolved no level, reads as a failure rather than as silence that passes.
  const MAXLEVEL_LADDER_MUST = /\[maxlevel\] cost moves at L[1-9]\d*:[\s\S]*\[maxlevel\] MEASURED maxlevel-cpu-ladder: \{[^\n]*"unlockRaf":true[\s\S]*RESULT: PASS arm=maxlevel-cpu-ladder/
  const maxlevelKeep = (line) => /^(RESULT:|\[maxlevel\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/maxlevel-crossover-witness.mjs', `--gpu=${gpu}`, '--viewport=1920x1080', '--knob=dprOff=true,qualityGovernorOff=true', '--sample-ms=5000', '--desc-sample-ms=4000'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (maxlevelKeep(line)) console.log(`check: ${line}`)
      if (!MAXLEVEL_LADDER_MUST.test(stdout)) gateFailures.push(`maxlevel-crossover-witness.mjs on ${gpu}: printed no line matching its must regex, so either its unlock proof or the crossover level it must name never ran`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (maxlevelKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`maxlevel-crossover-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  // PERF-cold-load-and-first-frame-1013: cold-load time-to-first-frame and the first frame's own
  // cost, measured on one instrument. It boots a real browser on the pinned vendor adapter, so it
  // rides the same opt-in GPU arm as the veg witness and never the gpu-free one. Its `must` is the
  // second half of the witness: a run whose first reported frame is NOT frame 1 -- the 250ms clock
  // swallowed the first rendered frame again -- whose first frame carries no render cost, or whose
  // boot shader warm wait never reported what it waited for, must read as a failure rather than as
  // silence that passes.
  const FIRST_FRAME_MUST = /\[first-frame\] MEASURED cold-load: time-to-first-frame [1-9][\d.]*ms[\s\S]*warm wait [\d.]+ms with \S+ outstanding[\s\S]*\[first-frame\] MEASURED worker-cold-start: init->ready [1-9][\d.]*ms, init->first-reported-frame [1-9][\d.]*ms, first reported frame number 1, its render cost [1-9][\d.]*ms[\s\S]*RESULT: PASS arm=\S+ label=first-frame-boot-witness/
  const firstFrameKeep = (line) => /^(RESULT:|\[first-frame\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/first-frame-boot-witness.mjs', `--gpu=${gpu}`, '--observe=4000', '--before-worker=auto'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (firstFrameKeep(line)) console.log(`check: ${line}`)
      if (!FIRST_FRAME_MUST.test(stdout)) gateFailures.push(`first-frame-boot-witness.mjs on ${gpu}: printed no line matching its must regex, so either the first frame was swallowed by the 250ms clock again or the cold-load figure never resolved`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (firstFrameKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`first-frame-boot-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  // A species that fails to build used to shrink the landscape instead of refusing, so the boot
  // looked healthy with nothing in it. Commit 1e89f8c9 made the build refuse, and species started
  // building -- and the boot stopped completing inside the budget a lane had been using, which read
  // as a hang. It is not one: the species build is real work, and on a software adapter it measures
  // about 14s per species over 45 of them. This arm is the instrument that separates the two, and it
  // does it by polling rather than by waiting on isReady: it records the loading machine's own state,
  // every `boot:*` performance mark and the vegetation instance count, and reports the last mark the
  // page reached, because "not-ready after N ms" distinguishes nothing. The `must` is the second
  // half: a run that never reached readiness is a FAIL, and so is one that reached it with
  // vegInstances 0 -- a boot with no trees in it is the silent-empty-world this exists to refuse.
  const VEG_WARM_DRAIN_MUST = /RESULT: PASS label=veg-warm-drain -- ready at [1-9]\d*ms with vegInstances=[1-9]\d* over [1-9]\d* mesh\(es\)/
  const vegWarmDrainKeep = (line) => /^(RESULT:|\[veg-warm-drain\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileSync(process.execPath, ['scripts/veg-warm-drain-boot-witness.mjs', '--timeout=540000', '--poll=2000'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (vegWarmDrainKeep(line)) console.log(`check: ${line}`)
      if (!VEG_WARM_DRAIN_MUST.test(stdout)) gateFailures.push(`veg-warm-drain-boot-witness.mjs on ${gpu}: printed no line pinning a ready time with a non-zero vegetation instance count, so either the boot never settled or it settled with no species built`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (vegWarmDrainKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`veg-warm-drain-boot-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  // PERF-grass-coherent-wind-webgpu-arm-1013. The wind lane that landed the join measured it on the
  // WebGL FALLBACK and vsync-locked, so the path that ships -- the TSL/WGSL one, where
  // client/core/GrassTSL.js's gustField samples a texture in the VERTEX stage with an explicit
  // level 0 -- had never been compiled by a real WebGPU driver, and a textureSample there is
  // illegal in WGSL while textureSampleLevel is not. It matters because the failure is silent: a
  // pipeline that fails validation dispatches nothing and surfaces nothing, and its error arrives
  // only ASYNC on device.onuncapturederror, so a clean console is not evidence. This arm boots on
  // the pinned vendor adapter and reads THREE error channels instead: getCompilationInfo() on every
  // WGSL module carrying a grass marker, a push/popErrorScope('validation') around every pipeline
  // creation, and an uncapturederror listener. It does not stop at "it compiled": grass has to
  // still DRAW (attributed by hiding it, so the count has a reason and not a bare zero) and the
  // wind has to still ANIMATE (read from the checksums of the 64x64 rgba16float field the CPU hands
  // the GPU, which is the only counter that can tell a live field from a frozen one). The `must` is
  // the second half: `backend=webgpu class=WebGPURenderer` refuses a run that fell back again, and
  // every pin below is a counter that must be non-zero or must be zero -- a run that installed no
  // instrument, read no error channel, found no grass module or drew no grass reads as a failure
  // rather than as silence that passes. `ab=` is allowed to be UNRESOLVED and is printed either
  // way: the CPU half of the join is switchable in one page load but the GPU half is not, so a
  // number the box cannot resolve must not be quoted as one.
  const GRASS_WIND_MUST = /RESULT: PASS label=grass-wind-webgpu[\s\S]*backend=webgpu class=WebGPURenderer[\s\S]*grassModules=[1-9]\d*[\s\S]*compiled=true[\s\S]*validationErrors=0[\s\S]*uncaptured=0[\s\S]*vertexSampleLevel=true[\s\S]*drawsPerFrame=[1-9][\d.]*[\s\S]*grassDrawsPerFrame=[1-9][\d.]*[\s\S]*instances=[1-9]\d*[\s\S]*animates=[1-9]\d*\/[1-9]\d*[\s\S]*fieldCpuMsPerFrame=0\.000->[\d.]+\/[\d.]+\/[\d.]+[\s\S]*ab=(RESOLVED|UNRESOLVED)[\s\S]*recentre=\d+ in [\d.]+m worst [\d.]+ms[\s\S]*contention=(clean|CONTESTED) x[\d.]+/
  const grassWindKeep = (line) => /^(RESULT:|\[grass-wind-webgpu\]|  \[(PASS|FAIL)\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/grass-wind-webgpu-witness.mjs', `--gpu=${gpu}`, '--settle=40000', '--control=10000', '--ab=6000', '--windows=8', '--walk=45000'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (grassWindKeep(line)) console.log(`check: ${line}`)
      if (!GRASS_WIND_MUST.test(stdout)) gateFailures.push(`grass-wind-webgpu-witness.mjs on ${gpu}: printed no line matching its must regex, so either it fell back off the webgpu backend, its compile/error channels never ran, or grass never drew`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (grassWindKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`grass-wind-webgpu-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  console.log(`check: ${imports.appCount} apps resolve every import through the worker path, ${imports.assetCount} asset references exist`)
  if (noGpuFailures.length > 0) {
    console.error(`check: ${noGpuFailures.length} of ${noGpuCount} gpu-free witness(es) failed -- all ${noGpuCount} ran, so this is the complete failure list:`)
    for (const f of noGpuFailures) {
      console.error(`  FAIL ${f.file} exit ${f.code === null ? 'never ran' : f.code}: ${f.reasons.join('; ')}`)
      for (const line of f.echo) console.error(`    ${f.file} out ${line}`)
    }
    console.error(`check: failing gpu-free witness(es): ${noGpuFailures.map((f) => f.file).join(', ')}`)
  }
  if (gateFailures.length > 0) {
    console.error(`check: ${gateFailures.length} post-arm gate(s) failed:`)
    for (const g of gateFailures) console.error(`  FAIL ${g}`)
  }
  if (noGpuFailures.length > 0 || gateFailures.length > 0) process.exit(1)
}

main().catch((e) => { console.error('check: harness error:', e); process.exit(2) })
