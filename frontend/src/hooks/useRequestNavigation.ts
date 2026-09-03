import { createContext, useCallback, useContext } from 'react'
import { NavigateFunction, useNavigate } from 'react-router-dom'
import { RequestTarget, requestTarget } from '../requestNavigation'

export const RequestViewerContext = createContext<((target: RequestTarget) => void) | null>(null)

/** Open request destinations in place; preserve normal navigation elsewhere. */
export function useRequestNavigation(): NavigateFunction {
  const navigate = useNavigate()
  const openRequest = useContext(RequestViewerContext)
  return useCallback<NavigateFunction>((to, options?) => {
    const target = typeof to === 'string' ? requestTarget(to) : null
    if (target && openRequest) {
      openRequest(target)
    } else if (typeof to === 'number') {
      navigate(to)
    } else {
      navigate(to, options)
    }
  }, [navigate, openRequest])
}
