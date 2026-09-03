# Anti-cheat threat model

This document is the explicit threat model for spoint's two distinct server shapes: a **dedicated
server** (`src/sdk/server.js`, one trusted process every client connects to over WebSocket/WebTransport)
and a **P2P browser-hosted room** (`client/BrowserServer.js`, an in-Worker server one of the *players'
own browsers* runs, reached via wireweave/nostr WebRTC data channels — see `client/WireweaveClient.js`,
`client/HostMigration.js`). The two have fundamentally different trust boundaries and this doc exists so
that difference is never silently assumed away when reasoning about a cheat-prevention feature.

Filed as part of the `nostr-matchmaking-server-browser-anticheat-baseline` epic: the real mitigations
this doc identifies as tractable are their own follow-up PRD rows (see bottom), not implemented here —
this is scoping, not a code-fix.

## Dedicated server: the trust root

`src/sdk/server.js` is architecturally already the trust root for spoint's netcode. Every piece of
gameplay-relevant state a client can affect goes through it:

- **Movement/physics**: `PhysicsIntegration.js` runs the real Jolt simulation server-side; a client's
  `PLAYER_INPUT` is *input* (desired move/look/actions), never a position write. The server computes the
  resulting position and that's what gets snapshotted back out.
- **Hit registration**: `apps/_lib/weapon.js`'s hitscan runs server-side against server-side player
  positions (with lag compensation — see the `clock-sync-ntp-style-plus-lag-comp-validation` row for the
  timestamp-validation piece this doc's rate-limiting proposal below explicitly composes with, not
  duplicates).
- **Pickups**: `apps/_lib/pickup.js`'s `definePickup(spec, appCtx).tick(dt)` polls `appCtx.players.getAll()`
  (server-side player state) against the pickup entity's own position, called only from the app's
  server-tick `update(ctx, dt)`. There is no client-trusted "I picked this up" message a malicious client
  could forge — collection is entirely a server-side proximity poll. **Confirmed already
  server-authoritative, no gap found.**

So for the dedicated-server path, "anti-cheat" is not about closing an open trust boundary (there isn't
one to close) — it's about **hardening an already-authoritative server against a malicious or buggy
client sending adversarial input**: flooding messages, claiming physically-impossible movement, or
statistically-anomalous play a human operator would want visibility into. See "Tractable dedicated-server
mitigations" below.

## P2P browser-hosted rooms: no trust boundary at all

`client/BrowserServer.js` boots a *real* in-Worker instance of the same server code
(`src/sdk/WorkerEntry.js`) inside one player's own browser tab. Every other room participant
(`client/WireweaveJoinClient.js`) routes its game traffic to that host over a wireweave/WebRTC data
channel (`attachWireweavePeer`). This means **the host player's own client computes the "authoritative"
game state everyone else trusts** — there is no third party, no server operator, nothing outside the
host's own browser process validating what it does.

Concretely, a malicious host can, trivially and with no defense currently possible:

- **God mode / infinite health / infinite ammo** — it's the host's own `PhysicsIntegration`/weapon state,
  it can set anything it wants before snapshotting it out to joiners.
- **Wallhack / omniscient aim** — the host computes every player's real position every tick; nothing
  stops it from rendering that for the host player's own benefit locally (this doesn't even require
  touching the wire protocol).
- **Fake hit registration** — hitscan resolution happens in the host's own weapon.js instance; a
  malicious host can report hits that never geometrically occurred, or suppress real ones against itself.
- **Silent state manipulation** — teleporting, spawning items, ignoring physics constraints — anything the
  real dedicated-server code *would* validate, a malicious host simply skips, since it's running the
  validating code itself with nothing checking its output.

This is not a bug to fix in the current architecture — it is the P2P model's structural shape. Every
peer-hosted game with this "one browser is the server" topology (this is not unique to spoint) has the
same property.

### Existing trust primitives this doc leans on

Two mechanisms already exist that are directly relevant to any future mitigation, even though neither
was built for anti-cheat:

