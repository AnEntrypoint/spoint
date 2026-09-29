---
key: mem-a6feaec1d10f1feb-1402
ns: default
created: 1790724781481
updated: 1790724781481
---

project/tick-scheduler-and-snapshot-wire-v3: Windows timers (setTimeout and Atomics.wait) resolve at about 15.6 ms for Node, so a 60/64 Hz tick can't be precise with timers. src/netcode/TickSystemBase.js keeps an absolute next-due timeline (fixed dt, catch-up capped at 4 steps then time dropped). Default timer mode may run a tick up to half a timer quantum early, which removes double-tick bursts at 0.3% CPU; at 60 Hz one 31 ms grid skip every ~15 ticks is inherent. Precise mode (worldDef.netcode.preciseTicks or SPOINT_PRECISE_TICKS=1) yield-spins with setImmediate: measured p99 15.7 ms at 64 Hz but 100% of a core on Windows; Linux timers are 1 ms. The snapshot rate is tickRate or netcode.snapshotRate, halved only by measured snapshot-build CPU cost, never by ping or player count. HEARTBEAT_ACK goes out via ConnectionManager.sendNow (unqueued). Wire v3: the player record is 8 fields with a 22-byte bin (no scale), 35 bytes vs 51; recipient-only fields [inputSequence, inputBuffer, groundNormal] travel in the per-recipient snapshot 'me' block (WIRE_STRUCTURES[1] ends with 'me', so snapshots are packed per recipient; the cell pack caches were removed). Bandwidth at 60 Hz: 8 players 18.5 KB/s, 16 players 34.9 KB/s per client. Over WebSocket, loss causes TCP head-of-line stalls that the interpolation jitter must absorb (75/15/5%: 222 ms delay); the unreliable-channel model gives 120 ms.
