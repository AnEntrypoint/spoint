import * as C from '/workspace/spoint/src/protocol/InputCodec.js';
import { emitEnvelope, validateEnvelope } from '/workspace/spoint/src/sdk/SharedEventEnvelope.js';
const out = {};
for (const name of ['expr', 'analogForward']) {
  try { C.createInputSchema({ inputAxes: [name] }); out[name] = 'accepted'; } catch (e) { out[name] = 'refused: ' + e.message.slice(0, 90); }
}
const entries = Array.from({ length: C.MAX_INPUTS_PER_PACKET + 2 }, (_, i) => ({ yaw: 0, pitch: 0 }));
const t = C.tryEncodeInputPacket(C.DEFAULT_INPUT_SCHEMA, entries, 0);
out.tryEncodeKeys = t && typeof t === 'object' ? Object.keys(t).join(',') : String(t);
const bus = { emit: (channel, data, meta) => ({ meta: { timestamp: 1 } }) };
const env = emitEnvelope(bus, '', { a: 1 });
out.emptyChannelEnv = { kind: env.kind, source: env.source };
out.validate = validateEnvelope(env);
console.log(JSON.stringify(out));