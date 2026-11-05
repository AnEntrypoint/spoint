function refusal(code, message) {
  const err = new TypeError(`[reference-bundle] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function splitTome(text) {
  if (typeof text !== 'string' || !text) throw refusal('tome-text-invalid', 'text must be a non-empty string')
  const seen = new Map()
  const sections = []
  let current = null
  for (const line of text.split('\n')) {
    if (/^#{1,3}\s+/.test(line)) {
      const heading = line.replace(/^#{1,3}\s+/, '').trim()
      const base = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const count = (seen.get(base) ?? 0) + 1
      seen.set(base, count)
      current = { heading, slug: count === 1 ? base : `${base}-${count}`, body: [] }
      sections.push(current)
    } else if (current) {
      current.body.push(line)
    }
  }
  if (sections.length === 0) throw refusal('tome-no-sections', 'text contains no headings')
  return sections.map(section => ({ heading: section.heading, slug: section.slug, body: section.body.join('\n').trim() }))
}

export function parseTypeListing(text) {
  if (typeof text !== 'string') throw refusal('type-text-invalid', 'text must be a string')
  const names = []
  for (const raw of text.split('\n')) {
    if (/^\d+\s+types:/.test(raw.trim())) break
    const line = raw.trim()
    if (!line) continue
    for (const name of line.split(',')) {
      const trimmed = name.trim().replace(/\s*\(\d+ kinds?\)\s*$/i, '')
      if (trimmed) names.push(trimmed)
    }
  }
  return names
}
