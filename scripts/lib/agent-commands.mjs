function refusal(code, message) {
  const err = new TypeError(`[agent-commands] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export const COMMANDS = Object.freeze(['numbers', 'logs', 'events', 'prefetch'])

export function createAgentCommandRegistry(sources = {}) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw refusal('agent-sources-invalid', 'sources must be an object')
  const filters = (args, allowed) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw refusal('agent-args-invalid', 'args must be an object')
    for (const key of Object.keys(args)) if (!allowed.includes(key)) throw refusal('agent-filter-invalid', `unknown filter ${key}`)
    return args
  }
  return {
    numbers(args = {}) {
      filters(args, ['world'])
      const rows = Array.isArray(sources.numbers) ? sources.numbers : []
      return rows.filter(row => !args.world || row.world === args.world).map(row => JSON.stringify(row)).join('\n')
    },
    logs(args = {}) {
      filters(args, ['level', 'object', 'limit'])
      let rows = Array.isArray(sources.logs) ? sources.logs.slice() : []
      if (args.level) rows = rows.filter(row => row.level === args.level)
      if (args.object) rows = rows.filter(row => row.object === args.object)
      if (Number.isInteger(args.limit)) rows = rows.slice(0, args.limit)
      return rows.map(row => JSON.stringify(row)).join('\n')
    },
    events(args = {}) {
      filters(args, ['kind', 'since', 'once'])
      let rows = Array.isArray(sources.events) ? sources.events.slice() : []
      if (args.kind) rows = rows.filter(row => String(args.kind).split(',').includes(row.kind))
      if (args.since) rows = rows.filter(row => row.at >= args.since)
      if (args.once) rows = rows.slice(0, 1)
      return rows.map(row => JSON.stringify(row)).join('\n')
    },
    prefetch(args = {}) {
      filters(args, ['world', 'manifest', 'hex'])
      if (!args.world || !args.manifest || !args.hex) throw refusal('agent-prefetch-invalid', 'prefetch needs world, manifest and hex')
      return JSON.stringify({ world: args.world, manifest: args.manifest, hex: args.hex, cached: true })
    },
    run(name, args = {}) {
      if (!COMMANDS.includes(name)) throw refusal('agent-command-invalid', `command must be one of ${COMMANDS.join(', ')}`)
      return this[name](args)
    },
  }
}
