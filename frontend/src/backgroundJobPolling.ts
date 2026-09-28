export interface PollableBackgroundJob<T = Record<string, unknown>> {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  progress: number
  result?: T | null
  error?: string | null
  artifact_name?: string | null
}

export interface BackgroundJobPollOptions {
  signal?: AbortSignal
  timeoutMs?: number
  pollIntervalMs?: number
}

export const BACKGROUND_JOB_TIMEOUT_MS = 5 * 60_000
export const BACKGROUND_JOB_TIMEOUT_MESSAGE = 'The background operation may still be running, but status checks timed out. Reload this page and check the result before retrying; the server job was not cancelled.'

export function backgroundJobTimeoutError(): Error {
  return new Error(BACKGROUND_JOB_TIMEOUT_MESSAGE)
}

export function backgroundJobAbortError(): Error {
  const error = new Error('The background operation was cancelled because its screen was closed.')
  error.name = 'AbortError'
  return error
}

function waitForNextPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(backgroundJobAbortError())
  return new Promise((resolve, reject) => {
    const cancel = () => {
      globalThis.clearTimeout(timer)
      reject(backgroundJobAbortError())
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

/**
 * Poll a server-owned job without allowing an infinite loading state.
 * `getJob` receives the remaining overall budget so its individual HTTP
 * deadline cannot extend beyond this workflow's deadline.
 */
export async function pollBackgroundJob<T>(
  getJob: (remainingMs: number) => Promise<PollableBackgroundJob<T>>,
  options: BackgroundJobPollOptions = {},
): Promise<PollableBackgroundJob<T>> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? BACKGROUND_JOB_TIMEOUT_MS)
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1000)
  const startedAt = Date.now()

  for (;;) {
    if (options.signal?.aborted) throw backgroundJobAbortError()
    let remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      throw backgroundJobTimeoutError()
    }

    const job = await getJob(remainingMs)
    if (job.status === 'FAILED') throw new Error(job.error || 'The background operation failed')
    if (job.status === 'COMPLETED') return job

    remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) continue
    await waitForNextPoll(Math.min(pollIntervalMs, remainingMs), options.signal)
  }
}
