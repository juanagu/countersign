import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser only talks to its own origin; /api is proxied to the BFF so the session cookie
// stays first-party, HttpOnly and SameSite=Strict, with no CORS. nginx does the same in Docker.
const bffUrl = process.env.BFF_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: bffUrl, rewrite: (path) => path.replace(/^\/api/, '') } },
  },
});
