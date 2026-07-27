import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import federation from '@originjs/vite-plugin-federation'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'security',
      filename: 'remoteEntry.js',
      exposes: {
        './SAST': './src/SAST.tsx',
        './DAST': './src/DAST.tsx',
        './Suppression': './src/Suppression.tsx',
      },
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
    port: 5002,
    cors: true,
  },
  preview: {
    port: 5002,
    cors: true,
  },
})
