import { AppRuntime } from '/workspace/spoint/src/apps/AppRuntime.js';
const rt = new AppRuntime({});
rt.entities.set('e1', { id: 'e1', position: [0, 0, 0], custom: {} });
const out = {};
try { rt.setPlayerPosition('p1', [1, NaN, 3]); out.setNaN = 'returned'; } catch (e) { out.setNaN = 'threw: ' + e.message.slice(0, 90) }
try { rt.setPlayerPosition('p1', null); out.setNull = 'returned'; } catch (e) { out.setNull = 'threw: ' + e.message.slice(0, 90) }
try { out.attachNull = rt.attachEntityToPlayer('e1', 'p1', null) } catch (e) { out.attachNull = 'threw: ' + e.message.slice(0, 90) }
try { out.attachShort = rt.attachEntityToPlayer('e1', 'p1', [0, 1]) } catch (e) { out.attachShort = 'threw: ' + e.message.slice(0, 90) }
console.log(JSON.stringify(out));
