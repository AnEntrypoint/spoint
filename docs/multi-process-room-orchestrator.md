# Multi-process room orchestrator

Covers `src/sdk/RoomOrchestrator.js`, `src/sdk/RoomProcessWorker.js`, and
`bin/room-orchestrator-boot.js` -- the multi-PROCESS step built on top of the
already-shipped `src/sdk/RoomDirectory.js` (multi-room-**per**-process).

This is a **different** feature from `src/sharding/RegionRouter.js` /
`bin/router-boot.js`, which splits **one** big world across a grid of
child-process workers behind a single seamless client-facing endpoint
(spatial sharding). This orchestrator instead runs many **independent,
complete** rooms (separate lobbies/matches/worlds) across N worker
processes, packing low-population rooms together instead of dedicating a
whole process to each one.

## Topology

```
                    ┌────────────────────────────┐
  client ──HTTP──►  │  router process (this file) │
                    │  GET  /route/:roomId         │
                    │  GET  /status                 │
                    │  POST /rooms?roomId=&world=   │
                    └───────────┬──────────────────┘
                                │ child_process IPC (fork)
                ┌───────────────┼───────────────┐
                ▼                               ▼
     ┌─────────────────────┐        ┌─────────────────────┐
     │ worker process 0     │        │ worker process 1     │
     │ RoomDirectory         │        │ RoomDirectory         │
     │  room A (port 19000) │        │  room C (port 19016) │
     │  room B (port 19001) │        │                       │
     └─────────────────────┘        └─────────────────────┘
                ▲                               ▲
                └───────── client connects DIRECTLY to the routed room's
                           own port for real game traffic (WebSocket) ────┘
```

Each worker process is a real, independently-forked Node process running its
own `RoomDirectory` -- its own event loop, its own Jolt WASM instance(s), its
own `TickSystem`. A crash or stall in one worker process cannot affect a
sibling worker's rooms (live-verified: `SIGKILL`-ing one worker process
leaves rooms hosted by the surviving worker fully reachable).

**Cross-machine workers** (external, not forked): register via the HTTP API
(`POST /workers/register`) with their public hostname.  The router tracks
their host alongside locally-forked workers and returns the correct host
in `/route/:roomId` responses.  External workers are never auto-restarted
(the orchestrator cannot fork a process on a different machine), and they
must manage their own room lifecycle (the orchestrator only tracks which
rooms exist on which worker for routing purposes).

The **router is a lookup service, not a traffic proxy**. `GET /route/:roomId`
returns `{host, port}` for the room's own already-independent HTTP+WebSocket
listener; the client then connects directly to that port for the actual game
session. This is deliberate: each room already has a fully working
`httpServer`/`WSServer` (that's what `createServer()`/`RoomDirectory` already
build), so making the router also re-proxy every frame would be pure added
latency and a new single point of failure with zero benefit. A router-process
crash never drops an in-progress game connection, since players are already
talking directly to their room's own port.

## Room placement policy

`RoomOrchestrator.createRoom(roomId, worldName)` auto-picks the
**least-loaded** ready worker (fewest rooms currently hosted, recomputed live
every call) unless `opts.workerIndex` is passed explicitly. This was chosen
over round-robin because round-robin's pointer keeps advancing regardless of
which workers have freed capacity (a room stopped on worker 0 doesn't make
worker 0 more likely to receive the next room under round-robin, but it does
under least-loaded) -- self-correcting from live state with zero extra
bookkeeping, since `RoomOrchestrator` already tracks each worker's
`roomIds` Set.

This is placement by **room count**, not by measured player/entity load. A
load-aware policy (weighting by `RoomDirectory.getStatus()`'s live
tick/player/entity numbers, not just room count) is scoped out of this slice
-- see the sibling PRD row below.

## Usage

```sh
ROOM_WORKER_COUNT=4 ROUTER_PORT=3400 node bin/room-orchestrator-boot.js
```

```sh
curl -X POST 'http://localhost:3400/rooms?roomId=lobby-1&world=tps-game'
curl 'http://localhost:3400/route/lobby-1'
# -> {"host":"127.0.0.1","port":19000,"workerIndex":0,"worldName":"tps-game"}
curl 'http://localhost:3400/status'
# -> {"workerCount":4,"rooms":[{"roomId":"lobby-1","worldName":"tps-game","port":19000,"uptimeMs":1234,"tick":56,"players":0,"entities":6}]}
curl -X DELETE 'http://localhost:3400/rooms/lobby-1'
```

## Cross-machine deployment

Register an external worker on a different Machine:

