import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    host: true,
    allowedHosts: true,
    watch: {
      ignored: ["**/data/**"],
    },
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
})