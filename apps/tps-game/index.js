import { tpsGameServer } from './server-app.js'
import { tpsGameClient } from './client-app.js'

export { predictHit } from './shared.js'

export default {
  server: tpsGameServer,
  client: tpsGameClient
}
