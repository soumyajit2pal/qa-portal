import React, { Component, ReactNode } from 'react'

interface Props {
  moduleName: string
  // Remote name as declared in vite.config.ts's federation({ remotes }) --
  // shown in the error message so it's obvious which module/env var to check.
  remoteKey: string
  // Suffix of the root package.json convenience script that builds+previews
  // this module (e.g. "functional", "specialised-testing") -- kept as an
  // explicit prop rather than derived from remoteKey since the two don't
  // always match casing/hyphenation (remoteKey is a camelCase JS identifier,
  // the npm script is kebab-case).
  serveScript: string
  children: ReactNode
}

interface State {
  error: Error | null
}

// Without this, a failed `lazy(() => import('functional/Functional'))` --
// e.g. because that module's dev server is running `vite dev` instead of
// being built+previewed (Module Federation's remoteEntry.js only exists in
// a *build* output, not the Vite dev server -- see README "Troubleshooting:
// blank module screen") -- throws inside Suspense with no boundary to catch
// it, and React unmounts the whole tree: a silent, blank white page with no
// clue why. This turns that into a visible, actionable message.
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
    console.error(`[ModuleBoundary] Failed to load remote "${this.props.remoteKey}" (${this.props.moduleName} module):`, error)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, maxWidth: 640 }}>
          <h3 style={{ marginTop: 0 }}>Couldn't load the {this.props.moduleName} module</h3>
          <p>
            The shell tried to load <code>{this.props.remoteKey}</code> as a Module Federation
            remote and it failed. Most common causes:
          </p>
          <ul>
            <li>
              That module's dev server is running <code>vite dev</code> instead of being built +
              previewed. <code>remoteEntry.js</code> only exists in a production build --
              run <code>npm run serve:{this.props.serveScript}</code> (from the <code>frontend/</code>{' '}
              workspace root; or <code>npm run build</code> then <code>npm run preview</code> inside
              that module's own package) instead of <code>npm run dev:...</code>.
            </li>
            <li>That module's server isn't running at all, or is on a different port than the shell expects.</li>
            <li>
              The shell was built/started with a stale <code>VITE_*_REMOTE_URL</code> pointing at
              the wrong host/port.
            </li>
          </ul>
          <p>Check the browser console and network tab for the exact failed request, then see the README's "Troubleshooting: blank module screen" section.</p>
        </div>
      )
    }
    return this.props.children
  }
}
