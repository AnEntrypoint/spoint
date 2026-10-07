export function parseArgs(argv) {
  return Object.fromEntries(argv.map(a => {
    const bare = a.replace(/^--/, '')
    const eq = bare.indexOf('=')
    return eq < 0 ? [bare, true] : [bare.slice(0, eq), bare.slice(eq + 1)]
  }))
}

export function numArg(value, fallback) {
  return (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) ? Number(value) : fallback
}

export function strArg(value, fallback) {
  return (typeof value === 'string' && value !== '') ? value : fallback
}
