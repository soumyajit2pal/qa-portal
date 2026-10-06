// Search destinations use each entity's owning module and existing deep link.
const ID_PREFIX_ROUTES = [
  { prefix: 'TQA-FUNC', path: '/functional-requests' },
  { prefix: 'TQA-SAST', path: '/sast' },
  { prefix: 'TQA-DAST', path: '/dast' },
  { prefix: 'TQA-PERF', path: '/performance' },
  { prefix: 'TQA-SUP', path: '/suppression' },
  { prefix: 'TQA-SIGN', path: '/signoff' },
  { prefix: 'TQA-PROJ', path: '/test-projects' },
  { prefix: 'TQA-PLAN', path: '/test-projects' },
  { prefix: 'TQA-TC', path: '/test-repository' },
  { prefix: 'TQA-CYCLE', path: '/test-execution' },
  { prefix: 'TQA-DEF-', path: '/defects' },
  // Preserve legacy IDs; DEF-* must not be rewritten to a different record.
  { prefix: 'DEF-', path: '/defects' },
  { prefix: 'SUP', path: '/suppression' },
  { prefix: 'QA-CERT', path: '/signoff' },
]

const TQA_ID_SHORTHAND = /^(FUNC|SAST|DAST|PERF|SIGN|PROJ|TC|CYCLE)-/i
const CR_OR_EPIC_NUMBER_REGEX = /^(?:CR-[0-9]{1,12}|EPIC-[0-9]{1,10})$/

export function clearGlobalSearchDestination(pathname: string, query: string): string | null {
  const params = new URLSearchParams(query)
  const searchKeys = ['cr_number', 'search', 'open', 'openId']
  if (!searchKeys.some((key) => params.has(key))) return null
  searchKeys.forEach((key) => params.delete(key))
  const remaining = params.toString()
  return `${pathname}${remaining ? `?${remaining}` : ''}`
}

export function globalSearchDestination(value: string): string | null {
  const term = value.trim()
  if (!term) return null
  const upper = term.toUpperCase()
  if (upper.startsWith('ESIG-')) return `/verify-signature?id=${encodeURIComponent(upper)}`
  const normalizedTerm = !upper.startsWith('TQA-') && TQA_ID_SHORTHAND.test(upper)
    ? `TQA-${upper}`
    : term
  const normalizedUpper = normalizedTerm.toUpperCase()
  const idRoute = ID_PREFIX_ROUTES.find((route) => normalizedUpper.startsWith(route.prefix))
  if (idRoute) return `${idRoute.path}?open=${encodeURIComponent(normalizedTerm)}`
  // Exact CR/EPIC matching prevents CR-102 from also finding CR-1023.
  if (CR_OR_EPIC_NUMBER_REGEX.test(normalizedUpper)) return `/qa-requests?cr_number=${encodeURIComponent(normalizedUpper)}`
  return `/qa-requests?search=${encodeURIComponent(normalizedTerm)}`
}
