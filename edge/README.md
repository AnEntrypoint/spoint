# Edge deployment (Cloudflare Workers / Durable Objects)

Real, live-verified deployment slices for running spoint's authoritative game server on
Cloudflare's edge instead of a long-lived Node process. See `AGENTS.md`'s
`edge-cf-workers-feasibility-workerentry-already-proves-core` catalog entry for the full
feasibility background (`src/sdk/WorkerEntry.js` -- already shipped, used today for singleplayer --
is live proof the game-logic/physics/netcode core has zero Node-native API dependency).

## Architecture: static assets stay on the origin, the edge handles only WebSocket traffic

`edge/cf-do/spoint-do.js` is a real Cloudflare Worker + Durable Object (`SpointGameRoom`) that runs
the unmodified `WorkerEntry.js` game core against a real `WebSocketPair`. It deliberately does
**not** attempt to serve static assets (GLB/VRM models, `index.html`, `app.js`, textures) itself --
that would mean either reimplementing `src/sdk/StaticHandler.js`'s transform/ETag/precompression
pipeline against R2 (real, substantial scope: GLBTransformer.js's Draco/quantize pass,
`content-hash-asset-cache-revalidation`'s content-hash ETags, the `.br`/`.gz` precompression
sidecars, `ProgressiveBake.js`'s environment-map bake) or accepting a second, divergent asset
pipeline. Instead the Worker's top-level `fetch()` **routes by request shape**:

- A real WebSocket-upgrade request (`Upgrade: websocket`, any path -- the client always dials `/ws`,
  but the router checks the real header, not a brittle path string) goes to the `SpointGameRoom`
  Durable Object, which handles the full authoritative game loop over that socket.
- Every other request (HTML, JS, GLB/VRM, textures, `/__identity`, anything) is reverse-proxied
  unchanged to `env.STATIC_ORIGIN` -- the existing Node-hosted server (`node server.js`) or a CDN
  fronting it. `StaticHandler.js` keeps running exactly as it does today; this Worker never touches
  asset bytes.

This is option (b) from the `edge-cf-static-asset-serving-r2-or-workers-assets` PRD row -- the
pragmatic default the row itself recommended evaluating first, since static-asset edge caching in
front of an existing origin is an already-solved problem (any CDN) and doesn't need
`StaticHandler.js`'s bespoke transform pipeline reimplemented against R2/Workers Static Assets. A
future full R2/Workers-Assets port (moving asset *storage* itself to the edge, not just caching in
front of an origin) remains a distinct, larger, not-yet-started follow-up if origin latency/cost ever
justifies it.

```
                       ┌─────────────────────────────┐
 client ── HTTP GET ──▶│ Worker fetch()                │── proxy ──▶ STATIC_ORIGIN (Node/CDN)
                       │  isWebSocketUpgrade? no  ─────┤            (StaticHandler.js, unchanged)
                       │  isWebSocketUpgrade? yes ─────┼──▶ SpointGameRoom Durable Object
                       └─────────────────────────────┘         (WorkerEntry.js game core,
                                                                  real Jolt WASM, real WebSocketPair)
```

## Files

- `edge/cf-do/spoint-do.js` -- the Worker script: `SpointGameRoom` DO (game-core-over-WebSocketPair,
  see its own header comment) + the top-level `fetch()` router described above.
- `edge/cf-do/wrangler-do.toml` -- real wrangler config. `[vars] STATIC_ORIGIN` points at your
  deployed Node origin / CDN URL -- set this before going live; the checked-in value is a
  `localhost` placeholder for `wrangler dev` local testing only.
- `edge/cf-do/jolt-edge-init.js` -- Jolt WASM instantiation for workerd (CompiledWasm module
  binding + `Module.instantiateWasm`, since workerd disallows a runtime
  `WebAssembly.instantiate()` from raw bytes).
- `edge/cf-do/do-client-probe.mjs` -- a real WS client (Node `ws` + the real msgpackr wire protocol)
  that connects, receives real snapshots, and drives real Jolt-simulated player movement -- the
  live-witness harness for both the DO transport and (as of this slice) the router in front of it.

## Running it locally

```bash
# 1. Boot the real static origin (any free port)
PORT=8195 SPOINT_SKIP_PREWARM=1 node server.js

# 2. Point wrangler-do.toml's STATIC_ORIGIN at it (edit [vars] STATIC_ORIGIN), then:
cd edge/cf-do
npx wrangler dev --config wrangler-do.toml --port 18830 --local-protocol http

# 3. Verify both halves of the split:
curl http://127.0.0.1:18830/index.html      # -> proxied from STATIC_ORIGIN, byte-identical
curl http://127.0.0.1:18830/__identity      # -> any arbitrary origin route works, not just /
node do-client-probe.mjs 18830              # -> real WS connect through the DO, real snapshots
```

## Known gotcha: Early Hints vs workerd's `fetch()`

Live-probed this session against a real `wrangler dev` workerd instance: workerd's own `fetch()`
does **not** transparently pass an interim HTTP 103 response through to the caller the way a browser
or Node's `fetch()` does -- it surfaces the 103 itself *as the final `Response`* (`status: 103`, body
never reached). `StaticHandler.js`'s Early Hints feature (`55141e02`, paired with the fetch
manifest) sends a real 103 ahead of every HTML response, which would silently break every page load
proxied through this router.

Fix: the router's proxy fetch sets `x-spoint-edge-proxy: 1` on its request to the origin;
`StaticHandler.js` checks that header and skips Early Hints for that one request only -- a real
browser's direct request never carries it, so the optimization is untouched for anyone hitting the
origin directly (or through a CDN that correctly forwards 1xx responses). See the paired comments in
`edge/cf-do/spoint-do.js` and `src/sdk/StaticHandler.js`.

## Still open (sibling PRD rows, not this slice's scope)

- `edge-cf-worker-app-bundle-static-source-loadfromstring` -- `AppLoader.js`'s `loadFromString()`
  uses `Blob`+`URL.createObjectURL()`, unimplemented in workerd; needs a build-time bundle + an
  edge-specific eval strategy fork before arbitrary game apps load on the edge (this slice's own
  probe passes `apps: []`, matching the DO row's own documented scope).
- `edge-cf-draco-glb-collider-not-yet-edge-safe` -- Draco-compressed GLB colliders (partially
  addressed by the build-time Draco-strip script, `9692fb5f`).
- A full R2/Workers-Assets asset-storage port, if origin-proxy latency/cost ever motivates moving
  asset bytes themselves to the edge instead of just proxying to an existing origin.
