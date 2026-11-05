export function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function parseSections(markdown) {
  const lines = markdown.split('\n')
  const sections = []
  let fenced = false
  lines.forEach((line, index) => {
    if (line.startsWith('```')) fenced = !fenced
    if (fenced) return
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match) sections.push({ level: match[1].length, title: match[2], slug: slugify(match[2]), line: index + 1 })
  })
  return sections
}

export function getSection(markdown, slug) {
  const sections = parseSections(markdown)
  const at = sections.findIndex((section) => section.slug === slug)
  if (at < 0) return null
  const start = sections[at]
  const next = sections.slice(at + 1).find((section) => section.level <= start.level)
  const lines = markdown.split('\n')
  return lines.slice(start.line - 1, next ? next.line - 1 : lines.length).join('\n').trimEnd()
}
