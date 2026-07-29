import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Single React + Vite SPA (see package.json description for why this isn't
// a Module Federation multi-app setup anymore). Domain modules are code-split
// via React.lazy() on local imports in src/App.tsx -- normal Vite chunking,
// no special plugin/build config needed for that.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
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
