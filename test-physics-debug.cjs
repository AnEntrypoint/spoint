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
      if (!playerId) return;
      
      if (payload.players && payload.players.length > 0) {
        const me = payload.players.find(p => Array.isArray(p) && p[0] === playerId);
        if (me) {
          const y = me[2];
          if (tickCount <= 5 || tickCount % 100 === 0) {
            console.log('Tick', tickCount, '- Y:', y.toFixed(2), tickCount > 5 && y < -10 ? '(FALLING!)' : '');
          }
          
          if (y < -50) {
            console.log('\n=== FAIL: Player fell through floor ===');
            console.log('Y position:', y.toFixed(2), 'after', tickCount, 'ticks');
            ws.close();
            process.exit(1);
          }
        }
      }
    }
  } catch (e) {}
});

setTimeout(() => {
  console.log('\n=== FAIL: No collision - still falling after 3s ===');
  ws.close();
  process.exit(1);
}, 3000);
