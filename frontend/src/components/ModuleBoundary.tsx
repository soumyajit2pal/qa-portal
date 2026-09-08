import React, { Component, ReactNode } from 'react'

interface Props {
  moduleName: string
  children: ReactNode
}

interface State {
  error: Error | null
}

function isChunkLoadError(error: Error): boolean {
  return /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
    `${error.name} ${error.message}`,
  )
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
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error(`[ModuleBoundary] Failed to load the ${this.props.moduleName} module:`, error)
  }

  render() {
    if (this.state.error) {
      const chunkLoadFailed = isChunkLoadError(this.state.error)
      return (
        <div style={{ padding: 40, maxWidth: 640 }}>
          <h3 style={{ marginTop: 0 }}>
            {chunkLoadFailed ? `${this.props.moduleName} update available` : `${this.props.moduleName} could not be displayed`}
          </h3>
          <p>{chunkLoadFailed
            ? 'The application was updated while this page was open. Reload to continue with the latest version.'
            : 'An unexpected display error occurred. Retry this view; your saved request data is unchanged.'}
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            {!chunkLoadFailed && <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>Retry</button>}
            <button className="btn" onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
