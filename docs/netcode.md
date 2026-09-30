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
    inputButtons: [],           // extra boolean input fields carried on the wire
    inputAxes: []               // extra float input fields carried on the wire
  }
}
```

`src/netcode/NetcodeProfile.js` (`resolveNetcodeProfile`) owns the names, defaults and validation. A bad value throws at load.

## authoritative (default)

Krunker-style server authority for fast shooters and anything with untrusted clients.

- **Input.** Clients step input at the server tick rate (`InputStepper`) and send binary, redundant, sequence-numbered packets (`InputCodec`). The server applies exactly one input per tick from a sequence-ordered buffer. It holds a starved player rather than repeating input, waits briefly on a sequence gap, and catches up only against a wall-clock step budget.
- **Prediction.** `PredictionEngine` runs the shared character step with ground-plane and terrain hints. It reconciles against the stored prediction for the acked input and hides corrections in a decaying render offset.
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

## Determinism requirements (rollback and lockstep)

The simulation must be a pure function of the initial world and the per-tick inputs.

- Same build on every peer. Jolt is bit-exact only within a single build.
- No `Math.random`, `Date.now` or `performance.now` in sim-affecting app code.
- Fixed `dt` (`LockstepTickSystem`).
- No persistence restore; peer worlds skip placed models and world snapshots.
- App state outside physics and player state is not rewound. Derive it from rewound state each tick, or keep it cosmetic.
- Each tick's input is fed explicitly through `simulateTick(tick, dt, players, inputsByPlayerId)`. There is no queue and no starve hold.

## Measuring

- `node scripts/netcode-conditioner-harness.mjs`: authoritative matrix, covering prediction, interpolation, hit rate, bandwidth and ticks. Options: `--cond=L/J/loss;...`, `--channel=ws|udp`, `--bots=N`, `--tick=64`, `--precise`.
- `node scripts/peer-profile-harness.mjs --world=rollback-duel --cond=25/5/1`: two peers in one Node process over a delayed link. Reports desyncs, rollback rate and depth, stalls, correction size, and the first diverging tick.
- In the browser, `?netsim=<preset>` conditions the WebSocket (authoritative) or the peer frame relay (rollback/lockstep).
