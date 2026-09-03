# apps/_lib

Shared building blocks for apps. Imported into app code via `ctx.*` helpers or
directly from `apps/_lib/`.

## Reachable from `ctx.define*` (no import needed)

Every stateful factory here is exposed on the app `ctx` so a maker never has to
know the file path: `ctx.defineGameFSM`, `ctx.defineGameMode`, `ctx.defineBuffStack`,
`ctx.defineShrinkingZone`, `ctx.defineHealth`, `ctx.defineSteering`,
`ctx.defineCheckpoint`, `ctx.definePickup`, `ctx.defineDestructible`,
`ctx.defineTeams` — each is
`ctx.defineX(spec)` and forwards `(spec, this)` to the underlying factory. The
non-stateful pure helpers (`squash-stretch.js`, `defineAudio` client-side) are
still direct imports. Prefer the `ctx.define*` form in app code.

## game-fsm.js — declarative game-state FSM builder

`ctx.defineGameFSM(spec)` (or `import { defineGameFSM } from 'apps/_lib/game-fsm.js'`)
compiles a declarative spec into a real [xstate 5](https://stately.ai/docs) machine
and returns a thin runtime. Use it to orchestrate game phases (lobby, countdown,
rounds, match-end) instead of hand-rolling state in `update()` with ad-hoc Maps
and timers.

### Spec

```js
ctx.defineGameFSM({
  id: 'match',                       // optional
  initial: 'waiting',                // required, must be a declared state
  context: { round: 0, scores: {} }, // optional seed data (the live game-data bag)
  states: {
    waiting:   { on: { START: { target: 'countdown', guard: (ctx) => ctx.players.getAll().length >= 2 } } },
    countdown: { enter: (ctx, fsm) => {}, tick: (ctx, dt, fsm) => {}, after: { 5000: 'active' } },
    active:    { enter: (ctx, fsm) => { fsm.context.round++ }, on: { ROUND_OVER: 'roundEnd' }, after: { 60000: 'roundEnd' } },
    roundEnd:  { after: { 4000: [
                  { target: 'done',   guard: (ctx, fsm) => fsm.context.round >= 3 },
                  { target: 'active' }                       // fall-through (no guard)
                ] } },
    done:      { final: true }
  }
})
```

Per-state keys (all optional except as routing requires):

- `enter(ctx, fsm)` / `exit(ctx, fsm)` — run on state entry/exit (xstate entry/exit actions).
- `tick(ctx, dt, fsm)` — run by `fsm.tick(dt)` only while this state is active. Forward `dt` from the app's `update(ctx, dt)`.
- `on: { EVENT: target }` — event transition. `target` may be a state name or `{ target, guard, action }`.
- `after: { ms: target }` — timed transition. `target` may also be an **array** of `{ target, guard }` candidates; the first whose guard passes wins (put a bare-target candidate last as the fall-through).
- `final: true` — terminal state; tick stops, the machine is done.

`guard(ctx, fsm) => boolean` gates a transition; `action(ctx, fsm)` runs on it.
Hooks receive the app `ctx` (so they can drive `ctx.players` / `ctx.state` /
`ctx.network`) and the `fsm` runtime.

### Runtime API

```js
fsm.state            // current state name
fsm.context          // live game-data bag (== xstate context; mutate via fsm.context.x++)
fsm.timeInState      // ms since entering the current state
fsm.is(name)         // fsm.matches(name)
fsm.can(event)       // would this event cause a transition right now?
fsm.send(event, payload?)
fsm.onTransition(fn) // fn(stateName, fsm) on each change; returns an unsubscribe
fsm.tick(dt)         // drive the active state's tick hook
fsm.stop()           // tear down (idempotent)
```

### Wiring into an app

```js
export default { server: {
  setup(ctx)        { ctx.state.match = ctx.defineGameFSM({ /* spec */ }) },
  update(ctx, dt)   { ctx.state.match?.tick(dt) },
  onMessage(ctx, m) { if (m?.type === 'player_join') ctx.state.match.send('START') }
}}
```

See `apps/fsm-arena/index.js` for a worked match-loop example, or scaffold one
with `spoint create-app --template fsm-game my-match`.

### Notes

- Works server-side (node `xstate`) and client-side (singleplayer/BrowserServer,
  `/node_modules/xstate/dist/xstate.esm.js`) via the same dual-import as
  `lifecycle.js`.
- `fsm.context` is the *same reference* as the xstate context, so mutating it in a
  hook (`fsm.context.round++`) is visible to guards/timed logic immediately.
- Send to an unknown event, tick before/after stop, and double-stop are all safe
  no-ops. Bad specs (missing/unknown `initial`, transition to an undeclared state,
  empty `states`) throw at build time.

Verification: no standing test file (repo convention -- see the root AGENTS.md
"no test files, ever" discipline); exercised live via real `defineGameFSM`
calls in Node and via `apps/fsm-arena/index.js`'s real server + WebSocket
witness (see `## gamemode.js` below).

## gamemode.js — lobby -> warmup -> rounds -> end game-mode skeleton

`ctx.defineGameMode(spec)` is the extracted, reusable "match loop" shape shared
by every lobby/warmup/rounds/end game in this repo. It is a **thin composition**
over two existing primitives, never a reimplementation of either:

- `ctx.defineGameFSM` builds the actual phase machine (xstate 5) underneath —
  `defineGameMode` just wires up the 5 canonical states (`lobby`, `warmup`,
  `rounds`, `roundEnd`, `end`) with their broadcast/counter logic pre-built.
- `ctx.defineTeams` handles team assignment + scoreboard when `spec.teams` is
  set — the resulting instance is exposed as `gamemode.teams`.

Extracted from the real shape already in `apps/fsm-arena/index.js` (a 5-state
`waiting/countdown/active/roundEnd/done` match FSM with a round counter, a
free-form scoring bag, and a `roundsPerMatch` win-condition) — see that file
for the migrated example, using `phaseNames`/`messages` overrides to
reproduce its original wire contract exactly.

### Spec

```js
ctx.defineGameMode({
  teams: { teams: ['red', 'blue'], scoreLimit: 5 }, // optional; forwards to ctx.defineTeams
  minPlayers: 2,        // lobby -> warmup once this many players are present
  countdownMs: 5000,    // warmup duration
  roundMs: 60000,       // max round duration before it force-ends
  intermissionMs: 4000, // pause between rounds / before end
  roundsPerMatch: 3,    // default winCondition: fsm.context.round >= this
  winCondition: (ctx, fsm) => fsm.context.round >= 3, // optional override
  scoring: 'teams',     // 'teams' | 'players' | 'none' (default: 'teams' if spec.teams set, else 'players')

  onRoundStart(ctx, fsm) { /* runs after the built-in round_start broadcast */ }
})
```

Per-phase hooks (`onLobbyEnter/onLobbyTick`, `onWarmupEnter/onWarmupTick`,
`onRoundStart/onRoundTick/onRoundEnd`, `onEnd`) compose alongside — not
instead of — the built-in broadcast/counter logic, same `(ctx, fsm)` /
`(ctx, dt, fsm)` hook shape as `defineGameFSM`.

### Runtime API

`defineGameMode` returns the underlying `defineGameFSM` runtime (`state`,
`context`, `is`, `send`, `tick`, `onTransition`, `stop`, ...) plus:

```js
gamemode.teams                  // the defineTeams instance, or null
gamemode.round                  // current round number
gamemode.addScore(id, delta=1)  // routes to teams.addScore in 'teams' mode,
                                 // else a plain per-id Map
gamemode.getScore(id)
gamemode.getScores()            // teams.getScores() shape, or [{id,score}]
```

### Customizing the wire contract (migration escape hatch)

A caller migrating a hand-rolled FSM that must keep its exact existing
message types/phase names passes `phaseNames` (rename the 5 internal states)
and `messages` (fully override any of the 6 broadcast payload builders:
`lobby`, `warmup`, `countdown`, `roundStart`, `roundEnd`, `end`) — see
`apps/fsm-arena/index.js`'s `buildMatchFSM` for a worked example that
reproduces its pre-migration `match_phase`/`countdown`/`round_start`/
`round_end`/`match_over` contract byte-for-byte.

### Notes

- `spec.teams` unset -> `gamemode.teams` is `null`; `addScore`/`getScore` fall
  back to a plain per-player-id scoreboard (`scoring: 'players'`, the default
  when `spec.teams` is absent). `scoring: 'none'` disables scoring entirely
  (`addScore` is a no-op returning 0).
- `phaseNames` must resolve to 5 distinct state names or the spec throws at
  build time (same fail-fast discipline as `defineGameFSM`'s own validation).
- `apps/_lib/shrinking-zone.js` has no phase-FSM shape of its own (a pure
  battle-royale-ring damage/push `tick()` primitive, never uses
  `defineGameFSM`) — nothing from it composes into `defineGameMode`; a BR
  mode combines `defineGameMode` (match loop) with a separate
  `ctx.defineShrinkingZone` call for the ring mechanic.

## squash-stretch.js — cheap squash/stretch impact "juice"

`computeSquashStretchScale(impactSpeed, elapsedMs, opts)` and
`createSquashStretch(mesh, opts)` (client-side import from
`apps/_lib/squash-stretch.js`) give any entity mesh a non-uniform-scale
squash-and-stretch pop on impact, decaying back to identity over time. This is
**not** a soft-body physics simulation -- it is a cheap visual distortion of
`mesh.scale`, generalized from a prior prototype game's hardcoded per-game
version of the same effect.

### Pure core

```js
import { computeSquashStretchScale } from 'apps/_lib/squash-stretch.js'

const [sx, sy, sz] = computeSquashStretchScale(impactSpeed, elapsedMs, {
  axis: 'y',        // which axis compresses on impact (the other two bulge); default 'y'
  strength: 0.5,    // distortion per m/s of impact speed; default 0.5
  maxStrength: 0.6, // hard cap on peak distortion so an extreme impact can't degenerate the mesh; default 0.6
  durationMs: 350   // time to fully settle back to [1,1,1]; default 350
})
mesh.scale.set(sx, sy, sz)
```

A damped, oscillating envelope (one visible overshoot past identity, then
settle) drives the decay -- `elapsedMs <= 0` is peak distortion, `elapsedMs >=
durationMs` is exactly `[1,1,1]`. Degenerate inputs (`NaN`/negative/undefined
speed or elapsed time) clamp to safe values and never throw.

### Stateful driver

```js
import { createSquashStretch } from 'apps/_lib/squash-stretch.js'

const squash = createSquashStretch(mesh, { axis: 'y', strength: 0.4, durationMs: 350 })

// Explicit: call with a known impact speed (m/s) directly.
squash.trigger(impactSpeed, performance.now())

// Or auto-detect: feed every fresh velocity sample (e.g. a decoded snapshot's
// entity.velocity) and it fires trigger() on a sudden deceleration past
// opts.impactThreshold (default 1.5 m/s) -- the same "speed suddenly dropped"
// collision signature the original prototype used.
squash.onVelocity(entity.velocity, performance.now())

// Every render frame: writes mesh.scale, returns the applied [sx,sy,sz] or
// null when idle (mesh.scale is left untouched on idle frames).
squash.update(performance.now())

squash.reset() // force back to identity + inactive, e.g. on entity despawn
```

`mesh` must expose `scale.set(x,y,z)` (any three.js `Object3D`/`Mesh`/`Group`,
or a `ModelPool` proxy root, satisfies this) -- the constructor throws
otherwise. A re-`trigger()` mid-distortion restarts the impact clock from the
new impact (re-entrant safe, no accumulation).

Tests: `npm test` (node --test, `apps/_lib/squash-stretch.test.js`).
