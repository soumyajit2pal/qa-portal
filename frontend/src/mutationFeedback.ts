import type { ApiMutationEvent } from './api'
import type { MutationSuccessCopy } from './mutationToast'

export interface MutationFeedbackItem extends MutationSuccessCopy, ApiMutationEvent {
  id: number
}

export interface MutationFeedbackState {
  toast: MutationFeedbackItem | null
  confirmations: MutationFeedbackItem[]
}

export const EMPTY_MUTATION_FEEDBACK: MutationFeedbackState = { toast: null, confirmations: [] }

export type MutationFeedbackAction =
  | { type: 'received'; item: MutationFeedbackItem }
  | { type: 'dismiss-toast'; id: number }
  | { type: 'acknowledge'; id: number }
  | { type: 'clear' }

export function mutationFeedbackReducer(state: MutationFeedbackState, action: MutationFeedbackAction): MutationFeedbackState {
  if (action.type === 'clear') return EMPTY_MUTATION_FEEDBACK
  if (action.type === 'dismiss-toast') return state.toast?.id === action.id ? { ...state, toast: null } : state
  if (action.type === 'acknowledge') {
    return state.confirmations[0]?.id === action.id
      ? { ...state, confirmations: state.confirmations.slice(1) } : state
  }
  const { item } = action
  if (item.presentation === 'confirmation') {
    const duplicate = state.confirmations.some(existing =>
      existing.path === item.path && existing.title === item.title && existing.message === item.message &&
      existing.requestId === item.requestId && existing.applicationName === item.applicationName &&
      existing.assigneeName === item.assigneeName,
    )
    return duplicate ? state : { toast: null, confirmations: [...state.confirmations, item] }
  }
  // Background saves must never replace an assignment awaiting acknowledgement.
  if (state.confirmations.length) return state
  if (state.toast?.title === item.title && state.toast.message === item.message) return state
  return { ...state, toast: item }
}
