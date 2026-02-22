#!/usr/bin/env node
import { boot } from './src/sdk/server.js'
import { scaffold } from './src/sdk/scaffold.js'

const cmd = process.argv[2]
if (cmd === 'scaffold') {
  await scaffold()
} else {
  await scaffold()
  await boot()
}
