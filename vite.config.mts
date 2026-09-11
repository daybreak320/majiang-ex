import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'

// 平台发布时会注入 PORT；本文件在 Node 下执行，而 tsconfig.node 未引入 @types/node，故就地声明
declare const process: { env: Record<string, string | undefined> }

// 本地开发不设 PORT，沿用 vite 默认 5173
const port = process.env.PORT ? Number(process.env.PORT) : undefined
const serve = {
  host: '0.0.0.0',
  allowedHosts: true as const,
  ...(port ? { port, strictPort: true } : {}),
}

export default defineConfig({
  base: './',
  server: serve,
  preview: serve,
  plugins: [react(), tailwindcss()],
})