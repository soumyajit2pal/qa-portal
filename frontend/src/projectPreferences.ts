import { TestProjectOut } from './types'

const LAST_PROJECT_PREFIX = 'qualityops.test-management.last-project'
const FAVORITE_PROJECTS_PREFIX = 'qualityops.test-management.favorite-projects'

function preferenceKey(prefix: string, userId?: number | null): string {
  return `${prefix}:${userId ?? 'anonymous'}`
}

export function readLastProjectId(userId?: number | null): number | null {
  try {
    const value = Number(window.localStorage.getItem(preferenceKey(LAST_PROJECT_PREFIX, userId)))
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export function rememberLastProjectId(projectId: number, userId?: number | null): void {
  try {
    window.localStorage.setItem(preferenceKey(LAST_PROJECT_PREFIX, userId), String(projectId))
  } catch {
    // A blocked/full storage area must not prevent project navigation.
  }
}

export function readFavoriteProjectIds(userId?: number | null): Set<number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(preferenceKey(FAVORITE_PROJECTS_PREFIX, userId)) || '[]')
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map(Number).filter((value) => Number.isInteger(value) && value > 0))
  } catch {
    return new Set()
  }
}

export function rememberFavoriteProjectIds(projectIds: ReadonlySet<number>, userId?: number | null): void {
  try {
    window.localStorage.setItem(preferenceKey(FAVORITE_PROJECTS_PREFIX, userId), JSON.stringify([...projectIds]))
  } catch {
    // Favorites are an enhancement; keep the selector usable without storage.
  }
}

export function resolvePreferredProjectId(
  projects: TestProjectOut[],
  requestedProjectId: number | null,
  currentProjectId: number | '',
  userId?: number | null,
): number | '' {
  const available = new Set(projects.map((project) => project.id))
  if (requestedProjectId && available.has(requestedProjectId)) return requestedProjectId
  if (currentProjectId && available.has(currentProjectId)) return currentProjectId
  const remembered = readLastProjectId(userId)
  if (remembered && available.has(remembered)) return remembered
  return projects[0]?.id || ''
}
