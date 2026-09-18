import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The backend's actual port — override with BACKEND_PORT if apps/server isn't on the
// default 4000 (e.g. via .env's PORT). Proxying every backend path through Vite's own dev
// server means the frontend never needs to know the backend's real address: it just calls
// same-origin paths, and this forwards them — see lib/ws-client.ts for the client side of
// that assumption. That's also what lets one tunnel (pointed at Vite's port) expose the
// whole app instead of needing to separately expose the backend port too.
const backendTarget = `http://localhost:${process.env.BACKEND_PORT ?? 4000}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': backendTarget,
      '/gemini-proxy': backendTarget,
      '/auth': backendTarget,
      '/ws': { target: backendTarget, ws: true },
      '/pty': { target: backendTarget, ws: true },
    },
  },
})
