import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // The API server reads PORT from .env, so the proxy must too.
  const env = loadEnv(mode, process.cwd(), '')
  const server = `http://localhost:${env.PORT || 3000}`

  return {
    root: 'web',
    plugins: [react(), tailwindcss()],
    build: { outDir: '../dist/web', emptyOutDir: true },
    server: {
      port: 5173,
      proxy: { '/api': server, '/media': server },
    },
    test: { root: '.', include: ['tests/**/*.test.ts'], environment: 'node' },
  }
})
