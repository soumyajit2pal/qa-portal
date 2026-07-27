// Standalone dev/preview entry -- lets this module be run and eyeballed on
// its own (`npm run dev` from this package), without the shell or the
// other 3 modules running. NOT used in production: in production this
// module is only ever loaded as a remote, by the shell's App.tsx, via
// `import('functional/Functional')` -- see vite.config.ts `exposes`.
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@qa-portal/shared/context/AuthContext'
import '@qa-portal/shared/index.css'
import Functional from './Functional'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

ReactDOM.createRoot(rootEl).render(
  <BrowserRouter>
    <AuthProvider>
      <Functional />
    </AuthProvider>
  </BrowserRouter>,
)
