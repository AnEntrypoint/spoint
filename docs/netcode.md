# Netcode profiles

A world picks its netcode with one config field. Apps use the same `ctx` APIs under every profile.

```js
export default {
  tickRate: 60,
  netcode: {
    profile: 'authoritative',   // 'authoritative' | 'rollback' | 'lockstep'
    snapshotRate: 60,           // authoritative only; defaults to tickRate
    adaptiveSnapshotRate: true, // authoritative only; halves the rate while clients are starved
    maxRewindMs: 1000,          // authoritative lag-compensation window (victim fairness cap)
    preciseTicks: false,        // spin-precise server ticks (costs a core on Windows)
    peers: 2,                   // rollback/lockstep: session starts once this many peers agree on a roster
    rollback: { inputDelayTicks: 1, maxRollbackTicks: 12, checksumIntervalTicks: 30 },
    lockstep: { inputDelayTicks: 3, checksumIntervalTicks: 30, stallTicks: 600, maxCatchUpTicks: 4 },
    inputButtons: [],           // extra boolean input fields carried on the wire
    inputAxes: []               // extra float input fields carried on the wire
  }
}
```

`src/netcode/NetcodeProfile.js` (`resolveNetcodeProfile`) owns the names, defaults and validation. A bad value throws at load.

## authoritative (default)

Krunker-style server authority for fast shooters and anything with untrusted clients.

