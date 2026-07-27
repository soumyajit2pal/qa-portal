// Standalone dev/preview entry -- see packages/functional/src/main.tsx for
// the full explanation. Defaults to Admin; edit the import below to preview
// SignOff, Approvals or Reports instead.
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@qa-portal/shared/context/AuthContext'
import '@qa-portal/shared/index.css'
import Admin from './Admin'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

ReactDOM.createRoot(rootEl).render(
  <BrowserRouter>
    <AuthProvider>
      <Admin />
    </AuthProvider>
  </BrowserRouter>,
)
