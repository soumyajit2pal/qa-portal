// Standalone dev/preview entry -- see packages/functional/src/main.tsx for
// the full explanation. Defaults to SAST; edit the import below to preview
// DAST or Suppression instead.
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@qa-portal/shared/context/AuthContext'
import '@qa-portal/shared/index.css'
import SAST from './SAST'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

ReactDOM.createRoot(rootEl).render(
  <BrowserRouter>
    <AuthProvider>
      <SAST />
    </AuthProvider>
  </BrowserRouter>,
)
