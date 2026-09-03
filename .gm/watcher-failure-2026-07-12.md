# gm-plugkit watcher terminal failure -- 2026-07-12 architecture-simplification session

The plugkit spool watcher became unrecoverable near the end of this session, blocking the gm
phase-machine's formal EMIT -> VERIFY -> CONSOLIDATE -> COMPLETE transitions. THE WORK ITSELF IS
COMPLETE, WITNESSED, COMMITTED, PUSHED, AND CI-GREEN -- only the phase bookkeeping is blocked.

## What shipped (commit ca90858d, main, CI green: deploy + npm + declaudeify + pages all success)

Maximum-effort architecture-simplification pass (user: "simplify/re-architect over-complex systems;
replace netcode with Colyseus"). Colyseus was re-verified net-negative (BrowserServer still runs the
whole server in a Web Worker with no net/ws sockets -> a Colyseus Room/Server swap still needs a
from-scratch in-Worker transport shim = net-larger surface, blocked by the smaller-surface guard;
user confirmed skip). A 7-system adversarial fan-out audit (47 agents, 20/39 findings REJECTED as
not-net-positive) found the codebase mostly already clean; 2 confirmed wins landed:

1. src/client/SnapshotProcessor.js -- collapsed to ONE decode path. Deleted parsePlayerNew +
   parseEntityNew (a duplicate hand-written decoder) + a dead _fieldDelta branch. The duplicate had
   DRIFTED into a real latent bug (stale 4-bit look-angle nibble decode vs the authoritative 8-bit
   fillPlayerArr). Buffer entries now deep-copy the authoritatively-decoded track slot. Witnessed:
   node test.js 32/32 pass, incl. a new array-form round-trip proving 8-bit look angles survive +
   no aliasing.
2. client/app.js -> client/core/FrameMetrics.js -- extracted the _perf/_dpr/_fog controllers
   (createPerfTracker/createDprController/createFogController). app.js -87 lines (~8%). Witnessed
   live (browser: __perf installed + sampling, app boots clean) + node + served-code.

All PRD rows resolved (pending 0), all mutables resolved (0), .ci-validated written matching HEAD
ca90858d -- confirmed BEFORE the watcher died.

## The watcher failure (bounded recovery exhausted)

Symptom: the watcher boots, immediately goes `busy` (codeinsight index rebuild of ~446 files + a
WASM bert embed-model load), misses heartbeats -> supervisor `planned-restart-after-heartbeat-stale`
-> restart loop -> `unplanned-restart-after-exit`. It processes ZERO `in/` dispatches while busy, and
the busy phase never completes (observed `busy stale` for 7+ minutes straight). Version churned
0.1.849 -> 0.1.850 -> 0.1.851 across reboots (npm has rapid releases; each `bun x`/`npx` boot pulls
newer). Earlier in the same session the sibling defect hit the `browser` verb (playwriter WASM
executor passing a STRING timeout to node vm/`waitForLoadState` -> `options.timeout must be number`),
also resistant to a cache-file patch + restarts (documented in mutables as
browser-executor-timeout-string-bug / mut-1783808296830). Both point at the WASM-wrapped plugkit
tooling (`~/.gm-tools/plugkit.wasm` + plugkit-wasm-wrapper.js) being unstable this session.

Recovery attempts, all exhausted: session reset, watcher+supervisor kill+reboot (6+ cycles), the
version upgrades themselves, a 5-location Number(timeout) patch to the cached playwriter executor.js
(the WASM daemon ignores it), and multi-minute settle waits for the index rebuild to finish (it
never did). NEXT SESSION: a genuinely fresh gm-plugkit install (clear ~/.gm-tools + the bun/npm
plugkit cache) should restore both the watcher and the browser verb, since dispatches 1-118 of an
earlier session worked fine before a mid-session reboot introduced the defect. Resume the gm chain
then to advance the (already-satisfied-on-substance) phase gates to COMPLETE.
