const fs = require('fs');

const logPath = 'C:/Users/user/AppData/Local/Temp/claude/C--dev-devbox-spawnpoint/tasks/bfe0ae7.output';

try {
  const log = fs.readFileSync(logPath, 'utf-8');
  const lines = log.split('\n');

  // Find all tick-profile logs
  const profiles = lines.filter(l => l.includes('[tick-profile]'));

  console.log(`Total lines: ${lines.length}`);
  console.log(`Tick-profile logs found: ${profiles.length}`);

  if (profiles.length === 0) {
    console.log('\nNo tick-profile logs found. Last 100 lines:');
    lines.slice(-100).forEach(l => console.log(l));
  } else {
    console.log('\n=== TICK-PROFILE LOGS ===\n');
    profiles.forEach(p => console.log(p));

    // Parse and analyze
    console.log('\n\n=== ANALYSIS ===');
    const parsed = profiles.map(p => {
      const match = p.match(/tick:(\d+).*?players:(\d+).*?entities:(\d+).*?dynIds:(\d+).*?activeDyn:(\d+).*?total:([\d.]+)ms.*?mv:([\d.]+).*?col:([\d.]+).*?phys:([\d.]+).*?app:([\d.]+).*?sync:([\d.]+).*?respawn:([\d.]+).*?spatial:([\d.]+).*?col2:([\d.]+).*?int:([\d.]+).*?snap:([\d.]+).*?heap:([\d.]+)MB.*?rss:([\d.]+)MB.*?ext:([\d.]+)MB.*?ab:([\d.]+)MB/);
      if (match) {
        return {
          tick: parseInt(match[1]),
          players: parseInt(match[2]),
          entities: parseInt(match[3]),
          dynIds: parseInt(match[4]),
          activeDyn: parseInt(match[5]),
          total: parseFloat(match[6]),
          mv: parseFloat(match[7]),
          col: parseFloat(match[8]),
          phys: parseFloat(match[9]),
          app: parseFloat(match[10]),
          sync: parseFloat(match[11]),
          respawn: parseFloat(match[12]),
          spatial: parseFloat(match[13]),
          col2: parseFloat(match[14]),
          int: parseFloat(match[15]),
          snap: parseFloat(match[16]),
          heap: parseFloat(match[17]),
          rss: parseFloat(match[18]),
          ext: parseFloat(match[19]),
          ab: parseFloat(match[20])
        };
      }
      return null;
    }).filter(p => p !== null);

    if (parsed.length > 0) {
      console.log(`\nParsed ${parsed.length} profiles\n`);
      console.log('Average times (ms):');
      const avg = {
        total: 0, mv: 0, col: 0, phys: 0, app: 0, sync: 0, respawn: 0, spatial: 0, col2: 0, int: 0, snap: 0
      };
      parsed.forEach(p => {
        avg.total += p.total; avg.mv += p.mv; avg.col += p.col; avg.phys += p.phys;
        avg.app += p.app; avg.sync += p.sync; avg.respawn += p.respawn;
        avg.spatial += p.spatial; avg.col2 += p.col2; avg.int += p.int; avg.snap += p.snap;
      });
      Object.keys(avg).forEach(k => avg[k] = (avg[k] / parsed.length).toFixed(2));

      console.log(`  Total:   ${avg.total}ms (budget: 7.8ms)`);
      console.log(`  Movement: ${avg.mv}ms`);
      console.log(`  Collision: ${avg.col}ms (before physics)`);
      console.log(`  Physics: ${avg.phys}ms`);
      console.log(`  Apps: ${avg.app}ms`);
      console.log(`  Sync: ${avg.sync}ms`);
      console.log(`  Respawn: ${avg.respawn}ms`);
      console.log(`  Spatial: ${avg.spatial}ms`);
      console.log(`  Collision2: ${avg.col2}ms (after physics)`);
      console.log(`  Interact: ${avg.int}ms`);
      console.log(`  Snapshot: ${avg.snap}ms`);

      console.log('\nMemory trend (last 3):');
      parsed.slice(-3).forEach(p => {
        console.log(`  Tick ${p.tick}: heap=${p.heap}MB, rss=${p.rss}MB, ext=${p.ext}MB`);
      });

      const snapTimes = parsed.map(p => p.snap).sort((a, b) => b - a);
      console.log(`\nSnapshot phase bottleneck: max=${snapTimes[0]}ms, min=${snapTimes[snapTimes.length-1]}ms, avg=${avg.snap}ms`);

      const physTimes = parsed.map(p => p.phys).sort((a, b) => b - a);
      console.log(`Physics phase: max=${physTimes[0]}ms, min=${physTimes[physTimes.length-1]}ms, avg=${avg.phys}ms`);
    }
  }
} catch (e) {
  console.error('Error:', e.message);
}
