function refusal(code, message) {
  const err = new TypeError(`[coverage-report] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function buildCoverageReport({ title, areas, openItems = [] } = {}) {
  if (typeof title !== 'string' || !title) throw refusal('coverage-title-invalid', 'title must be a non-empty string')
  if (!Array.isArray(areas) || areas.length === 0) throw refusal('coverage-areas-invalid', 'areas must be a non-empty array')
  if (!Array.isArray(openItems) || openItems.some(item => typeof item !== 'string')) throw refusal('coverage-open-invalid', 'openItems must be an array of strings')
  const rows = areas.map((area, i) => {
    if (!area || typeof area !== 'object' || typeof area.name !== 'string') throw refusal('coverage-area-invalid', `areas[${i}] needs a name`)
    const { expected, found } = area
    if (!Number.isInteger(expected) || !Number.isInteger(found) || expected < 0 || found < 0) throw refusal('coverage-count-invalid', `areas[${i}] counts must be non-negative integers`)
    const gaps = Array.isArray(area.gaps) ? area.gaps : []
    if (gaps.some(g => typeof g !== 'string')) throw refusal('coverage-gaps-invalid', `areas[${i}].gaps must be strings`)
    return { name: area.name, expected, found, result: found >= expected ? 'Matches' : 'Short', gaps }
  })
  const totalGaps = rows.reduce((sum, row) => sum + row.gaps.length, 0)
  const shortAreas = rows.filter(row => row.result === 'Short').length
  const complete = totalGaps === 0 && shortAreas === 0 && openItems.length === 0
  const lines = [
    `# ${title}`, '',
    '| Area | Expected | Found | Result |', '|---|---|---|---|',
    ...rows.map(row => `| ${row.name} | ${row.expected} | ${row.found} | ${row.result} |`),
    '', `Total gaps: ${totalGaps}. Open items: ${openItems.length}.`,
    ...rows.filter(row => row.gaps.length).flatMap(row => [`## ${row.name} gaps`, ...row.gaps.map(g => `- ${g}`), '']),
    ...(openItems.length ? ['## Open items', ...openItems.map(item => `- ${item}`), ''] : []),
    `Is this complete: ${complete ? 'YES' : 'NO'}.`,
  ]
  return { markdown: lines.join('\n'), complete, totalGaps, shortAreas, rows }
}
