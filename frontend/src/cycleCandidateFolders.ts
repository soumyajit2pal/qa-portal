export interface CandidateFolder { id: number; parent_id?: number | null; name: string; direct_count: number; available_count: number }
export function folderBreadcrumb(folders: CandidateFolder[], id: number | 'unfiled' | ''): Array<{ id: number | 'unfiled'; name: string }> {
  if (id === '') return []
  if (id === 'unfiled') return [{ id, name: 'Unfiled' }]
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const path: Array<{ id: number; name: string }> = []
  const seen = new Set<number>()
  let current = byId.get(id)
  while (current && !seen.has(current.id)) { seen.add(current.id); path.unshift({ id: current.id, name: current.name }); current = current.parent_id ? byId.get(current.parent_id) : undefined }
  return path.length ? path : [{ id, name: 'Folder unavailable' }]
}
export function repositoryFolderRows(folders: CandidateFolder[], collapsed: ReadonlySet<number>) {
  const ids = new Set(folders.map(folder => folder.id))
  const children = new Map<number | null, CandidateFolder[]>()
  for (const folder of folders) {
    const parent = folder.parent_id && ids.has(folder.parent_id) ? folder.parent_id : null
    children.set(parent, [...(children.get(parent) || []), folder])
  }
  const rows: Array<{ folder: CandidateFolder; depth: number; hasChildren: boolean }> = []
  const seen = new Set<number>()
  function visit(folder: CandidateFolder, depth: number) {
    if (seen.has(folder.id)) return
    seen.add(folder.id)
    const nested = children.get(folder.id) || []
    rows.push({ folder, depth, hasChildren: nested.length > 0 })
    if (!collapsed.has(folder.id)) for (const child of nested) visit(child, depth + 1)
  }
  for (const root of children.get(null) || []) visit(root, 0)
  return rows
}
