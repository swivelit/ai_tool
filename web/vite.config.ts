import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { validatePublicWebConfig } from './src/config/publicWebConfig'

export default defineConfig(({ command, mode }) => {
  if (command === 'build') validatePublicWebConfig(loadEnv(mode, process.cwd(), ''), 'production')

  return {
    plugins: [react()],
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      globals: true,
      exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase'
            if (id.includes('node_modules/react-markdown') || id.includes('node_modules/remark-') || id.includes('node_modules/highlight.js')) return 'markdown'
            if (id.includes('node_modules/react') || id.includes('node_modules/lucide-react')) return 'react-vendor'
          },
        },
      },
    },
  }
})
