// Minimal world-def: a player spawn point + one starter app entity. server.js's boot() picks
// apps/world/${WORLD}.js (WORLD env var, default 'tps-game') and falls back to apps/world/index.js
// when that named file is absent -- a fresh scaffold has no tps-game.js, so THIS file loads with
// zero env config needed on first run. Add more entities / a real terrain app / more games as
// additional apps/world/<name>.js files; select one with WORLD=<name> npx spoint.
export default {
  spawnPoint: [0, 5, 0],
  gravity: [0, -9.81, 0],
  entities: [
    { id: 'hello-box', app: 'hello-app', position: [0, 1, 3] }
  ]
}
