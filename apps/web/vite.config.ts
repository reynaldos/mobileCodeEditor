import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // The workspace server serves this in production, from the same origin.
    // That is why there is no CORS configuration outside of dev.
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
})
