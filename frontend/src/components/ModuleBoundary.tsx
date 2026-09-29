import React, { Component, ErrorInfo, ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { LazyModuleRecoveryContext, nextLazyModuleRecoveryKey } from '../lazyModule'
import { isLazyModuleLoadError, isLazyModuleTimeoutError } from '../lazyModuleLoader'
import { Modal } from './Common'

interface Props {
  moduleName: string
  children: ReactNode
  recoveryModal?: {
    title: string
    onClose: () => void
  }
}

interface State {
  error: Error | null
  recoveryKey: number
  automaticRecoveryAttempts: number
  automaticRecoveryPending: boolean
  errorReference: string | null
}

interface InternalProps extends Props {
  routeKey: string
}

const AUTOMATIC_RECOVERY_DELAY_MS = 250
const AUTOMATIC_RECOVERY_LIMIT = 1

function newErrorReference(): string {
  const time = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `UI-${time}-${random}`
}

// A `React.lazy()` chunk can fail to load -- most commonly after a fresh
// deploy, when a tab that's been open since before the deploy tries to
// fetch a module chunk by its old (now-replaced) hashed filename and gets a
// 404. Without an error boundary, that throws inside <Suspense> with
// nothing to catch it and React unmounts the whole tree: a silent, blank
// white page with no clue why. This turns that into a visible, actionable
// message instead.
//
// Declared once per Route (see App.tsx) rather than once globally. The
// location-aware wrapper below also resets a retained boundary whenever the
// matched URL changes, so an error from one page cannot strand another page
// behind a stale fallback.
class ModuleBoundaryImpl extends Component<InternalProps, State> {
  state: State = {
    error: null,
    recoveryKey: 0,
    automaticRecoveryAttempts: 0,
    automaticRecoveryPending: false,
    errorReference: null,
  }

  private recoveryTimer: ReturnType<typeof window.setTimeout> | null = null

  static getDerivedStateFromError(error: Error): Pick<State, 'error' | 'errorReference'> {
    return { error, errorReference: newErrorReference() }
  }

  componentDidMount() {
    window.addEventListener('online', this.handleOnline)
    if (import.meta.hot) import.meta.hot.on('vite:afterUpdate', this.handleHotUpdate)
  }

  componentDidUpdate(previousProps: InternalProps) {
    // React Router can retain a boundary instance while swapping matched
    // route content. Never let an error from the previous location strand a
    // healthy page behind a stale fallback.
    if (previousProps.routeKey !== this.props.routeKey && this.state.error) {
      this.recover(true)
    }
  }

  componentWillUnmount() {
    this.clearRecoveryTimer()
    window.removeEventListener('online', this.handleOnline)
    if (import.meta.hot) import.meta.hot.off('vite:afterUpdate', this.handleHotUpdate)
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(
      `[ModuleBoundary:${this.state.errorReference || 'unreferenced'}] ` +
      `Failed to display ${this.props.moduleName} at ${this.props.routeKey}:`,
      error,
      info.componentStack,
    )

    // Many of these incidents are one-render races (or a transient chunk
    // fetch) and the exact same page succeeds immediately on a fresh mount.
    // Recover once automatically, then stop and retain the actionable
    // fallback if the error is deterministic. The hard limit prevents an
    // error/retry loop from hiding a real defect or hammering APIs.
    if (this.state.automaticRecoveryAttempts < AUTOMATIC_RECOVERY_LIMIT) {
      this.setState((current) => ({
        automaticRecoveryAttempts: current.automaticRecoveryAttempts + 1,
        automaticRecoveryPending: true,
      }))
      this.clearRecoveryTimer()
      this.recoveryTimer = window.setTimeout(() => this.recover(false), AUTOMATIC_RECOVERY_DELAY_MS)
    }
  }

  clearRecoveryTimer = () => {
    if (this.recoveryTimer !== null) {
      window.clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
  }

  recover = (resetAutomaticAttempts: boolean) => {
    this.clearRecoveryTimer()
    this.setState((current) => ({
      error: null,
      recoveryKey: nextLazyModuleRecoveryKey(),
      automaticRecoveryAttempts: resetAutomaticAttempts ? 0 : current.automaticRecoveryAttempts,
      automaticRecoveryPending: false,
      errorReference: null,
    }))
  }

  handleOnline = () => {
    if (this.state.error && isLazyModuleLoadError(this.state.error)) this.recover(false)
  }

  handleHotUpdate = () => {
    // In development, React Fast Refresh can briefly render an invalidated
    // module graph. A successful subsequent Vite update must release the
    // boundary without requiring a manual page reload.
    if (this.state.error) this.recover(true)
  }

  retry = () => {
    // React.lazy permanently caches a rejection. A new recovery key makes
    // lazyModule() create a fresh wrapper and invoke its importer again.
    this.recover(false)
  }

  render() {
    if (this.state.error) {
      const lazyLoadFailed = isLazyModuleLoadError(this.state.error)
      const timedOut = isLazyModuleTimeoutError(this.state.error)
      const recovery = (
        <div style={{ padding: 40, maxWidth: 640 }} role="alert" aria-live="polite">
          <h3 style={{ marginTop: 0 }}>
            {timedOut
              ? `${this.props.moduleName} is taking too long to load`
              : lazyLoadFailed
                ? `${this.props.moduleName} could not be loaded`
                : `${this.props.moduleName} could not be displayed`}
          </h3>
          <p>{timedOut
            ? 'The module download did not finish. Check your connection and retry; your saved request data is unchanged.'
            : lazyLoadFailed
              ? 'The module files are temporarily unavailable or the application was updated while this page was open. Retry the download, or reload to use the latest version.'
              : 'An unexpected display error occurred. Retry this view; your saved request data is unchanged.'}
          </p>
          {this.state.automaticRecoveryPending && (
            <p className="muted small" role="status">Retrying this view automatically…</p>
          )}
          {!this.state.automaticRecoveryPending && this.state.errorReference && (
            <p className="muted small">Display error reference: <code>{this.state.errorReference}</code></p>
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn btn-primary" type="button" onClick={this.retry} disabled={this.state.automaticRecoveryPending}>Retry</button>
            <button className="btn" type="button" onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </div>
      )
      return this.props.recoveryModal
        ? <Modal title={this.props.recoveryModal.title} onClose={this.props.recoveryModal.onClose} wide>{recovery}</Modal>
        : recovery
    }
    return (
      <LazyModuleRecoveryContext.Provider value={this.state.recoveryKey}>
        {this.props.children}
      </LazyModuleRecoveryContext.Provider>
    )
  }
}

// Location awareness is intentionally kept outside the class boundary. It
// lets every existing call site reset stale failures on navigation without
// requiring dozens of routes and modal hosts to manufacture their own keys.
export default function ModuleBoundary(props: Props) {
  const location = useLocation()
  const routeKey = `${location.pathname}${location.search}${location.hash}`
  return <ModuleBoundaryImpl {...props} routeKey={routeKey} />
}
