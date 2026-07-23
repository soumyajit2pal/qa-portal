import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import './index.css'

// NOTE: React.StrictMode intentionally double-invokes effects in development
// (mount -> cleanup -> mount) to help surface side-effect bugs -- this is why
// every `useEffect(() => { load() }, [load])` data-fetch across the app was
// firing its API calls twice in the Network tab. It's a dev-only React
// behavior (removed in production builds) and doesn't indicate a real bug,
// but it was making the Network tab noisy/confusing during testing, so it's
// been removed here.
ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <App />
    </AuthProvider>
  </BrowserRouter>,
)
