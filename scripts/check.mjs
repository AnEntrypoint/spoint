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
  { file: 'tps-game-player-movement-witness.mjs', must: /RESULT: PASS: walked [1-9][\d.]*m over [1-9]\d* input step\(s\) and [1-9]\d* tick\(s\) in world=tps-game/ },
  { file: 'placement-climate-gate-witness.mjs', must: /RESULT: PASS identical true over [1-9]\d* veg and [1-9]\d* rock placement\(s\)[\s\S]*over [1-9]\d*\/[1-9]\d*\/[1-9]\d*\/[1-9]\d* placement\(s\) \(quarter-chunk control [1-9]\d* of [1-9]\d*\)/ },
  { file: 'check-cache-keys-scope-witness.mjs', must: /verifying 2 artifact\(s\) of the 2 tracked/ },
  { file: 'edge-collider-draco-witness.mjs', must: /0 byte\(s\) written into the tracked tree/ },
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
  // gpu-free: it measures the bend the shader computes, not pixels. Whether that much bend is VISIBLE
  // still needs a real frame, and that arm is a browser arm this CI does not run.
  { file: 'grass-bend-geometry-witness.mjs', must: /\[PASS\] the bend is quadratic in the card height coordinate[\s\S]*\[PASS\] the change is under 8% of the card height at the wind that ships[\s\S]*RESULT: PASS/ },
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
  // PERF-shadow-cascade-redraw-hitch-1013: how many cascade shadow maps one frame re-renders while
  // the player travels, unbounded against shipped. The `must` is the second half of the witness: a
  // run that printed no ladder, one whose unbounded arm never put all three cascades on one frame, or
  // one whose shipped arm did not cut that, must read as a failure rather than as silence that
  // passes. The cascade 0 figure is the fidelity pin -- the near cascade redraws on every frame in
  // both arms, so the near band's cadence is not what the budget bought.
  { file: 'shadow-cascade-redraw-witness.mjs', must: /RESULT: PASS label=shadow-cascade-redraw -- worst cascade redraw\(s\) in one frame while travelling 3m\/s:3->2 6m\/s:3->3 12m\/s:3->3 20m\/s:3->3 \(of 3\); frame\(s\) redrawing all three 3m\/s:31->0 6m\/s:178->3 12m\/s:671->174 20m\/s:1553->651; far redraw\(s\) 3m\/s:839->836 6m\/s:1613->1592 12m\/s:3069->2905 20m\/s:4662->3974; cascade 0 3600\/3600 frame\(s\) unchanged/ },
  { file: 'webgpu-pipeline-validation-refusal-witness.mjs', must: /\[PASS\] A1 real WGSL validates all four pipelines -- pipelinesValidated=4[\s\S]*\[PASS\] B1 broken WGSL is REFUSED --[\s\S]*\[PASS\] M1 without the error scope the same broken WGSL is NOT refused[\s\S]*RESULT: PASS/ },
  { file: 'tree-texture-budget-witness.mjs', must: /the leaf default is an eighth of the source, not the source[\s\S]*RESULT: PASS/ },
  // gpu-free: it builds the real node graph and models the sampler in JS, so no adapter is touched.
  // The second half of the witness is the `must`: a run that never swept a footprint inside the
  // coincide band, or never swept one outside it, has to read as a failure rather than as silence
  // that passes -- without an out-of-band sample the guard is decorative and unproven.
  { file: 'surface-splat-octave-tap-witness.mjs', must: /MEASURED surface-splat-octave-tap: [1-9]\d* in-band footprint\(s\) collapse to one tap set, [1-9]\d* do not, [1-9]\d* check\(s\) passed[\s\S]*RESULT: PASS [1-9]\d* check\(s\) label=surface-splat-octave-tap/ },
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
  { file: 'nearfield-lod-lattice-witness.mjs', must: /\[nearfield-lattice\] PIN near-field density boot L13: rendered 1\.2775 m, grass placement lattice 2 m, collider lattice 1 m, near-field lattice step 1 m == collider 1 m at all 8 tier\(s\), measured step [\d.]+ m u \/ [\d.]+ m v; trees placed over the near band: [1-9]\d* over [1-9]\d* chunk\(s\)[\s\S]*checks [1-9]\d* passed, 0 failed[\s\S]*RESULT: PASS/ },
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
]
const NO_GPU_WITNESS_TIMEOUT_MS = 120000
const SLOW_WITNESS_TIMEOUT_MS = 600000
const SLOW_NO_GPU_WITNESSES = [
  { file: 'planet-multiplayer-harness.mjs', args: ['--n=8'], must: /RESULT: PASS -- [1-9]\d* of [1-9]\d* check\(s\) passed/ },
  { file: 'collider-ring-scale-witness.mjs', must: /\[ring-scale\] [1-9]\d* passed, 0 failed[\s\S]*\[ring-scale\] RESULT: PASS/ },
  { file: 'collider-ring-boot-batches-witness.mjs', must: /ms per 1k operation\(s\) over [1-9]\d* operation\(s\)/ },
  // PERF-terrain-collider-ring-hitch-1013. The `must` is the second half of the witness: a run that
  // printed no A/B, one whose realistic arm reached the eviction path it is supposed to find
  // unreachable, or one whose eviction-pressure arm never evicted, must read as a failure rather
  // than as silence that passes.
  { file: 'collider-ring-frame-cost-witness.mjs', must: /\[ring-frame\] 8 walking, shipped cap:[^\n]*evict scan 0 \/ evicted 0[\s\S]*\[ring-frame\] 8 walking, tight cap 64:[^\n]*evict scan [1-9]\d* \/ evicted [1-9]\d*[\s\S]*\[ring-frame\] A\/B: 8 player\(s\) frame wall max [\d.]+ ms walking vs [\d.]+ ms settled[\s\S]*\[ring-frame\] A\/B: 48 player\(s\) frame wall max [\d.]+ ms walking vs [\d.]+ ms settled[\s\S]*\[ring-frame\] [1-9]\d* passed, 0 failed[\s\S]*\[ring-frame\] RESULT: PASS/ },
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
  const gpuArms = (process.env.SPOINT_GPU_WITNESS || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const gpu of gpuArms) {
    const keep = (line) => /^(\[veg-witness\]|RESULT:|  \[(PASS|FAIL)\])/.test(line)
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/veg-instance-browser-witness.mjs', `--gpu=${gpu}`, '--at=-15,-12.5', '--settle=15000', '--walk=45000'], { maxBuffer: 16 * 1024 * 1024 })
      for (const line of stdout.split('\n')) if (keep(line)) console.log(`check: ${line}`)
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
  const DRAW_INSTRUMENT_MUST = /\[draw-instrument\] MEASURED authoritative-draw-count: \{[^\n]*"authoritativeField":"(wgpuDrawsPerFrame|glDrawCallsPerFrame)"[\s\S]*\[draw-instrument\] band draws\/frame: terrain=[1-9][\d.]*[\s\S]*\[draw-instrument\] band instances\/frame:[\s\S]*\[draw-instrument\] api boundary:[\s\S]*\[draw-instrument\] liveness: info\.render\.calls [1-9]\d* -> [1-9]\d* \(moved=true\)[\s\S]*RESULT: PASS arm=draw-instrument/
  const drawInstrumentKeep = (line) => /^(RESULT:|\[draw-instrument\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/draw-instrument-witness.mjs', `--gpu=${gpu}`, '--settle=12000', '--frames=40'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (drawInstrumentKeep(line)) console.log(`check: ${line}`)
      if (!DRAW_INSTRUMENT_MUST.test(stdout)) gateFailures.push(`draw-instrument-witness.mjs on ${gpu}: printed no line matching its must regex, so either its band inventory or its counter-moved floor never ran`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (drawInstrumentKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`draw-instrument-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  // PERF-maxlevel-cpu-ladder-r1: the per-level cost gradient of `maxLevel` ABOVE the level the frame
  // wall can resolve, on an instrument proven to have unlocked rAF. s6's locked ladder read
  // L11=L16=L22=33.36 ms -- every median a multiple of the 16.68 ms refresh period -- so levels
  // above 11 were indistinguishable on it, and `splitFactor` is inert (s6/s13). This arm unlocks rAF
  // and refuses a run whose medians are still on that grid: the `must` names `unlockRaf:true`, the
  // measured ladder and the crossover level, so a run that stayed vsync-locked, one whose rAF never
  // unlocked, or one that resolved no level, reads as a failure rather than as silence that passes.
  const MAXLEVEL_LADDER_MUST = /\[maxlevel\] MEASURED maxlevel-cpu-ladder: \{[^\n]*"unlockRaf":true[\s\S]*\[maxlevel\] cost moves at L[1-9]\d*:[\s\S]*RESULT: PASS arm=maxlevel-cpu-ladder/
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
  const FIRST_FRAME_MUST = /\[first-frame\] MEASURED cold-load: time-to-first-frame [1-9][\d.]*ms[\s\S]*\[first-frame\] MEASURED worker-cold-start: init->first-reported-frame [1-9][\d.]*ms, first reported frame number 1, its render cost [1-9][\d.]*ms[\s\S]*RESULT: PASS arm=\S+ label=first-frame-boot-witness/
  const firstFrameKeep = (line) => /^(RESULT:|\[first-frame\])/.test(line)
  for (const gpu of gpuArms) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/first-frame-boot-witness.mjs', `--gpu=${gpu}`, '--observe=4000'], { maxBuffer: 16 * 1024 * 1024, timeout: SLOW_WITNESS_TIMEOUT_MS })
      for (const line of stdout.split('\n')) if (firstFrameKeep(line)) console.log(`check: ${line}`)
      if (!FIRST_FRAME_MUST.test(stdout)) gateFailures.push(`first-frame-boot-witness.mjs on ${gpu}: printed no line matching its must regex, so either the first frame was swallowed by the 250ms clock again or the cold-load figure never resolved`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (firstFrameKeep(line)) console.error(`check: ${line}`)
      gateFailures.push(`first-frame-boot-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
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
