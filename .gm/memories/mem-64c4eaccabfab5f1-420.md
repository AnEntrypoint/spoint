---
key: mem-64c4eaccabfab5f1-420
ns: default
created: 1789397744298
updated: 1789397744298
---

project/edge-bundled-flag-import-order: globalThis.__SPOINT_EDGE_BUNDLED__ is set at jolt-edge-init.js top level, so edge/cf-do/spoint-do.js must import jolt-edge-init.js BEFORE WorkerEntry.js: ESM evaluates in import order, and apps/_lib/game-fsm.js / src/protocol/msgpack.js read the flag during top-level evaluation to pick the bare specifier. Reordering reintroduces workerd 'No such module node_modules/xstate/...'.
