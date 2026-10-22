import { TestCycleFolderOut } from './types'

export function cycleFolderAncestors(folders: TestCycleFolderOut[], folder: TestCycleFolderOut): TestCycleFolderOut[] {
  const byId = new Map(folders.map(item => [item.id, item]))
  const path: TestCycleFolderOut[] = [], seen = new Set<number>()
  let current: TestCycleFolderOut | undefined = folder
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parent_id ? byId.get(current.parent_id) : undefined
  }
  return path
}

export function cycleFolderPathLabel(folders: TestCycleFolderOut[], folder: TestCycleFolderOut): string {
  return cycleFolderAncestors(folders, folder).map(item => item.name).join(' / ')
}

export function cycleFolderIsRestricted(folders: TestCycleFolderOut[], folder: TestCycleFolderOut): boolean {
  return cycleFolderAncestors(folders, folder).some(item => item.access_grants.length > 0)
}
