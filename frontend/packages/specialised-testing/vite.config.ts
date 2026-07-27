import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import federation from '@originjs/vite-plugin-federation'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'specialisedTesting',
      filename: 'remoteEntry.js',
      exposes: {
        './Automation': './src/Automation.tsx',
        './Performance': './src/Performance.tsx',
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
    port: 5003,
    cors: true,
  },
  preview: {
    port: 5003,
    cors: true,
  },
})
