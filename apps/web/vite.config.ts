import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发时把 /admin、/auth、/api、/ws 转发到本地 server，
// 生产构建产物由 server 或 nginx 直接托管。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/admin': 'http://127.0.0.1:3000',
      '/auth': 'http://127.0.0.1:3000',
      '/api': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
