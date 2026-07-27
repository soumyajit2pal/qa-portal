import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Single React + Vite application (previously a Module Federation shell +
// 4 independently-deployed remotes -- that split added real operational
// cost -- 5 images, 5 deploys, build-time-baked remote URLs -- for a portal
// that in practice ships as one unit, so it was collapsed back into one app).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    resolve: {
      alias: {
        // Keeps every page/component's existing `@qa-portal/shared/...`
        // import path working unchanged now that shared code lives at
        // src/shared instead of a separate workspace package.
        '@qa-portal/shared': path.resolve(__dirname, 'src/shared'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_BACKEND_URL || 'http://localhost:8000',
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 5173,
    },
  }
})
