import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const server = `http://localhost:${process.env.PORT ?? 3000}`

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': server, '/media': server },
  },
  test: { root: '.', include: ['tests/**/*.test.ts'], environment: 'node' },
})
