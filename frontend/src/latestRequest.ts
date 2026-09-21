/**
 * Small generation gate for async UI loaders. Starting a newer request makes
 * every older completion stale, so a slow response cannot overwrite the
 * user's newer selection.
 */
export interface LatestRequestGate {
  begin(): number
  isCurrent(generation: number): boolean
  invalidate(): void
}

export function createLatestRequestGate(): LatestRequestGate {
  let current = 0
  return {
    begin: () => ++current,
    isCurrent: (generation) => generation === current,
    invalidate: () => { current += 1 },
  }
}
