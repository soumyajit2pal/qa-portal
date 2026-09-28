import React, { ComponentProps, ComponentType, createContext, createElement, lazy, useContext } from 'react'
import { DEFAULT_LAZY_MODULE_TIMEOUT_MS, loadLazyModule } from './lazyModuleLoader'

export const LazyModuleRecoveryContext = createContext(0)

let nextRecoveryKey = 0

export function nextLazyModuleRecoveryKey(): number {
  nextRecoveryKey += 1
  return nextRecoveryKey
}

interface LazyModuleOptions {
  timeoutMs?: number
  displayName?: string
}

/**
 * React.lazy with a deadline and boundary-driven recovery. React.lazy caches
 * a rejected promise, so merely clearing an error boundary cannot retry it.
 * Each recovery key receives a fresh lazy wrapper while retaining normal
 * route-level code splitting and component props.
 */
export function lazyModule<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
  options: LazyModuleOptions = {},
): ComponentType<ComponentProps<T>> {
  const attempts = new Map<number, React.LazyExoticComponent<T>>()
  const timeoutMs = options.timeoutMs ?? DEFAULT_LAZY_MODULE_TIMEOUT_MS

  function componentFor(recoveryKey: number): React.LazyExoticComponent<T> {
    const existing = attempts.get(recoveryKey)
    if (existing) return existing

    const component = lazy(() => loadLazyModule(importer, timeoutMs))
    attempts.set(recoveryKey, component)
    // A user can retry repeatedly during a prolonged outage. Retain only a
    // few recent lazy wrappers rather than accumulating rejected promises.
    if (attempts.size > 4) {
      const oldestKey = attempts.keys().next().value
      if (oldestKey !== undefined) attempts.delete(oldestKey)
    }
    return component
  }

  function RetryableLazyModule(props: ComponentProps<T>) {
    const recoveryKey = useContext(LazyModuleRecoveryContext)
    const LazyComponent = componentFor(recoveryKey)
    return createElement(LazyComponent as ComponentType<ComponentProps<T>>, props)
  }

  RetryableLazyModule.displayName = options.displayName || 'LazyModule'
  return RetryableLazyModule
}