- **Host-migration election** (`client/HostMigration.js`'s `electWinner`): deterministic,
  lowest-RTT-with-pubkey-tiebreak selection of the next host on disconnect. Every peer computes the same
  answer independently — this is a *consensus* primitive (no leader-proposes-and-waits round trip), but it
  elects on RTT alone, with **zero notion of "trustworthiness."** A future mitigation wanting some form of
  multi-peer cross-validation (e.g. "N peers must agree on a snapshot's hit-registration outcome before
  it's accepted") would build on this same deterministic-computation pattern, but would need a genuinely
  new signal (not RTT) to weight candidates by.
- **Peer RTT table** (`src/sdk/TickHandler.js`'s `MSG.PEER_RTT_TABLE` broadcast, consumed via
  `MessageHandler.js`'s `getPeerRttTable()`): every *dedicated*-server client already gets a live
  per-peer RTT + pubkey map. This is a dedicated-server-only mechanism today (it's part of the
  host-migration data source for when a P2P *dedicated* server's connected players need to know each
  other's pubkeys) — it does not currently reach into a P2P room's own peer set to do anything
  P2P-trust-relevant.

## What CAN be mitigated client-side by joiners (detect, not prevent)

A joiner in a P2P room cannot force a malicious host to compute correctly — but a joiner CAN
sanity-check the snapshot deltas it receives for physically-impossible values and *flag* them (to the
player, or to a future reputation/reporting system), even though it cannot *prevent* the host from having
lied:

- Position deltas exceeding `maxSpeed * dt` by a large factor (composability note: this is the exact same
  envelope-check math a hardened dedicated server would run authoritatively — see
  `anticheat-server-envelope-checks` — except here it's advisory-only, since the joiner has no authority
  to reject/correct the host's snapshot, only to notice it looks wrong).
- Health/ammo values that jump up without a corresponding pickup/reload event in the visible event stream.
- A hit-registration event against a target whose last-known snapshot position was not geometrically in
  the claimed line of fire.

None of this is a real defense — a sufficiently motivated malicious host can always make its own snapshot
internally consistent (since it fully controls what it sends). It's a **detection-and-report** surface at
best, useful for community moderation/reputation signals, not a prevention mechanism.

## What fundamentally CANNOT be mitigated without a trusted-relay redesign

There is no client-side or protocol-level fix for "the host computes the authoritative state and I must
trust its output" as long as the host genuinely IS the authoritative compute node. The only architectural
fixes that actually close this gap:

1. **A trusted relay/rendezvous server** that either re-simulates (at least partially) or cross-validates
   host output against other peers' local observations before accepting it as canonical — this is a
   genuinely different netcode architecture from today's star-topology-through-the-host model, not a
   patch on top of it.
2. **Multi-host consensus** (N-of-M peers must independently compute/agree on an outcome before it's
   accepted) — expensive, adds latency, and still assumes a majority of participants aren't colluding.
3. **Restricting P2P-hosted rooms to non-competitive/cosmetic contexts** (private sessions among trusted
   friends, building/exploration modes) where "the host could cheat" is an accepted, low-stakes property
   — and steering competitive/ranked play exclusively to dedicated servers, where the existing
   server-authoritative architecture already holds.

Option 3 is the only one requiring no new infrastructure — it's a policy/UX decision (e.g. a server
browser, see `nostr-server-browser-client-ui`, could visually distinguish "dedicated" vs "P2P-hosted"
rooms so players make an informed trust choice), not a code change. Options 1 and 2 are large
architectural undertakings explicitly out of this doc's scope.

## Tractable dedicated-server mitigations (real follow-up work)

Since the dedicated server is already the trust root, the concrete, buildable hardening work is:

- **Input rate limiting** — a per-connection token bucket on `PLAYER_INPUT` messages (same shape as
  `ServerAPI.js`'s existing `DEBUG_LOG_BUCKET` pattern), catching a client flooding beyond the legitimate
  ~60/sec input-loop rate.
- **Movement envelope checks** — reject/clamp a claimed position delta exceeding `maxSpeed * dt`,
  composing with (not duplicating) the clock-sync/lag-comp timestamp-validation work.
- **Statistical outlier flags** — non-blocking `eventLog` entries for headshot% over a rolling window and
  suspiciously-fast reaction times on `weapon.js` hitscan events, for operator review, not auto-ban.

See PRD row `anticheat-server-envelope-checks` for the implementation of these three.
