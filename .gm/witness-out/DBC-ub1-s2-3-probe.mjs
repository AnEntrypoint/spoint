
import { defineStatsSystem } from '/workspace/spoint/src/game/StatsSystem.js';
const stats = defineStatsSystem({}, { progression: null, inventory: null });
const res = stats.restore({ 'p1': { level: 9, xp: 0 } });
const s = stats.getStats('p1');
console.log(JSON.stringify({ restoreOk: res && res.ok, level: s.level, xp: s.xp }));