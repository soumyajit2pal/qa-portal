// Each task publishes its own result. A failure cannot skip queued sections.
export async function runIndependentLoads(tasks: Array<() => Promise<void>>, concurrency = 2): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++]
      try { await task() } catch { /* Each task owns its visible error state. */ }
    }
  }))
}
