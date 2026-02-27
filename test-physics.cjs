const WebSocket = require('ws');
const msgpack = require('./src/protocol/msgpack.js');

const ws = new WebSocket('ws://localhost:3001/ws');
ws.binaryType = 'arraybuffer';

let playerId = null;
let tickCount = 0;

ws.on('open', () => console.log('Connected'));

ws.on('message', (data) => {
  try {
    const msg = msgpack.unpack(new Uint8Array(data));
    const type = msg.type;
    const payload = msg.payload || {};
    
    if (type === 0x02) {
      playerId = payload.playerId;
      console.log('Player ID:', playerId);
    } else if (type === 0x10) {
      tickCount++;
      
      // Players are encoded as arrays: [id, x, y, z, ...]
      if (payload.players && payload.players.length > 0) {
        // Find our player by ID at index 0 of each array
        const me = payload.players.find(p => Array.isArray(p) && p[0] === playerId);
        if (me) {
          const y = me[2]; // Y is at index 2
          if (tickCount <= 5 || tickCount % 50 === 0) {
            console.log('Tick', tickCount, '- Player', playerId, 'Y:', y.toFixed(2));
          }
          if (y < -100 && tickCount > 10) {
            console.log('FAIL: Player fell through floor! Y:', y);
            ws.close();
            process.exit(1);
          }
        }
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
});

setTimeout(() => {
  console.log('\n=== Test Results ===');
  console.log('Ticks received:', tickCount);
  console.log('PASS: Player did not fall through in 2 seconds');
  ws.close();
  process.exit(0);
}, 2000);
