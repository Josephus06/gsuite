import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // API_TARGET lets this client point at a non-default backend port, so the app can
  // run alongside sibling projects that also default to :4000.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: env.API_TARGET || 'http://localhost:4000',
          changeOrigin: true,
        },
      },
    },
  }
})
