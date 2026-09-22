export type MarkdownHeading = { level: number; text: string }

export function parseMarkdownHeading(line: string): MarkdownHeading | null {
  let level = 0
  while (level < line.length && level < 6 && line[level] === '#') level += 1
  if (level === 0 || line[level] !== ' ') return null
  let textStart = level
  while (line[textStart] === ' ') textStart += 1
  const text = line.slice(textStart)
  return text ? { level, text } : null
}

export function isMarkdownTableSeparator(line: string): boolean {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  const cells = body.split('|')
  return cells.length > 0 && cells.every((rawCell) => {
    let cell = rawCell.trim()
    if (cell.startsWith(':')) cell = cell.slice(1)
    if (cell.endsWith(':')) cell = cell.slice(0, -1)
    return cell.length >= 3 && Array.from(cell).every((character) => character === '-')
  })
}

export function splitMarkdownTableRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === '\\' && body[index + 1] === '|') {
      cell += '|'
      index += 1
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell.trim())
  return cells
}
