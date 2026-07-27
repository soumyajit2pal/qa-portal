import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import federation from '@originjs/vite-plugin-federation'
import path from 'path'

// This module's own independent Vite project -- own build, own Dockerfile/
// image, own deploy. `exposes` is this remote's public API: anything else
// (the shell) can load `functional/Functional` at runtime once this is
// built and served, without needing this module's source at all.
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'functional',
      filename: 'remoteEntry.js',
      exposes: {
        './Functional': './src/Functional.tsx',
      },
      // Must match the shell's own `shared` list exactly (see
      // packages/shell/vite.config.ts) -- these resolve to the shell's
      // already-loaded copies at runtime instead of bundling their own.
      shared: ['react', 'react-dom', 'react-router-dom'],
    }),
  ],
  resolve: {
    alias: {
      '@qa-portal/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  build: {
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
    modulePreload: false,
  },
  server: {
    port: 5001,
    cors: true,
  },
  preview: {
    port: 5001,
    cors: true,
  },
})
