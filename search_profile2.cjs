const fs = require('fs');

const logPath = 'C:/Users/user/AppData/Local/Temp/claude/C--dev-devbox-spawnpoint/tasks/bfe0ae7.output';

try {
  const log = fs.readFileSync(logPath, 'utf-8');
  const lines = log.split('\n');

  // Look for any line with 'profile' or 'tick'
  const profiles = lines.filter(l => l.includes('[tick-profile]') || l.includes('FINAL') || l.includes('Snapshots'));

  console.log(`Total lines: ${lines.length}`);
  console.log(`Profile-related lines: ${profiles.length}`);

  if (profiles.length > 0) {
    console.log('\nAll profile logs:');
    profiles.forEach(p => console.log(p));
  }

  console.log('\n\nLast 50 lines of output:');
  lines.slice(-50).forEach(l => console.log(l));
} catch (e) {
  console.error('Error:', e.message);
}
