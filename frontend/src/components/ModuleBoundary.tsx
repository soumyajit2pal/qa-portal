import React, { Component, ReactNode } from 'react'

interface Props {
  moduleName: string
  children: ReactNode
}

interface State {
  error: Error | null
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
      return (
        <div style={{ padding: 40, maxWidth: 640 }}>
          <h3 style={{ marginTop: 0 }}>Couldn't load the {this.props.moduleName} module</h3>
          <p>
            This usually means the app was updated (a new build shipped) while this tab was
            still open, and the browser is holding a stale reference to a chunk that no longer
            exists on the server.
          </p>
          <p>
            <button onClick={() => window.location.reload()}>Reload the page</button>
          </p>
          <p>If reloading doesn't fix it, check the browser console/network tab for the exact failed request.</p>
        </div>
      )
    }
    return this.props.children
  }
}
