export class AtlasSpecError extends Error {
  constructor(reasonCode, detail) {
    super(`[atlas] ${reasonCode}${detail === undefined ? '' : ` ${detail}`}`)
    this.name = 'AtlasSpecError'
    this.reasonCode = reasonCode
  }
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0

export function atlasLayout(spec) {
  if (spec === null || typeof spec !== 'object') throw new AtlasSpecError('spec-not-object')
  const { frameSize, animations, columns } = spec
  if (!Array.isArray(frameSize) || frameSize.length !== 2 || !frameSize.every(isPositiveInt)) {
    throw new AtlasSpecError('frame-size-invalid', JSON.stringify(frameSize))
  }
  if (animations === null || typeof animations !== 'object') throw new AtlasSpecError('animations-not-object')
  const names = Object.keys(animations)
  if (names.length === 0) throw new AtlasSpecError('animations-empty')
  for (const name of names) {
    if (!isPositiveInt(animations[name])) throw new AtlasSpecError('frame-count-invalid', name)
  }
  const total = names.reduce((sum, name) => sum + animations[name], 0)
  const cols = columns === undefined ? total : columns
  if (!isPositiveInt(cols)) throw new AtlasSpecError('columns-invalid', String(columns))
  const [cellW, cellH] = frameSize
  const rows = Math.ceil(total / cols)
  const clips = {}
  let index = 0
  for (const name of names) {
    const cells = []
    for (let i = 0; i < animations[name]; i++, index++) {
      cells.push([(index % cols) * cellW, Math.floor(index / cols) * cellH])
    }
    clips[name] = { start: index - animations[name], count: animations[name], cells }
  }
  return { cellW, cellH, width: cols * cellW, height: rows * cellH, columns: cols, rows, clips }
}
