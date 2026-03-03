import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

const serverLog = [];
const botLog = [];

console.log('Starting server...');
const serverProcess = spawn('npm', ['start'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true
});

serverProcess.stdout.on('data', (data) => {
  const text = data.toString();
  serverLog.push(text);
  if (text.includes('[tick-profile]') || text.includes('[boot]')) {
    console.log('[SERVER] ' + text.trim());
  }
});

serverProcess.stderr.on('data', (data) => {
  const text = data.toString();
  serverLog.push(text);
});

setTimeout(() => {
  console.log('\nStarting bot harness...');
  const botProcess = spawn('node', ['src/sdk/BotHarness.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, BOT_COUNT: '100', BOT_DURATION: '120000' }
  });

  botProcess.stdout.on('data', (data) => {
    const text = data.toString();
    botLog.push(text);
    console.log('[BOT] ' + text.trim());
  });

  botProcess.stderr.on('data', (data) => {
    const text = data.toString();
    botLog.push(text);
  });

  botProcess.on('close', (code) => {
    console.log(`\nBot harness exited with code ${code}`);

    // Save logs
    writeFileSync('server-profile.log', serverLog.join(''));
    writeFileSync('bot-profile.log', botLog.join(''));
    console.log('\nLogs saved to server-profile.log and bot-profile.log');

    // Parse tick-profile logs
    const profileLines = serverLog.join('').split('\n').filter(l => l.includes('[tick-profile]'));
    console.log(`\nFound ${profileLines.length} tick-profile logs`);
    profileLines.forEach(l => console.log(l));

    process.exit(0);
  });
}, 5000);
