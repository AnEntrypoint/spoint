process.env.BOT_COUNT = '100';
process.env.BOT_DURATION = '120000';

import('./src/sdk/BotHarness.js').catch(console.error);
