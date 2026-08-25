import type { ApiMutationEvent } from './api'

export interface MutationSuccessCopy {
  title: string
  message: string
}

function normalizedPath(path: string): string {
  return path.split('?')[0].toLowerCase()
}

/** Convert API route intent into concise, user-facing success feedback. */
export function mutationSuccessCopy({ path, method }: ApiMutationEvent): MutationSuccessCopy | null {
  const value = normalizedPath(path)
  const action = value.split('/').filter(Boolean).at(-1) || ''

  // Login/logout feedback belongs to the destination screen and would flash
  // during navigation. All authenticated business mutations are covered.
  if (value === '/api/auth/login' || value === '/api/auth/logout') return null

  if (method === 'POST' && (/\/delegations$/.test(value) || /\/child-delegations\/[^/]+\/\d+$/.test(value))) {
    return { title: 'Input delegated', message: 'The selected user can now provide input on this request.' }
  }
  if (action === 'recall') {
    return { title: 'Delegation recalled', message: 'Input control has been returned to the requester.' }
  }
  if (action === 'return' && value.includes('/delegations')) {
    return { title: 'Input returned', message: 'The request was returned to its requester successfully.' }
  }
  if (/(^|-)(assign|reassign)(-|$)/.test(action)) {
    return { title: 'Assignment updated', message: 'The selected assignee has been saved successfully.' }
  }
  if (/(^|-)(approve|approval|decision|review|signoff)(-|$)/.test(action) || action.includes('sign-off')) {
    return { title: 'Decision recorded', message: 'Your workflow decision was saved successfully.' }
  }
  if (/(^|-)(return|recall)(-|$)/.test(action)) {
    return { title: 'Request returned', message: 'The request was returned successfully.' }
  }
  if (/(^|-)reject(ed)?(-|$)/.test(action)) {
    return { title: 'Request rejected', message: 'The rejection was recorded successfully.' }
  }
  if (/(^|-)(submit|resubmit)(-|$)/.test(action)) {
    return { title: 'Submitted successfully', message: 'The request has moved to the next workflow step.' }
  }
  if (/(^|-)(upload|import|documents?)(-|$)/.test(action) && method === 'POST') {
    return { title: 'Upload complete', message: 'The file was saved successfully.' }
  }
  if (/(^|-)(archive|purge|delete|remove|unlink)(-|$)/.test(action) || method === 'DELETE') {
    return { title: 'Removed successfully', message: 'The selected item has been removed.' }
  }
  if (/(^|-)restore(d)?(-|$)/.test(action) || action === 'unarchive') {
    return { title: 'Restored successfully', message: 'The selected item is available again.' }
  }
  if (/(^|-)(clone|copy)(-|$)/.test(action)) {
    return { title: 'Copy created', message: 'The new copy was created successfully.' }
  }
  if (method === 'PATCH' || method === 'PUT') {
    return { title: 'Changes saved', message: 'Your updates were saved successfully.' }
  }
  if (method === 'POST') {
    return { title: 'Action completed', message: 'Your changes were applied successfully.' }
  }
  return { title: 'Action completed', message: 'The operation completed successfully.' }
}
