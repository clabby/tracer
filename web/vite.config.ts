import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the SPA talks to the local API server (`bun run dev:api`,
// port 7777) via the `/api` proxy — same path mapping the production server
// provides. `/tempo/*` proxies straight to a local Tempo as the raw escape
// hatch (in production the API server passes it through read-only).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:7777',
        changeOrigin: true,
      },
      '/tempo': {
        target: process.env.TEMPO_URL ?? 'http://localhost:3200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tempo/, ''),
      },
    },
  },
})
