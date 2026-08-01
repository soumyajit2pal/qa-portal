import React, { useMemo, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { ROLE_LABELS } from '../constants'
import { ApprovalActionOut } from '../types'
import { ErrorText } from './Common'

type ActivityFilter = 'all' | 'comments' | 'history'

function initials(name?: string | null): string {
  const parts = (name || '?').trim().split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase()
}

function actorLabel(item: ApprovalActionOut): string {
  return item.actor_name || (item.actor_role || 'System').split(',').map((role) => ROLE_LABELS[role.trim()] || role.trim()).join(' · ')
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(value).toLocaleDateString()
}

export default function JiraActivity({ entityType, entityId, items, onPosted }: {
  entityType: string
  entityId: number
  items: ApprovalActionOut[]
  onPosted: (item: ApprovalActionOut) => void
}) {
  const { user } = useAuth()
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [body, setBody] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const visible = useMemo(() => items.filter((item) => {
    const comment = item.decision === 'Commented'
    return filter === 'all' || (filter === 'comments' ? comment : !comment)
  }).slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()), [items, filter])

  const commentCount = items.filter((item) => item.decision === 'Commented').length

  async function postComment() {
    const text = body.trim()
    if (!text) { setError('Enter a comment before posting.'); return }
    setBusy(true); setError('')
    try {
      const created = await api.post<ApprovalActionOut>(`/api/approvals/${entityType}/${entityId}/comments`, { body: text })
      onPosted(created)
      setBody(''); setExpanded(false); setFilter('all')
    } catch (err: any) {
      const message = err?.message || ''
      if (message === 'Not Found') {
        setError('The comments API is not available on the running backend. Restart or redeploy the backend service, then try again.')
      } else if (message === 'Record not found') {
        setError('This record no longer exists or the page is using a stale record ID. Close this detail view, refresh the list, and reopen it.')
      } else {
        setError(message || 'Could not post the comment.')
      }
    } finally { setBusy(false) }
  }

  return (
    <section className="jira-activity">
      <div className="jira-activity-head">
        <div><h3>Activity</h3><span>{items.length} event{items.length !== 1 ? 's' : ''}</span></div>
        <div className="jira-activity-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'comments' ? 'active' : ''} onClick={() => setFilter('comments')}>Comments <span>{commentCount}</span></button>
          <button className={filter === 'history' ? 'active' : ''} onClick={() => setFilter('history')}>History</button>
        </div>
      </div>

      <div className={`jira-comment-composer ${expanded ? 'expanded' : ''}`}>
        <div className="jira-avatar current">{initials(user?.full_name)}</div>
        <div className="jira-composer-body">
          <textarea value={body} maxLength={5000} rows={expanded ? 4 : 1}
            placeholder="Add a comment…" onFocus={() => setExpanded(true)} onChange={(e) => setBody(e.target.value)} />
          {expanded && <div className="jira-composer-actions"><span>{body.length}/5000 · Plain text</span><div><button className="btn btn-sm" onClick={() => { setBody(''); setExpanded(false); setError('') }}>Cancel</button><button className="btn btn-primary btn-sm" disabled={busy || !body.trim()} onClick={postComment}>{busy ? 'Posting…' : 'Comment'}</button></div></div>}
          <ErrorText
            error={error}
            title="Comment could not be posted"
            guidance="Correct the issue described above, then post the comment again. Your draft remains available in the comment box."
          />
        </div>
      </div>

      <div className="jira-activity-feed">
        {visible.map((item) => {
          const isComment = item.decision === 'Commented'
          const name = actorLabel(item)
          return (
            <article className={`jira-activity-item ${isComment ? 'comment' : 'history'}`} key={item.id}>
              <div className={`jira-avatar ${isComment ? '' : 'system'}`}>{isComment ? initials(name) : '↻'}</div>
              <div className="jira-activity-content">
                <div className="jira-activity-meta"><strong>{name}</strong><span>{isComment ? 'added a comment' : `${item.decision || 'updated'} · ${item.step_name || 'Workflow'}`}</span><time title={new Date(item.created_at).toLocaleString()}>{relativeTime(item.created_at)}</time></div>
                {item.comments && <div className={`jira-activity-message ${isComment ? 'comment-box' : ''}`}>{item.comments}</div>}
              </div>
            </article>
          )
        })}
        {visible.length === 0 && <div className="jira-activity-empty">{filter === 'comments' ? 'No comments yet. Start the conversation above.' : 'No activity recorded yet.'}</div>}
      </div>
    </section>
  )
}
