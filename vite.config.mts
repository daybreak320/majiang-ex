import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'

// 平台发布时通过 PORT 注入单个公网端口；本地开发不设 PORT，沿用 vite 默认 5173
const port = process.env.PORT ? Number(process.env.PORT) : undefined
const serve = { host: '0.0.0.0', allowedHosts: true, ...(port ? { port, strictPort: true } : {}) }

export default defineConfig({
  base: './',
  server: serve,
  preview: serve,
  plugins: [react(), tailwindcss()],
})