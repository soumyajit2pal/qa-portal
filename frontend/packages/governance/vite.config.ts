import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import federation from '@originjs/vite-plugin-federation'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'governance',
      filename: 'remoteEntry.js',
      exposes: {
        './SignOff': './src/SignOff.tsx',
        './Approvals': './src/Approvals.tsx',
        './Admin': './src/Admin.tsx',
        './Reports': './src/Reports.tsx',
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
    port: 5004,
    cors: true,
  },
  preview: {
    port: 5004,
    cors: true,
  },
})
