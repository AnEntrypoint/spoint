const fs = require('fs');

const logPath = 'C:/Users/user/AppData/Local/Temp/claude/C--dev-devbox-spawnpoint/tasks/b8bf5a8.output';

try {
  const log = fs.readFileSync(logPath, 'utf-8');
  const lines = log.split('\n');

  // Look for any line with 'profile' or 'tick'
  const profiles = lines.filter(l => l.toLowerCase().includes('profile') || l.toLowerCase().includes('[tick]'));

  console.log(`Total lines: ${lines.length}`);
  console.log(`Profile-related lines: ${profiles.length}`);

  if (profiles.length === 0) {
    console.log('\nLast 20 lines of output:');
    lines.slice(-20).forEach(l => console.log(l));
  } else {
    console.log('\nProfile logs:');
    profiles.slice(-30).forEach(p => console.log(p));
  }
} catch (e) {
  console.error('Error:', e.message);
}
