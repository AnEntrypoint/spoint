# Terrain, collider and bake pipeline: wall-clock and CLI inspectability

Scope: tps-game ground (heightfield bake, terrain key, code-version pin, collider streaming, spawn hold).
Tree: local HEAD ba8850a, 31 commits behind upstream at search time (gm codesearch `stale_tree`), so cited
line numbers are local-HEAD numbers. gm-mcp reported bundle 0.2.128 served vs 0.2.129 installed (restart
needed); searches still answered.

## Q1. Which bake inputs force a re-bake, and which can be narrowed?

### Takeaway
Every file in `BAKE_INPUTS_HEIGHTFIELD_BAKE` changes `HEIGHTFIELD_BAKE_CODE_VERSION`, and any change marks every
shipped `.hf` stale. The list is 24 hand-written entries plus `presetInputs()`, which pulls every `src/presets/*.js`,
so one preset edit re-bakes tps-game even though only one world's preset feeds its bake.

### Cited findings
- The pin is `HEIGHTFIELD_BAKE_CODE_VERSION = bakeCodeVersion(BAKE_INPUTS_HEIGHTFIELD_BAKE)`, `src/static/BakeCodeVersion.js:144`.
- `bakeCodeVersion` sha1s the raw text (CRLF normalised) of every listed file, prefixed by its relative name, truncated to 12 hex chars: `src/static/BakeCodeVersion.js:9-22`.
- The list is `src/static/BakeCodeVersion.js:82-108`. Entries are `scripts/bake-heightfield.mjs`, `scripts/lib/gpu-eval.mjs`, `scripts/lib/witness-args.mjs`, `src/terrain/PlanetFrame.js`, `src/sdk/WorldLocator.js`, `src/shared/terrainConfig.js`, `canonicalJSON.js`, `fnv1a.js`, `worldName.js`, `worldPresets.js`, eight `packages/mapspinner/...` files, `scripts/lib/verdict-exit-guard.mjs`, `scripts/lib/witness-server.mjs`, and `...presetInputs()` at line 107.
- `presetInputs()` (`src/static/BakeCodeVersion.js:49-54`) globs `src/presets/*.js`. Narrowing candidate: pass only the preset of the world being baked.
- `src/shared/terrainConfig.js` appears in `BAKE_INPUTS_MINIMAP_BAKE` (line 60) and `BAKE_INPUTS_HEIGHTFIELD_BAKE` (line 88). Editing it re-pins two transforms.
- Narrowing is constrained by the closure check. `scripts/check-cache-keys.mjs:114-124` computes each transform's import closure and fails when an imported file is not in its declared list. A per-world list must be derived from the import graph, not hand-written, or the check reddens. Source of this constraint: `scripts/check-cache-keys.mjs:114-124`.

### Inferences
- Narrowing to "terrain module only" is not possible as stated. The bake genuinely imports the mapspinner height code and `PlanetFrame.js`, so those must stay. What can shrink is the preset glob (per world) and the `terrainConfig.js` edge into the minimap pin.

### Gaps
- Not measured: how many of the 24 entries change the output bytes. Only the import closure was checked.

## Q2. Can the terrain key and pin be checked without a bake?

### Takeaway
Yes, and it already is. `check-cache-keys.mjs` never runs the bake. It recomputes the pin from source (about 28 small file reads) and compares it with the `codeVersion` field in each `.hf` header. The bake (435 ms sampling) runs only on an actual re-bake. The premise that a check fails only after a bake is not correct for the pin.

### Cited findings
- The check reads header only: `decodeHeightfield` on each shipped `.hf`, then `header.codeVersion !== HEIGHTFIELD_BAKE_CODE_VERSION` at `scripts/check-cache-keys.mjs:129-138`. The failure message already prints the exact re-bake command at line 134.
- The terrain key is `terrainBakeKey(tcfg) = fnv1a32(canonicalJSON(terrainBakeSlice(parsedTerrainOf(tcfg))))`, `src/shared/terrainConfig.js:112-119`.
- `terrainBakeSlice` (`src/shared/terrainConfig.js:112-114`) includes only `seed`, `radius`, `reliefScale`, `anchorDir`, `hashVersion`, `carves`. It omits `extent`, `center`, `res`.
- `bakedTerrainMismatch` (`src/terrain/LatticeSurface.js:91-`) checks `terrainKey` first. When keys match it returns null, so later checks on `radius`/`reliefScale`/`anchorDir` never run. An extent or centre change with an unchanged key is therefore not caught by this function.

### Inferences
- A content-digest check could be a new `scripts/check-terrain-key.mjs` that reads only the `.hf` header and `parsedTerrainOf` for each world. It would fail in under a second. Existing code already does most of this in `check-cache-keys`.
- Risk: the key omits extent/centre/res. Either those are checked elsewhere (not verified here) or a re-extent bake can pass the check with the same key. This needs a witness before anyone relies on the key alone.

### Gaps
- Not verified: whether `extent` or `center` is compared anywhere else on load. Not verified: whether the `.hf` header stores `terrainKey` (`terrainIdentity` is spread into `base` at `scripts/bake-heightfield.mjs:98`, contents not read).

## Q3. Spawn hold released a player with no ground after 20 s: decision code and instrument

### Takeaway
Release is decided by `holdSpawnUntilGrounded` (`src/sdk/Relocation.js:167-195`), which gives up at `SPAWN_HOLD_MAX_MS = 20000` (`src/sdk/Relocation.js:15`). The ground-missing decision for "field not landed" is `terrainFieldMissingAt` (`src/sdk/Relocation.js:153-157`). That function returns false when the streamer is missing or lacks `coversPosition`, which reads as "covered" and sends the hold to the ray probe. The streamer's own census is the closest existing instrument.

