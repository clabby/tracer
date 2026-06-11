import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development, `/tempo/*` is proxied to a local Tempo instance so the
// browser never deals with CORS. In the Docker deployment, Caddy provides the
// same path mapping. Point the app at any other Tempo via the in-app settings.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/tempo': {
        target: process.env.TEMPO_URL ?? 'http://localhost:3200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tempo/, ''),
      },
    },
  },
})
