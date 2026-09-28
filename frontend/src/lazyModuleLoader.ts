export const DEFAULT_LAZY_MODULE_TIMEOUT_MS = 20_000

export class LazyModuleTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`The page module did not finish loading within ${Math.ceil(timeoutMs / 1_000)} seconds.`)
    this.name = 'LazyModuleTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export interface LazyModuleTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const defaultTimers: LazyModuleTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

/**
 * Put a hard deadline around a dynamic import. Browsers do not expose an
 * AbortSignal for import(), so a late result is ignored after the deadline;
 * invoking the importer again from a fresh React.lazy instance can still
 * reuse the browser's eventual module result.
 */
export function loadLazyModule<T>(
  importer: () => Promise<T>,
  timeoutMs = DEFAULT_LAZY_MODULE_TIMEOUT_MS,
  timers: LazyModuleTimers = defaultTimers,
): Promise<T> {
  const boundedTimeoutMs = Math.max(1, timeoutMs)

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      timers.clearTimeout(timeoutHandle)
      complete()
    }
    const timeoutHandle = timers.setTimeout(
      () => finish(() => reject(new LazyModuleTimeoutError(boundedTimeoutMs))),
      boundedTimeoutMs,
    )

    // Starting in a microtask converts a synchronous importer exception into
    // the same rejected-promise path as a failed network import.
    Promise.resolve()
      .then(importer)
      .then(
        (module) => finish(() => resolve(module)),
        (error) => finish(() => reject(error)),
      )
  })
}

export function isLazyModuleTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'LazyModuleTimeoutError'
}

export function isLazyModuleLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return isLazyModuleTimeoutError(error) || /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to load module script|Unable to preload CSS/i.test(
    `${error.name} ${error.message}`,
  )
}

interface VitePreloadErrorEvent extends Event {
  payload?: unknown
}

type PreloadErrorTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * Observe Vite's production preload failure without reloading automatically.
 * Vite will reject the corresponding import after this listener returns, so
 * the nearest module boundary can offer an explicit Retry or Reload. Leaving
 * the event un-cancelled is intentional: preventDefault() would turn some
 * failed preloads into an undefined module, while an automatic reload can
 * loop forever during a partial or unhealthy deployment.
 */
export function installVitePreloadErrorHandler(
  target: PreloadErrorTarget,
  report: (error: unknown) => void = (error) => console.error('[lazy-module] Vite preload failed:', error),
): () => void {
  const handlePreloadError = ((event: Event) => {
    report((event as VitePreloadErrorEvent).payload ?? new Error('A module preload failed.'))
  }) as EventListener

  target.addEventListener('vite:preloadError', handlePreloadError)
  return () => target.removeEventListener('vite:preloadError', handlePreloadError)
}
