export const WORKSPACE_TRANSITION_EVENT = 'qa-workspace-transition'
const KEY = 'qa_workspace_transition'
export interface WorkspaceTransition { name: string; phase: 'switching' | 'opening'; startedAt: number }
export function readWorkspaceTransition(): WorkspaceTransition | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) || 'null')
    if (value?.phase === 'opening' && typeof value.name === 'string' && typeof value.startedAt === 'number' && Date.now() - value.startedAt < 120_000) return value
  } catch { /* Storage unavailable or an interrupted older transition. */ }
  return null
}
export function beginWorkspaceTransition(name: string) {
  window.dispatchEvent(new CustomEvent(WORKSPACE_TRANSITION_EVENT, { detail: { name, phase: 'switching', startedAt: Date.now() } }))
}
export function persistWorkspaceTransition(name: string) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ name, phase: 'opening', startedAt: Date.now() })) } catch { /* Switching still works without session storage. */ }
}
export function endWorkspaceTransition() {
  try { sessionStorage.removeItem(KEY) } catch { /* Storage can be unavailable. */ }
  window.dispatchEvent(new CustomEvent(WORKSPACE_TRANSITION_EVENT, { detail: null }))
}
