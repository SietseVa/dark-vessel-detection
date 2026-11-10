import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The FastAPI backend runs on API_PORT (default 8000, set by `dvd dashboard`); /api is proxied so the
// app is same-origin.
const apiPort = process.env.API_PORT ?? '8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${import.meta.dirname}/src` } },
  worker: { format: 'es' },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
})
