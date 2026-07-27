import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import federation from '@originjs/vite-plugin-federation'
import path from 'path'

// Each remote's URL is resolved at BUILD time -- a limitation of
// @originjs/vite-plugin-federation's basic setup (true zero-rebuild
// runtime remote resolution needs the separate @module-federation/runtime
// package layered on top, which this project doesn't use -- see the
// README's "Independent module deploys" section for what that would take
// and why it was left out for now). Configurable per environment via env
// vars so at least a redeploy of the shell (not a code change) is all
// that's needed to point at a module's new URL -- see .env.example.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      federation({
        name: 'shell',
        remotes: {
          functional: env.VITE_FUNCTIONAL_REMOTE_URL || 'http://localhost:5001/assets/remoteEntry.js',
          security: env.VITE_SECURITY_REMOTE_URL || 'http://localhost:5002/assets/remoteEntry.js',
          specialisedTesting: env.VITE_SPECIALISED_TESTING_REMOTE_URL || 'http://localhost:5003/assets/remoteEntry.js',
          governance: env.VITE_GOVERNANCE_REMOTE_URL || 'http://localhost:5004/assets/remoteEntry.js',
        },
        // Singletons -- every remote must resolve to this SAME copy of
        // react/react-dom/react-router-dom at runtime, not bundle its own.
        // Without this, hooks/context (including AuthContext and React
        // Router's own route matching) silently break across the
        // shell/remote boundary because each module would be running its
        // own separate React instance.
        shared: ['react', 'react-dom', 'react-router-dom'],
      }),
    ],
    resolve: {
      alias: {
        // @qa-portal/shared isn't a real installed/published package --
        // this points the specifier straight at its source so it compiles
        // as part of this app. See packages/shared/package.json.
        '@qa-portal/shared': path.resolve(__dirname, '../shared/src'),
      },
    },
    build: {
      // Module Federation (this plugin) requires an unbundled, unminified,
      // single-chunk output -- these 4 settings are its documented
      // constraints, not stylistic choices.
      target: 'esnext',
      minify: false,
      cssCodeSplit: false,
      modulePreload: false,
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
