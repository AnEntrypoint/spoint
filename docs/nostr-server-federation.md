# Nostr Server Federation — Architecture

> PRD row: `ugc-nostr-server-federation`  
> Status: FIRST SLICE — architecture documentation + "no duplicate implementation" verification

## Overview

spoint uses **nostr** (Nostr Protocol) as its **serverless master server** for both dedicated-server discovery and P2P room discovery. This is a single, unified mechanism — not two separate server-browser systems.

## Architecture

### Publishers (server-side)

**Dedicated servers** publish via `src/sdk/ServerPresence.js`:

- Generates a persistent nostr keypair (stored in `data/nostr-identity.json`, gitignored)
- Publishes a replaceable NIP-78 `kind:30078` event with `d` tag `spoint-server:<namespace>:<port>`
- Payload: `{action, worldName, host, port, mode, players, maxPlayers, tickRate, protocolVersion, ts}`
- Cadence: `online` on boot, `offline` on shutdown, `heartbeat` every 30s
- Opt-in only: `worldDef.presence.enabled` or `SPOINT_PRESENCE=1` env var
- Reuses `wireweave`'s own `RelayPool` + `NostrAuth` primitives (zero hand-rolled nostr client)

**P2P rooms** (wireweave-hosted) publish via `node_modules/wireweave/src/data.js`:

- Already shipped, already used by `client/HostMigration.js` for peer mesh discovery
- Same `kind:30078`, different `d` tag: `wireweave-data:<roomId>`
- Payload: `{action, name, room, ts}`

### Consumer (client-side)

`client/ServerBrowser.js` is the single client-side server browser:

- Subscribes via `RelayPool` to a single nostr filter scoped to the shared `ns` tag
- Merges dedicated + P2P rooms into one unified list
- Disambiguates by `d` tag prefix (`spoint-server:` vs `wireweave-data:`)
- Pings dedicated servers via a lightweight WS connect to `ws://host:port/ws`
- Shows P2P room latency as relay RTT
- Click-to-join: dedicated → `?connect=host:port`, P2P → `?wwjoin&room=<id>`
- Presence rows expire after 90s (3x the 30s heartbeat cadence)

### Relays

Both publisher and consumer use wireweave's public relay defaults (`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`). A world/server can pin its own relay set via `worldDef.presence.relays` or `SPOINT_PRESENCE_RELAYS` env var.

## "No duplicate implementation" verification

| Concern | Verdict | Evidence |
|---|---|---|
| Second server browser? | No | `client/ServerBrowser.js` is the only client-side nostr consumer. `Grep` for `kind:30078`/`RelayPool`/`server-browser` across `client/` and `src/` confirms a single implementation. |
| Second presence publisher? | No | `src/sdk/ServerPresence.js` is the only server-side nostr presence publisher. `Grep` for `createServerPresence` across `src/` confirms a single call site in `server.js:443`. |
| Overlapping with wireweave? | No | `ServerPresence.js` reuses wireweave's `RelayPool`/`NostrAuth` rather than importing `nostr-tools` directly — it is one integration point, not two. |
| Per-row feature drift? | No | The "text-chat-matchmaking-server-browser-anticheat" row (which this row's detail says "already covers this functionally") is the same mechanism — `ServerPresence.js` + `ServerBrowser.js` are the single implementation both rows reference. |

## Remaining scope

- Relay health/fallback monitoring (the pool already handles reconnect internally)
- Server-browser UI polish (sorting, favorites, recent)
- Operator-facing presence dashboard (which servers are publishing, relay reachability)