```sh
# On the external worker's Machine (start a RoomDirectory independently,
# then register it with the router):
curl -X POST 'http://<router-host>:3400/workers/register' \
  -H 'Content-Type: application/json' \
  -d '{"host":"worker-3.fly.dev","portRange":[19048,19063]}'
# -> {"workerIndex":3,"host":"worker-3.fly.dev","portRange":[19048,19063]}

# List all workers:
curl 'http://localhost:3400/workers'
# -> [{"workerIndex":0,"host":"127.0.0.1","ready":true,...},{"workerIndex":3,"host":"worker-3.fly.dev","ready":true,"isExternal":true,...}]

# Now /route/:roomId returns the external worker's public host:
curl 'http://localhost:3400/route/lobby-external'
# -> {"host":"worker-3.fly.dev","port":19050,...}
```

Or set per-worker hosts for locally-forked workers at boot:

```sh
ROOM_WORKER_HOSTS="machine-0.fly.dev,machine-1.fly.dev" \
ROOM_WORKER_COUNT=2 ROUTER_PORT=3400 node bin/room-orchestrator-boot.js
```

## Crash auto-restart

```sh
# Enable crash auto-restart (default: on, max 3 restarts per 60s window):
ROOM_MAX_RESTARTS=5 ROOM_RESTART_WINDOW_MS=120000 node bin/room-orchestrator-boot.js

# Disable:
ROOM_RESTART_ON_CRASH=0 node bin/room-orchestrator-boot.js

# Monitor crash/restart stats:
curl 'http://localhost:3400/crash-stats'
# -> {"0":{"crashCount":0,"restartCount":0},"1":{"crashCount":2,"restartCount":2}}
```

A game client (or a matchmaker service sitting in front of this router)
resolves `/route/:roomId` first, then connects its real WebSocket game
transport straight to the returned `host:port`.

## Deploy recipe

`deploy/fly-rooms.toml` is a fly.io recipe for this shape -- a **separate**
deploy config from the repo-root `nixpacks.toml` (which is still the right
choice for a single always-on world/room). It runs
`node bin/room-orchestrator-boot.js` as the fly.io Machine's start command,
fronts the router's HTTP port with `[http_service]`, and exposes the
`ROOM_PORT_MIN..ROOM_PORT_MAX` range via `[[services]]` TCP blocks so a
client can connect directly to whichever port `/route/:roomId` returns.

fly.toml has no native port-range shorthand, so a real deploy needs one
`[[services]]` block per port. Generate the remaining blocks with:

```sh
node -e '
const min = 19000, max = 19031
for (let p = min; p <= max; p++) {
  console.log(`\n[[services]]\n  internal_port = ${p}\n  protocol = "tcp"\n  [[services.ports]]\n    port = ${p}`)
}
' >> deploy/fly-rooms.toml
```

(Run once against a fresh copy of the recipe -- `deploy/fly-rooms.toml` ships
with only the first representative block, to keep the file legible in the
repo; a real deploy should widen `ROOM_PORT_MIN`/`ROOM_PORT_MAX` to match
the actual number of concurrent rooms expected, then generate the matching
block set with the snippet above.)

## Known limitations / scoped-out follow-ups

- **Cross-machine/cross-region orchestration** -- SHIPPED in this row
  (`server-scale-room-orchestrator-cross-machine-routing`).  Each worker
  entry now carries a `host` field (defaults to `127.0.0.1` for local
  workers, overridable via `ROOM_WORKER_HOSTS` env var or per-worker
  constructor option).  `route(roomId)` returns the per-worker host, so a
  client connecting to the routed host:port pair reaches the correct
  Machine.  External workers (on separate Machines, not forked locally)
  register via `POST /workers/register {"host":"..."}` and are tracked
  alongside local workers.  See `GET /workers` and `GET /crash-stats` for
  fleet monitoring.
- **Worker crash auto-restart** -- SHIPPED in the same row.  Locally-forked
  workers that exit unexpectedly are automatically respawned (configurable
  via `ROOM_RESTART_ON_CRASH`, `ROOM_MAX_RESTARTS`, `ROOM_RESTART_WINDOW_MS`
  env vars).  A per-worker sliding-window crash count prevents infinite
  restart loops.  Restarted workers start with empty rooms (fresh state) --
  state recovery across crashes depends on the separate
  `server-scale-persistent-world-snapshot-restart-survival` row.  External
  workers are never auto-restarted (the orchestrator cannot fork a process
  on a different machine).
- **Load-aware placement** -- SHIPPED in sibling row
  `server-scale-room-orchestrator-load-aware-placement`.
- **Auto-scaling worker count** -- SHIPPED in sibling row
  `server-scale-room-orchestrator-elastic-worker-count`.
