const { execSync } = require('child_process');

try {
  console.log('Killing all node processes on port 3000...');
  execSync('netstat -ano | findstr :3000', { stdio: 'pipe' }).toString().split('\n').forEach(line => {
    const match = line.match(/\s+(\d+)\s*$/);
    if (match) {
      const pid = match[1];
      try {
        console.log(`Killing PID ${pid}`);
        execSync(`taskkill /PID ${pid} /F`);
      } catch (e) {
        console.log(`Could not kill ${pid}: ${e.message}`);
      }
    }
  });
} catch (e) {
  console.log('Port 3000 is free or no process found');
}
