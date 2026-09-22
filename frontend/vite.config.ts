import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setClientProxyHeaders } from './proxyHeaders.ts'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Single React + Vite SPA (see package.json description for why this isn't
// a Module Federation multi-app setup anymore). Domain modules are code-split
// via React.lazy() on local imports in src/App.tsx -- normal Vite chunking,
// no special plugin/build config needed for that.
export default defineConfig(({ mode, command }) => {
  const frontendDir = fileURLToPath(new URL('.', import.meta.url))
  const rootDir = resolve(frontendDir, '..')
  const env = loadEnv(mode, frontendDir, '')
  // Direct UAT uses the same root profile fallback as the backend.
  const rootEnv = loadEnv(mode, rootDir, '')
  const certDir = process.env.TLS_CERT_HOST_PATH || env.TLS_CERT_HOST_PATH || rootEnv.TLS_CERT_HOST_PATH
  // Match Compose's repository-relative directory and fixed filenames. Runtime
  // certificates are needed by dev/preview servers, never by the image build.
  const https = command === 'serve' && certDir
    ? {
        cert: readFileSync(resolve(rootDir, certDir, 'qualityops.crt')),
        key: readFileSync(resolve(rootDir, certDir, 'qualityops.key')),
      }
    : undefined

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@qualityops/csp-runtime': resolve(frontendDir, 'src/csp-runtime'),
      },
    },
    build: { sourcemap: false, minify: 'oxc' },
    server: {
      https,
      strictPort: true,
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_BACKEND_URL || rootEnv.VITE_BACKEND_URL || 'http://127.0.0.1:8000',
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', setClientProxyHeaders)
          },
        },
      },
    },
    preview: {
      https,
      strictPort: true,
      port: 5173,
    },
  }
})
