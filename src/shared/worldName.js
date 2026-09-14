const WORLD_FILE_STEM = /^[A-Za-z0-9_-]{1,128}$/

export function isWorldName(v) {
  return typeof v === 'string' && WORLD_FILE_STEM.test(v)
}
