import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import ModuleBoundary from './components/ModuleBoundary'
import { AuthProvider } from './context/AuthContext'
import { installVitePreloadErrorHandler } from './lazyModuleLoader'
import './index.css'

// Keep Vite preload failures on the normal rejected-import path. The nearest
// ModuleBoundary presents recovery controls; this listener is diagnostic only
// and deliberately never performs an automatic reload (which could loop while
// a deployment is incomplete).
const removeVitePreloadErrorHandler = installVitePreloadErrorHandler(window)
if (import.meta.hot) import.meta.hot.dispose(removeVitePreloadErrorHandler)

// NOTE: React.StrictMode intentionally double-invokes effects in development
// (mount -> cleanup -> mount) to help surface side-effect bugs -- this is why
// every `useEffect(() => { load() }, [load])` data-fetch across the app was
// firing its API calls twice in the Network tab. It's a dev-only React
// behavior (removed in production builds) and doesn't indicate a real bug,
// but it was making the Network tab noisy/confusing during testing, so it's
// been left out here.
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

ReactDOM.createRoot(rootEl).render(
  <BrowserRouter>
    <ModuleBoundary moduleName="Portal session">
    <AuthProvider>
      <App />
    </AuthProvider>
    </ModuleBoundary>
  </BrowserRouter>,
)
