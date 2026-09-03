# Architecture decisions

## Colyseus adoption (2026-07-07; re-verified 2026-07-12)

User directive: replace as much custom netcode as practical with Colyseus to reduce maintenance.

**Re-verified 2026-07-12 (user re-asked "replace as much netcode as we can with colyseus"):** the decision
below still stands. `client/BrowserServer.js` still runs the ENTIRE server inside a `new Worker('src/sdk/
WorkerEntry.js', {type:'module'})` communicating only via `postMessage` -- no `net`/`ws`/socket binding of
any kind. Colyseus's Room/Server still requires real Node sockets, so a full swap still needs a from-scratch
in-Worker transport shim (net-LARGER surface, blocked by the `.gm/constraints.md` smaller-maintained-surface
guard). User confirmed: SKIP Colyseus this pass, focus the effort on simplifying spoint's OTHER over-complex
systems instead. The `@colyseus/schema`-under-`SnapshotEncoder` partial (option 3) remains the recorded
future option if the encode layer is ever revisited; it was not undertaken because the tuned quantized
msgpackr format is not a clear loser today.

### Investigated

- spoint's netcode stack: `ConnectionManager`, `TickHandler`, `NetworkState`, `SnapshotEncoder`,
  `PlayerManager`, `PhysicsIntegration`, `LagCompensator`, `PredictionEngine`,
  `ReconciliationEngine`, `PhysicsNetworkClient` (server + client).
- Colyseus's Room/Server model (`@colyseus/core`) and its schema/delta-encoding library
  (`@colyseus/schema`), tested standalone.
- spoint's singleplayer path: `client/BrowserServer.js` runs the ENTIRE server (`src/sdk/server.js`
  and everything under it) inside a browser Web Worker (`src/sdk/WorkerEntry.js`), communicating
  with the main thread via `postMessage`. No Node process, no real TCP/WS socket.
- spoint's app-authoring boundary: `AppContext` (`src/apps/AppContext.js`) is the only surface every
  app in `apps/*` programs against (`ctx.entity`, `ctx.physics`, `ctx.world`, `ctx.players`,
  `ctx.network`, `ctx.bus`, `ctx.time`, `ctx.storage`) -- no app touches `ConnectionManager` or
  `MSG.*` directly.

### Alternatives considered (BBPF)

1. **Full Room/Server replacement.** Replace `ConnectionManager` + `TickHandler` + `NetworkState`
   with a Colyseus `Room`.
2. **No replacement.** Keep the custom stack as-is; decline the directive with recorded evidence.
3. **Partial replacement: `@colyseus/schema` only**, underneath `SnapshotEncoder`, keeping spoint's
   own `ConnectionManager`/`TickHandler`/room-equivalent.

### Decision: (2), no replacement, with (3) recorded as a live option for a future session

**Full Room/Server replacement is infeasible without a regression.** Colyseus's server requires a
real Node process with actual `net`/`ws` bindings. spoint's singleplayer mode runs the full server
inside a browser Web Worker with no such bindings. Adopting Colyseus's Room/Server would require
building and maintaining a custom in-Worker transport shim to bridge the two -- new, nontrivial
maintenance burden, which contradicts the stated goal (reduce maintenance) rather than serving it.
This alone rules out (1).

**`@colyseus/schema` standalone is real and works, but is not a clear win today.** Verified live
(see PRD row `colyseus-schema-standalone-feasibility`): the schema/delta-encoding library installs
with zero `@colyseus/core` dependency, runs in plain Node ESM via its non-decorator `defineTypes`
API (no build transform needed), and a full round-trip test confirmed real dirty-tracking delta
encoding (a 30-byte delta for one changed field, an unrelated field correctly left untouched on the
client) plus a `StateView` class for per-client filtered views -- the mechanism that would replace
spoint's hand-rolled relevance-radius cache (`nearbyPlayerIds`/`getRelevantDynamicIds` in
`TickHandler.js`). This IS technically viable in both the Node multiplayer path and the in-Worker
singleplayer path, since it has no socket/transport dependency of its own.

