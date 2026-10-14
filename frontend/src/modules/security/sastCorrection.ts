import { SAST_COMPONENT_FIELDS, blankSastComponent, type SastRepositoryRow } from '../../components/SastRepositoryDetails'

type Repository = { id: number; values: Record<string, string> }
const fields = SAST_COMPONENT_FIELDS.map(field => field.key)

export function repositoryIdentity(reference: string, branch: string) {
  let value = reference.trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(value)
    if (['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol) && parsed.hostname) {
      const defaultPort = { 'http:': '80', 'https:': '443', 'ssh:': '22', 'git:': '9418' }[parsed.protocol]
      const host = parsed.hostname.toLowerCase() + (parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : '')
      value = `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}${parsed.search}`
    } else value = value.replace(/\.git$/, '')
  } catch { value = value.replace(/\.git$/, '') }
  return JSON.stringify([value, branch.trim()])
}

export function initialCorrectionRows(scope: Repository[]): SastRepositoryRow[] {
  return scope.length ? scope.map(target => ({ ...target.values, _target_id: String(target.id) })) : [blankSastComponent()]
}

export function sastCorrectionPayload(scope: Repository[], rows: SastRepositoryRow[], editableIds: number[]) {
  const originals = new Map(scope.map(target => [target.id, target]))
  const corrections = rows.filter(row => row._target_id && editableIds.includes(Number(row._target_id))).flatMap(row => {
    const target = originals.get(Number(row._target_id))
    const changed = Object.fromEntries(fields.filter(field => (row[field] || '').trim() !== (target?.values[field] || '').trim()).map(field => [field, (row[field] || '').trim()]))
    return Object.keys(changed).length ? [{ target_id: Number(row._target_id), ...changed }] : []
  })
  const new_repositories = rows.filter(row => !row._target_id).map(row => Object.fromEntries(fields.map(field => [field, (row[field] || '').trim()])))
  return { corrections, new_repositories }
}

export function sastCorrectionError(scope: Repository[], rows: SastRepositoryRow[], editableIds: number[], allowAdd: boolean, scopeReason: string) {
  const originals = new Map(scope.map(target => [target.id, target]))
  const stored = rows.filter(row => row._target_id)
  if (stored.length !== scope.length || new Set(stored.map(row => row._target_id)).size !== scope.length || stored.some(row => !originals.has(Number(row._target_id)))) {
    return 'Submitted repositories must be retained. Refresh the correction form.'
  }
  const added = rows.filter(row => !row._target_id)
  if (added.length && !allowAdd) return 'QA must permit repository additions for this return.'
  const changed = stored.filter(row => fields.some(field => (row[field] || '').trim() !== (originals.get(Number(row._target_id))?.values[field] || '').trim()))
  if (changed.some(row => !editableIds.includes(Number(row._target_id)))) return 'Only returned repositories can be changed.'
  if ([...added, ...changed].some(row => fields.some(field => !row[field]?.trim()))) return 'Complete every required field in each new or modified repository.'
  const identities = rows.map(row => repositoryIdentity(row.repository_url || '', row.git_branch || ''))
  if (rows.some((row, index) => {
    const original = originals.get(Number(row._target_id))
    const changedIdentity = !original || identities[index] !== repositoryIdentity(original.values.repository_url || '', original.values.git_branch || '')
    return changedIdentity && identities.filter(identity => identity === identities[index]).length > 1
  })) return 'Each repository and branch must be unique across existing and new repositories.'
  if (added.length && !scopeReason.trim()) return 'Provide a short reason for adding repositories.'
  return null
}
