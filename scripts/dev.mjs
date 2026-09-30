#!/usr/bin/env node
process.env.SPOINT_DEV = '1'
await import('../server.js')
