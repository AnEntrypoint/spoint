const fs = require('fs');

const log = fs.readFileSync('server_output.log', 'utf-8');
const lines = log.split('\n');

// Find all tick-profile logs
const profiles = lines.filter(l => l.includes('[tick-profile]'));

console.log(`Total lines: ${lines.length}`);
console.log(`Tick-profile logs found: ${profiles.length}\n`);

if (profiles.length === 0) {
  console.log('No tick-profile logs found. Last 50 lines:');
  lines.slice(-50).forEach(l => console.log(l));
} else {
  console.log('=== TICK-PROFILE LOGS ===\n');
  profiles.forEach(p => console.log(p));

  // Parse and analyze
  console.log('\n\n=== PERFORMANCE ANALYSIS ===');
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
    console.log(`Parsed ${parsed.length} profiles\n`);

    // Calculate averages
    const avg = {
      total: 0, mv: 0, col: 0, phys: 0, app: 0, sync: 0, respawn: 0, spatial: 0, col2: 0, int: 0, snap: 0,
      heap: 0, rss: 0, ext: 0, ab: 0
    };
    parsed.forEach(p => {
      avg.total += p.total; avg.mv += p.mv; avg.col += p.col; avg.phys += p.phys;
      avg.app += p.app; avg.sync += p.sync; avg.respawn += p.respawn;
      avg.spatial += p.spatial; avg.col2 += p.col2; avg.int += p.int; avg.snap += p.snap;
      avg.heap += p.heap; avg.rss += p.rss; avg.ext += p.ext; avg.ab += p.ab;
    });
    Object.keys(avg).forEach(k => avg[k] = (avg[k] / parsed.length).toFixed(2));

    console.log('TIMING BREAKDOWN (milliseconds)');
    console.log('================================');
    console.log(`Total tick time:    ${avg.total}ms (budget: 7.8ms, over budget: ${(parseFloat(avg.total) - 7.8).toFixed(2)}ms)`);
    console.log(`  Movement:         ${avg.mv}ms`);
    console.log(`  Collision (pre):  ${avg.col}ms`);
    console.log(`  Physics:          ${avg.phys}ms`);
    console.log(`  Apps:             ${avg.app}ms`);
    console.log(`  Sync:             ${avg.sync}ms`);
    console.log(`  Respawn:          ${avg.respawn}ms`);
    console.log(`  Spatial:          ${avg.spatial}ms`);
    console.log(`  Collision (post): ${avg.col2}ms`);
    console.log(`  Interact:         ${avg.int}ms`);
    console.log(`  Snapshot:         ${avg.snap}ms`);

    console.log('\nMEMORY USAGE');
    console.log('============');
    console.log(`Heap:    ${avg.heap}MB`);
    console.log(`RSS:     ${avg.rss}MB`);
    console.log(`External: ${avg.ext}MB`);
    console.log(`Array Buffers: ${avg.ab}MB`);

    console.log('\nMEMORY TREND (last 3 snapshots)');
    console.log('===============================');
    parsed.slice(-3).forEach(p => {
      console.log(`Tick ${p.tick}: heap=${p.heap}MB, rss=${p.rss}MB`);
    });

    // Identify bottlenecks
    console.log('\nBOTTLENECK ANALYSIS');
    console.log('===================');
    const phases = [
      { name: 'Movement', times: parsed.map(p => p.mv) },
      { name: 'Collision (pre)', times: parsed.map(p => p.col) },
      { name: 'Physics', times: parsed.map(p => p.phys) },
      { name: 'Apps', times: parsed.map(p => p.app) },
      { name: 'Sync', times: parsed.map(p => p.sync) },
      { name: 'Respawn', times: parsed.map(p => p.respawn) },
      { name: 'Spatial', times: parsed.map(p => p.spatial) },
      { name: 'Collision (post)', times: parsed.map(p => p.col2) },
      { name: 'Interact', times: parsed.map(p => p.int) },
      { name: 'Snapshot', times: parsed.map(p => p.snap) }
    ];

    // Find slowest phase
    const slowest = phases.map(p => ({
      name: p.name,
      avg: (p.times.reduce((a, b) => a + b, 0) / p.times.length).toFixed(2),
      max: Math.max(...p.times).toFixed(2),
      min: Math.min(...p.times).toFixed(2)
    })).sort((a, b) => parseFloat(b.avg) - parseFloat(a.avg));

    slowest.forEach(p => {
      console.log(`${p.name.padEnd(18)}: ${p.avg}ms avg (max: ${p.max}ms, min: ${p.min}ms)`);
    });

    console.log('\nPRIMARY BOTTLENECK: ' + slowest[0].name.toUpperCase());
    console.log(`Current: ${slowest[0].avg}ms / 7.8ms budget = ${(parseFloat(slowest[0].avg) / 7.8 * 100).toFixed(1)}% of budget`);

    // Entity counts
    console.log('\nENTITY STATS');
    console.log('============');
    const lastProfile = parsed[parsed.length - 1];
    console.log(`Total entities: ${lastProfile.entities}`);
    console.log(`Dynamic entity IDs: ${lastProfile.dynIds}`);
    console.log(`Active dynamic: ${lastProfile.activeDyn}`);
    console.log(`Players: ${lastProfile.players}`);
  }
}
