import { worldMobileButtons } from '/workspace/spoint/src/shared/worldDefaults.js';
const out = {};
const run = (name, def) => { try { out[name] = JSON.stringify(worldMobileButtons(def).map(b => b.grid)); } catch (e) { out[name] = e.name + ': ' + e.message.slice(0, 90); } };
run('outOfRangeGrid', { input: { mobileButtons: [{ action: 'jump', grid: [5, 5] }] } });
run('tenNoGrid', { input: { mobileButtons: Array.from({ length: 10 }, (_, i) => ({ action: 'a' + i })) } });
run('nineNoGrid', { input: { mobileButtons: Array.from({ length: 9 }, (_, i) => ({ action: 'a' + i })) } });
console.log(JSON.stringify(out));