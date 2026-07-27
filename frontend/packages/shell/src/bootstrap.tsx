import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from '@qa-portal/shared/context/AuthContext'
import '@qa-portal/shared/index.css'

// This file's contents used to live directly in main.tsx, imported
// statically (`import App from './App'`). Module Federation (via
// @originjs/vite-plugin-federation) needs an async boundary before ANY
// module that touches a `shared` dependency (react/react-dom/react-router-dom)
// executes, so it can finish negotiating/loading the shared scope across the
// shell and whichever remote(s) get loaded first -- a synchronous top-level
// import doesn't give it that chance. main.tsx now only does a dynamic
// `import('./bootstrap')`, which is the documented workaround (see the
// plugin's own README, "Federation runtime requires an async entrypoint").

// NOTE: React.StrictMode intentionally double-invokes effects in development
// (mount -> cleanup -> mount) to help surface side-effect bugs -- this is why
// every `useEffect(() => { load() }, [load])` data-fetch across the app was
// firing its API calls twice in the Network tab. It's a dev-only React
// behavior (removed in production builds) and doesn't indicate a real bug,
// but it was making the Network tab noisy/confusing during testing, so it's
// been removed here.
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

ReactDOM.createRoot(rootEl).render(
  <BrowserRouter>
    <AuthProvider>
      <App />
    </AuthProvider>
  </BrowserRouter>,
)
