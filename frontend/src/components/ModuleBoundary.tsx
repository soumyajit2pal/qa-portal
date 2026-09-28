import React, { Component, ReactNode } from 'react'
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
}

// A `React.lazy()` chunk can fail to load -- most commonly after a fresh
// deploy, when a tab that's been open since before the deploy tries to
// fetch a module chunk by its old (now-replaced) hashed filename and gets a
// 404. Without an error boundary, that throws inside <Suspense> with
// nothing to catch it and React unmounts the whole tree: a silent, blank
// white page with no clue why. This turns that into a visible, actionable
// message instead.
//
// Declared once per Route (see App.tsx) rather than once globally, so
// navigating to a *different* route/module creates a fresh instance instead
// of staying stuck showing a stale error for a module that isn't even
// mounted anymore.
export default class ModuleBoundary extends Component<Props, State> {
  state: State = { error: null, recoveryKey: 0 }

  static getDerivedStateFromError(error: Error): Pick<State, 'error'> {
    return { error }
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error(`[ModuleBoundary] Failed to load the ${this.props.moduleName} module:`, error)
  }

  retry = () => {
    // React.lazy permanently caches a rejection. A new recovery key makes
    // lazyModule() create a fresh wrapper and invoke its importer again.
    this.setState({ error: null, recoveryKey: nextLazyModuleRecoveryKey() })
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
          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn btn-primary" type="button" onClick={this.retry}>Retry</button>
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
