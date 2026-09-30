# Netcode profiles

A world picks its netcode with one config field. Apps use the same `ctx` APIs under every profile.

```js
export default {
  tickRate: 60,
  netcode: {
    profile: 'authoritative',   // 'authoritative' | 'rollback' | 'lockstep'
    snapshotRate: 60,           // authoritative only; defaults to tickRate
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
- **Prediction.** `PredictionEngine` runs the shared character step with ground-plane and terrain hints. The server also sends the static wall planes the character touched (self block `me[3]`); the client clamps predicted position against them, so sliding along a wall no longer mispredicts. Stair step-ups are not hinted yet. It reconciles against the stored prediction for the acked input and hides corrections in a decaying render offset.
- **Remote players.** They render from `SnapshotTimeline` at the server tick shown on screen. The delay is 1.5 snapshot intervals plus measured jitter, with bounded extrapolation over stalls.
- **Lag compensation.** `sendFire` reports that displayed tick (`viewTick`). `LagCompensator.resolveViewTick`, `rewindAtTick` and `validateShotOrigin` rewind targets to it with blending and no extrapolation, capped by `maxRewindMs`. tps-game's `resolveFireRequest` shows the full hit path.
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

- `node scripts/netcode-conditioner-harness.mjs`: authoritative matrix, covering prediction, interpolation, hit rate, bandwidth and ticks. Options: `--cond=L/J/loss;...`, `--channel=ws|udp`, `--bots=N`, `--tick=64`, `--precise`, `--world=arena|wall|wall-end|stairs|<apps/world name>`, `--wallHints=off` (A/B the wall-plane hints).
- `node scripts/peer-profile-harness.mjs --world=rollback-duel --cond=25/5/1`: peers in one Node process over a delayed link. Reports desyncs, rollback rate and depth, stalls, correction size, input latency, and the first diverging input or state tick. For lockstep use `--world=lockstep-rts`. `--peers=3 --killPeer=peer-c --killAtMs=8000 --stallTicks=60` exercises a drop; `--peers=3 --cheatPeer=peer-c --cheatAtMs=6000` exercises ejection. The per-profile option names (`--inputDelayTicks=6` and so on) override the world.
- In the browser, `?netsim=<preset>` conditions the WebSocket (authoritative) or the peer frame relay (rollback/lockstep).
