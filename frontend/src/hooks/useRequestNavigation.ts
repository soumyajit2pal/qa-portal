import { createContext, useCallback, useContext } from 'react'
import { NavigateFunction, useNavigate as useRouterNavigate } from 'react-router-dom'
import { internalNavigationPath, RequestTarget, requestTarget } from '../requestNavigation'

export const RequestViewerContext = createContext<((target: RequestTarget) => void) | null>(null)

/** Module pages defer request-ID deep links to the shared viewer when mounted inside it. */
export function useViewerManagedDeepLinks(): boolean {
  return useContext(RequestViewerContext) !== null
}

/** Programmatic SPA navigation with one same-origin validation boundary. */
export function useInternalNavigate(): NavigateFunction {
  const navigate = useRouterNavigate()
  return useCallback<NavigateFunction>((to, options?) => {
    if (typeof to === 'number') {
      navigate(to)
      return
    }
    if (typeof to === 'string') {
      const internalPath = internalNavigationPath(to)
      if (internalPath) navigate(internalPath, options)
      return
    }
    if (!to.pathname) return
    const internalPath = internalNavigationPath(`${to.pathname}${to.search || ''}${to.hash || ''}`)
    if (!internalPath) return
    const parsed = new URL(internalPath, 'https://portal.invalid')
    navigate({ pathname: parsed.pathname, search: parsed.search, hash: parsed.hash }, options)
  }, [navigate])
}

/** Open request destinations in place; preserve normal navigation elsewhere. */
export function useRequestNavigation(): NavigateFunction {
  const navigate = useInternalNavigate()
  const openRequest = useContext(RequestViewerContext)
  return useCallback<NavigateFunction>((to, options?) => {
    const internalPath = typeof to === 'string' ? internalNavigationPath(to) : null
    // Every string passed through this shared navigator is intended to be an
    // in-app destination. Ignore malformed, protocol-relative, or absolute
    // values rather than handing untrusted API/query data to React Router.
    if (typeof to === 'string' && !internalPath) return
    const target = internalPath ? requestTarget(internalPath) : null
    if (target && openRequest) {
      openRequest(target)
    } else if (typeof to === 'number') {
      navigate(to)
    } else if (internalPath) {
      navigate(internalPath, options)
    } else {
      navigate(to, options)
    }
  }, [navigate, openRequest])
}
