const fs = require('fs');

const logPath = 'C:/Users/user/AppData/Local/Temp/claude/C--dev-devbox-spawnpoint/tasks/b8bf5a8.output';

try {
  const log = fs.readFileSync(logPath, 'utf-8');
  const profiles = log.split('\n').filter(l => l.includes('[tick-profile]'));
  console.log('=== TICK PROFILE LOGS ===');
  profiles.forEach(p => console.log(p));
  console.log(`\nTotal profiles captured: ${profiles.length}`);
} catch (e) {
  console.error('Error:', e.message);
}
