import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { WORKSPACE_TRANSITION_EVENT, readWorkspaceTransition, endWorkspaceTransition, WorkspaceTransition as TransitionState } from '../workspaceTransition'
import { IconFolder } from './Icons'
import './WorkspaceTransition.css'

export default function WorkspaceTransition() {
  const { loading } = useAuth()
  const [transition, setTransition] = useState<TransitionState | null>(readWorkspaceTransition)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const update = (event: Event) => setTransition((event as CustomEvent<TransitionState | null>).detail)
    window.addEventListener(WORKSPACE_TRANSITION_EVENT, update)
    return () => window.removeEventListener(WORKSPACE_TRANSITION_EVENT, update)
  }, [])
  useEffect(() => {
    // The persisted state spans the reload until the new session is resolved.
    // Individual pages then use their own data-loading indicators.
    if (!loading && transition?.phase === 'opening') endWorkspaceTransition()
  }, [loading, transition?.phase])
  useEffect(() => {
    if (!transition) return
    const root = document.getElementById('root')
    const previouslyInert = root?.hasAttribute('inert')
    const focused = document.activeElement as HTMLElement | null
    root?.setAttribute('inert', '')
    panel.current?.focus()
    return () => {
      if (!previouslyInert) root?.removeAttribute('inert')
      if (focused?.isConnected) focused.focus()
    }
  }, [!!transition])
  if (!transition) return null
  return createPortal(
    <div className="workspace-transition-backdrop">
      <div ref={panel} tabIndex={-1} className="workspace-transition-panel" role="status" aria-live="polite" aria-atomic="true" onKeyDown={event => { if (event.key === 'Tab') event.preventDefault() }}>
        <div className="workspace-transition-scene" aria-hidden="true">
          <span className="workspace-transition-tile tile-origin"><IconFolder width={22} height={22} /></span>
          <span className="workspace-transition-bridge"><i /><i /><i /></span>
          <span className="workspace-transition-tile tile-destination"><IconFolder width={24} height={24} /></span>
        </div>
        <p className="workspace-transition-eyebrow">Switching to workspace</p>
        <h2>{transition.name}</h2>
        <p className="workspace-transition-caption">{transition.phase === 'opening' ? 'Opening your workspace…' : 'Updating your workspace access…'}</p>
        <div className="workspace-transition-track" aria-hidden="true"><span /></div>
      </div>
    </div>, document.body,
  )
}
