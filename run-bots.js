process.env.BOT_COUNT = process.argv[2] || '100'
process.env.BOT_DURATION = process.argv[3] || '60000'
import('./src/sdk/BotHarness.js')