Declined as an immediate adoption because it would require rewriting entity/player state as
`@colyseus/schema` classes throughout `AppRuntime` (replacing today's plain entity objects) and
re-implementing spoint's relevance-radius filtering and measured-cost-adaptive snapshot rate
(`TickHandler.js`'s `_computeSnapshotInterval`, which factors both RTT and a real snapshot-build-time
EMA -- a mechanism `@colyseus/schema` does not provide) against `StateView` instead of the current
custom cache. That is a substantial rewrite of the encode layer for an unproven wire-size/perf
improvement over the current quantized msgpackr format, whose quantization tolerances are already
tuned and tested (`SnapshotEncoder.test.js`). Not a drop-in win; not undertaken this session.

**Favorable finding preserved for the future:** `AppContext`'s existing clean abstraction boundary
means a future partial swap under `SnapshotEncoder`/`NetworkState` (option 3) would be low-risk to
every app in `apps/*`, since no app code touches the swapped layer directly. If a future session
wants to revisit this, start from `@colyseus/schema` + `StateView` replacing just the encode layer,
not a Room/Server swap.

### Net-smaller-maintained-surface guard (constraints.md)

`.gm/constraints.md`: "replace bespoke code with native/library only when it nets a smaller
maintained surface... never carry a drift-prone upstream reimplementation." A full Colyseus adoption
here would net a LARGER total surface (custom stack PLUS a from-scratch in-Worker transport shim),
not smaller -- the guard correctly blocks it.

## HTTP/2 vs modulepreload-only for cold-load latency (2026-07-16)

Question: now that `client/index.html` ships `<link rel="modulepreload">` hints for the critical-path
ES modules (`app.js`, `three`, `msgpackr`), is upgrading the server to HTTP/2 also worth doing for
cold-load latency?

### Investigated

- `src/sdk/server.js` / `src/sdk/ServerAPI.js`: the entire HTTP surface is
  `import { createServer as createHttpServer } from 'node:http'` (`ServerAPI.js:1`), constructed once
  in `createServerDeps`/`createServer` and bound via `ctx.httpServer.listen(port, '0.0.0.0', 2048, ...)`
  (`ServerAPI.js:181`). There is no `node:http2` import anywhere in `src/sdk/`, no `node:https`, no TLS
  key/cert loading, and no ALPN negotiation code in this repo. WebSocket upgrade (`ws`) and
  `WebTransportServer` ride on top of that same plain HTTP/1.1 listener.
- `nixpacks.toml`: deploy target for the real Node server is `cmd = "node server.js"` on whatever port
  the platform assigns, no reverse proxy or TLS-terminator config checked into this repo (Railway/
  nixpacks-style platforms terminate TLS themselves in front of the container and speak plain HTTP back
  to it -- confirmed by the total absence of any cert/key path or `NODE_TLS_*` env read in `src/sdk/`).
  `.github/workflows/gh-pages.yml` deploys the OTHER target, the static demo, straight to GitHub Pages'
  own static host (a legacy branch-push publish per the `ghpages-deploy-symlink-cp-collision` AGENTS.md
  entry) -- that path has no origin server of ours in the loop at all, so it inherits GitHub's own
  HTTP/2 termination for free regardless of anything done here.
- `client/index.html`: the modulepreload hints already cover the three heaviest early-fetch modules
  (`app.js`, `three.module.js`, `msgpackr/index.js`), landed this session, verified ordered after the
  importmap per the file's own comment (`index.html:63-72`).

### Alternatives considered (BBPF)

1. **Adopt HTTP/2 now** in `src/sdk/server.js`: swap to `node:http2` (`createSecureServer`, since
   Node's `http2` module requires TLS for browser ALPN negotiation in practice -- plain-text `h2c` is not
   supported by any browser), generate/load a cert, and multiplex requests over one connection.
2. **Defer indefinitely / not worth it**: keep plain `node:http`, rely on modulepreload + the platform's
   own TLS-terminating reverse proxy (nixpacks target) or GitHub Pages' host (gh-pages target) for
   HTTP/2 whenever it matters.
3. **Partial: add optional HTTPS/HTTP2 listener behind an env flag** for self-hosters who don't sit
   behind a TLS-terminating proxy, without touching the default nixpacks/gh-pages paths.

### Decision: (2), not worth it now, given what actually exists here

**Both real deploy targets already get HTTP/2 without any change to this repo.** The gh-pages demo is
served entirely by GitHub's own static host in front of our build output -- no origin server of ours is
in that request path, so its HTTP/2 support is already whatever GitHub Pages provides today, unconditional
on this codebase. The self-hosted/nixpacks target is a `node server.js` process behind whatever the
deploy platform's own reverse proxy does (nixpacks-based platforms terminate TLS in front of the
container) -- multiplexing again happens one hop before this server, over plain HTTP/1.1 backhaul, which
is the normal and correct shape for that kind of deployment (the origin doesn't need to also speak
HTTP/2 for the browser-facing connection to get it).

**Standing up HTTP/2 directly in `src/sdk/server.js` would only matter for a deploy shape this repo does
not have:** a bare self-hosted instance with NO TLS-terminating reverse proxy in front of it, exposed
directly to browsers. Nothing in `nixpacks.toml`, `src/sdk/`, or the GitHub workflows describes that
shape today. Building it speculatively means carrying real new maintenance surface with no exercised
deploy target: cert/key provisioning and renewal (there is currently zero TLS code to build on -- this
is not a small delta), `node:http2`'s stricter/different API against `ws`'s upgrade handling and the
existing `WebTransportServer` (both already assume a `node:http`-shaped server object), and a config
surface (cert paths, `h2c` vs TLS, fallback to HTTP/1.1 for old clients) that has to be tested against a
deploy target nobody runs. That is exactly the `.gm/constraints.md` "net-smaller-maintained-surface"
guard from the Colyseus decision above, applied here: HTTP/2-in-this-repo is a LARGER surface for a
LATENCY WIN THE REPO ALREADY GETS FOR FREE at both real deploy targets.

**modulepreload was the right lever and is now landed.** Unlike HTTP/2 (an infrastructure-layer, deploy-
target-dependent change with no code path in this repo to build from), modulepreload is a pure
client-side, zero-infra hint that pays off identically regardless of which HTTP version actually serves
the response -- it tells the browser to start fetching/compiling the critical modules immediately on
parse rather than waiting to discover them via `app.js`'s own `import` graph, which is a real win on
HTTP/1.1 (fewer wasted round-trip-discovery hops before the connection's limited parallel-request budget
is used) and stays a (smaller, but nonzero) win under HTTP/2 multiplexing too.

**Recommendation: defer (revisit only if X).** Do not add `node:http2`/TLS to `src/sdk/server.js` now.
Revisit only if a concrete self-hosted deploy target appears that terminates TLS nowhere upstream of
this Node process (i.e. option 3 becomes needed for a real user, not hypothetically) -- at that point the
right shape is an opt-in `node:http2` `createSecureServer` path gated behind an env var (e.g.
`SPOINT_TLS_CERT`/`SPOINT_TLS_KEY`), defaulting to today's plain `node:http` so the nixpacks and
in-Worker-singleplayer paths (`client/BrowserServer.js`, which has no real socket at all per the
Colyseus decision above) are unaffected.
