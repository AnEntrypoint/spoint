---
key: mem-3c94ccdb48da9bd2-813
ns: default
created: 1789414414331
updated: 1789414414331
---

project/player-send-numeric-id-and-client-sync-request: ConnectionManager.clients is keyed by numeric player id, so ctx.players.send(String(pid), ...) silently returns false. QuestSystem, StatsSystem and apps/_lib/inventory.js did this until 8f4a35ba, so no push ever reached a client; send to the id as given. APP_EVENT payloads that arrive before the client app module is evaluated are dropped by onEvent, and pushes sent at player_join often land in that window. Either push periodically (rpg-tutorial, every 1 s) or have client.setup send engine.network.send({type:'<app>.sync'}) and answer with each system's push(senderId) (tutorial-rpg). In the singleplayer Worker, an app importing ../_lib/game-fsm.js fails string eval on its xstate import ('Failed to resolve module specifier /node_modules/xstate/...').
