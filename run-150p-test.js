const WebSocket = require('ws');
const crypto = require('crypto');

const BOT_COUNT = 150;
const BOT_DURATION = 120000; // 120 seconds
const SERVER_URL = 'ws://localhost:3001';
const HEARTBEAT_INTERVAL = 1000;
const INPUT_INTERVAL = 16; // ~60Hz input

let connectedCount = 0;
let failedCount = 0;
const bots = [];
const startTime = Date.now();
let lastProfileTime = startTime;
let tickCount = 0;
let snapshotCount = 0;
let lastTickCount = 0;
let lastSnapshotCount = 0;

const profileInterval = setInterval(() => {
  const elapsed = Date.now() - startTime;
  const deltaTicks = tickCount - lastTickCount;
  const deltaSnapshots = snapshotCount - lastSnapshotCount;
  const deltaTime = elapsed - (lastProfileTime - startTime);

  console.log(`[150p-profile @ ${(elapsed/1000).toFixed(1)}s] ticks=${deltaTicks} (${(deltaTicks / (deltaTime / 1000)).toFixed(0)}/s) snapshots=${deltaSnapshots} (${(deltaSnapshots / (deltaTime / 1000)).toFixed(0)}/s) connected=${connectedCount} failed=${failedCount}`);

  lastTickCount = tickCount;
  lastSnapshotCount = snapshotCount;
  lastProfileTime = Date.now();
};
10000); // Every 10 seconds

function createBot(botId) {
  const uuid = crypto.randomUUID();
  let socket;
  let heartbeatTimer;
  let inputTimer;
  let tickTimer;
  let connected = false;

  const connect = () => {
    socket = new WebSocket(SERVER_URL);

    socket.on('open', () => {
      connected = true;
      connectedCount++;

      const joinMsg = {
        t: 0x00,
        playerId: uuid,
        playerName: `bot-${botId}`,
      };
      socket.send(Buffer.from(JSON.stringify(joinMsg)));

      heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(Buffer.from(JSON.stringify({ t: 0x20 })));
        }
      }, HEARTBEAT_INTERVAL);

      inputTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          const input = {
            t: 0x11,
            keys: Math.random() > 0.5 ? 'w' : '',
            lx: (Math.random() - 0.5) * 2,
            ly: (Math.random() - 0.5) * 2,
            lp: Math.random() * Math.PI * 2,
            ly_p: (Math.random() - 0.5) * Math.PI / 4,
          };
          socket.send(Buffer.from(JSON.stringify(input)));
        }
      }, INPUT_INTERVAL);
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.t === 0x10) snapshotCount++;
        if (msg.t === undefined && msg.ticks !== undefined) tickCount++;
      } catch (e) {}
    });

    socket.on('error', (err) => {
      if (!connected) failedCount++;
    });

    socket.on('close', () => {
      clearInterval(heartbeatTimer);
      clearInterval(inputTimer);
      connected = false;
    });
  };

  return { connect };
}

console.log(`[150p-test] Starting ${BOT_COUNT} bots for ${BOT_DURATION}ms...`);

for (let i = 0; i < BOT_COUNT; i++) {
  const bot = createBot(i);
  bot.connect();
  bots.push(bot);

  if ((i + 1) % 25 === 0) {
    console.log(`[150p-test] Spawned ${i + 1} bots...`);
  }
}

setTimeout(() => {
  clearInterval(profileInterval);

  const totalElapsed = Date.now() - startTime;
  const finalTicks = tickCount;
  const finalSnapshots = snapshotCount;

  console.log(`\n[150p-test FINAL] Test complete after ${(totalElapsed / 1000).toFixed(1)}s`);
  console.log(`[150p-test FINAL] Connected: ${connectedCount}/${BOT_COUNT}`);
  console.log(`[150p-test FINAL] Failed: ${failedCount}`);
  console.log(`[150p-test FINAL] Total ticks: ${finalTicks}`);
  console.log(`[150p-test FINAL] Total snapshots: ${finalSnapshots}`);
  console.log(`[150p-test FINAL] Tick rate: ${(finalTicks / (totalElapsed / 1000)).toFixed(0)} ticks/sec`);
  console.log(`[150p-test FINAL] Snapshot rate: ${(finalSnapshots / (totalElapsed / 1000)).toFixed(0)} snapshots/sec`);

  process.exit(0);
}, BOT_DURATION);
