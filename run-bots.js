if (!process.env.BOT_COUNT) process.env.BOT_COUNT = process.argv[2] || '100'
if (!process.env.BOT_DURATION) process.env.BOT_DURATION = process.argv[3] || '60000'
if (!process.env.BOT_HZ) process.env.BOT_HZ = process.argv[4] || '60'
import('./src/sdk/BotHarness.js')
