import { emitEnvelope, validateEnvelope } from '/workspace/spoint/src/sdk/SharedEventEnvelope.js';
const bus = { emit: () => ({ meta: { timestamp: 1 } }) };
const out = {};
try { emitEnvelope(bus, '', {}); out.empty = 'accepted'; } catch (e) { out.empty = 'refused: ' + e.message; }
const ok = emitEnvelope(bus, 'chan.x', { a: 1 });
out.valid = validateEnvelope(ok);
console.log(JSON.stringify(out));