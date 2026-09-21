export function boundedRetryDelay(attempt: number, baseMs = 1_000, maximumMs = 30_000): number {
  return Math.min(maximumMs, baseMs * (2 ** Math.max(0, attempt)))
}
