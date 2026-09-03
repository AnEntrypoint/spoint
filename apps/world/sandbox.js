// boot with: WORLD=sandbox SANDBOX_APP=<name> node server.js
const sandboxApp = (typeof process !== 'undefined' && process.env && process.env.SANDBOX_APP) || null

export default {
  spawnPoint: [0, 5, 0],
  gravity: [0, -9.81, 0],
  entities: sandboxApp ? [{ id: 'sandbox-' + sandboxApp, app: sandboxApp, position: [0, 1, 3] }] : []
}
