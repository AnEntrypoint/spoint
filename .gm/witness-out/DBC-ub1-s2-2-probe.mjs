
import { EventChainManager } from '/workspace/spoint/src/game/EventChainManager.js';
const m = new EventChainManager();
const spec = { trigger: { type: 'onInteract', entityId: '*' } };
const before = JSON.stringify(spec);
const chain = m.addChain(spec);
let threw = null;
try { m.addChain(null) } catch (e) { threw = e.message }
console.log(JSON.stringify({ specUnchanged: JSON.stringify(spec) === before, name: chain.name, id: chain.id, threwOnNull: threw }));