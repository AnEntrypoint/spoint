---
key: mem-ea80a3eff6f3de6c-420
ns: default
created: 1789393136016
updated: 1789393136016
---

project/appstate-map-set-tagged-snapshot: AppRuntime.snapshotGameState stores ctx.state via tagAppState (src/apps/AppRuntimeState.js) as plain JSON with {__type:'Map'|'Set'} tags; restoreGameState revives via untagAppState. A plain JSON round trip turns Map/Set into {} (tps-game ctx.state.buffs 'not iterable' after rollback). Snapshot output must stay tagged, not live Maps: WorldPersistence/FSAdapter re-stringify it.