### Cited findings
- `terrainFieldMissingAt` returns `false` when `streamerOf(ctx)` is null or `coversPosition` is not a function (`src/sdk/Relocation.js:153-157`). A missing streamer is therefore silently "covered". The comment at lines 146-148 records that this exact fault once released players on the first ray hit.
- `streamerOf` resolves `ctx._terrainStreamer || ctx.physics?._terrainStreamer` (`src/sdk/Relocation.js:149-151`).
- `coversPosition(x, z)` and `groundlessCenters()` are in `src/terrain/HeightfieldStreamer.js:271-277`. The getter `groundlessPlayers` is at `src/terrain/HeightfieldStreamer.js:568`.
- The hold warning (`src/sdk/Relocation.js:161`) prints `groundless players now: [...]` for `HEIGHTFIELD_NOT_LANDED`. That is the instrument that shows which player centres have no field.
- The release log is `[spawn-hold] releasing player N at chart-local (x, z) after M ms without ground: <reason>` (`src/sdk/Relocation.js:185`). The reason text comes from `probeSpawnHoldGround` (`src/sdk/Relocation.js:164` default branch: "the ground probe found no walkable surface under it"). That default text is the "ray-missed-ground" case in the live log.
- Existing open row: `.gm/prd.yml:898` (title "probeGroundY collapses four distinct spawn-hold outcomes ... into one bare null"). The same collapse is the root of "cannot name the reason".
- `[terrain] ${where}: N=... (near-field floor)` at `src/terrain/HeightfieldStreamer.js` (around line 265) logs field sizing, not per-ring coverage.

### Inferences
- The instrument that would show built versus unbuilt rings is `groundlessCenters()` exported as a CLI census: list `validCenters()` with a `covered` boolean and the owning field. It does not exist as a command today. The closest is the `groundless players` text in the hold warning.
- Fix candidate: make `terrainFieldMissingAt` return a reason code, not a boolean, and refuse when the streamer is absent. This follows the "refusals carry a code" rule in AGENTS.md.

### Gaps
- Not verified at runtime which branch fired in the live 20 s case. The log line text in the task is quoted from the brief, not reproduced here.

## Q4. Node-only ground verification at a spawn point

### Takeaway
Nothing read here is confirmed node-only. `scripts/tps-game-spawn-ground-hold-witness.mjs` is the closest match to the spawn question, but its header describes a server boot and a relocation, and I did not read the body to confirm it runs without a browser.

### Cited findings
- `scripts/tps-game-spawn-ground-hold-witness.mjs` header: measures the declared spawn y (`apps/world/tps-game.js:50`, y=8.39 against ground near -0.02 m) and the hold that gives up where ground is absent. It covers the same two defects as this note.
- Other candidates by name only (bodies not read): `scripts/relocation-ground-wait-witness.mjs`, `scripts/terrain-baked-heightfield-fail-loud-witness.mjs` (covers the `[baked-heightfield]` throw path, AGENTS.md "Terrain and colliders"), `scripts/ground-entry-precondition-witness.mjs`, `scripts/collider-ring-boot-batches-witness.mjs`.

### Gaps
- Not verified: whether any of these avoids the browser. Each needs a read of its body and a dry run before it is listed as the node check. The witness does not cover the coverage census (Q3) or the terrain key bake check (Q2).

## Q5. Bake wall-clock: what the 435 ms measures

### Cited findings
- The log `[bake] CPU height sampler: ${N*N} samples in ${Date.now()-t0}ms` is at `scripts/bake-heightfield.mjs:84`. It times the sampling loop only. 66049 = 257 squared, so N = 257.
- Arithmetic from the brief's figures: 435 ms / 66049 = 6.6 us per sample. A memory record in `.gm/disciplines/default/` says the CPU sampler cost about 325 us per sample. That record predates the current fix. The record was not checked against code here.
- The `.hf` codec and the `check-cache-keys` run are not timed by the log, so the full wall-clock of a re-bake is not known from it.

## Concrete changes (ranked by saving)

1. Narrow `presetInputs()` to the world being baked (`src/static/BakeCodeVersion.js:49-54`, `:107`). Saves a full re-bake on unrelated preset edits. Risk: closure check reddens unless the per-world list is derived (`scripts/check-cache-keys.mjs:114-124`).
2. Make the spawn ground decision return a reason code (`src/sdk/Relocation.js:153-157`, `:185`). Fixes the silent "covered" when the streamer is absent. Risk: small; touches the same path as `.gm/prd.yml:898`.
3. Add a coverage census CLI over `HeightfieldStreamer.groundlessCenters()` (`src/terrain/HeightfieldStreamer.js:271-277`, `:568`). Shows which rings are built. Risk: must read the streamer on a live server, so it is not node-only.
4. Add `extent`/`center`/`res` to the terrain-key check, or document why they are excluded (`src/shared/terrainConfig.js:112-114`, `src/terrain/LatticeSurface.js:91-`). Risk: changing the key re-pins every `.hf`, which is a re-bake of all shipped worlds.
5. Time the codec and check stages in `scripts/bake-heightfield.mjs` alongside line 84, so the full re-bake cost is measured, not inferred.

## Caveats
- All line numbers are local HEAD ba8850a. The tree is 31 commits behind upstream; re-verify after a pull.
- gm-mcp needs a restart to serve bundle 0.2.129 (see the tool output). This is friction for every codesearch call.