- **Input.** Clients step input at the server tick rate (`InputStepper`) and send binary, redundant, sequence-numbered packets (`InputCodec`). The server applies exactly one input per tick from a sequence-ordered buffer. It holds a starved player rather than repeating input, waits briefly on a sequence gap, and catches up only against a wall-clock step budget.
- **Prediction.** `PredictionEngine` runs the shared character step with ground-plane and terrain hints. The server also sends the static wall planes the character touched (self block `me[3]`); the client clamps predicted position against them, so sliding along a wall no longer mispredicts. A contact only becomes a plane when the character is on that plane's free side, and one wall is emitted once: every plane is packed as `d = n·position`, so a plane carrying the negated normal of the wall it came from forbids the direction the server is actually moving and pins the player in place. Measured by holding into a box wall and forward at the same time: 59 m of travel along the wall, 0.25% mispredict, 0.0 cm max pop, 2 corrections. Merging is by direction, not by contact: two contacts on the same wall collapse to one plane (dot > 0.98) and two perpendicular walls keep both slots, Where one flat wall yields two contact points the pre-fix emitter spent both slots on copies of it and dropped the perpendicular wall: at the tps spawn it packed two byte-identical planes on 255 of 255 ticks (wire `[0,-1,10.14, 0,-1,10.14]` against one plane after the fix), and on a stacked horizontal seam it kept `[1,0] [1,0]` where the fix keeps `[1,0] [0,1]`, differing on 384 of 400 ticks. The `corner` world does not exercise this: its walls meet on a vertical seam, so each wall yields one contact and old and new agree on 325 of 325 ticks. Stair step-ups are not hinted yet. It reconciles against the stored prediction for the acked input and hides corrections in a decaying render offset.
- **Remote players.** They render from `SnapshotTimeline` at the server tick shown on screen. The delay is 1.5 snapshot intervals plus measured jitter, with bounded extrapolation over stalls. Measured over WebSocket with the harness's own `interp jitter ms` / `remote - server ms` / `extrap/held %` columns: the jitter estimate runs 16 / 25 / 59 / 187 ms at 0 / 50 / 100 / 150 ms added latency and the render lag behind the server truth follows it at 36 / 98 / 190 / 408 ms, so the buffer tracks the link instead of sitting at a constant. The delay it picks is 40 / 48 / 89 / 260 ms (p50 over the run) — 1.5 snapshot intervals (17 / 17 / 33 / 33 ms) plus that jitter estimate — and remote input-to-visual follows at 78 / 235 / 461 / 886 ms. At 150/25/5% the jitter estimate alone is 210 ms and the buffer still runs dry on 7.1% of frames, which is the ordered-transport head-of-line blocking measured below rather than a constant that is too small. Two smaller-buffer variants were measured and rejected: an interval margin of 1.0 buys 6 ms on a clean link and 20 ms at 150/25/5% but starts producing held frames (buffer dry past the 100 ms extrapolation cap) on 1% of frames where there were none, and taking the base offset from p10 instead of the window minimum is 1-2 cm worse at every condition.
- **Snapshot pacing.** With `adaptiveSnapshotRate`, the server watches the fraction of ticks where a player had no input queued and doubles the snapshot interval while that fraction stays above 8%, halving it again below 3%. On an ordered transport every lost packet head-of-line blocks every later snapshot for a full retransmit, so fewer snapshots per second means fewer stalls and half the downstream bytes. Measured over WebSocket: clean and 50/10/1% links stay at 60 Hz (40 ms remote delay, 17 cm error, 6.4 KB/s down), while 100/20/2% and 150/25/5% fall to 30 Hz — 6.5 to 3.3 KB/s down, remote delay 448 to 408 ms, error 173 to 161 cm, input starves 18.7 to 16.2/s. Pinning 30 Hz unconditionally costs the clean link 66 ms and 28 cm, which is why the rate adapts instead of being pinned.
- **Snapshot transport.** Snapshots are marked unreliable (`SNAP_UNRELIABLE`) and reach the client as true datagrams over WebTransport and wireweave, where a lost one costs only itself. Over plain WebSocket they ride TCP, so a lost segment stalls the whole stream: measured at 150 ms one way with 5% loss, remote input-to-visual latency is 899 ms over the ordered path and 458 ms over datagrams, and remote interpolation error is 171 cm against 89 cm. Host with WebTransport for the datagram path.
- **Lag compensation.** `sendFire` reports that displayed tick (`viewTick`). `LagCompensator.resolveViewTick`, `rewindAtTick` and `validateShotOrigin` rewind targets to it with blending and no extrapolation, capped by `maxRewindMs`. tps-game's `resolveFireRequest` shows the full hit path. Measured with the harness at 0 / 50 / 100 / 150 ms added latency: 96 / 95 / 95 / 94 shots, rewind 36 / 164 / 363 / 702 ms mean, victim behind its live position by 0.15 / 0.66 / 1.44 / 2.64 m mean (5.31 m p95 at 150/25/5%), 0 shots rejected past the cap, 100 / 100 / 100 / 99% hit rate. That measures server agreement with the rewound view, not a player's aim: the harness shooter is static and derives its aim from the rendered target position, so `miss p50` of 0 cm is a property of the rig and not evidence about aiming at a moving target.
- **Where it runs.** The server runs in Node, or in the browser worker for singleplayer and host.

## rollback (fighting-game style)

Every peer simulates the whole world locally inside its own BrowserServer worker. Peers exchange only inputs over wireweave data channels.

- Local input takes effect after `inputDelayTicks`. Remote input is predicted as the peer's last confirmed input.
- When a confirmed remote input differs from the one that was simulated, the peer restores the exact state at that tick and resimulates to the present.
- The state saved each tick is: Jolt `PhysicsSystem.SaveState`, each CharacterVirtual's `SaveState`, player state, and the tick handler's schedule maps.
- A peer never runs more than `maxRollbackTicks` ahead of the slowest confirmed remote input. Frame-advantage time sync makes the peer that is ahead yield ticks until both are balanced.
- Every `checksumIntervalTicks`, peers exchange a checksum of the settled state. Mismatches count as desyncs in `client.peerStats.loop`.
- Join with `?room=<code>&world=<world>` on every peer. There is no host.

## lockstep (RTS style)

Every peer simulates the whole world, and tick `t` runs only once every peer's input for `t` has arrived. Nothing is predicted and nothing is rewound, so app state of any size is safe. `apps/world/lockstep-rts.js` is the demo: two squads of units run by the `lockstep-rts` app. Hold E to rally your squad to you; click to toggle attack-move.

