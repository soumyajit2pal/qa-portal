export interface MergedRichTableCell {
  t: string
  c?: number
  r?: number
  h?: boolean
}

export interface MergedRichTable {
  rows: MergedRichTableCell[][]
}

const PREFIX = '[qap-merged-table:v1:'
const PATTERN = /^\[qap-merged-table:v1:([A-Za-z0-9_-]+)\]$/

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
}

function validSpan(value: unknown): number | undefined {
  const span = Number(value || 1)
  return Number.isInteger(span) && span > 1 && span <= 100 ? span : undefined
}

// Spreadsheet clipboard HTML occasionally contains row spans that conflict
// with a later, fully populated row. Browsers resolve that invalid logical
// grid by silently adding columns, which is why a four-column paste could
// render as six columns. A genuine row span leaves fewer source cells in the
// covered rows; only shorten spans when keeping them would force the row past
// the table's source width.
export function normalizeMergedRichTable(table: MergedRichTable): MergedRichTable {
  const rows = table.rows.map((row) => row.map((cell) => ({ ...cell })))
  const width = Math.max(1, ...rows.map((row) => row.reduce((total, cell) => total + (cell.c || 1), 0)))
  type ActiveSpan = { cell: MergedRichTableCell; originRow: number; endRow: number }
  const active: Array<ActiveSpan | undefined> = Array(width)

  rows.forEach((row, rowIndex) => {
    for (let column = 0; column < width; column += 1) {
      if (active[column] && active[column]!.endRow < rowIndex) active[column] = undefined
    }
    const required = row.reduce((total, cell) => total + (cell.c || 1), 0)
    const activeCount = active.filter(Boolean).length
    if (activeCount + required > width) {
      let toRelease = activeCount + required - width
      const conflicts = Array.from(new Set(active.filter((span): span is ActiveSpan => !!span)))
      for (const conflict of conflicts) {
        const covered = active.filter((span) => span === conflict).length
        const shortened = rowIndex - conflict.originRow
        conflict.cell.r = shortened > 1 ? shortened : undefined
        active.forEach((span, column) => { if (span === conflict) active[column] = undefined })
        toRelease -= covered
        if (toRelease <= 0) break
      }
    }

    let column = 0
    row.forEach((cell) => {
      while (column < width && active[column]) column += 1
      const columnSpan = cell.c || 1
      const rowSpan = cell.r || 1
      if (rowSpan > 1) {
        const span = { cell, originRow: rowIndex, endRow: rowIndex + rowSpan - 1 }
        for (let covered = column; covered < Math.min(width, column + columnSpan); covered += 1) active[covered] = span
      }
      column += columnSpan
    })
  })
  return { rows }
}

export function encodeMergedRichTable(table: MergedRichTable): string {
  return `${PREFIX}${encodeBase64Url(JSON.stringify(normalizeMergedRichTable(table)))}]`
}

export function decodeMergedRichTable(value: string): MergedRichTable | null {
  const match = value.trim().match(PATTERN)
  if (!match) return null
  try {
    const parsed = JSON.parse(decodeBase64Url(match[1])) as MergedRichTable
    if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) return null
    const rows = parsed.rows.map((row) => {
      if (!Array.isArray(row)) throw new Error('Invalid merged table row')
      return row.map((cell) => {
        if (!cell || typeof cell.t !== 'string') throw new Error('Invalid merged table cell')
        return {
          t: cell.t,
          c: validSpan(cell.c),
          r: validSpan(cell.r),
          h: cell.h === true || undefined,
        }
      })
    })
    return normalizeMergedRichTable({ rows })
  } catch {
    return null
  }
}