- **Input delay.** Local input sampled while simulating `t` is scheduled for `t + inputDelayTicks` and broadcast at once. The sim stalls whenever a remote input is late. Set `inputDelayTicks` above one-way latency plus jitter, in ticks: 3 ticks at 30 Hz covers about 50 ms one way; about 75 ms with 5% loss needs 6.
- **Pacing.** The sim never runs ahead of its own driver clock. After a stall it catches up at most `maxCatchUpTicks` per driver tick. Frame-advantage time sync makes the peer that is ahead skip driver ticks. The advantage is smoothed, so a single late packet does not trigger it.
- **Desyncs.** Every `checksumIntervalTicks`, `ConsensusVoter` broadcasts a checksum of physics bodies, players and every entity position. `DesyncDetector` counts mismatches. With three or more peers, a strict minority that diverges on 3 consecutive checksums is ejected through `CheatEjection`. With two peers there is no majority, so a mismatch is counted as `unattributedDesyncs` and nobody is ejected.
- **Drops.** A peer missing for `stallTicks`, a closed data channel, or an ejection starts a drop. Every survivor broadcasts the dropped peer's inputs it holds. The cut tick is the highest tick any survivor holds, and after it the dropped peer's input is `null`, so every survivor resumes on identical inputs. The dropped peer sees `evicted` and stops.
- **Stats.** `client.peerStats.loop` reports simTick, stalls, catchUpTicks, timeSyncYields, inputLatencyMs (sample to simulate: avg, p50, p95, max), checksumsCompared, desyncs, dropLog and evicted.

## Determinism requirements (rollback and lockstep)

The simulation must be a pure function of the initial world and the per-tick inputs.

- Same build on every peer. Jolt is bit-exact only within a single build.
- No `Math.random`, `Date.now` or `performance.now` in sim-affecting app code.
- Fixed `dt` (`LockstepTickSystem`).
- No persistence restore; peer worlds skip placed models and world snapshots.
- Rollback only: app state outside physics and player state is not rewound. Derive it from rewound state each tick, or keep it cosmetic. Lockstep never rewinds, so app state is fine there.
- Iterate in a fixed order. Sort players by id (ids are assigned in sorted roster order), and never iterate a Map or Set whose insertion order depends on message arrival.
- Each tick's input is fed explicitly through `simulateTick(tick, dt, players, inputsByPlayerId)`. There is no queue and no starve hold.

## Measuring

- `node scripts/netcode-conditioner-harness.mjs`: authoritative matrix, covering prediction, interpolation, hit rate, bandwidth and ticks. Options: `--cond=L/J/loss;...`, `--channel=ws|udp`, `--bots=N`, `--tick=64`, `--precise`, `--world=arena|wall|wall-end|corner|stairs|<apps/world name>`, `--wallHints=off` (A/B the wall-plane hints), `--snapHz=N` (pin the snapshot rate), `--snapAdaptive=off` (A/B the adaptive pacing), `--at=x,y,z` (place the mover) with `--hold=forward[,left,right,back,jump,sprint]` (drive one fixed input for the whole run instead of the scripted route).
- `node scripts/peer-profile-harness.mjs --world=rollback-duel --cond=25/5/1`: peers in one Node process over a delayed link. Reports desyncs, rollback rate and depth, stalls, correction size, input latency, and the first diverging input or state tick. For lockstep use `--world=lockstep-rts --profile=lockstep`. `--peers=3 --killPeer=peer-c --killAtMs=8000 --stallTicks=60` exercises a drop; `--peers=3 --cheatPeer=peer-c --cheatAtMs=6000` exercises ejection. The per-profile option names (`--inputDelayTicks=6` and so on) override the world.
- In the browser, `?netsim=<preset>` conditions the WebSocket (authoritative) or the peer frame relay (rollback/lockstep).
- Reading the table: `remote in->visual` is an onset metric, so it includes the time the mover takes to cover the 0.25 m detection threshold (about 31 ms at 8 m/s) as well as latency. `remote eff. delay` is the latency-only figure — the lag that best fits the rendered remote to the server truth — and `remote - server` is the part of the onset added after the server has already moved.
